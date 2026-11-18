// The layer stack: a back-to-front pipeline. Data enters at index 0 (back) and flows
// through each layer towards the user (last index = front).
import { persist } from '@live/runtime';
import * as db from '../../lib/db.js';
import { layers as masks, removeLayer as removeMask } from '../timeline/layers.js';

/**
 * @typedef {'audio-in' | 'latent' | 'operator' | 'audio-out'} StackLayerType
 * @typedef {object} StackLayer
 * @property {string} id
 * @property {StackLayerType} type
 * @property {string} name
 * @property {number} [hue]  OKLCH hue; defaults to the type's
 * @property {string} [func]  layer function source (app/stack/layerFunc.js)
 * @property {Record<string, any>} [paramValues]  user-set parameter values
 * @property {number} [funcUpdated]  ms timestamp of the last function save
 * @property {string} [funcChat]  chat session that last saved the function
 * Masks (app/timeline/layers.js, field layerId) limit where a layer operates.
 */

export const LAYER_TYPES = {
  'audio-in': { label: 'Audio input', glyph: '◖', hue: 220, io: 'mic / file → audio' },
  latent: { label: 'Latent recording', glyph: '▤', hue: 290, io: 'latent clips' },
  operator: { label: 'Operator', glyph: '⚙', hue: 50, io: 'audio ⇄ latent · no model' },
  'audio-out': { label: 'Audio output', glyph: '◗', hue: 150, io: 'audio → speakers' },
};

export const typeColor = (type) => `oklch(0.68 0.14 ${LAYER_TYPES[type].hue})`;
/** Per-layer colour: its type's hue, shifted so several layers of one type stay distinguishable. */
export const stackLayerColor = (l) => `oklch(0.68 0.14 ${(l.hue ?? LAYER_TYPES[l.type].hue).toFixed(1)})`;
const HUE_SHIFTS = [0, 35, -35, 70, -70];

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));

/** @type {import('@preact/signals').Signal<StackLayer[]>} back to front */
export const stack = persist('stack.layers', () => [{ id: newId(), type: 'latent', name: 'Latent recording' }]);
/** The layer new masks are drawn onto. */
export const activeLayerId = persist('stack.activeLayerId', null);
/** Stack layer whose masks are highlighted on the canvas (hovering its card). */
export const highlightedLayerId = persist('stack.highlighted', null);
const unbind = [db.sync(stack, 'stack.layers'), db.sync(activeLayerId, 'stack.activeLayerId')];
export function dispose() {
  unbind.forEach((f) => f());
}

export const stackLayerById = (id) => stack.value.find((l) => l.id === id);
/** The active layer, falling back to the front layer. */
export const activeLayer = () => stackLayerById(activeLayerId.value) ?? stack.value.at(-1) ?? null;

export function insertLayer(type, index = stack.value.length) {
  const n = stack.value.filter((l) => l.type === type).length;
  const hue = (LAYER_TYPES[type].hue + HUE_SHIFTS[n % HUE_SHIFTS.length] + 360) % 360;
  const layer = { id: newId(), type, name: n ? `${LAYER_TYPES[type].label} ${n + 1}` : LAYER_TYPES[type].label, hue };
  const list = [...stack.value];
  list.splice(index, 0, layer);
  stack.value = list;
  return layer;
}

export function updateStackLayer(id, patch) {
  stack.value = stack.value.map((l) => (l.id === id ? { ...l, ...patch } : l));
}

/** Moves a layer to slot `index` (a gap position 0..length in the current list). */
export function moveLayer(id, index) {
  const list = [...stack.value];
  const from = list.findIndex((l) => l.id === id);
  if (from === -1) return;
  const [layer] = list.splice(from, 1);
  list.splice(index > from ? index - 1 : index, 0, layer);
  stack.value = list;
}

/** Removes the layer and its masks. */
export function removeStackLayer(id) {
  stack.value = stack.value.filter((l) => l.id !== id);
  masks.value.filter((m) => m.layerId === id).forEach((m) => removeMask(m.id));
  if (activeLayerId.value === id) activeLayerId.value = null;
}
