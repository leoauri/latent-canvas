// A multiplayer room: a full mesh of WebRTC data channels between everyone holding the same room
// secret (link.js). The signaling server only introduces peers; once connected, data flows directly.
// This is the transport; session.js decides which room to be in.
//
// Signaling: every message published on the room's topic is AES-GCM encrypted with a key derived
// from the room secret, and is { from, to?, kind, body }:
//   announce  (broadcast) I'm here. Sent on joining, after each reconnect to the server, and after
//             a peer connection failed.
//   hello     (to one peer) Reply to an announce, from the peer with the larger id, so that the
//             smaller id learns of it. The smaller id of a pair always makes the offer; there is
//             no glare to resolve.
//   signal    (to one peer) { description } or { candidate }: the offer/answer and trickled ICE.
//   bye       (broadcast) I'm leaving.
//
// Each peer pair shares negotiated data channels, one per entry of CHANNELS:
//   mesh  JSON messages (sendTo / broadcast / onMessage)
//   sync  binary, Automerge sync (docs.js)
//   blob  binary, file chunks (blobs.js); separate so a big transfer doesn't delay sync
// Binary messages of any size are split into fragments and reassembled (send / on).
import { signal } from '@preact/signals';
import { persist, env } from '@live/runtime';
import { connectSignaling } from './signaling.js';

export const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
export const CHANNELS = { mesh: 0, sync: 1, blob: 2 };
const RETRY_ANNOUNCE_MS = 3000;
const FRAGMENT = 64 * 1024; // payload bytes per data channel message
const HEADER = 8; // u32 message id, u16 fragment index, u16 fragment count

/**
 * This instance's peer id. A reload of this module is a new instance, evaluated next to the old one
 * until the swap is final, so each instance is its own peer: peers see the old one leave and the
 * new one join.
 */
export const selfId = crypto.randomUUID();

/** The room we're in ({ room, signal }), or null. Survives module reloads. */
export const current = persist('net.current', null);
/** This instance's signaling connection: 'connecting' | 'open' | 'closed'. */
export const signalStatus = signal('closed');
/** This instance's remote peers by id: { state: 'connecting' | 'open', since: ms }. */
export const peers = signal({});

const handlers = new Map(Object.keys(CHANNELS).map((l) => [l, new Set()]));
const peerListeners = new Set();

/** fn(fromPeerId, data) for messages on a channel (mesh: parsed JSON; others: Uint8Array). */
export function on(label, fn) {
  handlers.get(label).add(fn);
  return () => handlers.get(label).delete(fn);
}
/** fn(fromPeerId, message) for JSON messages on the mesh channel. */
export const onMessage = (fn) => on('mesh', fn);
/** fn(peerId, 'open' | 'closed') when a peer's channels open or the peer goes away. */
export function onPeer(fn) {
  peerListeners.add(fn);
  return () => peerListeners.delete(fn);
}
const emitPeer = (id, state) => {
  for (const fn of peerListeners) {
    try { fn(id, state); } catch (e) { console.error('room: peer listener failed', e); }
  }
};

let active = null; // the joined room's internals

const channelOf = (peerId, label) => {
  const ch = active?.conns.get(peerId)?.channels[label];
  return ch?.readyState === 'open' ? ch : null;
};

/** Send on a channel: mesh takes any JSON value, the others bytes. False if the peer isn't open. */
export function send(peerId, label, data) {
  const ch = channelOf(peerId, label);
  if (!ch) return false;
  if (label === 'mesh') {
    ch.send(JSON.stringify(data));
    return true;
  }
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const count = Math.max(1, Math.ceil(bytes.length / FRAGMENT));
  if (count > 0xffff) throw new Error(`room: message of ${bytes.length} bytes is too large`);
  const id = (active.nextMessageId = (active.nextMessageId + 1) >>> 0);
  for (let i = 0; i < count; i++) {
    const part = bytes.subarray(i * FRAGMENT, (i + 1) * FRAGMENT);
    const frame = new Uint8Array(HEADER + part.length);
    const view = new DataView(frame.buffer);
    view.setUint32(0, id);
    view.setUint16(4, i);
    view.setUint16(6, count);
    frame.set(part, HEADER);
    ch.send(frame);
  }
  return true;
}
export const sendTo = (peerId, msg) => send(peerId, 'mesh', msg);
export function broadcast(msg) {
  for (const id of openPeers()) sendTo(id, msg);
}
export const openPeers = () => Object.keys(peers.value).filter((id) => peers.value[id].state === 'open');

/** Bytes queued on a channel, for backpressure. */
export const buffered = (peerId, label) => channelOf(peerId, label)?.bufferedAmount ?? 0;

/** Resolves once a channel's queue has drained below `low` bytes (or the peer is gone). */
export function drained(peerId, label, low = 1024 * 1024) {
  const ch = channelOf(peerId, label);
  if (!ch || ch.bufferedAmount <= low) return Promise.resolve();
  return new Promise((resolve) => {
    ch.bufferedAmountLowThreshold = low;
    const done = () => {
      ch.removeEventListener('bufferedamountlow', done);
      ch.removeEventListener('close', done);
      resolve();
    };
    ch.addEventListener('bufferedamountlow', done);
    ch.addEventListener('close', done);
  });
}

/** Default server for new rooms: REDAW_SIGNAL_URL, else this dev server's relay. */
export function defaultSignalURL() {
  if (env.signalURL) return env.signalURL;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/__live/signal`;
}

/** Join a room ({ room, signal }), leaving the current one. */
export function join(link) {
  if (active && current.value?.room === link.room && current.value?.signal === link.signal) return;
  leave();
  current.value = link;
  active = openRoom(link);
}

export function leave() {
  active?.close();
  active = null;
  current.value = null;
  peers.value = {};
}

// ---------------------------------------------------------------------------------------------

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function roomCrypto(secret) {
  const topic = 'redaw-' + hex(await crypto.subtle.digest('SHA-256', enc.encode(`redaw/topic/${secret}`)));
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('redaw/signal'), info: new Uint8Array() },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  return {
    topic,
    async seal(obj) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
      return `${b64(iv)}.${b64(ct)}`;
    },
    async open(data) {
      const [iv, ct] = String(data).split('.');
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(ct));
      return JSON.parse(dec.decode(pt));
    },
  };
}

function openRoom(link) {
  const conns = new Map(); // peerId -> { pc, channels: { label: RTCDataChannel }, queued, partial }
  let closed = false;
  let sig = null;
  let sendChain = Promise.resolve(); // keeps signaling messages in order through async encryption
  let retryTimer = null;
  const ready = roomCrypto(link.room);

  const setPeer = (id, state) => {
    const prev = peers.value[id]?.state;
    const next = { ...peers.value };
    if (state) next[id] = { state, since: prev === state ? next[id].since : Date.now() };
    else delete next[id];
    peers.value = next;
    if (state === 'open' && prev !== 'open') emitPeer(id, 'open');
    if (!state && prev === 'open') emitPeer(id, 'closed');
  };

  const publish = (kind, body, to) => {
    sendChain = sendChain
      .then(async () => {
        const { seal } = await ready;
        sig?.publish(await seal({ from: selfId, to, kind, body }));
      })
      .catch((e) => console.warn('room: publish failed', e));
  };

  function drop(id) {
    const c = conns.get(id);
    if (!c) return;
    conns.delete(id);
    c.pc.onconnectionstatechange = null;
    for (const ch of Object.values(c.channels)) {
      ch.onclose = null;
      ch.close();
    }
    c.pc.close();
    setPeer(id, null);
  }

  // After a failure, ask everyone to reintroduce themselves (connected peers ignore it).
  function retrySoon() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => !closed && publish('announce'), RETRY_ANNOUNCE_MS);
  }

  function deliver(label, from, data) {
    for (const fn of handlers.get(label)) {
      try { fn(from, data); } catch (err) { console.error(`room: ${label} handler failed`, err); }
    }
  }

  function receiveBinary(c, label, from, buf) {
    const frame = new Uint8Array(buf);
    const view = new DataView(frame.buffer, frame.byteOffset);
    const id = view.getUint32(0);
    const index = view.getUint16(4);
    const count = view.getUint16(6);
    const part = frame.subarray(HEADER);
    if (count === 1) return deliver(label, from, part);
    const key = `${label}:${id}`;
    let p = c.partial.get(key);
    if (!p) c.partial.set(key, (p = { parts: new Array(count), got: 0, size: 0 }));
    if (!p.parts[index]) {
      p.parts[index] = part;
      p.got++;
      p.size += part.length;
    }
    if (p.got < count) return;
    c.partial.delete(key);
    const whole = new Uint8Array(p.size);
    let at = 0;
    for (const x of p.parts) {
      whole.set(x, at);
      at += x.length;
    }
    deliver(label, from, whole);
  }

  function connect(id, initiator) {
    drop(id);
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const channels = {};
    for (const [label, n] of Object.entries(CHANNELS)) {
      const ch = pc.createDataChannel(label, { negotiated: true, id: n, ordered: true });
      ch.binaryType = 'arraybuffer';
      channels[label] = ch;
    }
    const c = { pc, channels, queued: [], partial: new Map() };
    conns.set(id, c);
    setPeer(id, 'connecting');

    pc.onicecandidate = (e) => e.candidate && publish('signal', { candidate: e.candidate.toJSON() }, id);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        drop(id);
        retrySoon();
      }
    };
    for (const [label, ch] of Object.entries(channels)) {
      ch.onopen = () => Object.values(channels).every((x) => x.readyState === 'open') && setPeer(id, 'open');
      ch.onclose = () => {
        drop(id);
        retrySoon();
      };
      ch.onmessage = (e) => {
        if (label !== 'mesh') return receiveBinary(c, label, id, e.data);
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        deliver('mesh', id, msg);
      };
    }

    if (initiator) {
      (async () => {
        await pc.setLocalDescription(await pc.createOffer());
        publish('signal', { description: pc.localDescription.toJSON() }, id);
      })().catch((e) => console.warn('room: offer failed', e));
    }
    return c;
  }

  async function onSignal(from, { description, candidate }) {
    if (description?.type === 'offer') {
      if (selfId < from) return; // we'd be the offerer; a stale or confused peer
      const c = connect(from, false);
      await c.pc.setRemoteDescription(description);
      for (const q of c.queued.splice(0)) await c.pc.addIceCandidate(q);
      await c.pc.setLocalDescription(await c.pc.createAnswer());
      publish('signal', { description: c.pc.localDescription.toJSON() }, from);
    } else if (description?.type === 'answer') {
      const c = conns.get(from);
      if (!c || c.pc.signalingState !== 'have-local-offer') return;
      await c.pc.setRemoteDescription(description);
      for (const q of c.queued.splice(0)) await c.pc.addIceCandidate(q);
    } else if (candidate) {
      const c = conns.get(from);
      if (!c) return;
      if (c.pc.remoteDescription) await c.pc.addIceCandidate(candidate);
      else c.queued.push(candidate);
    }
  }

  // Someone (re)appeared: meet them unless we're already connected or connecting.
  function greet(from) {
    if (conns.has(from)) return;
    if (selfId < from) connect(from, true);
    else publish('hello', null, from);
  }

  async function onPublished(data) {
    let msg;
    try {
      msg = await (await ready).open(data);
    } catch {
      return; // not ours (wrong key) or garbled
    }
    if (closed || !msg || msg.from === selfId || typeof msg.from !== 'string') return;
    if (msg.to && msg.to !== selfId) return;
    try {
      if (msg.kind === 'announce' || msg.kind === 'hello') greet(msg.from);
      else if (msg.kind === 'signal') await onSignal(msg.from, msg.body || {});
      else if (msg.kind === 'bye') drop(msg.from);
    } catch (e) {
      console.warn(`room: handling ${msg.kind} from ${msg.from.slice(0, 8)} failed`, e);
    }
  }

  ready
    .then(({ topic }) => {
      if (closed) return;
      sig = connectSignaling(link.signal, topic, {
        onOpen: () => publish('announce'),
        onMessage: onPublished,
        onStatus: (s) => !closed && (signalStatus.value = s),
      });
    })
    .catch((e) => console.error('room: cannot set up encryption', e));

  const onPageHide = () => publish('bye');
  addEventListener('pagehide', onPageHide);

  return {
    conns,
    nextMessageId: 0,
    close() {
      publish('bye');
      closed = true;
      clearTimeout(retryTimer);
      removeEventListener('pagehide', onPageHide);
      for (const id of [...conns.keys()]) drop(id);
      // Let the bye go out before the socket closes.
      sendChain.finally(() => sig?.close());
      signalStatus.value = 'closed';
    },
  };
}

export function dispose() {
  // A reload of this module is a new peer; session.js (re-evaluated with it) joins again.
  active?.close();
  active = null;
}
