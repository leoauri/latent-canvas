// `@live/runtime`: what the bootstrap offers to live modules.
//   import { vfs, loader, persist, env, logs } from '@live/runtime';
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
    vfsVersion, // read .value inside a component to re-render on VFS changes
    runScript,
    logs: { read: readLog, on: onLog, record, reportError, format: formatValue },
  };
  return runtime;
}
