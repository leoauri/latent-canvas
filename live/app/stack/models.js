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
// A model is dropped on an operator layer as a folder (its anira config, model file and optional
// meta): the files are stored in IndexedDB and recorded on the layer as `model`, and the model
// runs on anira (lib/streamModel.js) for as long as the layer has it.
import { effect } from '@preact/signals';
import { persist } from '@live/runtime';
import * as db from '../../lib/db.js';
import { audioContext, inputs } from '../../lib/audio.js';
import { createStreamModel, describeModel } from '../../lib/streamModel.js';
import { createTap, createMixer } from '../../lib/audioBlocks.js';
import { stack, updateStackLayer, stackLayerById } from './stack.js';
import { playing } from '../timeline/Playhead.jsx';

/**
 * @typedef {object} ModelRef  stored on an operator layer as `model`
 * @property {string} name     the folder's (or config's) name
 * @property {string[]} files  file names, each a blob at fileKey(layerId, name)
 * @property {number} added    ms timestamp
 *
 * @typedef {object} ModelRuntime
 * @property {'loading' | 'ready' | 'error'} status
 * @property {string} [error]
 * @property {ModelRef} ref     the ref this runtime was built for
 * @property {object} [model]   lib/streamModel.js createStreamModel result
 *
 * @typedef {{ kind: 'audio', data: Float32Array, start: number, voice: string }
 *   | { kind: 'latent', data: Float32Array, dim: number, rate: number, start: number, voice: string, missed?: boolean }} StreamMsg
 *   `start`: the context frame this unit belongs to. `voice`: which of the stream's parallel
 *   voices it belongs to (a clip, an input); a model keeps a separate state per voice.
 *
 * @typedef {object} Link  what reaches a consumer layer
 * @property {string|null} sourceId  the producer behind it
 * @property {'audio'|'latent'|null} kind
 * @property {string|null} error     why it does not take that stream
 */

const AUDIO_BLOCK = 1024; // samples per block an audio-in layer streams
const VOICE_IDLE_MS = 250; // a voice that sent nothing this long has ended: its model voice is freed

const fileKey = (layerId, name) => `model:${layerId}:${name}`;

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
    const rt = runtimes.value[l.id];
    return rt?.status === 'ready' ? rt.model.output.kind : null;
  }
  // Armed, it records what reaches it and lets it pass; else it plays its clips.
  if (l.type === 'latent') return playing.value && !l.armed ? 'latent' : null;
  return null;
}
/** The nearest layer behind `l` that makes a stream, or null. */
export function producerBehind(l) {
  for (let i = stack.value.indexOf(l) - 1; i >= 0; i--) if (producedKind(stack.value[i])) return stack.value[i];
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
  const { configName } = await describeModel(files); // refuse a drop without a config early
  const l = stackLayerById(layerId);
  if (!l || l.type !== 'operator') throw new Error('models go on operator layers');
  for (const [n, f] of files) await db.put('blobs', fileKey(layerId, n), f);
  const old = l.model;
  updateStackLayer(layerId, { model: { name: name ?? configName.replace(/\.(anira|model)\.json$/i, ''), files: [...files.keys()], added: Date.now() } });
  if (old) for (const n of old.files) if (!files.has(n)) db.del('blobs', fileKey(layerId, n));
}

export function detachModel(layerId) {
  const l = stackLayerById(layerId);
  if (!l?.model) return;
  for (const n of l.model.files) db.del('blobs', fileKey(layerId, n));
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
  if (rt && !stackLayerById(id)) for (const n of rt.ref.files) db.del('blobs', fileKey(id, n));
}

async function startModel(l) {
  const ref = l.model;
  setIn(runtimes, l.id, { status: 'loading', ref });
  const current = () => runtimes.peek()[l.id]?.ref === ref;
  try {
    const files = new Map();
    for (const n of ref.files) {
      const f = await db.get('blobs', fileKey(l.id, n));
      if (!f) throw new Error(`model file ${n} is missing from storage; drop the model again`);
      files.set(n, f);
    }
    const model = await createStreamModel({ files, sampleRate: audioContext().sampleRate });
    if (!current()) return model.destroy();
    setIn(runtimes, l.id, { status: 'ready', ref, model });
  } catch (e) {
    console.warn(`model on layer ${l.name}:`, e);
    if (current()) setIn(runtimes, l.id, { status: 'error', ref, error: String(e?.message || e) });
  }
}

// Model runtimes follow the stack: start new models, stop removed or replaced ones.
const stopModels = effect(() => {
  const want = new Map(stack.value.filter((l) => l.type === 'operator' && l.model).map((l) => [l.id, l]));
  const rts = runtimes.peek();
  for (const id of Object.keys(rts)) if (!want.has(id) || rts[id].ref.added !== want.get(id).model.added) stopModel(id);
  for (const [id, l] of want) if (!runtimes.peek()[id]) startModel(l);
});

// ---- audio inputs as producers ---------------------------------------------------------

// Every open audio-in layer streams its input as blocks, through a tap on its source node.
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
    createTap(audioContext(), AUDIO_BLOCK, (data, start) => emit(id, { kind: 'audio', data, start, voice: `in:${id}` })).then((tap) => {
      if (t.destroyed) return tap.destroy();
      t.tap = tap;
      source.connect(tap.node);
    });
  }
});

// ---- consumers -------------------------------------------------------------------------

/** Re-blocks audio into units of `size` samples for fn(unit, start). */
function reblock(size, fn) {
  let buf = new Float32Array(size), n = 0, start = 0;
  return ({ data, start: s }) => {
    for (let i = 0; i < data.length; ) {
      if (n === 0) start = s + i;
      const k = Math.min(size - n, data.length - i);
      buf.set(data.subarray(i, i + k), n);
      n += k;
      i += k;
      if (n === size) {
        fn(buf, start);
        buf = new Float32Array(size);
        n = 0;
      }
    }
  };
}

/**
 * A model operator's input: one model voice per voice that reaches it (each stream decoded or
 * encoded on its own handler, in parallel), ended once that voice has sent nothing for a while.
 * `prepare(msg)` turns a message into units for the voice's push, or reports and returns null.
 */
function modelVoices(l, model, prepare) {
  const voices = new Map(); // voice -> { voice, feed, last }
  const reap = setInterval(() => {
    const now = performance.now();
    for (const [key, v] of voices) if (now - v.last > VOICE_IDLE_MS) (v.voice.end(), voices.delete(key));
  }, VOICE_IDLE_MS / 2);
  return {
    handler(msg) {
      let v = voices.get(msg.voice);
      if (!v) {
        const voice = model.voice((data, { missed, start }) =>
          emit(
            l.id,
            model.output.kind === 'audio'
              ? { kind: 'audio', data, start, voice: msg.voice }
              : { kind: 'latent', data, dim: model.output.channels, rate: model.rate, start, missed, voice: msg.voice },
          ),
        );
        v = { voice, feed: prepare((unit, start) => voice.push(unit, start)), last: 0 };
        voices.set(msg.voice, v);
      }
      v.last = performance.now();
      v.feed(msg);
    },
    stop() {
      clearInterval(reap);
      for (const v of voices.values()) v.voice.end();
      voices.clear();
    },
  };
}

/** What a consumer does with the stream reaching it: { handler, stop? } or { error }. */
function consumerOf(l, src, kind) {
  if (l.type === 'operator') {
    const model = runtimes.value[l.id]?.model;
    const want = model.input.kind;
    if (kind !== want) return { error: `the model takes ${want === 'audio' ? 'audio' : 'latents'}, but ${kind === 'audio' ? 'audio' : 'latents'} reach it from ${src.name}` };
    if (want === 'audio') return modelVoices(l, model, (push) => reblock(model.input.samples, push));
    const dim = runtimes.value[src.id]?.model?.output.channels;
    if (dim !== undefined && dim !== model.input.channels) return { error: `the model takes ${model.input.channels}-d latents, ${src.name} makes ${dim}-d` };
    // From clips the width is per clip: frames of another width are skipped, and reported.
    return modelVoices(l, model, (push) => (msg) => {
      if (msg.dim === model.input.channels) return void push(msg.data, msg.start);
      const text = `skipping ${msg.dim}-d frames from ${src.name}: the model takes ${model.input.channels}-d`;
      if (warnings.peek()[l.id] !== text) setIn(warnings, l.id, text);
    });
  }
  if (l.type === 'audio-out') {
    if (kind !== 'audio') return { error: `latents reach it from ${src.name}: put a decoder in between` };
    // Every voice is added into the mix at its own time.
    return { handler: (msg) => mixers.get(l.id)?.push(msg.data, msg.start) };
  }
  return null; // latent recording layers subscribe themselves (recorder.js)
}

// Audio output layers each have a mixer while the stack holds them.
const stopMixers = effect(() => {
  const ids = new Set(stack.value.filter((l) => l.type === 'audio-out').map((l) => l.id));
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

// Wire every consumer to the producer behind it.
const stopWiring = effect(() => {
  const next = {};
  for (const l of stack.value) {
    if (l.type !== 'operator' && l.type !== 'audio-out' && l.type !== 'latent') continue;
    if (l.type === 'operator' && runtimes.value[l.id]?.status !== 'ready') continue;
    const src = producerBehind(l);
    const kind = src ? producedKind(src) : null;
    next[l.id] = { sourceId: src?.id ?? null, kind, error: null };
    if (l.type === 'latent') continue;
    const sub = subs.get(l.id);
    // Rewire when the producer, or either side's model, changes.
    const key = src ? `${src.id}:${kind}:${runtimes.value[src.id]?.ref.added ?? ''}:${runtimes.value[l.id]?.ref.added ?? ''}` : null;
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
