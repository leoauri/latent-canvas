// Mask editing overlay (the shading itself is drawn in stack order by TimelineCanvas.jsx).
// The mask toolbar opens next to a layer's mask icon in the stack. With a tool selected (marquee,
// horizontal stripe: dragged y range at all times, vertical stripe: dragged time range at all heights)
// a plain drag adds to that layer's mask and Alt+drag cuts. Without one, drags are left to the canvas.
import { useEffect, useRef } from 'preact/hooks';
import { signal } from '@preact/signals';
import { view, timeToX, xToTime, worldToScreenY, screenToWorldY } from './view.js';
import { addMaskArea, cutMaskArea, clearMask, setEmptyMask, isMasked, masked, maskTools, maskTool, closeMaskTools, BIG } from './layers.js';
import { activeLayer, stackLayerById, stackLayerColor, hasMaskTools } from '../stack/stack.js';

const MIN_PX = 4;
function StripeIcon({ d }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" style={{ display: 'block', margin: 'auto' }}>
      <rect x="2" y="2" width="12" height="12" rx="1" stroke="currentColor" stroke-width="1.2" fill="none" />
      <path d={d} stroke="currentColor" stroke-width="1.2" fill="none" />
    </svg>
  );
}
const TOOLS = [
  { id: 'rect', glyph: '⬚', title: 'Marquee' },
  { id: 'hstripe', glyph: <StripeIcon d="M2 6h12M2 10h12" />, title: 'Horizontal stripe: all time, dragged height range' },
  { id: 'vstripe', glyph: <StripeIcon d="M6 2v12M10 2v12" />, title: 'Vertical stripe: all heights, dragged time range' },
];
/** Drag in progress: { a, b: {t, y}, cut, tool }. */
const pending = signal(null);

function areaOf({ a, b, tool }) {
  const t = Math.min(a.t, b.t), dur = Math.abs(b.t - a.t), y = Math.min(a.y, b.y), h = Math.abs(b.y - a.y);
  if (tool === 'hstripe') return { t: -BIG, dur: 2 * BIG, y, h };
  if (tool === 'vstripe') return { t, dur, y: -BIG, h: 2 * BIG };
  return { t, dur, y, h };
}
function tooSmall(area, v) {
  return (area.dur < BIG && area.dur * v.pps < MIN_PX) || (area.h < BIG && area.h * v.ys < MIN_PX);
}

const px = (n) => `${n}px`;
const clampX = (x, w) => Math.max(-10, Math.min(w + 10, x));
const stop = (e) => e.stopPropagation();

/** The layer whose toolbar is open with a tool selected: plain drags edit its mask. */
function toolTarget() {
  const open = maskTools.value;
  return open && maskTool.value ? stackLayerById(open.layerId) : null;
}

export default function Layers() {
  const ref = useRef(null);

  useEffect(() => {
    const host = ref.current.parentElement;
    let suppressClick = false;
    const local = (e) => {
      const r = host.getBoundingClientRect();
      return { t: xToTime(e.clientX - r.left), y: screenToWorldY(e.clientY - r.top) };
    };

    // Capture phase, so the clip canvas never sees these gestures.
    const onPointerDownCapture = (e) => {
      if (e.button !== 0 || e.target.closest('.stack, .mask-tools')) return;
      const owner = toolTarget();
      if (!owner) return;
      const tool = maskTool.value;
      e.preventDefault();
      e.stopImmediatePropagation();
      suppressClick = true;
      const a = local(e);
      pending.value = { a, b: a, cut: e.altKey, tool };
      const move = (ev) => (pending.value = { a, b: local(ev), cut: ev.altKey, tool });
      const end = (ev) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
        const p = pending.value;
        pending.value = null;
        if (ev.type !== 'pointerup' || !p) return;
        const area = areaOf(p);
        if (tooSmall(area, view.value)) return;
        (p.cut ? cutMaskArea : addMaskArea)(owner.id, area);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
    };
    const onClickCapture = (e) => {
      if (!suppressClick) return;
      suppressClick = false;
      e.stopImmediatePropagation();
    };
    const onKeyDown = (e) => {
      if (e.key !== 'Escape' || !maskTools.value || e.target.closest?.('input, textarea, [contenteditable]')) return;
      if (maskTool.value) maskTool.value = null;
      else closeMaskTools();
    };
    host.addEventListener('pointerdown', onPointerDownCapture, true);
    host.addEventListener('click', onClickCapture, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      host.removeEventListener('pointerdown', onPointerDownCapture, true);
      host.removeEventListener('click', onClickCapture, true);
      window.removeEventListener('keydown', onKeyDown);
      pending.value = null;
    };
  }, []);

  // Close the toolbar when its layer is deleted or takes no masks.
  const open = maskTools.value;
  const found = open && stackLayerById(open.layerId);
  const owner = found && hasMaskTools(found) ? found : null;
  useEffect(() => {
    if (open && !owner) closeMaskTools();
  }, [open, owner]);

  // Follow the icon while the stack reflows (selecting a layer expands its details); keep the last spot
  // when the stack collapses.
  const openId = open?.layerId;
  useEffect(() => {
    if (!openId) return;
    let frame = requestAnimationFrame(function follow() {
      const icon = document.querySelector(`.stack [data-layer-id="${openId}"] .stack-mask`);
      const cur = maskTools.peek();
      if (icon && cur?.layerId === openId) {
        const s = icon.closest('.stack').getBoundingClientRect(), i = icon.getBoundingClientRect();
        const x = s.right + 8, y = i.top + i.height / 2;
        if (Math.abs(x - cur.x) > 0.5 || Math.abs(y - cur.y) > 0.5) maskTools.value = { ...cur, x, y };
      }
      frame = requestAnimationFrame(follow);
    });
    return () => cancelAnimationFrame(frame);
  }, [openId]);

  const v = view.value;
  const active = activeLayer();
  const p = pending.value;
  masked.value; // re-render the Clear / Add mask button
  const target = toolTarget();
  const host = ref.current?.parentElement;
  if (host) host.style.cursor = target ? 'crosshair' : '';

  let preview = null;
  if (p) {
    const area = areaOf(p);
    const w = ref.current?.clientWidth ?? 0, hh = ref.current?.clientHeight ?? 0;
    const x0 = clampX(timeToX(area.t, v), w), x1 = clampX(timeToX(area.t + area.dur, v), w);
    const y0 = Math.max(-10, Math.min(hh + 10, worldToScreenY(area.y, v)));
    const y1 = Math.max(-10, Math.min(hh + 10, worldToScreenY(area.y + area.h, v)));
    preview = (
      <div
        class={`mask-preview${p.cut ? ' mask-preview-cut' : ''}`}
        style={{ left: px(x0), top: px(y0), width: px(x1 - x0), height: px(y1 - y0) }}
      />
    );
  }

  let toolbar = null;
  if (owner) {
    const r = ref.current?.getBoundingClientRect() ?? { left: 0, top: 0, width: 1e4, height: 1e4 };
    const left = Math.max(4, Math.min(r.width - 260, open.x - r.left));
    const top = Math.max(18, Math.min(r.height - 18, open.y - r.top)); // the toolbar is centred on top
    const isOn = isMasked(owner.id);
    toolbar = (
      <div
        class="mask-tools"
        style={{ left: px(left), top: px(top), '--layer': stackLayerColor(owner) }}
        onPointerDown={stop}
        onClick={stop}
      >
        <span class="mask-tools-name">{owner.name}</span>
        {TOOLS.map((t) => (
          <button
            key={t.id}
            class={`mask-tool${maskTool.value === t.id ? ' mask-tool-on' : ''}`}
            title={`${t.title} · Drag: add · Alt+drag: cut`}
            onClick={() => (maskTool.value = maskTool.value === t.id ? null : t.id)}
          >
            {t.glyph}
          </button>
        ))}
        <button
          class="mask-tools-action"
          title={isOn ? 'Remove the mask: the layer operates everywhere' : 'Add an empty mask: the layer operates nowhere until you add areas'}
          onClick={() => (isOn ? clearMask : setEmptyMask)(owner.id)}
        >
          {isOn ? 'Clear' : 'Add mask'}
        </button>
        <button class="mask-tool" title="Close (Esc)" onClick={closeMaskTools}>
          ×
        </button>
      </div>
    );
  }

  return (
    <div ref={ref} class="layers" style={{ '--layer': target || active ? stackLayerColor(target ?? active) : 'transparent' }}>
      {preview}
      {toolbar}
    </div>
  );
}
