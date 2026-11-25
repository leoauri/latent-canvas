// Streams through the layer stack, and the models on operator layers. A stream may carry several
// voices at once (one per clip under the playhead): models process each on its own, and an audio
// output layer sums them.
//
// Producers make a stream: an audio-in layer with an open input (audio), an operator layer
// whose model runs (audio or latent frames, by the model), and a latent layer while the transport
// plays and it is not armed (the latent frames of its clips under the playhead, latentPlayback.js). What reaches a layer is the stream of
// the nearest producer behind it; the layers in between (a latent recorder, an audio output)
// let it pass. Consumers: an operator's model, a latent recording layer (app/stack/recorder.js)
// and an audio output layer, which plays the audio reaching it.
//
// Principle: streams carry only real frames. A frame is data that something produced; absence is
// never encoded as a value. Nothing in the chain invents frames to stand for "no input": a zero
// vector (or any "silence" vector) is a point in latent space that a decoder will render, and what
// is silence differs per model. The start and end of a voice are events (its first frame; an `end`
// message), not values. A layer that wants to sound on after its input ended (an echo ringing
// out) produces those frames itself, on its own clock (a layer function's tick), and decides
// when it is done. A frame that arrives late is only late: it never means the stream ended.
//
// A model is dropped on an operator layer as a folder (its anira config, model file and optional
// meta): the files go into the blob store (net/blobs.js) and are recorded on the layer as `model`
// by content hash, so peers in the session fetch them from whoever has them; the model runs on
// anira (lib/streamModel.js) for as long as the layer has it.
//
// To encode or decode a whole buffer (not live), use renderOffline(layerId, data): it runs as fast as
// the model goes and waits for every frame, where pushing into a live voice faster than real time
// loses frames (late units are popped as zeros).
import { effect } from '@preact/signals';
import { persist } from '@live/runtime';
import * as db from '../../lib/db.js';
import * as blobs from '../../net/blobs.js';
import { audioContext, inputs } from '../../lib/audio.js';
import { engineOn } from '../../lib/engine.js';
import { createStreamModel, describeModel } from '../../lib/streamModel.js';
import { createTap, createMixer } from '../../lib/audioBlocks.js';
import { stack, updateStackLayer, stackLayerById, LAYER_TYPES } from './stack.js';
import { playing, inputPointAt, setOutputDelay } from '../timeline/Playhead.jsx';
import { operatesAt } from '../timeline/layers.js';
import { runLayer, tickLayer, hasTick } from './layerFunc.js';
import { clips } from '../timeline/clips.js';

/**
 * @typedef {object} ModelRef  stored on an operator layer as `model`
 * @property {string} name     the folder's (or config's) name
 * @property {string[]} files  file names
 * @property {Record<string, string>} [hashes]  file name -> blob hash (net/blobs.js); refs from
 *   before the blob store have none, their files are in IndexedDB at fileKey(layerId, name)
 * @property {number} added    ms timestamp
 *
 * @typedef {object} ModelRuntime
 * @property {'loading' | 'ready' | 'error'} status
 * @property {string} [error]
 * @property {string} [detail]  while loading: e.g. fetching files from peers
 * @property {ModelRef} ref     the ref this runtime was built for
 * @property {object} [model]   lib/streamModel.js createStreamModel result
 *
 * @typedef {{ kind: 'audio', data: Float32Array, start: number, voice: string }
 *   | { kind: 'latent', data: Float32Array, dim: number, rate: number, start: number, voice: string, missed?: boolean }
 *   | { kind: 'end', voice: string, start: number }
 *   | { kind: 'flush', voices: string[] }} StreamMsg
 *   `start`: the context frame this unit belongs to. `voice`: which of the stream's parallel
 *   voices it belongs to (a clip, an input); a model keeps a separate state per voice.
 *   `end`: that voice's stream ended at `start` (its clip ran out, left the masks, its input stopped):
 *   what is on its way still plays out, and each layer passes the end on after its own last frame
 *   of the voice. A voice's frames after its end start it again.
 *   `flush`: those voices were cut off (a seek or stop): drop what is still on its way for them.
 *   Optional `t` (timeline seconds) and `y` (world y): where on the timeline a unit comes from (clip
 *   playback; live input enters at the playhead, mid-view; models' outputs keep their input's). An operator processes only units inside its
 *   masks (or without a position) and passes the rest on as they are, as it does units its model
 *   does not take; consumers ignore units of a kind they do not take. An audio-in layer sends
 *   only while the input point is inside its masks; an audio output plays only units inside its.
 *
 * @typedef {object} Link  what reaches a consumer layer
 * @property {string|null} sourceId  the producer behind it
 * @property {'audio'|'latent'|null} kind
 * @property {string|null} error     why it does not take that stream
 */

const AUDIO_BLOCK = 1024; // samples per block an audio-in layer streams
// A model voice whose producer sent nothing this long and no `end` (audio input, which has no end to
// announce) is ended as if it had been, so its model voice is freed.
const VOICE_IDLE_MS = 250;
const RING_MAX_S = 60; // a layer function's ring-out is ended after this long, in case tick never returns none

const fileKey = (layerId, name) => `model:${layerId}:${name}`;
/** An operator without a model but with a layer function: it transforms the latents reaching it. */
const isFuncOperator = (l) => l.type === 'operator' && !l.model && !!l.func;

/** @type {import('@preact/signals').Signal<Record<string, ModelRuntime>>} by operator layer id */
export const runtimes = persist('models.runtimes', {});
/** @type {import('@preact/signals').Signal<Record<string, Link>>} by consumer layer id */
export const links = persist('models.links', {});
/** @type {import('@preact/signals').Signal<Record<string, string>>} stream problems found while running, by consumer layer id */
export const warnings = persist('models.warnings', {});
const listeners = persist('models.listeners', () => new Map()).value; // producer id -> Set<fn>
const taps = persist('models.taps', () => new Map()).value; // audio-in id -> { source, tap }
const mixers = persist('models.mixers', () => new Map()).value; // audio-out id -> mixer
const subs = persist('models.subs', () => new Map()).value; // consumer id -> { sourceId, unsub }

// ---- the stream bus --------------------------------------------------------------------

/** Subscribe to the stream a producer layer makes: fn(StreamMsg). */
export function subscribe(producerId, fn) {
  if (!listeners.has(producerId)) listeners.set(producerId, new Set());
  listeners.get(producerId).add(fn);
  return () => listeners.get(producerId)?.delete(fn);
}
export function emit(producerId, msg) {
  const fns = listeners.get(producerId);
  if (fns) for (const fn of fns) fn(msg);
}

/** The kind of stream layer `l` makes, or null if it makes none (now). */
export function producedKind(l) {
  if (l.type === 'audio-in') return inputs.value[l.id]?.status === 'open' ? 'audio' : null;
  if (l.type === 'operator') {
    if (isFuncOperator(l)) {
      const src = producerBehind(l);
      return src && producedKind(src) === 'latent' ? 'latent' : null;
    }
    const rt = runtimes.value[l.id];
    return rt?.status === 'ready' ? rt.model.output.kind : null;
  }
  // A latent layer sends its clips while playing, and with pass-through on (the default) also the
  // latents reaching it. Recording (armed) is separate: it records what reaches it either way.
  if (l.type === 'latent') {
    if (playing.value) return 'latent';
    if (l.passThrough === false) return null;
    const src = producerBehind(l);
    return src && producedKind(src) === 'latent' ? 'latent' : null;
  }
  return null;
}
/**
 * The nearest layer behind `l` that makes a stream, or null. Layers that make none let streams
 * pass, except a latent layer with pass-through off: nothing from behind it gets through.
 */
export function producerBehind(l) {
  for (let i = stack.value.indexOf(l) - 1; i >= 0; i--) {
    const s = stack.value[i];
    if (producedKind(s)) return s;
    if (s.type === 'latent' && s.passThrough === false) return null;
  }
  return null;
}

// ---- model files -----------------------------------------------------------------------

/** Reads a drop (a folder or loose files) into Map<name, File> and a name for the model. */
export async function readDrop(dataTransfer) {
  // Entries must be taken synchronously, inside the drop event.
  const entries = [...dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  const files = new Map();
  let folder = null;
  const fileOf = (entry) => new Promise((res, rej) => entry.file(res, rej));
  const readAll = async (dir) => {
    const reader = dir.createReader();
    const out = [];
    for (let batch; (batch = await new Promise((res, rej) => reader.readEntries(res, rej))).length; ) out.push(...batch);
    return out;
  };
  for (const e of entries) {
    if (e.isFile) files.set(e.name, await fileOf(e));
    else if (e.isDirectory) {
      folder ??= e.name;
      for (const c of await readAll(e)) if (c.isFile) files.set(c.name, await fileOf(c)); // the folder's own files only
    }
  }
  if (!entries.length) for (const f of dataTransfer.files) files.set(f.name, f);
  return { files, name: folder };
}

/** Stores dropped model files on an operator layer (replacing its model) and starts it. */
export async function attachModel(layerId, files, name) {
  const { configName, meta } = await describeModel(files); // refuse a drop without a config early
  const l = stackLayerById(layerId);
  if (!l || l.type !== 'operator') throw new Error('models go on operator layers');
  const hashes = {};
  for (const [n, f] of files) hashes[n] = await blobs.put(f, { name: n, type: f.type });
  const old = l.model;
  const modelName = (typeof meta.model === 'string' && meta.model.trim()) || name || configName.replace(/\.(anira|model)\.json$/i, '');
  // Not named by the user: the type's default label, blank, or the name the previous model gave it.
  const unnamed = [LAYER_TYPES.operator.label, '', l.model?.name].includes(l.name.trim());
  updateStackLayer(layerId, { ...(unnamed && { name: modelName }), model: { name: modelName, files: [...files.keys()], hashes, added: Date.now() } });
  if (old) dropLegacyFiles(layerId, old);
}

/** Deletes a pre-blob-store ref's files. (Blobs stay: the asset browser cleans up unused ones.) */
function dropLegacyFiles(layerId, ref) {
  if (!ref.hashes) for (const n of ref.files) db.del('blobs', fileKey(layerId, n));
}

/**
 * Runs a whole buffer through the model on operator layer `layerId`, offline: as fast as the
 * inferences go, never missing a frame (lib/streamModel.js render). Encoder: context-rate mono
 * audio in, latent frames out (n * dim, at `rate` per second). Decoder: the reverse.
 * Resolves to { data, frames, missed, ms, dim, rate, sampleRate }.
 */
export async function renderOffline(layerId, data, opts) {
  const rt = runtimes.peek()[layerId];
  if (rt?.status !== 'ready') throw new Error(`no model is ready on layer ${layerId} (${rt?.status ?? 'none'})`);
  const { model } = rt;
  const r = await model.render(data, opts);
  return { ...r, dim: model.output.kind === 'latent' ? model.output.channels : model.input.channels, rate: model.rate, sampleRate: model.sampleRate };
}

export function detachModel(layerId) {
  const l = stackLayerById(layerId);
  if (!l?.model) return;
  dropLegacyFiles(layerId, l.model);
  updateStackLayer(layerId, { model: undefined });
}

// ---- model runtimes --------------------------------------------------------------------

const setIn = (sig, id, v) => {
  const next = { ...sig.peek() }; // peek: called from effects, which must not depend on it
  if (v) next[id] = v;
  else delete next[id];
  sig.value = next;
};

function stopModel(id) {
  const rt = runtimes.peek()[id];
  rt?.model?.destroy();
  setIn(runtimes, id, null);
  // The layer itself is gone: so are its model files.
  if (rt && !stackLayerById(id)) dropLegacyFiles(id, rt.ref);
}

async function startModel(l) {
  const ref = l.model;
  setIn(runtimes, l.id, { status: 'loading', ref });
  const current = () => runtimes.peek()[l.id]?.ref === ref;
  try {
    const files = new Map();
    for (const n of ref.files) {
      const hash = ref.hashes?.[n];
      let f = hash ? await blobs.get(hash) : await db.get('blobs', fileKey(l.id, n));
      if (!f && hash) {
        if (current()) setIn(runtimes, l.id, { status: 'loading', ref, detail: `fetching ${n} from peers`, hash });
        f = await blobs.ensure(hash, { name: n });
      }
      if (!f) throw new Error(`model file ${n} is missing from storage; drop the model again`);
      files.set(n, f);
    }
    // A ref from before the blob store: move its files there so peers can fetch them.
    if (!ref.hashes && current()) {
      const hashes = {};
      for (const [n, f] of files) hashes[n] = await blobs.put(f, { name: n, type: f.type });
      updateStackLayer(l.id, { model: { ...ref, hashes } });
      ref.hashes = hashes; // same `added`: the runtime carries on
    }
    const onStatus = (detail) => current() && setIn(runtimes, l.id, { status: 'loading', ref, detail });
    const model = await createStreamModel({ files, sampleRate: audioContext().sampleRate, onStatus });
    if (!current()) return model.destroy();
    setIn(runtimes, l.id, { status: 'ready', ref, model });
  } catch (e) {
    console.warn(`model on layer ${l.name}:`, e);
    if (current()) setIn(runtimes, l.id, { status: 'error', ref, error: String(e?.message || e) });
  }
}

// Model runtimes follow the stack: start new models, stop removed or replaced ones (all of them
// while the engine is off).
const stopModels = effect(() => {
  const want = new Map(!engineOn.value ? [] : stack.value.filter((l) => l.type === 'operator' && l.model).map((l) => [l.id, l]));
  const rts = runtimes.peek();
  for (const id of Object.keys(rts)) if (!want.has(id) || rts[id].ref.added !== want.get(id).model.added) stopModel(id);
  for (const [id, l] of want) if (!runtimes.peek()[id]) startModel(l);
});

// ---- audio inputs as producers ---------------------------------------------------------

// Every open audio-in layer streams its input as blocks, through a tap on its source node.
// Taps left by a previous version of this module run its code: rebuild them with this one's.
for (const [id, t] of taps) (t.destroyed = true, t.tap?.destroy(), taps.delete(id));
const stopTaps = effect(() => {
  const open = new Map(stack.value.filter((l) => l.type === 'audio-in' && inputs.value[l.id]?.status === 'open').map((l) => [l.id, inputs.value[l.id].source]));
  for (const [id, t] of taps)
    if (open.get(id) !== t.source) {
      t.destroyed = true;
      t.tap?.destroy(); // a closed input's source has disconnected already
      taps.delete(id);
    }
  for (const [id, source] of open) {
    if (taps.has(id)) continue;
    const t = { source, tap: null, destroyed: false };
    taps.set(id, t);
    createTap(audioContext(), AUDIO_BLOCK, (data, start) => {
      const at = inputPointAt(start, inputs.peek()[id]?.latency);
      if (operatesAt(id, at.t, at.y)) emit(id, { kind: 'audio', data, start, voice: `in:${id}`, ...at });
    }).then((tap) => {
      if (t.destroyed) return tap.destroy();
      t.tap = tap;
      source.connect(tap.node);
    });
  }
});

// ---- consumers -------------------------------------------------------------------------

/**
 * Resamples a latent stream at any rate onto a grid of one unit per `hop` context frames, as a
 * zero-order hold: a frame holds from its start for 1 / rate seconds, and every grid point in
 * that span gets it, for fn(frame, start), once the context clock reaches the point. A gap of
 * under a hop keeps the previous frame; a longer one restarts the grid at the next frame.
 */
function holdResample(hop, fn) {
  const ctx = audioContext();
  let next = null, held = null, until = 0;
  const run = (to) => {
    for (; held && next <= to && next < until; next += hop) fn(held, next);
  };
  const timer = setInterval(() => run(ctx.currentTime * ctx.sampleRate), 5);
  const feed = ({ data, start, rate }) => {
    if (next !== null && start - next <= hop) (until = Math.max(until, start)), run(start - 1);
    else next = start;
    held = data;
    until = start + ctx.sampleRate / rate;
    run(ctx.currentTime * ctx.sampleRate);
  };
  feed.stop = () => clearInterval(timer);
  feed.busy = () => held !== null && next < until;
  return feed;
}

/**
 * A model operator's input: one model voice per voice that reaches it (each stream decoded or
 * encoded on its own handler, in parallel). A voice ends on its `end` once its last units are out
 * of the model (or when it has sent nothing for VOICE_IDLE_MS), and the end goes on after them.
 * `prepare(msg)` turns a message into units for the voice's push, or reports and returns null.
 */
function modelVoices(l, model, prepare) {
  const sr = audioContext().sampleRate;
  const voices = new Map(); // voice -> { voice, feed, last, ending, outEnd, tOff, y }
  const close = (key, v) => {
    v.voice.end();
    v.feed.stop?.();
    voices.delete(key);
    const start = v.outEnd ?? v.ending?.start;
    if (start === undefined) return; // nothing came out: nothing to end
    emit(l.id, { kind: 'end', voice: key, start, ...(v.tOff !== undefined && { t: start / sr + v.tOff, y: v.y }) });
  };
  const drained = (v) => !v.feed.busy?.() && !v.voice.inFlight?.();
  const settle = setInterval(() => {
    const now = performance.now();
    for (const [key, v] of voices) if (drained(v) && (v.ending || now - v.last > VOICE_IDLE_MS)) close(key, v);
  }, 10);
  return {
    handler(msg) {
      if (msg.kind === 'flush') {
        // Their pending outputs are dropped with the voices; the layers in front flush too.
        for (const key of msg.voices) voices.get(key)?.voice.end(), voices.get(key)?.feed.stop?.(), voices.delete(key);
        return emit(l.id, msg);
      }
      if (msg.kind === 'end') {
        const v = voices.get(msg.voice);
        if (!v) return emit(l.id, msg); // a voice this model never took: its end passes, like its frames
        v.ending = msg; // closed once what was pushed is out (settle)
        return;
      }
      if (msg.kind !== model.input.kind || (msg.t !== undefined && !operatesAt(l.id, msg.t, msg.y))) return emit(l.id, msg);
      let v = voices.get(msg.voice);
      if (v?.ending) close(msg.voice, v), (v = null); // frames after its end start it again
      if (!v) {
        const voice = model.voice((data, { missed, start }) => {
          v.outEnd = start + (model.output.kind === 'audio' ? data.length : sr / model.rate);
          const pos = v.tOff === undefined ? {} : { t: start / sr + v.tOff, y: v.y };
          emit(
            l.id,
            model.output.kind === 'audio'
              ? { kind: 'audio', data, start, voice: msg.voice, ...pos }
              : { kind: 'latent', data, dim: model.output.channels, rate: model.rate, start, missed, voice: msg.voice, ...pos },
          );
        });
        v = { voice, feed: prepare((unit, start) => voice.push(unit, start)), last: 0 };
        voices.set(msg.voice, v);
      }
      if (msg.t !== undefined) (v.tOff = msg.t - msg.start / sr), (v.y = msg.y);
      v.last = performance.now();
      v.feed(msg);
    },
    stop() {
      clearInterval(settle);
      for (const v of voices.values()) v.voice.end(), v.feed.stop?.();
      voices.clear();
    },
  };
}

/** What a consumer does with the stream reaching it: { handler, stop? } or { error }. */
function consumerOf(l, src, kind) {
  if (l.type === 'operator' && isFuncOperator(l)) {
    // Layer function on latents. transform(params, ctx) gets each latent frame inside the layer's
    // masks, ctx = { msg, state, sampleRate, clip } (clip: the clip the voice plays, voice id =
    // clip id, so a function knows where its clip starts and ends), and returns the messages to
    // send on. It only ever sees frames a producer sent: nothing is made up for it (see the
    // principle at the top). When a voice ends:
    // - without tick: its state is dropped and the `end` passes on at once;
    // - with tick(params, ctx): the function rings out. tick is called once per frame of the voice's
    //   grid after its end, ctx = { voice, at, state, sampleRate, clip }, where `at` = { voice,
    //   start, rate, dim, t?, y? } places the frame due (spread it into a frame you return:
    //   { kind: 'latent', ...ctx.at, data }). It returns the frames to send on; returning none
    //   ends the ring-out, and then the voice's `end` goes on. New frames of the voice stop it.
    // While the layer is bypassed everything passes on unchanged and a ring-out ends.
    const state = {};
    const seen = new Map(); // voice -> its last frame in, while transform has it and no end yet
    const ringing = new Map(); // voice -> { at, end, until }: the frame due next after its end
    const ctx = audioContext();
    const sr = ctx.sampleRate;
    const layer = () => stackLayerById(l.id) ?? l;
    const clipOf = (voice) => clips.peek().find((c) => c.id === voice);
    const report = (e, where) => {
      const text = `layer function${where}: ${e?.message || e}`;
      if (warnings.peek()[l.id] !== text) setIn(warnings, l.id, text);
    };
    const forget = (voice) => (seen.delete(voice), ringing.delete(voice), delete state[voice]);
    const timer = setInterval(() => {
      if (!ringing.size) return;
      const now = ctx.currentTime * sr;
      for (const [voice, r] of ringing) {
        while (ringing.get(voice) === r && now >= r.at.start) {
          let out = [];
          if (r.at.start > r.until) report(`${voice} rang out for over ${RING_MAX_S} s: ended`, ' tick');
          else if (!layer().bypass)
            try {
              out = [tickLayer(layer(), { voice, at: r.at, state, sampleRate: sr, clip: clipOf(voice) }) ?? []].flat();
            } catch (e) {
              report(e, ' tick');
            }
          if (!out.length) {
            forget(voice);
            emit(l.id, { ...r.end, start: r.at.start, ...(r.at.t !== undefined && { t: r.at.t }) });
            break;
          }
          for (const m of out) emit(l.id, m);
          const { start, t, rate } = r.at;
          r.at = { ...r.at, start: start + sr / rate, ...(t !== undefined && { t: t + 1 / rate }) };
        }
      }
    }, 5);
    return {
      handler: (msg) => {
        if (msg.kind === 'flush') {
          for (const v of msg.voices) forget(v);
          return emit(l.id, msg);
        }
        if (msg.kind === 'end') {
          const last = seen.get(msg.voice);
          if (!last || layer().bypass || !hasTick(layer())) return forget(msg.voice), emit(l.id, msg);
          seen.delete(msg.voice);
          const y = msg.y ?? last.y;
          const at = { voice: msg.voice, start: msg.start, rate: last.rate, dim: last.dim, ...(msg.t !== undefined && { t: msg.t }), ...(y !== undefined && { y }) };
          ringing.set(msg.voice, { at, end: msg, until: msg.start + RING_MAX_S * sr });
          return;
        }
        if (msg.kind !== 'latent' || layer().bypass || (msg.t !== undefined && !operatesAt(l.id, msg.t, msg.y))) return emit(l.id, msg);
        ringing.delete(msg.voice); // its input is back: the ring-out stops
        seen.set(msg.voice, msg);
        let out;
        try {
          out = runLayer(layer(), { msg, state, sampleRate: sr, clip: clipOf(msg.voice) });
        } catch (e) {
          report(e, '');
          out = msg;
        }
        for (const m of [out ?? []].flat()) emit(l.id, m);
      },
      stop: () => clearInterval(timer),
    };
  }
  if (l.type === 'operator') {
    const model = runtimes.value[l.id]?.model;
    const want = model.input.kind;
    if (kind !== want) return { error: `the model takes ${want === 'audio' ? 'audio' : 'latents'}, but ${kind === 'audio' ? 'audio' : 'latents'} reach it from ${src.name}` };
    // The model's voice re-blocks (and resamples) audio itself.
    if (want === 'audio') return modelVoices(l, model, (push) => (msg) => push(msg.data, msg.start));
    const dim = runtimes.value[src.id]?.model?.output.channels;
    if (dim !== undefined && dim !== model.input.channels) return { error: `the model takes ${model.input.channels}-d latents, ${src.name} makes ${dim}-d` };
    // From clips the width is per clip: frames of another width are skipped, and reported.
    return modelVoices(l, model, (push) => {
      const zoh = holdResample(model.hop, push);
      return (msg) => {
        if (msg.dim === model.input.channels) return zoh(msg);
        const text = `skipping ${msg.dim}-d frames from ${src.name}: the model takes ${model.input.channels}-d`;
        if (warnings.peek()[l.id] !== text) setIn(warnings, l.id, text);
      };
    });
  }
  if (l.type === 'audio-out') {
    if (kind !== 'audio') return { error: `latents reach it from ${src.name}: put a decoder in between` };
    // Every voice is added into the mix at its own time; only blocks from inside its masks.
    return {
      handler: (msg) => {
        if (msg.kind === 'flush') return mixers.get(l.id)?.flush();
        if (msg.kind === 'audio' && (msg.t === undefined || operatesAt(l.id, msg.t, msg.y))) mixers.get(l.id)?.push(msg.data, msg.start);
      },
    };
  }
  if (l.type === 'latent') {
    // Pass-through: the latents reaching it go on to the layers in front, beside its own clips
    // (latentPlayback.js). Recording subscribes by itself (recorder.js).
    if (kind !== 'latent' || l.passThrough === false) return null;
    return { handler: (msg) => emit(l.id, msg) };
  }
  return null;
}

// Audio output layers each have a mixer while the stack holds them and the engine runs.
const stopMixers = effect(() => {
  const ids = new Set(!engineOn.value ? [] : stack.value.filter((l) => l.type === 'audio-out').map((l) => l.id));
  for (const [id, p] of mixers) if (!ids.has(id)) (p.destroy?.(), mixers.delete(id));
  for (const id of ids)
    if (!mixers.has(id)) {
      const pending = { push() {}, stats: () => null, destroy() { this.destroyed = true; } };
      mixers.set(id, pending);
      createMixer(audioContext()).then((p) => (pending.destroyed ? p.destroy() : mixers.get(id) === pending && mixers.set(id, p)));
    }
});

/** An audio output layer's mixer: { late, early, blocks, sounding }, or null. */
export const mixerStats = (id) => mixers.get(id)?.stats() ?? null;
/** An audio output layer's mixer ({ push(data, start), flush() }), or null. */
export const mixerOf = (id) => mixers.get(id) ?? null;

setOutputDelay(() => {
  let d = 0;
  for (const [id, m] of mixers) if (links.peek()[id]?.kind === 'audio') d = Math.max(d, m.stats()?.delay ?? m.delay ?? 0);
  return d / audioContext().sampleRate;
});

// Handlers left by a previous version of this module run its code: rewire with this one's.
for (const [id, sub] of subs) (sub.unsub(), sub.stop?.(), subs.delete(id));

// Wire every consumer to the producer behind it.
const stopWiring = effect(() => {
  const next = {};
  for (const l of stack.value) {
    if (l.type !== 'operator' && l.type !== 'audio-out' && l.type !== 'latent') continue;
    if (l.type === 'operator' && !isFuncOperator(l) && runtimes.value[l.id]?.status !== 'ready') continue;
    const src = producerBehind(l);
    const kind = src ? producedKind(src) : null;
    next[l.id] = { sourceId: src?.id ?? null, kind, error: null };
    const sub = subs.get(l.id);
    // Rewire when the producer, either side's model, or a latent layer's pass-through changes.
    const key = src ? `${src.id}:${kind}:${runtimes.value[src.id]?.ref.added ?? ''}:${runtimes.value[l.id]?.ref.added ?? ''}:${l.passThrough !== false}:${isFuncOperator(l) ? l.funcUpdated ?? l.func : ''}` : null;
    if (sub?.key === key) {
      next[l.id].error = sub.error;
      continue;
    }
    sub?.unsub();
    sub?.stop?.();
    subs.delete(l.id);
    setIn(warnings, l.id, null);
    if (!src) continue;
    const c = consumerOf(l, src, kind);
    if (!c) continue;
    if (c.error) next[l.id].error = c.error;
    subs.set(l.id, { key, error: c.error ?? null, unsub: c.handler ? subscribe(src.id, c.handler) : () => {}, stop: c.stop });
  }
  for (const [id, sub] of subs) if (!next[id]) (sub.unsub(), sub.stop?.(), subs.delete(id));
  links.value = next;
});

export function dispose() {
  stopModels();
  stopTaps();
  stopMixers();
  stopWiring();
}
