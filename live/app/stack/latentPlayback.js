// Latent playback: while the transport plays, every latent layer that is not armed streams the
// latent frames of its clips under the playhead (app/stack/models.js routes them to the layers in
// front, a decoder say). Frames go out on the audio context's clock, one per HOP samples: frame k
// of a run is due when the context reaches frame start + k * HOP, and carries the clip's sample
// at the playhead time t0 + k * HOP / sampleRate (held, at the clip's own rate).
// Every clip under the playhead inside the layer's masks (a layer without masks plays every clip)
// is a voice of the stream, identified by the clip's id: the layers in front process each on its
// own (a decoder decodes them in parallel) and an audio output sums them. Where there is no clip,
// nothing is sent.
import { effect } from '@preact/signals';
import { persist } from '@live/runtime';
import { audioContext } from '../../lib/audio.js';
import { stack } from './stack.js';
import { emit, producedKind } from './models.js';
import { playing, time, cue } from '../timeline/Playhead.jsx';
import { clips, CLIP_HEIGHT, duration, sampleAt } from '../timeline/clips.js';
import { operatesAt } from '../timeline/layers.js';

export const HOP = 1024; // audio samples per latent frame (the codec's)
const TICK_MS = 5;

/** layer id -> { start, t0, k, timer } */
const runs = persist('latentPlayback.runs', () => new Map()).value;

/** The latent frames layer `layerId` plays at time t: one { voice, data, dim } per clip there. */
export function framesAt(layerId, t) {
  const out = [];
  for (const c of clips.value) {
    if (c.recording || t < c.t || t >= c.t + duration(c)) continue;
    if (!operatesAt(layerId, t, c.y + CLIP_HEIGHT / 2)) continue;
    out.push({ voice: c.id, data: sampleAt(c, Math.min(c.length - 1, Math.floor((t - c.t) * c.rate))), dim: c.dim });
  }
  return out;
}

function begin(id) {
  const ctx = audioContext();
  ctx.resume(); // Space is a user gesture: a context nothing has started yet can start here
  const run = { start: Math.round(ctx.currentTime * ctx.sampleRate), t0: time.peek(), cue: cue.peek(), k: 0, timer: 0 };
  run.timer = setInterval(() => {
    const now = ctx.currentTime * ctx.sampleRate;
    // Due frames, oldest first; after a stall of over half a second, skip ahead instead.
    if (now - (run.start + run.k * HOP) > ctx.sampleRate / 2) run.k = Math.floor((now - run.start) / HOP);
    while (run.start + run.k * HOP <= now) {
      const start = run.start + run.k * HOP;
      for (const f of framesAt(id, run.t0 + (run.k * HOP) / ctx.sampleRate))
        emit(id, { kind: 'latent', data: f.data, dim: f.dim, rate: ctx.sampleRate / HOP, start, voice: f.voice });
      run.k++;
    }
  }, TICK_MS);
  runs.set(id, run);
}

function end(id) {
  clearInterval(runs.get(id)?.timer);
  runs.delete(id);
}

// A run per latent layer that produces (playing, not armed); a seek restarts it.
const stopEffect = effect(() => {
  playing.value;
  const c = cue.value;
  const want = new Set(stack.value.filter((l) => l.type === 'latent' && producedKind(l)).map((l) => l.id));
  for (const [id, run] of [...runs]) if (!want.has(id) || run.cue !== c) end(id);
  for (const id of want) if (!runs.has(id)) begin(id);
});

export function dispose() {
  stopEffect();
  for (const id of [...runs.keys()]) end(id);
}
