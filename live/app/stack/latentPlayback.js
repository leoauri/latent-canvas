// Latent playback: while the transport plays, every latent layer (armed or not) streams the
// latent frames of its clips under the playhead (app/stack/models.js routes them to the layers in
// front, a decoder say). Each clip sends its own samples at its own rate, each when the playhead
// reaches it, with `rate` set to the clip's: consumers resample as they need (a model holds them,
// models.js holdResample). A clip entered mid-sample (at the start, or after a seek) sends that
// sample at once.
// Every clip under the playhead inside the layer's masks (a layer without masks plays every clip)
// is a voice of the stream, identified by the clip's id: the layers in front process each on its
// own (a decoder decodes them in parallel) and an audio output sums them. Where there is no clip,
// nothing is sent.
// A voice ends with an `end` message (models.js StreamMsg) when its clip runs out, leaves the
// layer's masks, or is removed: the end of a stream is an event, never a run of zero frames.
// A seek or stop cuts every voice off with `flush` instead.
import { effect } from '@preact/signals';
import { persist } from '@live/runtime';
import { audioContext } from '../../lib/audio.js';
import { stack } from './stack.js';
import { emit } from './models.js';
import { playing, time, cue } from '../timeline/Playhead.jsx';
import { clips, CLIP_HEIGHT, duration, sampleAt } from '../timeline/clips.js';
import { operatesAt } from '../timeline/layers.js';
import { isBaked } from './prebake.js';

const TICK_MS = 5;
const MAX_LAG = 0.5; // seconds behind after a stall: skip ahead instead of catching up

/** layer id -> { start, t0, at, last, timer, voices, sounding } */
const runs = persist('latentPlayback.runs', () => new Map()).value;

function begin(id) {
  const ctx = audioContext();
  ctx.resume(); // Space is a user gesture: a context nothing has started yet can start here
  const sr = ctx.sampleRate;
  const run = { start: Math.round(ctx.currentTime * sr), t0: time.peek(), cue: cue.peek(), at: time.peek(), last: new Map(), timer: 0, voices: new Set(), sounding: new Set() };
  // sounding: voices that have had frames sent and no `end` yet.
  const frameAt = (ts) => run.start + Math.round((ts - run.t0) * sr);
  run.timer = setInterval(() => {
    const now = run.t0 + (ctx.currentTime * sr - run.start) / sr;
    if (now < run.at) return;
    if (now - run.at > MAX_LAG) (run.at = now), run.last.clear();
    const from = run.at;
    const alive = new Set(); // voices still sounding after this tick
    for (const c of clips.value) {
      if (c.recording || c.t + duration(c) <= from || c.t > now || isBaked(c.id)) continue;
      const y = c.y + CLIP_HEIGHT / 2;
      // From the sample under `from` (or the next after the last one sent), up to `now`.
      let i = Math.max(Math.floor((from - c.t) * c.rate), (run.last.get(c.id) ?? -1) + 1, 0);
      for (; i < c.length; i++) {
        const ts = Math.max(c.t + i / c.rate, from);
        if (ts > now) break;
        run.last.set(c.id, i);
        if (!operatesAt(id, ts, y)) {
          if (run.sounding.has(c.id)) endVoice(c.id, ts); // it left the masks
          continue;
        }
        run.voices.add(c.id);
        run.sounding.add(c.id);
        emit(id, { kind: 'latent', data: sampleAt(c, i), dim: c.dim, rate: c.rate, start: frameAt(ts), voice: c.id, t: ts, y });
      }
      // Its last sample is sent: it ends with the clip.
      if (i >= c.length && run.sounding.has(c.id)) endVoice(c.id, c.t + duration(c));
      if (run.sounding.has(c.id)) alive.add(c.id);
    }
    // A voice whose clip was removed, moved away or baked ends where the playhead is.
    for (const v of [...run.sounding]) if (!alive.has(v)) endVoice(v, now);
    run.at = now + 1e-9; // the next tick takes what comes after this one
  }, TICK_MS);
  function endVoice(voice, ts) {
    run.sounding.delete(voice);
    const c = clips.peek().find((x) => x.id === voice);
    emit(id, { kind: 'end', voice, start: frameAt(ts), t: ts, ...(c && { y: c.y + CLIP_HEIGHT / 2 }) });
  }
  runs.set(id, run);
}

/** Stops a run, and cuts its voices off downstream: what is still on its way is dropped. */
function end(id) {
  const run = runs.get(id);
  if (!run) return;
  clearInterval(run.timer);
  runs.delete(id);
  if (run.voices.size) emit(id, { kind: 'flush', voices: [...run.voices] });
}

// A run per latent layer while playing; a seek restarts it.
const stopEffect = effect(() => {
  playing.value;
  const c = cue.value;
  const want = new Set(playing.value ? stack.value.filter((l) => l.type === 'latent').map((l) => l.id) : []);
  for (const [id, run] of [...runs]) if (!want.has(id) || run.cue !== c) end(id);
  for (const id of want) if (!runs.has(id)) begin(id);
});

export function dispose() {
  stopEffect();
  for (const id of [...runs.keys()]) end(id);
}
