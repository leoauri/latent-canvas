// Client for a y-webrtc-compatible signaling server (vite/signal.js documents the protocol):
// one topic, reconnecting with backoff, re-subscribing and calling onOpen after every reconnect.

const PING_MS = 20000; // keeps proxies from closing an idle socket
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

  function open() {
    onStatus?.('connecting');
    ws = new WebSocket(url);
    ws.onopen = () => {
      retry = 0;
      ws.send(JSON.stringify({ type: 'subscribe', topics: [topic] }));
      pingTimer = setInterval(() => send({ type: 'ping' }), PING_MS);
      onStatus?.('open');
      onOpen?.();
    };
    ws.onmessage = (e) => {
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
