// In-page stress agent. The driver (e2e/stress.mjs) evaluates this file's function in every tab:
//   (AGENT)(config) → installs window.__stress
// It reaches the app through the module loader (fresh module instances on every call, since code
// can be swapped under it) and reports through the console, which the rig writes to the central
// event log (events.jsonl): lines starting with '[stress:metrics]' / '[stress:event]' carry JSON.
(cfg) => {
  if (window.__stress) window.__stress.stop();
  const L = __redaw.runtime.loader;
  const AM = __redaw.vendor['@automerge/automerge-repo']?.Automerge;
  const m = {
    stack: () => L.get('app/stack/stack.js'),
    masks: () => L.get('app/timeline/layers.js'),
    clips: () => L.get('app/timeline/clips.js'),
    history: () => L.get('net/history.js'),
    shared: () => L.get('net/shared.js'),
    session: () => L.get('net/session.js'),
    room: () => L.get('net/room.js'),
    changes: () => L.get('net/changes.js'),
    presence: () => L.get('net/presence.js'),
    tools: () => L.get('chat/tools.js'),
  };
  const name = cfg.name;
  const rnd = (n) => Math.floor(Math.random() * n);
  const pick = (a, hot = 0.6) => (a.length ? a[Math.random() < hot ? rnd(Math.min(3, a.length)) : rnd(a.length)] : undefined);
  const noBig = (_k, x) => (typeof x === 'bigint' ? Number(x) : x);
  const stable = (v) => {
    if (v === undefined) return 'null';
    if (v === null || typeof v !== 'object') return JSON.stringify(v, noBig);
    if (Array.isArray(v) || ArrayBuffer.isView(v)) return `[${Array.from(v, stable).join(',')}]`;
    return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  };
  const fnv = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return (h >>> 0).toString(16).padStart(8, '0');
  };
  const say = (kind, data) => console.debug(`[stress:${kind}] ${JSON.stringify(data, noBig)}`);

  // ---- counters ------------------------------------------------------------------------------
  const st = {
    acts: {}, // type -> count
    actErrors: {}, // type -> { n, last }
    errors: 0, // uncaught errors + rejections + console.error in this page
    lag: [], // propagation lag samples (ms) of other peers' probe stamps, since the last report
    loopMax: 0, // worst event-loop delay (ms) since the last report
    longtasks: 0,
    longMs: 0,
  };
  const act = (type, fn) => {
    try {
      const r = fn();
      st.acts[type] = (st.acts[type] ?? 0) + 1;
      if (r && typeof r.then === 'function') r.catch((e) => actError(type, e));
      return r;
    } catch (e) {
      actError(type, e);
    }
  };
  const actError = (type, e) => {
    const a = (st.actErrors[type] ??= { n: 0, last: '' });
    a.n++;
    a.last = String(e?.message || e).slice(0, 300);
    if (a.n <= 3) say('event', { kind: 'act-error', type, message: a.last });
  };
  const onErr = () => st.errors++;
  addEventListener('error', onErr);
  addEventListener('unhandledrejection', onErr);
  const origError = console.error;
  console.error = (...a) => (st.errors++, origError.apply(console, a));

  let po;
  try {
    po = new PerformanceObserver((l) => l.getEntries().forEach((e) => (st.longtasks++, (st.longMs += e.duration))));
    po.observe({ type: 'longtask', buffered: false });
  } catch {}
  let loopLast = performance.now();
  const loopTimer = setInterval(() => {
    const now = performance.now();
    st.loopMax = Math.max(st.loopMax, now - loopLast - 100);
    loopLast = now;
  }, 100);

  // ---- probe: everyone stamps the document; others measure how long a stamp takes to arrive -----
  let n = 0;
  const seen = {};
  const handle = () => m.session().handle.value;
  // One top-level key per peer: a map several peers create concurrently would lose all but one's stamps.
  const stamp = () => handle()?.change((d) => {
    d[`stress:${name}`] = { n: ++n, at: Date.now() };
  });
  let watched = null;
  const onDoc = ({ doc }) => {
    if (!doc) return;
    const now = Date.now();
    for (const key of Object.keys(doc)) {
      if (!key.startsWith('stress:') || key === `stress:${name}`) continue;
      const peer = key.slice(7);
      const { n: pn, at } = doc[key];
      if (seen[peer] !== undefined && pn > seen[peer]) st.lag.push(now - Number(at));
      seen[peer] = Number(pn);
    }
  };
  const watch = () => {
    const h = handle();
    if (h === watched) return;
    watched?.off('change', onDoc);
    watched = h;
    h?.on('change', onDoc);
  };
  let probeTimer = 0;
  const probe = () => {
    clearInterval(probeTimer);
    probeTimer = setInterval(() => (watch(), stamp()), cfg.probeMs ?? 1000);
  };
  probe();

  // ---- state ---------------------------------------------------------------------------------
  /** The document without the probe key, as a digest; plus the local view of each shared key. */
  function snapshot({ bytes = false } = {}) {
    const h = handle();
    const doc = h?.doc();
    const rest = doc ? JSON.parse(JSON.stringify(doc, noBig)) : {};
    for (const k of Object.keys(rest)) if (k.startsWith('stress')) delete rest[k];
    const heads = doc && AM ? AM.getHeads(doc) : [];
    const sig = {
      stack: m.stack().stack.value.map(({ inputDevice, funcChat, armed, ...l }) => l),
      masks: m.masks().layers.value,
      masked: m.masks().masked.value,
      clips: m.clips().clips.value.filter((c) => !c.recording).map(({ data, ...c }) => ({ ...c, n: data?.length })),
    };
    const out = {
      heads: fnv(heads.slice().sort().join(',')),
      doc: fnv(stable(rest)),
      view: Object.fromEntries(Object.entries(sig).map(([k, v]) => [k, fnv(stable(v))])),
      counts: { layers: sig.stack.length, masks: sig.masks.length, clips: sig.clips.length, published: m.changes().published.value.length, history: m.history().entries.value.length },
      peers: m.room().openPeers().length,
      presence: Object.keys(m.presence().others.value).length,
      status: m.session().status.value,
      recovery: document.querySelector('[data-recovery]')?.dataset.recovery ?? null,
      app: !!document.querySelector('.timeline'),
      invariants: invariants(rest),
    };
    if (bytes && doc && AM) {
      const t0 = performance.now();
      const bin = AM.save(doc);
      const t1 = performance.now();
      AM.load(bin);
      out.docBytes = bin.byteLength;
      out.saveMs = Math.round(t1 - t0);
      out.loadMs = Math.round(performance.now() - t1);
      out.changes = AM.getAllChanges ? AM.getAllChanges(doc).length : undefined;
    }
    return out;
  }

  /** Breaches of what the app assumes about shared state, local view and document. */
  function invariants(doc) {
    const bad = [];
    const add = (s) => bad.length < 20 && bad.push(s);
    const fin = (x) => typeof x === 'number' && Number.isFinite(x);
    const stack = m.stack().stack.value;
    const types = m.stack().LAYER_TYPES;
    const ids = new Set();
    for (const l of stack) {
      if (!l || typeof l.id !== 'string') add('stack: layer without id');
      else if (ids.has(l.id)) add(`stack: duplicate ${l.id}`);
      ids.add(l?.id);
      if (l && !types[l.type]) add(`stack: layer ${l.id} has type ${JSON.stringify(l.type)}`);
      if (l && typeof l.name !== 'string') add(`stack: layer ${l.id} without name`);
    }
    const masked = m.masks().masked.value;
    for (const k of Object.keys(masked)) if (!ids.has(k)) add(`masked: orphan ${k}`);
    for (const mk of m.masks().layers.value) {
      if (!['t', 'dur', 'y', 'h'].every((f) => fin(mk[f]))) add(`mask ${mk.id}: non-finite geometry`);
      if (!ids.has(mk.layerId)) add(`mask ${mk.id}: orphan of ${mk.layerId}`);
    }
    for (const c of m.clips().clips.value) {
      if (c.recording) continue;
      if (!['t', 'y', 'rate', 'dim', 'length'].every((f) => fin(c[f]))) add(`clip ${c.id}: non-finite fields`);
      else if (c.data?.length !== c.length * c.dim) add(`clip ${c.id}: data ${c.data?.length} != ${c.length}*${c.dim}`);
    }
    // Document: list keys' order and items agree.
    for (const [key, v] of Object.entries(doc?.state ?? {})) {
      if (!v || typeof v !== 'object' || !v.items || !Array.isArray(v.order)) continue;
      const order = v.order;
      if (new Set(order).size !== order.length) add(`doc ${key}: duplicate ids in order`);
      for (const id of Object.keys(v.items)) if (!order.includes(id)) add(`doc ${key}: item ${id} not in order`);
      for (const [id, e] of Object.entries(v.items)) if (!e || typeof e !== 'object' || e.id !== id) add(`doc ${key}: item ${id} malformed`);
    }
    return bad;
  }

  const pct = (a, p) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : null);
  let reports = 0;
  function report() {
    const snap = snapshot({ bytes: ++reports % (cfg.bytesEvery ?? 5) === 0 });
    const lag = st.lag.splice(0);
    say('metrics', {
      ...snap,
      lag: { n: lag.length, p50: pct(lag, 0.5), p95: pct(lag, 0.95), max: lag.length ? Math.max(...lag) : null },
      loopMax: Math.round(st.loopMax),
      longtasks: st.longtasks,
      longMs: Math.round(st.longMs),
      heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null,
      errors: st.errors,
      acts: st.acts,
      actErrors: Object.fromEntries(Object.entries(st.actErrors).map(([k, v]) => [k, v.n])),
    });
    st.loopMax = 0;
  }
  const reportTimer = setInterval(report, cfg.reportMs ?? 2000);

  // ---- chaos ---------------------------------------------------------------------------------
  const TYPES = ['latent', 'operator', 'audio-in', 'audio-out'];
  const randArea = () => ({ t: Math.random() * 20, dur: 0.5 + Math.random() * 5, y: Math.random() * 400 - 200, h: 10 + Math.random() * 80 });
  const newClip = () => {
    const length = 4 + rnd(12);
    const dim = 4;
    const data = new Float32Array(length * dim).map(() => Math.random());
    return { id: crypto.randomUUID(), t: Math.random() * 20, y: Math.random() * 400 - 200, rate: 4, dim, length, data };
  };
  const drags = new Set();
  /** Moves a clip 25 times a second for ms, like a pointer drag. */
  function drag(id, ms = 1000) {
    const C = m.clips();
    const c = C.clips.value.find((x) => x.id === id);
    if (!c) return;
    let k = 0;
    const iv = setInterval(() => {
      if (++k * 40 > ms) return void (clearInterval(iv), drags.delete(iv));
      m.clips().updateClip(id, { t: c.t + k * 0.05, y: c.y + Math.sin(k) * 5 });
    }, 40);
    drags.add(iv);
  }

  const actions = {
    'layer.insert': () => m.stack().stack.value.length < 12 && m.stack().insertLayer(pick(TYPES, 0)),
    'layer.remove': () => {
      const s = m.stack().stack.value;
      if (s.length > 2) m.stack().removeStackLayer(pick(s).id);
    },
    'layer.rename': () => {
      const l = pick(m.stack().stack.value);
      l && m.stack().updateStackLayer(l.id, { name: `${name} ${rnd(1000)}` });
    },
    'layer.hue': () => {
      const l = pick(m.stack().stack.value);
      l && m.stack().updateStackLayer(l.id, { hue: rnd(360) });
    },
    'layer.move': () => {
      const s = m.stack().stack.value;
      const l = pick(s);
      l && m.stack().moveLayer(l.id, rnd(s.length + 1));
    },
    'layer.passThrough': () => {
      const l = pick(m.stack().stack.value.filter((x) => x.type === 'latent'));
      l && m.stack().togglePassThrough(l.id);
    },
    'mask.add': () => {
      const l = pick(m.stack().stack.value);
      l && m.masks().addMaskArea(l.id, randArea());
    },
    'mask.cut': () => {
      const l = pick(m.stack().stack.value);
      l && m.masks().cutMaskArea(l.id, randArea());
    },
    'mask.clear': () => {
      const l = pick(m.stack().stack.value);
      l && m.masks().clearMask(l.id);
    },
    'clip.add': () => {
      const owner = pick(m.stack().stack.value.filter((l) => l.type === 'latent')); // every clip is on a latent layer
      if (owner && m.clips().clips.value.length < 30) m.clips().addClip({ ...newClip(), layer: owner.id });
    },
    'clip.remove': () => {
      const c = pick(m.clips().clips.value);
      c && m.clips().removeClip(c.id);
    },
    'clip.move': () => {
      const c = pick(m.clips().clips.value);
      c && m.clips().updateClip(c.id, { t: Math.random() * 20, y: Math.random() * 400 - 200 });
    },
    'clip.drag': () => {
      const c = pick(m.clips().clips.value);
      c && drag(c.id);
    },
    'clip.front': () => {
      const c = pick(m.clips().clips.value);
      c && m.clips().bringToFront(c.id);
    },
    'clip.select': () => {
      const c = pick(m.clips().clips.value);
      m.clips().selectedId.value = c?.id ?? null;
    },
    cursor: () => {
      const el = document.querySelector('.timeline');
      el?.dispatchEvent(new PointerEvent('pointermove', { clientX: 50 + rnd(700), clientY: 50 + rnd(600), bubbles: true }));
    },
    undo: () => m.history().undoLast(),
    restore: () => {
      const list = m.history().list({ limit: 30 });
      const e = pick(list, 0);
      if (e) m.history().restore(`${Math.random() < 0.5 ? 'before:' : ''}${e.id}`, Math.random() < 0.5 ? { key: pick(e.keys, 0) } : {});
    },
  };
  const DEFAULT_WEIGHTS = {
    'layer.insert': 3, 'layer.remove': 2, 'layer.rename': 4, 'layer.hue': 3, 'layer.move': 3, 'layer.passThrough': 1,
    'mask.add': 4, 'mask.cut': 2, 'mask.clear': 1,
    'clip.add': 3, 'clip.remove': 2, 'clip.move': 4, 'clip.drag': 1, 'clip.front': 1, 'clip.select': 2,
    cursor: 6, undo: 2, restore: 0.3,
  };

  let chaosTimer = 0;
  function chaos({ rate = 5, weights = {} } = {}) {
    clearInterval(chaosTimer);
    probe();
    if (!rate) return;
    const w = Object.entries({ ...DEFAULT_WEIGHTS, ...weights }).filter(([, x]) => x > 0);
    const total = w.reduce((a, [, x]) => a + x, 0);
    chaosTimer = setInterval(() => {
      let r = Math.random() * total;
      const [type] = w.find(([, x]) => (r -= x) < 0) ?? w[0];
      act(type, actions[type]);
    }, 1000 / rate);
  }

  // ---- targeted scenarios ---------------------------------------------------------------------
  /** Everyone calls this at the same moment with the same target: edit vs remove races. */
  function race({ role, layerId, clipId }) {
    const S = m.stack();
    if (role === 'remove') {
      if (layerId) act('race.removeLayer', () => S.removeStackLayer(layerId));
      if (clipId) act('race.removeClip', () => m.clips().removeClip(clipId));
    } else {
      if (layerId) {
        act('race.editLayer', () => S.updateStackLayer(layerId, { name: `${name} race`, hue: rnd(360) }));
        act('race.maskLayer', () => m.masks().addMaskArea(layerId, randArea()));
      }
      if (clipId) act('race.editClip', () => m.clips().updateClip(clipId, { t: Math.random() * 20 }));
    }
  }

  /** Writes malformed values straight into the document, as buggy or hostile peer code could. */
  function poison(kind) {
    const h = handle();
    const first = (d, key) => d.state?.[key]?.order?.[0];
    const P = {
      'layer-bad-type': (d) => {
        const id = first(d, 'stack.layers');
        if (id) d.state['stack.layers'].items[id].type = 'bogus';
      },
      'layer-no-fields': (d) => {
        const id = crypto.randomUUID();
        d.state['stack.layers'].items[id] = { id };
        d.state['stack.layers'].order.push(id);
      },
      'layer-name-object': (d) => {
        const id = first(d, 'stack.layers');
        if (id) d.state['stack.layers'].items[id].name = { evil: true };
      },
      'order-unknown-id': (d) => d.state['stack.layers'].order.push('no-such-layer'),
      'item-null': (d) => {
        const id = first(d, 'timeline.layers');
        if (id) d.state['timeline.layers'].items[id] = null;
      },
      'mask-nan': (d) => {
        const id = first(d, 'timeline.layers');
        if (id) d.state['timeline.layers'].items[id].dur = 'NaN';
      },
      'clip-bad-length': (d) => {
        const id = first(d, 'timeline.clips');
        if (id) d.state['timeline.clips'].items[id].length = -5;
      },
      'clip-missing-hash': (d) => {
        const id = crypto.randomUUID();
        d.state['timeline.clips'].items[id] = { id, t: 1, y: 0, rate: 4, dim: 4, length: 4, dataHash: 'f'.repeat(64) };
        d.state['timeline.clips'].order.push(id);
      },
      'masked-string': (d) => (d.state['timeline.masked'] = 'nope'),
      'state-key-array': (d) => (d.state['stack.layers'] = []),
      'huge-string': (d) => {
        const id = first(d, 'stack.layers');
        if (id) d.state['stack.layers'].items[id].name = 'x'.repeat(2_000_000);
      },
      'change-bad': (d) => {
        d.code ??= {};
        d.code.changes ??= {};
        d.code.changes.poison = { id: 'poison', name: 42, files: 'nope', at: 'later' };
      },
    };
    if (!P[kind]) throw new Error(`unknown poison ${kind}; have ${Object.keys(P).join(', ')}`);
    const d0 = JSON.parse(JSON.stringify(h.doc(), noBig));
    beforePoison = { state: d0.state, code: d0.code };
    h.change((d) => {
      d.state ??= {};
      P[kind](d);
    });
    say('event', { kind: 'poisoned', poison: kind });
    return Object.keys(P);
  }

  let beforePoison = null;
  /** Puts state and code back as they were before the last poison (writers must be quiet). */
  function unpoison() {
    if (!beforePoison) return false;
    const b = beforePoison;
    beforePoison = null;
    handle().change((d) => {
      d.state = b.state ?? {};
      d.code = b.code ?? { changes: {}, incorporated: {} };
    });
    say('event', { kind: 'unpoisoned' });
    return true;
  }

  /** Leaves the room (keeps editing locally) or rejoins it. */
  let parked = null;
  function partition(on) {
    const R = m.room();
    if (on) {
      parked = R.current.value;
      R.leave();
    } else if (parked) {
      R.join(parked);
      parked = null;
    }
    say('event', { kind: on ? 'partitioned' : 'rejoined' });
  }

  // ---- code changes ----------------------------------------------------------------------------
  const tool = (tname, input) => m.tools().runTool({ id: `stress-${Math.random()}`, name: tname, input }, {});
  /** A code change through the agent's tools (published automatically). shared: one file everyone edits. */
  async function codeChange({ file = `stress/${name}.js`, follows } = {}) {
    const path = file;
    const cur = __redaw.runtime.vfs.readCommitted(`live/${path}`) ?? __redaw.runtime.vfs.readCommitted(path);
    const line = `export const v_${name.replace(/\W/g, '_')}_${rnd(1e6)} = ${rnd(1000)};\n`;
    const r1 = await tool('str_replace_based_edit_tool', cur == null ? { command: 'create', path, file_text: line } : { command: 'create', path, file_text: cur + line });
    const r2 = await tool('apply_changes', { label: `${name} edits ${path}`, follows, observe_ms: 100 });
    const id = r2.content.match(/as change (\w+)/)?.[1] ?? null;
    say('event', { kind: 'code-change', path, ok: !r2.is_error, published: id, result: String(r2.content).slice(0, 300), edit: String(r1.content).slice(0, 120) });
    return id;
  }
  /** Tries to incorporate every incoming change: apply if clean, else record why not. */
  async function incorporate() {
    const C = m.changes();
    const out = [];
    for (const c of C.incoming.value.slice().reverse()) {
      try {
        if (C.isApplied(c)) {
          C.markApplied(c.id);
          out.push([c.id, 'same']);
          continue;
        }
        const p = C.plan(c.id);
        if (!p.clean) {
          out.push([c.id, p.missing.length ? 'missing' : 'stale']);
          continue;
        }
        const r = await C.apply(c.id, { observeMs: 100 });
        out.push([c.id, r.ok ? 'applied' : `failed: ${r.message || r.phase}`]);
      } catch (e) {
        out.push([c.id, `error: ${e.message}`]);
      }
    }
    say('event', { kind: 'incorporate', results: out });
    return out;
  }

  // ---- control ---------------------------------------------------------------------------------
  function stop() {
    clearInterval(chaosTimer);
    clearInterval(probeTimer);
    clearInterval(reportTimer);
    clearInterval(loopTimer);
    drags.forEach(clearInterval);
    po?.disconnect();
    watched?.off('change', onDoc);
    removeEventListener('error', onErr);
    removeEventListener('unhandledrejection', onErr);
    console.error = origError;
    delete window.__stress;
  }
  /** Stops writes (chaos, drags, probe) so the session can settle. */
  function quiet() {
    clearInterval(chaosTimer);
    clearInterval(probeTimer);
    drags.forEach(clearInterval);
    drags.clear();
  }

  m.changes().myName.value = name;
  window.__stress = { chaos, quiet, stop, snapshot, report, race, poison, unpoison, partition, codeChange, incorporate, st, actions };
  say('event', { kind: 'installed', name });
  return true;
};
