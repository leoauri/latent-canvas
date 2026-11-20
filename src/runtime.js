// `@live/runtime`: what the bootstrap offers to live modules.
//   import { vfs, loader, persist, env, logs, chatLog } from '@live/runtime';
import { signal } from '@preact/signals';
import { readLog, onLog, record, reportError, formatValue } from './errors.js';
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
 * A no-op in a static build.
 */
export function chatLog(role, text, { session } = {}) {
  if (!import.meta.env.DEV || !text?.trim()) return;
  fetch('/__live/chat-log', {
    method: 'POST',
    headers: { 'x-redaw': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ role, text, ...(session && { session }) }),
  }).catch(() => {});
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

  /** Run JS in page context with top-level await; `return` produces the result. */
  async function runScript(code) {
    const scope = scriptScope();
    const fn = VFS.compileScript(code, Object.keys(scope));
    return fn(...Object.values(scope));
  }

  const runtime = {
    vfs,
    loader,
    env,
    persist,
    chatLog: (role, text) => chatLog(role, text, { session: vfs.layerId }),
    vfsVersion, // read .value inside a component to re-render on VFS changes
    runScript,
    logs: { read: readLog, on: onLog, record, reportError, format: formatValue },
  };
  return runtime;
}
