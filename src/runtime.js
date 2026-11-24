// `@live/runtime`: what the bootstrap offers to live modules.
//   import { vfs, loader, persist, env, logs, chatLog } from '@live/runtime';
import { signal } from '@preact/signals';
import { readLog, onLog, record, reportError, formatValue, errorText } from './errors.js';
import { VFS } from './vfs.js';

const persisted = (globalThis.__redaw_persist ||= new Map());

/**
 * A signal that survives module reloads (not page reloads): every instance of a module
 * that calls persist('key', …) gets the same signal.
 */
export function persist(key, initial) {
  if (!persisted.has(key)) persisted.set(key, signal(typeof initial === 'function' ? initial() : initial));
  return persisted.get(key);
}

/**
 * Append a chat turn to .redaw/chat.jsonl via the dev server, where the commit hook finds
 * the human prompts behind each commit. role 'human' for typed prompts, 'agent' for replies.
 * `session`: the session whose code the turn worked on (the runtime's chatLog adds the open one),
 * so the hook can find the prompts when that session's code is promoted to the base.
 * `chat`: the id of the chat the turn belongs to, so turns of different chats can be told apart.
 * A no-op in a static build.
 */
export function chatLog(role, text, { session, chat } = {}) {
  if (!import.meta.env.DEV || !text?.trim()) return;
  fetch('/__live/chat-log', {
    method: 'POST',
    headers: { 'x-redaw': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ role, text, ...(session && { session }), ...(chat && { chat }) }),
  }).catch(() => {});
}

/**
 * Mirror a page-chat record (full transcript with tool calls) to .redaw/chats/<id>.json via the
 * dev server, so it outlives the browser's IndexedDB. Writes per chat are coalesced: at most one
 * in flight, and only the latest record is sent after it. A no-op in a static build.
 */
const archiving = new Map(); // id -> { busy, next }
export function chatArchive(id, record) {
  if (!import.meta.env.DEV || !id) return;
  const slot = archiving.get(id) ?? { busy: false, next: null };
  archiving.set(id, slot);
  slot.next = record;
  if (slot.busy) return;
  const flush = () => {
    const body = slot.next;
    slot.next = null;
    if (!body) return void ((slot.busy = false), archiving.delete(id));
    slot.busy = true;
    fetch(`/__live/chat-archive/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'x-redaw': '1', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
      .catch(() => {})
      .finally(flush);
  };
  flush();
}

export function createRuntime({ vfs, loader, env }) {
  const vfsVersion = signal(0);
  vfs.subscribe(() => (vfsVersion.value = vfs.version));

  const scriptScope = () => ({
    runtime,
    vfs,
    loader,
    modules: (path) => loader.get(path),
    vendor: globalThis.__redaw.vendor,
  });

  /** Run JS in page context with top-level await; `return` produces the result. `extra`: more names in scope. */
  async function runScript(code, extra = {}) {
    const scope = { ...scriptScope(), ...extra };
    const fn = VFS.compileScript(code, Object.keys(scope));
    return fn(...Object.values(scope));
  }

  const runtime = {
    vfs,
    loader,
    env,
    persist,
    chatLog: (role, text, opts) => chatLog(role, text, { session: vfs.layerId, ...opts }),
    chatArchive,
    vfsVersion, // read .value inside a component to re-render on VFS changes
    runScript,
    logs: { read: readLog, on: onLog, record, reportError, format: formatValue, errorText },
  };
  return runtime;
}
