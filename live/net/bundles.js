// Your bundles: the named groups of changes your chats' agents built and you approved, remembered
// on this machine with whether you currently publish them. The published copy lives in the session
// document (code.changes, see changes.js), like tracks and masks: every peer holds it and gets it
// on joining, for as long as the session exists. Unpublishing deletes it from there (peers who
// applied it keep their code); publishing again restores the same change under the same id.
//
//   bundle = { id (the change id), room (session doc url), sessionId (chat), name, intent?,
//              follows?, guide?, entries: [vfs history ids], change (as published, with sources),
//              state: 'published'|'unpublished', at, changedAt }
import { persist } from '@live/runtime';
import * as db from '../lib/db.js';
import * as changes from './changes.js';
import * as session from './session.js';

/** All bundles, newest first (a signal; mirrored to IndexedDB). */
export const bundles = persist('net.bundles', []);
const unbind = db.sync(bundles, 'net.bundles');

const put = (b) => (bundles.value = [b, ...bundles.peek().filter((x) => x.id !== b.id)]);
const patch = (id, p) => (bundles.value = bundles.peek().map((b) => (b.id === id ? { ...b, ...p, changedAt: Date.now() } : b)));

/** Remembers a change just published from a chat. */
export function record(change, { sessionId, entries, guide } = {}) {
  const now = Date.now();
  put({
    id: change.id,
    room: session.currentDoc.peek(),
    sessionId,
    name: change.name,
    ...(change.intent ? { intent: change.intent } : {}),
    ...(change.follows ? { follows: change.follows } : {}),
    ...(guide ? { guide } : {}),
    entries,
    change,
    state: 'published',
    at: now,
    changedAt: now,
  });
}

export const byId = (id) => bundles.value.find((b) => b.id === id);
export const ofSession = (sessionId) => bundles.value.filter((b) => b.sessionId === sessionId);
/** Whether the bundle's session document is the one open (only then can it be (un)published). */
export const inOpenRoom = (b) => !!session.handle.value && b.room === session.currentDoc.value;

/** Drops your bundles from a session (when it is forgotten with its code). */
export function forgetRoom(doc) {
  bundles.value = bundles.peek().filter((b) => b.room !== doc);
}

export function unpublish(id) {
  const b = byId(id);
  if (!b) return { ok: false, message: `no bundle ${id}` };
  if (!inOpenRoom(b)) return { ok: false, message: 'Open the session it was published to first.' };
  changes.unpublish(id);
  patch(id, { state: 'unpublished' });
  return { ok: true };
}

export function republish(id) {
  const b = byId(id);
  if (!b) return { ok: false, message: `no bundle ${id}` };
  if (!inOpenRoom(b)) return { ok: false, message: 'Open the session it was published to first.' };
  changes.republish(b.change);
  patch(id, { state: 'published' });
  return { ok: true };
}

export function dispose() {
  unbind();
}
