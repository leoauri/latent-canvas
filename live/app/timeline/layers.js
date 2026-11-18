// Masks: rectangular regions over the timeline (time x vertical position). Each belongs to a stack
// layer (app/stack/stack.js) and limits where that layer operates: the union of its masks.
// A layer without masks operates everywhere.
import { persist } from '@live/runtime';
import * as db from '../../lib/db.js';
import { selectedId as selectedClipId } from './clips.js';

export const MIN_LAYER_HEIGHT = 12; // on-screen px, at any zoom

/**
 * @typedef {object} Mask
 * @property {string} id
 * @property {string|null} layerId  stack layer this mask belongs to
 * @property {number} t     start time, seconds
 * @property {number} dur   duration, seconds
 * @property {number} y     world y of the top edge (px at vertical scale 1)
 * @property {number} h     height in world y units (scales with zoom, unlike clip lines)
 */

/** @type {import('@preact/signals').Signal<Mask[]>} */
export const layers = persist('timeline.layers', []);
export const selectedLayerId = persist('timeline.selectedLayerId', null);
const unbind = [db.sync(layers, 'timeline.layers'), db.sync(selectedLayerId, 'timeline.selectedLayerId')];
export function dispose() {
  unbind.forEach((f) => f());
}

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));

export function addLayer({ t, y, dur, h, layerId = null }) {
  const mask = { id: newId(), layerId, t, y, dur, h };
  layers.value = [...layers.value, mask];
  return mask;
}
export function updateLayer(id, patch) {
  layers.value = layers.value.map((l) => (l.id === id ? { ...l, ...patch } : l));
}
export function removeLayer(id) {
  layers.value = layers.value.filter((l) => l.id !== id);
  if (selectedLayerId.value === id) selectedLayerId.value = null;
}
/** Mask and clip selection are exclusive. */
export function selectLayer(id) {
  selectedLayerId.value = id;
  if (id) selectedClipId.value = null;
}

const contains = (m, t, y) => t >= m.t && t <= m.t + m.dur && y >= m.y && y <= m.y + m.h;
/** Masks containing the point (t seconds, y world px), in draw order. */
export const layersAt = (t, y) => layers.value.filter((m) => contains(m, t, y));
export const masksOf = (layerId) => layers.value.filter((m) => m.layerId === layerId);
/** Whether the stack layer operates at (t, y): inside one of its masks, or anywhere if it has none. */
export function operatesAt(layerId, t, y) {
  const own = masksOf(layerId);
  return !own.length || own.some((m) => contains(m, t, y));
}
