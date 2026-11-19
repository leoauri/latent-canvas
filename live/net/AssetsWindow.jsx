// The assets window: every file in this browser's blob store (blobs.js), whatever session is open.
// Shows completeness and live transfers, which blobs the open session's document uses (and which
// only its recent history does, for undo), and lets you add, download and remove files.
import { useState, useEffect, useMemo } from 'preact/hooks';
import { registerWindowKind, FloatingWindow } from '../ui/FloatingWindow.jsx';
import { toggleWindow, findWindow } from '../ui/windows.js';
import * as blobs from './blobs.js';
import * as session from './session.js';
import * as history from './history.js';
import './net.css';

const HASH_RE = /^sha256-[0-9a-f]{64}$/;
const HISTORY_SCAN = 20; // newest history entries whose `before` state is scanned

const ago = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : new Date(t).toLocaleDateString();
};
const bytes = (n) => {
  if (n == null) return '?';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do (n /= 1024), i++;
  while (n >= 1024 && i < u.length - 1);
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
};
const short = (h) => h.slice(7, 15);

// ---- references --------------------------------------------------------------------------

// Where a string sits in the document, readably: 'state' dropped, list items' ids dropped
// ('stack.items.<id>.model' -> 'stack.model'), deep paths cut to their first and last key.
function where(path) {
  let segs = path[0] === 'state' ? path.slice(1) : path;
  segs = segs.filter((s, i) => s !== 'items' && segs[i - 1] !== 'items');
  if (segs[0] === 'code' && segs[1] === 'changes') return 'code.changes';
  return segs.length > 2 ? `${segs[0]}.${segs.at(-1)}` : segs.join('.') || '(root)';
}

/** hash -> Set of places (see where()) for every blob id in a document. */
function scanDoc(doc, out = new Map()) {
  const walk = (v, path) => {
    if (typeof v === 'string' || (v && typeof v === 'object' && typeof v.val === 'string' && !Array.isArray(v))) {
      const s = typeof v === 'string' ? v : v.val;
      if (s.length === 71 && HASH_RE.test(s)) {
        if (!out.has(s)) out.set(s, new Set());
        out.get(s).add(where(path));
      }
      return;
    }
    if (!v || typeof v !== 'object' || ArrayBuffer.isView(v) || v instanceof Date) return;
    if (Array.isArray(v)) for (const x of v) walk(x, path);
    else for (const k of Object.keys(v)) walk(v[k], [...path, k]);
  };
  walk(doc, []);
  return out;
}

// Heads never change what they point at, so a scan at some heads is cached for good (a few).
const headScans = new Map();
function scanAt(h, heads) {
  const key = heads.join(',');
  let r = headScans.get(key);
  if (!r) {
    r = new Set(scanDoc(h.view(heads).doc()).keys());
    headScans.set(key, r);
    if (headScans.size > 100) headScans.delete(headScans.keys().next().value);
  }
  return r;
}

function useRefs() {
  const h = session.handle.value;
  const v = session.version.value;
  const used = useMemo(() => {
    try {
      return h ? scanDoc(h.doc()) : new Map();
    } catch {
      return new Map();
    }
  }, [h, v]);
  const list = history.entries.value;
  const recent = useMemo(() => {
    const out = new Set();
    if (!h || typeof h.view !== 'function') return { set: out, scanned: 0 };
    let scanned = 0;
    for (const e of list.slice(-HISTORY_SCAN)) {
      try {
        for (const x of scanAt(h, e.before)) out.add(x);
        scanned++;
      } catch {}
    }
    return { set: out, scanned };
  }, [h, list]);
  return { used, recent };
}

// ---- actions -----------------------------------------------------------------------------

async function download(hash) {
  const file = await blobs.get(hash);
  if (!file) throw new Error('not complete locally');
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name || hash;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ---- UI ----------------------------------------------------------------------------------

function AssetsBody() {
  const idx = blobs.index.value;
  const tr = blobs.transfers.value;
  const { used, recent } = useRefs();
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState('added');
  const [estimate, setEstimate] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    let live = true;
    navigator.storage?.estimate?.().then((e) => live && setEstimate(e), () => {});
    return () => (live = false);
  }, [idx]);

  const rows = useMemo(() => {
    const ids = new Set([...Object.keys(idx), ...Object.keys(tr)]);
    const f = filter.trim().toLowerCase();
    const list = [...ids]
      .map((hash) => ({ hash, e: idx[hash] ?? null, t: tr[hash] ?? null }))
      .filter(({ hash, e, t }) => !f || (e?.name ?? t?.name ?? '').toLowerCase().includes(f) || hash.includes(f));
    const name = (r) => (r.e?.name ?? r.t?.name ?? r.hash).toLowerCase();
    const cmp = {
      added: (a, b) => (b.e?.added ?? Infinity) - (a.e?.added ?? Infinity),
      name: (a, b) => name(a).localeCompare(name(b)),
      size: (a, b) => (b.e?.size ?? b.t?.total ?? 0) - (a.e?.size ?? a.t?.total ?? 0),
    }[sort];
    return list.sort(cmp);
  }, [idx, tr, filter, sort]);

  const total = Object.values(idx).reduce((s, e) => s + (e.complete ? e.size : Math.min(e.size, e.have * blobs.CHUNK_SIZE)), 0);
  const active = (t) => t && (t.state === 'fetching' || t.state === 'waiting');
  const unused = Object.keys(idx).filter((h) => !used.has(h) && !recent.set.has(h) && !active(tr[h]));

  const run = async (label, fn) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(`${label}: ${e.message || e}`);
    } finally {
      setBusy(null);
    }
  };
  const addFiles = (files) => files.length && run(`Adding ${files.length} file${files.length > 1 ? 's' : ''}`, async () => {
    for (const f of files) await blobs.put(f, { name: f.name, type: f.type || undefined });
  });
  const remove = (hash) => {
    const e = idx[hash];
    const label = e?.name ?? short(hash);
    const places = used.get(hash);
    const warn = places
      ? `\n\nThe open session uses it (${[...places].join(', ')}): it will have to be fetched again from a peer, or will be missing if nobody has it.`
      : recent.set.has(hash)
        ? '\n\nIt is used in recent history: undoing those actions would need it again.'
        : '';
    if (confirm(`Remove “${label}” (${bytes(e?.size ?? tr[hash]?.total)}) from this browser?${warn}`)) run('Remove', () => blobs.remove(hash));
  };
  const removeUnused = () => {
    const size = unused.reduce((s, h) => s + (idx[h]?.size ?? 0), 0);
    if (confirm(`Remove ${unused.length} file${unused.length > 1 ? 's' : ''} (${bytes(size)}) that the open session doesn't use, now or in its recent history?`))
      run('Remove unused', async () => {
        for (const h of unused) await blobs.remove(h);
      });
  };

  return (
    <div
      class={`net-body net-assets${dragging ? ' net-drop' : ''}`}
      onDragOver={(e) => {
        if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget) && setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        addFiles([...(e.dataTransfer?.files ?? [])]);
      }}
    >
      <section>
        <label class="net-label">Storage</label>
        <div class="net-row net-muted">
          <span class="net-grow">
            {Object.keys(idx).length} file{Object.keys(idx).length === 1 ? '' : 's'}, {bytes(total)}
            {estimate ? ` · browser storage ${bytes(estimate.usage)} of ${bytes(estimate.quota)}` : ''}
          </span>
        </div>
        <div class="net-row">
          <label class="net-button">
            Add files…
            <input type="file" multiple hidden onChange={(e) => (addFiles([...e.currentTarget.files]), (e.currentTarget.value = ''))} />
          </label>
          <span class="net-grow net-muted">or drop them here</span>
          <button disabled={!unused.length || !!busy} onClick={removeUnused} title="Files the open session doesn't reference, now or in its recent history">
            Remove unused{unused.length ? ` (${unused.length})` : ''}
          </button>
        </div>
        {busy && <p class="net-muted">{busy}…</p>}
        {error && <p class="net-error">{error}</p>}
      </section>

      <section class="net-fill">
        <div class="net-row">
          <input placeholder="Filter by name or id" value={filter} onInput={(e) => setFilter(e.currentTarget.value)} />
          <select value={sort} onChange={(e) => setSort(e.currentTarget.value)} title="Sort">
            <option value="added">Newest</option>
            <option value="name">Name</option>
            <option value="size">Size</option>
          </select>
        </div>
        {rows.length ? (
          <ul class="net-list net-assets-list">
            {rows.map(({ hash, e, t }) => (
              <AssetRow key={hash} hash={hash} e={e} t={t} places={used.get(hash)} inHistory={recent.set.has(hash)} onRemove={() => remove(hash)} run={run} />
            ))}
          </ul>
        ) : (
          <p class="net-muted">{filter ? 'No file matches.' : 'No files stored in this browser.'}</p>
        )}
        <p class="net-hint">
          “Used” is what the open session's document references; “in history” is referenced only by the state before one of your last{' '}
          {HISTORY_SCAN} actions (undo would need it).
        </p>
      </section>
    </div>
  );
}

function AssetRow({ hash, e, t, places, inHistory, onRemove, run }) {
  const complete = !!e?.complete;
  const transferring = t && (t.state === 'fetching' || t.state === 'waiting');
  const pct = t?.total ? Math.min(100, (100 * t.bytes) / t.total) : e ? (100 * e.have) / Math.max(1, e.chunks) : 0;
  return (
    <li class="net-asset">
      <div class="net-row">
        <span class="net-grow net-asset-name" title={hash}>
          {e?.name ?? t?.name ?? <span class="net-mono">{short(hash)}</span>}
        </span>
        {complete && (
          <button class="net-small" onClick={() => run('Download', () => download(hash))}>
            Download
          </button>
        )}
        {transferring && (
          <button class="net-small" onClick={() => blobs.cancel(hash)} title="Stop fetching (what arrived stays)">
            Cancel
          </button>
        )}
        <button class="net-small" onClick={onRemove} title="Remove from this browser">
          ✕
        </button>
      </div>
      <div class="net-row net-muted net-asset-meta">
        <span>{bytes(e?.size ?? t?.total)}</span>
        {e?.type && <span>{e.type}</span>}
        {e?.added && <span>{ago(e.added)}</span>}
        {e && (
          <span title="chunks stored / total">
            {e.have}/{e.chunks} chunks{complete ? '' : ' (incomplete)'}
          </span>
        )}
        <span class="net-mono" title={hash}>
          {short(hash)}
        </span>
      </div>
      {(places || inHistory) && (
        <div class="net-row net-tags">
          {places && [...places].map((p) => <span class="net-tag net-tag-used" key={p} title="Referenced by the open session">{p}</span>)}
          {!places && inHistory && <span class="net-tag" title="Referenced by the state before a recent action (undo)">used in recent history</span>}
        </div>
      )}
      {t && t.state !== 'done' && (
        <div class="net-transfer">
          <div class="net-progress">
            <div style={{ width: `${pct}%` }} class={t.state === 'error' ? 'net-progress-error' : ''} />
          </div>
          <div class="net-row net-muted">
            <span class="net-grow">
              {t.state === 'waiting' ? 'waiting for a peer that has it' : t.state === 'error' ? <span class="net-error">{t.error || 'failed'}</span> : 'fetching'}
            </span>
            <span>
              {bytes(t.bytes)}
              {t.total ? ` / ${bytes(t.total)}` : ''}
            </span>
            {t.state === 'fetching' && <span>{bytes(t.rate)}/s</span>}
            <span title={(t.peers ?? []).join(', ')}>{t.peers?.length ?? 0} peers</span>
          </div>
        </div>
      )}
    </li>
  );
}

const unregister = registerWindowKind('assets', {
  render: (win) => (
    <FloatingWindow win={win} title="Assets" class="net-window">
      <AssetsBody />
    </FloatingWindow>
  ),
});

/** Pill button that opens the assets window; shows a dot while anything is being fetched. */
export function AssetsPill() {
  const open = !!findWindow('assets');
  const fetching = Object.values(blobs.transfers.value).filter((t) => t.state === 'fetching' || t.state === 'waiting').length;
  return (
    <button
      class={`net-pill${open ? ' net-pill-on' : ''}`}
      onClick={() => toggleWindow('assets', {}, { rect: { w: 400, h: 560 } })}
      title="Assets: files stored in this browser"
    >
      Assets
      {fetching > 0 && <span class="net-badge net-badge-muted" title={`${fetching} fetching`}>↓{fetching}</span>}
    </button>
  );
}

export function dispose() {
  unregister();
}
