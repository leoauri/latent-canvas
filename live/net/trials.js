// Trial queue. The VFS runs one trial (preview) at a time; asking for another while one runs puts it
// in line here instead of failing, and it starts when the running one ends (kept or discarded).
// Every way of starting a preview goes through requestTrial: a peer's change (Changes window), a
// chat's Try button, and the agent's try_changes.
//
//   const r = await requestTrial('peer:abc', () => vfs.startTrial('peer:abc'), { label: '“Reverb” by Ann', kind: 'peer' });
//   // r: the start result, or { ok: true, queued: true, position } when it had to wait.
//   //    With { wait: true } the promise instead settles once the trial actually started (or failed).
//
// The queue lives in persist() so it survives module swaps (a trial swaps modules).
import { signal, effect } from '@preact/signals';
import { vfs, vfsVersion, persist } from '@live/runtime';

/** [{ id, overlayId, label, kind: 'agent'|'peer'|'other', at }] waiting, first starts next (a signal). */
export const queue = persist('trials.queue', () => signal([])).value;
// The non-serializable halves of queue entries: id -> { start, resolve, signal }.
const jobs = persist('trials.jobs', () => new Map()).value;
/** The last queued start that failed: { label, message } or null (shown by the preview frame). */
export const lastFailure = persist('trials.lastFailure', () => signal(null)).value;

let seq = 0;
const newId = () => `q${Date.now().toString(36)}${(seq++).toString(36)}`;

/**
 * Starts a trial now, or queues it if another overlay is on trial. start() must call vfs.startTrial
 * (or overlay.trial()). opts: { label, kind, wait, signal (AbortSignal: drop it from the queue) }.
 */
export function requestTrial(overlayId, start, { label = overlayId, kind = 'other', wait = false, signal: abort } = {}) {
  const t = vfs.trial;
  if (t?.overlayId === overlayId) return Promise.resolve({ ok: false, phase: 'trial', message: `overlay "${overlayId}" is already on trial` });
  if (!t && !queue.peek().length) return start();
  const existing = queue.peek().find((q) => q.overlayId === overlayId);
  const id = existing?.id ?? newId();
  return new Promise((resolve) => {
    const prev = jobs.get(id);
    const resolvers = [...(prev?.resolvers ?? []), ...(wait ? [resolve] : [])];
    jobs.set(id, { start, resolvers, abort });
    if (!existing) queue.value = [...queue.peek(), { id, overlayId, label, kind, at: Date.now() }];
    abort?.addEventListener('abort', () => cancel(id, 'cancelled'), { once: true });
    if (!wait) resolve({ ok: true, queued: true, position: queue.peek().findIndex((q) => q.id === id) + 1, behind: t?.overlayId ?? null });
    pump();
  });
}

/** Drops a queued trial (by queue id or overlay id). */
export function cancel(idOrOverlay, why = 'removed from the queue') {
  const q = queue.peek().find((x) => x.id === idOrOverlay || x.overlayId === idOrOverlay);
  if (!q) return false;
  queue.value = queue.peek().filter((x) => x !== q);
  const job = jobs.get(q.id);
  jobs.delete(q.id);
  job?.resolvers.forEach((r) => r({ ok: false, phase: 'queue', message: `not started: ${why}` }));
  return true;
}

/** Moves a queued trial to the front. */
export function promote(id) {
  const list = queue.peek();
  const q = list.find((x) => x.id === id);
  if (q) queue.value = [q, ...list.filter((x) => x !== q)];
}

let starting = false;
function pump() {
  if (starting || vfs.trial || !queue.peek().length) return;
  starting = true;
  // After the current turn: the trial that just ended may still be finishing its swap.
  setTimeout(async () => {
    try {
      if (vfs.trial) return;
      const [q, ...rest] = queue.peek();
      if (!q) return;
      queue.value = rest;
      const job = jobs.get(q.id);
      jobs.delete(q.id);
      if (!job) return;
      let r;
      try {
        r = await job.start();
      } catch (e) {
        r = { ok: false, message: String(e?.message || e) };
      }
      if (!r?.ok) lastFailure.value = { label: q.label, message: r?.message || r?.errors?.map((e) => `${e.path}: ${e.message}`).join('; ') || 'failed' };
      job.resolvers.forEach((res) => res(r));
    } finally {
      starting = false;
      if (!vfs.trial && queue.peek().length) pump();
    }
  }, 0);
}

// Start the next one whenever no trial runs (vfsVersion is bumped when a trial ends).
const off = effect(() => {
  vfsVersion.value;
  queue.value;
  pump();
});

export function dispose() {
  off();
}
