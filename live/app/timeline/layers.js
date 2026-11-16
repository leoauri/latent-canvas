// Layers: rectangular regions over the timeline (time x vertical position), drawn above clips.
// Each layer gets a distinct colour and hatch angle at creation, so overlapping layers stay
// distinguishable: colours are spread by the golden angle, hatches cycle through 8 directions.
import { persist } from '@live/runtime';
import { selectedId as selectedClipId } from './clips.js';

export const MIN_LAYER_HEIGHT = 12; // on-screen px, at any zoom

/**
 * @typedef {object} Layer
 * @property {string} id
 * @property {string} name
 * @property {number} t     start time, seconds
 * @property {number} dur   duration, seconds
 * @property {number} y     world y of the top edge (px at vertical scale 1)
 * @property {number} h     height in world y units (scales with zoom, unlike clip lines)
 * @property {number} hue   OKLCH hue, degrees
 * @property {number} hatch hatch angle, degrees
 */

/** @type {import('@preact/signals').Signal<Layer[]>} draw order = array order (last on top) */
export const layers = persist('timeline.layers', []);
export const selectedLayerId = persist('timeline.selectedLayerId', null);
const created = persist('timeline.layerCount', 0);

const HATCHES = [45, 135, 0, 90, 22.5, 112.5, 67.5, 157.5];
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));

export function addLayer({ t, y, dur, h, name }) {
  const i = created.value++;
  const layer = {
    id: newId(),
    name: name ?? `Layer ${i + 1}`,
    t, y, dur, h,
    hue: (25 + i * 137.508) % 360,
    hatch: HATCHES[i % HATCHES.length],
  };
  layers.value = [...layers.value, layer];
  return layer;
}
export function updateLayer(id, patch) {
  layers.value = layers.value.map((l) => (l.id === id ? { ...l, ...patch } : l));
}
export function removeLayer(id) {
  layers.value = layers.value.filter((l) => l.id !== id);
  if (selectedLayerId.value === id) selectedLayerId.value = null;
}
export function bringLayerToFront(id) {
  const list = layers.value;
  const i = list.findIndex((l) => l.id === id);
  if (i === -1 || i === list.length - 1) return;
  layers.value = [...list.slice(0, i), ...list.slice(i + 1), list[i]];
}
/** Layer and clip selection are exclusive. */
export function selectLayer(id) {
  selectedLayerId.value = id;
  if (id) selectedClipId.value = null;
}

export const layerColor = (l) => `oklch(0.66 0.17 ${l.hue.toFixed(1)})`;

/** Layers containing the point (t seconds, y world px), bottom to top. */
export const layersAt = (t, y) =>
  layers.value.filter((l) => t >= l.t && t <= l.t + l.dur && y >= l.y && y <= l.y + l.h);
