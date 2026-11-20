// Which session's code a chat works in. Chats belong to the page and outlive sessions, but each
// session has its own code (vfs layers: base + what was committed while it was open). When the
// open session changes between a chat's turns (or during one), the agent gets a note saying what
// changed underneath it, so it doesn't mistake the other code for breakage and "fix" it back.
import { vfs } from '@live/runtime';
import { current } from '../net/session.js';
import { overlayIdOf } from './store.js';

/** The open session: { doc, name } (doc null when none is open). */
export function whereNow() {
  return { doc: vfs.layerId ?? null, name: current.peek()?.name ?? 'unnamed session' };
}

/** The session the chat last worked in (from the newest message that records one), or null. */
export function lastWhere(s) {
  const ms = s.messages.peek();
  for (let i = ms.length - 1; i >= 0; i--) if (ms[i].session) return ms[i].session;
  return null;
}

const list = (paths, max = 12) => (paths.length > max ? `${paths.slice(0, max).join(', ')} and ${paths.length - max} more` : paths.join(', '));

/** A note for the agent when the session changed since `prev`, else null. */
export async function sessionChangeNote(s, prev, now = whereNow()) {
  if (!prev || prev.doc === now.doc) return null;
  const ovId = overlayIdOf(s);
  const own = vfs.layerStatus();
  const before = await vfs.readLayer(prev.doc).catch(() => null);
  // What your commits there left each file as, compared with what runs here.
  const last = new Map();
  for (const e of before?.history ?? []) if (e.overlayId === ovId) for (const f of e.files) last.set(f.path, f.after ?? null);
  const missing = [...last].filter(([p, after]) => (vfs.readCommitted(p) ?? null) !== after).map(([p]) => p);
  const stale = vfs.overlay(ovId)?.status().filter((f) => f.stale).map((f) => f.path) ?? [];
  return [
    `The open session changed since you last worked: now "${now.name}", before "${prev.name}". Each session has its own code (the base, plus what was committed while that session was open), so the code you see now is not the code you worked on, and that is expected, not breakage.`,
    own.length ? `This session's own files: ${list(own.map((f) => `${f.path} (${f.kind})`))}. session_code shows how they differ from the base.` : 'This session has no code of its own: it runs the base.',
    missing.length ? `What you committed in "${prev.name}" to ${list(missing)} is not in this session's code. Don't redo it here unless the user asks for that.` : null,
    stale.length ? `Your unapplied edits to ${list(stale)} were made on the other code; they will be merged onto this code when applied. Re-read those files first.` : null,
    `revert_applied and the recent transactions in list_modules now refer to this session's history.`,
  ]
    .filter(Boolean)
    .join('\n');
}
