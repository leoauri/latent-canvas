// The timeline viewport, shared by everything drawn over the temporal dimension.
// Time flows left to right. Zoom scales both axes together; clip lines keep their pixel height.
import { persist } from '@live/runtime';

export const MIN_PPS = 0.5;
export const MAX_PPS = 50000;

/**
 * t0: seconds at the left edge, pps: pixels per second,
 * y0: world y at the top edge, ys: pixels per world-y unit.
 */
export const view = persist('timeline.view', { t0: -0.5, y0: -40, pps: 100, ys: 1 });
if (view.value.ys == null) view.value = { ...view.value, ys: 1 }; // views persisted before ys existed

export const timeToX = (t, v = view.value) => (t - v.t0) * v.pps;
export const xToTime = (x, v = view.value) => v.t0 + x / v.pps;
export const worldToScreenY = (y, v = view.value) => (y - v.y0) * v.ys;
export const screenToWorldY = (sy, v = view.value) => v.y0 + sy / v.ys;

export function panBy(dxPx, dyPx) {
  const v = view.value;
  view.value = { ...v, t0: v.t0 + dxPx / v.pps, y0: v.y0 + dyPx / v.ys };
}

/** Zoom both axes by `factor`, keeping the point under screen (x, y) fixed. */
export function zoomAt(x, y, factor) {
  const v = view.value;
  const pps = Math.min(MAX_PPS, Math.max(MIN_PPS, v.pps * factor));
  const f = pps / v.pps; // same effective factor on both axes, so the aspect never drifts
  const ys = v.ys * f;
  view.value = { ...v, pps, ys, t0: xToTime(x, v) - x / pps, y0: screenToWorldY(y, v) - y / ys };
}

/** Shift the view so that time `t` sits at screen x `x`. */
export function placeTimeAt(t, x) {
  const v = view.value;
  view.value = { ...v, t0: t - x / v.pps };
}
