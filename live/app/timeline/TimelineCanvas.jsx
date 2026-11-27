// Infinite blank canvas over time. Touchpad: two-finger scroll pans, pinch zooms both axes.
// Mouse: wheel pans (shift for horizontal), ctrl+wheel zooms, middle-drag pans.
// Click selects a clip (shift+click toggles it), Alt+drag on empty space lassos clips (Alt+Shift:
// adds to the selection). Dragging a selected clip moves the whole selection, Alt+drag moves a copy
// of it; with Shift either goes only horizontally or vertically. Cmd/Ctrl+D duplicates the selection right after itself, Delete removes it.
// Presses on empty space bubble to the container (the playhead uses them); presses on clips don't.
import { useEffect, useRef } from 'preact/hooks';
import { effect } from '@preact/signals';
import { view, panBy, zoomAt, worldToScreenY, xToTime, screenToWorldY } from './view.js';
import { clips, selection, CLIP_HEIGHT, LANE, duration, removeClips, moveClips, duplicateClips, bringAllToFront, addClip } from './clips.js';
import { isAssetDrag, assetOf, assetKind, clipFromAsset } from '../assetDrag.js';
import { seek } from './Playhead.jsx';
import { isAudioFile, decodeAudioFile, clipsFromAudio, recordersFor, pendingDrops, showPending } from '../stack/audioDrop.js';
import { audioContext } from '../../lib/audio.js';
import { readDrop } from '../stack/models.js';
import * as blobs from '../../net/blobs.js';

// Message over the timeline, above the pill row (the HUD has no error slot). A note (`ms` 0) stays
// until removed. Errors also go to the console (the app log agents read), and a click dismisses them.
function showDropError(msg, ms = 10000, kind = 'error') {
  const el = document.createElement('div');
  el.className = `timeline-drop-${kind}`;
  el.textContent = msg;
  if (kind === 'error') {
    console.warn(`timeline drop: ${msg}`);
    el.title = 'Click to dismiss';
    el.onclick = () => el.remove();
  }
  document.querySelector('.timeline')?.append(el);
  if (ms) setTimeout(() => el.remove(), ms);
  return el;
}
const showDropNote = (msg) => showDropError(msg, 0, 'note');
import { layers as masks, masked } from './layers.js';
import { stack, activeLayer, activeLayerId, highlightedLayerId, stackLayerColor, dropOwner } from '../stack/stack.js';

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
export function bitmap(clip) {
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

// Whether the polygon (screen points) contains point (x, y): even-odd ray casting.
function inside(poly, x, y) {
  let k = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) k = !k;
  }
  return k;
}
// Whether segments ab and cd cross.
function crosses([ax, ay], [bx, by], [cx, cy], [dx, dy]) {
  const o = (px, py, qx, qy, rx, ry) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
  return o(ax, ay, bx, by, cx, cy) !== o(ax, ay, bx, by, dx, dy) && o(cx, cy, dx, dy, ax, ay) !== o(cx, cy, dx, dy, bx, by);
}
// A clip is lassoed when its centre line touches the closed lasso: an end inside, or crossing an edge.
function lassoed(poly, x0, x1, y) {
  if (poly.length < 3) return false;
  if (inside(poly, x0, y) || inside(poly, x1, y)) return true;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) if (crosses([x0, y], [x1, y], poly[j], poly[i])) return true;
  return false;
}

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
      const sel = new Set(selection.value);
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
        const on = sel.has(c.id);
        if (!on && c.id !== hoverId) continue;
        const x = (c.t - v.t0) * v.pps, y = worldToScreenY(c.y, v), cw = c.length * (v.pps / c.rate);
        const left = Math.max(x, -4), right = Math.min(x + Math.max(2, cw), w + 4);
        if (right < left) continue;
        ctx.globalAlpha = on ? 1 : 0.6;
        ctx.strokeStyle = on ? accent : fg;
        ctx.lineWidth = on ? 2 : 1;
        ctx.strokeRect(left - 1, y - 1, right - left + 2, CLIP_HEIGHT + 2);
        ctx.globalAlpha = 1;
      }

      // Dropped audio on its way through the stack: the areas its clips will fill (a lane per armed
      // layer it can reach), dashed.
      for (const p of pendingDrops.value)
        for (let k = 0; k < (p.lanes ?? 1); k++) {
          const x = (p.t - v.t0) * v.pps, y = worldToScreenY(p.y + k * (p.lane ?? 0), v), pw = Math.max(2, p.dur * v.pps);
          if (x > w || x + pw < 0 || y > h || y + CLIP_HEIGHT < 0) continue;
          ctx.globalAlpha = 0.12;
          ctx.fillStyle = accent;
          ctx.fillRect(x, y, pw, CLIP_HEIGHT);
          ctx.globalAlpha = 0.8;
          ctx.setLineDash([4, 3]);
          ctx.lineWidth = 1;
          ctx.strokeStyle = accent;
          ctx.strokeRect(x - 0.5, y - 0.5, pw + 1, CLIP_HEIGHT + 1);
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
        }

      // The lasso being drawn.
      if (drag?.mode === 'lasso' && drag.poly.length > 1) {
        ctx.beginPath();
        drag.poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.closePath();
        ctx.globalAlpha = 0.08;
        ctx.fillStyle = accent;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1;
        ctx.strokeStyle = accent;
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Selects the clips the lasso touches (in addition to those selected when it started).
    function lassoSelect() {
      const v = view.value, poly = drag.poly, ids = new Set(drag.base);
      for (const c of clips.value) {
        const x0 = (c.t - v.t0) * v.pps, x1 = x0 + Math.max(2, duration(c) * v.pps);
        if (lassoed(poly, x0, x1, worldToScreenY(c.y, v) + CLIP_HEIGHT / 2)) ids.add(c.id);
      }
      const next = [...ids];
      if (next.length !== selection.value.length || next.some((id, i) => id !== selection.value[i])) selection.value = next;
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
      if (!masked.value[l.id]) return;
      ctx.beginPath();
      for (const m of masks.value) {
        if (m.layerId !== l.id) continue;
        const x0 = Math.max(-50, (m.t - v.t0) * v.pps), x1 = Math.min(w + 50, (m.t + m.dur - v.t0) * v.pps);
        const y0 = Math.max(-50, worldToScreenY(m.y, v)), y1 = Math.min(h + 50, worldToScreenY(m.y + m.h, v));
        if (x1 > x0 && y1 > y0) ctx.rect(x0, y0, x1 - x0, y1 - y0);
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

    const origins = (ids) => {
      const from = {};
      for (const c of clips.value) if (ids.includes(c.id)) from[c.id] = { t: c.t, y: c.y };
      return from;
    };

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

    // Touch: one finger on empty space pans (a tap seeks), a second finger hands over to the pinch.
    const touches = new Set();
    const onPointerDown = (e) => {
      suppressClick = false;
      if (e.pointerType === 'touch') {
        touches.add(e.pointerId);
        if (touches.size > 1) return void (e.stopPropagation(), (drag = { mode: 'pinch' }));
        if (!hit(...local(e))) {
          e.stopPropagation();
          selection.value = [];
          drag = { mode: 'pan', x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, tap: true };
          canvas.setPointerCapture(e.pointerId);
          return;
        }
      }
      if (e.button === 1) {
        e.preventDefault();
        drag = { mode: 'pan', x: e.clientX, y: e.clientY };
        canvas.setPointerCapture(e.pointerId);
        return;
      }
      if (e.button !== 0) return;
      const c = hit(...local(e));
      if (!c) {
        if (e.altKey) {
          // Lasso: the playhead stays where it is. Alt+Shift adds to the selection.
          e.stopPropagation();
          suppressClick = true;
          drag = { mode: 'lasso', poly: [local(e)], base: e.shiftKey ? selection.value : [] };
          lassoSelect();
          canvas.setPointerCapture(e.pointerId);
        } else selection.value = [];
        return;
      }
      e.stopPropagation(); // a press on a clip must not move the playhead
      suppressClick = true;
      const sel = selection.value, was = sel.includes(c.id);
      // Pressing an unselected clip selects just it (with Shift: adds it); pressing a selected one
      // keeps the group. Shift+click (no drag) on a selected clip deselects it.
      const ids = was ? [...sel.filter((id) => id !== c.id), c.id] : e.shiftKey && !e.altKey ? [...sel, c.id] : [c.id];
      selection.value = ids;
      // Alt: the copy is made once the pointer moves, so an Alt+click doesn't stack a hidden duplicate.
      if (!e.altKey) bringAllToFront(ids);
      drag = { mode: 'clip', ids, from: origins(ids), copies: null, deselect: e.shiftKey && !e.altKey && was ? c.id : null, x: e.clientX, y: e.clientY };
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
      if (drag.mode === 'pinch') return;
      if (drag.mode === 'pan') {
        if (drag.tap && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 8) return;
        drag.tap = false;
        panBy(drag.x - e.clientX, drag.y - e.clientY);
        drag.x = e.clientX;
        drag.y = e.clientY;
        return;
      }
      if (drag.mode === 'lasso') {
        const p = local(e), last = drag.poly[drag.poly.length - 1];
        if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 3) return;
        drag.poly.push(p);
        lassoSelect();
        schedule();
        return;
      }
      drag.cx = e.clientX;
      drag.cy = e.clientY;
      applyClipDrag(e);
    };
    // Moves the dragged clips for the latest pointer position under the given modifiers. Also run when
    // Shift or Alt changes mid-drag, so those take effect at once instead of on the next pointer move.
    const applyClipDrag = (mods) => {
      let dx = (drag.cx ?? drag.x) - drag.x, dy = (drag.cy ?? drag.y) - drag.y;
      if (drag.deselect) {
        if (Math.hypot(dx, dy) < 3) return;
        drag.deselect = null; // a drag after all
      }
      // Alt duplicates while it is held: pressing it (at the press or mid-drag) makes copies once the
      // pointer has moved, and the originals go back to where they were; releasing it drops the copies
      // and moves the originals again.
      if (mods.altKey && !drag.copies && Math.hypot(dx, dy) < 3) return; // an Alt+click doesn't nudge
      const copy = !!mods.altKey;
      if (copy && !drag.copies) {
        moveClips(drag.from, 0, 0); // put the originals back before copying
        drag.copies = origins(duplicateClips(drag.ids, 0).map((d) => d.id));
      } else if (!copy && drag.copies) {
        removeClips(Object.keys(drag.copies));
        drag.copies = null;
        selection.value = drag.ids;
        bringAllToFront(drag.ids);
      }
      canvas.style.cursor = drag.copies ? 'copy' : 'grabbing';
      // Shift constrains the move (or Alt+Shift the copy) to the dominant axis.
      if (mods.shiftKey) Math.abs(dx) >= Math.abs(dy) ? (dy = 0) : (dx = 0);
      moveClips(drag.copies ?? drag.from, dx / view.value.pps, dy / view.value.ys);
    };
    const onModifierKey = (e) => {
      if ((e.key === 'Shift' || e.key === 'Alt') && drag?.mode === 'clip' && !e.repeat) applyClipDrag(e);
    };
    const onPointerUp = (e) => {
      touches.delete(e.pointerId);
      if (drag?.mode === 'pinch' && touches.size) return;
      const was = drag;
      drag = null;
      if (was?.tap && e.type === 'pointerup') seek(xToTime(local(e)[0]));
      if (was?.mode === 'lasso') schedule();
      if (was?.deselect && e.type === 'pointerup') selection.value = selection.value.filter((id) => id !== was.deselect);
      canvas.style.cursor = hoverId ? 'grab' : '';
    };
    const onClick = (e) => {
      if (suppressClick) e.stopPropagation();
      suppressClick = false;
    };
    const onKeyDown = (e) => {
      if (!selection.value.length || isTyping(e.target)) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        removeClips(selection.value);
      } else if (e.code === 'KeyD' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault(); // not the browser's bookmark
        duplicateClips(selection.value);
      }
    };

    // Latent assets dragged from the assets window become clips where they are dropped. So do audio
    // files from the OS, once the layer stack has carried them to a latent recording layer. Any other
    // file (a model, a folder's files) goes to the assets: dropping something here is never an error.
    const offStack = (e) => !e.target.closest?.('.stack');
    const isFileDrag = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
    const onAssetOver = (e) => {
      if (!(isAssetDrag(e) || isFileDrag(e)) || !offStack(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    };
    const onAssetDrop = (e) => {
      if (!(isAssetDrag(e) || isFileDrag(e)) || !offStack(e)) return;
      e.preventDefault();
      const [px, py] = local(e);
      const v = view.value;
      if (!isAssetDrag(e)) {
        const at = { t: xToTime(px, v), y: screenToWorldY(py, v) };
        // readDrop takes the entries now, inside the event, and reads a dropped folder's own files.
        return readDrop(e.dataTransfer).then(({ files }) => dropFiles([...files.values()], at, v), (err) => showDropError(`Not added: ${err.message || err}`));
      }
      const a = assetOf(e.dataTransfer);
      const at = { t: xToTime(px, v), y: screenToWorldY(py, v) - CLIP_HEIGHT / 2 / v.ys };
      if (assetKind(a) !== 'clip') return showDropError(`“${a?.name ?? 'file'}” is not clip data: drop models on the layer stack`);
      clipFromAsset(a.hash).then(
        // On the selected layer if it is a latent one, else the backmost latent layer.
        (c) => (addClip({ ...c, ...at, layer: dropOwner().id }), (selection.value = [c.id])),
        (err) => showDropError(`Clip not added: ${err.message || err}`),
      );
    };
    // Audio files are recorded through the stack (stack/audioDrop.js): each armed layer, whatever
    // the pass-through of the layers between, records a clip, a lane apart, and each file goes below
    // the lanes of the one before. Each shows the areas it will fill as soon as it is decoded; they
    // go through the stack one after the other.
    const dropFiles = (files, at, v) => {
      const audio = files.filter(isAudioFile);
      const rest = files.filter((f) => !isAudioFile(f));
      if (rest.length) addAssets(rest);
      if (audio.length) dropAudioFiles(audio, at, v);
    };
    const addAssets = async (files) => {
      const what = files.length === 1 ? `“${files[0].name}”` : `${files.length} files`;
      try {
        for (const f of files) await blobs.put(f, { name: f.name, type: f.type || null });
        showDropError(`${what} added to Assets`, 4000, 'note');
      } catch (err) {
        showDropError(`${what} not added to Assets: ${err.message || err}`);
      }
    };
    const dropAudioFiles = async (audio, at, v) => {
      const lane = LANE / v.ys, lanes = Math.max(1, recordersFor().length);
      const sr = audioContext().sampleRate;
      const drops = audio.map((file, i) => {
        const y = at.y + i * lanes * lane, top = y - CLIP_HEIGHT / 2 / v.ys;
        const d = { file, at: { t: at.t, y, top, lane }, hide: () => {} };
        d.decoded = decodeAudioFile(file).then((data) => ((d.hide = showPending({ name: file.name, t: at.t, y: top, dur: data.length / sr, lanes, lane })), data));
        d.decoded.catch(() => {}); // reported below, in turn
        return d;
      });
      const made = [];
      for (const d of drops) {
        const name = d.file.name;
        const note = showDropNote(`${name}: decoding…`);
        try {
          const takes = await clipsFromAudio(await d.decoded, d.at, (l, waiting) =>
            (note.textContent = `${name}: ${waiting ? `waiting for the model on ${l.name}` : `through ${l.name}`}…`));
          for (const { clip } of takes) addClip(clip), made.push(clip.id);
        } catch (err) {
          showDropError(`${name} not recorded: ${err.message || err}`);
        } finally {
          d.hide();
          note.remove();
        }
      }
      if (made.length) selection.value = made;
    };

    const listeners = [
      [host, 'dragover', onAssetOver],
      [host, 'drop', onAssetDrop],
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
      [window, 'keydown', onModifierKey],
      [window, 'keyup', onModifierKey],
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
      view.value, clips.value, selection.value, pendingDrops.value, stack.value, masks.value, masked.value, highlightedLayerId.value, activeLayerId.value;
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
