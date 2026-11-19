// WebRTC signaling relay, speaking y-webrtc's signaling protocol (y-webrtc/bin/server.js), so
// the page can use this one, a public `y-webrtc-signaling` deployment, or any compatible server:
//
//   → { type: 'subscribe', topics: [string] }      → { type: 'unsubscribe', topics: [string] }
//   → { type: 'publish', topic, ...payload }        ← the same message, plus `clients` (subscriber count),
//                                                     to every subscriber of `topic`, the sender included
//   → { type: 'ping' }                              ← { type: 'pong' }
//
// It relays opaque messages between whoever subscribes to a topic; rooms encrypt what they publish
// (live/net/room.js), so the server never sees more than topic hashes and ciphertext.
import { WebSocketServer } from 'ws';

const PING_MS = 30000;
const MAX_MESSAGE = 256 * 1024;

/** Attach the relay to an http(s) server at `pathname`; other upgrades (Vite's HMR) are left alone. */
export function attachSignaling(httpServer, pathname = '/__live/signal') {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
  const topics = new Map(); // topic -> Set<ws>

  const send = (ws, msg) => {
    if (ws.readyState !== ws.OPEN) return;
    try { ws.send(msg); } catch { ws.close(); }
  };

  wss.on('connection', (ws) => {
    const mine = new Set();
    let alive = true;
    const timer = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      try { ws.ping(); } catch { ws.terminate(); }
    }, PING_MS);
    ws.on('pong', () => (alive = true));
    ws.on('close', () => {
      clearInterval(timer);
      for (const t of mine) {
        const subs = topics.get(t);
        subs?.delete(ws);
        if (subs && !subs.size) topics.delete(t);
      }
      mine.clear();
    });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      switch (msg.type) {
        case 'subscribe':
          for (const t of Array.isArray(msg.topics) ? msg.topics : []) {
            if (typeof t !== 'string') continue;
            if (!topics.has(t)) topics.set(t, new Set());
            topics.get(t).add(ws);
            mine.add(t);
          }
          break;
        case 'unsubscribe':
          for (const t of Array.isArray(msg.topics) ? msg.topics : []) {
            const subs = topics.get(t);
            subs?.delete(ws);
            if (subs && !subs.size) topics.delete(t);
            mine.delete(t);
          }
          break;
        case 'publish': {
          const subs = typeof msg.topic === 'string' && topics.get(msg.topic);
          if (!subs) break;
          const out = JSON.stringify({ ...msg, clients: subs.size });
          for (const s of subs) send(s, out);
          break;
        }
        case 'ping':
          send(ws, JSON.stringify({ type: 'pong' }));
          break;
      }
    });
  });

  const onUpgrade = (req, socket, head) => {
    if (new URL(req.url, 'http://x').pathname !== pathname) return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  };
  httpServer.on('upgrade', onUpgrade);
  return () => {
    httpServer.off('upgrade', onUpgrade);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  };
}
