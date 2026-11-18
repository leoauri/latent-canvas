// Clips: sequences of latent vectors sampled over time, each at its own sample rate.
import { persist } from '@live/runtime';
import * as db from '../../lib/db.js';

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

// Metadata goes to kv as one record; each clip's vectors are a separate blob, written once.
const savedBlobs = persist('timeline.savedBlobs', () => new Map()); // clip id -> data saved
const unbind = [
  db.sync(clips, 'timeline.clips', {
    hydrate: async (meta) => {
      const out = [];
      for (const m of meta) {
        const data = await db.get('blobs', m.id);
        if (!data) continue;
        savedBlobs.value.set(m.id, data);
        out.push({ ...m, data });
      }
      return out;
    },
    write: async (all) => {
      const list = all.filter((c) => !c.recording);
      const saved = savedBlobs.value;
      const ids = new Set(list.map((c) => c.id));
      for (const c of list)
        if (saved.get(c.id) !== c.data) {
          await db.put('blobs', c.id, c.data);
          saved.set(c.id, c.data);
        }
      await db.put('kv', 'timeline.clips', list.map(({ data, ...m }) => m));
      for (const id of [...saved.keys()])
        if (!ids.has(id)) {
          saved.delete(id);
          await db.del('blobs', id);
        }
    },
  }),
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
