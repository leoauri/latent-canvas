// Redundant changes: bundles and peers' changes whose effect the base (live/ on disk) already has,
// merged as-is or rewritten. The Changes window folds them away; nothing is unpublished or deleted.
//
//   state(c)          this change's verdict for the current base, or null (unchecked):
//                     { v: 'redundant'|'partial'|'no', reason, by: 'text'|'duplicate'|'agent'|'you', sig, at }
//   notRedundant(c)   the user overrules a verdict (holds until a file it touches changes in the base)
//   checking          signal: the change id an agent is judging now
//   lastError         signal: why the last agent check failed (retried after RETRY_MS)
//   request(c)        c's verdict, or null after asking for one soon (auto-merge waits for it):
//                     wanted changes go first, after URGENT_MS instead of QUIET_MS
//   retryNow()        lifts the pause after an endpoint/network error (e.g. the LLM settings changed)
//
// A verdict is keyed by the hashes of the base files the change touches (sig), so a change is
// judged again only when one of those files changes. Cheap checks first: every edit already in the
// base, or the same edits as a newer change. The rest go to the chat's LLM endpoint, one at a time,
// once the base has been quiet for QUIET_MS (so a promotion in progress isn't judged half-written).
// An answer that can't be used skips that change for RETRY_MS; only an endpoint or network error
// pauses the whole queue. A check in flight survives this module being reloaded: the new instance
// takes over its request (globalThis.__redundantInflight) instead of sending it again.
import { signal, effect } from '@preact/signals';
import { vfs, vfsVersion, persist } from '@live/runtime';
import * as db from '../lib/db.js';
import * as changes from './changes.js';
import * as bundles from './bundles.js';
import * as session from './session.js';
import { complete, APIError } from '../chat/llm.js';

const QUIET_MS = 30_000;
const URGENT_MS = 1_000;
const RETRY_MS = 5 * 60_000;
const MAX_FILE_CHARS = 80_000;

export const verdicts = persist('net.redundant', {});
const unbind = db.sync(verdicts, 'net.redundant');
export const checking = signal(null);
export const lastError = signal(null);

const hash = (s) => vfs.hash(s ?? null);
const sigOf = (c) => hash(changes.pathsOf(c).map((p) => `${p}\0${hash(vfs.readBase(p))}`).join('\n'));
const content = (c) => JSON.stringify(c.patch ?? c.files ?? null);

/** A bundle as a change (its published form, under the bundle's id and name). */
export const asChange = (b) => ({ ...b.change, id: b.id, name: b.name });

/** The open session's changes: published ones plus your bundles (published or not). */
function candidates() {
  const byId = new Map();
  for (const c of changes.published.peek()) byId.set(c.id, c);
  const doc = session.currentDoc.peek();
  for (const b of bundles.bundles.peek()) if (b.room === doc && b.change) byId.set(b.id, asChange(b));
  return [...byId.values()].filter((c) => changes.pathsOf(c).length);
}

export function state(c) {
  const v = verdicts.value[c.id];
  return v && v.sig === sigOf(c) ? v : null;
}
export const isRedundant = (c) => state(c)?.v === 'redundant';

const setVerdict = (c, v) => {
  wanted.delete(c.id);
  verdicts.value = { ...verdicts.peek(), [c.id]: { ...v, sig: sigOf(c), at: Date.now() } };
};

export function notRedundant(c) {
  setVerdict(c, { v: 'no', by: 'you', reason: 'you marked it not redundant' });
}

/** Is this patch file's result in `text`? (Unlike changes.patchFile, an insertion, whose new_str contains its old_str, counts.) */
function patchInText(text, f) {
  if (f.delete) return text == null;
  if (f.create != null) return text === f.create;
  if (text == null) return false;
  return f.edits.every((e) => (e.new_str ? text.includes(e.new_str) && (!text.includes(e.old_str) || e.new_str.includes(e.old_str)) : !text.includes(e.old_str)));
}

/** Decided without an agent, or null. */
function textCheck(c, all) {
  const inBase = c.patch
    ? c.patch.every((f) => patchInText(vfs.readBase(f.path), f))
    : c.files.every((f) => hash(vfs.readBase(f.path)) === f.afterHash);
  if (inBase) return { v: 'redundant', by: 'text', reason: 'all its edits are in the base' };
  const twin = all.find((d) => d.id !== c.id && (d.at ?? 0) > (c.at ?? 0) && content(d) === content(c));
  if (twin) return { v: 'redundant', by: 'duplicate', reason: `same edits as “${twin.name}”` };
  return null;
}

const SYSTEM = `You compare a proposed code change against the current code of a web app (its "base").
Decide whether the base already does what the change does. The base may have it written differently:
rewritten, refactored, renamed, moved to another file, or extended since. Judge behaviour, not text.
You have no tools: you cannot search, read other files or run anything. Everything you get is in
this message. A file shown as (absent) does not exist in the base; judge from what you have.
Answer with JSON only, no prose around it:
{"verdict": "redundant" | "partial" | "no", "reason": "one short sentence; name where in the base"}
redundant: everything the change achieves, the base already does.
partial: the base does some of it but not all (say what is missing).
no: the base lacks what the change is for.`;

const cap = (s) => (s.length > MAX_FILE_CHARS ? `${s.slice(0, MAX_FILE_CHARS)}\n… (truncated)` : s);

function brief(c) {
  const out = [`# The change: “${c.name}”`];
  if (c.intent) out.push(`Intent: ${c.intent}`);
  if (c.patch) out.push('Its edits (exact-text replacements, - old / + new):', changes.formatPatch(c.patch));
  else {
    out.push('A whole-file change. Diff from the CURRENT base to the change\'s version of each file ("+" lines are what the change has and the base doesn\'t; the base may simply be newer, so "-" lines alone mean nothing):');
    for (const f of c.files) out.push(`--- ${f.path}`, f.source == null ? '(the change deletes it)' : vfs.lineDiff(vfs.readBase(f.path) ?? '', f.source) || '(identical)');
  }
  out.push('', '# The base now');
  for (const p of changes.pathsOf(c)) {
    const s = vfs.readBase(p);
    out.push(`--- ${p}`, s == null ? '(absent)' : cap(s));
  }
  return out.join('\n');
}

function parse(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`no JSON in the answer: ${text.slice(0, 200)}`);
  const j = JSON.parse(m[0]);
  if (!['redundant', 'partial', 'no'].includes(j.verdict)) throw new Error(`unknown verdict: ${j.verdict}`);
  return { v: j.verdict, reason: String(j.reason ?? '').slice(0, 300) };
}

/** The request in flight, shared across reloads of this module: { id, sig, promise } */
const inflight = (sig, c) => {
  const f = globalThis.__redundantInflight;
  if (f?.id === c.id && f.sig === sig) return f.promise;
  const promise = complete([{ role: 'system', content: SYSTEM }, { role: 'user', content: brief(c) }]);
  globalThis.__redundantInflight = { id: c.id, sig, promise };
  promise.catch(() => {}).finally(() => globalThis.__redundantInflight?.promise === promise && (globalThis.__redundantInflight = null));
  return promise;
};

async function agentCheck(c) {
  const sig = sigOf(c);
  const text = await inflight(sig, c);
  if (stopped || sigOf(c) !== sig) return; // replaced by a newer instance, or the base moved: judged again later
  setVerdict(c, { ...parse(text), by: 'agent' });
}

// An error that isn't about this change: the endpoint or the network. Pauses the whole queue.
const isTransport = (e) => e instanceof APIError || e instanceof TypeError;

// ---- scheduling --------------------------------------------------------------------------------

const wanted = new Set(); // ids someone waits on (auto-merge): checked first, without the quiet wait
const textMiss = new Map(); // id -> sig the text check couldn't decide
const skipped = new Map(); // id -> { sig, until }: its last answer was unusable
let timer = 0;
let timerAt = 0; // when the timer fires
let pendingKey = '';
let retryAt = 0;
let running = false;
let stopped = false;

/** Unchecked changes after the cheap checks (which this runs and records). */
function unchecked() {
  if (session.status.peek() !== 'ready') return [];
  const all = candidates();
  const out = [];
  for (const c of all) {
    const v = verdicts.peek()[c.id];
    const sig = sigOf(c);
    if (v && v.sig === sig) continue;
    const s = skipped.get(c.id);
    if (s && s.sig === sig && s.until > Date.now()) continue;
    if (textMiss.get(c.id) !== sig) {
      const t = textCheck(c, all);
      if (t) {
        setVerdict(c, t);
        continue;
      }
      textMiss.set(c.id, sig);
    }
    out.push(c);
  }
  // Wanted first, in the order they were asked for (auto-merge asks in its own order); the rest as listed.
  const rank = new Map([...wanted].map((id, i) => [id, i]));
  return out.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
}

/**
 * The verdict on change `c` for the current base, or null after asking for one soon. The cheap
 * checks run now; an agent check runs after URGENT_MS, ahead of the others. A change with no files
 * can't be judged: it counts as not redundant.
 */
export function request(c) {
  const v = state(c);
  if (v) return v;
  if (!changes.pathsOf(c).length) return { v: 'no', by: 'text', reason: 'touches no files' };
  if (!wanted.has(c.id)) {
    wanted.add(c.id);
    queueMicrotask(() => !stopped && update());
  }
  return null;
}

/** Lifts the pause after an endpoint or network error, so the queue goes on now. */
export function retryNow() {
  if (!retryAt && !skipped.size) return;
  retryAt = 0;
  skipped.clear();
  pendingKey = '';
  if (!running) update();
}

function update() {
  const todo = unchecked();
  const key = todo.map((c) => `${c.id}:${sigOf(c)}`).join(',');
  if (!todo.length) {
    // Only skipped ones left: look again when the first skip runs out.
    const until = Math.min(...[...skipped.values()].map((s) => s.until));
    if (!running && Number.isFinite(until) && !timer) timer = setTimeout(() => ((timer = 0), (pendingKey = ''), update()), Math.max(0, until - Date.now()) + 1000);
  }
  if (!todo.length || running) return void (pendingKey = key);
  const at = Date.now() + Math.max(wanted.has(todo[0].id) ? URGENT_MS : QUIET_MS, retryAt - Date.now());
  if (key === pendingKey && timer && timerAt <= at) return; // nothing new (or nothing sooner): let the timer run
  pendingKey = key;
  clearTimeout(timer);
  timerAt = at;
  timer = setTimeout(run, at - Date.now());
}

async function run() {
  timer = 0;
  running = true;
  try {
    // One at a time, taking the list again after each: a change asked for meanwhile goes next.
    const tried = new Set();
    for (let c; (c = unchecked().find((x) => !tried.has(x.id))); ) {
      tried.add(c.id);
      if (stopped) return;
      checking.value = c.id;
      try {
        await agentCheck(c);
        lastError.value = null;
      } catch (e) {
        if (stopped) return;
        lastError.value = `${c.name}: ${String(e.message || e)}`;
        if (isTransport(e)) {
          retryAt = Date.now() + RETRY_MS;
          break;
        }
        skipped.set(c.id, { sig: sigOf(c), until: Date.now() + RETRY_MS });
      }
    }
  } finally {
    checking.value = null;
    running = false;
  }
  if (!stopped) {
    pendingKey = '';
    update();
  }
}

const offEffect = effect(() => {
  vfsVersion.value;
  changes.published.value;
  bundles.bundles.value;
  session.currentDoc.value;
  session.status.value;
  queueMicrotask(() => !stopped && update());
});

export function dispose() {
  stopped = true;
  offEffect();
  clearTimeout(timer); // a request in flight is left to the next instance
  unbind();
}
