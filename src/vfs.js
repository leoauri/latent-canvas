// Virtual file system over the live modules.
//
//   base        the instrument's code, the same in every session. Stored in IndexedDB; mirrored
//               to live/ on disk when served by the Vite dev server ("most recent mtime wins" on
//               boot). Changed by disk edits (your editor, an agent outside the browser, git).
//   layer       the open session's own code: every file committed while that session is open, as
//               { source, base } over the base (redaw-layers store, one record per session, with
//               its history). Opening another session swaps its layer in; a new or joined session
//               starts with an empty one. Layers never reach disk; peers get them only as
//               published changes. With no session open (useLayer(null)) commits go to the base.
//   committed   what runs: the base with the open session's layer on top. A disk edit to a file
//               the layer changed is three-way merged under it; on conflict the session's version
//               keeps running (and is reported).
//   overlays    named edit buffers over the committed base, one level deep (no nesting). Each
//               file in an overlay remembers the committed source it was edited from (`base`).
//               Reads through an overlay see its edits; nothing runs until it is applied
//               (promoted) or tried. The 'default' overlay is the old single pending buffer: the
//               legacy methods (read/write/remove/list/status/discard/apply) act on it.
//               Overlays persist in IndexedDB. A change from another peer arrives as an overlay
//               too (createOverlay with files + their bases or base hashes).
//   history     committed transactions with before/after sources, for revert().
//
// Promotion (apply/promote) is a per-file three-way merge of the overlay onto the current
// committed files (base = what the overlay started from), then a transaction: stage the new
// module instances, swap them in, observe the page for errors from *any* module for a short
// window (plus an optional check script), then either commit (persist + write to disk) or roll
// the swap back and keep the overlay. Overlapping edits are returned as structured conflicts.
//
// A trial runs an overlay's (merged) sources live without committing; only one at a time. It
// ends with keep (commit what is running) or discard (swap the committed instances back).
// onTrial(fn) listeners hear { phase: 'start'|'keep'|'discard', overlayId }.
import { createStore, get, set, del, entries, clear } from 'idb-keyval';
import { collectErrors, record, reportError } from './errors.js';
import { normalizePath } from './loader.js';
import { merge3, hashSource, hasConflictMarkers, lineDiff } from './merge.js';

const fileStore = createStore('redaw-files', 'files');
const metaStore = createStore('redaw-meta', 'meta');
const layerStore = createStore('redaw-layers', 'layers');
const HISTORY_LIMIT = 50;
const DEFAULT = 'default';
const AsyncFunction = (async () => {}).constructor;

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let idCounter = 0;
const newId = (prefix = '') => prefix + Date.now().toString(36) + (idCounter++ % 1296).toString(36).padStart(2, '0');

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

/** "edit live/x.js", "add live/a.js, live/b.js", "edit 5 files". */
function deriveLabel(files) {
  const verb = (f) => (f.before == null ? 'add' : f.after == null ? 'delete' : 'edit');
  if (!files.length) return 'no change';
  const verbs = new Set(files.map(verb));
  const v = verbs.size === 1 ? [...verbs][0] : 'edit';
  return files.length <= 3 ? `${v} ${files.map((f) => 'live/' + f.path).join(', ')}` : `${v} ${files.length} files`;
}

/** History entries are { id, label, intent?, origin, overlayId?, files, at }; `changes`/`time` are legacy aliases. */
function historyEntry(e) {
  const entry = {
    id: e.id,
    label: e.label,
    origin: e.origin || (/^disk: /.test(e.label || '') ? 'editor' : 'agent'),
    files: e.files || e.changes || [],
    at: e.at ?? e.time ?? Date.now(),
  };
  if (e.intent) entry.intent = e.intent;
  if (e.overlayId) entry.overlayId = e.overlayId;
  if (e.revertOf) entry.revertOf = e.revertOf;
  entry.label ||= deriveLabel(entry.files);
  Object.defineProperty(entry, 'changes', { get: () => entry.files, enumerable: false });
  Object.defineProperty(entry, 'time', { get: () => entry.at, enumerable: false });
  return entry;
}

const sameChanges = (a, b) => a.size === b.size && [...a].every(([p, s]) => b.has(p) && b.get(p) === s);

export class VFS {
  constructor({ loader, disk, bundle, runCheck }) {
    this.loader = loader;
    this.disk = disk; // true when the Vite dev server is there to persist to
    this.bundle = bundle; // files inlined at build time (or null in dev)
    this.runCheck = runCheck; // (code) => Promise, evaluates a check script in page context
    this.base = new Map(); // path -> { source, mtime, diskMtime }
    this.layerId = null; // the open session's layer (null: commits go to the base)
    this.layer = new Map(); // path -> { source: string|null, base: string|null } (base: the base source it was made from)
    this.committed = new Map(); // path -> { source }: the base with the layer on top
    // id -> { id, label, origin, peer?, intent?, createdAt, updatedAt,
    //         files: Map path -> { source: string|null, base: string|null|undefined, baseHash?, conflicted? } }
    // base null = the file did not exist; undefined = unknown (a foreign change whose base hash
    // matches nothing we have).
    this.overlayMap = new Map();
    this._ensureOverlay(DEFAULT, { label: 'default', origin: 'agent' });
    this.history = [];
    this.listeners = new Set();
    this.trialListeners = new Set();
    this.trialState = null; // { overlayId, stage, changes, snapshot, startedAt }
    this.queue = Promise.resolve();
    this._ownWrites = new Map(); // path -> recent [{ source, mtime }] this page wrote to disk
    this.version = 0;
    this.hash = hashSource;
    this.merge3 = merge3;
    this.lineDiff = lineDiff;
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
      const take = (src, mtime, diskMtime) => this.base.set(path, { source: src, mtime, diskMtime });
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
    for (const path of local.keys()) if (!this.base.has(path)) await del(path, fileStore).catch(() => {});
    for (const [path, f] of this.base) await set(path, f, fileStore).catch(() => {});
    if (this.disk) {
      for (const path of pushes) await this._persistDisk(path).catch((e) => record('warn', [e.message], 'vfs'));
      for (const path of deletes) await diskApi.remove(path).catch((e) => record('warn', [e.message], 'vfs'));
    }
    await this._loadLayer((await get('layer', metaStore).catch(() => null)) ?? null);
    this.committed = this._compose();
    await this._saveLayer();
    for (const o of (await get('overlays', metaStore).catch(() => null)) || []) {
      if (!o?.id || !(o.files instanceof Map)) continue;
      this.overlayMap.set(o.id, { ...o, files: o.files });
    }
    this._ensureOverlay(DEFAULT, { label: 'default', origin: 'agent' });
    this._changed();
  }

  /**
   * Forget this page's committed copies of the live files (the redaw-files store) and reload, so
   * the next boot takes every file from the server (the dev server's live/ folder, or the build's
   * bundle). Queued behind any running transaction so no commit lands after the wipe. Overlays and
   * history are kept.
   */
  resetLocal() {
    return this._serial(async () => {
      await clear(fileStore);
      location.reload();
      await new Promise(() => {}); // hold the queue until the page goes away
    });
  }

  disk_list() {
    return diskApi.list();
  }

  // ---- session layers ----------------------------------------------------------------

  /** The base's source of a file (null: absent). */
  readBase(path) {
    return this.base.get(normalizePath(path))?.source ?? null;
  }

  /** The open layer's files: [{ path, kind: 'added'|'modified'|'deleted', stale }] (stale: made from an older base). */
  layerStatus() {
    return [...this.layer].map(([path, e]) => ({
      path,
      kind: e.source == null ? 'deleted' : e.base == null ? 'added' : 'modified',
      stale: e.base !== this.readBase(path),
    }));
  }

  /**
   * Files where the base changed under the session's own version and the two conflict (the
   * session's version runs): [{ path, base (what the session's version was made from), baseNow, session }].
   */
  layerConflicts() {
    return [...this.layer]
      .filter(([path, e]) => e.base !== this.readBase(path))
      .map(([path, e]) => ({ path, base: e.base, baseNow: this.readBase(path), session: e.source }));
  }

  /** Resolve a conflict by taking the base's version (the session's own version of the file is dropped). */
  layerUseBase(path) {
    path = normalizePath(path);
    return this._serial(async () => {
      if (this.trialState) return this._busy();
      if (!this.layer.has(path)) return { ok: true, changed: [] };
      this.layer.delete(path);
      return this._transact(new Map([[path, this.readBase(path)]]), { origin: 'base-merge', label: `use the base's ${path}`, observeMs: 300 });
    });
  }

  /** Resolve a conflict by keeping the session's version as it is (it now counts as made from the current base). */
  layerKeep(path) {
    path = normalizePath(path);
    return this._serial(async () => {
      const e = this.layer.get(path);
      if (!e) return { ok: true };
      this.layer.set(path, { source: e.source, base: this.readBase(path) });
      if (e.source === this.readBase(path)) this.layer.delete(path);
      await this._saveLayer();
      this._changed();
      return { ok: true };
    });
  }

  /**
   * Stage the conflicting files in overlay `id` for an agent to merge: each holds the merge of the
   * new base into the session's version, with conflict markers (<<<<<<< session / ||||||| base /
   * ======= / >>>>>>> new base). Applying that overlay resolves the conflicts. -> { overlayId, conflicts }
   */
  stageLayerMerge(id = 'base-merge') {
    if (this.overlayMap.has(id)) this.overlayMap.delete(id);
    const conflicts = this.layerConflicts();
    // The new base, made from the base the session's version started from, merged onto what runs (the session's version).
    this.createOverlay({ id, label: 'merge the base into this session', origin: 'base-merge', files: conflicts.map((c) => ({ path: c.path, source: c.baseNow, base: c.base })) });
    const ov = this._ov(id);
    for (const c of conflicts) {
      const r = this._mergeFile(c.path, ov.files.get(c.path), 'new base', c.session, 'session');
      if (r.conflict) ov.files.set(c.path, { source: r.conflict.merged, base: c.session, conflicted: hasConflictMarkers(r.conflict.merged) || undefined });
      else ov.files.set(c.path, { source: r.same ? c.session : r.change, base: c.session });
    }
    for (const f of ov.files.values()) if (f.conflicted === undefined) delete f.conflicted;
    this._touch(ov);
    return { overlayId: id, conflicts: conflicts.map((c) => c.path) };
  }

  /** How the open session's version of a file differs from the base: a line diff (base -> session), '' if it doesn't. */
  layerDiff(path) {
    path = normalizePath(path);
    if (!this.layer.has(path)) return '';
    return lineDiff(this.readBase(path) ?? '', this.readCommitted(path) ?? '');
  }

  /** Another session's layer as stored (the open one as it is now): { files: [{ path, kind }], history } or null. */
  async readLayer(id) {
    if (!id) return null;
    const rec = id === this.layerId ? { files: this.layer, history: this.history } : await get(id, layerStore).catch(() => null);
    if (!rec) return null;
    return {
      files: [...(rec.files ?? new Map())].map(([path, e]) => ({ path, kind: e.source == null ? 'deleted' : e.base == null ? 'added' : 'modified' })),
      history: (rec.history ?? []).map(historyEntry),
    };
  }

  /** Load a layer record (files + history) without swapping modules. */
  async _loadLayer(id) {
    this.layerId = id;
    const rec = id ? await get(id, layerStore).catch(() => null) : null;
    this.layer = rec?.files instanceof Map ? rec.files : new Map();
    const hist = id ? rec?.history : await get('history', metaStore).catch(() => null);
    this.history = (hist || []).map(historyEntry);
  }

  _saveLayer() {
    if (!this.layerId) return Promise.resolve();
    const rec = { files: new Map(this.layer), history: this.history.map((e) => ({ ...e })), at: Date.now() };
    return set(this.layerId, rec, layerStore).catch((e) => record('warn', [`live: saving the session layer failed: ${e.message}`], 'vfs'));
  }

  /**
   * What runs for one path: the base, or the layer's version of it. A layer file made from an
   * older base is three-way merged onto the current one (and the layer updated); on conflict the
   * layer's version stays as is. -> { source, conflict? }
   */
  _composeFile(path) {
    const baseSrc = this.base.get(path)?.source ?? null;
    const e = this.layer.get(path);
    if (!e) return { source: baseSrc };
    if (e.base === baseSrc) return { source: e.source };
    const r = this._mergeFile(path, e, 'session', baseSrc, 'base');
    if (r.conflict) return { source: e.source, conflict: true };
    const merged = r.same ? baseSrc : r.change;
    if (merged === baseSrc) this.layer.delete(path);
    else this.layer.set(path, { source: merged, base: baseSrc });
    return { source: merged };
  }

  /** The base with the layer on top (merging stale layer files; conflicts are reported). */
  _compose() {
    const out = new Map();
    const conflicts = [];
    for (const path of new Set([...this.base.keys(), ...this.layer.keys()])) {
      const r = this._composeFile(path);
      if (r.conflict) conflicts.push(path);
      if (r.source != null) out.set(path, { source: r.source });
    }
    if (conflicts.length)
      record('warn', [`live: the base changed under this session's own version of ${conflicts.join(', ')} and they conflict; the session's version runs. Resolve it in the Changes window.`], 'vfs');
    return out;
  }

  /**
   * Open a session's layer (null: none, commits go to the base): swap the running modules to the
   * base with that layer on top. Ends a running trial. Overlays stay (they merge onto the new code).
   */
  useLayer(id = null) {
    return this._serial(async () => {
      id = id || null;
      if (id === this.layerId) return { ok: true, changed: [] };
      if (this.trialState) await this._discardTrial();
      await this._saveLayer();
      await this._loadLayer(id);
      await set('layer', id, metaStore).catch(() => {});
      const next = this._compose();
      await this._saveLayer();
      const changes = new Map();
      for (const path of new Set([...this.committed.keys(), ...next.keys()])) {
        const a = this.committed.get(path)?.source ?? null;
        const b = next.get(path)?.source ?? null;
        if (a !== b) changes.set(path, b);
      }
      let result = { ok: true, changed: [] };
      if (changes.size) {
        const s = await this._swapIn(changes, { observeMs: 0, rollbackOnError: false });
        if (s.ok) {
          this.loader.finalize(s.stage);
          result = { ok: true, changed: s.changed, rebuilt: s.stage.rebuilt };
        } else {
          record('error', [`live: the code of this session failed to load:\n${formatErrors(s.errors)}`], 'vfs');
          result = s;
        }
      }
      this.committed = next;
      this._changed();
      return result;
    });
  }

  /** Load every module reachable from the entry. Returns the stage result. */
  async boot() {
    return this._serial(async () => {
      if (this.trialState) await this._discardTrial();
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

  readCommitted(path) {
    return this.committed.get(normalizePath(path))?.source;
  }

  // ---- legacy single-buffer API: the default overlay -----------------------------------

  /** The default overlay's file map (was: the pending buffer). */
  get pending() {
    return this._ov(DEFAULT).files;
  }
  read(path) {
    return this._read(DEFAULT, path);
  }
  /** All paths seen through the default overlay (committed + its edits, minus its deletes). */
  list() {
    return this._list(DEFAULT);
  }
  write(path, source) {
    this._write(DEFAULT, path, source);
  }
  remove(path) {
    this._remove(DEFAULT, path);
  }
  discard(paths) {
    return this._discard(DEFAULT, paths);
  }
  status() {
    return this._status(DEFAULT);
  }
  /**
   * Apply the default overlay as one transaction (see promote). Overlapping edits are not
   * applied; the conflicting files get conflict markers written into the buffer (rebased onto
   * the committed file) so the agent can edit them out and apply again.
   * opts: observeMs (default 800), check, includeConsole (default true), label, intent, origin.
   */
  apply(opts = {}) {
    return this.promote(DEFAULT, { markConflicts: true, ...opts });
  }

  // ---- overlays ------------------------------------------------------------------------

  /**
   * A handle on an overlay (default: the 'default' one), or null if there is none with that id.
   * With { create: true } (plus optional label/origin/peer) a missing overlay is created.
   */
  overlay(id = DEFAULT, { create = false, ...meta } = {}) {
    if (!this.overlayMap.has(id)) {
      if (!create) return null;
      this.createOverlay({ id, ...meta });
    }
    return new Overlay(this, id);
  }

  /** Summaries of every overlay. */
  overlays() {
    return [...this.overlayMap.values()].map((o) => this._summary(o));
  }

  /**
   * Create an overlay. files (optional, e.g. a change published by a peer): an array of
   * { path, source (null = delete), base?, baseHash? } or an object path -> source | { source, base?, baseHash? }.
   * base (string, or null = the file did not exist) is what the change was made from; with only a
   * baseHash (see vfs.hash) the base is looked up among the committed files and the history; with
   * neither, the current committed file is the base.
   */
  createOverlay({ id, label, origin = 'agent', peer, intent, files } = {}) {
    id = id ?? newId('ov-');
    if (this.overlayMap.has(id)) throw new Error(`overlay ${id} already exists`);
    const ov = this._ensureOverlay(id, { label: label ?? id, origin, peer, intent });
    const list = Array.isArray(files)
      ? files
      : Object.entries(files || {}).map(([path, f]) => (typeof f === 'string' || f === null ? { path, source: f } : { path, ...f }));
    for (const f of list) {
      const path = normalizePath(f.path);
      if (!path) throw new Error('empty path');
      const entry = { source: f.source == null ? null : String(f.source) };
      if (f.base !== undefined) entry.base = f.base;
      else if (f.baseHash !== undefined) {
        entry.base = this._findByHash(path, f.baseHash);
        if (entry.base === undefined) entry.baseHash = f.baseHash;
      } else entry.base = this._committedOrNull(path);
      ov.files.set(path, entry);
    }
    this._touch(ov);
    return new Overlay(this, id);
  }

  /** Remove an overlay entirely (the default one is only emptied). Ends its trial, if any, by discarding. */
  deleteOverlay(id) {
    return this._serial(async () => {
      this._ov(id);
      if (this.trialState?.overlayId === id) await this._discardTrial();
      if (id === DEFAULT) this._ov(DEFAULT).files.clear();
      else this.overlayMap.delete(id);
      this._touch();
      return true;
    });
  }

  /** The overlay running on trial: { overlayId, startedAt } or null. */
  get trial() {
    return this.trialState && { overlayId: this.trialState.overlayId, startedAt: this.trialState.startedAt };
  }

  /** fn({ phase: 'start'|'keep'|'discard', overlayId }); 'start' listeners may return a promise, awaited before the swap. */
  onTrial(fn) {
    this.trialListeners.add(fn);
    return () => this.trialListeners.delete(fn);
  }

  _ensureOverlay(id, meta) {
    let ov = this.overlayMap.get(id);
    if (!ov) {
      const now = Date.now();
      ov = { id, origin: 'agent', ...meta, createdAt: now, updatedAt: now, files: new Map() };
      for (const k of Object.keys(ov)) if (ov[k] === undefined) delete ov[k];
      this.overlayMap.set(id, ov);
    }
    return ov;
  }

  _ov(id) {
    const ov = this.overlayMap.get(id);
    if (!ov) throw new Error(`no such overlay: ${id}`);
    return ov;
  }

  _summary(o) {
    return {
      id: o.id,
      label: o.label,
      origin: o.origin,
      peer: o.peer,
      intent: o.intent,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
      files: o.files.size,
      onTrial: this.trialState?.overlayId === o.id,
    };
  }

  _committedOrNull(path) {
    return this.committed.get(path)?.source ?? null;
  }

  _findByHash(path, hash) {
    if (hash == null) return null;
    const cur = this._committedOrNull(path);
    if (hashSource(cur) === hash) return cur;
    for (let i = this.history.length - 1; i >= 0; i--)
      for (const f of this.history[i].files)
        if (f.path === path) for (const s of [f.after, f.before]) if (s != null && hashSource(s) === hash) return s;
    return undefined;
  }

  /** Mark an overlay changed: persist the overlays (coalesced) and notify. */
  _touch(ov) {
    if (ov) ov.updatedAt = Date.now();
    if (!this._saving) {
      this._saving = Promise.resolve().then(() => {
        this._saving = null;
        const plain = [...this.overlayMap.values()].map((o) => ({ ...o, files: new Map(o.files) }));
        return set('overlays', plain, metaStore).catch((e) => record('warn', [`live: saving overlays failed: ${e.message}`], 'vfs'));
      });
    }
    this._changed();
  }

  _read(id, path) {
    path = normalizePath(path);
    const f = this._ov(id).files.get(path);
    if (f) return f.source ?? undefined;
    return this.committed.get(path)?.source;
  }

  _list(id) {
    const paths = new Set(this.committed.keys());
    for (const [p, c] of this._ov(id).files) c.source == null ? paths.delete(p) : paths.add(p);
    return [...paths].sort();
  }

  _write(id, path, source) {
    path = normalizePath(path);
    if (!path) throw new Error('empty path');
    const ov = this._ov(id);
    const prev = ov.files.get(path);
    const entry = prev ? { ...prev, source: String(source) } : { source: String(source), base: this._committedOrNull(path) };
    if (entry.conflicted && !hasConflictMarkers(entry.source)) delete entry.conflicted;
    ov.files.set(path, entry);
    this._dropNoop(ov, path);
    this._touch(ov);
  }

  _remove(id, path) {
    path = normalizePath(path);
    if (this._read(id, path) === undefined) throw new Error(`no such file: ${path}`);
    const ov = this._ov(id);
    const prev = ov.files.get(path);
    const entry = prev ? { ...prev, source: null } : { source: null, base: this._committedOrNull(path) };
    delete entry.conflicted;
    ov.files.set(path, entry);
    this._dropNoop(ov, path);
    this._touch(ov);
  }

  _dropNoop(ov, path) {
    const c = ov.files.get(path);
    const committed = this._committedOrNull(path);
    if (c && c.source === committed && c.base === committed) ov.files.delete(path);
  }

  _discard(id, paths) {
    const ov = this._ov(id);
    const list = paths?.length ? paths.map(normalizePath) : [...ov.files.keys()];
    for (const p of list) ov.files.delete(p);
    this._touch(ov);
    return list;
  }

  _isStale(path, c) {
    const committed = this._committedOrNull(path);
    return c.base === undefined ? c.baseHash !== hashSource(committed) : c.base !== committed;
  }

  _statusOf(path, c) {
    const s = {
      path,
      kind: c.source == null ? 'deleted' : c.base === null || (c.base === undefined && !this.committed.has(path)) ? 'added' : 'modified',
      stale: this._isStale(path, c),
    };
    if (c.conflicted) s.conflicted = true;
    return s;
  }

  _status(id) {
    return [...this._ov(id).files].map(([path, c]) => this._statusOf(path, c));
  }

  _changes(id) {
    return [...this._ov(id).files].map(([path, c]) => ({
      ...this._statusOf(path, c),
      source: c.source,
      base: c.base,
      ...(c.baseHash !== undefined ? { baseHash: c.baseHash } : {}),
    }));
  }

  // ---- merging -------------------------------------------------------------------------

  /**
   * Three-way merge of one file version f ({ source, base }) onto `ours` (default: the committed
   * file; the session layer merges onto the base with it). -> { same } | { change } | { conflict }
   */
  _mergeFile(path, f, label, ours = this._committedOrNull(path), oursLabel = 'committed') {
    const theirs = f.source;
    let base = f.base;
    if (base === undefined && f.baseHash !== undefined && f.baseHash === hashSource(ours)) base = ours;
    if (theirs === ours) return { same: true };
    if (base === ours) return { change: theirs };
    const conflict = (kind, merged) => ({ conflict: { path, kind, base: base ?? null, ours, theirs, merged } });
    if (base === undefined) return conflict('unknown-base', merge3('', ours ?? '', theirs ?? '', { ours: oursLabel, theirs: label }).result);
    if (theirs === base) return { same: true }; // the overlay did not change it; committed did
    if (theirs == null) return conflict('modify/delete', ours); // committed changed it, overlay deletes it
    if (ours == null) return conflict('delete/modify', theirs); // committed deleted it, overlay changed it
    const m = merge3(base ?? '', ours, theirs, { ours: oursLabel, theirs: label });
    if (m.clean) return { change: m.result, merged: true };
    return conflict(base == null ? 'add/add' : 'content', m.result);
  }

  /** What promoting the overlay would do now: { changes: Map path -> source|null, merged: [paths], conflicts, unresolved }. */
  _plan(ov) {
    const changes = new Map();
    const merged = [];
    const conflicts = [];
    const unresolved = [];
    const label = ov.id === DEFAULT ? 'overlay' : `overlay ${ov.id}`;
    for (const [path, f] of ov.files) {
      if (f.conflicted && hasConflictMarkers(f.source)) {
        unresolved.push(path);
        continue;
      }
      const r = this._mergeFile(path, f, label);
      if (r.conflict) conflicts.push(r.conflict);
      else if (!r.same) {
        changes.set(path, r.change);
        if (r.merged) merged.push(path);
      }
    }
    return { changes, merged, conflicts, unresolved };
  }

  _conflictResult(plan, ov, markConflicts) {
    if (markConflicts) {
      // Only text conflicts are written back; modify/delete ones stay as they are.
      for (const c of plan.conflicts)
        if (hasConflictMarkers(c.merged)) ov.files.set(c.path, { source: c.merged, base: c.ours, conflicted: true });
      if (plan.conflicts.length) this._touch(ov);
    }
    const marked = markConflicts
      ? ' The buffer now holds the merge with conflict markers (<<<<<<< committed / ||||||| base / ======= / >>>>>>> overlay) and is rebased onto the committed file: edit the markers out (keep what both sides intended), then apply again.'
      : '';
    const redo = ' Discard the buffered change to this file, re-read it and redo the change.';
    const describe = (c) =>
      ({
        content: 'the committed file and this overlay changed the same lines.',
        'add/add': 'the file was added both in the committed files and in this overlay, with different content.',
        'modify/delete': 'the committed file changed since this overlay deleted it.',
        'delete/modify': 'the committed file was deleted since this overlay changed it.',
        'unknown-base': 'the base this change was made from is unknown here, and it differs from the committed file.',
      })[c.kind] + (hasConflictMarkers(c.merged) ? marked : markConflicts ? redo : '');
    return {
      ok: false,
      phase: 'conflict',
      conflicts: plan.conflicts,
      errors: [
        ...plan.conflicts.map((c) => ({ path: c.path, message: describe(c) })),
        ...plan.unresolved.map((p) => ({ path: p, message: 'still has conflict markers from an earlier merge; edit them out first.' })),
      ],
    };
  }

  /** Dry run of promote: { changes: [paths], merged: [paths], conflicts, unresolved }. */
  preview(id = DEFAULT) {
    const p = this._plan(this._ov(id));
    return { changes: [...p.changes.keys()], merged: p.merged, conflicts: p.conflicts, unresolved: p.unresolved };
  }

  /**
   * Update an overlay's bases to the current committed files. Files that changed underneath are
   * three-way merged into the overlay; paths in `resolved` keep their overlay content as is (you
   * wrote the resolution). Conflicting files stay untouched and are returned, unless
   * markConflicts, which writes the merge with conflict markers into the overlay.
   * -> { ok, rebased: [paths], conflicts }
   */
  rebase(id = DEFAULT, { resolved = [], markConflicts = false } = {}) {
    const ov = this._ov(id);
    const resolvedSet = new Set(resolved.map(normalizePath));
    const rebased = [];
    const conflicts = [];
    const label = id === DEFAULT ? 'overlay' : `overlay ${id}`;
    for (const [path, f] of [...ov.files]) {
      const committed = this._committedOrNull(path);
      if (resolvedSet.has(path)) {
        if (hasConflictMarkers(f.source)) throw new Error(`${path} still has conflict markers`);
        ov.files.set(path, { source: f.source, base: committed });
        rebased.push(path);
      } else if (this._isStale(path, f)) {
        const r = this._mergeFile(path, f, label);
        if (r.conflict) {
          if (markConflicts && hasConflictMarkers(r.conflict.merged)) {
            ov.files.set(path, { source: r.conflict.merged, base: committed, conflicted: true });
            rebased.push(path);
          }
          conflicts.push(r.conflict);
        } else {
          ov.files.set(path, { source: r.same ? f.source : r.change, base: committed });
          rebased.push(path);
        }
      } else continue;
      this._dropNoop(ov, path);
    }
    this._touch(ov);
    return { ok: !conflicts.length, rebased, conflicts };
  }

  /** Write a conflict resolution into an overlay and mark it rebased onto the committed file. */
  resolve(id, path, source) {
    path = normalizePath(path);
    if (source != null && hasConflictMarkers(source)) throw new Error(`${path}: the resolution still has conflict markers`);
    const ov = this._ov(id);
    ov.files.set(path, { source: source == null ? null : String(source), base: this._committedOrNull(path) });
    this._dropNoop(ov, path);
    this._touch(ov);
  }

  /** A foreign-change description of an overlay, for publishing to peers (see createOverlay). */
  exportOverlay(id = DEFAULT) {
    const ov = this._ov(id);
    return {
      id: ov.id,
      label: ov.label,
      intent: ov.intent,
      files: [...ov.files].map(([path, f]) => ({
        path,
        source: f.source,
        base: f.base,
        baseHash: f.base === undefined ? f.baseHash : hashSource(f.base),
      })),
    };
  }

  // ---- transactions ------------------------------------------------------------------

  _busy() {
    const id = this.trialState.overlayId;
    const message = `overlay "${id}" is running on trial; keep or discard the trial first`;
    return { ok: false, phase: 'trial', message, errors: [{ path: '(trial)', message }] };
  }

  /** Remove the promoted files from an overlay; files rewritten meanwhile stay, rebased on the new commit. */
  _settle(ov, snapshot) {
    for (const [p, entry] of snapshot) {
      const cur = ov.files.get(p);
      if (cur === entry) ov.files.delete(p);
      else if (cur) {
        cur.base = this._committedOrNull(p);
        delete cur.baseHash;
        this._dropNoop(ov, p);
      }
    }
    this._touch(ov);
  }

  /**
   * Promote an overlay: merge it onto the committed files and apply that as one transaction.
   * Conflicts -> { ok: false, phase: 'conflict', conflicts: [{ path, kind, base, ours, theirs, merged }], errors }
   * (with markConflicts, the merges with markers are also written into the overlay and rebased).
   * If the overlay is on trial, this keeps the trial.
   * opts: observeMs (default 800), check, includeConsole (default true), rollbackOnError (default true),
   *       label, intent, origin (default: the overlay's), markConflicts.
   */
  promote(id = DEFAULT, opts = {}) {
    return this._serial(async () => {
      const ov = this._ov(id);
      if (this.trialState) return this.trialState.overlayId === id ? this._keep(opts) : this._busy();
      if (!ov.files.size) return { ok: true, message: 'nothing to apply', changed: [] };
      const plan = this._plan(ov);
      if (plan.conflicts.length || plan.unresolved.length) return this._conflictResult(plan, ov, opts.markConflicts);
      const snapshot = new Map(ov.files);
      if (!plan.changes.size) {
        this._settle(ov, snapshot);
        return { ok: true, message: 'nothing to apply (the overlay matches the committed files)', changed: [] };
      }
      const r = await this._transact(plan.changes, this._commitOpts(ov, opts));
      if (r.phase === 'committed') this._settle(ov, snapshot);
      r.merged = plan.merged;
      return r;
    });
  }

  _commitOpts(ov, opts) {
    return { ...opts, origin: opts.origin ?? ov.origin ?? 'agent', overlayId: ov.id, intent: opts.intent ?? ov.intent };
  }


  /**
   * Run an overlay's merged sources live without committing them. Fails (and swaps back) on
   * errors like a transaction. opts: observeMs, check, includeConsole.
   */
  startTrial(id = DEFAULT, opts = {}) {
    return this._serial(async () => {
      const ov = this._ov(id);
      if (this.trialState)
        return this.trialState.overlayId === id ? { ok: false, phase: 'trial', message: `overlay "${id}" is already on trial` } : this._busy();
      const plan = this._plan(ov);
      if (plan.conflicts.length || plan.unresolved.length) return this._conflictResult(plan, ov, false);
      if (!plan.changes.size) return { ok: false, phase: 'trial', message: 'nothing to try: the overlay matches the committed files' };
      await this._emitTrial({ phase: 'start', overlayId: id });
      const s = await this._swapIn(plan.changes, { ...opts, rollbackOnError: true });
      if (!s.ok) {
        await this._emitTrial({ phase: 'discard', overlayId: id });
        return s;
      }
      this.trialState = { overlayId: id, stage: s.stage, changes: plan.changes, snapshot: new Map(ov.files), startedAt: Date.now() };
      this._changed();
      return { ok: true, phase: 'trial', errors: [], rebuilt: s.stage.rebuilt, changed: s.changed, merged: plan.merged };
    });
  }

  /** End the running trial: 'keep' commits it (see promote opts), 'discard' swaps the committed instances back. */
  endTrial(outcome = 'discard', opts = {}) {
    return this._serial(async () => {
      if (!this.trialState) return { ok: false, phase: 'trial', message: 'no trial is running' };
      return outcome === 'keep' ? this._keep(opts) : this._discardTrial();
    });
  }

  async _discardTrial() {
    const t = this.trialState;
    this.trialState = null;
    this.loader.rollback(t.stage);
    await nextFrame();
    await this._emitTrial({ phase: 'discard', overlayId: t.overlayId });
    this._changed();
    return { ok: true, phase: 'discarded', overlayId: t.overlayId, rebuilt: t.stage.rebuilt };
  }

  async _keep(opts) {
    const t = this.trialState;
    const ov = this.overlayMap.get(t.overlayId);
    const plan = ov && this._plan(ov);
    if (plan && !plan.conflicts.length && !plan.unresolved.length && sameChanges(plan.changes, t.changes)) {
      this.trialState = null;
      this.loader.finalize(t.stage);
      const { warnings, entry } = await this._commit(t.changes, this._commitOpts(ov, opts));
      this._settle(ov, t.snapshot);
      await this._emitTrial({ phase: 'keep', overlayId: t.overlayId });
      return { ok: true, phase: 'committed', errors: [], warnings, rebuilt: t.stage.rebuilt, changed: [...t.changes.keys()], merged: plan.merged, entry: entry?.id };
    }
    // The overlay changed during the trial: swap back, then apply its current state as a normal transaction.
    this.trialState = null;
    this.loader.rollback(t.stage);
    await nextFrame();
    if (!plan || plan.conflicts.length || plan.unresolved.length || !plan.changes.size) {
      await this._emitTrial({ phase: 'discard', overlayId: t.overlayId });
      if (!plan) return { ok: false, phase: 'trial', message: `overlay ${t.overlayId} no longer exists; trial discarded` };
      if (!plan.changes.size) return { ok: true, message: 'nothing to apply; trial discarded', changed: [] };
      return this._conflictResult(plan, ov, opts.markConflicts);
    }
    const snapshot = new Map(ov.files);
    const r = await this._transact(plan.changes, this._commitOpts(ov, opts));
    if (r.phase === 'committed') this._settle(ov, snapshot);
    await this._emitTrial({ phase: r.phase === 'committed' ? 'keep' : 'discard', overlayId: t.overlayId });
    r.merged = plan.merged;
    return r;
  }

  async _emitTrial(event) {
    await Promise.all(
      [...this.trialListeners].map(async (fn) => {
        try {
          await fn(event);
        } catch (err) {
          reportError(err, 'vfs.onTrial');
        }
      }),
    );
  }

  /** Undo the last `count` committed transactions, as a transaction itself (they leave the history). */
  revert(count = 1, opts = {}) {
    return this._serial(async () => {
      if (this.trialState) return this._busy();
      const entries = this.history.slice(-count);
      if (!entries.length) return { ok: false, message: 'history is empty' };
      const changes = new Map();
      for (const entry of [...entries].reverse()) for (const ch of entry.files) changes.set(ch.path, ch.before);
      const result = await this._transact(changes, { ...opts, origin: 'revert', record: false });
      if (result.ok) {
        this.history.splice(this.history.length - entries.length, entries.length);
        await this._saveHistory();
        result.reverted = entries.map((e) => ({ id: e.id, label: e.label }));
        this._changed();
      }
      return result;
    });
  }

  /**
   * Undo one history entry by id. The newest entry is reverted like revert(1); an older one is
   * undone by a three-way merge onto the current files and recorded as a new 'revert' entry.
   */
  revertEntry(id, opts = {}) {
    if (this.history[this.history.length - 1]?.id === id) return this.revert(1, opts);
    return this._serial(async () => {
      if (this.trialState) return this._busy();
      const entry = this.history.find((e) => e.id === id);
      if (!entry) return { ok: false, message: `no history entry ${id}` };
      const changes = new Map();
      const conflicts = [];
      for (const f of entry.files) {
        const r = this._mergeFile(f.path, { source: f.before, base: f.after }, `before ${entry.label}`);
        if (r.conflict) conflicts.push(r.conflict);
        else if (!r.same) changes.set(f.path, r.change);
      }
      if (conflicts.length) return this._conflictResult({ conflicts, unresolved: [] }, null, false);
      if (!changes.size) return { ok: true, message: 'nothing to revert', changed: [] };
      const result = await this._transact(changes, { ...opts, origin: 'revert', label: opts.label ?? `revert: ${entry.label}`, revertOf: id });
      if (result.ok) result.reverted = [{ id: entry.id, label: entry.label }];
      return result;
    });
  }

  /**
   * A change that arrived on disk (your editor, or an agent outside the browser): it changes the
   * base. If the open session's layer has its own version of the file, the change is merged under
   * it. Applied without rollback; ends a running trial.
   */
  external({ path, source, mtime }) {
    return this._serial(async () => {
      const b = this.base.get(path);
      if (source == null && !b) return;
      if (b && b.source === source) {
        b.diskMtime = mtime;
        b.mtime = Math.max(b.mtime, mtime);
        await set(path, b, fileStore).catch(() => {});
        return;
      }
      // The watcher reads a file ~120 ms after a write, so the echo of one of our own earlier
      // writes can arrive after a newer commit of the same file: same source and mtime -> ignore.
      if (this._ownWrites.get(path)?.some((w) => w.source === source && w.mtime === mtime)) return;
      if (source == null) {
        this.base.delete(path);
        await set(path, { deleted: true, mtime, source: '' }, fileStore).catch(() => {});
      } else {
        const f = { source, mtime, diskMtime: mtime };
        this.base.set(path, f);
        await set(path, f, fileStore).catch(() => {});
      }
      const r = this._composeFile(path);
      await this._saveLayer();
      if (r.conflict)
        record('warn', [`live: ${path} changed on disk, conflicting with this session's own version, which keeps running. Resolve it in the Changes window.`], 'vfs');
      if ((this.committed.get(path)?.source ?? null) === (r.source ?? null)) return this._changed();
      if (this.trialState) await this._discardTrial();
      const result = await this._transact(new Map([[path, r.source ?? null]]), {
        origin: 'editor',
        fromDisk: true,
        rollbackOnError: false,
        observeMs: 0,
        mtime,
      });
      if (!result.ok) record('error', [`live: ${path} changed on disk and failed:\n${formatErrors(result.errors)}`], 'vfs');
    });
  }

  /** Stage `changes` over the committed files and swap them in; observe; roll back on errors. */
  async _swapIn(changes, opts) {
    const { observeMs = 800, check, includeConsole = true, rollbackOnError = true } = opts;
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
    return { ok: true, stage, errors, changed };
  }

  async _transact(changes, opts) {
    const s = await this._swapIn(changes, opts);
    if (!s.ok) return s;
    this.loader.finalize(s.stage);
    const { warnings, entry } = await this._commit(changes, opts);
    return { ok: s.errors.length === 0, phase: 'committed', errors: s.errors, warnings, rebuilt: s.stage.rebuilt, changed: s.changed, entry: entry?.id };
  }

  async _commit(changes, { origin, label, intent, overlayId, revertOf, mtime, fromDisk, record: addHistory = true }) {
    const warnings = [];
    const now = mtime ?? Date.now();
    const files = [];
    for (const [path, source] of changes) {
      const before = this.committed.get(path)?.source ?? null;
      files.push({ path, before, after: source ?? null });
      if (source == null) this.committed.delete(path);
      else this.committed.set(path, { source });
      if (fromDisk) continue; // external() already updated the base (and the layer)
      if (this.layerId) {
        // The open session's own code: kept in its layer, never written to the base or disk.
        const baseSrc = this.base.get(path)?.source ?? null;
        // A merge of the base into the session (origin 'base-merge') resolves its conflict: it is made from the current base.
        const fileBase = origin === 'base-merge' ? baseSrc : this.layer.get(path)?.base ?? baseSrc;
        if ((source ?? null) === baseSrc && fileBase === baseSrc) this.layer.delete(path);
        else this.layer.set(path, { source: source ?? null, base: fileBase });
      } else if (source == null) {
        this.base.delete(path);
        await set(path, { deleted: true, mtime: now, source: '' }, fileStore).catch(() => {});
        if (this.disk) await diskApi.remove(path).catch((e) => warnings.push(e.message));
      } else {
        const f = { source, mtime: now, diskMtime: this.base.get(path)?.diskMtime ?? null };
        this.base.set(path, f);
        await set(path, f, fileStore).catch(() => {});
        if (this.disk) await this._persistDisk(path).catch((e) => warnings.push(e.message));
      }
    }
    let entry = null;
    if (addHistory) {
      entry = historyEntry({ id: newId(), label, intent, origin, overlayId, revertOf, files, at: Date.now() });
      this.history.push(entry);
      if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT);
    }
    if (addHistory || this.layerId) await this._saveHistory();
    this._changed();
    return { warnings, entry };
  }

  /** Saves the history (with the open layer, which holds its own). */
  _saveHistory() {
    if (this.layerId) return this._saveLayer();
    return set('history', this.history.map((e) => ({ ...e })), metaStore).catch(() => {});
  }

  async _persistDisk(path) {
    const f = this.base.get(path);
    const mtime = await diskApi.write(path, f.source);
    f.mtime = f.diskMtime = mtime;
    const own = this._ownWrites.get(path) || [];
    own.push({ source: f.source, mtime });
    this._ownWrites.set(path, own.slice(-8));
    await set(path, f, fileStore).catch(() => {});
  }

  /** Run arbitrary code with the page context (used by check scripts and eval_js). */
  static compileScript(code, names) {
    return new AsyncFunction(...names, code);
  }
}

/** A handle on one overlay; the same file API as the legacy VFS methods, scoped to the overlay. */
export class Overlay {
  constructor(vfs, id) {
    this.vfs = vfs;
    this.id = id;
  }
  get info() {
    return this.vfs._summary(this.vfs._ov(this.id));
  }
  get exists() {
    return this.vfs.overlayMap.has(this.id);
  }
  read(path) {
    return this.vfs._read(this.id, path);
  }
  write(path, source) {
    this.vfs._write(this.id, path, source);
  }
  remove(path) {
    this.vfs._remove(this.id, path);
  }
  delete(path) {
    this.vfs._remove(this.id, path);
  }
  list() {
    return this.vfs._list(this.id);
  }
  /** [{ path, kind: 'added'|'modified'|'deleted', stale, conflicted? }] (as vfs.status()). */
  status() {
    return this.vfs._status(this.id);
  }
  /** status() plus source, base (and baseHash when the base is unknown). */
  changes() {
    return this.vfs._changes(this.id);
  }
  /** Drop edits (all, or the given paths). Does not end a trial; see endTrial(). */
  discard(paths) {
    return this.vfs._discard(this.id, paths);
  }
  preview() {
    return this.vfs.preview(this.id);
  }
  apply(opts) {
    return this.vfs.promote(this.id, opts);
  }
  promote(opts) {
    return this.vfs.promote(this.id, opts);
  }
  rebase(opts) {
    return this.vfs.rebase(this.id, opts);
  }
  resolve(path, source) {
    this.vfs.resolve(this.id, path, source);
  }
  trial(opts) {
    return this.vfs.startTrial(this.id, opts);
  }
  get onTrial() {
    return this.vfs.trialState?.overlayId === this.id;
  }
  /** Keep this overlay's running trial (commit it). */
  keep(opts) {
    return this.vfs.promote(this.id, opts);
  }
  /** Discard this overlay's running trial (swap the committed instances back); the edits stay. */
  endTrial() {
    if (!this.onTrial) return Promise.resolve({ ok: false, phase: 'trial', message: `overlay "${this.id}" is not on trial` });
    return this.vfs.endTrial('discard');
  }
  export() {
    return this.vfs.exportOverlay(this.id);
  }
  /** Delete the overlay (ends its trial by discarding). */
  drop() {
    return this.vfs.deleteOverlay(this.id);
  }
}

export function formatErrors(errors = []) {
  return errors.map((e) => `- ${e.path}: ${e.message}`).join('\n');
}
