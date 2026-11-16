// Virtual file system over the live modules.
//
//   committed   the running, persisted state. Stored in IndexedDB; mirrored to live/ on disk
//               when served by the Vite dev server ("most recent mtime wins" on boot).
//   pending     an in-memory buffer of edits (the agent's workspace). Reads see the overlay;
//               nothing runs until apply().
//   history     committed transactions with before/after sources, for revert().
//
// apply() is a transaction: stage the new module instances, swap them in, observe the page
// for errors from *any* module for a short window (plus an optional check script), then
// either commit (persist + write to disk) or roll the swap back and keep the buffer.
import { createStore, get, set, del, entries } from 'idb-keyval';
import { collectErrors, record } from './errors.js';
import { normalizePath } from './loader.js';

const fileStore = createStore('redaw-files', 'files');
const metaStore = createStore('redaw-meta', 'meta');
const HISTORY_LIMIT = 50;
const AsyncFunction = (async () => {}).constructor;

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const diskApi = {
  async list() {
    const res = await fetch('/__live/files', { headers: { 'x-redaw': '1' } });
    if (!res.ok) throw new Error(`disk list failed: ${res.status}`);
    return (await res.json()).files;
  },
  async write(path, source) {
    const res = await fetch(`/__live/files/${encodeURI(path)}`, {
      method: 'PUT',
      headers: { 'x-redaw': '1', 'content-type': 'text/plain' },
      body: source,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`disk write ${path} failed: ${body.error || res.status}`);
    return body.mtime;
  },
  async remove(path) {
    const res = await fetch(`/__live/files/${encodeURI(path)}`, { method: 'DELETE', headers: { 'x-redaw': '1' } });
    if (!res.ok) throw new Error(`disk delete ${path} failed: ${res.status}`);
  },
};

export class VFS {
  constructor({ loader, disk, bundle, runCheck }) {
    this.loader = loader;
    this.disk = disk; // true when the Vite dev server is there to persist to
    this.bundle = bundle; // files inlined at build time (or null in dev)
    this.runCheck = runCheck; // (code) => Promise, evaluates a check script in page context
    this.committed = new Map(); // path -> { source, mtime, diskMtime }
    this.pending = new Map(); // path -> { source: string|null, base: string|undefined }
    this.history = [];
    this.listeners = new Set();
    this.queue = Promise.resolve();
    this.version = 0;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  _changed() {
    this.version++;
    for (const fn of this.listeners) fn(this);
  }
  _serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  // ---- boot / sync -------------------------------------------------------------------

  async init() {
    const local = new Map(await entries(fileStore).catch(() => []));
    let remote = null;
    if (this.disk) {
      try {
        remote = await this.disk_list();
      } catch (err) {
        record('warn', [`live: dev server file API unavailable, using local copies (${err.message})`], 'vfs');
        this.disk = false;
      }
    }
    if (!remote) remote = this.bundle || [];
    const remoteMap = new Map(remote.map((f) => [f.path, f]));
    const pushes = [];
    const deletes = [];

    for (const path of new Set([...remoteMap.keys(), ...local.keys()])) {
      const r = remoteMap.get(path);
      const l = local.get(path);
      const take = (src, mtime, diskMtime) => this.committed.set(path, { source: src, mtime, diskMtime });
      if (r && !l) take(r.source, r.mtime, r.mtime);
      else if (r && l) {
        if (l.deleted) {
          if (l.mtime > r.mtime) deletes.push(path);
          else take(r.source, r.mtime, r.mtime);
        } else if (l.source === r.source) take(r.source, Math.max(l.mtime, r.mtime), r.mtime);
        else if (r.mtime > l.mtime) take(r.source, r.mtime, r.mtime);
        else {
          take(l.source, l.mtime, r.mtime);
          pushes.push(path);
        }
      } else if (l && !l.deleted) {
        const wasSynced = l.diskMtime != null && l.mtime <= l.diskMtime;
        if (!wasSynced) {
          take(l.source, l.mtime, null);
          pushes.push(path);
        }
      }
    }

    // Rewrite IndexedDB to match, then push local-newer state to disk.
    for (const path of local.keys()) if (!this.committed.has(path)) await del(path, fileStore).catch(() => {});
    for (const [path, f] of this.committed) await set(path, f, fileStore).catch(() => {});
    if (this.disk) {
      for (const path of pushes) await this._persistDisk(path).catch((e) => record('warn', [e.message], 'vfs'));
      for (const path of deletes) await diskApi.remove(path).catch((e) => record('warn', [e.message], 'vfs'));
    }
    this.history = (await get('history', metaStore).catch(() => null)) || [];
    this._changed();
  }

  disk_list() {
    return diskApi.list();
  }

  /** Load every module reachable from the entry. Returns the stage result. */
  async boot() {
    return this._serial(async () => {
      const stage = await this.loader.stage(this.committedSources(), []);
      if (stage.ok) {
        this.loader.activate(stage);
        this.loader.finalize(stage);
      }
      return stage;
    });
  }

  committedSources() {
    return new Map([...this.committed].map(([p, f]) => [p, f.source]));
  }

  // ---- reading / buffered writes -----------------------------------------------------

  read(path) {
    path = normalizePath(path);
    if (this.pending.has(path)) return this.pending.get(path).source ?? undefined;
    return this.committed.get(path)?.source;
  }

  readCommitted(path) {
    return this.committed.get(normalizePath(path))?.source;
  }

  /** All paths in the overlay (committed + pending, minus pending deletes). */
  list() {
    const paths = new Set(this.committed.keys());
    for (const [p, c] of this.pending) c.source == null ? paths.delete(p) : paths.add(p);
    return [...paths].sort();
  }

  write(path, source) {
    path = normalizePath(path);
    if (!path) throw new Error('empty path');
    const prev = this.pending.get(path);
    this.pending.set(path, { source: String(source), base: prev ? prev.base : this.committed.get(path)?.source });
    this._dropNoops(path);
    this._changed();
  }

  remove(path) {
    path = normalizePath(path);
    if (this.read(path) === undefined) throw new Error(`no such file: ${path}`);
    const prev = this.pending.get(path);
    this.pending.set(path, { source: null, base: prev ? prev.base : this.committed.get(path)?.source });
    this._dropNoops(path);
    this._changed();
  }

  _dropNoops(path) {
    const c = this.pending.get(path);
    const committed = this.committed.get(path)?.source;
    if (c && (c.source ?? undefined) === committed && c.base === committed) this.pending.delete(path);
  }

  discard(paths) {
    const list = paths?.length ? paths.map(normalizePath) : [...this.pending.keys()];
    for (const p of list) this.pending.delete(p);
    this._changed();
    return list;
  }

  status() {
    return [...this.pending].map(([path, c]) => ({
      path,
      kind: c.source == null ? 'deleted' : c.base === undefined ? 'added' : 'modified',
      stale: c.base !== this.committed.get(path)?.source,
    }));
  }

  // ---- transactions ------------------------------------------------------------------

  /**
   * Apply the pending buffer as one transaction.
   * opts: observeMs (default 800), check (JS source run after the swap; throwing fails it),
   *       includeConsole (count console.error as failure, default true), label.
   */
  apply(opts = {}) {
    return this._serial(async () => {
      if (!this.pending.size) return { ok: true, message: 'nothing to apply', changed: [] };
      const conflicts = this.status().filter((s) => s.stale).map((s) => s.path);
      if (conflicts.length)
        return {
          ok: false,
          phase: 'conflict',
          errors: conflicts.map((p) => ({ path: p, message: 'file changed underneath the buffer (e.g. edited on disk); re-read it and redo the edit' })),
        };
      const changes = new Map([...this.pending].map(([p, c]) => [p, c.source]));
      const result = await this._transact(changes, { ...opts, origin: 'apply' });
      if (result.ok) {
        this.pending.clear();
        this._changed();
      }
      return result;
    });
  }

  /** Undo the last `count` committed transactions, as a transaction itself. */
  revert(count = 1, opts = {}) {
    return this._serial(async () => {
      const entries = this.history.slice(-count);
      if (!entries.length) return { ok: false, message: 'history is empty' };
      const changes = new Map();
      for (const entry of [...entries].reverse()) for (const ch of entry.changes) changes.set(ch.path, ch.before);
      const result = await this._transact(changes, { ...opts, origin: 'revert', record: false });
      if (result.ok) {
        this.history.splice(this.history.length - entries.length, entries.length);
        await set('history', this.history, metaStore).catch(() => {});
        result.reverted = entries.map((e) => ({ id: e.id, label: e.label }));
        this._changed();
      }
      return result;
    });
  }

  /** A change that arrived on disk (your editor). Applied without rollback. */
  external({ path, source, mtime }) {
    return this._serial(async () => {
      const c = this.committed.get(path);
      if (source == null && !c) return;
      if (c && c.source === source) {
        c.diskMtime = mtime;
        c.mtime = Math.max(c.mtime, mtime);
        await set(path, c, fileStore).catch(() => {});
        return;
      }
      const result = await this._transact(new Map([[path, source]]), {
        origin: 'disk',
        rollbackOnError: false,
        observeMs: 0,
        label: `disk: ${path}`,
        mtime,
      });
      if (!result.ok) record('error', [`live: ${path} changed on disk and failed:\n${formatErrors(result.errors)}`], 'vfs');
    });
  }

  async _transact(changes, opts) {
    const { observeMs = 800, check, includeConsole = true, rollbackOnError = true, origin, label } = opts;
    const files = this.committedSources();
    for (const [p, src] of changes) (src == null ? files.delete(p) : files.set(p, src));
    const changed = [...changes.keys()];

    const collector = collectErrors({ includeConsole });
    const stage = await this.loader.stage(files, changed);
    if (!stage.ok) {
      collector.stop();
      return { ok: false, phase: 'evaluate', errors: stage.errors, rolledBack: false };
    }

    this.loader.activate(stage);
    const checkErrors = [];
    await nextFrame();
    if (check) {
      try {
        await this.runCheck(check);
      } catch (err) {
        checkErrors.push({ path: '(check)', message: this.loader.mapUrls(err?.stack || String(err)) });
      }
    }
    if (observeMs > 0) await sleep(observeMs);
    await nextFrame();
    const errors = [
      ...collector.stop().map((e) => ({ path: `(${e.source})`, message: this.loader.mapUrls(e.text) })),
      ...checkErrors,
    ];

    if (errors.length && rollbackOnError) {
      this.loader.rollback(stage);
      await nextFrame();
      return { ok: false, phase: 'observe', errors, rolledBack: true, rebuilt: stage.rebuilt };
    }

    this.loader.finalize(stage);
    const warnings = await this._commit(changes, { origin, label, mtime: opts.mtime, record: opts.record !== false });
    return { ok: errors.length === 0, phase: 'committed', errors, warnings, rebuilt: stage.rebuilt, changed };
  }

  async _commit(changes, { origin, label, mtime, record: addHistory }) {
    const warnings = [];
    const now = mtime ?? Date.now();
    const histChanges = [];
    for (const [path, source] of changes) {
      const before = this.committed.get(path)?.source ?? null;
      histChanges.push({ path, before, after: source ?? null });
      if (source == null) {
        this.committed.delete(path);
        await set(path, { deleted: true, mtime: now, source: '' }, fileStore).catch(() => {});
        if (this.disk && origin !== 'disk') await diskApi.remove(path).catch((e) => warnings.push(e.message));
      } else {
        const f = { source, mtime: now, diskMtime: origin === 'disk' ? now : this.committed.get(path)?.diskMtime ?? null };
        this.committed.set(path, f);
        await set(path, f, fileStore).catch(() => {});
        if (this.disk && origin !== 'disk') await this._persistDisk(path).catch((e) => warnings.push(e.message));
      }
    }
    if (addHistory) {
      this.history.push({ id: Date.now().toString(36), time: Date.now(), label: label || origin, changes: histChanges });
      if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT);
      await set('history', this.history, metaStore).catch(() => {});
    }
    this._changed();
    return warnings;
  }

  async _persistDisk(path) {
    const f = this.committed.get(path);
    const mtime = await diskApi.write(path, f.source);
    f.mtime = f.diskMtime = mtime;
    await set(path, f, fileStore).catch(() => {});
  }

  /** Run arbitrary code with the page context (used by check scripts and eval_js). */
  static compileScript(code, names) {
    return new AsyncFunction(...names, code);
  }
}

export function formatErrors(errors = []) {
  return errors.map((e) => `- ${e.path}: ${e.message}`).join('\n');
}
