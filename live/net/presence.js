// Presence: ephemeral per-peer state (where someone's cursor is, their playhead, what they have
// selected) sent over the room's mesh channel. Never stored, never in the document or history.
//
//   publish(key, signal)   share a local signal under a key (null = nothing to show); returns unbind
//   others                 signal: { [peerId]: { name, color, client, state: { key: value }, at } }
//   show                   signal: whether this page draws others' presence (persisted locally)
//   remoteNow(peerId)      the peer's Date.now() as estimated here (clock offset from pings)
//
// Updates are throttled per key (THROTTLE_MS); a peer that joins gets everything at once. A peer that
// goes quiet for STALE_MS (no heartbeat) or leaves the room is dropped.
import { signal, effect } from '@preact/signals';
import { persist } from '@live/runtime';
import * as room from './room.js';
import { myName } from './changes.js';

const THROTTLE_MS = 50;
const HEARTBEAT_MS = 4000;
const STALE_MS = 12000;
const PINGS = 5; // clock samples per peer (the one with the shortest round trip wins)

/** A stable id for this browser profile (room peer ids change with every module reload). */
const clientId = (() => {
  try {
    let id = localStorage.getItem('redaw.net.client');
    if (!id) localStorage.setItem('redaw.net.client', (id = crypto.randomUUID()));
    return id;
  } catch {
    return crypto.randomUUID();
  }
})();

/** A peer's colour, from its client id: the same person keeps their colour across reloads. */
export function colorOf(client) {
  let h = 0;
  for (const ch of String(client)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `oklch(0.62 0.19 ${h % 360})`;
}
export const myColor = colorOf(clientId);

export const show = persist('net.presence.show', () => {
  try {
    return localStorage.getItem('redaw.net.showPresence') !== 'false';
  } catch {
    return true;
  }
});
const offShow = show.subscribe((v) => {
  try {
    localStorage.setItem('redaw.net.showPresence', String(v));
  } catch {}
});

export const others = signal({});
const mine = new Map(); // key -> current value
const offsets = new Map(); // peerId -> { rtt, offset } (their clock minus ours, ms)

const header = () => ({ type: 'presence', client: clientId, name: myName.value, color: myColor });

function sendAll(to) {
  const msg = { ...header(), state: Object.fromEntries(mine) };
  to ? room.sendTo(to, msg) : room.broadcast(msg);
}

// ---- publishing --------------------------------------------------------------------------------

const timers = new Map(); // key -> { timer, last }

function flushKey(key) {
  const t = timers.get(key);
  t.timer = 0;
  t.last = performance.now();
  room.broadcast({ ...header(), state: { [key]: mine.get(key) ?? null } });
}

/** Shares `sig`'s value with the room's peers under `key` while bound. */
export function publish(key, sig) {
  timers.set(key, timers.get(key) ?? { timer: 0, last: 0 });
  const off = effect(() => {
    const v = sig.value ?? null;
    mine.set(key, v);
    const t = timers.get(key);
    if (t.timer) return;
    const wait = THROTTLE_MS - (performance.now() - t.last);
    if (wait <= 0) flushKey(key);
    else t.timer = setTimeout(() => flushKey(key), wait);
  });
  return () => {
    off();
    clearTimeout(timers.get(key)?.timer);
    timers.delete(key);
    mine.delete(key);
    room.broadcast({ ...header(), state: { [key]: null } });
  };
}

// ---- receiving ---------------------------------------------------------------------------------

function setPeer(id, fn) {
  const next = { ...others.peek() };
  const p = fn(next[id]);
  if (p) next[id] = p;
  else delete next[id];
  others.value = next;
}

const offMsg = room.onMessage((from, msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'presence-ping') return void room.sendTo(from, { type: 'presence-pong', t0: msg.t0, t1: Date.now() });
  if (msg.type === 'presence-pong') return void gotPong(from, msg);
  if (msg.type !== 'presence' || typeof msg.client !== 'string') return;
  const state = msg.state && typeof msg.state === 'object' ? msg.state : {};
  setPeer(from, (p) => {
    const merged = { ...(p?.state ?? {}) };
    for (const k in state) state[k] == null ? delete merged[k] : (merged[k] = state[k]);
    return {
      client: msg.client,
      name: typeof msg.name === 'string' ? msg.name.slice(0, 80) : 'peer',
      color: colorOf(msg.client), // computed here: never a peer-supplied CSS string
      state: merged,
      at: Date.now(),
    };
  });
});

// ---- clocks ------------------------------------------------------------------------------------

function ping(id, n) {
  if (n <= 0 || room.peers.peek()[id]?.state !== 'open') return;
  room.sendTo(id, { type: 'presence-ping', t0: Date.now() });
  setTimeout(() => ping(id, n - 1), 300);
}
function gotPong(from, { t0, t1 }) {
  const t2 = Date.now();
  if (typeof t0 !== 'number' || typeof t1 !== 'number') return;
  const rtt = t2 - t0;
  const cur = offsets.get(from);
  if (!cur || rtt < cur.rtt) offsets.set(from, { rtt, offset: t1 - (t0 + t2) / 2 });
}
/** The peer's clock now, as far as we can tell (ms). */
export const remoteNow = (peerId) => Date.now() + (offsets.get(peerId)?.offset ?? 0);
/** Converts a timestamp from the peer's clock to ours. */
export const toLocal = (peerId, t) => t - (offsets.get(peerId)?.offset ?? 0);

const offPeer = room.onPeer((id, state) => {
  if (state === 'open') {
    sendAll(id);
    ping(id, PINGS);
  } else {
    offsets.delete(id);
    setPeer(id, () => null);
  }
});

const beat = setInterval(() => {
  if (mine.size) sendAll();
  const now = Date.now();
  for (const [id, p] of Object.entries(others.peek())) if (now - p.at > STALE_MS || !room.peers.peek()[id]) setPeer(id, () => null);
}, HEARTBEAT_MS);

// A new name or colour reaches everyone at once, not with the next heartbeat.
let named = false;
const offName = effect(() => {
  myName.value;
  if (named && mine.size) sendAll();
  named = true;
});

// Peers already open when this module (re)loads.
for (const id of room.openPeers()) {
  sendAll(id);
  ping(id, PINGS);
}

export function dispose() {
  offMsg();
  offPeer();
  offShow();
  offName();
  clearInterval(beat);
  for (const t of timers.values()) clearTimeout(t.timer);
}
