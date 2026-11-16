// Dev-server side of the live module system.
//
//   GET    /__live/files          -> { files: [{ path, mtime, source }] }
//   PUT    /__live/files/<path>   body = file text  -> { mtime }
//   DELETE /__live/files/<path>   -> { ok: true }
//   ws event "live:change"         { path, mtime, source | null }  (disk edits from your editor)
//
// In a production build the same file list is inlined via `virtual:live-bundle`, so the
// page also works as a static site (edits then only persist to IndexedDB).
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

const VIRTUAL_ID = 'virtual:live-bundle';
const RESOLVED_ID = '\0' + VIRTUAL_ID;
const TEXT_EXT = /\.(jsx?|tsx?|mjs|css|json|md|txt|html|svg)$/i;

export default function livePlugin({ dir = 'live' } = {}) {
  let root;
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
      isBuild = cfg.command === 'build';
    },
    resolveId(id) { if (id === VIRTUAL_ID) return RESOLVED_ID; },
    async load(id) {
      if (id !== RESOLVED_ID) return;
      // Dev: the client asks the server. Build: inline the current files.
      const files = isBuild ? await listFiles() : null;
      return `export default ${JSON.stringify(files)};`;
    },
    configureServer(server) {
      server.middlewares.use('/__live/files', async (req, res) => {
        const send = (code, body) => {
          res.statusCode = code;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(body));
        };
        try {
          // Cheap CSRF guard: a custom header forces a CORS preflight for foreign origins,
          // and browsers tell us when a request is cross-site.
          if (req.headers['x-redaw'] !== '1') return send(403, { error: 'missing x-redaw header' });
          const site = req.headers['sec-fetch-site'];
          if (site && site !== 'same-origin' && site !== 'none') return send(403, { error: 'cross-site' });

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
