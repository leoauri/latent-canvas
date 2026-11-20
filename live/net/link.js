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

/** creds: optional LLM credentials ({ apiKey, baseURL, model }) to hand to whoever opens the link. */
export function makeLink(link, base = location.origin + location.pathname, creds = null) {
  return `${base}#${fragment(link)}${creds ? credsFragment(creds) : ''}`;
}

// LLM credentials can ride along in a link (llmkey, llmurl, llmmodel), so friends can try the
// agent on the inviter's key. Like the rest of the fragment they never reach an HTTP server, but
// anyone the link reaches can use the key. The page drops them from its URL once read.

function credsFragment({ apiKey, baseURL, model }) {
  const p = new URLSearchParams({ llmkey: apiKey, llmurl: baseURL });
  if (model) p.set('llmmodel', model);
  return '&' + p;
}

/** The LLM credentials in a link or fragment: { apiKey, baseURL, model }, or null. */
export function parseCredentials(text) {
  if (!text) return null;
  let s = String(text).trim();
  const hash = s.indexOf('#');
  if (hash >= 0) s = s.slice(hash + 1);
  const p = new URLSearchParams(s);
  const apiKey = p.get('llmkey');
  const baseURL = p.get('llmurl');
  if (!apiKey || !baseURL) return null;
  try {
    if (!['https:', 'http:'].includes(new URL(baseURL).protocol)) return null;
  } catch {
    return null;
  }
  return { apiKey, baseURL: baseURL.replace(/\/+$/, ''), model: p.get('llmmodel') || '' };
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
