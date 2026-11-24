#!/usr/bin/env node
// End-to-end test rig: a dev server on a scratch copy of live/ plus headless browser tabs with
// separate profiles (each tab name is its own participant: own storage, own IndexedDB), driven from
// the command line, e.g. by a test agent following a scenario in e2e/scenarios/.
//
//   node scripts/e2e.mjs up                    start server + browser (detached); prints the URL
//   node scripts/e2e.mjs down                  stop them
//   node scripts/e2e.mjs status
//   node scripts/e2e.mjs <tab> goto [url|#frag] open the app (default) or a URL/fragment of it
//   node scripts/e2e.mjs <tab> eval '<js>'     run JS in the page (an expression, or a function
//                                              source, called with no args); prints JSON
//   node scripts/e2e.mjs <tab> wait '<js>' [ms] poll until the JS is truthy (default 15000 ms)
//   node scripts/e2e.mjs <tab> click '<css or text=…>'
//   node scripts/e2e.mjs <tab> fill '<selector>' '<text>'
//   node scripts/e2e.mjs <tab> press '<key>'
//   node scripts/e2e.mjs <tab> text ['<selector>']   visible text (default: body), trimmed
//   node scripts/e2e.mjs <tab> screenshot      saves a PNG, prints its path
//   node scripts/e2e.mjs <tab> console         console messages and page errors since the last call
//   node scripts/e2e.mjs <tab> reload | close
//   node scripts/e2e.mjs <tab> init '<js>'      run this script in the tab before each page load
//   node scripts/e2e.mjs tabs
//   node scripts/e2e.mjs log '<text>'          append a note to the event log
//
// Event log: e2e/out/<run>/events.jsonl gets one JSON line per event from every tab (console
// messages, page errors, crashes, failed requests) plus notes from drivers ({ t, tab, kind, text }),
// so a test can be followed in one place: tail -f e2e/out/<run>/events.jsonl.
//
// Tabs are created on first use. The live copy is e2e/out/<run>/live, so changes the tabs commit
// never touch the repo. E2E_PORT (default 5199) picks the server port; the control port is one below.
//
// A rig nobody stops would keep a dev server and a browser (every tab's page and storage) alive
// for days: it shuts itself down after E2E_IDLE_MIN minutes (default 20, 0 = never) without a
// command. `down` also works on a rig whose control port stopped answering (by its pid).
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'e2e/out');
const PORT = Number(process.env.E2E_PORT) || 5199;
const CONTROL = PORT - 1;
const STATE = path.join(OUT, PORT === 5199 ? 'current.json' : `current-${PORT}.json`);
const IDLE_MIN = process.env.E2E_IDLE_MIN != null ? Number(process.env.E2E_IDLE_MIN) : 20;
const URL_ = `http://localhost:${PORT}/`;

const [cmd, ...rest] = process.argv.slice(2);

async function request(body) {
  const res = await fetch(`http://127.0.0.1:${CONTROL}/`, { method: 'POST', body: JSON.stringify(body) }).catch(() => null);
  if (!res) throw new Error('rig is not running: node scripts/e2e.mjs up');
  const out = await res.json();
  if (out.error) throw new Error(out.error);
  return out.result;
}

const print = (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));

async function main() {
  if (cmd === 'up') return up();
  if (cmd === '__daemon') return daemon(rest[0]);
  if (cmd === 'down') return print(await down());
  if (cmd === 'status') return print(await request({ op: 'status' }));
  if (cmd === 'tabs') return print(await request({ op: 'tabs' }));
  if (cmd === 'log') return print(await request({ op: 'log', args: rest }));
  if (!cmd || !rest.length) {
    console.log(fsSync.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\nimport ')[0]);
    process.exitCode = 2;
    return;
  }
  const [op, ...args] = rest;
  print(await request({ tab: cmd, op, args }));
}

async function down() {
  try {
    return await request({ op: 'down' });
  } catch (e) {
    // Control port gone or wedged: stop the daemon by pid (it closes the browser and vite).
    const pid = JSON.parse(await fs.readFile(STATE, 'utf8').catch(() => '{}')).pid;
    if (!pid) return e.message;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      await fs.rm(STATE, { force: true });
      return 'not running';
    }
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try { process.kill(pid, 0); } catch { return `stopped (pid ${pid})`; }
    }
    try { process.kill(pid, 'SIGKILL'); } catch {}
    return `killed (pid ${pid})`;
  }
}

async function up() {
  try {
    const s = await request({ op: 'status' });
    return print({ already: true, ...s });
  } catch {}
  const runDir = path.join(OUT, new Date().toISOString().replace(/[:.]/g, '-'));
  await fs.mkdir(runDir, { recursive: true });
  const log = fsSync.openSync(path.join(runDir, 'rig.log'), 'a');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '__daemon', runDir], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', log, log],
  });
  child.unref();
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      return print(await request({ op: 'status' }));
    } catch {}
    if (child.exitCode != null) break;
  }
  throw new Error(`rig did not start; see ${path.relative(ROOT, runDir)}/rig.log`);
}

// ---- daemon --------------------------------------------------------------------------------

async function daemon(runDir) {
  const { chromium } = await import('playwright');
  const liveDir = path.join(runDir, 'live');
  await fs.cp(path.join(ROOT, 'live'), liveDir, { recursive: true });

  // A server left on the port would silently serve an old copy of live/.
  if (await fetch(URL_).then(() => true, () => false)) throw new Error(`port ${PORT} is already serving; stop that server first`);
  const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    detached: true, // own process group, so stopping it also stops vite under npx
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, REDAW_LIVE_DIR: liveDir },
  });
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(URL_)).ok) break;
    } catch {}
    if (i > 120 || vite.exitCode != null) throw new Error('dev server did not come up');
    await new Promise((r) => setTimeout(r, 500));
  }

  const killVite = () => {
    try { process.kill(-vite.pid, 'SIGTERM'); } catch { try { vite.kill(); } catch {} }
  };
  // However the daemon ends (including a failed start below), vite goes with it.
  process.on('exit', killVite);
  let browser = null;
  let server = null;
  let stopping = false;
  const shutdown = async (why) => {
    if (stopping) return;
    stopping = true;
    console.log(`rig stopping: ${why}`);
    setTimeout(() => process.exit(0), 5000).unref(); // a hung browser.close() mustn't keep it alive
    await browser?.close().catch(() => {});
    server?.close();
    if (JSON.parse(await fs.readFile(STATE, 'utf8').catch(() => '{}')).pid === process.pid) await fs.rm(STATE, { force: true });
    process.exit(0);
  };
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => shutdown(sig));
  browser = await chromium.launch({ headless: true });
  const tabs = new Map(); // name -> { context, page, logs }
  let shots = 0;
  const events = fsSync.createWriteStream(path.join(runDir, 'events.jsonl'), { flags: 'a' });
  const emit = (tab, kind, text) => events.write(JSON.stringify({ t: Date.now(), tab, kind, text }) + '\n');

  async function tab(name) {
    if (tabs.has(name)) return tabs.get(name);
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const t = { context, page, logs: [] };
    page.on('console', (m) => {
      t.logs.push(`[${m.type()}] ${m.text()}`);
      if (t.logs.length > 5000) t.logs.splice(0, t.logs.length - 5000);
      emit(name, m.type(), m.text());
    });
    page.on('pageerror', (e) => {
      t.logs.push(`[pageerror] ${e.message}`);
      emit(name, 'pageerror', loaderless(e.stack || e.message));
    });
    page.on('crash', () => emit(name, 'crash', 'page crashed'));
    page.on('requestfailed', (r) => emit(name, 'requestfailed', `${r.url()} ${r.failure()?.errorText ?? ''}`));
    page.on('load', () => emit(name, 'load', page.url()));
    tabs.set(name, t);
    return t;
  }

  const loaderless = (s) => String(s).split('\n').slice(0, 8).join('\n');
  const asFn = (src) => `(async () => { const __v = (${src}); return typeof __v === 'function' ? await __v() : await __v; })()`;
  const json = (v) => JSON.parse(JSON.stringify(v ?? null));

  const ops = {
    async goto(t, [target = '']) {
      const url = /^https?:/.test(target) ? target : URL_ + (target.startsWith('#') ? target : target.replace(/^\//, ''));
      await t.page.goto(url);
      await t.page.waitForFunction(() => globalThis.__redaw?.runtime?.loader.get('main.jsx'), null, { timeout: 30000 });
      return t.page.url();
    },
    async eval(t, [src]) {
      return json(await t.page.evaluate(asFn(src)));
    },
    async wait(t, [src, ms = '15000']) {
      const deadline = Date.now() + Number(ms);
      let last;
      while (Date.now() < deadline) {
        try {
          last = await t.page.evaluate(asFn(src));
          if (last) return { ok: true, value: json(last) };
        } catch (e) {
          last = `throws: ${e.message.split('\n')[0]}`;
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      return { ok: false, timeout: Number(ms), last: json(last) };
    },
    async click(t, [sel]) {
      await t.page.locator(sel).first().click({ timeout: 10000 });
      return true;
    },
    async fill(t, [sel, text]) {
      await t.page.locator(sel).first().fill(text, { timeout: 10000 });
      return true;
    },
    async press(t, [key]) {
      await t.page.keyboard.press(key);
      return true;
    },
    async text(t, [sel = 'body']) {
      return (await t.page.locator(sel).first().innerText({ timeout: 10000 })).replace(/\n{3,}/g, '\n\n').trim();
    },
    async screenshot(t) {
      const file = path.join(runDir, `shot-${++shots}.png`);
      await t.page.screenshot({ path: file });
      return file;
    },
    async console(t) {
      return t.logs.splice(0);
    },
    async init(t, [src]) {
      await t.context.addInitScript(src);
      return true;
    },
    async reload(t) {
      await t.page.reload();
      await t.page.waitForFunction(() => globalThis.__redaw?.runtime?.loader.get('main.jsx'), null, { timeout: 30000 });
      return true;
    },
  };

  let lastUsed = Date.now();
  if (IDLE_MIN > 0) {
    setInterval(() => {
      if (Date.now() - lastUsed > IDLE_MIN * 60_000) shutdown(`idle for ${IDLE_MIN} min`);
    }, 30_000).unref();
  }
  server = http.createServer(async (req, res) => {
    lastUsed = Date.now();
    let body = '';
    for await (const c of req) body += c;
    const reply = (o) => res.end(JSON.stringify(o));
    try {
      const { tab: name, op, args = [] } = JSON.parse(body);
      if (op === 'status') return reply({ result: { url: URL_, events: path.relative(ROOT, path.join(runDir, 'events.jsonl')), liveDir: path.relative(ROOT, liveDir), runDir: path.relative(ROOT, runDir), tabs: [...tabs.keys()] } });
      if (op === 'log') {
        emit(name ?? 'driver', 'note', args.join(' '));
        return reply({ result: true });
      }
      if (op === 'tabs') return reply({ result: [...tabs].map(([n, t]) => ({ tab: n, url: t.page.url() })) });
      if (op === 'down') {
        reply({ result: 'stopped' });
        return shutdown('down');
      }
      if (typeof name !== 'string' || !/^[\w-]+$/.test(name)) throw new Error('bad tab name');
      if (op === 'close') {
        await tabs.get(name)?.context.close();
        tabs.delete(name);
        emit(name, 'close', 'tab closed');
        return reply({ result: true });
      }
      if (!ops[op]) throw new Error(`unknown op ${op}`);
      reply({ result: await ops[op](await tab(name), args) });
    } catch (e) {
      reply({ error: String(e.message || e).split('\n').slice(0, 6).join('\n') });
    }
  });
  server.listen(CONTROL, '127.0.0.1');
  await fs.writeFile(STATE, JSON.stringify({ url: URL_, control: CONTROL, runDir, pid: process.pid }));
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
