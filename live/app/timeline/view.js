// The timeline viewport, shared by everything drawn over the temporal dimension.
// Time flows left to right; x zooms, y only scrolls (clip lines keep their pixel height).
import { persist } from '@live/runtime';

export const MIN_PPS = 0.5;
export const MAX_PPS = 50000;

/** t0: seconds at the left edge, y0: world px at the top edge, pps: pixels per second. */
export const view = persist('timeline.view', { t0: -0.5, y0: -40, pps: 100 });

export const timeToX = (t, v = view.value) => (t - v.t0) * v.pps;
export const xToTime = (x, v = view.value) => v.t0 + x / v.pps;
export const worldToScreenY = (y, v = view.value) => y - v.y0;
export const screenToWorldY = (sy, v = view.value) => sy + v.y0;

export function panBy(dxPx, dyPx) {
  const v = view.value;
  view.value = { ...v, t0: v.t0 + dxPx / v.pps, y0: v.y0 + dyPx };
}

/** Zoom the time axis by `factor`, keeping the time under screen x `x` fixed. */
export function zoomAt(x, factor) {
  const v = view.value;
  const pps = Math.min(MAX_PPS, Math.max(MIN_PPS, v.pps * factor));
  const t = xToTime(x, v);
  view.value = { ...v, pps, t0: t - x / pps };
}

/** Shift the view so that time `t` sits at screen x `x`. */
export function placeTimeAt(t, x) {
  const v = view.value;
  view.value = { ...v, t0: t - x / v.pps };
}
