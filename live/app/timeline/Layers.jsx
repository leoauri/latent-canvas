// Mask editing overlay (the shading itself is drawn in stack order by TimelineCanvas.jsx).
// Shift+drag draws a mask on the active
// stack layer; Alt+drag inside one of its masks moves it; its edges/corners resize; Delete removes the
// selected mask. Mask interiors let pointer events through, so clips stay draggable.
import { useEffect, useRef } from 'preact/hooks';
import { useSignal, effect } from '@preact/signals';
import { view, timeToX, xToTime, worldToScreenY, screenToWorldY } from './view.js';
import { selectedId as selectedClipId } from './clips.js';
import { layers, selectedLayerId, addLayer, updateLayer, removeLayer, selectLayer, MIN_LAYER_HEIGHT } from './layers.js';
import { activeLayer, stackLayerColor } from '../stack/stack.js';

const MIN_WIDTH_PX = 6;
const OFFSCREEN = 50; // px: masks extending past the viewport are clipped this far outside it
const EDGES = ['l', 'r', 't', 'b', 'tl', 'tr', 'bl', 'br'];

const isTyping = (el) => !!el?.closest?.('input, textarea, select, button, [contenteditable]');

function track(onMove, onEnd) {
  const up = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    onEnd?.();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

/** Move (mode 'move') or resize (mode = edges, e.g. 'tl') a mask by dragging. */
function startDrag(e, mask, mode) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  selectLayer(mask.id);
  const s = mask, px0 = e.clientX, py0 = e.clientY;
  track((ev) => {
    const { pps, ys } = view.value;
    const dt = (ev.clientX - px0) / pps, dy = (ev.clientY - py0) / ys;
    const minDur = MIN_WIDTH_PX / pps, minH = MIN_LAYER_HEIGHT / ys;
    if (mode === 'move') return updateLayer(s.id, { t: s.t + dt, y: s.y + dy });
    const p = {};
    if (mode.includes('l')) {
      p.t = Math.min(s.t + dt, s.t + s.dur - minDur);
      p.dur = s.t + s.dur - p.t;
    }
    if (mode.includes('r')) p.dur = Math.max(minDur, s.dur + dt);
    if (mode.includes('t')) {
      p.y = Math.min(s.y + dy, s.y + s.h - minH);
      p.h = s.y + s.h - p.y;
    }
    if (mode.includes('b')) p.h = Math.max(minH, s.h + dy);
    updateLayer(s.id, p);
  });
}

const px = (n) => `${n}px`; // Preact 11 no longer appends px to numeric styles
const stop = (e) => e.stopPropagation(); // handle clicks must not place the playhead

/** Screen rect of a mask clipped to just beyond the viewport, or null when offscreen. */
function screenRect(m, v, w) {
  const x = timeToX(m.t, v);
  const left = Math.max(x, -OFFSCREEN);
  const right = Math.min(x + m.dur * v.pps, w + OFFSCREEN);
  if (right <= left) return null;
  return { left, top: worldToScreenY(m.y, v), width: right - left, height: m.h * v.ys };
}

export default function Layers() {
  const ref = useRef(null);
  const width = useSignal(0);

  useEffect(() => {
    const el = ref.current;
    const host = el.parentElement;
    let suppressClick = false;
    const local = (e) => {
      const r = host.getBoundingClientRect();
      return { t: xToTime(e.clientX - r.left), y: screenToWorldY(e.clientY - r.top) };
    };

    // Capture phase, so the clip canvas never sees these gestures.
    const onPointerDownCapture = (e) => {
      if (e.button !== 0 || !(e.shiftKey || e.altKey) || e.target.closest('.stack')) return;
      const owner = activeLayer();
      if (!owner) return;
      const p = local(e);
      if (e.altKey) {
        const hit = layers.value.findLast((m) => m.layerId === owner.id && p.t >= m.t && p.t <= m.t + m.dur && p.y >= m.y && p.y <= m.y + m.h);
        if (!hit) return;
        suppressClick = true;
        e.stopImmediatePropagation();
        return startDrag(e, hit, 'move');
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      suppressClick = true;
      const mask = addLayer({ t: p.t, y: p.y, dur: 0, h: 0, layerId: owner.id });
      selectLayer(mask.id);
      track(
        (ev) => {
          const q = local(ev);
          updateLayer(mask.id, { t: Math.min(p.t, q.t), dur: Math.abs(q.t - p.t), y: Math.min(p.y, q.y), h: Math.abs(q.y - p.y) });
        },
        () => {
          const m = layers.value.find((x) => x.id === mask.id);
          if (m && (m.dur * view.value.pps < MIN_WIDTH_PX || m.h * view.value.ys < MIN_LAYER_HEIGHT)) removeLayer(m.id);
        },
      );
    };
    const onClickCapture = (e) => {
      if (!suppressClick) return;
      suppressClick = false;
      e.stopImmediatePropagation();
    };
    const onPointerDown = () => selectLayer(null);
    const onKeyDown = (e) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedLayerId.value && !isTyping(e.target)) {
        e.preventDefault();
        removeLayer(selectedLayerId.value);
      }
    };
    host.addEventListener('pointerdown', onPointerDownCapture, true);
    host.addEventListener('click', onClickCapture, true);
    host.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);

    const stopEffect = effect(() => {
      if (selectedClipId.value) selectedLayerId.value = null;
    });
    const resize = new ResizeObserver(() => (width.value = el.clientWidth));
    resize.observe(el);

    return () => {
      host.removeEventListener('pointerdown', onPointerDownCapture, true);
      host.removeEventListener('click', onClickCapture, true);
      host.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
      stopEffect();
      resize.disconnect();
    };
  }, []);

  const v = view.value;
  const w = width.value;
  const sel = selectedLayerId.value;
  const active = activeLayer();
  const masks = layers.value;

  const handles = active ? masks.filter((m) => m.layerId === active.id) : [];

  return (
    <div ref={ref} class="layers" style={{ '--layer': active ? stackLayerColor(active) : 'transparent' }}>
      {w > 0 &&
        handles.map((m) => {
          const r = screenRect(m, v, w);
          if (!r) return null;
          return (
            <div
              key={m.id}
              class={`mask-box${m.id === sel ? ' mask-selected' : ''}`}
              style={{ left: px(r.left), top: px(r.top), width: px(r.width), height: px(r.height) }}
            >
              {EDGES.map((edge) => (
                <div key={edge} class={`layer-edge layer-edge-${edge}`} onPointerDown={(e) => startDrag(e, m, edge)} onClick={stop} />
              ))}
            </div>
          );
        })}
    </div>
  );
}
