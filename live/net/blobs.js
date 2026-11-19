// Content-addressed file store with p2p transfer over room.js's 'blob' channel.
//
// Hash: the bytes are cut into 1 MiB chunks (the last may be shorter), each chunk is SHA-256'd,
// and the id is 'sha256-' + hex(SHA-256(chunkHash_0 ‖ … ‖ chunkHash_n-1 ‖ u64be(size))). The list
// of chunk hashes is the blob's manifest: fetched first, checked against the id, then every chunk
// received is checked against its entry before it is stored. Names and types are metadata only.
//
// Storage (OPFS, navigator.storage.getDirectory()/redaw-blobs/):
//   chunks/<chunk hex>       one file per chunk, shared by every blob that contains it. Written
//                            with createWritable, which swaps the file in on close(), so a chunk
//                            file is either absent, empty (crash between create and close) or whole.
//   meta/<id>.json           { size, name, type, added, chunks: [hex], complete }
// Which chunks a blob has is not stored separately: at page load the chunk files are listed (and,
// for incomplete blobs, their sizes checked), so a transfer resumes after a reload exactly from the
// chunks that made it to disk. get() returns a File made of the chunk Files (backed by OPFS).
//
// Protocol: every message is [u8 op][u32be header length][JSON header][payload bytes].
//   1 WANT          { hashes }                              who has these? (holders answer HAVE)
//   2 HAVE          { hash, size, chunks, complete }        + packed chunk bitmap if not complete;
//                                                            also re-sent to askers as we gain chunks
//   3 MANIFEST_REQ  { hash }
//   4 MANIFEST      { hash, size, name, type }              + n × 32 bytes of chunk hashes
//   5 CHUNK_REQ     { hash, index }
//   6 CHUNK         { hash, index }                         + the chunk's bytes
//   7 ERROR         { hash, index?, error }                 'unknown' | 'missing' | 'busy' | 'unreadable'
// A fetch asks every open peer (WANT), takes the manifest from one holder, then keeps up to WINDOW
// chunk requests in flight per holder, round-robin over the missing chunks. Requests that time out
// or whose peer leaves go back in the queue; peers that time out or send bad data are struck, and
// banned from that transfer for a while after MAX_STRIKES. Serving reads one chunk file at a time
// per peer and waits for the channel to drain before each send.
import { persist } from '@live/runtime';
import * as room from './room.js';

export const CHUNK_SIZE = 1 << 20;
const DIR = 'redaw-blobs';
const WINDOW = 8; // chunk requests in flight per peer
const REQUEST_TIMEOUT_MS = 30_000;
const MANIFEST_TIMEOUT_MS = 15_000;
const WANT_EVERY_MS = 5_000; // re-ask for holders while a fetch runs
const BAN_MS = 60_000;
const MAX_STRIKES = 3;
const SERVE_QUEUE = 64; // queued chunk requests per peer before answering 'busy'
const ORPHAN_AGE_MS = 60 * 60_000; // unreferenced chunk files older than this are deleted at load
const TICK_MS = 1000;
const OP = { WANT: 1, HAVE: 2, MANIFEST_REQ: 3, MANIFEST: 4, CHUNK_REQ: 5, CHUNK: 6, ERROR: 7 };
const HASH_RE = /^sha256-[0-9a-f]{64}$/;
const HEX_RE = /^[0-9a-f]{64}$/;

/**
 * @typedef {object} IndexEntry
 * @property {number} size      bytes
 * @property {string|null} name
 * @property {string|null} type
 * @property {number} added     ms timestamp
 * @property {number} chunks    chunk count
 * @property {number} have      chunks stored
 * @property {boolean} complete
 *
 * @typedef {object} TransferInfo
 * @property {'fetching'|'waiting'|'done'|'error'} state  waiting: no peer has it (or none answers)
 * @property {number} bytes     bytes stored so far (also those from before a reload)
 * @property {number} total     0 until the manifest is in
 * @property {string[]} peers   peers with requests in flight
 * @property {number} rate      bytes/s received, smoothed
 * @property {string} [error]
 */

/** @type {import('@preact/signals').Signal<Record<string, IndexEntry>>} every blob stored (fully or partly) */
export const index = persist('blobs.index', {});
/** @type {import('@preact/signals').Signal<Record<string, TransferInfo>>} fetches of this page load */
export const transfers = persist('blobs.transfers', {});
/** Counters, for tests and diagnostics: bytes sent/received, chunks rejected by verification. */
export const stats = persist('blobs.stats', () => ({ sent: 0, received: 0, rejected: 0 })).value;

// hash -> { hash, meta: { size, name, type, added, chunks: [hex] }, n, bits: Uint8Array, have, bytes }
const store = persist('blobs.store', () => new Map()).value;
// hash -> { promise, resolve, reject, name, from: Set } for ensure() calls in progress. Kept across
// module reloads: the next instance resumes these fetches and settles the same promises.
const pending = persist('blobs.pending', () => new Map()).value;
const boot = persist('blobs.boot', () => ({ dirs: null, ready: null })).value;

let disposed = false;
const active = new Map(); // hash -> transfer (this instance)
const holders = new Map(); // hash -> Map(peerId -> { complete, bits: Uint8Array | null })
const wanters = new Map(); // hash -> Set(peerId) that asked us for it
const dirty = new Set(); // hashes that gained chunks since the last HAVE to their wanters
const serving = new Map(); // peerId -> { queue, busy }

// ---- bytes and hashes -------------------------------------------------------------------

const enc = new TextEncoder();
const dec = new TextDecoder();
const toHex = (b) => {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
};
const fromHex = (s, out = new Uint8Array(s.length / 2), at = 0) => {
  for (let i = 0; i < s.length / 2; i++) out[at + i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
};
const sha256 = async (data) => new Uint8Array(await crypto.subtle.digest('SHA-256', data));

/** The blob id for a list of raw chunk hashes (n × 32 bytes) and the total size. */
async function rootOf(chunkHashes, size) {
  const buf = new Uint8Array(chunkHashes.length + 8);
  buf.set(chunkHashes);
  new DataView(buf.buffer).setBigUint64(chunkHashes.length, BigInt(size));
  return 'sha256-' + toHex(await sha256(buf));
}

const toBlob = (data) => (data instanceof Blob ? data : new Blob([data]));
async function* chunksOf(blob) {
  for (let at = 0; at < blob.size; at += CHUNK_SIZE)
    yield new Uint8Array(await blob.slice(at, at + CHUNK_SIZE).arrayBuffer());
}

/** The id `data` would get, without storing it. */
export async function hashOf(data) {
  const blob = toBlob(data);
  const hashes = new Uint8Array(Math.ceil(blob.size / CHUNK_SIZE) * 32);
  let i = 0;
  for await (const buf of chunksOf(blob)) hashes.set(await sha256(buf), 32 * i++);
  return rootOf(hashes, blob.size);
}

/** Checks a manifest (n × 32 bytes of chunk hashes, size) against an id. */
export async function verifyManifest(hash, chunkHashes, size) {
  if (!Number.isSafeInteger(size) || size < 0) return false;
  if (chunkHashes.length !== Math.ceil(size / CHUNK_SIZE) * 32) return false;
  return (await rootOf(chunkHashes, size)) === hash;
}

/** Checks one chunk against the manifest of a stored (possibly incomplete) blob. */
export async function verifyChunk(hash, index, bytes) {
  const e = store.get(hash);
  if (!e || !(index >= 0 && index < e.n)) return false;
  return bytes.length === chunkLen(e, index) && toHex(await sha256(bytes)) === e.meta.chunks[index];
}

const packBits = (bits) => {
  const out = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) if (bits[i]) out[i >> 3] |= 1 << (i & 7);
  return out;
};
const unpackBits = (packed, n) => {
  const bits = new Uint8Array(n);
  for (let i = 0; i < n; i++) bits[i] = (packed[i >> 3] >> (i & 7)) & 1;
  return bits;
};

// ---- local store ------------------------------------------------------------------------

function newEntry(hash, meta) {
  const n = meta.chunks.length;
  return { hash, meta, n, bits: new Uint8Array(n), have: 0, bytes: 0, saving: Promise.resolve() };
}
const chunkLen = (e, i) => (i < e.n - 1 ? CHUNK_SIZE : e.meta.size - (e.n - 1) * CHUNK_SIZE);
const isComplete = (e) => e.have === e.n;
function setBit(e, i) {
  if (e.bits[i]) return;
  e.bits[i] = 1;
  e.have++;
  e.bytes += chunkLen(e, i);
}
function clearBit(e, i) {
  if (!e.bits[i]) return;
  e.bits[i] = 0;
  e.have--;
  e.bytes -= chunkLen(e, i);
}
const summary = (e) => ({
  size: e.meta.size,
  name: e.meta.name ?? null,
  type: e.meta.type ?? null,
  added: e.meta.added,
  chunks: e.n,
  have: e.have,
  complete: isComplete(e),
});
function publish(...hashes) {
  const next = { ...index.value };
  for (const h of hashes) {
    const e = store.get(h);
    if (e) next[h] = summary(e);
    else delete next[h];
  }
  index.value = next;
}

function dirs() {
  return (boot.dirs ??= (async () => {
    const root = await navigator.storage.getDirectory();
    const base = await root.getDirectoryHandle(DIR, { create: true });
    return {
      meta: await base.getDirectoryHandle('meta', { create: true }),
      chunks: await base.getDirectoryHandle('chunks', { create: true }),
    };
  })());
}

async function writeFile(dir, name, data) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  try {
    await w.write(data);
    await w.close();
  } catch (err) {
    await w.abort().catch(() => {});
    throw err;
  }
}
async function fileOf(dir, name) {
  try {
    return await (await dir.getFileHandle(name)).getFile();
  } catch (err) {
    if (err.name === 'NotFoundError' || err.name === 'TypeError') return null;
    throw err;
  }
}
const chunkStored = async (hex, len) => (await fileOf((await dirs()).chunks, hex))?.size === len;
const writeChunk = async (hex, bytes) => writeFile((await dirs()).chunks, hex, bytes);
function saveMeta(e) {
  // Serialized per blob, so the last state written is the last one asked for.
  e.saving = e.saving
    .catch(() => {})
    .then(async () =>
      writeFile((await dirs()).meta, `${e.hash}.json`, JSON.stringify({ ...e.meta, complete: isComplete(e) })),
    );
  return e.saving;
}

// Rebuild the store from OPFS, once per page load.
async function scan() {
  const { meta, chunks } = await dirs();
  const present = new Map(); // chunk hex -> file handle
  const strays = []; // other names in chunks/ (swap files left by a crash)
  for await (const [name, h] of chunks.entries()) {
    if (h.kind !== 'file') continue;
    if (HEX_RE.test(name)) present.set(name, h);
    else strays.push([name, h]);
  }
  const referenced = new Set();
  for await (const [name, h] of meta.entries()) {
    const hash = name.endsWith('.json') ? name.slice(0, -5) : '';
    if (!HASH_RE.test(hash) || h.kind !== 'file' || store.has(hash)) continue;
    let m;
    try {
      m = JSON.parse(await (await h.getFile()).text());
    } catch (err) {
      console.warn(`blobs: unreadable metadata ${name}`, err);
      continue;
    }
    const { complete, ...rest } = m;
    const e = newEntry(hash, rest);
    await Promise.all(
      e.meta.chunks.map(async (hex, i) => {
        referenced.add(hex);
        const fh = present.get(hex);
        if (!fh) return;
        if (complete || (await fh.getFile()).size === chunkLen(e, i)) setBit(e, i);
      }),
    );
    store.set(hash, e);
    if (complete && !isComplete(e)) saveMeta(e).catch(() => {});
  }
  index.value = Object.fromEntries([...store].map(([h, e]) => [h, summary(e)]));
  // Chunks of interrupted put()s and swap files: delete once they are old (another tab of this
  // origin may be writing them right now).
  const old = Date.now() - ORPHAN_AGE_MS;
  for (const [name, h] of [...[...present].filter(([hex]) => !referenced.has(hex)), ...strays]) {
    try {
      if ((await h.getFile()).lastModified < old) await chunks.removeEntry(name);
    } catch {}
  }
}

/** Resolves once the store has been read from disk (index is filled). */
export function ready() {
  return (boot.ready ??= scan().catch((err) => {
    boot.ready = null;
    console.error('blobs: reading the store failed', err);
    throw err;
  }));
}

// ---- API --------------------------------------------------------------------------------

/** Stores bytes locally; resolves to their id. */
export async function put(data, { name, type } = {}) {
  await ready();
  const blob = toBlob(data);
  name ??= data?.name ?? null;
  type ??= blob.type || null;
  const size = blob.size;
  const hashes = new Uint8Array(Math.ceil(size / CHUNK_SIZE) * 32);
  const hexes = [];
  let i = 0;
  for await (const buf of chunksOf(blob)) {
    const h = await sha256(buf);
    hashes.set(h, 32 * i++);
    const hex = toHex(h);
    hexes.push(hex);
    if (!(await chunkStored(hex, buf.length))) await writeChunk(hex, buf);
  }
  const hash = await rootOf(hashes, size);
  let e = store.get(hash);
  if (!e) {
    e = newEntry(hash, { size, name, type, added: Date.now(), chunks: hexes });
    store.set(hash, e);
  } else {
    if (name && !e.meta.name) e.meta.name = name;
    if (type && !e.meta.type) e.meta.type = type;
  }
  for (let k = 0; k < e.n; k++) setBit(e, k);
  await saveMeta(e);
  publish(hash);
  dirty.add(hash);
  const t = active.get(hash);
  if (t) pump(t);
  return hash;
}

/** The blob if it is complete locally (a File backed by OPFS), else null. */
export async function get(hash) {
  await ready();
  const e = store.get(hash);
  if (!e || !isComplete(e)) return null;
  const { chunks } = await dirs();
  const files = await Promise.all(e.meta.chunks.map(async (hex) => (await chunks.getFileHandle(hex)).getFile()));
  return new File(files, e.meta.name || hash, { type: e.meta.type || '' });
}

/** Whether the blob is complete locally. */
export function has(hash) {
  const e = store.get(hash);
  return e ? isComplete(e) : !!index.value[hash]?.complete;
}

/**
 * The blob, fetched from peers if it isn't complete locally. Concurrent calls share one fetch.
 * `from`: peers known to have it (asked first, and assumed to hold it until they say otherwise).
 * Waits (state 'waiting') while no peer has it; rejects on storage errors or remove().
 */
export async function ensure(hash, { name, from } = {}) {
  if (!HASH_RE.test(hash)) throw new Error(`blobs: not a blob id: ${hash}`);
  await ready();
  const e = store.get(hash);
  if (e && isComplete(e)) return get(hash);
  let d = pending.get(hash);
  if (!d) {
    d = { name: name ?? null, from: new Set() };
    d.promise = new Promise((resolve, reject) => Object.assign(d, { resolve, reject }));
    pending.set(hash, d);
  } else if (name && !d.name) d.name = name;
  for (const p of from ?? []) d.from.add(p);
  if (!disposed) {
    const t = active.get(hash) ?? startTransfer(hash);
    if (from?.length) {
      for (const p of from) sendMsg(p, OP.WANT, { hashes: [hash] });
      pump(t);
    }
  }
  await d.promise;
  return get(hash);
}

/** Stops fetching a blob (its ensure() calls reject); what was stored stays. */
export function cancel(hash, reason = 'cancelled') {
  const t = active.get(hash);
  if (t) fail(t, new Error(reason));
  else settle(hash, new Error(reason));
}

/** Deletes a blob (chunks shared with other blobs stay). */
export async function remove(hash) {
  await ready();
  cancel(hash, 'removed');
  const e = store.get(hash);
  store.delete(hash);
  publish(hash);
  const { [hash]: _, ...rest } = transfers.value;
  transfers.value = rest;
  if (!e) return;
  const { meta, chunks } = await dirs();
  await e.saving.catch(() => {});
  await meta.removeEntry(`${hash}.json`).catch(() => {});
  const used = new Set();
  for (const o of store.values()) for (const hex of o.meta.chunks) used.add(hex);
  for (const hex of new Set(e.meta.chunks)) if (!used.has(hex)) await chunks.removeEntry(hex).catch(() => {});
}

/** Peers known to hold (part of) a blob: peerId -> { complete, have }. */
export function holdersOf(hash) {
  const out = {};
  for (const [p, h] of holders.get(hash) ?? []) out[p] = { complete: h.complete, have: h.bits ? h.bits.reduce((a, b) => a + b, 0) : null };
  return out;
}

// ---- protocol ---------------------------------------------------------------------------

function encode(op, header, payload) {
  const h = enc.encode(JSON.stringify(header));
  const out = new Uint8Array(5 + h.length + (payload?.length ?? 0));
  out[0] = op;
  new DataView(out.buffer).setUint32(1, h.length);
  out.set(h, 5);
  if (payload) out.set(payload, 5 + h.length);
  return out;
}
function decode(bytes) {
  if (bytes.length < 5) return null;
  const hl = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1);
  if (5 + hl > bytes.length) return null;
  const header = JSON.parse(dec.decode(bytes.subarray(5, 5 + hl)));
  if (!header || typeof header !== 'object') return null;
  return { op: bytes[0], header, payload: bytes.subarray(5 + hl) };
}
const sendMsg = (peer, op, header, payload) => room.send(peer, 'blob', encode(op, header, payload));
const sendError = (peer, hash, index, error) => sendMsg(peer, OP.ERROR, { hash, index, error });
function sendHave(peer, e) {
  const complete = isComplete(e);
  return sendMsg(peer, OP.HAVE, { hash: e.hash, size: e.meta.size, chunks: e.n, complete }, complete ? null : packBits(e.bits));
}

function onMessage(from, bytes) {
  let m;
  try {
    m = decode(bytes);
  } catch {
    return;
  }
  if (!m) return;
  const { op, header: h, payload } = m;
  if (op !== OP.WANT && !HASH_RE.test(h.hash)) return;
  if ('index' in h && h.index != null && !Number.isInteger(h.index)) return;
  const run = {
    [OP.WANT]: onWant,
    [OP.HAVE]: onHave,
    [OP.MANIFEST_REQ]: onManifestReq,
    [OP.MANIFEST]: onManifest,
    [OP.CHUNK_REQ]: onChunkReq,
    [OP.CHUNK]: onChunk,
    [OP.ERROR]: onError,
  }[op];
  if (!run) return;
  Promise.resolve(run(from, h, payload)).catch((err) => console.warn(`blobs: handling op ${op} from ${from.slice(0, 8)} failed`, err));
}

function onWant(from, h) {
  if (!Array.isArray(h.hashes)) return;
  for (const hash of h.hashes.slice(0, 256)) {
    if (!HASH_RE.test(hash)) continue;
    if (!wanters.has(hash)) wanters.set(hash, new Set());
    wanters.get(hash).add(from);
    const e = store.get(hash);
    if (e?.have) sendHave(from, e);
  }
}

function onHave(from, h, payload) {
  const t = active.get(h.hash);
  if (!t || !Number.isInteger(h.chunks) || h.chunks < 0) return;
  if (!holders.has(h.hash)) holders.set(h.hash, new Map());
  const bits = h.complete ? null : unpackBits(payload, h.chunks);
  if (bits && !bits.some((b) => b)) holders.get(h.hash).delete(from);
  else holders.get(h.hash).set(from, { complete: !!h.complete, bits });
  pump(t);
}

function onManifestReq(from, h) {
  const e = store.get(h.hash);
  if (!e) return sendError(from, h.hash, null, 'unknown');
  const payload = new Uint8Array(e.n * 32);
  e.meta.chunks.forEach((hex, i) => fromHex(hex, payload, i * 32));
  sendMsg(from, OP.MANIFEST, { hash: e.hash, size: e.meta.size, name: e.meta.name, type: e.meta.type }, payload);
}

async function onManifest(from, h, payload) {
  const t = active.get(h.hash);
  if (!t || store.has(h.hash)) return;
  if (t.manifestReq?.peer === from) t.manifestReq = null;
  if (!(await verifyManifest(h.hash, payload, h.size))) {
    stats.rejected++;
    console.warn(`blobs: manifest of ${h.hash.slice(0, 16)} from ${from.slice(0, 8)} failed verification`);
    strike(t, from, MAX_STRIKES);
    return pump(t);
  }
  const chunks = [];
  for (let i = 0; i < payload.length; i += 32) chunks.push(toHex(payload.subarray(i, i + 32)));
  const str = (v) => (typeof v === 'string' ? v.slice(0, 1024) : null);
  const e = newEntry(h.hash, {
    size: h.size,
    name: pending.get(h.hash)?.name ?? str(h.name),
    type: str(h.type),
    added: Date.now(),
    chunks,
  });
  // Chunks we already hold for other blobs (or from an earlier, forgotten attempt) count.
  await Promise.all(chunks.map(async (hex, i) => (await chunkStored(hex, chunkLen(e, i))) && setBit(e, i)));
  if (store.has(h.hash) || t.stopped) return;
  store.set(h.hash, e);
  try {
    await saveMeta(e);
  } catch (err) {
    return fail(t, err);
  }
  publish(h.hash);
  dirty.add(h.hash);
  pump(t);
}

function onChunkReq(from, h) {
  const e = store.get(h.hash);
  if (!e || !(h.index >= 0 && h.index < e.n) || !e.bits[h.index]) return sendError(from, h.hash, h.index, 'missing');
  let s = serving.get(from);
  if (!s) serving.set(from, (s = { queue: [], busy: false }));
  if (s.queue.length >= SERVE_QUEUE) return sendError(from, h.hash, h.index, 'busy');
  s.queue.push({ hash: h.hash, index: h.index });
  if (!s.busy) serve(from, s);
}

async function serve(peer, s) {
  s.busy = true;
  try {
    while (s.queue.length && serving.get(peer) === s && !disposed) {
      const { hash, index: i } = s.queue.shift();
      const e = store.get(hash);
      if (!e?.bits[i]) {
        sendError(peer, hash, i, 'missing');
        continue;
      }
      let buf;
      try {
        const f = await fileOf((await dirs()).chunks, e.meta.chunks[i]);
        if (f?.size !== chunkLen(e, i)) throw new Error('chunk file missing or truncated');
        buf = new Uint8Array(await f.arrayBuffer());
      } catch (err) {
        console.warn(`blobs: cannot read chunk ${i} of ${hash.slice(0, 16)}`, err);
        clearBit(e, i);
        publish(hash);
        saveMeta(e).catch(() => {});
        sendError(peer, hash, i, 'unreadable');
        continue;
      }
      await room.drained(peer, 'blob', 2 * CHUNK_SIZE);
      if (!sendMsg(peer, OP.CHUNK, { hash, index: i }, buf)) break;
      stats.sent += buf.length;
    }
  } finally {
    s.busy = false;
  }
}

async function onChunk(from, h, payload) {
  const t = active.get(h.hash);
  const e = store.get(h.hash);
  if (!t || !e || !(h.index >= 0 && h.index < e.n)) return;
  const i = h.index;
  if (t.inflight.get(i)?.peer === from) t.inflight.delete(i);
  if (e.bits[i] || t.writing.has(i)) return pump(t);
  t.writing.add(i);
  try {
    t.recv += payload.length;
    stats.received += payload.length;
    if (!(await verifyChunk(h.hash, i, payload))) {
      stats.rejected++;
      console.warn(`blobs: chunk ${i} of ${h.hash.slice(0, 16)} from ${from.slice(0, 8)} failed verification`);
      strike(t, from);
      return;
    }
    try {
      await writeChunk(e.meta.chunks[i], payload);
    } catch (err) {
      return fail(t, err);
    }
    if (store.get(h.hash) !== e) return; // removed meanwhile
    setBit(e, i);
    if (isComplete(e)) await saveMeta(e).catch((err) => console.warn('blobs: saving metadata failed', err));
    publish(h.hash);
    dirty.add(h.hash);
  } finally {
    t.writing.delete(i);
    pump(t);
  }
}

function onError(from, h) {
  const t = active.get(h.hash);
  if (!t) return;
  if (h.index == null) {
    // 'unknown': they don't have the manifest.
    if (t.manifestReq?.peer === from) t.manifestReq = null;
    holders.get(h.hash)?.delete(from);
    t.hints.delete(from);
    return pump(t);
  }
  if (t.inflight.get(h.index)?.peer === from) t.inflight.delete(h.index);
  if (h.error === 'missing' || h.error === 'unreadable') {
    const holder = holders.get(h.hash)?.get(from);
    if (holder?.bits) holder.bits[h.index] = 0;
    else if (holder || t.hints.has(from)) {
      // Thought complete; it isn't. Wait for its HAVE.
      holders.get(h.hash)?.delete(from);
      t.hints.delete(from);
      sendMsg(from, OP.WANT, { hashes: [h.hash] });
    }
  }
  pump(t);
}

// ---- fetching ---------------------------------------------------------------------------

function startTransfer(hash) {
  const d = pending.get(hash);
  const t = {
    hash,
    stopped: false,
    hints: new Set(d?.from ?? []),
    manifestReq: null, // { peer, at }
    inflight: new Map(), // chunk index -> { peer, at }
    writing: new Set(), // chunk indexes received, being verified/written
    strikes: new Map(), // peer -> count
    banned: new Map(), // peer -> until (ms)
    lastWant: 0,
    recv: 0,
    lastRecv: 0,
    lastTick: Date.now(),
    rate: 0,
  };
  active.set(hash, t);
  want(t);
  pump(t);
  return t;
}

function want(t) {
  t.lastWant = Date.now();
  for (const p of room.openPeers()) sendMsg(p, OP.WANT, { hashes: [t.hash] });
}

function strike(t, peer, by = 1) {
  const n = (t.strikes.get(peer) ?? 0) + by;
  if (n < MAX_STRIKES) return t.strikes.set(peer, n);
  t.strikes.delete(peer);
  t.banned.set(peer, Date.now() + BAN_MS);
  for (const [i, r] of t.inflight) if (r.peer === peer) t.inflight.delete(i);
  if (t.manifestReq?.peer === peer) t.manifestReq = null;
}

function pump(t) {
  if (t.stopped) return;
  const e = store.get(t.hash);
  if (e && isComplete(e)) return finish(t);
  const now = Date.now();
  const open = new Set(room.openPeers());
  const hs = holders.get(t.hash) ?? new Map();
  const peers = [...new Set([...hs.keys(), ...t.hints])].filter((p) => open.has(p) && !((t.banned.get(p) ?? 0) > now));
  if (!e) {
    if (!t.manifestReq) {
      for (const p of [...peers].sort((a, b) => (hs.get(b)?.complete ?? 0) - (hs.get(a)?.complete ?? 0))) {
        if (sendMsg(p, OP.MANIFEST_REQ, { hash: t.hash })) {
          t.manifestReq = { peer: p, at: now };
          break;
        }
      }
    }
    return report(t, e);
  }
  const missing = [];
  for (let i = 0; i < e.n; i++) if (!e.bits[i] && !t.inflight.has(i) && !t.writing.has(i)) missing.push(i);
  const load = new Map(peers.map((p) => [p, 0]));
  for (const r of t.inflight.values()) if (load.has(r.peer)) load.set(r.peer, load.get(r.peer) + 1);
  const taken = new Uint8Array(missing.length);
  const pos = new Map();
  // Round-robin: each peer with a free slot takes the next missing chunk it has.
  for (let assigned = true; assigned; ) {
    assigned = false;
    for (const p of peers) {
      if (load.get(p) >= WINDOW) continue;
      const bits = hs.get(p)?.bits ?? null; // null: complete (or a hint)
      let k = pos.get(p) ?? 0;
      while (k < missing.length && (taken[k] || (bits && !bits[missing[k]]))) k++;
      pos.set(p, k + 1);
      if (k >= missing.length) continue;
      if (!sendMsg(p, OP.CHUNK_REQ, { hash: t.hash, index: missing[k] })) {
        load.set(p, WINDOW);
        continue;
      }
      taken[k] = 1;
      t.inflight.set(missing[k], { peer: p, at: now });
      load.set(p, load.get(p) + 1);
      assigned = true;
    }
  }
  report(t, e);
}

function setTransfer(hash, info) {
  transfers.value = { ...transfers.value, [hash]: info };
}
function report(t, e) {
  const peers = new Set([...t.inflight.values()].map((r) => r.peer));
  if (t.manifestReq) peers.add(t.manifestReq.peer);
  setTransfer(t.hash, {
    state: peers.size || t.writing.size ? 'fetching' : 'waiting',
    bytes: e?.bytes ?? 0,
    total: e?.meta.size ?? 0,
    peers: [...peers],
    rate: Math.round(t.rate),
    name: e?.meta.name ?? pending.get(t.hash)?.name ?? null,
  });
}

function settle(hash, err) {
  const d = pending.get(hash);
  if (!d) return;
  pending.delete(hash);
  if (err) d.reject(err);
  else d.resolve();
}
function finish(t) {
  t.stopped = true;
  active.delete(t.hash);
  holders.delete(t.hash);
  const e = store.get(t.hash);
  setTransfer(t.hash, { state: 'done', bytes: e.meta.size, total: e.meta.size, peers: [], rate: Math.round(t.rate) });
  settle(t.hash, null);
}
function fail(t, err) {
  t.stopped = true;
  active.delete(t.hash);
  holders.delete(t.hash);
  const e = store.get(t.hash);
  setTransfer(t.hash, {
    state: 'error',
    bytes: e?.bytes ?? 0,
    total: e?.meta.size ?? 0,
    peers: [],
    rate: 0,
    error: String(err?.message ?? err),
  });
  settle(t.hash, err);
}

function tick() {
  const now = Date.now();
  for (const t of [...active.values()]) {
    const dt = (now - t.lastTick) / 1000;
    t.rate = 0.5 * t.rate + (0.5 * (t.recv - t.lastRecv)) / Math.max(dt, 0.001);
    t.lastRecv = t.recv;
    t.lastTick = now;
    for (const [i, r] of t.inflight) {
      if (now - r.at < REQUEST_TIMEOUT_MS) continue;
      t.inflight.delete(i);
      strike(t, r.peer);
    }
    if (t.manifestReq && now - t.manifestReq.at > MANIFEST_TIMEOUT_MS) {
      const p = t.manifestReq.peer;
      t.manifestReq = null;
      strike(t, p);
    }
    if (now - t.lastWant > WANT_EVERY_MS) want(t);
    pump(t);
  }
  // Tell peers that asked for a blob about chunks we gained.
  const open = new Set(room.openPeers());
  for (const hash of dirty) {
    const e = store.get(hash);
    const ws = wanters.get(hash);
    if (e && ws) for (const p of ws) if (open.has(p)) sendHave(p, e);
    if (!e || isComplete(e)) wanters.delete(hash);
  }
  dirty.clear();
}

function onPeer(peer, state) {
  if (state === 'open') {
    const hashes = [...active.keys()];
    for (let i = 0; i < hashes.length; i += 256) sendMsg(peer, OP.WANT, { hashes: hashes.slice(i, i + 256) });
    return;
  }
  serving.delete(peer);
  for (const ws of wanters.values()) ws.delete(peer);
  for (const hs of holders.values()) hs.delete(peer);
  for (const t of active.values()) {
    for (const [i, r] of t.inflight) if (r.peer === peer) t.inflight.delete(i);
    if (t.manifestReq?.peer === peer) t.manifestReq = null;
    pump(t);
  }
}

const unsubs = [room.on('blob', onMessage), room.onPeer(onPeer)];
const timer = setInterval(tick, TICK_MS);

// Resume the fetches a previous instance of this module was running.
ready()
  .then(() => {
    for (const hash of pending.keys()) if (!disposed && !active.has(hash)) startTransfer(hash);
  })
  .catch(() => {});

export function dispose() {
  disposed = true;
  clearInterval(timer);
  for (const f of unsubs) f();
  // Fetches stop here; their ensure() promises stay pending for the next instance to settle.
  for (const t of active.values()) t.stopped = true;
  active.clear();
  serving.clear();
}
