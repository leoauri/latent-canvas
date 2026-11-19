// Clips: sequences of latent vectors sampled over time, each at its own sample rate.
import { persist } from '@live/runtime';
import * as db from '../../lib/db.js';
import { shared } from '../../net/shared.js';
import * as blobs from '../../net/blobs.js';

export const CLIP_HEIGHT = 10; // px, independent of zoom

/**
 * @typedef {object} Clip
 * @property {string} id
 * @property {number} t       start time in seconds
 * @property {number} y       world y of the top edge, px
 * @property {number} rate    samples per second (per clip)
 * @property {number} dim     latent dimensionality
 * @property {number} length  number of samples
 * @property {Float32Array} data  length * dim values, sample-major: data[i * dim + d]
 * @property {boolean} [recording]  still being recorded (app/stack/recorder.js): not saved yet
 */

/** @type {import('@preact/signals').Signal<Clip[]>} draw order = array order (last on top) */
export const clips = persist('timeline.clips', []);
export const selectedId = persist('timeline.selectedId', null);

// Shared with the session (net/shared.js): a clip's metadata goes into the document, its vectors
// into the blob store (net/blobs.js) as `dataHash`, fetched from peers when missing. A clip is local
// until its vectors are stored (while recording, and briefly after).
const hashes = persist('timeline.clipHashes', () => new WeakMap()); // Float32Array -> blob hash
const decoded = persist('timeline.clipData', () => new Map()); // blob hash -> Float32Array
const bytesOf = (f) => new Uint8Array(f.buffer, f.byteOffset, f.byteLength);

const storing = new WeakSet();
async function storeData(c) {
  if (hashes.value.has(c.data) || storing.has(c.data)) return;
  storing.add(c.data);
  const hash = await blobs.put(bytesOf(c.data), { name: `clip ${c.id}.f32`, type: 'application/x-redaw-latents' });
  hashes.value.set(c.data, hash);
  decoded.value.set(hash, c.data);
  clips.value = [...clips.value]; // now shareable: let the binding write it
}

async function loadData(hash, name) {
  if (decoded.value.has(hash)) return decoded.value.get(hash);
  const blob = (await blobs.get(hash)) ?? (await blobs.ensure(hash, { name }));
  const data = new Float32Array(await blob.arrayBuffer());
  hashes.value.set(data, hash);
  decoded.value.set(hash, data);
  return data;
}

const unbind = [
  shared('timeline.clips', clips, {
    kind: 'list',
    label: 'edit clips',
    keepLocal: (c) => c.recording || !hashes.value.has(c.data),
    valid: (c) =>
      ['t', 'y'].every((f) => Number.isFinite(c[f])) &&
      c.rate > 0 && Number.isFinite(c.rate) &&
      Number.isInteger(c.dim) && c.dim > 0 && c.dim <= 4096 &&
      Number.isInteger(c.length) && c.length >= 0 &&
      typeof c.dataHash === 'string',
    encode: ({ data, recording, ...m }) => ({ ...m, dataHash: hashes.value.get(data) }),
    decode: ({ dataHash, ...m }, prev) => {
      if (!dataHash) return null;
      if (prev && hashes.value.get(prev.data) === dataHash) return { ...m, data: prev.data };
      if (decoded.value.has(dataHash)) return { ...m, data: decoded.value.get(dataHash) };
      return loadData(dataHash, `clip ${m.id}.f32`).then((data) => ({ ...m, data }));
    },
    // The first session adopts the clips stored before sessions existed (kv + IndexedDB blobs).
    seedFrom: async () => {
      const meta = (await db.get('kv', 'timeline.clips')) ?? [];
      const out = [];
      for (const m of meta) {
        const data = await db.get('blobs', m.id);
        if (data) out.push({ ...m, data });
      }
      return out;
    },
  }),
  clips.subscribe((list) => list.forEach((c) => !c.recording && c.data && !hashes.value.has(c.data) && storeData(c).catch((e) => console.warn('clips: storing data failed', e)))),
  db.sync(selectedId, 'timeline.selectedId'),
];
export function dispose() {
  unbind.forEach((f) => f());
}

export const duration = (c) => c.length / c.rate;
export const sampleAt = (c, i) => c.data.subarray(i * c.dim, (i + 1) * c.dim);

export function addClip(clip) {
  clips.value = [...clips.value, clip];
}
export function updateClip(id, patch) {
  clips.value = clips.value.map((c) => (c.id === id ? { ...c, ...patch } : c));
}
export function removeClip(id) {
  clips.value = clips.value.filter((c) => c.id !== id);
  if (selectedId.value === id) selectedId.value = null;
}
export function bringToFront(id) {
  const list = clips.value;
  const i = list.findIndex((c) => c.id === id);
  if (i === -1 || i === list.length - 1) return;
  clips.value = [...list.slice(0, i), ...list.slice(i + 1), list[i]];
}
