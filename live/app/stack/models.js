// Models on operator layers. Dropping an encoder (a folder with its anira config, model file and
// optional meta) on an operator layer stores the files in IndexedDB and records them on the layer
// as `model`. While the layer exists, an encoder runs for it (lib/encoder.js): audio from the
// nearest open audio-in layer behind it goes in, a stream of latent frames comes out, and
// onLatent(layerId, fn) hands those frames to whoever listens (the latent recorder).
import { effect } from '@preact/signals';
import { persist } from '@live/runtime';
import * as db from '../../lib/db.js';
import { audioContext, inputs } from '../../lib/audio.js';
import { createEncoder, createTap, describeModel } from '../../lib/encoder.js';
import { stack, updateStackLayer, stackLayerById } from './stack.js';

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
 * @property {object} [enc]     lib/encoder.js createEncoder result
 * @property {object} [tap]
 * @property {string|null} [sourceId]  the audio-in layer feeding it
 */

const fileKey = (layerId, name) => `model:${layerId}:${name}`;

/** @type {import('@preact/signals').Signal<Record<string, ModelRuntime>>} by operator layer id */
export const runtimes = persist('models.runtimes', {});
const listeners = persist('models.listeners', () => new Map()).value; // layerId -> Set<fn>
const nodes = persist('models.nodes', () => new Map()).value; // layerId -> { tap, source, starts }

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

/** Subscribe to a model layer's latent frames: fn(frame, { missed, block, start, rate, dim }). */
export function onLatent(layerId, fn) {
  if (!listeners.has(layerId)) listeners.set(layerId, new Set());
  listeners.get(layerId).add(fn);
  return () => listeners.get(layerId)?.delete(fn);
}

/** The nearest layer behind `index` matching `pred`, or null. */
export function behind(index, pred) {
  for (let i = index - 1; i >= 0; i--) if (pred(stack.value[i])) return stack.value[i];
  return null;
}
/** The audio-in layer feeding operator `l`: the nearest one behind it with an open input. */
export const audioSourceOf = (l) =>
  behind(stack.value.indexOf(l), (s) => s.type === 'audio-in' && inputs.value[s.id]?.status === 'open');

const setRuntime = (id, rt) => {
  const next = { ...runtimes.peek() }; // peek: called from the effect below, which must not depend on it
  if (rt) next[id] = rt;
  else delete next[id];
  runtimes.value = next;
};

function stop(id) {
  const n = nodes.get(id);
  if (n) {
    try {
      n.source?.disconnect(n.tap.node);
    } catch {}
    n.tap.destroy();
    nodes.delete(id);
  }
  const rt = runtimes.peek()[id];
  rt?.enc?.destroy();
  setRuntime(id, null);
  // The layer itself is gone: so are its model files.
  if (rt && !stackLayerById(id)) for (const n of rt.ref.files) db.del('blobs', fileKey(id, n));
}

async function start(l) {
  const ref = l.model;
  setRuntime(l.id, { status: 'loading', ref });
  const current = () => runtimes.peek()[l.id]?.ref === ref;
  try {
    const files = new Map();
    for (const n of ref.files) {
      const f = await db.get('blobs', fileKey(l.id, n));
      if (!f) throw new Error(`model file ${n} is missing from storage; drop the model again`);
      files.set(n, f);
    }
    const ctx = audioContext();
    const starts = []; // context frame of each pushed block's first sample, until its frame pops
    const enc = await createEncoder({
      files,
      sampleRate: ctx.sampleRate,
      onFrame: (frame, info) => {
        const start = starts.shift();
        const fns = listeners.get(l.id);
        if (fns) for (const fn of fns) fn(frame, { ...info, start, rate: enc.rate, dim: enc.dim });
      },
    });
    if (!current()) return enc.destroy();
    const tap = await createTap(ctx, enc.hop, (block, startFrame) => {
      starts.push(startFrame);
      if (!enc.push(block)) starts.pop();
    });
    if (!current()) return (tap.destroy(), enc.destroy());
    nodes.set(l.id, { tap, source: null, starts });
    setRuntime(l.id, { status: 'ready', ref, enc, sourceId: null });
    wire();
  } catch (e) {
    console.warn(`model on layer ${l.name}:`, e);
    if (current()) setRuntime(l.id, { status: 'error', ref, error: String(e?.message || e) });
  }
}

/** Connects every running encoder's tap to its audio source. */
function wire() {
  for (const [id, n] of nodes) {
    const l = stackLayerById(id);
    const src = l && audioSourceOf(l);
    const node = src ? inputs.value[src.id].source : null;
    if (node === n.source) continue;
    try {
      n.source?.disconnect(n.tap.node);
    } catch {} // a closed input already disconnected everything
    if (node) node.connect(n.tap.node);
    n.source = node;
    const rt = runtimes.peek()[id];
    if (rt) setRuntime(id, { ...rt, sourceId: src?.id ?? null });
  }
}

// Keep runtimes in step with the stack: start new models, stop removed ones, rewire sources.
const stopEffect = effect(() => {
  const layers = stack.value;
  inputs.value;
  const rts = runtimes.peek();
  const want = new Map(layers.filter((l) => l.type === 'operator' && l.model).map((l) => [l.id, l]));
  for (const id of Object.keys(rts)) if (!want.has(id) || rts[id].ref.added !== want.get(id).model.added) stop(id);
  for (const [id, l] of want) if (!runtimes.peek()[id]) start(l);
  wire();
});

export function dispose() {
  stopEffect();
}
