// The layer stack: a back-to-front pipeline. Data enters at index 0 (back) and flows
// through each layer towards the user (last index = front).
import { persist } from '@live/runtime';
import * as db from '../../lib/db.js';
import { effect } from '@preact/signals';
import { clearMask, layers as maskList, masked } from '../timeline/layers.js';
import { shared } from '../../net/shared.js';
import { handle } from '../../net/session.js';

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
 * @property {string} [inputDevice]  audio-in: chosen input deviceId (lib/audio.js); empty = default
 * @property {import('./models.js').ModelRef} [model]  operator: the model it runs (app/stack/models.js)
 * @property {boolean} [armed]  latent: records the latent stream reaching it while playing (app/stack/recorder.js)
 * @property {boolean} [passThrough]  latent: false stops the latents reaching it going on to the layers in front (default on)
 * @property {boolean} [bypass]  layer-function operator: lets everything reaching it pass unchanged (live and in bakes)
 * Masks (app/timeline/layers.js, field layerId) limit where a layer operates.
 */

export const LAYER_TYPES = {
  'audio-in': { label: 'Audio input', glyph: '◖', hue: 220, io: 'mic / file → audio' },
  latent: { label: 'Latent recording', glyph: '▤', hue: 290, io: 'latent clips' },
  operator: { label: 'Operator', glyph: '⚙', hue: 50, io: 'audio ⇄ latent · drop a model' },
  'audio-out': { label: 'Audio output', glyph: '◗', hue: 150, io: 'audio → speakers' },
};

export const typeColor = (type) => `oklch(0.68 0.14 ${LAYER_TYPES[type].hue})`;
/** Per-layer colour: its type's hue, shifted so several layers of one type stay distinguishable. */
// Shared fields can hold whatever a peer's code wrote: fall back rather than throw while rendering.
export const stackLayerColor = (l) => {
  const hue = Number.isFinite(l.hue) ? l.hue : (LAYER_TYPES[l.type]?.hue ?? 0);
  return `oklch(0.68 0.14 ${hue.toFixed(1)})`;
};
const HUE_SHIFTS = [0, 35, -35, 70, -70];

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));

/** @type {import('@preact/signals').Signal<StackLayer[]>} back to front */
const initialStack = () => [{ id: newId(), type: 'latent', name: 'Latent recording' }];
export const stack = persist('stack.layers', initialStack);
/** The layer new masks are drawn onto. */
export const activeLayerId = persist('stack.activeLayerId', null);
/** Stack layer whose masks are highlighted on the canvas (hovering its card). */
export const highlightedLayerId = persist('stack.highlighted', null);
// The stack is shared with the session (net/shared.js); which device feeds an input, which chat
// wrote a function and what's armed stay per machine. The active layer is local UI state.
const unbind = [
  shared('stack.layers', stack, {
    kind: 'list',
    label: 'edit stack',
    local: ['inputDevice', 'funcChat', 'armed'],
    seedFrom: () => db.get('kv', 'stack.layers'),
    empty: initialStack,
    valid: (l) => typeof l.id === 'string' && !!LAYER_TYPES[l.type] && typeof l.name === 'string' && l.name.length < 1000,
  }),
  db.sync(activeLayerId, 'stack.activeLayerId'),
  orphanSweeper(),
];

// A peer can mask a layer while another removes it: the masks outlive their layer. Masks of layers
// that are gone from the document (not merely unreadable here) are removed, after a pause so a
// session switch or a sync in progress settles first. Peers doing this at once is harmless.
function orphanSweeper() {
  let timer = 0;
  const sweep = () => {
    const items = handle.peek()?.doc()?.state?.['stack.layers']?.items;
    if (!items) return;
    const gone = new Set([...maskList.peek().map((m) => m.layerId), ...Object.keys(masked.peek())].filter((id) => id && !items[id]));
    for (const id of gone) clearMask(id);
  };
  const off = effect(() => {
    stack.value;
    maskList.value;
    masked.value;
    clearTimeout(timer);
    timer = setTimeout(sweep, 1500);
  });
  return () => (off(), clearTimeout(timer));
}
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

/** What a layer's card says it does: its type's io, or the model it runs (`model`: its runtime's model, once loaded). */
export function layerIo(l, model) {
  if (l.type === 'latent') return '';
  if (l.type !== 'operator' || !l.model) return LAYER_TYPES[l.type].io;
  const kinds = model ? `${model.input.kind} → ${model.output.kind}` : 'loading';
  return `${kinds} · ${modelName(l, model)}`;
}

/** The model's name from its *.meta.json (`model`), else the name stored when it was dropped. */
export const modelName = (l, model) => (typeof model?.meta?.model === 'string' && model.meta.model.trim()) || l.model?.name || '';

/** Latent layers let the latents reaching them through (to the layers in front) unless this is off. */
export function togglePassThrough(id) {
  const l = stackLayerById(id);
  if (l?.type === 'latent') updateStackLayer(id, { passThrough: l.passThrough === false ? undefined : false });
}

/** Layer-function operators let everything pass unchanged while bypassed. */
export function toggleBypass(id) {
  const l = stackLayerById(id);
  if (l) updateStackLayer(id, { bypass: !l.bypass || undefined });
}

export function toggleArm(id) {
  const l = stackLayerById(id);
  if (l?.type === 'latent') updateStackLayer(id, { armed: !l.armed || undefined });
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
  clearMask(id);
  if (activeLayerId.value === id) activeLayerId.value = null;
}
