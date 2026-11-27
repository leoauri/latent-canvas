import { useRef, useEffect } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import {
  stack, LAYER_TYPES, typeColor, stackLayerColor, insertLayer, moveLayer, removeStackLayer,
  activeLayer, activeLayerId, highlightedLayerId, layerIo, toggleArm, togglePassThrough, toggleBypass, stackLayerById,
} from './stack.js';
import { readDrop, attachModel, runtimes } from './models.js';
import { recordings } from './recorder.js';
import { layers as masks, masked, isMasked, masksOf, maskTools, openMaskTools, closeMaskTools } from '../timeline/layers.js';
import { LayerDetails } from './LayerConfig.jsx';
import { isAssetDrag, assetOf, assetKind, modelFilesFor } from '../assetDrag.js';
import './stack.css';

const DRAG_SLOP = 4;

export default function LayerStack() {
  const hover = useSignal(false);
  const pinned = useSignal(false);
  const paletteOpen = useSignal(false);
  /** { kind: 'new'|'move', type, id, x, y, gap, started } */
  const drag = useSignal(null);
  /** An OS file drag over the stack: { overId } (the card under it), else null. */
  const fileDrag = useSignal(null);
  const dropError = useSignal(null);
  const holdHeight = useSignal(null);
  const root = useRef(null);
  const list = useRef(null);

  const expanded = hover.value || pinned.value || !!drag.value || !!fileDrag.value;
  const layers = stack.value;

  useEffect(() => {
    const el = root.current;
    const stopWheel = (e) => e.stopPropagation();
    const outside = (e) => {
      if (!el.contains(e.target)) (pinned.value = false), (paletteOpen.value = false);
    };
    // A file dropped outside the stack must not make the browser open it.
    const noOpen = (e) => e.dataTransfer?.types.includes('Files') && !el.contains(e.target) && e.preventDefault();
    el.addEventListener('wheel', stopWheel);
    document.addEventListener('pointerdown', outside);
    window.addEventListener('dragover', noOpen);
    window.addEventListener('drop', noOpen);
    return () => {
      el.removeEventListener('wheel', stopWheel);
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('dragover', noOpen);
      window.removeEventListener('drop', noOpen);
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
        // Bottom-anchored: a smaller details panel would shrink the stack out from under the pointer.
        if (hover.value && root.current) holdHeight.value = root.current.getBoundingClientRect().height;
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

  // Model drops: on an operator card that layer runs the model; anywhere else in the stack a new
  // operator layer gets it (in front of the card it was dropped on, else in front of everything).
  const isFileDrag = (e) => e.dataTransfer?.types.includes('Files') || isAssetDrag(e);
  const onDragOver = (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const overId = e.target.closest?.('.stack-card')?.dataset.layerId ?? null;
    if (fileDrag.value?.overId !== overId) fileDrag.value = { overId };
    dropError.value = null;
  };
  const onDragLeave = (e) => {
    if (!root.current.contains(e.relatedTarget)) fileDrag.value = null;
  };
  const onDrop = (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    const over = stackLayerById(fileDrag.value?.overId);
    fileDrag.value = null;
    const asset = isAssetDrag(e) ? assetOf(e.dataTransfer) : null;
    if (isAssetDrag(e) && assetKind(asset) !== 'model') {
      dropError.value = assetKind(asset) === 'clip' ? 'clip data goes on the canvas, not the stack' : `“${asset?.name ?? 'file'}” is not a model file`;
      return;
    }
    const read = asset ? modelFilesFor(asset.hash) : readDrop(e.dataTransfer); // takes the entries now, inside the event
    (async () => {
      let files, name;
      try {
        ({ files, name } = await read);
      } catch (err) {
        dropError.value = String(err?.message || err);
        return;
      }
      let id = over?.type === 'operator' ? over.id : null;
      const created = !id;
      if (created) id = insertLayer('operator', over ? stack.value.indexOf(over) + 1 : stack.value.length).id;
      activeLayerId.value = id;
      try {
        await attachModel(id, files, name);
      } catch (err) {
        if (created) removeStackLayer(id);
        dropError.value = String(err?.message || err);
      }
    })();
  };

  const d = drag.value;
  const gap = d?.started ? d.gap : null;
  const active = activeLayer();
  masked.value, masks.value; // re-render on mask changes
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
          data-layer-id={l.id}
          class={`stack-card${moving ? ' stack-card-moving' : ''}${active?.id === l.id ? ' stack-card-active' : ''}${fileDrag.value?.overId === l.id ? ' stack-card-drop' : ''}`}
          style={{ '--c': stackLayerColor(l) }}
          title="Click: select · ◩: mask tools · Drag: reorder"
          onPointerDown={(e) => expanded && startDrag(e, { kind: 'move', id: l.id, type: l.type })}
          onPointerEnter={() => (highlightedLayerId.value = l.id)}
          onPointerLeave={() => highlightedLayerId.value === l.id && (highlightedLayerId.value = null)}
        >
          <span class="stack-glyph">{t.glyph}</span>
          <span class="stack-text">
            <span class="stack-name">{l.name}</span>
            <span class="stack-io">
              {layerIo(l, runtimes.value[l.id]?.model)}
            </span>
          </span>
          <button
            class={`stack-mask${isMasked(l.id) ? ' stack-mask-on' : ''}${maskTools.value?.layerId === l.id ? ' stack-mask-open' : ''}`}
            title={`${isMasked(l.id) ? (masksOf(l.id).length ? 'Masked: operates only inside its mask' : 'Masked to nothing: operates nowhere') : 'Unmasked: operates everywhere'}. Click: mask tools`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              activeLayerId.value = l.id;
              if (maskTools.value?.layerId === l.id) return closeMaskTools();
              const card = e.currentTarget.closest('.stack').getBoundingClientRect();
              const icon = e.currentTarget.getBoundingClientRect();
              openMaskTools(l.id, card.right + 8, icon.top + icon.height / 2);
            }}
          >
            ◩
          </button>
          {l.type === 'operator' && l.func && !l.model && (
            <button
              class={`stack-thru stack-bypass${!l.bypass ? ' stack-thru-on' : ''}`}
              title={l.bypass ? 'Bypassed: everything passes unchanged. Click to activate' : 'Active. Click to bypass'}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => toggleBypass(l.id)}
            >
              ⏻
            </button>
          )}
          {l.type === 'latent' && (
            <>
              <button
                class={`stack-thru${l.passThrough !== false ? ' stack-thru-on' : ''}`}
                title={l.passThrough !== false ? 'Pass-through on: the latents reaching this layer go on, beside its clips. Click to turn off' : 'Pass-through off: only its clips go on. Click to turn on'}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => togglePassThrough(l.id)}
              >
                ⇡
              </button>
              <button
                class={`stack-arm${l.armed ? ' stack-arm-on' : ''}${recordings.value[l.id] ? ' stack-arm-rec' : ''}`}
                title={recordings.value[l.id] ? 'Recording' : l.armed ? 'Armed: records while playing with Rec on. Click to disarm' : 'Arm: record the latent stream reaching this layer while playing with Rec on'}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => toggleArm(l.id)}
              >
                ●
              </button>
            </>
          )}
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
      style={{
        '--layer': active ? stackLayerColor(active) : undefined,
        minHeight: expanded && holdHeight.value ? `${holdHeight.value}px` : undefined,
        boxSizing: 'border-box',
      }}
      onPointerEnter={(e) => e.pointerType === 'mouse' && (hover.value = true)}
      onPointerLeave={(e) => e.pointerType === 'mouse' && ((hover.value = false), (holdHeight.value = null))}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={() => !expanded && (pinned.value = true)}
      onDragEnter={onDragOver}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
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
          {fileDrag.value && (
            <div class="stack-target stack-drop-hint">
              {stackLayerById(fileDrag.value.overId)?.type === 'operator'
                ? <>Drop: <b>{stackLayerById(fileDrag.value.overId).name}</b> runs this model</>
                : 'Drop on an operator layer, or here for a new one'}
            </div>
          )}
          {dropError.value && (
            <div class="stack-target stack-drop-error" title="Click to dismiss" onClick={() => (dropError.value = null)}>
              Model not added: {dropError.value}
            </div>
          )}
          {active && (
            <div class="stack-target" style={{ '--c': stackLayerColor(active) }}>
              Edit the mask of <b>{active.name}</b> with ◩
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
