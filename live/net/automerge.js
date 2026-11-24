// Auto-merge: with it on, each change a peer publishes is handed to a background agent (a chat
// in scope "automerge", working in the change's overlay 'peer:<id>') that reviews it for anything
// malicious, adapts it to this page's code if needed, and applies it. Its apply_changes waits until
// the user pauses (no input for IDLE_MS, not playing or recording, no trial), so an edit or a take isn't
// interrupted. One change at a time, oldest first in causal order. A change the agent holds back
// (or fails on) stays in the Changes window for the user, with the agent's reason.
//
// Jobs, by change id: { state, sessionId?, note?, at, tries?, retryAt?, pulled? }
//   state: 'reviewing' (agent working) | 'waiting' (ready to apply, waiting for a pause) | 'merged'
//          | 'held' (the agent didn't apply it: note says why) | 'failed' (error: note)
// Kept in localStorage, so held changes aren't reviewed again on every boot; an unfinished job
// (the page reloaded under it) is started again.
//
// A failed job (missing API key, network, rate limit, …) is tried again after RETRY_MS[tries - 1],
// up to MAX_TRIES times. Failed jobs start over (tries 0, due now) when the page loads, when the LLM
// settings change, and when another change merges (the LLM works again). A change that builds on a
// failed one tries that one again first (pulled forward once, then it waits for its retries); one
// that builds on a held-back change is held back too, so the held code doesn't come in with it.
//
// Redundant changes (the base already has them, redundant.js) are never merged: a change waits for
// its verdict, and the verdicts of what is staged with it, asking redundant.js to check them first.
import { effect, computed, signal } from '@preact/signals';
import { vfs, persist } from '@live/runtime';
import * as changes from './changes.js';
import * as session from './session.js';
import * as redundant from './redundant.js';
import { registerExtension } from '../chat/extensions.js';

export const SCOPE = 'automerge';
const IDLE_MS = 4000;
const ON_KEY = 'redaw.net.autoMerge';
const JOBS_KEY = 'redaw.net.autoMerge.jobs';
const DONE = new Set(['merged', 'held', 'failed']);
const RETRY_MS = [15e3, 60e3, 5 * 60e3, 15 * 60e3, 30 * 60e3];
const MAX_TRIES = 6;

const load = (k, d) => {
  try {
    return JSON.parse(localStorage.getItem(k)) ?? d;
  } catch {
    return d;
  }
};

/** Whether peers' changes are merged automatically. */
export const autoMergeOn = persist('net.autoMerge.on', () => load(ON_KEY, false));
/** Change id -> job (see above). Unfinished jobs from an earlier page load are dropped (retried). */
// Failed ones start over: whatever failed them (a missing key, the network) may be fixed by now.
export const jobs = persist('net.autoMerge.jobs', () =>
  Object.fromEntries(
    Object.entries(load(JOBS_KEY, {}))
      .filter(([, j]) => DONE.has(j?.state))
      .map(([id, j]) => [id, j.state === 'failed' ? { ...j, tries: 0, retryAt: 0, pulled: false } : j]),
  ),
);
/** The change being worked on now (one at a time), or null. */
const active = persist('net.autoMerge.active', null);
/** What auto-merge did, newest last: { id, name, author, state, note } (for the arrival bubble). */
export const outcomes = persist('net.autoMerge.outcomes', () => []);

const offSave = [
  autoMergeOn.subscribe((v) => localStorage.setItem(ON_KEY, JSON.stringify(v))),
  jobs.subscribe((j) => localStorage.setItem(JOBS_KEY, JSON.stringify(Object.fromEntries(Object.entries(j).filter(([, x]) => DONE.has(x.state)).slice(-300))))),
];

const setJob = (id, patch) => (jobs.value = { ...jobs.peek(), [id]: { ...jobs.peek()[id], ...patch, at: Date.now() } });
export const jobOf = (id) => jobs.value[id] ?? null;

const canRetry = (j) => j?.state === 'failed' && (j.tries ?? 0) < MAX_TRIES;
const isDue = (j) => canRetry(j) && (j.retryAt ?? 0) <= Date.now();
const nameOf = (id) => changes.published.peek().find((c) => c.id === id)?.name ?? id;

/** Lets every failed change be tried again now (something that may have failed them changed). */
function retryFailed() {
  const all = jobs.peek();
  const failed = Object.keys(all).filter((id) => all[id].state === 'failed');
  if (!failed.length) return;
  jobs.value = { ...all, ...Object.fromEntries(failed.map((id) => [id, { ...all[id], tries: 0, retryAt: 0, pulled: false }])) };
}

// Ticks when the next failed job is due, so the scheduler below looks again.
const clock = signal(Date.now());
let retryTimer = 0;
const offTimer = effect(() => {
  clearTimeout(retryTimer);
  const due = Object.values(jobs.value).filter(canRetry).map((j) => j.retryAt ?? 0);
  if (due.length) retryTimer = setTimeout(() => (clock.value = Date.now()), Math.max(0, Math.min(...due) - Date.now()) + 50);
});

// The chat's LLM settings (same persist keys and loaders as chat/store.js, which net/ doesn't import
// statically). A new key, endpoint or model may fix what failed.
const llmSettings = [
  persist('chat.apiKey', () => load('redaw.apiKey', '')),
  persist('chat.baseURL', () => load('redaw.baseURL', '')),
  persist('chat.model', () => load('redaw.chat.model', '')),
];
const offSettings = llmSettings.map((sig) => {
  let first = true;
  return sig.subscribe(() => (first ? (first = false) : (retryFailed(), redundant.retryNow())));
});

/** Changes auto-merge waits on for a redundancy verdict (ids; for the Changes window). */
export const awaitingVerdict = signal([]);
/** The job running now, with its change: { change, job } or null. */
export const current = computed(() => {
  const id = active.value;
  return id ? { change: changes.published.value.find((c) => c.id === id) ?? { id, name: id, author: '?' }, job: jobs.value[id] ?? {} } : null;
});

export function toggleAutoMerge() {
  autoMergeOn.value = !autoMergeOn.peek();
}

// ---- idle ---------------------------------------------------------------------------------------

let lastInput = Date.now();
let held = 0; // pointer buttons down
const onInput = (e) => {
  if (e.type === 'pointermove' && !e.buttons) return;
  lastInput = Date.now();
  if (e.type === 'pointerdown') held = e.buttons || 1;
  else if (e.type === 'pointerup' || e.type === 'pointercancel') held = e.buttons;
};
const INPUT_EVENTS = ['pointerdown', 'pointerup', 'pointercancel', 'pointermove', 'keydown', 'wheel'];
for (const t of INPUT_EVENTS) window.addEventListener(t, onInput, { capture: true, passive: true });

// The transport's and recorder's state, by their persist keys (net/ doesn't import app/).
const playing = persist('playhead.playing', false);
const recordings = persist('recorder.recordings', {});

/** Why it isn't a good moment to swap code in now, or null when the user has paused. */
export function busyReason() {
  if (held) return 'you are dragging';
  if (Object.keys(recordings.peek()).length) return 'recording';
  if (playing.peek()) return 'playing';
  if (vfs.trial) return 'a preview is running';
  if (Date.now() - lastInput < IDLE_MS) return 'you are working';
  return null;
}

/** Resolves once the user pauses; rejects when `signal` aborts or the session changes. */
function waitForIdle(signal, doc) {
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (signal?.aborted) return reject(new Error('Stopped.'));
      if (session.currentDoc.peek() !== doc) return reject(new Error('The user opened another session; the change belongs to the one it was published in. Stop here.'));
      if (!busyReason()) return resolve();
      timer = setTimeout(tick, 300);
    };
    let timer = 0;
    tick();
  });
}

// ---- the agent ----------------------------------------------------------------------------------

const PROMPT = `# Auto-merge
This chat runs in the background: the user turned auto-merge on, so a change a peer published is merged into this page's code without their click. Nobody reads this chat while you work. You decide whether the change is safe, and make it fit.

1. Review it first. Read every edit of the change (the first message lists the bundle; view the files in your overlay, and what they call). Hold it back if the code sends data off the page (fetch, WebSocket, sendBeacon, image or script URLs to other hosts), reads API keys, chats or stored data it doesn't need, loads or evaluates remote or obfuscated code, changes chat/ or net/ (the code that decides what runs here and what is shared) without its intent explaining why, or does anything else its intent doesn't explain. If any part of it is suspicious, hold back the whole change: don't apply the harmless rest, since its author can't be trusted with it either. When in doubt, hold it back: the user can still apply it by hand.
2. If it is safe, make it fit: edits marked DID NOT APPLY and conflict markers need the equivalent change on top of our code, keeping our local changes. Change no more than that.
3. apply_changes with the change's name as label. The call waits until the user pauses (no input for a few seconds, playback stopped), so their work isn't interrupted. If it rolls back, fix and apply again; if it can't be made to work in a few tries, hold it back.
4. End with one line: "Merged: …" (what it adds), or "Held back: …" (why). To hold back, just end your turn without applying. Don't try_changes, propose_bundle or add an onboarding_guide.`;

const unregister = registerExtension('automerge', {
  label: (scope) => (scope === SCOPE ? 'Auto-merge' : null),
  prompt: (scope) => (scope === SCOPE ? PROMPT : null),
  beforeApply: async (scope, { session: s, signal }) => {
    if (scope !== SCOPE) return;
    const id = Object.keys(jobs.peek()).find((k) => jobs.peek()[k].sessionId === s?.id);
    if (id) setJob(id, { state: 'waiting' });
    try {
      await waitForIdle(signal, jobs.peek()[id]?.doc ?? session.currentDoc.peek());
    } finally {
      if (id) setJob(id, { state: 'reviewing' });
    }
  },
});

/** The agent's last words. */
function lastText(s) {
  for (const m of [...s.messages.peek()].reverse()) {
    if (m.role !== 'assistant' || typeof m.content === 'string') continue;
    const t = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (t) return t.split('\n').find((l) => l.trim()) ?? t;
  }
  return null;
}

async function run(c) {
  active.value = c.id;
  const doc = session.currentDoc.peek();
  setJob(c.id, { state: 'reviewing', doc, note: null });
  let state = 'failed', note = null;
  try {
    const [{ newSession, getSession }, { sendMessage }] = await Promise.all([import('../chat/store.js'), import('../chat/agent.js')]);
    const pv = await changes.preview(c.id); // stages it (and what it needs) in 'peer:<id>'
    const sid = newSession(SCOPE, { overlayId: pv.ovId, title: `Auto-merge “${c.name}”` });
    setJob(c.id, { sessionId: sid });
    const s = getSession(sid);
    await sendMessage(s, changes.adaptationBrief(c.id, pv.conflicts));
    note = lastText(s);
    if (changes.applied.peek().has(c.id)) state = 'merged';
    else if (/^The model declined/.test(s.error.peek() ?? '')) {
      // The model's own safeguards refused the change: as good a reason to hold it back as any.
      state = 'held';
      note = 'the model refused to work on it (its safety filter flagged the code)';
    } else if (s.error.peek()) note = s.error.peek();
    else state = 'held';
  } catch (e) {
    note = String(e?.message || e);
  } finally {
    if (state === 'failed' && !autoMergeOn.peek()) retry(c.id); // switched off mid-way: try again when it's back on
    else if (state === 'failed') {
      const tries = (jobs.peek()[c.id]?.tries ?? 0) + 1;
      setJob(c.id, { state, note, tries, retryAt: Date.now() + RETRY_MS[Math.min(tries, RETRY_MS.length) - 1] });
    } else setJob(c.id, { state, note });
    if (state === 'merged') retryFailed(); // the LLM works (again): what failed may go through now
    if (jobs.peek()[c.id]) outcomes.value = [...outcomes.peek(), { id: c.id, name: c.name, author: c.author, state, note }].slice(-20);
    if (active.peek() === c.id) active.value = null;
  }
}

/** Stops the running auto-merge agent (its change stays for the user). */
export async function stopCurrent() {
  const id = active.peek();
  const sid = id && jobs.peek()[id]?.sessionId;
  if (!sid) return;
  const [{ findSession }, { stop }] = await Promise.all([import('../chat/store.js'), import('../chat/agent.js')]);
  const s = findSession(sid);
  if (s) stop(s);
}

/** Forgets a held or failed job, so auto-merge tries the change again. */
export function retry(id) {
  const { [id]: _, ...rest } = jobs.peek();
  jobs.value = rest;
}

const WAIT = Symbol('wait'); // the queue stops here until a redundancy verdict comes

/**
 * What to run for change `c`: c itself, a failed change it builds on (tried again first), null to
 * leave it for now (it is held back, redundant, or waits for a change it builds on), or WAIT when it
 * waits for a redundancy verdict (nothing after it runs meanwhile, so the order holds).
 */
function nextStep(c) {
  const all = jobs.peek();
  if (all[c.id] && !isDue(all[c.id])) return null;
  const p = changes.plan(c.id);
  if (p.missing.length) return void setJob(c.id, { state: 'held', note: `needs changes that aren't published: ${p.missing.join(', ')}` }), null;
  // Redundant or not? Ask for what isn't judged yet (it and what is staged with it), and wait.
  const byId = (id) => changes.published.peek().find((x) => x.id === id);
  const unjudged = p.order.map(byId).filter((x) => x && !redundant.request(x));
  if (unjudged.length) {
    if (!awaitingVerdict.peek().includes(c.id)) awaitingVerdict.value = [...awaitingVerdict.peek(), c.id];
    return WAIT;
  }
  if (awaitingVerdict.peek().includes(c.id)) awaitingVerdict.value = awaitingVerdict.peek().filter((x) => x !== c.id);
  if (redundant.isRedundant(c)) return null; // judged just now: left out like the others
  for (const id of p.order) {
    const d = all[id];
    if (id === c.id || !d || redundant.isRedundant(byId(id) ?? {})) continue; // not tried yet (staged with c), or the base has it
    if (d.state === 'held') return void setJob(c.id, { state: 'held', note: `builds on “${nameOf(id)}”, which was held back${d.note ? `: ${d.note}` : ''}` }), null;
    if (d.state !== 'failed') continue;
    const dep = byId(id);
    if (dep && isDue(d)) return dep;
    if (dep && canRetry(d) && !d.pulled) return setJob(id, { pulled: true, retryAt: 0 }), dep;
    return null; // it waits for that one's retries (or for the user, when they ran out)
  }
  return c;
}

// One at a time: when nothing runs, start on the oldest change not handled yet (or failed and due
// again), and not redundant.
const offRun = effect(() => {
  if (!autoMergeOn.value || session.status.value !== 'ready' || active.value) return;
  const all = jobs.value;
  clock.value; // look again when a failed job is due
  redundant.verdicts.value; // changes the base already has are left out (the Changes window folds them)
  const todo = changes.catchUpList.value.filter((c) => (!all[c.id] || canRetry(all[c.id])) && !redundant.isRedundant(c));
  if (!todo.length) return;
  queueMicrotask(() => {
    if (active.peek() || !autoMergeOn.peek()) return;
    const left = awaitingVerdict.peek().filter((id) => todo.some((c) => c.id === id));
    if (left.length !== awaitingVerdict.peek().length) awaitingVerdict.value = left;
    for (const c of todo) redundant.request(c); // queue every verdict now, so they come back to back
    for (const c of todo) {
      const step = nextStep(c);
      if (step === WAIT) return;
      if (step) return void run(step);
    }
  });
});
const offOff = autoMergeOn.subscribe((on) => !on && stopCurrent());

export function dispose() {
  unregister();
  offRun();
  offOff();
  offTimer();
  clearTimeout(retryTimer);
  offSettings.forEach((f) => f());
  offSave.forEach((f) => f());
  for (const t of INPUT_EVENTS) window.removeEventListener(t, onInput, { capture: true });
}
