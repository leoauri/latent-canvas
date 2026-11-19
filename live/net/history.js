// Peer-local action history over the open session's document. Every change this page makes to
// shared state is an entry { id, label, origin, keys, before, after (document heads), at };
// shared.js records them (act(label, fn) names one; unnamed edits of the same keys coalesce).
// Since Automerge keeps every past state, any entry's heads can be viewed again, so the history
// can recover:
//   undo(id)              revert what that action changed, where nobody has changed it since
//   restore(at, { key, id })  set one entity, one key, or all shared state back to how it was at
//                         an entry (at: entry id, 'before:<id>' or raw heads)
// Both write forward (a new change everyone receives); nothing is rewound. Entries persist
// per document in IndexedDB (only this page's, at most MAX).
import { signal } from '@preact/signals';
import { persist } from '@live/runtime';
import * as db from '../lib/db.js';
import { handle, currentDoc, trialEnded } from './session.js';

const MAX = 300;
const COALESCE_MS = 1500;

/** @typedef {{ id: string, label: string, origin: string, keys: string[], before: string[], after: string[], at: number }} Entry */

/** Entries of the open session, oldest first. */
export const entries = persist('net.history', []);
const loadedFor = signal(null);

const kvKey = (doc) => `history:${doc}`;
let saveTimer = 0;
function save() {
  const doc = loadedFor.value;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => doc && db.put('kv', kvKey(doc), entries.value).catch(() => {}), 300);
}

const offDoc = currentDoc.subscribe(async (doc) => {
  if (doc === loadedFor.value) return;
  loadedFor.value = null;
  entries.value = [];
  if (!doc) return;
  const stored = await db.get('kv', kvKey(doc)).catch(() => null);
  if (currentDoc.value !== doc) return;
  entries.value = Array.isArray(stored) ? stored : [];
  loadedFor.value = doc;
});

// A discarded trial's fork is gone, and so are the states its entries point at.
const offTrial = trialEnded.subscribe((t) => {
  if (t?.outcome !== 'discard') return;
  const kept = entries.value.filter((e) => e.at < t.since);
  if (kept.length !== entries.value.length) (entries.value = kept), save();
});

/** Called by shared.js after each change it writes. */
export function record({ label, origin, keys, before, after, coalesce, undoes }) {
  const list = entries.value;
  const last = list.at(-1);
  if (coalesce && last?.coalesce && Date.now() - last.at < COALESCE_MS && same(last.keys, keys) && same(last.after, before)) {
    const merged = { ...last, after, at: Date.now() };
    entries.value = [...list.slice(0, -1), merged];
    save();
    return merged;
  }
  const e = { id: Math.random().toString(36).slice(2, 10), label, origin, keys, before, after, at: Date.now(), coalesce: !!coalesce, ...(undoes ? { undoes } : {}) };
  entries.value = [...list, e].slice(-MAX);
  save();
  return e;
}

const noBig = (_k, x) => (typeof x === 'bigint' ? Number(x) : x); // see shared.js
const same = (a, b) => JSON.stringify(a, noBig) === JSON.stringify(b, noBig);
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v, noBig)));
const find = (id) => entries.value.find((e) => e.id === id);

function headsOf(at) {
  if (Array.isArray(at)) {
    // Empty heads are the empty document: restoring to it would wipe the session.
    if (!at.length || !at.every((h) => typeof h === 'string')) throw new Error('restore: heads must be a non-empty list of change hashes');
    return at;
  }
  const [which, id] = String(at).includes(':') ? String(at).split(':') : ['after', at];
  const e = find(id);
  if (!e) throw new Error(`no history entry ${id}`);
  return which === 'before' ? e.before : e.after;
}

function stateAt(heads) {
  const h = handle.value;
  if (!h) throw new Error('no open session');
  return plain(h.view(heads).doc()?.state) ?? {};
}

/** Leaf paths where two state trees differ: [key, k] for maps, [key,'items',id(,field)] / [key,'order'] for lists. */
function changedPaths(a, b, keys) {
  const out = [];
  for (const key of keys ?? union(a, b)) {
    const x = a?.[key], y = b?.[key];
    if (same(x, y)) continue;
    const isList = (v) => v && typeof v === 'object' && 'items' in v && 'order' in v;
    if (isList(x) || isList(y)) {
      if (!same(x?.order, y?.order)) out.push([key, 'order']);
      for (const id of union(x?.items, y?.items)) {
        const ex = x?.items?.[id], ey = y?.items?.[id];
        if (same(ex, ey)) continue;
        if (!ex || !ey) out.push([key, 'items', id]);
        else for (const f of union(ex, ey)) if (!same(ex[f], ey[f])) out.push([key, 'items', id, f]);
      }
    } else if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x)) {
      for (const k of union(x, y)) if (!same(x[k], y[k])) out.push([key, k]);
    } else out.push([key]);
  }
  return out;
}
const union = (a, b) => [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])];
const get = (o, p) => p.reduce((v, k) => v?.[k], o);

function writePaths(paths, values, label, origin, undoes) {
  const h = handle.value;
  if (!h || !paths.length) return null;
  const before = h.heads();
  h.change(
    (d) => {
      d.state ??= {};
      paths.forEach((p, i) => {
        const v = values[i];
        let o = d.state;
        for (const [j, k] of p.slice(0, -1).entries()) {
          if (o[k] === undefined) {
            if (v === undefined) return;
            // A field of an entity someone removed meanwhile: don't bring back a partial entity.
            if (j === 2 && p[1] === 'items') return;
            o[k] = {};
          }
          o = o[k];
        }
        const last = p.at(-1);
        if (v === undefined) delete o[last];
        else if (!same(o[last], v)) o[last] = v;
      });
    },
    { message: JSON.stringify({ label, origin }) },
  );
  const after = h.heads();
  return same(before, after) ? null : record({ label, origin, keys: [...new Set(paths.map((p) => p[0]))], before, after, undoes });
}

/** Entries, newest first: { id, label, origin, keys, at }. */
export function list({ limit = 50 } = {}) {
  return entries.value.slice(-limit).reverse().map(({ id, label, origin, keys, at }) => ({ id, label, origin, keys, at }));
}

/** What an entry changed: [{ path, before, after, now }] (now: the current value). */
export function diff(id) {
  const e = find(id);
  if (!e) throw new Error(`no history entry ${id}`);
  const a = stateAt(e.before), b = stateAt(e.after), now = plain(handle.value.doc()?.state) ?? {};
  return changedPaths(a, b, e.keys).map((path) => ({ path, before: get(a, path), after: get(b, path), now: get(now, path) }));
}

/**
 * Reverts entry `id`'s changes where the value is still what it wrote (others' later edits win).
 * Returns { entry, skipped: paths changed since }.
 */
export function undo(id) {
  const e = find(id);
  if (!e) throw new Error(`no history entry ${id}`);
  const changes = diff(id);
  const apply = changes.filter((c) => same(c.now, c.after));
  const skipped = changes.filter((c) => !same(c.now, c.after)).map((c) => c.path);
  const entry = writePaths(apply.map((c) => c.path), apply.map((c) => c.before), `undo ${e.label}`, 'undo', e.id);
  return { entry, skipped };
}

/**
 * Undoes this page's most recent action that isn't an undo of something later. Actions whose
 * changes were all overwritten since (by peers or later edits) are skipped: there's nothing left of
 * them to undo. → { entry, skipped, passed: [labels of the actions skipped that way] } or null.
 */
export function undoLast() {
  const undone = new Set();
  const passed = [];
  for (const e of [...entries.value].reverse()) {
    if (e.origin === 'undo') {
      if (e.undoes) undone.add(e.undoes);
      continue;
    }
    if (undone.has(e.id) || e.origin === 'seed' || e.origin === 'restore') continue;
    const r = undo(e.id);
    if (r.entry) return { ...r, passed };
    passed.push(e.label);
  }
  return passed.length ? { entry: null, skipped: [], passed } : null;
}

/**
 * Sets shared state back to how it was at `at` (entry id = after it, 'before:<id>', or heads):
 * all of it, one key, or one entity of a list key ({ key, id }).
 */
export function restore(at, { key, id } = {}) {
  const heads = headsOf(at);
  const then = stateAt(heads);
  const now = plain(handle.value.doc()?.state) ?? {};
  let paths = changedPaths(now, then, key ? [key] : undefined);
  if (id != null) paths = paths.filter((p) => p[1] === 'items' && p[2] === String(id));
  const label = `restore ${key ?? 'everything'}${id != null ? ` ${id}` : ''} to ${typeof at === 'string' ? at : 'earlier'}`;
  return writePaths(paths, paths.map((p) => get(then, p)), label, 'restore');
}

export function dispose() {
  offDoc();
  offTrial();
  clearTimeout(saveTimer);
  if (loadedFor.value) db.put('kv', kvKey(loadedFor.value), entries.value).catch(() => {});
}
