// Page-state persistence in IndexedDB. Stores: kv (structured-clone values by key),
// blobs (large typed arrays, e.g. clip vectors), chats (full transcripts by id).
import { persist } from '@live/runtime';

const STORES = ['kv', 'blobs', 'chats'];
const conn = persist('db.conn', null);
const hydrated = persist('db.hydrated', () => new Set());

function open() {
  navigator.storage?.persist?.().catch(() => {});
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('redaw', 1);
    r.onupgradeneeded = () => {
      for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s);
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
const db = () => (conn.value ??= open());

const req = (r) =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
const done = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });

export async function get(store, key) {
  return req((await db()).transaction(store).objectStore(store).get(key));
}
export async function keys(store) {
  return req((await db()).transaction(store).objectStore(store).getAllKeys());
}
export async function put(store, key, value) {
  const tx = (await db()).transaction(store, 'readwrite');
  tx.objectStore(store).put(value, key);
  return done(tx);
}
export async function del(store, key) {
  const tx = (await db()).transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  return done(tx);
}

/** Runs `fn` once per page load for `key` (not again when modules are hot-swapped). */
export function once(key, fn) {
  if (hydrated.value.has(key)) return Promise.resolve();
  hydrated.value.add(key);
  return Promise.resolve().then(fn).catch((e) => console.warn(`db: hydrating ${key} failed`, e));
}

const flushers = new Set();
const flushAll = () => flushers.forEach((f) => f());
const onHidden = () => document.visibilityState === 'hidden' && flushAll();
document.addEventListener('visibilitychange', onHidden);
window.addEventListener('pagehide', flushAll);
export function dispose() {
  document.removeEventListener('visibilitychange', onHidden);
  window.removeEventListener('pagehide', flushAll);
}

/**
 * Mirrors a signal to kv[key]: restores it once per page load, then writes changes (debounced).
 * hydrate(stored) may be async and returns the signal's value; write(value) replaces the kv put.
 * Returns an unbind function that flushes a pending write.
 */
export function sync(signal, key, { hydrate = (v) => v, write = (v) => put('kv', key, v), delay = 250 } = {}) {
  let timer = 0;
  let pending = null;
  let unsub = null;
  let stopped = false;
  const flush = () => {
    if (!pending) return;
    clearTimeout(timer);
    const v = pending.v;
    pending = null;
    Promise.resolve(write(v)).catch((e) => console.warn(`db: saving ${key} failed`, e));
  };
  once(`sync:${key}`, async () => {
    const stored = await get('kv', key);
    if (stored !== undefined) signal.value = await hydrate(stored);
  }).then(() => {
    if (stopped) return;
    let first = true;
    unsub = signal.subscribe((v) => {
      if (first) return void (first = false);
      pending = { v };
      clearTimeout(timer);
      timer = setTimeout(flush, delay);
    });
    flushers.add(flush);
  });
  return () => {
    stopped = true;
    unsub?.();
    flush();
    flushers.delete(flush);
  };
}
