// Masks: where a stack layer (app/stack/stack.js) operates, over the timeline (time x vertical position).
// A layer is either unmasked (operates everywhere) or masked: then it operates inside the union of its
// rectangles, which may be empty (operates nowhere). Areas are added and cut with addMaskArea /
// cutMaskArea; a layer's rectangles never overlap.
import { persist } from '@live/runtime';
import * as db from '../../lib/db.js';

export const MIN_LAYER_HEIGHT = 12; // on-screen px, at any zoom
/** Extent standing in for infinity (JSON can't store Infinity): stripes span -BIG..BIG. */
export const BIG = 1e9;

/**
 * @typedef {object} Mask
 * @property {string} id
 * @property {string|null} layerId  stack layer this rectangle belongs to
 * @property {number} t     start time, seconds
 * @property {number} dur   duration, seconds
 * @property {number} y     world y of the top edge (px at vertical scale 1)
 * @property {number} h     height in world y units (scales with zoom, unlike clip lines)
 */

/** @type {import('@preact/signals').Signal<Mask[]>} */
export const layers = persist('timeline.layers', []);
/** layerId -> true for masked layers. */
export const masked = persist('timeline.masked', () => Object.fromEntries(layers.value.map((m) => [m.layerId, true])));
/** Open mask toolbar: { layerId, x, y } (viewport px of its left-middle anchor), or null. */
export const maskTools = persist('timeline.maskTools', null);
/** Selected mask tool ('rect' | 'hstripe' | 'vstripe') while the toolbar is open, or null. */
export const maskTool = persist('timeline.maskToolActive', null);
export function openMaskTools(layerId, x, y) {
  maskTools.value = { layerId, x, y };
  maskTool.value = null;
}
export function closeMaskTools() {
  maskTools.value = null;
  maskTool.value = null;
}
const unbind = [db.sync(layers, 'timeline.layers'), db.sync(masked, 'timeline.masked')];
export function dispose() {
  unbind.forEach((f) => f());
}

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
const EVERYWHERE = { t: -BIG, dur: 2 * BIG, y: -BIG, h: 2 * BIG };

/** a minus b: up to four rectangles. */
function subtract(a, b) {
  const ax1 = a.t + a.dur, ay1 = a.y + a.h, bx1 = b.t + b.dur, by1 = b.y + b.h;
  if (b.t >= ax1 || bx1 <= a.t || b.y >= ay1 || by1 <= a.y) return [a];
  const out = [];
  const piece = (t, t1, y, y1) => t1 > t && y1 > y && out.push({ ...a, id: newId(), t, dur: t1 - t, y, h: y1 - y });
  piece(a.t, ax1, a.y, Math.max(a.y, b.y)); // above
  piece(a.t, ax1, Math.min(ay1, by1), ay1); // below
  const y0 = Math.max(a.y, b.y), y1 = Math.min(ay1, by1);
  piece(a.t, Math.max(a.t, b.t), y0, y1); // left
  piece(Math.min(ax1, bx1), ax1, y0, y1); // right
  return out;
}

export const masksOf = (layerId) => layers.value.filter((m) => m.layerId === layerId);
export const isMasked = (layerId) => !!masked.value[layerId];

function setRects(layerId, rects) {
  layers.value = [...layers.value.filter((m) => m.layerId !== layerId), ...rects.map((r) => ({ ...r, layerId }))];
  if (!masked.value[layerId]) masked.value = { ...masked.value, [layerId]: true };
}

/** Adds the area {t, dur, y, h} to the layer's mask (masking it if it was unmasked). */
export function addMaskArea(layerId, area) {
  const base = isMasked(layerId) ? masksOf(layerId) : [];
  setRects(layerId, [...base.flatMap((m) => subtract(m, area)), { ...area, id: newId() }]);
}
/** Removes the area from where the layer operates; an unmasked layer starts from everywhere. */
export function cutMaskArea(layerId, area) {
  const base = isMasked(layerId) ? masksOf(layerId) : [{ ...EVERYWHERE, id: newId() }];
  setRects(layerId, base.flatMap((m) => subtract(m, area)));
}
/** Masked with no area: the layer operates nowhere until areas are added. */
export function setEmptyMask(layerId) {
  setRects(layerId, []);
}
/** Back to unmasked: the layer operates everywhere. */
export function clearMask(layerId) {
  layers.value = layers.value.filter((m) => m.layerId !== layerId);
  if (masked.value[layerId]) {
    const { [layerId]: _, ...rest } = masked.value;
    masked.value = rest;
  }
}

const contains = (m, t, y) => t >= m.t && t <= m.t + m.dur && y >= m.y && y <= m.y + m.h;
/** Whether the stack layer operates at (t, y). */
export function operatesAt(layerId, t, y) {
  return !isMasked(layerId) || masksOf(layerId).some((m) => contains(m, t, y));
}
