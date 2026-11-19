#!/usr/bin/env node
// An always-on peer: serves the built app (dist/) and keeps it open in a headless browser joined to
// a session, so the session's document and files stay available to peers who join later, even when
// nobody else is online. Its storage (IndexedDB, OPFS) lives in a persistent browser profile.
//
//   npm run build
//   node scripts/peer.mjs '<invite link>'      or PEER_LINK='<invite link>'
//
// PEER_PORT (default 5180) is where it serves the app, on 127.0.0.1 only. PEER_PROFILE (default
// .peer/profile) is the browser profile; keep it, it is the peer's copy of the session. Exits when
// the page or browser crashes, so a supervisor (systemd) restarts it.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const link = process.argv[2] || process.env.PEER_LINK;
const port = Number(process.env.PEER_PORT) || 5180;
const profile = path.resolve(ROOT, process.env.PEER_PROFILE || '.peer/profile');

const hash = link && link.slice(link.indexOf('#'));
if (!hash?.includes('doc=')) {
  console.error('usage: node scripts/peer.mjs <invite link with #doc=…&room=…&signal=…>');
  process.exit(2);
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

const server = await preview({ root: ROOT, preview: { host: '127.0.0.1', port, strictPort: true } });
const ctx = await chromium.launchPersistentContext(profile, {
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const exit = (code, why) => {
  log(why);
  process.exit(code);
};
let stopping = false;
ctx.on('close', () => stopping || exit(1, 'browser closed'));

const page = ctx.pages()[0] ?? (await ctx.newPage());
page.on('console', (m) => log(`[${m.type()}]`, m.text()));
page.on('pageerror', (e) => log('[pageerror]', e.stack || e.message));
page.on('crash', () => exit(1, 'page crashed'));

await page.goto(`http://localhost:${port}/${hash}`);
log('joined', hash.replace(/room=[^&]+/, 'room=…'));

// What the peer is doing, once a minute: signaling connection, open peers, session load state.
const status = () =>
  page
    .evaluate(() => {
      const get = (p) => globalThis.__redaw?.runtime.loader.get(p);
      const room = get('net/room.js');
      const session = get('net/session.js');
      const blobs = get('net/blobs.js');
      const fetching = Object.values(blobs?.transfers.value ?? {}).filter((t) => t.state !== 'done');
      return {
        files: Object.keys(blobs?.index.value ?? {}).length,
        fetching: fetching.length,
        received: blobs?.stats.received,
        signal: room?.signalStatus.value,
        peers: room?.openPeers().length,
        session: session?.status.value,
        name: session?.current.value?.name,
      };
    })
    .then((s) => log('status', JSON.stringify(s)), (e) => log('status failed', e.message));
setTimeout(status, 15000);
setInterval(status, 60000);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    stopping = true;
    await ctx.close().catch(() => {});
    await server.close();
    process.exit(0);
  });
}
