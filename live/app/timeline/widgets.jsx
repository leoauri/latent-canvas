// Default input widgets for layer parameters. Every widget is a preact component taking
// { value, onChange, default } plus its own options (min, max, step, ...) from the param's meta.
// Keep this module to widget exports only: all of them are put in scope for layer functions.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const quantize = (v, min, step) => (step ? min + Math.round((v - min) / step) * step : v);
const fmt = (v) => (typeof v === 'number' ? String(+v.toPrecision(4)) : String(v ?? ''));

/** Rotary knob over [min, max]. Drag vertically (Shift: fine), wheel to nudge, double-click resets. */
export function Knob({ value, onChange, min = 0, max = 1, step, default: def, size = 30 }) {
  const v = clamp(Number(value ?? def ?? min), min, max);
  const frac = max > min ? (v - min) / (max - min) : 0;
  const set = (x) => onChange(clamp(quantize(x, min, step), min, max));
  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const y0 = e.clientY, v0 = v;
    const move = (ev) => set(v0 + ((y0 - ev.clientY) / 150) * (max - min) * (ev.shiftKey ? 0.1 : 1));
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  const onWheel = (e) => {
    e.preventDefault();
    set(v - Math.sign(e.deltaY) * (step || (max - min) / 100));
  };
  const r = 11, c = 2 * Math.PI * r, arc = 0.75 * c;
  return (
    <span class="w-knob">
      <svg
        viewBox="0 0 30 30"
        width={size}
        height={size}
        onPointerDown={onPointerDown}
        onWheel={onWheel}
        onDblClick={() => def !== undefined && onChange(def)}
        role="slider"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={v}
      >
        <g transform="rotate(135 15 15)">
          <circle class="w-knob-track" cx="15" cy="15" r={r} stroke-dasharray={`${arc} ${c}`} />
          <circle class="w-knob-value" cx="15" cy="15" r={r} stroke-dasharray={`${arc * frac} ${c}`} />
        </g>
        <line class="w-knob-pointer" x1="15" y1="15" x2="15" y2="7" transform={`rotate(${-135 + 270 * frac} 15 15)`} />
      </svg>
      <span class="w-value">{fmt(v)}</span>
    </span>
  );
}

/** Horizontal slider over [min, max] with its value. */
export function Slider({ value, onChange, min = 0, max = 1, step, default: def }) {
  const v = Number(value ?? def ?? min);
  return (
    <span class="w-slider">
      <input type="range" min={min} max={max} step={step ?? 'any'} value={v} onInput={(e) => onChange(Number(e.currentTarget.value))} onDblClick={() => def !== undefined && onChange(def)} />
      <span class="w-value">{fmt(v)}</span>
    </span>
  );
}

/** Numeric field; commits on change (Enter/blur). */
export function NumberInput({ value, onChange, min, max, step, default: def }) {
  return (
    <input
      class="w-number"
      type="number"
      min={min}
      max={max}
      step={step ?? 'any'}
      value={value ?? def ?? ''}
      onChange={(e) => {
        const n = Number(e.currentTarget.value);
        if (e.currentTarget.value !== '' && Number.isFinite(n)) onChange(clamp(n, min ?? -Infinity, max ?? Infinity));
      }}
    />
  );
}

/** Single-line text field. */
export function TextInput({ value, onChange, default: def, placeholder }) {
  return <input class="w-text" type="text" value={value ?? def ?? ''} placeholder={placeholder} onInput={(e) => onChange(e.currentTarget.value)} />;
}
