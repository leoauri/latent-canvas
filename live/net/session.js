// Sessions: each is one Automerge document (docs.js) with its own room. This page keeps a local
// list of the sessions it knows, has one open, and owns the URL fragment: it shows the open
// session's join link (link.js), so a reload reopens it and copying the URL invites someone.
// Opening a join link (pasted, or arriving in the URL) adds that session and opens it.
import { signal, computed } from '@preact/signals';
import { persist, vfs, env } from '@live/runtime';
import * as db from '../lib/db.js';
import * as room from './room.js';
import { repo, offered, offeredChanged } from './docs.js';
import { parseLink, fragment, makeLink, newRoomSecret } from './link.js';

/**
 * @typedef {{ doc: string, room: string, signal: string, name: string, created: number, lastOpened: number }} Session
 */

/** @type {import('@preact/signals').Signal<Session[]>} known sessions, most recently opened first */
export const sessions = persist('net.sessions', []);
/** Document URL of the open session. */
export const currentDoc = persist('net.currentDoc', null);
/** DocHandle of the open session, once loaded (null while loading or unavailable). */
export const handle = signal(null);
/** 'idle' | 'loading' | 'waiting' (not found locally, asking peers) | 'ready' | 'error' */
export const status = signal('idle');
export const error = signal(null);
/** Bumped on every change of the open document. */
export const version = signal(0);

export const current = computed(() => sessions.value.find((s) => s.doc === currentDoc.value) ?? null);
export const shareLink = computed(() => (current.value ? makeLink(current.value, env.publicURL || undefined) : null));

const unbind = [db.sync(sessions, 'net.sessions'), db.sync(currentDoc, 'net.currentDoc')];
let disposed = false;
let offChange = null;
let opening = 0;

function upsert(s) {
  const rest = sessions.value.filter((x) => x.doc !== s.doc);
  const old = sessions.value.find((x) => x.doc === s.doc);
  sessions.value = [{ ...old, ...s }, ...rest];
}

/** Creates a session (a new document and room) and opens it. `seed` marks the doc to adopt local state. */
export async function create({ name = 'Untitled session', signal: signalURL = room.defaultSignalURL(), seed = false } = {}) {
  // Containers exist from the start: maps two peers create concurrently don't merge (one wins, the
  // other's contents are lost), so nobody may have to create them later.
  const h = repo.create({ meta: { name, created: Date.now(), seed }, state: {}, code: { changes: {}, incorporated: {} } });
  const s = { doc: h.url, room: newRoomSecret(), signal: signalURL, name, created: Date.now(), lastOpened: Date.now() };
  upsert(s);
  await open(s.doc);
  return s;
}

/** Joins the session a link names (adding it to the list) and opens it. Returns false for a bad link. */
export async function join(text) {
  const link = parseLink(text);
  if (!link) return false;
  const known = sessions.value.find((s) => s.doc === link.doc);
  upsert({ name: 'Joined session', created: Date.now(), ...known, ...link, lastOpened: Date.now() });
  await open(link.doc);
  return true;
}

/** Opens a known session: joins its room and loads its document (from storage, or from peers). */
export async function open(docUrl) {
  const s = sessions.value.find((x) => x.doc === docUrl);
  if (!s) throw new Error(`unknown session ${docUrl}`);
  const n = ++opening;
  offChange?.();
  offChange = null;
  handle.value = null;
  error.value = null;
  status.value = 'loading';
  currentDoc.value = docUrl;
  upsert({ ...s, lastOpened: Date.now() });
  writeHash(s);
  offered.clear();
  offered.add(docUrl.replace(/^automerge:/, ''));
  offeredChanged();
  room.join({ room: s.room, signal: s.signal });
  try {
    let h = await repo.find(docUrl, { allowableStates: ['ready', 'unavailable'] });
    if (n !== opening || disposed) return;
    if (!h.isReady()) {
      status.value = 'waiting';
      await h.whenReady(['ready']);
      if (n !== opening || disposed) return;
    }
    const onChange = () => {
      version.value++;
      const name = h.doc()?.meta?.name;
      if (name && name !== current.value?.name) upsert({ ...current.value, name });
    };
    h.on('change', onChange);
    offChange = () => h.off('change', onChange);
    // Older documents: add the containers in a change of their own, before anything goes into them.
    const d0 = h.doc();
    if (!d0?.state || !d0?.code?.changes || !d0?.code?.incorporated)
      h.change((d) => {
        d.state ??= {};
        d.code ??= {};
        d.code.changes ??= {};
        d.code.incorporated ??= {};
      });
    handle.value = h;
    status.value = 'ready';
    onChange();
  } catch (e) {
    if (n !== opening) return;
    status.value = 'error';
    error.value = String(e.message || e);
  }
}

/** Renames the open session (in the document, so peers see it too). */
export function rename(name) {
  name = String(name ?? '').trim();
  if (!name) throw new Error('a session needs a name');
  handle.value?.change((d) => {
    d.meta.name = name;
  });
}

/** Forgets a session locally (the document stays in storage; peers keep theirs). */
export function forget(docUrl) {
  sessions.value = sessions.value.filter((s) => s.doc !== docUrl);
  if (currentDoc.value === docUrl) {
    const next = sessions.value[0];
    if (next) open(next.doc);
    else create({ name: 'Untitled session' });
  }
}

/** Moves the open session to another signaling server (everyone needs the new link). */
export function setSignal(signalURL) {
  if (!current.value) return;
  upsert({ ...current.value, signal: signalURL });
  open(current.value.doc);
}

// While code runs on trial (vfs overlays), the document is forked: bindings write to a local
// clone, merged back when the trial is kept and dropped when it's discarded, so trial code never
// writes into everyone's session.
/** { original, fork, overlayId } while a trial runs */
export const trialFork = signal(null);
/** { outcome: 'keep'|'discard', since } of the last trial, so history can drop what the discarded fork recorded. */
export const trialEnded = signal(null);
const offTrial = vfs.onTrial(async ({ phase, overlayId }) => {
  if (phase === 'start') {
    const h = handle.value;
    if (!h || trialFork.value) return;
    const fork = repo.clone(h);
    trialFork.value = { original: h, fork, overlayId, since: Date.now() };
    handle.value = fork;
    return;
  }
  const t = trialFork.value;
  if (!t) return;
  trialFork.value = null;
  if (phase === 'keep') t.original.merge(t.fork);
  if (handle.value === t.fork) handle.value = t.original;
  trialEnded.value = { outcome: phase, since: t.since };
  t.fork.delete?.();
});

function writeHash(s) {
  const frag = '#' + fragment(s);
  if (location.hash !== frag) history.replaceState(history.state, '', frag);
}

function onHashChange() {
  const link = parseLink(location.hash);
  if (link && link.doc !== currentDoc.value) join(location.hash);
}
window.addEventListener('hashchange', onHashChange);

// Start: a link in the URL wins, then the last open session, else a new one adopting local state.
// (Reads kv directly rather than waiting on db.sync's hydration; on a module reload the persisted
// signals already hold the values.)
(async () => {
  if (!sessions.value.length) {
    const [list, cur] = await Promise.all([db.get('kv', 'net.sessions'), db.get('kv', 'net.currentDoc')]).catch(() => []);
    if (Array.isArray(list) && !sessions.value.length) sessions.value = list;
    if (cur && !currentDoc.value) currentDoc.value = cur;
  }
  if (disposed) return;
  if (parseLink(location.hash)) return join(location.hash);
  const last = sessions.value.find((s) => s.doc === currentDoc.value) ?? sessions.value[0];
  if (last) return open(last.doc);
  return create({ name: 'My session', seed: true });
})();

export function dispose() {
  disposed = true;
  offChange?.();
  offTrial();
  window.removeEventListener('hashchange', onHashChange);
  unbind.forEach((f) => f());
}
