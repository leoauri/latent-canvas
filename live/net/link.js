// Join links: the page URL plus a fragment naming a session's document, its room, and the
// signaling server the room meets on.
//
//   https://host/redaw/#doc=automerge:<id>&room=<secret>&signal=<url-encoded ws(s):// URL>
//
// `room` is a random 128-bit secret: its hash is the topic peers meet under on the signaling
// server, and a key derived from it encrypts everything they publish there (room.js). Whoever has
// the link is in the room. Everything sits in the fragment, so it never reaches an HTTP server; the
// fragment works the same pasted into another redaw instance (any origin) as opened directly.

/** @typedef {{ doc: string, room: string, signal: string }} JoinLink */

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A fresh room secret. */
export const newRoomSecret = () => b64url(crypto.getRandomValues(new Uint8Array(16)));

/** A link or a bare fragment ("#doc=…" or "doc=…"): its JoinLink, or null. */
export function parseLink(text) {
  if (!text) return null;
  let s = String(text).trim();
  const hash = s.indexOf('#');
  if (hash >= 0) s = s.slice(hash + 1);
  const p = new URLSearchParams(s);
  const doc = p.get('doc');
  const room = p.get('room');
  const signal = p.get('signal');
  if (!/^automerge:[1-9A-HJ-NP-Za-km-z]+$/.test(doc || '')) return null;
  if (!room || !/^[A-Za-z0-9_-]{16,}$/.test(room) || !validSignalURL(signal)) return null;
  return { doc, room, signal };
}

export function fragment({ doc, room, signal }) {
  return `doc=${doc}&room=${room}&signal=${encodeURIComponent(signal)}`;
}

export function makeLink(link, base = location.origin + location.pathname) {
  return `${base}#${fragment(link)}`;
}

export function validSignalURL(s) {
  try {
    return ['ws:', 'wss:'].includes(new URL(s).protocol);
  } catch {
    return false;
  }
}

/** True when the server is only reachable from this machine, so a link to it is no use to others. */
export function isLoopback(signal) {
  try {
    const h = new URL(signal).hostname.replace(/^\[|\]$/g, '');
    return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\./.test(h);
  } catch {
    return false;
  }
}
