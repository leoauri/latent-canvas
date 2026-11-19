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
// - `keepLocal(entity)`: entities not (yet) shared, e.g. a clip still recording: neither written
//   nor removed by remote changes.
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
const toDoc = (v) => {
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
    pending: 0, // decode generation
    // value to adopt when this machine's first session is created (e.g. migrated from kv)
    seedFrom: opts.seedFrom ?? (() => sig.value),
  };
  bindings.get(key)?.unbind();
  bindings.set(key, b);
  const offSig = sig.subscribe((v) => {
    if (b.local.size && b.attachedTo && b.localsLoaded && Array.isArray(v)) saveLocals(b, v);
    if (applying || !b.attachedTo) return;
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
      if (d.state[b.key] === undefined) d.state[b.key] = b.kind === 'list' ? { items: {}, order: [] } : {};
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

function readDoc(b, d) {
  const s = d?.state?.[b.key];
  if (!s) return b.kind === 'list' ? [] : {};
  if (b.kind === 'map') return plain(s);
  const items = s.items ?? {};
  const ids = [];
  const seenIds = new Set();
  for (const id of s.order ?? []) if (items[id] && !seenIds.has(id)) (ids.push(id), seenIds.add(id));
  for (const id of Object.keys(items).sort()) if (!seenIds.has(id)) ids.push(id); // concurrently added
  return ids.map((id) => plain(items[id]));
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
  if (b.seen && b.seen.size === seen.size && same([...b.seen.values()], enc)) return;
  const prevList = b.sig.value ?? [];
  const prevById = new Map(prevList.map((e) => [e.id, e]));
  const prevSeen = b.seen;
  b.seen = seen;
  const out = [];
  for (const e of enc) {
    const prev = prevById.get(e.id);
    // Unchanged entity: keep the local object as is (identity matters to caches and memos).
    if (prev && prevSeen && same(prevSeen.get(e.id), e)) {
      out.push(prev);
      continue;
    }
    const local = { ...b.locals?.get(String(e.id)) };
    if (prev) for (const f of b.local) if (prev[f] !== undefined) local[f] = prev[f];
    const json = JSON.stringify(e);
    const cached = b.decoded.get(e.id);
    let v = cached?.json === json ? cached.value : b.decode(e, prev);
    if (v?.then) {
      // Not available yet (e.g. a blob still downloading): leave it out, re-read once it is.
      v.then((value) => {
        b.decoded.set(e.id, { json, value });
        if (value) refresh(b);
      }, (err) => console.warn(`shared: decoding ${b.key} ${e.id} failed`, err));
      if (prev) {
        // Keep showing the old version meanwhile; `seen` records it, so local edits of it diff right.
        out.push(prev);
        seen.set(e.id, clean(plain(clean(b.encode(prev)))));
      }
      continue;
    }
    if (v) out.push({ ...v, ...local });
  }
  // Entities that exist only here (keepLocal) stay, after the shared ones.
  for (const e of prevList) if (b.keepLocal(e) && !seen.has(e.id)) out.push(e);
  setSignal(b, out);
}

/** Re-reads a binding from its document (after an async decode finished). */
function refresh(b) {
  if (!b.attachedTo) return;
  b.seen = null;
  fromDoc(b, b.attachedTo.doc());
}

function setSignal(b, v) {
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
  const keys = [...dirty].filter((k) => bindings.get(k)?.attachedTo);
  dirty.clear();
  if (!keys.length) return null;
  const h = bindings.get(keys[0]).attachedTo;
  const before = h.heads();
  flushing = true;
  try {
    h.change(
      (d) => {
        d.state ??= {};
        for (const k of keys) {
          const b = bindings.get(k);
          if (b.attachedTo !== h) continue;
          d.state[k] ??= b.kind === 'list' ? { items: {}, order: [] } : {};
          writeInto(b, d.state[k], b.sig.value);
        }
      },
      { message: JSON.stringify({ label: label ?? (keys.length === 1 ? bindings.get(keys[0]).label : `edit ${keys.join(', ')}`), origin }) },
    );
  } finally {
    flushing = false;
  }
  const after = h.heads();
  if (same(before, after)) return null;
  return history.record({ label: label ?? keys.map((k) => bindings.get(k).label).join(', '), origin, keys, before, after, coalesce: !label });
}

/** Writes value v (signal form) into the doc's state[key] object `s`, as a diff against b.seen. */
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
  const held = new Set(all.filter((e) => b.keepLocal(e)).map((e) => String(e.id)));
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
  const order = [...new Set(list.map((e) => String(e.id)))]; // two peers can add the same id
  // Ids a peer added that this page hasn't seen yet keep their place after ours.
  const unseen = [...(s.order ?? [])].filter((id) => !order.includes(id) && s.items[id] && !prevSeen.has(id) && !held.has(id));
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
/** Debugging: a binding's internals. */
export const binding = (key) => bindings.get(key);

export function dispose() {
  flush();
  for (const b of [...bindings.values()]) b.unbind();
}
