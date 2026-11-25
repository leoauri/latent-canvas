#!/usr/bin/env node
// Stress test for multiplayer sessions: N tabs (separate profiles) join one session and are driven
// through phases designed to hit the breaking points listed in e2e/stress/README.md. Runs against
// the e2e rig (scripts/e2e.mjs up), so every tab's console and errors land in the rig's central
// event log (e2e/out/<run>/events.jsonl), and tabs can be inspected mid-run with
// `node scripts/e2e.mjs P3 eval '…'`.
//
//   E2E_PORT=5680 node scripts/e2e.mjs up
//   E2E_PORT=5680 node e2e/stress.mjs [--peers 6] [--scale 1] [--phases warm,storm,…] [--soak 0]
//
// Phases (default: all but soak, in this order):
//   warm       light random edits                       baseline lag and convergence
//   storm      heavy random edits, hot entities          same-field conflicts, order merges, CPU
//   race       remove vs edit of one entity, at once     resurrected/partial entities, orphan masks
//   partition  half the peers offline, both halves edit  big merges after healing
//   churn      random reloads during edits               rejoin, re-sync, seeding races
//   code       concurrent agent changes, follow-ups      publish/incorporate under contention
//   poison     malformed values written to the doc       crash isolation (runs last: may break)
//   soak       moderate edits for --soak minutes         document growth, save/load time, memory
// After each phase writers stop and the driver waits for all peers to converge (same heads,
// document and view digests), then checks invariants and errors.
//
// Output: e2e/out/<run>/stress-report.json and stress-report.md; progress on stdout.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT) || 5199;
const CONTROL = PORT - 1;

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i === -1 ? d : argv[i + 1];
};
const PEERS = Number(opt('peers', 6));
const SCALE = Number(opt('scale', 1));
const SOAK_MIN = Number(opt('soak', 0));
const ALL = ['warm', 'storm', 'race', 'partition', 'churn', 'code', 'poison', 'soak'];
const PHASES = opt('phases', ALL.filter((p) => p !== 'soak' || SOAK_MIN > 0).join(',')).split(',');
const tabs = Array.from({ length: PEERS }, (_, i) => `P${i + 1}`);
const sec = (s) => Math.round(s * SCALE * 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rig(body) {
  const res = await fetch(`http://127.0.0.1:${CONTROL}/`, { method: 'POST', body: JSON.stringify(body) }).catch(() => null);
  if (!res) throw new Error(`rig is not running on ${PORT}: E2E_PORT=${PORT} node scripts/e2e.mjs up`);
  const out = await res.json();
  if (out.error) throw new Error(`${body.tab ?? ''} ${body.op}: ${out.error}`);
  return out.result;
}
const evalIn = (tab, src) => rig({ tab, op: 'eval', args: [src] });
const all = (fn) => Promise.all(tabs.map(fn));
const note = (text) => rig({ op: 'log', args: [text] }).catch(() => {});
const t0 = Date.now();
const log = (...a) => {
  const line = `[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${a.join(' ')}`;
  console.log(line);
  note(line);
};

const AGENT = (await fs.readFile(path.join(ROOT, 'e2e/stress/agent.js'), 'utf8')).replace(/^\s*\/\/.*$/gm, '').trim().replace(/;\s*$/, '');
const install = (tab) => evalIn(tab, `() => (${AGENT})(${JSON.stringify({ name: tab })})`);
const S = (tab, call) => evalIn(tab, `async () => { if (!window.__stress) throw new Error('agent not installed'); return await window.__stress.${call}; }`);

// ---- convergence -------------------------------------------------------------------------------

async function snapshots(bytes = false) {
  return Object.fromEntries(await all(async (t) => [t, await S(t, `snapshot({ bytes: ${bytes} })`).catch((e) => ({ error: e.message }))]));
}
const sameAll = (snaps, f) => new Set(Object.values(snaps).map(f)).size === 1;

/** Stops writes everywhere and waits until all peers agree. → { ok, ms, snaps, diff } */
async function settle(label, timeout = 45000) {
  await all((t) => S(t, 'quiet()').catch(() => {}));
  const start = Date.now();
  let snaps;
  while (Date.now() - start < timeout) {
    await sleep(1000);
    snaps = await snapshots();
    if (Object.values(snaps).some((s) => s.error)) continue;
    if (sameAll(snaps, (s) => s.heads) && sameAll(snaps, (s) => s.doc) && sameAll(snaps, (s) => JSON.stringify(s.view))) {
      const ms = Date.now() - start;
      log(`${label}: converged in ${(ms / 1000).toFixed(1)}s`);
      return { ok: true, ms, snaps: await snapshots(true) };
    }
  }
  const diff = {};
  for (const f of ['heads', 'doc', 'peers', 'status', 'recovery']) diff[f] = Object.fromEntries(Object.entries(snaps).map(([t, s]) => [t, s[f] ?? s.error]));
  diff.view = Object.fromEntries(Object.entries(snaps).map(([t, s]) => [t, s.view]));
  log(`${label}: NOT converged after ${timeout / 1000}s`, JSON.stringify(diff));
  return { ok: false, ms: timeout, snaps, diff };
}

// ---- events ------------------------------------------------------------------------------------

let eventsFile;
let eventsRead = 0;
/** New lines of the central event log since the last call. */
async function newEvents() {
  const text = await fs.readFile(eventsFile, 'utf8').catch(() => '');
  const lines = text.slice(eventsRead).split('\n');
  const tail = lines.pop();
  eventsRead = text.length - tail.length;
  return lines.filter(Boolean).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter(Boolean);
}
const NOISE = /\[vite\]|Download the React DevTools|stress:/;
/** Errors and warnings in events: pageerrors, console errors/warnings (not the agent's own). */
function problems(events) {
  const out = [];
  for (const e of events) {
    if (e.kind === 'pageerror' || e.kind === 'crash' || ((e.kind === 'error' || e.kind === 'warning') && !NOISE.test(e.text))) out.push(e);
    if (e.kind === 'debug' && e.text.startsWith('[stress:event]') && /act-error/.test(e.text)) out.push({ ...e, kind: 'act-error' });
  }
  return out;
}
function metricsOf(events) {
  const rows = [];
  for (const e of events)
    if (e.kind === 'debug' && e.text.startsWith('[stress:metrics] ')) {
      try {
        rows.push({ tab: e.tab, t: e.t, ...JSON.parse(e.text.slice(17)) });
      } catch {}
    }
  const max = (f) => rows.reduce((a, r) => Math.max(a, f(r) ?? -Infinity), -Infinity);
  const fin = (x) => (Number.isFinite(x) ? x : null);
  return {
    samples: rows.length,
    lagP95Max: fin(max((r) => r.lag?.p95)),
    lagMax: fin(max((r) => r.lag?.max)),
    loopMax: fin(max((r) => r.loopMax)),
    longMsMax: fin(max((r) => r.longMs)),
    heapMBMax: fin(max((r) => r.heapMB)),
    docBytesMax: fin(max((r) => r.docBytes)),
    saveMsMax: fin(max((r) => r.saveMs)),
    loadMsMax: fin(max((r) => r.loadMs)),
    peersMin: fin(-max((r) => -r.peers)),
    invariantBreaches: [...new Set(rows.flatMap((r) => r.invariants ?? []))].slice(0, 20),
    actErrors: rows.reduce((acc, r) => {
      for (const [k, v] of Object.entries(r.actErrors ?? {})) acc[k] = Math.max(acc[k] ?? 0, v);
      return acc;
    }, {}),
  };
}

// ---- phases ------------------------------------------------------------------------------------

const results = [];
async function phase(name, fn) {
  if (!PHASES.includes(name)) return;
  log(`=== ${name}`);
  await newEvents(); // start this phase's window
  const started = Date.now();
  let extra = {};
  let error = null;
  try {
    extra = (await fn()) ?? {};
  } catch (e) {
    error = String(e.message || e);
    log(`${name}: driver error: ${error}`);
  }
  const conv = await settle(name);
  const events = await newEvents();
  const probs = problems(events);
  const invariants = Object.fromEntries(Object.entries(conv.snaps ?? {}).map(([t, s]) => [t, s.invariants ?? s.error]).filter(([, v]) => v?.length));
  const recovery = Object.fromEntries(Object.entries(conv.snaps ?? {}).filter(([, s]) => s.recovery || s.app === false).map(([t, s]) => [t, s.recovery ?? 'app not rendered']));
  const r = {
    phase: name,
    seconds: Math.round((Date.now() - started) / 1000),
    converged: conv.ok,
    convergeMs: conv.ms,
    diff: conv.diff,
    final: Object.values(conv.snaps ?? {})[0] && (({ counts, docBytes, saveMs, loadMs, changes }) => ({ counts, docBytes, saveMs, loadMs, changes }))(Object.values(conv.snaps)[0]),
    invariants,
    recovery,
    problems: probs.length,
    problemSamples: dedupe(probs).slice(0, 25),
    metrics: metricsOf(events),
    error,
    ...extra,
  };
  results.push(r);
  log(`${name}: converged=${r.converged} problems=${r.problems} invariants=${Object.keys(invariants).length ? JSON.stringify(invariants) : 'ok'} recovery=${Object.keys(recovery).length ? JSON.stringify(recovery) : 'none'}`);
  log(`${name}: metrics ${JSON.stringify(r.metrics)}`);
  await writeReport();
}
function dedupe(probs) {
  const seen = new Map();
  for (const p of probs) {
    const key = `${p.kind}:${p.text.replace(/[0-9a-f-]{8,}/gi, '…').slice(0, 160)}`;
    const s = seen.get(key);
    if (s) s.count++, s.tabs.add(p.tab);
    else seen.set(key, { kind: p.kind, text: p.text.slice(0, 600), count: 1, tabs: new Set([p.tab]) });
  }
  return [...seen.values()].sort((a, b) => b.count - a.count).map((s) => ({ ...s, tabs: [...s.tabs] }));
}

const chaosAll = (rate, weights = {}) => all((t) => S(t, `chaos(${JSON.stringify({ rate, weights })})`));
let link;

async function setup() {
  const status = await rig({ op: 'status' });
  eventsFile = path.join(ROOT, status.events);
  log(`rig ${status.url}, run ${status.runDir}, ${PEERS} peers, scale ${SCALE}, phases ${PHASES.join(',')}`);
  log(`event log: ${status.events}`);
  for (const t of tabs) await rig({ tab: t, op: 'init', args: ['globalThis.__REDAW_NO_DISK__ = true'] });
  await rig({ tab: tabs[0], op: 'goto', args: [''] });
  link = await evalIn(tabs[0], `() => __redaw.runtime.loader.get('net/session.js').shareLink.value`);
  if (!link) throw new Error('P1 has no share link');
  const frag = link.slice(link.indexOf('#'));
  const joinStart = Date.now();
  await Promise.all(tabs.slice(1).map((t) => rig({ tab: t, op: 'goto', args: [frag] })));
  await all(install);
  // Full mesh: everyone sees everyone.
  let mesh;
  for (let i = 0; i < 90; i++) {
    mesh = await all((t) => evalIn(t, `() => __redaw.runtime.loader.get('net/room.js').openPeers().length`));
    if (mesh.every((n) => n === PEERS - 1)) break;
    await sleep(1000);
  }
  log(`mesh: ${mesh.join(',')} open peers after ${((Date.now() - joinStart) / 1000).toFixed(1)}s`);
  results.push({ phase: 'setup', meshMs: Date.now() - joinStart, mesh });
}

async function run() {
  await setup();

  await phase('warm', async () => {
    await chaosAll(2);
    await sleep(sec(20));
  });

  await phase('storm', async () => {
    await chaosAll(12, { 'clip.drag': 3 });
    await sleep(sec(60));
  });

  await phase('race', async () => {
    const rounds = [];
    for (let i = 0; i < 6; i++) {
      // A fresh layer and clip everyone has, then one peer removes them while the others edit them.
      const ids = await evalIn(tabs[0], `() => { const S = __redaw.runtime.loader.get('app/stack/stack.js'); const C = __redaw.runtime.loader.get('app/timeline/clips.js');
        const l = S.insertLayer('operator'); const c = { id: crypto.randomUUID(), t: 1, y: 0, rate: 4, dim: 4, length: 4, data: new Float32Array(16), layer: S.stack.value.find((x) => x.type === 'latent').id }; C.addClip(c); return { layerId: l.id, clipId: c.id }; }`);
      const ready = await waitAll(`(() => { const S = __redaw.runtime.loader.get('app/stack/stack.js'); const C = __redaw.runtime.loader.get('app/timeline/clips.js'); return !!S.stackLayerById(${JSON.stringify(ids.layerId)}) && C.clips.value.some((c) => c.id === ${JSON.stringify(ids.clipId)}); })()`, 15000);
      const remover = tabs[i % PEERS];
      await all((t) => S(t, `race(${JSON.stringify({ ...ids, role: t === remover ? 'remove' : 'edit' })})`));
      await sleep(3000);
      const after = await all((t) => evalIn(t, `() => { const S = __redaw.runtime.loader.get('app/stack/stack.js'); const C = __redaw.runtime.loader.get('app/timeline/clips.js'); const L = __redaw.runtime.loader.get('app/timeline/layers.js');
        return { layer: S.stackLayerById(${JSON.stringify(ids.layerId)}) ?? null, clip: C.clips.value.find((c) => c.id === ${JSON.stringify(ids.clipId)})?.t ?? null, masks: L.layers.value.filter((m) => m.layerId === ${JSON.stringify(ids.layerId)}).length }; }`));
      rounds.push({ ready, remover, after: Object.fromEntries(tabs.map((t, k) => [t, after[k]])) });
      log(`race ${i + 1}: remover ${remover}, layer kept by ${after.filter((a) => a.layer).length}/${PEERS} (fields: ${[...new Set(after.filter((a) => a.layer).map((a) => Object.keys(a.layer).sort().join('+')))].join(' | ') || '-'}), clip kept by ${after.filter((a) => a.clip != null).length}, orphan masks ${after.map((a) => a.masks).join(',')}`);
    }
    return { rounds };
  });

  await phase('partition', async () => {
    const half = tabs.slice(0, Math.floor(PEERS / 2));
    await chaosAll(5);
    await sleep(sec(5));
    await Promise.all(half.map((t) => S(t, 'partition(true)')));
    log(`partitioned: ${half.join(',')} offline`);
    await sleep(sec(30));
    await Promise.all(half.map((t) => S(t, 'partition(false)')));
    log('healed');
    await sleep(sec(5));
  });

  await phase('churn', async () => {
    await chaosAll(4);
    const end = Date.now() + sec(45);
    const reloads = [];
    while (Date.now() < end) {
      const t = tabs[1 + Math.floor(Math.random() * (PEERS - 1))];
      const s = Date.now();
      try {
        await rig({ tab: t, op: 'reload' });
        await install(t);
        await S(t, 'chaos({ rate: 4 })');
        reloads.push({ tab: t, ms: Date.now() - s });
        log(`churn: reloaded ${t} in ${Date.now() - s}ms`);
      } catch (e) {
        reloads.push({ tab: t, error: e.message });
        log(`churn: reload ${t} failed: ${e.message}`);
      }
      await sleep(sec(5));
    }
    // Everyone back in the mesh?
    await sleep(3000);
    const mesh = await all((t) => evalIn(t, `() => __redaw.runtime.loader.get('net/room.js').openPeers().length`));
    log(`churn: mesh after ${mesh.join(',')}`);
    return { reloads, meshAfter: mesh };
  });

  await phase('code', async () => {
    const out = {};
    // Everyone changes their own file at once, then three peers change one shared file at once.
    out.own = await all((t) => S(t, 'codeChange()'));
    await sleep(3000);
    out.shared = await Promise.all(tabs.slice(0, 3).map((t) => S(t, `codeChange({ file: 'stress/shared.js' })`)));
    await sleep(3000);
    // Follow-ups on P1's own change, by P1 and (concurrently) by P2 who first incorporates it.
    const p1 = out.own[0];
    out.inc1 = await all((t) => S(t, 'incorporate()'));
    out.followups = await Promise.all([S(tabs[0], `codeChange({ follows: ${JSON.stringify(p1)} })`), S(tabs[1], `codeChange({ file: 'stress/P1.js', follows: ${JSON.stringify(p1)} })`)]);
    await sleep(3000);
    out.inc2 = await all((t) => S(t, 'incorporate()'));
    // Edits keep running meanwhile on half the peers, while the others incorporate again.
    await Promise.all(tabs.slice(PEERS / 2).map((t) => S(t, 'chaos({ rate: 4 })')));
    out.inc3 = await Promise.all(tabs.slice(0, PEERS / 2).map((t) => S(t, 'incorporate()')));
    await sleep(3000);
    const views = await all((t) => evalIn(t, `() => { const C = __redaw.runtime.loader.get('net/changes.js'); return C.published.value.map((c) => ({ id: c.id, name: c.name, follows: c.follows ?? null, deps: c.deps, inc: Object.keys(c.incorporatedBy ?? {}).sort(), state: C.isApplied(c) ? 'in' : (() => { try { const p = C.plan(c.id); return p.missing.length ? 'missing' : p.clean ? 'clean' : 'stale'; } catch (e) { return 'error ' + e.message; } })() })); }`));
    out.published = Object.fromEntries(tabs.map((t, i) => [t, views[i]]));
    const summary = tabs.map((t, i) => `${t}: ${views[i].length} published, in ${views[i].filter((c) => c.state === 'in').length}, stale ${views[i].filter((c) => c.state === 'stale').length}, missing ${views[i].filter((c) => c.state === 'missing').length}`);
    log(`code: ${summary.join(' | ')}`);
    const outcomes = [...out.inc1, ...out.inc2, ...out.inc3].flat().map(([, r]) => r.split(':')[0]);
    log(`code: incorporate outcomes ${JSON.stringify(outcomes.reduce((a, x) => ((a[x] = (a[x] ?? 0) + 1), a), {}))}`);
    return { code: out };
  });

  await phase('soak', async () => {
    await chaosAll(3);
    const end = Date.now() + SOAK_MIN * 60000;
    while (Date.now() < end) {
      await sleep(30000);
      const s = await S(tabs[0], 'snapshot({ bytes: true })');
      log(`soak: doc ${s.docBytes} B, ${s.changes} changes, save ${s.saveMs}ms load ${s.loadMs}ms, counts ${JSON.stringify(s.counts)}`);
    }
  });

  await phase('poison', async () => {
    const kinds = await S(tabs[0], `poison('order-unknown-id')`);
    const outcomes = {};
    for (const k of kinds) {
      if (k !== 'order-unknown-id') await S(tabs[0], `poison(${JSON.stringify(k)})`).catch((e) => log(`poison ${k}: ${e.message}`));
      await sleep(2500);
      const snaps = await snapshots();
      const ev = problems(await newEvents());
      outcomes[k] = {
        recovery: Object.entries(snaps).filter(([, s]) => s.recovery || s.app === false || s.error).map(([t, s]) => `${t}: ${s.recovery ?? s.error ?? 'no app'}`),
        errors: dedupe(ev).slice(0, 4).map((p) => `${p.tabs.join(',')} ${p.kind}: ${p.text.split('\n')[0].slice(0, 200)}`),
        invariants: [...new Set(Object.values(snaps).flatMap((s) => s.invariants ?? []))].slice(0, 5),
      };
      log(`poison ${k}: ${outcomes[k].recovery.length ? 'RECOVERY ' + outcomes[k].recovery.join('; ') : 'pages up'}${outcomes[k].errors.length ? ' | errors: ' + outcomes[k].errors.join(' ‖ ') : ''}${outcomes[k].invariants.length ? ' | invariants: ' + outcomes[k].invariants.join('; ') : ''}`);
      // Undo it, and reload pages in recovery, so the next kind is judged alone.
      await S(tabs[0], 'unpoison()').catch((e) => log(`unpoison failed: ${e.message}`));
      await sleep(1500);
      const after = await snapshots();
      for (const [t, s] of Object.entries(after)) if (s.recovery || s.app === false || s.error) await rig({ tab: t, op: 'reload' }).then(() => install(t)).catch(() => {});
      await newEvents();
    }
    return { poison: outcomes };
  });
}

async function waitAll(expr, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const ok = await all((t) => evalIn(t, `() => ${expr}`).catch(() => false));
    if (ok.every(Boolean)) return Date.now() - (end - ms);
    await sleep(250);
  }
  return null;
}

async function writeReport() {
  const status = await rig({ op: 'status' }).catch(() => null);
  if (!status) return;
  const dir = path.join(ROOT, status.runDir);
  const report = { peers: PEERS, scale: SCALE, phases: PHASES, at: new Date(t0).toISOString(), results };
  await fs.writeFile(path.join(dir, 'stress-report.json'), JSON.stringify(report, null, 1));
  const md = [`# Stress run ${report.at}`, '', `${PEERS} peers, scale ${SCALE}. Event log: ${status.events}`, ''];
  for (const r of results) {
    if (r.phase === 'setup') {
      md.push(`- **setup**: mesh ${r.mesh?.join(',')} in ${r.meshMs} ms`);
      continue;
    }
    const m = r.metrics ?? {};
    md.push(
      `- **${r.phase}** (${r.seconds}s): ${r.converged ? `converged in ${(r.convergeMs / 1000).toFixed(1)}s` : '**did not converge**'}; problems ${r.problems}; ` +
        `lag p95 ≤${m.lagP95Max ?? '-'}ms (max ${m.lagMax ?? '-'}); loop stall ≤${m.loopMax ?? '-'}ms; doc ${r.final?.docBytes ?? '-'} B (save ${r.final?.saveMs ?? '-'} / load ${r.final?.loadMs ?? '-'} ms); heap ≤${m.heapMBMax ?? '-'} MB` +
        (Object.keys(r.invariants ?? {}).length ? `; invariants: ${JSON.stringify(r.invariants)}` : '') +
        (Object.keys(r.recovery ?? {}).length ? `; RECOVERY: ${JSON.stringify(r.recovery)}` : ''),
    );
    for (const p of r.problemSamples ?? []) md.push(`  - ${p.count}× [${p.kind}] (${p.tabs.join(',')}) ${p.text.split('\n')[0].slice(0, 200)}`);
  }
  await fs.writeFile(path.join(dir, 'stress-report.md'), md.join('\n') + '\n');
}

run()
  .catch((e) => log(`FAILED: ${e.stack || e}`))
  .finally(async () => {
    await writeReport();
    const status = await rig({ op: 'status' }).catch(() => null);
    if (status) log(`report: ${status.runDir}/stress-report.md`);
  });
