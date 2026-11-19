// Streaming band-limited resampler at any ratio (Kaiser-windowed sinc, interpolated table).
// Output sample k sits at input position k * inRate / outRate: zero phase, so times map exactly;
// a sample comes out once the input reaches `half` samples past it.
const ZERO_CROSSINGS = 16, PHASES = 512, BETA = 8.6;

function bessel0(x) {
  let s = 1, t = 1;
  for (let k = 1; k < 40; k++) s += t *= (x / (2 * k)) ** 2;
  return s;
}

export function createResampler(inRate, outRate) {
  const step = inRate / outRate;
  const down = Math.min(1, outRate / inRate);
  const cut = 0.94 * down; // of the input's Nyquist
  const half = Math.ceil(ZERO_CROSSINGS / down);
  const table = new Float32Array(half * PHASES + 2);
  const i0b = bessel0(BETA);
  for (let i = 0; i < table.length; i++) {
    const u = i / PHASES;
    if (u >= half) continue;
    const w = bessel0(BETA * Math.sqrt(1 - (u / half) ** 2)) / i0b;
    table[i] = cut * w * (u === 0 ? 1 : Math.sin(Math.PI * cut * u) / (Math.PI * cut * u));
  }
  const kernel = (u) => {
    u = Math.abs(u) * PHASES;
    const i = u | 0;
    return i >= table.length - 1 ? 0 : table[i] + (table[i + 1] - table[i]) * (u - i);
  };
  let buf = new Float32Array(half), base = -half; // buf[0] is input sample `base`; zeros before 0
  let k = 0;
  return {
    /** Feeds input samples; returns the output samples now complete. */
    push(x) {
      const next = new Float32Array(buf.length + x.length);
      next.set(buf);
      next.set(x, buf.length);
      buf = next;
      const end = base + buf.length;
      const out = [];
      for (;;) {
        const pos = k * step, c = Math.floor(pos);
        if (c + half >= end) break;
        let acc = 0;
        for (let j = c - half + 1; j <= c + half; j++) acc += buf[j - base] * kernel(pos - j);
        out.push(acc);
        k++;
      }
      const keep = Math.floor(k * step) - half + 1;
      if (keep > base) (buf = buf.slice(keep - base)), (base = keep);
      return Float32Array.from(out);
    },
  };
}
