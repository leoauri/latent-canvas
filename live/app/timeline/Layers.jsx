// Layer overlay. Shift+drag on the timeline draws a new layer; drag a layer's tab to move it,
// its edges/corners to resize it; Delete removes the selected layer. Layer interiors let
// pointer events through, so clips underneath stay draggable and the playhead placeable.
import { useEffect, useRef } from 'preact/hooks';
import { useSignal, effect } from '@preact/signals';
import { view, timeToX, xToTime, worldToScreenY, screenToWorldY } from './view.js';
import { selectedId as selectedClipId } from './clips.js';
import {
  layers, selectedLayerId, addLayer, updateLayer, removeLayer, bringLayerToFront, selectLayer,
  layerColor, MIN_LAYER_HEIGHT,
} from './layers.js';

const MIN_WIDTH_PX = 6;
const OFFSCREEN = 50; // px: layers extending past the viewport are clipped this far outside it
const EDGES = ['l', 'r', 't', 'b', 'tl', 'tr', 'bl', 'br'];

const isTyping = (el) => !!el?.closest?.('input, textarea, select, button, [contenteditable]');

/** Follow a pointer until release. */
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

/** Move (mode 'move') or resize (mode = edges, e.g. 'tl') a layer by dragging. */
function startDrag(e, layer, mode) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  selectLayer(layer.id);
  bringLayerToFront(layer.id);
  const s = layer, px0 = e.clientX, py0 = e.clientY;
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

export default function Layers() {
  const ref = useRef(null);
  const width = useSignal(0);

  useEffect(() => {
    const el = ref.current;
    const host = el.parentElement;
    let suppressClick = false;

    // Shift+drag anywhere on the timeline draws a new layer. Capture phase, so the clip
    // canvas never sees this gesture.
    const onPointerDownCapture = (e) => {
      if (!e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      suppressClick = true;
      const r = host.getBoundingClientRect();
      const t0 = xToTime(e.clientX - r.left), y0 = screenToWorldY(e.clientY - r.top);
      const layer = addLayer({ t: t0, y: y0, dur: 0, h: 0 });
      selectLayer(layer.id);
      track(
        (ev) => {
          const t1 = xToTime(ev.clientX - r.left), y1 = screenToWorldY(ev.clientY - r.top);
          updateLayer(layer.id, { t: Math.min(t0, t1), dur: Math.abs(t1 - t0), y: Math.min(y0, y1), h: Math.abs(y1 - y0) });
        },
        () => {
          const l = layers.value.find((x) => x.id === layer.id);
          if (l && (l.dur * view.value.pps < MIN_WIDTH_PX || l.h * view.value.ys < MIN_LAYER_HEIGHT)) removeLayer(l.id);
        },
      );
    };
    const onClickCapture = (e) => {
      if (!suppressClick) return;
      suppressClick = false;
      e.stopImmediatePropagation();
    };
    // Pointer down that reached the timeline itself (not a layer handle): deselect.
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

    // Selecting a clip deselects the layer.
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
  return (
    <div ref={ref} class="layers">
      {w > 0 &&
        layers.value.map((l) => {
          const x = timeToX(l.t, v);
          // Clip to just beyond the viewport: at deep zoom a layer can be millions of px wide.
          const left = Math.max(x, -OFFSCREEN);
          const right = Math.min(x + l.dur * v.pps, w + OFFSCREEN);
          if (right <= left) return null;
          return (
            <div
              key={l.id}
              class={`layer${l.id === sel ? ' layer-selected' : ''}`}
              style={{ left: px(left), top: px(worldToScreenY(l.y, v)), width: px(right - left), height: px(l.h * v.ys), '--layer': layerColor(l), '--hatch': `${l.hatch}deg` }}
            >
              <div
                class="layer-tab"
                style={{ left: px(Math.max(0, -left)) }} // keep the name visible when the start is offscreen
                onPointerDown={(e) => startDrag(e, l, 'move')}
                onClick={stop}
              >
                {l.name}
              </div>
              {EDGES.map((edge) => (
                <div key={edge} class={`layer-edge layer-edge-${edge}`} onPointerDown={(e) => startDrag(e, l, edge)} onClick={stop} />
              ))}
            </div>
          );
        })}
    </div>
  );
}
