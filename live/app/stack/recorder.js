// Latent recording: an armed latent layer records, while the transport plays, the latent stream
// reaching it (from the nearest producer behind it, app/stack/models.js) into a new clip that
// starts at the playhead. The clip grows on the timeline while it records and is saved when the
// recording ends (stop, disarm, or the source going away).
import { effect } from '@preact/signals';
import { persist } from '@live/runtime';
import { audioContext } from '../../lib/audio.js';
import { stack, stackLayerById } from './stack.js';
import { subscribe, producerBehind, producedKind } from './models.js';
import { playing, time } from '../timeline/Playhead.jsx';
import { clips, addClip, updateClip, removeClip, CLIP_HEIGHT, duration } from '../timeline/clips.js';
import { masksOf } from '../timeline/layers.js';

const UPDATE_EVERY = 4; // frames between redraws of a growing clip

/**
 * @typedef {object} Recording
 * @property {string} sourceId   the producer layer
 * @property {number} startFrame context frame at the playhead's start
 * @property {number} t0         playhead time at the start, seconds
 * @property {string|null} clipId  created with the first frame
 * @property {number} n          frames recorded
 * @property {number} missed     of which missed (zeros)
 * @property {Float32Array} buf
 * @property {() => void} unsub
 */
/** @type {import('@preact/signals').Signal<Record<string, Recording>>} by latent layer id */
export const recordings = persist('recorder.recordings', {});

/** The layer whose latents reach latent layer `l`, or null (nothing, or audio, reaches it). */
export function latentSourceOf(l) {
  const src = producerBehind(l);
  return src && producedKind(src) === 'latent' ? src : null;
}

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));

/** Where a new clip goes: the layer's first mask, else below the clips it would overlap. */
function laneFor(l, t0) {
  const m = masksOf(l.id)[0];
  if (m) return m.y + Math.max(0, (m.h - CLIP_HEIGHT) / 2);
  const overlapping = clips.value.filter((c) => !c.recording && c.t + duration(c) > t0);
  return overlapping.length ? Math.max(...overlapping.map((c) => c.y)) + CLIP_HEIGHT + 6 : 0;
}

function begin(l, sourceId) {
  const ctx = audioContext();
  const rec = { sourceId, startFrame: Math.round(ctx.currentTime * ctx.sampleRate), t0: time.peek(), clipId: null, n: 0, missed: 0, buf: null };
  rec.unsub = subscribe(sourceId, ({ data: frame, missed, start, rate, dim }) => {
    if (start < rec.startFrame) return; // audio from before the recording started
    if (!rec.clipId) {
      rec.buf = new Float32Array(dim * Math.ceil(rate * 30));
      const clip = {
        id: newId(),
        t: rec.t0 + (start - rec.startFrame) / ctx.sampleRate,
        y: laneFor(stackLayerById(l.id) ?? l, rec.t0),
        rate,
        dim,
        length: 0,
        data: rec.buf.subarray(0, 0),
        recording: true,
      };
      addClip(clip);
      rec.clipId = clip.id;
    }
    if ((rec.n + 1) * dim > rec.buf.length) {
      const grown = new Float32Array(rec.buf.length * 2);
      grown.set(rec.buf);
      rec.buf = grown;
    }
    rec.buf.set(frame, rec.n * dim);
    rec.n++;
    if (missed) rec.missed++;
    if (rec.n % UPDATE_EVERY === 0) update(rec, dim);
  });
  recordings.value = { ...recordings.peek(), [l.id]: rec };
}

const update = (rec, dim) => updateClip(rec.clipId, { length: rec.n, data: rec.buf.subarray(0, rec.n * dim) });

function end(id) {
  const rec = recordings.peek()[id];
  if (!rec) return;
  rec.unsub();
  const next = { ...recordings.peek() };
  delete next[id];
  recordings.value = next;
  const clip = rec.clipId && clips.peek().find((c) => c.id === rec.clipId);
  if (!clip) return; // nothing arrived, or the clip was deleted while recording
  if (!rec.n) return removeClip(clip.id);
  // An exact copy of the frames, saved with the other clips from now on.
  updateClip(clip.id, { length: rec.n, data: rec.buf.slice(0, rec.n * clip.dim), recording: undefined });
  if (rec.missed) console.warn(`latent recording: ${rec.missed} of ${rec.n} frames missed their inference (zeros)`);
}

const stopEffect = effect(() => {
  const on = playing.value;
  const recs = recordings.peek();
  const want = new Map();
  for (const l of stack.value) {
    if (l.type !== 'latent' || !l.armed || !on) continue;
    const src = latentSourceOf(l);
    if (src) want.set(l.id, src.id);
  }
  for (const id of Object.keys(recs)) if (want.get(id) !== recs[id].sourceId) end(id);
  for (const [id, src] of want) if (!recordings.peek()[id]) begin(stackLayerById(id), src);
});

export function dispose() {
  stopEffect();
  // Recordings keep running across a module swap: their listeners live in models.js.
}
