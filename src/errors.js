// Page-wide log and error bus. Installed before any live module runs, so everything a
// module logs or throws is visible to the agent (read_console) and to transactions
// (which collect errors while they observe a freshly applied change).

const MAX_LOG = 500;
let seq = 0;
const log = [];
const collectors = new Set();
const listeners = new Set();

export function formatValue(v, depth = 0) {
  if (v instanceof Error) return v.stack || `${v.name}: ${v.message}`;
  if (typeof v === 'string') return v;
  if (typeof v === 'function') return `[Function ${v.name || 'anonymous'}]`;
  if (typeof Element !== 'undefined' && v instanceof Element) {
    const html = v.outerHTML;
    return html.length > 300 ? html.slice(0, 300) + '…' : html;
  }
  if (v && typeof v === 'object') {
    if (depth > 2) return Array.isArray(v) ? '[Array]' : '[Object]';
    try {
      const seen = new WeakSet();
      return JSON.stringify(v, (k, x) => {
        if (x && typeof x === 'object') {
          if (seen.has(x)) return '[Circular]';
          seen.add(x);
        }
        if (typeof x === 'function') return `[Function ${x.name || 'anonymous'}]`;
        if (typeof x === 'bigint') return x.toString() + 'n';
        return x;
      });
    } catch {
      return String(v);
    }
  }
  return String(v);
}

/** Record an entry. level: log | info | warn | error | debug */
export function record(level, args, source = 'console') {
  const text = args.map((a) => formatValue(a)).join(' ');
  const entry = { id: ++seq, time: Date.now(), level, source, text };
  log.push(entry);
  if (log.length > MAX_LOG) log.shift();
  if (level === 'error') for (const c of collectors) c.push(entry);
  for (const l of listeners) l(entry);
  return entry;
}

/** Report an error that was caught by framework code (render boundary, loader, …). */
export function reportError(err, source = 'boundary') {
  return record('error', [err], source);
}

export function readLog({ since = 0, limit = 100, levels } = {}) {
  let out = log.filter((e) => e.id > since && (!levels || levels.includes(e.level)));
  if (out.length > limit) out = out.slice(-limit);
  return out;
}

export function onLog(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Collect every error-level entry until stop() is called.
 * includeConsole=false ignores plain console.error calls and keeps only thrown errors.
 */
export function collectErrors({ includeConsole = true } = {}) {
  const errors = [];
  const sink = { push: (e) => { if (includeConsole || e.source !== 'console') errors.push(e); } };
  collectors.add(sink);
  return { errors, stop: () => { collectors.delete(sink); return errors; } };
}

let installed = false;
export function installErrorCapture() {
  if (installed) return;
  installed = true;
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      try { record(level, args); } catch {}
      orig(...args);
    };
  }
  window.addEventListener('error', (e) => {
    record('error', [e.error || `${e.message} (${e.filename}:${e.lineno})`], 'window.onerror');
  });
  window.addEventListener('unhandledrejection', (e) => {
    record('error', [e.reason ?? 'unhandled rejection'], 'unhandledrejection');
  });
}
