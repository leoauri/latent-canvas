// Infinite blank canvas over time. Touchpad: two-finger scroll pans, pinch zooms both axes.
// Mouse: wheel pans (shift for horizontal), ctrl+wheel zooms, middle-drag pans.
// Drag clips to move them, Delete removes the selection.
// Presses on empty space bubble to the container (the playhead uses them); presses on clips don't.
import { useEffect, useRef } from 'preact/hooks';
import { effect } from '@preact/signals';
import { view, panBy, zoomAt, worldToScreenY } from './view.js';
import { clips, selectedId, CLIP_HEIGHT, duration, updateClip, removeClip, bringToFront } from './clips.js';
import { layers as masks } from './layers.js';
import { stack, activeLayer, activeLayerId, highlightedLayerId, stackLayerColor } from '../stack/stack.js';

const HIT_PAD = 3; // px of slack around the 10px lines

// ---- clip rendering: each clip becomes a (length x 1) bitmap, stretched to its on-screen size

const projections = new Map(); // dim -> 3 x dim projection to RGB, fixed per dim
function projection(dim) {
  let p = projections.get(dim);
  if (!p) {
    p = new Float32Array(3 * dim);
    let s = (0x9e3779b9 ^ dim) >>> 0;
    const a = Math.sqrt(3 / dim); // unit-variance inputs -> unit-variance outputs
    for (let i = 0; i < p.length; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      p[i] = ((s / 2 ** 32) * 2 - 1) * a;
    }
    projections.set(dim, p);
  }
  return p;
}

const bitmaps = new WeakMap(); // clip.data -> canvas
function bitmap(clip) {
  let c = bitmaps.get(clip.data);
  if (c) return c;
  const { length: n, dim, data } = clip;
  const P = projection(dim);
  c = document.createElement('canvas');
  c.width = Math.max(1, n);
  c.height = 1;
  const g = c.getContext('2d');
  const img = g.createImageData(c.width, 1);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      let s = 0;
      for (let d = 0; d < dim; d++) s += P[k * dim + d] * data[i * dim + d];
      img.data[i * 4 + k] = 128 + 112 * Math.tanh(s);
    }
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  bitmaps.set(clip.data, c);
  return c;
}

const isTyping = (el) => !!el?.closest?.('input, textarea, select, button, [contenteditable]');

export default function TimelineCanvas() {
  const ref = useRef(null);

  useEffect(() => {
    const canvas = ref.current;
    const host = canvas.parentElement;
    const ctx = canvas.getContext('2d');
    let w = 0, h = 0, dpr = 1, frame = 0, hoverId = null, drag = null, suppressClick = false;

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(() => ((frame = 0), draw()));
    };

    function draw() {
      const v = view.value;
      const sel = selectedId.value;
      const css = getComputedStyle(canvas);
      const color = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
      const bg = color('--bg', '#fff'), fg = color('--fg', '#111'), accent = color('--timeline-select', '#4c8dff');

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      // Back to front through the stack: clips at the (backmost) latent recording layer, each
      // layer's masks as one shaded area, so only layers in front of the clips shade them.
      const layersBack = stack.value;
      const clipsAt = layersBack.findIndex((l) => l.type === 'latent');
      const focus = highlightedLayerId.value ?? activeLayer()?.id;
      if (clipsAt === -1) drawClips(v);
      for (const l of layersBack) {
        if (l === layersBack[clipsAt]) drawClips(v);
        drawMasks(l, v, l.id === focus);
      }

      // Hover/selection outlines stay on top of all shading.
      for (const c of clips.value) {
        if (c.id !== sel && c.id !== hoverId) continue;
        const x = (c.t - v.t0) * v.pps, y = worldToScreenY(c.y, v), cw = c.length * (v.pps / c.rate);
        const left = Math.max(x, -4), right = Math.min(x + Math.max(2, cw), w + 4);
        ctx.globalAlpha = c.id === sel ? 1 : 0.6;
        ctx.strokeStyle = c.id === sel ? accent : fg;
        ctx.lineWidth = c.id === sel ? 2 : 1;
        ctx.strokeRect(left - 1, y - 1, right - left + 2, CLIP_HEIGHT + 2);
        ctx.globalAlpha = 1;
      }
    }

    // Clips: only the visible sample range is drawn, nearest-neighbour when zoomed in so
    // individual samples (and so the clip's sample rate) are visible.
    function drawClips(v) {
      for (const c of clips.value) {
        const x = (c.t - v.t0) * v.pps, y = worldToScreenY(c.y, v);
        const pxPerSample = v.pps / c.rate, cw = c.length * pxPerSample;
        if (x > w || x + cw < 0 || y > h || y + CLIP_HEIGHT < 0) continue;
        const s0 = Math.max(0, Math.floor(-x / pxPerSample));
        const s1 = Math.min(c.length, Math.ceil((w - x) / pxPerSample));
        if (s1 > s0) {
          ctx.imageSmoothingEnabled = pxPerSample < 1;
          ctx.drawImage(bitmap(c), s0, 0, s1 - s0, 1, x + s0 * pxPerSample, y, Math.max(2, (s1 - s0) * pxPerSample), CLIP_HEIGHT);
        }
      }
    }

    // One path per layer, filled once: overlapping masks merge into a single evenly shaded area.
    function drawMasks(l, v, focused) {
      const own = masks.value.filter((m) => m.layerId === l.id);
      if (!own.length) return;
      ctx.beginPath();
      for (const m of own) {
        const x0 = Math.max(-50, (m.t - v.t0) * v.pps), x1 = Math.min(w + 50, (m.t + m.dur - v.t0) * v.pps);
        if (x1 > x0) ctx.rect(x0, worldToScreenY(m.y, v), x1 - x0, m.h * v.ys);
      }
      ctx.globalAlpha = focused ? 0.22 : 0.1;
      ctx.fillStyle = stackLayerColor(l);
      ctx.fill('nonzero');
      ctx.globalAlpha = 1;
    }

    const local = (e) => {
      const r = canvas.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    function hit(px, py) {
      const v = view.value, list = clips.value;
      for (let i = list.length - 1; i >= 0; i--) {
        const c = list[i];
        const x = (c.t - v.t0) * v.pps, y = worldToScreenY(c.y, v), cw = Math.max(2, duration(c) * v.pps);
        if (px >= x - HIT_PAD && px <= x + cw + HIT_PAD && py >= y - HIT_PAD && py <= y + CLIP_HEIGHT + HIT_PAD) return c;
      }
      return null;
    }

    // ---- input

    const onWheel = (e) => {
      e.preventDefault(); // also stops browser zoom and swipe-back navigation
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? h : 1;
      if (e.ctrlKey || e.metaKey) {
        // Touchpad pinch arrives as ctrl+wheel (Chrome, Firefox); clamp for mouse wheels.
        const dy = Math.max(-50, Math.min(50, e.deltaY * k));
        zoomAt(...local(e), Math.exp(-dy * 0.01));
      } else {
        panBy(e.deltaX * k, e.deltaY * k);
      }
    };
    // Safari sends pinch as gesture events instead.
    let gestureScale = 1;
    const onGestureStart = (e) => (e.preventDefault(), (gestureScale = 1));
    const onGestureEnd = (e) => e.preventDefault();
    const onGestureChange = (e) => {
      e.preventDefault();
      zoomAt(...local(e), e.scale / gestureScale);
      gestureScale = e.scale;
    };

    const onPointerDown = (e) => {
      suppressClick = false;
      if (e.button === 1) {
        e.preventDefault();
        drag = { mode: 'pan', x: e.clientX, y: e.clientY };
        canvas.setPointerCapture(e.pointerId);
        return;
      }
      if (e.button !== 0) return;
      const c = hit(...local(e));
      if (!c) {
        selectedId.value = null;
        return;
      }
      e.stopPropagation(); // a press on a clip must not move the playhead
      suppressClick = true;
      selectedId.value = c.id;
      bringToFront(c.id);
      drag = { mode: 'clip', id: c.id, x: e.clientX, y: e.clientY, t: c.t, cy: c.y };
      canvas.setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e) => {
      if (!drag) {
        const c = hit(...local(e));
        const id = c?.id ?? null;
        if (id !== hoverId) ((hoverId = id), schedule());
        canvas.style.cursor = c ? 'grab' : '';
        return;
      }
      if (drag.mode === 'pan') {
        panBy(drag.x - e.clientX, drag.y - e.clientY);
        drag.x = e.clientX;
        drag.y = e.clientY;
        return;
      }
      canvas.style.cursor = 'grabbing';
      updateClip(drag.id, { t: drag.t + (e.clientX - drag.x) / view.value.pps, y: drag.cy + (e.clientY - drag.y) / view.value.ys });
    };
    const onPointerUp = () => {
      drag = null;
      canvas.style.cursor = hoverId ? 'grab' : '';
    };
    const onClick = (e) => {
      if (suppressClick) e.stopPropagation();
      suppressClick = false;
    };
    const onKeyDown = (e) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId.value && !isTyping(e.target)) {
        e.preventDefault();
        removeClip(selectedId.value);
      }
    };

    const listeners = [
      // Pan/zoom on the whole timeline, not just the canvas: overlays above it (layer tabs and
      // edges) would otherwise let pinches through to browser zoom and stall scrolling.
      [host, 'wheel', onWheel, { passive: false }],
      [host, 'gesturestart', onGestureStart],
      [host, 'gesturechange', onGestureChange],
      [host, 'gestureend', onGestureEnd],
      [canvas, 'pointerdown', onPointerDown],
      [canvas, 'pointermove', onPointerMove],
      [canvas, 'pointerup', onPointerUp],
      [canvas, 'pointercancel', onPointerUp],
      [canvas, 'click', onClick],
      [window, 'keydown', onKeyDown],
    ];
    for (const [target, type, fn, opts] of listeners) target.addEventListener(type, fn, opts);

    const resize = new ResizeObserver(() => {
      const r = canvas.getBoundingClientRect();
      dpr = devicePixelRatio || 1;
      w = r.width;
      h = r.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      draw(); // synchronously, so resizing doesn't flash an empty canvas
    });
    resize.observe(canvas);

    // Redraw whenever the view, the clips or the selection change.
    const stopEffect = effect(() => {
      view.value, clips.value, selectedId.value, stack.value, masks.value, highlightedLayerId.value, activeLayerId.value;
      schedule();
    });
    // Theme changes (light/dark) change the CSS colours.
    const scheme = matchMedia('(prefers-color-scheme: dark)');
    scheme.addEventListener('change', schedule);

    return () => {
      for (const [target, type, fn, opts] of listeners) target.removeEventListener(type, fn, opts);
      scheme.removeEventListener('change', schedule);
      resize.disconnect();
      stopEffect();
      cancelAnimationFrame(frame);
    };
  }, []);

  return <canvas ref={ref} class="timeline-canvas" />;
}
