import { useRef, useEffect } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import {
  stack, LAYER_TYPES, typeColor, stackLayerColor, insertLayer, moveLayer, removeStackLayer,
  activeLayer, activeLayerId, highlightedLayerId,
} from './stack.js';
import { layers as masks } from '../timeline/layers.js';
import { ChatBubble, LayerDetails } from './LayerConfig.jsx';
import './stack.css';

const DRAG_SLOP = 4;

export default function LayerStack() {
  const hover = useSignal(false);
  const pinned = useSignal(false);
  const paletteOpen = useSignal(false);
  /** { kind: 'new'|'move', type, id, x, y, gap, started } */
  const drag = useSignal(null);
  const root = useRef(null);
  const list = useRef(null);

  const expanded = hover.value || pinned.value || !!drag.value;
  const layers = stack.value;

  useEffect(() => {
    const el = root.current;
    const stopWheel = (e) => e.stopPropagation();
    const outside = (e) => {
      if (!el.contains(e.target)) (pinned.value = false), (paletteOpen.value = false);
    };
    el.addEventListener('wheel', stopWheel);
    document.addEventListener('pointerdown', outside);
    return () => {
      el.removeEventListener('wheel', stopWheel);
      document.removeEventListener('pointerdown', outside);
    };
  }, []);

  /** Gap index (0 = behind everything, n = in front) under the pointer, or null if off the list. */
  const gapAt = (x, y) => {
    const box = list.current?.getBoundingClientRect();
    if (!box || x < box.left - 40 || x > box.right + 40 || y < box.top - 40 || y > box.bottom + 40) return null;
    const cards = list.current.querySelectorAll('.stack-card');
    let behind = 0;
    cards.forEach((c) => {
      const r = c.getBoundingClientRect();
      if (r.top + r.height / 2 > y) behind++;
    });
    return behind;
  };

  const startDrag = (e, payload) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX, y0 = e.clientY;
    drag.value = { ...payload, x: x0, y: y0, gap: null, started: false };
    const move = (ev) => {
      const d = drag.value;
      const started = d.started || Math.hypot(ev.clientX - x0, ev.clientY - y0) > DRAG_SLOP;
      drag.value = { ...d, x: ev.clientX, y: ev.clientY, started, gap: started ? gapAt(ev.clientX, ev.clientY) : null };
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      const d = drag.value;
      drag.value = null;
      if (ev.type === 'pointercancel') return;
      if (!d.started) {
        if (d.kind === 'new') (activeLayerId.value = insertLayer(d.type).id), (paletteOpen.value = false);
        else activeLayerId.value = d.id;
        return;
      }
      if (d.gap == null) return;
      if (d.kind === 'new') activeLayerId.value = insertLayer(d.type, d.gap).id;
      else moveLayer(d.id, d.gap);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const d = drag.value;
  const gap = d?.started ? d.gap : null;
  const active = activeLayer();
  const maskCount = {};
  for (const m of masks.value) maskCount[m.layerId] = (maskCount[m.layerId] ?? 0) + 1;
  // Front first on screen: render indices n-1..0, with gaps n..0 interleaved.
  const rows = [];
  for (let i = layers.length; i >= 0; i--) {
    rows.push(<div key={`gap-${i}`} class={`stack-gap${gap === i ? ' stack-gap-active' : ''}`} />);
    if (i > 0) {
      const l = layers[i - 1];
      const t = LAYER_TYPES[l.type];
      const moving = d?.started && d.kind === 'move' && d.id === l.id;
      rows.push(
        <div
          key={l.id}
          class={`stack-card${moving ? ' stack-card-moving' : ''}${active?.id === l.id ? ' stack-card-active' : ''}`}
          style={{ '--c': stackLayerColor(l) }}
          title="Click: select (Shift+drag on the canvas adds masks to it) · Drag: reorder"
          onPointerDown={(e) => expanded && startDrag(e, { kind: 'move', id: l.id, type: l.type })}
          onPointerEnter={() => (highlightedLayerId.value = l.id)}
          onPointerLeave={() => highlightedLayerId.value === l.id && (highlightedLayerId.value = null)}
        >
          <span class="stack-glyph">{t.glyph}</span>
          <span class="stack-text">
            <span class="stack-name">{l.name}</span>
            <span class="stack-io">
              {t.io} · {maskCount[l.id] ? `${maskCount[l.id]} mask${maskCount[l.id] > 1 ? 's' : ''}` : 'unmasked'}
            </span>
          </span>
          <ChatBubble layer={l} />
          <button
            class="stack-remove"
            title="Remove layer and its masks"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => removeStackLayer(l.id)}
          >
            ×
          </button>
        </div>,
      );
      if (active?.id === l.id && !moving) rows.push(<LayerDetails key={`details-${l.id}`} layer={l} />);
    }
  }

  return (
    <div
      ref={root}
      class={`stack${expanded ? ' stack-expanded' : ''}`}
      style={{ '--layer': active ? stackLayerColor(active) : undefined }}
      onPointerEnter={(e) => e.pointerType === 'mouse' && (hover.value = true)}
      onPointerLeave={(e) => e.pointerType === 'mouse' && (hover.value = false)}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={() => !expanded && (pinned.value = true)}
    >
      {expanded ? (
        <>
          <div class="stack-head">
            <span class="stack-title">Layers</span>
            <span class="stack-hint">front ↑</span>
            <button
              class={`stack-add${paletteOpen.value ? ' stack-add-open' : ''}`}
              title="Add layer"
              onClick={() => (paletteOpen.value = !paletteOpen.value)}
            >
              +
            </button>
          </div>
          {paletteOpen.value && (
            <div class="stack-palette">
              {Object.entries(LAYER_TYPES).map(([type, t]) => (
                <div
                  key={type}
                  class="stack-chip"
                  style={{ '--c': typeColor(type) }}
                  title="Click: add in front · Drag: place in stack"
                  onPointerDown={(e) => startDrag(e, { kind: 'new', type })}
                >
                  <span class="stack-glyph">{t.glyph}</span>
                  {t.label}
                </div>
              ))}
            </div>
          )}
          <div ref={list} class="stack-list">
            {layers.length ? rows : <div class="stack-empty">Drag a layer type here</div>}
            {!layers.length && <div class={`stack-gap${gap === 0 ? ' stack-gap-active' : ''}`} />}
          </div>
          <div class="stack-foot">back · data flows up</div>
          {active && (
            <div class="stack-target" style={{ '--c': stackLayerColor(active) }}>
              Shift+drag on canvas: add mask to <b>{active.name}</b> · Alt+drag: move mask · Del: remove
            </div>
          )}
        </>
      ) : (
        <div class="stack-mini" title="Layers">
          {[...layers].reverse().map((l) => (
            <div key={l.id} class={`stack-mini-bar${active?.id === l.id ? ' stack-mini-active' : ''}`} style={{ '--c': stackLayerColor(l) }} />
          ))}
          {!layers.length && <div class="stack-mini-bar stack-mini-empty" />}
        </div>
      )}
      {d?.started && (
        <div
          class="stack-ghost"
          style={{ left: `${d.x + 10}px`, top: `${d.y + 10}px`, '--c': typeColor(d.type) }}
        >
          {LAYER_TYPES[d.type].glyph} {d.kind === 'new' ? LAYER_TYPES[d.type].label : layers.find((l) => l.id === d.id)?.name}
        </div>
      )}
    </div>
  );
}
