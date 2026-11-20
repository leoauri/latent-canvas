// Line-based three-way merge (node-diff3) for promoting VFS overlays onto the committed files.
import { diff3Merge, diffPatch } from 'node-diff3';

const lines = (s) => (s === '' ? [] : s.split('\n'));

/**
 * Merge `theirs` (the overlay) and `ours` (committed) against their common `base`. Strings only;
 * pass '' for a side that does not exist. Returns { clean, result, conflicts } where `result`
 * holds diff3-style conflict markers when not clean and `conflicts` counts conflicting regions.
 */
export function merge3(base, ours, theirs, labels = {}) {
  if (ours === theirs || theirs === base) return { clean: true, result: ours, conflicts: 0 };
  if (ours === base) return { clean: true, result: theirs, conflicts: 0 };
  const { ours: lo = 'committed', base: lb = 'base', theirs: lt = 'overlay' } = labels;
  const out = [];
  let conflicts = 0;
  for (const region of diff3Merge(lines(ours), lines(base), lines(theirs), { excludeFalseConflicts: true })) {
    if (region.ok) out.push(...region.ok);
    else {
      conflicts++;
      const c = region.conflict;
      out.push(`<<<<<<< ${lo}`, ...c.a, `||||||| ${lb}`, ...c.o, '=======', ...c.b, `>>>>>>> ${lt}`);
    }
  }
  return { clean: conflicts === 0, result: out.join('\n'), conflicts };
}

const MARKER_RE = /^(<<<<<<<|>>>>>>>)( |$)/m;
export const hasConflictMarkers = (s) => typeof s === 'string' && MARKER_RE.test(s);

/**
 * Stable, synchronous content hash (two seeded 53-bit cyrb53 runs, hex). Peers exchange base
 * hashes with it, so every peer must use this same function. null (absent file) hashes to null.
 */
export function hashSource(s) {
  if (s == null) return null;
  const run = (seed) => {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
  };
  return run(0) + run(0x9e3779b9);
}

/** A line diff of a -> b as hunks: "@@ -line +line" then "-" and "+" lines. '' when equal. */
export function lineDiff(a, b) {
  if (a === b) return '';
  const out = [];
  const hunks = diffPatch(lines(a ?? ''), lines(b ?? '')).sort((x, y) => x.buffer1.offset - y.buffer1.offset);
  for (const { buffer1: x, buffer2: y } of hunks) {
    out.push(`@@ -${x.offset + 1} +${y.offset + 1}`);
    for (const l of x.chunk) out.push(`-${l}`);
    for (const l of y.chunk) out.push(`+${l}`);
  }
  return out.join('\n');
}
