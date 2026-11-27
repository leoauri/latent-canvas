// Audio files dropped on the canvas become latent clips, recorded the way live input is. The
// file's audio enters the layer stack at the back, as a live input's would, and goes forward by the
// rules of the live stream (models.js, recorder.js; stack.js `records` and `passesOn`):
// - an operator inside whose masks the drop point lies runs its model on it if the model takes that
//   kind (an encoder turns the audio into latents), or its layer function on latents (unless
//   bypassed); otherwise it lets it pass;
// - an armed latent recording layer records the latents reaching it into a clip of its own at the
//   drop point (several armed layers each make one, a lane apart in stack order); a latent layer
//   lets it go on only with pass-through on;
// - nothing reaches an audio output: the drop is never heard.
// Unlike live recording this runs offline (models.js renderOffline): as fast as the models go, with
// every frame, and without the transport playing. While it runs, `pendingDrops` holds the area the
// clip will fill (drawn by TimelineCanvas.jsx) once the file's length is known.
import { effect } from '@preact/signals';
import { persist } from '@live/runtime';
import { audioContext } from '../../lib/audio.js';
import { engineOn } from '../../lib/engine.js';
import { stack, records, passesOn } from './stack.js';
import { runtimes, renderOffline } from './models.js';
import { runLayer, tickLayer, hasTick } from './layerFunc.js';
import { operatesAt } from '../timeline/layers.js';
import { CLIP_HEIGHT, LANE } from '../timeline/clips.js';

const AUDIO_FILE_RE = /\.(wav|wave|mp3|ogg|oga|opus|flac|m4a|aac|aif|aiff|caf|webm)$/i;
const RING_MAX_S = 60; // as models.js: a layer function's ring-out is ended after this long

export const isAudioFile = (f) => !!f && (f.type?.startsWith('audio/') || AUDIO_FILE_RE.test(f.name ?? ''));

/** A file's audio as mono at the audio context's rate (channels averaged). */
export async function decodeAudioFile(file) {
  let buf;
  try {
    buf = await audioContext().decodeAudioData(await file.arrayBuffer());
  } catch (e) {
    const ext = (file.name?.match(/\.(\w+)$/)?.[1] ?? file.type ?? 'this format').toLowerCase();
    throw new Error(`this browser can't decode ${ext} (${e?.message || e}); try wav or mp3`);
  }
  const out = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += ch[i] / buf.numberOfChannels;
  }
  return out;
}

/** The model runtime of operator `l` once it is no longer loading; throws if it can't run. */
function readyRuntime(l) {
  if (!engineOn.peek()) return Promise.reject(new Error(`the engine is off, so the model on ${l.name} does not run`));
  return new Promise((resolve, reject) => {
    let done = false;
    const stop = effect(() => {
      const rt = runtimes.value[l.id];
      if (done || !rt || rt.status === 'loading' || rt.ref.added !== l.model.added) return; // not started yet, or loading
      done = true;
      queueMicrotask(() => stop());
      if (rt.status === 'ready') resolve(rt);
      else reject(new Error(`the model on ${l.name} failed: ${rt.error}`));
    });
  });
}

/** Latent frames at `from` per second resampled to `to` per second, as a zero-order hold. */
function holdResample(data, dim, from, to) {
  if (from === to) return data;
  const n = Math.floor(((data.length / dim) * to) / from);
  const out = new Float32Array(n * dim);
  for (let i = 0; i < n; i++) {
    const j = Math.floor((i * from) / to);
    out.set(data.subarray(j * dim, (j + 1) * dim), i * dim);
  }
  return out;
}

/**
 * Runs a layer function on a whole latent stream (one voice), as the live operator does frame by
 * frame, ring-out (tick) included. Returns { data, dim, rate } of the latent frames it sends on.
 */
function runFunc(l, s, at) {
  const sr = audioContext().sampleRate;
  const voice = `file:${l.id}`;
  const state = {};
  const out = [];
  const take = (msgs) => {
    for (const m of [msgs ?? []].flat()) if (m?.kind === 'latent' && m.data) out.push(m);
  };
  const n = s.data.length / s.dim;
  for (let i = 0; i < n; i++) {
    const msg = { kind: 'latent', data: s.data.slice(i * s.dim, (i + 1) * s.dim), dim: s.dim, rate: s.rate, start: Math.round((i * sr) / s.rate), voice, t: at.t + i / s.rate, y: at.y };
    take(runLayer(l, { msg, state, sampleRate: sr }));
  }
  if (hasTick(l))
    for (let i = n; i < n + RING_MAX_S * s.rate; i++) {
      const frame = { voice, start: Math.round((i * sr) / s.rate), rate: s.rate, dim: s.dim, t: at.t + i / s.rate, y: at.y };
      const msgs = [tickLayer(l, { voice, at: frame, state, sampleRate: sr }) ?? []].flat();
      if (!msgs.length) break;
      take(msgs);
    }
  if (!out.length) return { data: new Float32Array(0), dim: s.dim, rate: s.rate };
  const dim = out[0].dim ?? out[0].data.length;
  const data = new Float32Array(out.length * dim);
  out.forEach((m, i) => m.data.length === dim && data.set(m.data, i * dim));
  return { data, dim, rate: out[0].rate ?? s.rate };
}

/** The armed latent layers a drop can reach (none past a layer that stops it), back to front. */
export function recordersFor(layers = stack.peek()) {
  const stop = layers.findIndex((l) => !passesOn(l));
  return (stop === -1 ? layers : layers.slice(0, stop + 1)).filter(records);
}

/** Audio drops in progress: [{ id, name, t, y (top edge), dur (s), lanes, lane (step, world y) }], shown as placeholders. */
export const pendingDrops = persist('audioDrop.pending', []);

/** Shows the area a dropped file will fill until the returned function is called. */
export function showPending(p) {
  const id = crypto.randomUUID();
  pendingDrops.value = [...pendingDrops.peek(), { ...p, id }];
  return () => (pendingDrops.value = pendingDrops.peek().filter((q) => q.id !== id));
}

/**
 * Carries mono context-rate audio from the back of the stack forward, recording it into every armed
 * latent layer it reaches as latents, into a clip owned by that layer. `at` = { t, y, top?, lane? }:
 * where the stream enters (the clips' start and centre line, as a recorded unit's position), the
 * first clip's top edge (default: CLIP_HEIGHT / 2 above y), and the step between the clips of
 * several recording layers (default LANE), which go a lane apart in stack order, as in live
 * recording. `onStep(layer, waiting)` names each layer that processes it (`waiting`: for its model
 * to load). Resolves to [{ clip, layer }]: the clips (not added yet) and the layers that recorded
 * them; throws if none did.
 */
export async function clipsFromAudio(audio, at, onStep) {
  const sr = audioContext().sampleRate;
  const layers = [...stack.peek()];
  const recorders = recordersFor(layers);
  if (!recorders.length) {
    const stop = layers.find((l) => !passesOn(l));
    throw new Error(stop && layers.some(records) ? `${stop.name} (pass-through off) stops it before any armed layer` : 'no latent recording layer is armed: arm one to record dropped audio');
  }
  // Past the last layer that can record it, nothing more is needed (and nothing is ever heard).
  const end = layers.indexOf(recorders.at(-1)) + 1;
  const top = at.top ?? at.y - CLIP_HEIGHT / 2;
  let s = { kind: 'audio', data: audio, dim: 1, rate: sr };
  const out = [];
  let reachedAsAudio = null;
  for (const l of layers.slice(0, end)) {
    if (l.type === 'latent') {
      if (!records(l)) continue;
      if (s.kind !== 'latent') reachedAsAudio ??= l;
      else if (s.data.length) {
        const y = top + recorders.indexOf(l) * (at.lane ?? LANE);
        out.push({ layer: l, clip: { id: crypto.randomUUID(), t: at.t, y, rate: s.rate, dim: s.dim, length: s.data.length / s.dim, data: s.data, layer: l.id } });
      }
      continue;
    }
    if (l.type !== 'operator' || !operatesAt(l.id, at.t, at.y)) continue;
    if (l.model) {
      if (runtimes.peek()[l.id]?.status !== 'ready') onStep?.(l, 'waiting');
      const { model } = await readyRuntime(l);
      if (model.input.kind !== s.kind) continue; // passes, as in the live stream
      let input = s.data;
      if (s.kind === 'latent') {
        if (s.dim !== model.input.dim) throw new Error(`the model on ${l.name} takes ${model.input.dim}-d latents, ${s.dim}-d reach it`);
        input = holdResample(s.data, s.dim, s.rate, model.rate);
      }
      onStep?.(l);
      const r = await renderOffline(l.id, input);
      if (r.missed) console.warn(`audio drop: ${r.missed} units missed their inference on ${l.name}`);
      s = model.output.kind === 'latent' ? { kind: 'latent', data: r.data, dim: r.dim, rate: r.rate } : { kind: 'audio', data: r.data, dim: 1, rate: sr };
    } else if (l.func && !l.bypass && s.kind === 'latent') {
      onStep?.(l);
      s = { kind: 'latent', ...runFunc(l, s, at) };
    }
  }
  if (out.length) return out;
  if (reachedAsAudio) throw new Error(`it reached ${reachedAsAudio.name} as audio: put an encoder behind it`);
  throw new Error(`no latent frames reached the armed layer ${recorders.at(-1).name}`);
}
