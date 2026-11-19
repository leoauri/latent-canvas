// Fetches every file the open session's composition references as soon as it appears in the
// document, rather than when something first uses it, so each peer holds the whole composition
// (and can serve it to others) even if it never plays it. A reference is any blob id in the
// document's state (clip data, model files, …); code changes and history are not scanned.
import { effect } from '@preact/signals';
import * as blobs from './blobs.js';
import * as session from './session.js';

const HASH_RE = /^sha256-[0-9a-f]{64}$/;
const DEBOUNCE_MS = 500;

/** Every blob id in a value (strings, and Automerge text objects with a string `val`). */
export function blobIds(value, out = new Set()) {
  const walk = (v) => {
    const s = typeof v === 'string' ? v : v && typeof v === 'object' && !Array.isArray(v) && typeof v.val === 'string' ? v.val : null;
    if (s !== null) {
      if (s.length === 71 && HASH_RE.test(s)) out.add(s);
      return;
    }
    if (!v || typeof v !== 'object' || ArrayBuffer.isView(v) || v instanceof Date) return;
    for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x);
  };
  walk(value);
  return out;
}

const requested = new Set(); // ids this instance is fetching or has fetched
let timer = null;
let disposed = false;

function sweep() {
  timer = null;
  const h = session.handle.peek();
  if (disposed || !h) return;
  for (const id of blobIds(h.doc()?.state)) {
    if (requested.has(id) || blobs.has(id)) continue;
    requested.add(id);
    // Waits while no peer has it. Rejects if removed or cancelled here: a later change retries.
    blobs.ensure(id).catch(() => requested.delete(id));
  }
}

const stop = effect(() => {
  session.handle.value;
  session.version.value;
  clearTimeout(timer);
  timer = setTimeout(sweep, DEBOUNCE_MS);
});

export function dispose() {
  disposed = true;
  stop();
  clearTimeout(timer);
}
