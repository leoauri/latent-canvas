// Renders the active onboarding guide (see guide.js): per step a ring around the element, a curved
// arrow and a label. Positions follow the elements every frame (windows move, the timeline pans).
import { useEffect, useState } from 'preact/hooks';
import { activeGuide, dismissGuide, refind } from './guide.js';
import './guide.css';

const GAP = 64; // label distance from the element
const PAD = 4; // ring padding

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** extra: how much further out than GAP the label goes (to dodge others). size: the label's measured { w, h }. */
function layout(step, k, extra = 0, size = { w: 180, h: 40 }) {
  const el = refind(step);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) return null;
  const vw = innerWidth;
  const vh = innerHeight;
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const room = { bottom: vh - r.bottom, top: r.top, right: vw - r.right, left: r.left };
  const side =
    step.side ??
    (room.bottom >= GAP + 40 || room.top >= GAP + 40 ? (room.bottom >= room.top ? 'bottom' : 'top') : room.right >= room.left ? 'right' : 'left');
  let ax, ay, from, to, transform, box;
  const { w, h } = size;
  const gap = GAP + extra;
  const sway = (k % 2 ? -1 : 1) * 18; // labels of neighbouring steps lean apart
  if (side === 'bottom' || side === 'top') {
    ax = clamp(cx + sway, 130, vw - 130);
    ax = clamp(ax, w / 2 + 8, vw - w / 2 - 8);
    ay = side === 'bottom' ? clamp(r.bottom + gap, 8, vh - h - 8) : clamp(r.top - gap, h + 8, vh - 8);
    transform = side === 'bottom' ? 'translate(-50%, 0)' : 'translate(-50%, -100%)';
    box = { x: ax - w / 2, y: side === 'bottom' ? ay : ay - h, w, h };
    from = [ax, side === 'bottom' ? ay - 4 : ay + 4];
    to = [clamp(cx, r.left + 6, r.right - 6), side === 'bottom' ? r.bottom + PAD + 4 : r.top - PAD - 4];
  } else {
    ay = clamp(cy + sway, 24, vh - 24);
    ay = clamp(ay, h / 2 + 8, vh - h / 2 - 8);
    ax = side === 'right' ? clamp(r.right + gap, 8, vw - w - 8) : clamp(r.left - gap, w + 8, vw - 8);
    transform = side === 'right' ? 'translate(0, -50%)' : 'translate(-100%, -50%)';
    box = { x: side === 'right' ? ax : ax - w, y: ay - h / 2, w, h };
    from = [side === 'right' ? ax - 4 : ax + 4, ay];
    to = [side === 'right' ? r.right + PAD + 4 : r.left - PAD - 4, clamp(cy, r.top + 6, r.bottom - 6)];
  }
  // A hand-drawn-looking bend: control point off the straight line, alternating per step.
  const [x1, y1] = from;
  const [x2, y2] = to;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const bend = (k % 2 ? -1 : 1) * 0.35;
  const c = [x1 + dx / 2 - dy * bend, y1 + dy / 2 + dx * bend];
  const ang = Math.atan2(y2 - c[1], x2 - c[0]);
  const head = (a) => [x2 - 11 * Math.cos(ang + a), y2 - 11 * Math.sin(ang + a)];
  const [h1, h2] = [head(0.45), head(-0.45)];
  const f = (n) => Math.round(n * 10) / 10;
  return {
    i: step.i,
    box,
    text: step.text,
    fallback: step.fallback,
    ring: { left: r.left - PAD, top: r.top - PAD, width: r.width + 2 * PAD, height: r.height + 2 * PAD },
    label: { left: ax, top: ay, transform },
    path: `M${f(x1)},${f(y1)} Q${f(c[0])},${f(c[1])} ${f(x2)},${f(y2)} M${f(h1[0])},${f(h1[1])} L${f(x2)},${f(y2)} L${f(h2[0])},${f(h2[1])}`,
  };
}

export function Guide() {
  const g = activeGuide.value;
  const [items, setItems] = useState([]);
  const [hot, setHot] = useState(false);

  useEffect(() => {
    if (!g) return void setItems([]);
    let raf;
    let last = '';
    const sizes = new Map(); // step index -> measured label size
    const measure = () => {
      for (const el of document.querySelectorAll('.guide-label[data-step]')) sizes.set(+el.dataset.step, { w: el.offsetWidth, h: el.offsetHeight });
    };
    const tick = () => {
      raf = requestAnimationFrame(tick);
      measure();
      const next = place(g.steps, sizes);
      const key = JSON.stringify(next);
      if (key !== last) {
        last = key;
        setItems(next);
      }
    };
    tick();
    // Using what a step points at dismisses the guide too (the click still goes through).
    const onDown = (e) => {
      if (e.target.closest?.('.guide')) return;
      if (g.steps.some((s) => s.el?.contains(e.target))) dismissGuide();
    };
    const onKey = (e) => e.key === 'Escape' && dismissGuide();
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [g]);

  useEffect(() => setHot(false), [g]);
  if (!g || !items.length) return null;

  const hover = {
    onPointerEnter: () => setHot(true),
    onPointerLeave: () => setHot(false),
    onClick: (e) => {
      e.stopPropagation();
      dismissGuide();
    },
  };
  return (
    <div class={`guide${hot ? ' guide-hot' : ''}`} aria-live="polite">
      {items.map((it) => (
        <div key={`r${it.i}`} class="guide-ring" style={px(it.ring)} />
      ))}
      <svg class="guide-arrows" width="100%" height="100%">
        {items.map((it) => (
          <g key={`a${it.i}`}>
            <path class="guide-arrow-under" d={it.path} />
            <path class="guide-arrow" d={it.path} />
            <path class="guide-arrow-hit" d={it.path} {...hover} />
          </g>
        ))}
      </svg>
      {items.map((it, k) => (
        <button
          key={`l${it.i}`}
          data-step={it.i}
          class={`guide-label${it.fallback ? ' guide-fallback' : ''}`}
          style={{ ...px(it.label), transform: it.label.transform }}
          title="Got it (click to hide all)"
          {...hover}
        >
          {k === 0 && <span class="guide-new">{g.title ? `New: ${g.title}` : 'New'}</span>}
          {it.text}
        </button>
      ))}
    </div>
  );
}

const px = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'transform').map(([k, v]) => [k, `${v}px`]));

const overlaps = (a, b, m = 6) => a.x < b.x + b.w + m && b.x < a.x + a.w + m && a.y < b.y + b.h + m && b.y < a.y + a.h + m;

/** Lays the steps out in order; a label that would cover another label or a pointed-at element moves further out. */
function place(steps, sizes) {
  const rings = [];
  const out = [];
  for (const [k, step] of steps.entries()) {
    const it = layout(step, k, 0, sizes.get(step.i));
    if (it) rings.push({ x: it.ring.left, y: it.ring.top, w: it.ring.width, h: it.ring.height });
  }
  for (const [k, step] of steps.entries()) {
    const size = sizes.get(step.i);
    let best = null;
    for (let n = 0; n < 6; n++) {
      const it = layout(step, k, n * ((size?.h ?? 40) + 10), size);
      if (!it) break;
      best ??= it;
      if (!out.some((o) => overlaps(o.box, it.box)) && !rings.some((r) => overlaps(r, it.box, 2))) {
        best = it;
        break;
      }
    }
    if (best) out.push(best);
  }
  return out;
}
