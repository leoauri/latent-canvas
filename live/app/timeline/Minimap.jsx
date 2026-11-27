// A small overview of where the clips are (top left): every clip, masks over that area, the
// playhead, everyone's cursor as a dot in their colour, and the part currently in view as a rectangle (cut off where it reaches past the clips). Drag the rectangle (or press anywhere
// to centre the view there, then drag) to move around.
// The dots follow presence state as it arrives (a peer's cursor every THROTTLE_MS in net/presence.js), not
// Presence.jsx's interpolation: at this scale steps of a few px read as movement, and the map redraws (at
// most once a frame) only when something changes rather than every frame.
// Coordinates: (t, y * r) with r = ys / pps. Zoom scales both axes together, so r never changes
// and the overview looks the same at any zoom.
import { useEffect, useRef } from 'preact/hooks';
import { effect } from '@preact/signals';
import { view } from './view.js';
import { clips, duration } from './clips.js';
import { layers as masks, masked } from './layers.js';
import { time } from './Playhead.jsx';
import { stack, stackLayerColor } from '../stack/stack.js';
import { bitmap } from './TimelineCanvas.jsx';
import { persist } from '@live/runtime';
import * as presence from '../../net/presence.js';

const myCursor = persist('presence.cursor', null);

const W = 200, H = 120, PAD = 6; // px
const MAX_STRETCH = 8;
const CLIP_PX = 3; // clip height on the map: fixed, since a clip's height in world units depends on the zoom

export default function Minimap() {
  const ref = useRef(null);

  useEffect(() => {
    const canvas = ref.current;
    const host = canvas.closest('.timeline');
    const ctx = canvas.getContext('2d');
    let frame = 0, hostW = 0, hostH = 0, drag = null, fit = null;

    // The area with clips and the playhead, in (t, y * r) units; the view only when there are no clips. Time and height are scaled separately so the content fills the box, with
    // height stretched at most MAX_STRETCH times relative to time.
    function bounds(v) {
      const r = v.ys / v.pps;
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      const add = (a, b, c, d) => ((x0 = Math.min(x0, a)), (x1 = Math.max(x1, b)), (y0 = Math.min(y0, c)), (y1 = Math.max(y1, d)));
      for (const c of clips.value) add(c.t, c.t + duration(c), c.y * r, c.y * r); // tops only: see CLIP_PX
      if (x0 === Infinity) add(v.t0, v.t0 + hostW / v.pps, v.y0 * r, v.y0 * r + hostH / v.pps);
      ((x0 = Math.min(x0, time.value)), (x1 = Math.max(x1, time.value))); // the playhead too, when it's past the clips
      const sx = (W - 2 * PAD) / (x1 - x0 || 1);
      const sy = Math.min((H - 2 * PAD - CLIP_PX) / (y1 - y0 || 1), sx * MAX_STRETCH);
      // Centre the content in the box.
      return { sx, sy, ox: PAD - x0 * sx, oy: (H - CLIP_PX) / 2 - ((y0 + y1) / 2) * sy };
    }

    function draw() {
      const v = view.value, r = v.ys / v.pps;
      const b = drag ? fit : (fit = bounds(v)); // frozen while dragging, so the map holds still under the pointer
      const X = (t) => b.ox + t * b.sx, Y = (y) => b.oy + y * r * b.sy;
      const css = getComputedStyle(canvas);
      const dpr = devicePixelRatio || 1;
      if (canvas.width !== W * dpr) ((canvas.width = W * dpr), (canvas.height = H * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      // Masked areas, clipped to the box (an "everywhere" mask covers it all).
      for (const l of stack.value) {
        if (!masked.value[l.id]) continue;
        ctx.beginPath();
        for (const m of masks.value) {
          if (m.layerId !== l.id) continue;
          const x0 = Math.max(0, X(m.t)), x1 = Math.min(W, X(m.t + m.dur)), y0 = Math.max(0, Y(m.y)), y1 = Math.min(H, Y(m.y + m.h));
          if (x1 > x0 && y1 > y0) ctx.rect(x0, y0, x1 - x0, y1 - y0);
        }
        ctx.globalAlpha = 0.15;
        ctx.fillStyle = stackLayerColor(l);
        ctx.fill('nonzero');
        ctx.globalAlpha = 1;
      }

      ctx.imageSmoothingEnabled = true;
      for (const c of clips.value) {
        const x = X(c.t), y = Y(c.y);
        ctx.drawImage(bitmap(c), x, y, Math.max(1, duration(c) * b.sx), CLIP_PX);
      }

      const px = X(time.value);
      ctx.fillStyle = css.getPropertyValue('--playhead').trim() || '#ff5a36';
      ctx.fillRect(Math.round(px) - 0.5, 0, 1, H);

      // Everyone's cursor (ours included) as a dot, kept inside the box.
      const dot = (c, color) => {
        if (!c || !Number.isFinite(c.t) || !Number.isFinite(c.y)) return;
        ctx.beginPath();
        ctx.arc(Math.min(W - 2, Math.max(2, X(c.t))), Math.min(H - 2, Math.max(2, Y(c.y))), 1.5, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      };
      if (presence.show.value) for (const p of Object.values(presence.others.value)) dot(p.state.cursor, p.color);
      dot(myCursor.value, presence.myColor);

      // The view, kept at least a sliver inside the box: off the content, it waits at the nearest edge.
      const E = 3, clamp = (a, lo, hi) => Math.min(hi, Math.max(lo, a));
      const rx0 = X(v.t0), ry0 = Y(v.y0), rx1 = rx0 + (hostW / v.pps) * b.sx, ry1 = ry0 + (hostH / v.pps) * b.sy;
      const vx = clamp(rx0, 0, W - E), vy = clamp(ry0, 0, H - E);
      const vw = Math.max(E, clamp(rx1, E, W) - vx), vh = Math.max(E, clamp(ry1, E, H) - vy);
      ctx.fillStyle = css.getPropertyValue('--timeline-select').trim() || '#4c8dff';
      ctx.globalAlpha = 0.08;
      ctx.fillRect(vx, vy, vw, vh);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(vx, vy, vw, vh);
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(() => ((frame = 0), draw()));
    };

    const local = (e) => {
      const rc = canvas.getBoundingClientRect();
      return [e.clientX - rc.left, e.clientY - rc.top];
    };
    // Moves the view so that its top-left lands at minimap point (mx, my).
    const placeView = (mx, my) => {
      const v = view.peek(), r = v.ys / v.pps;
      view.value = { ...v, t0: (mx - fit.ox) / fit.sx, y0: (my - fit.oy) / fit.sy / r };
    };
    const onDown = (e) => {
      if (e.button !== 0) return;
      e.stopPropagation(); // not a seek
      e.preventDefault();
      const v = view.peek(), r = v.ys / v.pps;
      const [mx, my] = local(e);
      const vx = fit.ox + v.t0 * fit.sx, vy = fit.oy + v.y0 * r * fit.sy, vw = (hostW / v.pps) * fit.sx, vh = (hostH / v.pps) * fit.sy;
      const inside = mx >= vx && mx <= vx + vw && my >= vy && my <= vy + vh;
      // Grab the rectangle where pressed; elsewhere, centre it on the press.
      drag = inside ? { dx: mx - vx, dy: my - vy } : { dx: vw / 2, dy: vh / 2 };
      if (!inside) placeView(mx - drag.dx, my - drag.dy);
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = 'grabbing';
    };
    const onMove = (e) => {
      if (!drag) return;
      const [mx, my] = local(e);
      placeView(mx - drag.dx, my - drag.dy);
    };
    const onUp = () => {
      if (!drag) return;
      drag = null;
      canvas.style.cursor = '';
      schedule(); // refit now that the pointer let go
    };
    const stopClick = (e) => e.stopPropagation();
    const listeners = [
      ['pointerdown', onDown],
      ['pointermove', onMove],
      ['pointerup', onUp],
      ['pointercancel', onUp],
      ['click', stopClick],
    ];
    for (const [type, fn] of listeners) canvas.addEventListener(type, fn);

    const resize = new ResizeObserver(() => ((hostW = host.clientWidth), (hostH = host.clientHeight), draw()));
    resize.observe(host);
    const stopEffect = effect(() => {
      view.value, clips.value, masks.value, masked.value, stack.value, time.value, presence.others.value, presence.show.value, myCursor.value;
      schedule();
    });

    return () => {
      for (const [type, fn] of listeners) canvas.removeEventListener(type, fn);
      resize.disconnect();
      stopEffect();
      cancelAnimationFrame(frame);
    };
  }, []);

  return <canvas ref={ref} class="minimap" style={{ width: `${W}px`, height: `${H}px` }} title="Overview: drag to move the view" />;
}
