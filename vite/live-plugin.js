// Dev-server side of the live module system.
//
//   GET    /__live/files          -> { files: [{ path, mtime, source }] }
//   PUT    /__live/files/<path>   body = file text  -> { mtime }
//   DELETE /__live/files/<path>   -> { ok: true }
//   POST   /__live/chat-log       body = { role, text, session? } -> appended to .redaw/chat.jsonl (read by the commit hook)
//   GET    /__live/db             -> the open page's IndexedDB databases and stores (read-only,
//          /__live/db/<db>/<store>[?values]   keys, or all { key, value }   relayed to the page,
//          /__live/db/<db>/<store>/<key>      one value (?jkey=<json> for    src/db-bridge.js;
//                                             non-string keys; ?full: binary data in full)
//   GET    /__live/ls[/<key>]     -> the open page's localStorage (read-only, relayed the same way;
//                                    both answer with header x-redaw-page: the tab that answered)
//   ws event "live:change"        { path, mtime, source | null }  (disk edits from your editor)
//   ws     /__live/signal          WebRTC signaling relay for multiplayer rooms (vite/signal.js),
//                                  also under `vite preview`
//
// In a production build the same file list is inlined via `virtual:live-bundle`, so the
// page also works as a static site (edits then only persist to IndexedDB).
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { attachSignaling } from './signal.js';

const VIRTUAL_ID = 'virtual:live-bundle';
const RESOLVED_ID = '\0' + VIRTUAL_ID;
const TEXT_EXT = /\.(jsx?|tsx?|mjs|css|json|md|txt|html|svg)$/i;

// Turn on the repo's commit hooks (.githooks, see scripts/commit_prompts.py) for anyone who runs
// the dev server, unless the clone already uses a hooks path of its own.
function enableCommitHooks(cwd) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    try { if (git('config', 'core.hooksPath')) return; } catch {} // exits 1 when unset
    git('config', 'core.hooksPath', '.githooks');
    console.log('[redaw] enabled commit hooks: git config core.hooksPath .githooks');
  } catch {} // not a git checkout
}

export default function livePlugin({ dir = 'live' } = {}) {
  let root;
  let chatLogPath;
  let isBuild = false;

  // Resolve a client-supplied path and make sure it stays inside the live root,
  // including through symlinks.
  async function safePath(rel) {
    if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw new Error('bad path');
    const target = path.resolve(root, decodeURIComponent(rel).replace(/^\/+/, ''));
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('path escapes live root');
    if (!TEXT_EXT.test(target)) throw new Error('unsupported file type');
    // Canonicalise the nearest existing ancestor to catch symlinked dirs.
    let probe = target;
    while (!fsSync.existsSync(probe)) probe = path.dirname(probe);
    const real = await fs.realpath(probe);
    const realRoot = await fs.realpath(root);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new Error('path escapes live root');
    return target;
  }

  async function listFiles(dirAbs = root, out = []) {
    let entries = [];
    try { entries = await fs.readdir(dirAbs, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dirAbs, e.name);
      if (e.isDirectory()) await listFiles(abs, out);
      else if (e.isFile() && TEXT_EXT.test(e.name)) {
        const [source, stat] = await Promise.all([fs.readFile(abs, 'utf8'), fs.stat(abs)]);
        out.push({ path: toRel(abs), mtime: Math.floor(stat.mtimeMs), source });
      }
    }
    return out;
  }

  const toRel = (abs) => path.relative(root, abs).split(path.sep).join('/');

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.setEncoding('utf8');
      req.on('data', (c) => { data += c; if (data.length > 5e6) reject(new Error('too large')); });
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });
  }

  return {
    name: 'redaw-live',
    configResolved(cfg) {
      root = path.resolve(cfg.root, dir);
      chatLogPath = path.resolve(cfg.root, '.redaw', 'chat.jsonl');
      isBuild = cfg.command === 'build';
    },
    resolveId(id) { if (id === VIRTUAL_ID) return RESOLVED_ID; },
    async load(id) {
      if (id !== RESOLVED_ID) return;
      // Dev: the client asks the server. Build: inline the current files.
      const files = isBuild ? await listFiles() : null;
      return `export default ${JSON.stringify(files)};`;
    },
    configurePreviewServer(server) {
      if (server.httpServer) attachSignaling(server.httpServer);
    },
    configureServer(server) {
      enableCommitHooks(server.config.root);
      if (server.httpServer) attachSignaling(server.httpServer); // null in middleware mode
      const sender = (res) => (code, body) => {
        res.statusCode = code;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(body));
      };
      // Cheap CSRF guard: a custom header forces a CORS preflight for foreign origins,
      // and browsers tell us when a request is cross-site.
      const guard = (req, send) => {
        if (req.headers['x-redaw'] !== '1') return send(403, { error: 'missing x-redaw header' }), false;
        const site = req.headers['sec-fetch-site'];
        if (site && site !== 'same-origin' && site !== 'none') return send(403, { error: 'cross-site' }), false;
        return true;
      };

      server.middlewares.use('/__live/chat-log', async (req, res) => {
        const send = sender(res);
        try {
          if (!guard(req, send)) return;
          if (req.method !== 'POST') return send(405, { error: 'method not allowed' });
          const { role, text, session } = JSON.parse(await readBody(req));
          if (typeof role !== 'string' || typeof text !== 'string') return send(400, { error: 'expected { role, text, session? }' });
          const line = { ts: new Date().toISOString(), role, text, ...(typeof session === 'string' && session && { session }) };
          await fs.mkdir(path.dirname(chatLogPath), { recursive: true });
          await fs.appendFile(chatLogPath, JSON.stringify(line) + '\n', 'utf8');
          send(200, { ok: true });
        } catch (err) {
          send(400, { error: String(err.message || err) });
        }
      });

      // Read-only view of the open page's IndexedDB, relayed over the HMR socket (src/db-bridge.js).
      const pending = new Map(); // id -> resolve
      let nextId = 0;
      server.ws.on('live:db-reply', (data) => {
        pending.get(data?.id)?.(data);
        pending.delete(data?.id);
      });
      const askPage = (q, ms = 5000) =>
        new Promise((resolve) => {
          const id = ++nextId;
          const timer = setTimeout(() => (pending.delete(id), resolve({ ok: false, status: 504, error: 'no page answered (is a tab open on the dev server?)' })), ms);
          pending.set(id, (r) => (clearTimeout(timer), resolve(r)));
          server.ws.send({ type: 'custom', event: 'live:db', data: { id, ...q } });
        });

      server.middlewares.use('/__live/db', async (req, res) => {
        const send = sender(res);
        try {
          if (!guard(req, send)) return;
          if (req.method !== 'GET') return send(405, { error: 'method not allowed' });
          const url = new URL(req.url || '/', 'http://x');
          const [db, store, ...rest] = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
          const full = url.searchParams.has('full');
          let q;
          if (!db) q = { op: 'dbs' };
          else if (!store) return send(400, { error: 'expected /__live/db/<db>/<store>[/<key>]' });
          else if (rest.length || url.searchParams.has('jkey')) {
            const key = url.searchParams.has('jkey') ? JSON.parse(url.searchParams.get('jkey')) : rest.join('/');
            q = { op: 'get', db, store, key, full };
          } else q = { op: url.searchParams.has('values') ? 'all' : 'keys', db, store, full };
          const r = await askPage(q);
          if (r.page) res.setHeader('x-redaw-page', r.page);
          if (!r.ok) return send(r.status || 400, { error: r.error });
          send(200, r.result);
        } catch (err) {
          send(400, { error: String(err.message || err) });
        }
      });

      // Read-only view of the open page's localStorage (auto-merge jobs, chat settings, …), same relay.
      server.middlewares.use('/__live/ls', async (req, res) => {
        const send = sender(res);
        try {
          if (!guard(req, send)) return;
          if (req.method !== 'GET') return send(405, { error: 'method not allowed' });
          const key = decodeURIComponent(new URL(req.url || '/', 'http://x').pathname.replace(/^\/+/, ''));
          const r = await askPage(key ? { op: 'ls', key } : { op: 'ls' });
          if (r.page) res.setHeader('x-redaw-page', r.page);
          if (!r.ok) return send(r.status || 400, { error: r.error });
          send(200, r.result);
        } catch (err) {
          send(400, { error: String(err.message || err) });
        }
      });

      server.middlewares.use('/__live/files', async (req, res) => {
        const send = sender(res);
        try {
          if (!guard(req, send)) return;

          const rel = (req.url || '/').split('?')[0].replace(/^\//, '');
          if (req.method === 'GET' && !rel) return send(200, { files: await listFiles() });
          const abs = await safePath(rel);
          if (req.method === 'PUT') {
            const body = await readBody(req);
            await fs.mkdir(path.dirname(abs), { recursive: true });
            await fs.writeFile(abs, body, 'utf8');
            const stat = await fs.stat(abs);
            return send(200, { mtime: Math.floor(stat.mtimeMs) });
          }
          if (req.method === 'DELETE') {
            await fs.rm(abs, { force: true });
            return send(200, { ok: true });
          }
          send(405, { error: 'method not allowed' });
        } catch (err) {
          send(400, { error: String(err.message || err) });
        }
      });

      // Push disk edits (e.g. from your editor) to the page.
      server.watcher.add(root);
      const notify = async (abs, deleted) => {
        if (!abs.startsWith(root + path.sep) || !TEXT_EXT.test(abs)) return;
        let payload = { path: toRel(abs), mtime: Date.now(), source: null };
        if (!deleted) {
          try {
            const [source, stat] = await Promise.all([fs.readFile(abs, 'utf8'), fs.stat(abs)]);
            payload = { path: toRel(abs), mtime: Math.floor(stat.mtimeMs), source };
          } catch { return; }
        }
        server.ws.send({ type: 'custom', event: 'live:change', data: payload });
      };
      // Debounce per file and read on the trailing edge: rapid successive writes (an agent
      // commit followed by an editor save) can coalesce into one watcher event.
      const timers = new Map();
      const schedule = (abs) => {
        clearTimeout(timers.get(abs));
        timers.set(abs, setTimeout(() => {
          timers.delete(abs);
          fs.access(abs).then(() => notify(abs, false), () => notify(abs, true));
        }, 120));
      };
      server.watcher.on('add', schedule);
      server.watcher.on('change', schedule);
      server.watcher.on('unlink', schedule);
    },
    // Never let Vite's own HMR react to live/ files; the page owns them.
    handleHotUpdate(ctx) {
      if (ctx.file.startsWith(root + path.sep)) return [];
    },
  };
}
