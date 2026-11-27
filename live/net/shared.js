// shared(): binds a signal to the open session's document (session.js), so its value is synced
// with everyone in the session. Everything not bound stays local. The contract:
//
//   shared('timeline.layers', layers, { kind: 'list' })     // array of { id, … } entities
//   shared('timeline.masked', masked, { kind: 'map' })      // Record<string, value>
//
// - Writes are diffs per entity and field against the value this page last saw, so concurrent
//   edits of different fields (or entities) by different peers merge. Fields this page's code
//   doesn't know (added by a peer running newer code) are carried through and never deleted.
// - `local: ['field', …]`: per-machine fields (an input device id) are neither written nor
//   overwritten: they're kept from this page's previous value of the entity.
// - `encode(entity)` / `decode(entity, prev)`: map an entity to/from its document form (e.g. a
//   clip's Float32Array to a blob hash). decode may return null (leave it out) or a promise; the
//   entity then shows up (or updates) once it resolves.
// - `valid(entity, id)`: entities from the document that fail it are skipped (and reported once):
//   a peer's buggy or newer code can't feed this page values its rendering would crash on. They
//   stay in the document; nothing is deleted for others. Malformed containers read as empty.
// - `keepLocal(entity)`: entities not (yet) shared, e.g. a clip still recording: neither written
//   nor removed by remote changes. A shared entity it holds (a clip given new vectors that aren't
//   stored yet) keeps its local version and its place until it is written.
// - A key missing from the document is seeded from the local value (or `seedFrom()`) when the session adopts local
//   state (the first session on this machine), else the signal is reset to `empty()`. So a local
//   module introducing new shared state just starts writing it; peers without that code ignore it.
// - Changes are grouped into actions (history.js): act(label, fn) names one; otherwise edits are
//   flushed every FLUSH_MS and labelled after the key.
//
// Document layout: state[key] = { items: { id: entity }, order: [id] } for lists, a plain map for maps.
import { Automerge } from '@automerge/automerge-repo';
import { handle } from './session.js';
import * as db from '../lib/db.js';
import * as history from './history.js';

const FLUSH_MS = 40;

/**
 * Whether local edits reach the document (diag.js reports these to peers). `dropped`: edits made
 * while a session is open that were never written (the binding wasn't attached to the open
 * document); `errors`: document writes that threw.
 */
export const stats = { loadedAt: Date.now(), writes: 0, lastWrite: null, dropped: 0, lastDropped: null, errors: 0, lastError: null };
const warnedDrop = new Map(); // key -> last warning time
function dropped(key, why) {
  stats.dropped++;
  stats.lastDropped = { at: Date.now(), key, why };
  const now = Date.now();
  if (now - (warnedDrop.get(key) ?? 0) < 10000) return;
  warnedDrop.set(key, now);
  console.warn(`shared: edit of ${key} not written to the document: ${why}`);
}

/** @type {Map<string, Binding>} */
const bindings = new Map();
const dirty = new Set();
let timer = 0;
let applying = false; // true while writing doc → signals

// Automerge stores integers beyond 2^53 as (clamped) int64 and reads them back as BigInt, which
// JSON can't serialize: read BigInts as numbers, and write such numbers as floats (toDoc).
const noBig = (_k, x) => (typeof x === 'bigint' ? Number(x) : x);
const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v, noBig)));
const same = (a, b) => a === b || JSON.stringify(a, noBig) === JSON.stringify(b, noBig);
// Long strings (function sources, …) are stored whole: as collaborative text Automerge keeps an op
// per character, which makes writing, loading and syncing them orders of magnitude slower. Reading
// goes through JSON, which turns them back into strings.
const LONG = 256;
const toDoc = (v) => {
  if (typeof v === 'string') return v.length >= LONG ? new Automerge.ImmutableString(v) : v;
  if (typeof v === 'number') return Number.isInteger(v) && !Number.isSafeInteger(v) ? new Automerge.Float64(v) : v;
  if (Array.isArray(v)) return v.map(toDoc);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k in v) out[k] = toDoc(v[k]);
    return out;
  }
  return v;
};
const clean = (o) => {
  const out = {};
  for (const k in o) if (o[k] !== undefined && typeof o[k] !== 'function') out[k] = o[k];
  return out;
};

/**
 * @param {string} key
 * @param {import('@preact/signals').Signal} sig
 * @param {{ kind?: 'list'|'map', local?: string[], encode?: (e:any)=>any, decode?: (e:any, prev:any)=>any, keepLocal?: (e:any)=>boolean, empty?: () => any, seedFrom?: () => any, label?: string }} [opts]
 * @returns {() => void} unbind
 */
export function shared(key, sig, opts = {}) {
  const b = {
    key,
    sig,
    kind: opts.kind ?? (Array.isArray(sig.value) ? 'list' : 'map'),
    local: new Set(opts.local ?? []),
    encode: opts.encode ?? ((e) => e),
    decode: opts.decode ?? ((e) => e),
    empty: opts.empty ?? (() => (Array.isArray(sig.value) ? [] : {})),
    label: opts.label ?? `edit ${key}`,
    seen: null, // encoded form of the signal's value as last synced (list: Map id → entity)
    attachedTo: null,
    attachGen: 0,
    decoded: new Map(), // id -> { json, value } of async decodes
    keepLocal: opts.keepLocal ?? (() => false),
    valid: opts.valid ?? (() => true),
    pending: 0, // decode generation
    // value to adopt when this machine's first session is created (e.g. migrated from kv)
    seedFrom: opts.seedFrom ?? (() => sig.value),
  };
  bindings.get(key)?.unbind();
  bindings.set(key, b);
  const offSig = sig.subscribe((v) => {
    if (b.local.size && b.attachedTo && b.localsLoaded && Array.isArray(v)) saveLocals(b, v);
    // Our own write from the document isn't an edit. `applying` alone can't tell: a write made
    // inside an effect (attach runs in handle.subscribe) notifies only after the effect, when
    // `applying` is false again; so the value setSignal wrote is recognised by identity too.
    if (applying || v === b.fromDocValue) return;
    if (!b.attachedTo) {
      // Before a session is open nothing is shared; with one open, the document's value will
      // replace this edit when the binding attaches.
      if (handle.peek()) dropped(key, 'not attached to the open document');
      return;
    }
    dirty.add(key);
    clearTimeout(timer);
    timer = setTimeout(flush, FLUSH_MS);
  });
  const offDoc = handle.subscribe((h) => attach(b, h)); // subscribe callbacks are untracked
  b.unbind = () => {
    if (dirty.has(key)) flush();
    offSig();
    offDoc();
    b.offChange?.();
    clearTimeout(b.rereadTimer);
    if (bindings.get(key) === b) bindings.delete(key);
  };
  return b.unbind;
}

function attach(b, h) {
  b.offChange?.();
  b.offChange = null;
  b.attachedTo = null;
  b.seen = null;
  if (!h) return;
  const gen = ++b.attachGen;
  const onChange = ({ doc: d }) => {
    if (!flushing && b.attachedTo === h) fromDoc(b, d);
  };
  h.on('change', onChange);
  b.offChange = () => h.off('change', onChange);
  const doc = h.doc();
  if (b.local.size) {
    // Per-machine fields live in kv per document; until they're read, keep what the signal has.
    b.locals = new Map();
    b.localsLoaded = false;
    db.get('kv', localsKey(b, h)).catch(() => null).then((m) => {
      if (gen !== b.attachGen) return;
      b.localsLoaded = true;
      if (!m) return;
      b.locals = new Map(Object.entries(m));
      const v = b.sig.value;
      if (Array.isArray(v)) setSignal(b, v.map((e) => (b.locals.has(String(e.id)) ? { ...e, ...b.locals.get(String(e.id)) } : e)));
    });
  }
  if (doc?.state?.[b.key] !== undefined) {
    b.attachedTo = h;
    return fromDoc(b, doc);
  }
  // Missing from the document: seed it (from what this machine had, for the session adopting
  // local state; else empty).
  Promise.resolve(doc?.meta?.seed ? b.seedFrom() : b.empty()).then((v) => {
    if (gen !== b.attachGen) return;
    if (h.doc()?.state?.[b.key] !== undefined) {
      b.attachedTo = h;
      return fromDoc(b, h.doc()); // a peer's arrived meanwhile
    }
    v ??= b.empty();
    b.attachedTo = h;
    setSignal(b, v);
    h.change((d) => {
      d.state ??= {};
      { const cur = d.state[b.key]; const c = container(b, cur); if (c !== cur) d.state[b.key] = c; }
      writeInto(b, d.state[b.key], v);
    }, { message: JSON.stringify({ label: `share ${b.key}`, origin: 'seed' }) });
  }, (e) => console.warn(`shared: seeding ${b.key} failed`, e));
}

const localsKey = (b, h) => `shared.local:${h.url}:${b.key}`;
function saveLocals(b, list) {
  const m = {};
  for (const e of list) {
    const o = {};
    for (const f of b.local) if (e[f] !== undefined) o[f] = e[f];
    if (Object.keys(o).length) m[e.id] = o;
  }
  const json = JSON.stringify(m);
  if (json === b.localsJSON) return;
  b.localsJSON = json;
  b.locals = new Map(Object.entries(m));
  clearTimeout(b.localsTimer);
  const key = localsKey(b, b.attachedTo);
  b.localsTimer = setTimeout(() => db.put('kv', key, m).catch(() => {}), 250);
}

// ---- doc → signal ----------------------------------------------------------------------------

const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const reported = new Set();
function invalid(b, id, why) {
  const k = `${b.key}:${id}:${why}`;
  if (reported.has(k)) return;
  reported.add(k);
  console.warn(`shared: ignoring ${b.key} ${id}: ${why}`);
}
function check(b, e, id) {
  try {
    if (b.valid(e, id)) return true;
    invalid(b, id, 'fails validation');
  } catch (err) {
    invalid(b, id, `validation threw: ${err.message}`);
  }
  return false;
}

function readDoc(b, d) {
  const s = d?.state?.[b.key];
  if (b.kind === 'map') {
    if (!isObj(s)) return (s != null && invalid(b, '(all)', 'not a map'), {});
    const out = {};
    for (const [k, v] of Object.entries(plain(s))) if (check(b, v, k)) out[k] = v;
    return out;
  }
  if (!isObj(s) || !isObj(s.items)) return (s != null && invalid(b, '(all)', 'not a list'), []);
  const items = s.items;
  const order = Array.isArray(s.order) ? s.order : [];
  const ids = [];
  const seenIds = new Set();
  for (const id of order) if (typeof id === 'string' && items[id] && !seenIds.has(id)) (ids.push(id), seenIds.add(id));
  for (const id of Object.keys(items).sort()) if (!seenIds.has(id)) ids.push(id); // concurrently added
  const out = [];
  for (const id of ids) {
    const e = plain(items[id]);
    if (!isObj(e) || e.id !== id) invalid(b, id, 'not an entity');
    else if (check(b, e, id)) out.push(e);
  }
  return out;
}

function fromDoc(b, d) {
  const enc = readDoc(b, d);
  if (b.kind === 'map') {
    if (b.seen && same(b.seen, enc)) return;
    b.seen = enc;
    const prev = b.sig.value ?? {};
    const out = {};
    for (const k in enc) out[k] = b.decode(enc[k], prev[k]);
    return setSignal(b, out);
  }
  const seen = new Map(enc.map((e) => [e.id, e]));
  const reread = b.reread;
  b.reread = false;
  if (!reread && b.seen && b.seen.size === seen.size && same([...b.seen.values()], enc)) return;
  const prevList = b.sig.value ?? [];
  const prevById = new Map(prevList.map((e) => [e.id, e]));
  const prevSeen = b.seen;
  b.seen = seen;
  // Entities in the document this page can't show yet (decode pending, no previous version): not
  // in the signal, but they mustn't look deleted to writeInto.
  b.loading = new Set();
  // Local edits not flushed yet (within FLUSH_MS) would be lost by taking the document's version:
  // keep the locally changed fields (and local adds/removes) so the pending flush writes them.
  const docIds = new Set(enc.map((e) => e.id));
  const edits = new Map();
  const removed = new Set();
  if (dirty.has(b.key) && prevSeen) {
    for (const p of prevList) {
      if (p?.id == null || b.keepLocal(p)) continue;
      const was = prevSeen.get(String(p.id));
      const now = clean(plain(clean(b.encode(p))));
      for (const f of b.local) delete now[f];
      if (!was) {
        if (!docIds.has(p.id)) edits.set(p.id, null);
        continue;
      }
      const fields = Object.keys({ ...now, ...was }).filter((f) => !same(now[f], was[f]));
      if (fields.length) edits.set(p.id, Object.fromEntries(fields.map((f) => [f, now[f]])));
    }
    for (const id of prevSeen.keys()) if (!prevById.has(id)) removed.add(id);
  }
  const out = [];
  for (const e of enc) {
    if (removed.has(e.id)) continue;
    const prev = prevById.get(e.id);
    const mine = edits.get(e.id);
    if (mine) {
      const was = prevSeen.get(String(e.id));
      seen.set(e.id, { ...e, ...Object.fromEntries(Object.keys(mine).map((f) => [f, was[f]])) });
      const v = b.decode(e, prev);
      out.push({ ...prev, ...(v?.then ? null : v), ...mine });
      continue;
    }
    // Unchanged entity: keep the local object as is (identity matters to caches and memos).
    if (prev && prevSeen && same(prevSeen.get(e.id), e)) {
      out.push(prev);
      continue;
    }
    const local = { ...b.locals?.get(String(e.id)) };
    if (prev) for (const f of b.local) if (prev[f] !== undefined) local[f] = prev[f];
    const json = JSON.stringify(e);
    const cached = b.decoded.get(e.id)?.json === json ? b.decoded.get(e.id) : null;
    // A decode already in flight for this version is waited for, not started again: every re-read
    // while N entities load would otherwise start N more (each reading and copying a whole blob).
    let v = cached ? (cached.pending ?? cached.value) : b.decode(e, prev);
    if (v?.then) {
      // Not available yet (e.g. a blob still downloading): leave it out, re-read once it is.
      if (!cached) {
        const entry = { json, pending: v };
        b.decoded.set(e.id, entry);
        v.then((value) => {
          if (b.decoded.get(e.id) !== entry) return; // superseded by a newer version
          b.decoded.set(e.id, { json, value });
          if (value) rereadSoon(b);
        }, (err) => {
          if (b.decoded.get(e.id) === entry) b.decoded.delete(e.id); // retried on the next read
          console.warn(`shared: decoding ${b.key} ${e.id} failed`, err);
        });
      }
      if (prev) {
        // Keep showing the old version meanwhile; `seen` records it, so local edits of it diff right.
        out.push(prev);
        seen.set(e.id, clean(plain(clean(b.encode(prev)))));
      } else b.loading.add(String(e.id));
      continue;
    }
    if (v) out.push({ ...v, ...local });
  }
  for (const [id, f] of edits) if (f === null) out.push(prevById.get(id));
  // Entities that exist only here (keepLocal) stay, after the shared ones.
  for (const e of prevList) if (b.keepLocal(e) && !seen.has(e.id)) out.push(e);
  // Shared entities changed here that can't be written yet (keepLocal, e.g. a clip whose new
  // vectors are still being stored) keep the local version, not the document's older one. `seen`
  // keeps what this page last saw of them, so once they're written only this page's changes go.
  for (const p of prevList) {
    if (!p || !b.keepLocal(p) || !seen.has(p.id)) continue;
    const i = out.findIndex((e) => e.id === p.id);
    if (i === -1) out.push(p);
    else out[i] = p;
    if (prevSeen?.has(p.id)) seen.set(p.id, prevSeen.get(p.id));
  }
  setSignal(b, out);
}

/**
 * After writing, the signal should show what the document holds. If it doesn't (a bug in the
 * diffing: seen out of step with the document), every later read would look unchanged and the view
 * would stay wrong until the next edit: report what differs and re-read from the document.
 */
const sameDeep = (a, b) => {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) => a[k] !== undefined);
  const kb = Object.keys(b).filter((k) => b[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => sameDeep(a[k], b[k]));
};
function checkDrift(b) {
  if (!b?.attachedTo || !b.seen) return;
  const enc = (e) => {
    const o = clean(plain(clean(b.encode(e))));
    for (const f of b.local) delete o[f];
    return o;
  };
  let mine, theirs;
  if (b.kind === 'map') {
    mine = {};
    for (const k in b.sig.peek() ?? {}) if (b.sig.peek()[k] !== undefined) mine[k] = plain(b.encode(b.sig.peek()[k]));
    theirs = b.seen;
  } else {
    const all = (b.sig.peek() ?? []).filter((e) => e && e.id != null);
    mine = all.filter((e) => !b.keepLocal(e)).map(enc);
    const held = new Set(all.filter((e) => b.keepLocal(e)).map((e) => String(e.id))); // not written yet
    theirs = [...b.seen.values()].filter((e) => !b.loading?.has(String(e.id)) && !held.has(String(e.id))).map((e) => (b.local.size ? Object.fromEntries(Object.entries(e).filter(([f]) => !b.local.has(f))) : e));
  }
  if (sameDeep(mine, theirs)) return;
  const same = sameDeep;
  const ids = (l) => (Array.isArray(l) ? l.map((e) => e.id) : Object.keys(l));
  const diff = Array.isArray(mine)
    ? {
        order: same(ids(mine), ids(theirs)) ? 'same' : { mine: ids(mine), doc: ids(theirs) },
        fields: mine.flatMap((e) => {
          const t = theirs.find((x) => x.id === e.id);
          if (!t) return [];
          return Object.keys({ ...e, ...t }).filter((f) => !same(e[f], t[f])).map((f) => `${e.id}.${f}`);
        }),
      }
    : Object.keys({ ...mine, ...theirs }).filter((k) => !same(mine[k], theirs[k]));
  console.warn(`shared: drift in ${b.key} after writing; re-reading`, JSON.stringify(diff).slice(0, 2000));
  queueMicrotask(() => refresh(b));
}

/** Re-reads a binding from its document from scratch (after drift). */
function refresh(b) {
  if (!b.attachedTo) return;
  b.seen = null;
  fromDoc(b, b.attachedTo.doc());
}

/**
 * Re-reads a binding once async decodes have finished, batched: loading a session resolves many
 * decodes in a burst, and each re-read walks the whole list and sets the signal (re-rendering
 * everything that shows it). Unchanged entities keep their objects (`seen` is kept).
 */
const REREAD_MS = 50;
function rereadSoon(b) {
  if (b.rereadTimer) return;
  b.rereadTimer = setTimeout(() => {
    b.rereadTimer = 0;
    if (!b.attachedTo) return;
    b.reread = true;
    fromDoc(b, b.attachedTo.doc());
  }, REREAD_MS);
}

function setSignal(b, v) {
  b.fromDocValue = v;
  applying = true;
  try {
    b.sig.value = v;
  } finally {
    applying = false;
  }
}

// ---- signal → doc ----------------------------------------------------------------------------

let flushing = false;

/** Writes pending local edits to the document as one change labelled `label`. */
export function flush(label, origin = 'local') {
  clearTimeout(timer);
  for (const k of dirty) if (!bindings.get(k)?.attachedTo) dropped(k, bindings.has(k) ? 'detached before writing' : 'unbound before writing');
  const keys = [...dirty].filter((k) => bindings.get(k)?.attachedTo);
  dirty.clear();
  if (!keys.length) return null;
  const h = bindings.get(keys[0]).attachedTo;
  for (const k of keys) if (bindings.get(k).attachedTo !== h) dropped(k, 'attached to a different document');
  const before = h.heads();
  flushing = true;
  try {
    h.change(
      (d) => {
        d.state ??= {};
        for (const k of keys) {
          const b = bindings.get(k);
          if (b.attachedTo !== h) continue;
          { const cur = d.state[k]; const c = container(b, cur); if (c !== cur) d.state[k] = c; }
          writeInto(b, d.state[k], b.sig.value);
        }
      },
      { message: JSON.stringify({ label: label ?? (keys.length === 1 ? bindings.get(keys[0]).label : `edit ${keys.join(', ')}`), origin }) },
    );
  } catch (err) {
    // The edits stay in the signals; marking them dirty again retries them with the next edit.
    stats.errors++;
    stats.lastError = { at: Date.now(), keys, message: String(err?.message ?? err).slice(0, 200) };
    console.error(`shared: writing ${keys.join(', ')} to the document failed`, err);
    for (const k of keys) dirty.add(k);
    return null;
  } finally {
    flushing = false;
  }
  for (const k of keys) checkDrift(bindings.get(k));
  const after = h.heads();
  if (same(before, after)) return null;
  stats.writes++;
  stats.lastWrite = { at: Date.now(), key: keys.join(',') };
  return history.record({ label: label ?? keys.map((k) => bindings.get(k).label).join(', '), origin, keys, before, after, coalesce: !label });
}

/** Writes value v (signal form) into the doc's state[key] object `s`, as a diff against b.seen. */
/** The key's container in the document, replaced if a peer left something malformed there. */
function container(b, s) {
  if (b.kind === 'map') return isObj(s) ? s : (s !== undefined && invalid(b, '(all)', 'replacing malformed map'), {});
  if (isObj(s) && isObj(s.items) && Array.isArray(s.order)) return s;
  if (s !== undefined) invalid(b, '(all)', 'replacing malformed list');
  return { items: isObj(s?.items) ? plain(s.items) : {}, order: Array.isArray(s?.order) ? plain(s.order) : [] };
}

function writeInto(b, s, v) {
  if (b.kind === 'map') {
    const enc = {};
    for (const k in v ?? {}) if (v[k] !== undefined) enc[k] = plain(b.encode(v[k]));
    const prev = b.seen ?? {};
    for (const k in enc) if (!same(enc[k], s[k]) && !same(enc[k], prev[k])) s[k] = toDoc(enc[k]);
    for (const k in prev) if (!(k in enc) && k in s) delete s[k];
    b.seen = plain(s);
    return;
  }
  const all = (v ?? []).filter((e) => e && e.id != null);
  const list = all.filter((e) => !b.keepLocal(e));
  // Not written and never deleted here: local-only entities, and shared ones still loading.
  const held = new Set([...all.filter((e) => b.keepLocal(e)).map((e) => String(e.id)), ...(b.loading ?? [])]);
  const prevSeen = b.seen ?? new Map();
  const seen = new Map();
  s.items ??= {};
  for (const e of list) {
    const id = String(e.id);
    const enc = clean(plain(clean(b.encode(e))));
    for (const f of b.local) delete enc[f];
    const prev = prevSeen.get(id);
    const cur = s.items[id];
    if (!cur) s.items[id] = toDoc(enc);
    else {
      for (const f in enc) if (!same(enc[f], prev?.[f]) && !same(enc[f], cur[f])) cur[f] = toDoc(enc[f]);
      // Only fields this page had and dropped are deleted; unknown ones are left alone.
      if (prev) for (const f in prev) if (!(f in enc) && f in cur) delete cur[f];
    }
    seen.set(id, plain(s.items[id]));
  }
  for (const id of prevSeen.keys()) if (!seen.has(id) && !held.has(id) && s.items[id]) delete s.items[id];
  // Held entities the document has keep their place in it.
  const order = [...new Set(all.filter((e) => !b.keepLocal(e) || s.items[String(e.id)]).map((e) => String(e.id)))]; // two peers can add the same id
  // Ids a peer added that this page hasn't seen yet keep their place after ours.
  const unseen = [...(s.order ?? [])].filter((id) => !order.includes(id) && s.items[id] && ((!prevSeen.has(id) && !held.has(id)) || b.loading?.has(id)));
  if (!same([...(s.order ?? [])], [...order, ...unseen])) s.order = [...order, ...unseen];
  // Entities a peer added that this page hasn't seen yet stay (they're in items, appended on read).
  b.seen = new Map(readDoc(b, { state: { [b.key]: s } }).map((e) => [String(e.id), e]));
}

/**
 * Runs fn (which changes shared signals) as one named action: one document change, one history
 * entry. Returns fn's result. Nested calls join the outer action.
 */
let depth = 0;
export function act(label, fn, { origin = 'local' } = {}) {
  if (depth === 0) flush();
  depth++;
  let out;
  try {
    out = fn();
  } finally {
    depth--;
  }
  if (depth === 0) {
    // Subscriptions fire synchronously, so dirty holds everything fn changed.
    flush(label, origin);
  }
  return out;
}

export const sharedKeys = () => [...bindings.keys()];
/** True while this page writes its own edits to the document (a change event then isn't remote). */
export const writing = () => flushing;
/** Debugging: a binding's internals. */
export const binding = (key) => bindings.get(key);

export function dispose() {
  flush();
  for (const b of [...bindings.values()]) b.unbind();
}
