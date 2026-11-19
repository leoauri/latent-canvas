// Others in the session on the timeline: their cursors (interpolated) and selected clip,
// each in the peer's colour. Positions travel in timeline coordinates (seconds, world y), so they
// land in the right place whatever each viewer's zoom and scroll. Also publishes ours (net/presence.js).
// Hidden while presence.show is off (Session window, or Alt+P).
import { useEffect, useRef } from 'preact/hooks';
import { computed } from '@preact/signals';
import { persist } from '@live/runtime';
import * as presence from '../../net/presence.js';
import { view, timeToX, xToTime, worldToScreenY, screenToWorldY } from './view.js';
import { clips, selectedId, CLIP_HEIGHT } from './clips.js';

const DELAY_MS = 100; // cursors are drawn this far behind the latest update, interpolating between updates
const KEEP = 12; // cursor samples kept per peer

// ---- ours --------------------------------------------------------------------------------------

const cursor = persist('presence.cursor', null); // { t, y } in timeline coordinates, or null
const selection = computed(() => selectedId.value ?? null);

const unbind = [presence.publish('cursor', cursor), presence.publish('selection', selection)];

// ---- theirs: cursor samples for interpolation --------------------------------------------------

const samples = new Map(); // peerId -> [{ t, y, at (local ms) } | { gone: true, at }]
const offSamples = presence.others.subscribe((all) => {
  const now = performance.now();
  for (const [id, p] of Object.entries(all)) {
    const c = p.state.cursor;
    const list = samples.get(id) ?? [];
    const last = list[list.length - 1];
    const next = c && Number.isFinite(c.t) && Number.isFinite(c.y) ? { t: c.t, y: c.y, at: now } : { gone: true, at: now };
    if (last && (last.gone ? next.gone : !next.gone && last.t === next.t && last.y === next.y)) continue;
    list.push(next);
    if (list.length > KEEP) list.splice(0, list.length - KEEP);
    samples.set(id, list);
  }
  for (const id of samples.keys()) if (!all[id]) samples.delete(id);
});

/** Where peer `id`'s cursor is drawn at local time `now`: interpolated DELAY_MS behind, or null. */
function cursorAt(id, now) {
  const list = samples.get(id);
  if (!list?.length) return null;
  const at = now - DELAY_MS;
  let i = list.length - 1;
  while (i > 0 && list[i].at > at) i--;
  const a = list[i];
  const b = list[i + 1];
  if (a.gone && (!b || b.at > at)) return null;
  if (!b || a.gone) return a.gone ? null : { t: a.t, y: a.y };
  if (b.gone) return { t: a.t, y: a.y };
  // After a pause the previous sample is old: move from it over at most DELAY_MS, not the whole pause.
  const from = Math.max(a.at, b.at - DELAY_MS);
  const k = Math.min(1, Math.max(0, (at - from) / (b.at - from)));
  return { t: a.t + (b.t - a.t) * k, y: a.y + (b.y - a.y) * k };
}

// ---- the layer ---------------------------------------------------------------------------------

const Arrow = ({ color }) => (
  <svg class="presence-arrow" width="16" height="20" viewBox="0 0 16 20">
    <path d="M1 1 L1 16 L5 12 L8 19 L11 18 L8 11 L14 11 Z" fill={color} stroke="#fff" stroke-width="1.2" stroke-linejoin="round" />
  </svg>
);

export default function Presence() {
  const ref = useRef(null);

  // Our cursor, in timeline coordinates, while it's over the timeline.
  useEffect(() => {
    const host = ref.current.parentElement;
    const move = (e) => {
      const r = host.getBoundingClientRect();
      cursor.value = { t: xToTime(e.clientX - r.left), y: screenToWorldY(e.clientY - r.top) };
    };
    const leave = () => (cursor.value = null);
    const key = (e) => {
      if (e.altKey && e.code === 'KeyP' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        presence.show.value = !presence.show.value;
      }
    };
    host.addEventListener('pointermove', move, { passive: true });
    host.addEventListener('pointerleave', leave);
    window.addEventListener('keydown', key);
    return () => {
      host.removeEventListener('pointermove', move);
      host.removeEventListener('pointerleave', leave);
      window.removeEventListener('keydown', key);
      cursor.value = null;
    };
  }, []);

  // Cursors move every frame: positioned directly, not re-rendered.
  useEffect(() => {
    let frame = requestAnimationFrame(function step() {
      const el = ref.current;
      if (!el) return;
      const now = performance.now();
      const v = view.peek();
      for (const node of el.querySelectorAll('[data-cursor]')) {
        const c = cursorAt(node.dataset.cursor, now);
        node.style.display = c ? '' : 'none';
        if (c) node.style.transform = `translate(${timeToX(c.t, v)}px, ${worldToScreenY(c.y, v)}px)`;
      }
      frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const peers = presence.show.value ? Object.entries(presence.others.value) : [];
  const v = view.value;
  const byId = new Map(clips.value.map((c) => [c.id, c]));
  return (
    <div ref={ref} class="presence-layer">
      {peers.map(([id, p]) => {
        const sel = byId.get(p.state.selection);
        return (
          <div key={id} class="presence-peer">
            {sel && (
              <div
                class="presence-selection"
                style={{
                  borderColor: p.color,
                  left: `${timeToX(sel.t, v) - 3}px`,
                  top: `${worldToScreenY(sel.y, v) - 3}px`,
                  width: `${Math.max(2, (sel.length * v.pps) / sel.rate) + 6}px`,
                  height: `${CLIP_HEIGHT + 6}px`,
                }}
              />
            )}
            <div data-cursor={id} class="presence-cursor" style={{ display: 'none' }}>
              <Arrow color={p.color} />
              <span class="presence-name" style={{ background: p.color }}>
                {p.name}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function dispose() {
  for (const f of unbind) f();
  offSamples();
}
