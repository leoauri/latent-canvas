// Pre-bake (this page, open session): while on, every clip is rendered offline into audio per audio
// output, one clip at a time in the background, and playback mixes the renders instead of
// streaming the clip's latents live (latentPlayback.js skips baked clips). A clip whose inputs
// changed keeps playing its last bake until re-baked.
//
// This file is the scaffold: scheduling, cache, playback, diagnostics. HOW a clip is rendered
// depends on the session (which evolves collaboratively) and lives in bakeRender.js, which the
// pre-bake agent (prebakeAgent.js) writes into the open session's code layer (the base only has a
// stub). Bakes belong to one session and one renderer: they are dropped when the session changes and
// on any re-evaluation of this module (every change to bakeRender.js, including the swap to another
// session's version).
import { effect, computed } from '@preact/signals';
import { persist } from '@live/runtime';
import { audioContext } from '../../lib/audio.js';
import { engineOn } from '../../lib/engine.js';
import { stack } from './stack.js';
import { runtimes, mixerOf } from './models.js';
import { clips } from '../timeline/clips.js';
import { playing, time, cue } from '../timeline/Playhead.jsx';
import { currentDoc } from '../../net/session.js';
import * as renderer from './bakeRender.js';

const SETTLE_MS = 800; // a clip's inputs must be unchanged this long before it is baked
const LOOKAHEAD_S = 0.1;

export const prebakeOn = persist('prebake.on', false);
/** clip id -> { key, outs: [{ outId, offset (s from clip.t), data: Float32Array }], missed } */
export const bakes = persist('prebake.bakes', {});
export const baking = persist('prebake.baking', null);
export const bakeErrors = persist('prebake.errors', {}); // clip id -> { key, error }

export const togglePrebake = () => (prebakeOn.value = !prebakeOn.value);
export const isBaked = (id) => prebakeOn.peek() && !!bakes.peek()[id];

// Every bake runs under the current stop controller. stopBakes() aborts the bake in progress (its
// renderClip gets the signal; the scaffold stops waiting for it even if the renderer ignores it)
// and any bakeAll, e.g. when pre-bake is switched off, the session changes or this module is replaced.
let stopper = new AbortController();
export function stopBakes(reason = 'pre-bake stopped') {
  stopper.abort(new Error(reason));
  stopper = new AbortController();
}
/** Resolves `p`, or rejects as soon as `signal` aborts (`p` may still be running then). */
function unlessAborted(p, signal) {
  let off;
  const aborted = new Promise((_, reject) => {
    const on = () => reject(signal.reason);
    if (signal.aborted) return on();
    signal.addEventListener('abort', on, { once: true });
    off = () => signal.removeEventListener('abort', on);
  });
  p.catch(() => {}); // still running after an abort when the renderer ignores the signal
  return Promise.race([p, aborted]).finally(() => off?.());
}

// This evaluation of the renderer: bakes from earlier code (or another session) are dropped.
const serial = persist('prebake.serial', 0);
const RENDERER = ++serial.value;
const forget = () => ((bakes.value = {}), (bakeErrors.value = {}));
forget();
const stopSessionWatch = effect(() => (currentDoc.value, stopBakes(), forget()));

const ids = persist('prebake.dataIds', () => ({ map: new WeakMap(), n: 0 })).value;
const dataId = (d) => (ids.map.has(d) || ids.map.set(d, ++ids.n), ids.map.get(d));
function contextKey() {
  try {
    return `${RENDERER}|${renderer.contextKey()}`;
  } catch (e) {
    return `${RENDERER}|contextKey failed: ${e?.message || e}`;
  }
}
const clipKey = (c, ck) => `${c.t}|${c.y}|${c.rate}|${c.dim}|${c.length}|${dataId(c.data)}|${ck}`;
const bakeable = (c) => !c.recording && !!c.data;

/** clip id -> 'baked' | 'stale' | 'baking' | 'failed' | 'none' */
export const bakeStatus = computed(() => {
  const ck = contextKey(), bk = bakes.value, errs = bakeErrors.value, out = {};
  for (const c of clips.value) {
    if (!bakeable(c)) continue;
    const key = clipKey(c, ck);
    out[c.id] =
      baking.value === c.id ? 'baking' : errs[c.id]?.key === key ? 'failed' : !bk[c.id] ? 'none' : bk[c.id].key === key ? 'baked' : 'stale';
  }
  return out;
});

/** What the renderer says it can't render in the current session (reactive). */
export const renderProblems = computed(() => {
  try {
    return renderer.problems?.() ?? [];
  } catch (e) {
    return [`problems() failed: ${e?.message || e}`];
  }
});

/** Errors of the current bakes: [{ clip, error }] (reactive). */
export const currentErrors = computed(() => {
  const st = bakeStatus.value, errs = bakeErrors.value;
  return Object.keys(st).filter((id) => st[id] === 'failed').map((id) => ({ clip: id, error: errs[id].error }));
});

/** No renderer has been written for this page yet (bakeRender.js is the stub). */
export const unwritten = !!renderer.unwritten;
/** Pre-bake needs an agent: the renderer can't handle something, or bakes fail. */
export const needsFix = computed(() => !unwritten && (renderProblems.value.length > 0 || currentErrors.value.length > 0));

// ---- baking ----------------------------------------------------------------------------------

let lock = Promise.resolve();
/** Runs bakes one at a time (the background loop and bakeAll share the models). */
function exclusive(fn) {
  const p = lock.then(fn);
  lock = p.catch(() => {});
  return p;
}

const notReady = () => {
  if (!engineOn.peek()) return 'the engine is off';
  const l = stack.peek().find((l) => l.type === 'operator' && l.model && runtimes.peek()[l.id]?.status !== 'ready');
  return l ? `the model on ${l.name} is not ready` : null;
};

const level = (d) => {
  let peak = 0, sum = 0;
  for (const v of d) (peak = Math.max(peak, Math.abs(v))), (sum += v * v);
  return { peak: +peak.toFixed(4), rms: +Math.sqrt(sum / (d.length || 1)).toFixed(4) };
};

async function bakeOne(c, key, signal) {
  if (signal.aborted) return { clip: c.id, aborted: true };
  baking.value = c.id;
  const t0 = performance.now();
  try {
    const { outs, missed = 0 } = await unlessAborted(Promise.resolve(renderer.renderClip(c, { signal })), signal);
    if (alive && !signal.aborted) {
      bakes.value = { ...bakes.peek(), [c.id]: { key, outs, missed } };
      const { [c.id]: _, ...rest } = bakeErrors.peek();
      bakeErrors.value = rest;
    }
    if (missed) console.warn(`prebake: clip ${c.id} baked with ${missed} missed decoder units`);
    const sr = audioContext().sampleRate;
    return { clip: c.id, ms: Math.round(performance.now() - t0), missed, outs: outs.map((o) => ({ outId: o.outId, offset: +o.offset.toFixed(3), seconds: +(o.data.length / sr).toFixed(3), ...level(o.data) })) };
  } catch (e) {
    if (signal.aborted) return { clip: c.id, aborted: true, ms: Math.round(performance.now() - t0) };
    console.warn('prebake:', e);
    const error = String(e?.message || e);
    if (alive) bakeErrors.value = { ...bakeErrors.peek(), [c.id]: { key, error } };
    return { clip: c.id, error, stack: String(e?.stack || '').split('\n').slice(0, 4).join('\n') };
  } finally {
    baking.value = null;
  }
}

/**
 * Bakes clips now (no settling), for checking the renderer: { problems, clips: [{ clip, ms,
 * missed, outs: [{ outId, offset, seconds, peak, rms }] } | { clip, error, stack } | { clip,
 * aborted }], aborted? }. Every clip by default; `ids` picks some, `limit` caps how many (first
 * ones in timeline order). `signal` (or stopBakes()) stops it after the clip in progress is abandoned.
 */
export async function bakeAll({ ids, limit = Infinity, signal } = {}) {
  const why = notReady();
  if (why) return { error: `can't bake: ${why}` };
  const ck = contextKey();
  const stop = AbortSignal.any([stopper.signal, ...(signal ? [signal] : [])]);
  const want = ids && new Set(ids);
  const todo = clips.peek().filter((c) => bakeable(c) && (!want || want.has(c.id))).slice(0, limit);
  const report = [];
  for (const c of todo) {
    if (stop.aborted) break;
    report.push(await exclusive(() => bakeOne(c, clipKey(c, ck), stop)));
  }
  return { problems: renderProblems.peek(), clips: report, ...(stop.aborted && { aborted: String(stop.reason?.message || stop.reason) }) };
}

let alive = true;
const seen = new Map(); // clip id -> { key, at }: when its current inputs were first seen
(async function loop() {
  while (alive) {
    await new Promise((r) => setTimeout(r, 300));
    if (!alive || unwritten || !prebakeOn.peek() || notReady()) continue;
    const ck = contextKey(), bk = bakes.peek(), now = performance.now();
    let todo = null;
    for (const c of clips.peek()) {
      if (!bakeable(c)) continue;
      const key = clipKey(c, ck);
      if (bk[c.id]?.key === key || bakeErrors.peek()[c.id]?.key === key) continue;
      const s = seen.get(c.id);
      if (s?.key !== key) seen.set(c.id, { key, at: now });
      else if (now - s.at >= SETTLE_MS && !todo) todo = { c, key };
    }
    if (todo) await exclusive(() => bakeOne(todo.c, todo.key, stopper.signal));
  }
})();

// ---- playback of bakes -----------------------------------------------------------------------

const play = persist('prebake.play', () => ({ run: null })).value;

function begin() {
  const ctx = audioContext();
  const sr = ctx.sampleRate;
  const run = { start: Math.round(ctx.currentTime * sr), t0: time.peek(), cue: cue.peek(), sent: new Map(), outs: new Set(), timer: 0 };
  run.timer = setInterval(() => {
    const now = run.t0 + (ctx.currentTime * sr - run.start) / sr;
    const bk = bakes.peek();
    for (const c of clips.peek()) {
      const b = bk[c.id];
      if (!b) continue;
      for (const o of b.outs) {
        const T0 = c.t + o.offset, k = `${c.id}:${o.outId}`;
        const from = run.sent.get(k) ?? Math.max(0, Math.round((now - T0) * sr));
        const to = Math.min(o.data.length, Math.round((now + LOOKAHEAD_S - T0) * sr));
        if (to <= from) continue;
        run.sent.set(k, to);
        mixerOf(o.outId)?.push(o.data.slice(from, to), run.start + Math.round((T0 - run.t0) * sr) + from);
        run.outs.add(o.outId);
      }
    }
  }, 5);
  play.run = run;
}
function end() {
  const run = play.run;
  if (!run) return;
  clearInterval(run.timer);
  for (const id of run.outs) mixerOf(id)?.flush();
  play.run = null;
}

end();
// Switching pre-bake off abandons the bake in progress instead of letting it run to its end.
const stopOnOff = effect(() => void (prebakeOn.value || stopBakes('pre-bake switched off')));
const stopEffect = effect(() => {
  const want = playing.value && prebakeOn.value;
  const c = cue.value;
  if (play.run && (!want || play.run.cue !== c)) end();
  if (want && !play.run) begin();
});

export function dispose() {
  alive = false;
  stopBakes('the pre-bake scaffold was replaced');
  stopOnOff();
  stopEffect();
  stopSessionWatch();
  end();
}
