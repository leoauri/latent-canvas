// Audio files dropped on the canvas become latent clips. The file's audio enters the layer stack at
// the back, as a live input's would, and goes forward through the layers by the rules of the live
// stream (models.js): an operator inside whose masks the drop point lies runs its model on it if
// the model takes that kind (an encoder turns the audio into latents), or its layer function on
// latents; every other layer lets it pass, except a latent layer with pass-through off, which stops
// it. The first latent recording layer that the latents reach, with the drop point inside its
// masks, takes them: they become a clip at the drop point, as a recording would make.
// Unlike a recording this runs offline (models.js renderOffline): as fast as the models go, with
// every frame, and without the transport playing or a layer armed.
import { effect } from '@preact/signals';
import { audioContext } from '../../lib/audio.js';
import { engineOn } from '../../lib/engine.js';
import { stack } from './stack.js';
import { runtimes, renderOffline } from './models.js';
import { runLayer, tickLayer, hasTick } from './layerFunc.js';
import { operatesAt } from '../timeline/layers.js';
import { CLIP_HEIGHT } from '../timeline/clips.js';

const AUDIO_FILE_RE = /\.(wav|wave|mp3|ogg|oga|opus|flac|m4a|aac|aif|aiff|caf|webm)$/i;
const RING_MAX_S = 60; // as models.js: a layer function's ring-out is ended after this long

export const isAudioFile = (f) => !!f && (f.type?.startsWith('audio/') || AUDIO_FILE_RE.test(f.name ?? ''));

/** A file's audio as mono at the audio context's rate (channels averaged). */
export async function decodeAudioFile(file) {
  const buf = await audioContext().decodeAudioData(await file.arrayBuffer());
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

/**
 * Carries mono context-rate audio from the back of the stack forward until a latent recording layer
 * takes it as latents. `at` = { t, y, top? }: where the stream enters (the clip's start and centre
 * line, as a recorded unit's position) and the clip's top edge (default: CLIP_HEIGHT / 2 above y).
 * `onStep(layer, waiting)` names each layer that processes it (`waiting`: for
 * its model to load). Resolves to { clip, layer }: the clip (not added yet) and the latent layer
 * that took it.
 */
export async function clipFromAudio(audio, at, onStep) {
  const sr = audioContext().sampleRate;
  let s = { kind: 'audio', data: audio, dim: 1, rate: sr };
  for (const l of [...stack.peek()]) {
    const inside = operatesAt(l.id, at.t, at.y);
    if (l.type === 'latent') {
      if (s.kind === 'latent' && inside) {
        const length = s.data.length / s.dim;
        if (!length) throw new Error(`no latent frames reached ${l.name}`);
        return { layer: l, clip: { id: crypto.randomUUID(), t: at.t, y: at.top ?? at.y - CLIP_HEIGHT / 2, rate: s.rate, dim: s.dim, length, data: s.data } };
      }
      if (l.passThrough === false) throw new Error(`${l.name} lets nothing through and ${s.kind === 'audio' ? 'audio' : 'latents'} reach it`);
      continue;
    }
    if (l.type !== 'operator' || !inside) continue;
    if (l.model) {
      if (runtimes.peek()[l.id]?.status !== 'ready') onStep?.(l, 'waiting');
      const { model } = await readyRuntime(l);
      if (model.input.kind !== s.kind) continue; // passes, as in the live stream
      let input = s.data;
      if (s.kind === 'latent') {
        if (s.dim !== model.input.channels) throw new Error(`the model on ${l.name} takes ${model.input.channels}-d latents, ${s.dim}-d reach it`);
        input = holdResample(s.data, s.dim, s.rate, model.rate);
      }
      onStep?.(l);
      const r = await renderOffline(l.id, input);
      if (r.missed) console.warn(`audio drop: ${r.missed} units missed their inference on ${l.name}`);
      s = model.output.kind === 'latent' ? { kind: 'latent', data: r.data, dim: r.dim, rate: r.rate } : { kind: 'audio', data: r.data, dim: 1, rate: sr };
    } else if (l.func && s.kind === 'latent') {
      onStep?.(l);
      s = { kind: 'latent', ...runFunc(l, s, at) };
    }
  }
  throw new Error(
    s.kind === 'audio'
      ? 'no encoder turns it into latents on the way to a latent recording layer: put an operator with an encoder behind one'
      : 'no latent recording layer takes the latents here (in front of the encoder, with the drop point inside its masks)',
  );
}
