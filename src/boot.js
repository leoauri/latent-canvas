// Bootstrap: the only code the agent cannot edit. Sets up the package registry, loader,
// VFS and error bus, then renders the live entry module (live/main.jsx, default export =
// root component). If the root fails to load or render, a recovery panel (owned by the
// bootstrap, so it works even when every live module is broken) offers to revert.
import { h, render, Component } from 'preact';
import liveBundle from 'virtual:live-bundle';
import { installErrorCapture, reportError, record } from './errors.js';
import { Loader } from './loader.js';
import { VFS, formatErrors } from './vfs.js';
import { createRuntime } from './runtime.js';
import { vendor } from './vendor.js';

installErrorCapture();

const ENTRY = 'main.jsx';
const isDev = import.meta.env.DEV;
// The __REDAW_*__ values are injected by vite.config.js `define` when the server starts. The guards
// keep the bootstrap alive if a new one is served before the server has reloaded its config.
const env = {
  dev: isDev,
  proxy: isDev && typeof __REDAW_PROXY__ !== 'undefined' && __REDAW_PROXY__,
  baseURL: typeof __REDAW_BASE_URL__ !== 'undefined' ? __REDAW_BASE_URL__ : 'https://api.openai.com/v1',
  model: typeof __REDAW_MODEL__ !== 'undefined' ? __REDAW_MODEL__ : 'gpt-5',
  maxTokens: typeof __REDAW_MAX_TOKENS__ !== 'undefined' ? __REDAW_MAX_TOKENS__ : 128000,
  signalURL: typeof __REDAW_SIGNAL_URL__ !== 'undefined' ? __REDAW_SIGNAL_URL__ : '',
  publicURL: typeof __REDAW_PUBLIC_URL__ !== 'undefined' ? __REDAW_PUBLIC_URL__ : '',
  entry: ENTRY,
};

const loader = new Loader({ vendor, entry: ENTRY });
let runtime;
// A page can be kept off the shared live/ folder after reading it once (e2e stress tabs, which must
// get each other's code only by publishing): set globalThis.__REDAW_NO_DISK__ before boot.
const useDisk = isDev && !globalThis.__REDAW_NO_DISK__;
const vfs = new VFS({ loader, disk: isDev, bundle: liveBundle, runCheck: (code) => runtime.runScript(code) });
runtime = createRuntime({ vfs, loader, env });
vendor['@live/runtime'] = runtime;
globalThis.__redaw.runtime = runtime; // handy from devtools
// Last resort from the devtools console: drop this browser's copy of the live code and reload with
// the server's version (the session window's Danger zone does the same).
window.reset = () => vfs.resetLocal();

const rootEl = document.getElementById('root');
let swapCount = 0;
let bootErrors = null;

class RootBoundary extends Component {
  componentDidCatch(err) {
    reportError(err, 'render');
    this.setState({ err });
  }
  render({ children }, { err }) {
    return err ? h(Recovery, { title: 'The live app crashed while rendering', detail: err.stack || String(err) }) : children;
  }
}

function Recovery({ title, detail }) {
  const last = vfs.history[vfs.history.length - 1];
  const btn = (label, onClick) =>
    h('button', { onClick, style: 'margin-right:8px;padding:6px 12px;font:inherit;cursor:pointer' }, label);
  return h(
    'div',
    { 'data-recovery': title, style: 'font:14px/1.5 system-ui;padding:24px;max-width:900px;margin:auto;color:#222;background:#fff;min-height:100vh' },
    h('h2', { style: 'color:#b00020;margin-top:0' }, title),
    h('pre', { style: 'white-space:pre-wrap;background:#f6f6f6;padding:12px;border-radius:6px;max-height:50vh;overflow:auto' }, detail),
    h('p', null, last ? `Last applied change: ${last.label} (${new Date(last.at).toLocaleTimeString()})` : 'No history to revert.'),
    last && btn('Revert last change', () => vfs.revert(1, { observeMs: 300 }).then(afterRecovery)),
    // Shared session state this page wrote can break rendering (what peers write, render code must tolerate).
    loader.get('net/history.js')?.undoLast && btn('Undo my last session action', () => (loader.get('net/history.js').undoLast(), start())),
    btn('Retry', () => start()),
    h('p', { style: 'color:#666' }, 'Shortcut anywhere: Ctrl+Alt+Z reverts the last applied change.'),
  );
}

function afterRecovery(result) {
  if (!result.ok) record('error', ['live: revert failed\n' + formatErrors(result.errors)], 'boot');
  start();
}

function renderRoot() {
  if (bootErrors) {
    render(h(Recovery, { title: 'The live modules failed to load', detail: formatErrors(bootErrors) }), rootEl);
    return;
  }
  const App = loader.get(ENTRY)?.default;
  if (typeof App !== 'function') {
    render(h(Recovery, { title: `${ENTRY} has no default-exported component`, detail: '' }), rootEl);
    return;
  }
  // A fresh key per swap resets the boundary, so a rolled-back swap renders cleanly again.
  render(h(RootBoundary, { key: ++swapCount }, h(App, null)), rootEl);
}

async function start() {
  const stage = await vfs.boot();
  bootErrors = stage.ok ? null : stage.errors;
  renderRoot();
}

loader.onSwap(() => {
  bootErrors = null;
  renderRoot();
});

window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    vfs.revert(1, { observeMs: 300 }).then(afterRecovery);
  }
});

if (import.meta.hot && useDisk) import.meta.hot.on('live:change', (data) => vfs.external(data));

await vfs.init();
if (!useDisk) vfs.disk = false;
await start();
