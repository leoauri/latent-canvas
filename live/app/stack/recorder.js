// Latent recording: an armed latent layer records, while the transport plays, the latent stream
// reaching it (from the nearest producer behind it, app/stack/models.js) into new clips, one per
// voice of the stream, each placed where its voice is on the timeline (for a live input: the
// playhead, at the input dot).
// Clips grow on the timeline while they record and are saved when the recording ends (stop,
// disarm, or the source going away).
import { effect } from '@preact/signals';
import { persist } from '@live/runtime';
import { audioContext } from '../../lib/audio.js';
import { stack, stackLayerById } from './stack.js';
import { subscribe, producerBehind, producedKind } from './models.js';
import { playing, time, holdInput, nudgeInput } from '../timeline/Playhead.jsx';
import { clips, addClip, updateClip, removeClip, CLIP_HEIGHT, duration } from '../timeline/clips.js';
import { masksOf } from '../timeline/layers.js';

const UPDATE_EVERY = 4; // frames between redraws of a growing clip
const LANE_GAP = 6; // px between stacked takes

/**
 * @typedef {object} Take  one voice of the stream, recorded into one clip
 * @property {string|null} clipId  created with the first frame
 * @property {number} n
 * @property {number} missed
 * @property {number} dim
 * @property {Float32Array} buf
 *
 * @typedef {object} Recording
 * @property {string} sourceId   the producer layer
 * @property {number} startFrame context frame at the playhead's start
 * @property {number} t0         playhead time at the start, seconds
 * @property {Map<string, Take>} takes  by voice: each voice that reaches the layer gets its own clip
 * @property {number} n          frames of the longest take
 * @property {number} missed     missed frames over all takes (zeros)
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

/** Where a new clip goes when its stream has no position: the layer's first mask, else below the clips it would overlap. */
function laneFor(l, t0) {
  const m = masksOf(l.id).find((r) => r.h < 1e6);
  if (m) return m.y + Math.max(0, (m.h - CLIP_HEIGHT) / 2);
  const overlapping = clips.value.filter((c) => c.t + duration(c) > t0);
  return overlapping.length ? Math.max(...overlapping.map((c) => c.y)) + CLIP_HEIGHT + LANE_GAP : 0;
}

function begin(l, sourceId) {
  const ctx = audioContext();
  const rec = { sourceId, startFrame: Math.round(ctx.currentTime * ctx.sampleRate), t0: time.peek(), takes: new Map(), n: 0, missed: 0 };
  rec.unsub = subscribe(sourceId, ({ kind, data: frame, missed, start, rate, dim, voice, t, y }) => {
    if (kind !== 'latent' || start < rec.startFrame) return; // a flush; or audio from before the recording started
    let take = rec.takes.get(voice);
    if (!take) {
      take = { clipId: newId(), n: 0, missed: 0, dim, buf: new Float32Array(dim * Math.ceil(rate * 30)) };
      addClip({
        id: take.clipId,
        t: t ?? rec.t0 + (start - rec.startFrame) / ctx.sampleRate,
        // The trace goes where the stream is: a unit's y is a clip's centre line.
        y: y !== undefined ? y - CLIP_HEIGHT / 2 : laneFor(stackLayerById(l.id) ?? l, rec.t0),
        rate,
        dim,
        length: 0,
        data: take.buf.subarray(0, 0),
        recording: true,
      });
      rec.takes.set(voice, take);
    }
    if (dim !== take.dim) return;
    if ((take.n + 1) * dim > take.buf.length) {
      const grown = new Float32Array(take.buf.length * 2);
      grown.set(take.buf);
      take.buf = grown;
    }
    take.buf.set(frame, take.n * dim);
    take.n++;
    rec.n = Math.max(rec.n, take.n);
    if (missed) take.missed++, rec.missed++;
    if (take.n % UPDATE_EVERY === 0) updateClip(take.clipId, { length: take.n, data: take.buf.subarray(0, take.n * dim) });
  });
  recordings.value = { ...recordings.peek(), [l.id]: rec };
}

function end(id) {
  const rec = recordings.peek()[id];
  if (!rec) return;
  rec.unsub();
  if ([...rec.takes.values()].some((take) => take.n)) tookClip = true;
  const next = { ...recordings.peek() };
  delete next[id];
  recordings.value = next;
  for (const take of rec.takes.values()) {
    if (!clips.peek().some((c) => c.id === take.clipId)) continue; // deleted while recording
    if (!take.n) removeClip(take.clipId);
    // An exact copy of the frames, saved with the other clips from now on.
    else updateClip(take.clipId, { length: take.n, data: take.buf.slice(0, take.n * take.dim), recording: undefined });
  }
  if (rec.missed) console.warn(`latent recording: ${rec.missed} frames missed their inference (zeros)`);
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

// While a recording runs, the live input's world position stays put (Playhead.jsx). When it ends
// having made a clip, the input dot moves a lane down, so the next take goes below it.
let tookClip = false;
const stopHold = effect(() => {
  const on = Object.keys(recordings.value).length > 0;
  holdInput(on);
  if (!on && tookClip) (tookClip = false), nudgeInput(CLIP_HEIGHT + LANE_GAP);
});

export function dispose() {
  stopEffect();
  stopHold();
  // Recordings keep running across a module swap: their listeners live in models.js.
}
