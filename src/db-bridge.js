// Dev only: answers the dev server's read requests for this page's IndexedDB, so tools outside the
// browser (curl, agents) can inspect it via GET /__live/db (vite/live-plugin.js). Read-only.
//
//   { op: 'dbs' }                          -> [{ name, version, stores: [{ name, count }] }]
//   { op: 'keys', db, store }              -> [key, …]
//   { op: 'all',  db, store }              -> [{ key, value }, …]
//   { op: 'get',  db, store, key }         -> value (undefined -> 404)
//   { op: 'ls' }                           -> { key: value, … } of this page's localStorage (keys/tokens redacted)
//   { op: 'ls', key }                      -> one localStorage value (missing -> 404)
//                                             (values that are JSON come back parsed)
//
// Values are made JSON-safe: typed arrays and binary become { $type, length, head } summaries
// unless `full` is set, Maps/Sets/Dates/Blobs are tagged.

const open = (name) =>
  new Promise((resolve, reject) => {
    const r = indexedDB.open(name);
    // Opening a database that does not exist would create it; abort that instead.
    r.onupgradeneeded = () => r.transaction.abort();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(new Error(`no database ${name}`));
  });

const req = (r) =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

function jsonSafe(v, full, seen = new WeakSet()) {
  if (v === undefined) return { $type: 'undefined' };
  if (v === null || typeof v !== 'object') return typeof v === 'bigint' ? { $type: 'BigInt', value: String(v) } : v;
  if (v instanceof ArrayBuffer) v = new Uint8Array(v);
  if (ArrayBuffer.isView(v)) {
    const arr = Array.from(v instanceof DataView ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : v, Number);
    return full ? { $type: v.constructor.name, length: arr.length, data: arr } : { $type: v.constructor.name, length: arr.length, head: arr.slice(0, 8) };
  }
  if (v instanceof Date) return { $type: 'Date', value: v.toISOString() };
  if (typeof Blob !== 'undefined' && v instanceof Blob) return { $type: v.constructor.name, size: v.size, mime: v.type, name: v.name };
  if (seen.has(v)) return { $type: 'Circular' };
  seen.add(v);
  if (v instanceof Map) return { $type: 'Map', entries: [...v].map(([k, x]) => [jsonSafe(k, full, seen), jsonSafe(x, full, seen)]) };
  if (v instanceof Set) return { $type: 'Set', values: [...v].map((x) => jsonSafe(x, full, seen)) };
  if (Array.isArray(v)) return v.map((x) => jsonSafe(x, full, seen));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = jsonSafe(x, full, seen);
  return out;
}

// Keys and tokens stay in the page.
const SECRET = /api.?key|token|secret|password/i;
const parsed = (v) => {
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};

async function handle({ op, db: name, store, key, full }) {
  if (op === 'ls') {
    const read = (k) => (SECRET.test(k) && localStorage.getItem(k) ? '[redacted]' : parsed(localStorage.getItem(k)));
    if (key == null) return Object.fromEntries(Object.keys(localStorage).sort().map((k) => [k, read(k)]));
    if (localStorage.getItem(key) === null) throw Object.assign(new Error(`no localStorage key ${JSON.stringify(key)}`), { status: 404 });
    return read(key);
  }
  if (op === 'dbs') {
    const list = await indexedDB.databases();
    return Promise.all(
      list.map(async ({ name, version }) => {
        const d = await open(name);
        try {
          const stores = await Promise.all(
            [...d.objectStoreNames].map(async (s) => ({ name: s, count: await req(d.transaction(s).objectStore(s).count()) }))
          );
          return { name, version, stores };
        } finally {
          d.close();
        }
      })
    );
  }
  const d = await open(name);
  try {
    if (!d.objectStoreNames.contains(store)) throw Object.assign(new Error(`no store ${store} in ${name}`), { status: 404 });
    const os = d.transaction(store).objectStore(store);
    if (op === 'keys') return jsonSafe(await req(os.getAllKeys()), full);
    if (op === 'all') {
      const [keys, values] = await Promise.all([req(os.getAllKeys()), req(os.getAll())]);
      return keys.map((k, i) => ({ key: jsonSafe(k, full), value: jsonSafe(values[i], full) }));
    }
    if (op === 'get') {
      const v = await req(os.get(key));
      if (v === undefined) throw Object.assign(new Error(`no key ${JSON.stringify(key)} in ${name}/${store}`), { status: 404 });
      return jsonSafe(v, full);
    }
    throw new Error(`unknown op ${op}`);
  } finally {
    d.close();
  }
}

export function attachDbBridge(hot) {
  hot.on('live:db', async ({ id, ...q }) => {
    try {
      hot.send('live:db-reply', { id, ok: true, result: await handle(q), page: location.href });
    } catch (e) {
      hot.send('live:db-reply', { id, ok: false, status: e.status || 400, error: String(e.message || e), page: location.href });
    }
  });
}
