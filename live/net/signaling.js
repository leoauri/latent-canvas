// Client for a y-webrtc-compatible signaling server (vite/signal.js documents the protocol):
// one topic, reconnecting with backoff, re-subscribing and calling onOpen after every reconnect.
// A socket that stops answering pings is dropped and reconnected: a connection can die without
// ever closing (sleep, network change, a NAT forgetting it), and would otherwise look open forever.

const PING_MS = 20000; // keeps proxies from closing an idle socket
const DEAD_MS = 2 * PING_MS + 5000; // nothing heard for this long: the socket is dead
const MAX_BACKOFF_MS = 30000;

/**
 * @param {string} url
 * @param {string} topic
 * @param {{ onOpen?: () => void, onMessage: (data: any) => void, onStatus?: (s: 'connecting'|'open'|'closed') => void }} handlers
 */
export function connectSignaling(url, topic, { onOpen, onMessage, onStatus }) {
  let ws = null;
  let closed = false;
  let retry = 0;
  let retryTimer = null;
  let pingTimer = null;
  let lastHeard = 0;

  function open() {
    onStatus?.('connecting');
    ws = new WebSocket(url);
    ws.onopen = () => {
      retry = 0;
      lastHeard = Date.now();
      ws.send(JSON.stringify({ type: 'subscribe', topics: [topic] }));
      pingTimer = setInterval(() => {
        if (Date.now() - lastHeard > DEAD_MS) return drop();
        send({ type: 'ping' });
      }, PING_MS);
      onStatus?.('open');
      onOpen?.();
    };
    ws.onmessage = (e) => {
      lastHeard = Date.now(); // pongs and publishes alike
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg?.type === 'publish' && msg.topic === topic) onMessage(msg.data);
    };
    ws.onclose = () => {
      clearInterval(pingTimer);
      ws = null;
      if (closed) return;
      onStatus?.('closed');
      retryTimer = setTimeout(open, Math.min(MAX_BACKOFF_MS, 500 * 2 ** retry++));
    };
    ws.onerror = () => {}; // onclose follows
  }

  // Give up on a silent socket now: its close handshake would never finish, so onclose may not
  // fire for minutes. Detach it and reconnect.
  function drop() {
    const dead = ws;
    dead.onclose = dead.onmessage = dead.onopen = null;
    try { dead.close(); } catch {}
    clearInterval(pingTimer);
    ws = null;
    onStatus?.('closed');
    retryTimer = setTimeout(open, 0);
  }

  function send(msg) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  open();
  return {
    publish: (data) => send({ type: 'publish', topic, data }),
    get open() { return ws?.readyState === WebSocket.OPEN; },
    close() {
      closed = true;
      clearTimeout(retryTimer);
      clearInterval(pingTimer);
      if (ws) {
        send({ type: 'unsubscribe', topics: [topic] });
        ws.close();
      }
      onStatus?.('closed');
    },
  };
}
