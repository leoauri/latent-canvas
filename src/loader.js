// Live module loader.
//
// Every live module is compiled in the page (sucrase: JSX via preact's automatic runtime,
// TypeScript stripping), its import specifiers are rewritten to blob: URLs, and it is
// evaluated with a native dynamic import(). Changes go through three phases so they can be
// undone cleanly:
//
//   stage(files)     evaluate new instances of every affected module *next to* the old ones
//   activate(stage)  make the new instances current (CSS swapped, onSwap listeners re-render)
//   finalize(stage)  dispose the replaced instances      — or —
//   rollback(stage)  make the old instances current again and dispose the new ones
//
// Old instances are never disposed before finalize, so rollback needs no re-evaluation.
import { transform } from 'sucrase';
import { init as initLexer, parse as parseImports } from 'es-module-lexer';
import { reportError, errorText } from './errors.js';

const RESOLVE_EXTS = ['', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.json', '.css'];
const CODE_RE = /\.(jsx?|tsx?|mjs)$/i;
const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

export function normalizePath(p) {
  const parts = [];
  for (const seg of String(p).replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) throw new Error(`path escapes live root: ${p}`);
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirname = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

export class Loader {
  constructor({ vendor, entry = 'main.jsx' }) {
    this.vendor = vendor; // { specifier: moduleNamespace }
    this.entry = entry;
    this.records = new Map(); // path -> record (current instances)
    this.compileCache = new Map(); // path -> { source, result }
    this.vendorUrls = new Map();
    this.urlToPath = new Map();
    this.swapListeners = new Set();
    this.ready = initLexer;
    globalThis.__redaw = globalThis.__redaw || {};
    globalThis.__redaw.vendor = vendor;
  }

  onSwap(fn) {
    this.swapListeners.add(fn);
    return () => this.swapListeners.delete(fn);
  }

  /** Namespace of the current instance of a loaded module. */
  get(path) {
    return this.records.get(normalizePath(path))?.ns;
  }

  /** Module map for tools/UI. */
  graph() {
    const importedBy = new Map();
    for (const r of this.records.values())
      for (const d of r.deps) importedBy.set(d, [...(importedBy.get(d) || []), r.path]);
    return [...this.records.values()].map((r) => ({
      path: r.path,
      deps: r.deps,
      packages: r.packages,
      importedBy: importedBy.get(r.path) || [],
      exports: r.ns ? Object.keys(r.ns) : [],
    }));
  }

  // ---- compilation -------------------------------------------------------------------

  compile(path, source) {
    const cached = this.compileCache.get(path);
    if (cached && cached.source === source) return cached.result;
    const result = this._compile(path, source);
    this.compileCache.set(path, { source, result });
    return result;
  }

  _compile(path, source) {
    if (/\.json$/i.test(path)) {
      JSON.parse(source); // surfaces syntax errors with a position
      return { code: `export default ${source};`, imports: [] };
    }
    if (/\.css$/i.test(path)) return { code: `export default ${JSON.stringify(source)};`, imports: [], css: source };
    if (!CODE_RE.test(path)) return { code: `export default ${JSON.stringify(source)};`, imports: [] };

    const isTS = /\.tsx?$/i.test(path);
    const transforms = /\.ts$/i.test(path) ? ['typescript'] : isTS ? ['typescript', 'jsx'] : ['jsx'];
    let code;
    try {
      code = transform(source, {
        transforms,
        jsxRuntime: 'automatic',
        jsxImportSource: 'preact',
        production: true,
        filePath: path,
      }).code;
    } catch (err) {
      const e = new Error(err.message);
      e.stack = e.message; // the compiler's own stack is noise for the agent
      throw e;
    }
    const [imports] = parseImports(code);
    const out = [];
    for (const imp of imports) {
      // es-module-lexer 3 records: { type: 'static'|'dynamic'|'import-meta'|..., specifier, start, end }
      if (imp.type !== 'static' && imp.type !== 'dynamic') continue;
      if (imp.specifier == null || imp.typeOnly) continue; // computed dynamic specifier: left alone
      // For static imports start..end is the bare specifier; for dynamic ones it includes quotes.
      out.push({ spec: imp.specifier, start: imp.start, end: imp.end, dynamic: imp.type === 'dynamic' });
    }
    return { code, imports: out };
  }

  /** Resolve an import specifier from `from` against the candidate file set. */
  resolve(from, spec, files) {
    if (/^(https?:|data:|blob:)/.test(spec)) return { kind: 'url', target: spec };
    if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')) {
      const base = normalizePath(spec.startsWith('/') ? spec : `${dirname(from)}/${spec}`);
      for (const ext of RESOLVE_EXTS) if (files.has(base + ext)) return { kind: 'live', target: base + ext };
      for (const ext of RESOLVE_EXTS.slice(1))
        if (files.has(`${base}/index${ext}`)) return { kind: 'live', target: `${base}/index${ext}` };
      throw new Error(`${from}: cannot resolve "${spec}" (no such live module)`);
    }
    if (this.vendor[spec]) return { kind: 'vendor', target: spec };
    throw new Error(
      `${from}: package "${spec}" is not bundled. Available: ${Object.keys(this.vendor).sort().join(', ')}`,
    );
  }

  vendorUrl(spec) {
    let url = this.vendorUrls.get(spec);
    if (url) return url;
    const ns = this.vendor[spec];
    const names = Object.keys(ns).filter((k) => k !== 'default' && IDENT_RE.test(k));
    const code = [
      `const m = globalThis.__redaw.vendor[${JSON.stringify(spec)}];`,
      `export default ('default' in m ? m.default : m);`,
      names.length ? `const { ${names.map((n, i) => `${n}: _${i}`).join(', ')} } = m;` : '',
      names.length ? `export { ${names.map((n, i) => `_${i} as ${n}`).join(', ')} };` : '',
    ].join('\n');
    url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    this.vendorUrls.set(spec, url);
    return url;
  }

  // ---- staging -----------------------------------------------------------------------

  /**
   * Evaluate new instances for `files` (Map path -> source, the complete candidate file set).
   * `changed` lists paths that differ from the current state (written or deleted); changed
   * modules are evaluated even when nothing imports them, so their errors surface.
   */
  async stage(files, changed = []) {
    await this.ready;
    const errors = [];
    const prev = this.records;
    const graph = new Map(); // path -> { compiled, links: [{imp, kind, target}] }
    const failed = new Set();

    const addError = (path, err) => {
      failed.add(path);
      errors.push({ path, message: this.mapUrls(errorText(err)) });
    };

    // 1. Walk everything reachable from the entry, the changed modules and the
    //    currently loaded modules, compiling and resolving as we go.
    const roots = new Set([this.entry, ...changed, ...prev.keys()].filter((p) => files.has(p)));
    if (!files.has(this.entry)) errors.push({ path: this.entry, message: `entry module ${this.entry} is missing` });
    const visit = (path) => {
      if (graph.has(path) || failed.has(path)) return;
      let compiled;
      try {
        compiled = this.compile(path, files.get(path));
      } catch (err) {
        return addError(path, err);
      }
      const links = [];
      graph.set(path, { compiled, links });
      for (const imp of compiled.imports) {
        try {
          links.push({ imp, ...this.resolve(path, imp.spec, files) });
        } catch (err) {
          addError(path, err);
        }
      }
      for (const l of links) if (l.kind === 'live') visit(l.target);
    };
    for (const r of roots) visit(r);

    // 2. Topological order; a module is rebuilt if its source changed, it is new, or any
    //    of its live dependencies is rebuilt.
    const order = [];
    const state = new Map(); // path -> 'visiting' | 'done'
    const rebuild = new Set();
    const topo = (path, stack) => {
      if (state.get(path) === 'done' || !graph.has(path)) return;
      if (state.get(path) === 'visiting') {
        const cycle = [...stack.slice(stack.indexOf(path)), path].join(' -> ');
        throw new Error(`import cycle between live modules: ${cycle}`);
      }
      state.set(path, 'visiting');
      const node = graph.get(path);
      for (const l of node.links) if (l.kind === 'live') topo(l.target, [...stack, path]);
      state.set(path, 'done');
      const old = prev.get(path);
      const deps = node.links.filter((l) => l.kind === 'live').map((l) => l.target);
      if (
        !old ||
        old.source !== files.get(path) ||
        deps.some((d) => rebuild.has(d) || failed.has(d)) ||
        old.deps.join('\n') !== deps.join('\n')
      )
        rebuild.add(path);
      order.push(path);
    };
    try {
      for (const r of roots) topo(r, []);
    } catch (err) {
      errors.push({ path: '(graph)', message: err.message });
    }

    // 3. Evaluate rebuilt modules in dependency order.
    const next = new Map();
    const created = [];
    for (const path of order) {
      if (!rebuild.has(path)) {
        next.set(path, prev.get(path));
        continue;
      }
      const node = graph.get(path);
      const deps = node.links.filter((l) => l.kind === 'live').map((l) => l.target);
      const brokenDep = deps.find((d) => failed.has(d) || !next.has(d));
      if (brokenDep || failed.has(path)) {
        if (!failed.has(path)) addError(path, `not evaluated: dependency ${brokenDep} failed`);
        continue;
      }
      const record = {
        path,
        source: files.get(path),
        deps,
        packages: node.links.filter((l) => l.kind === 'vendor').map((l) => l.target),
        css: node.compiled.css,
        ns: null,
        url: null,
      };
      try {
        let code = node.compiled.code;
        // Replace specifiers back to front so earlier offsets stay valid.
        for (const l of [...node.links].sort((a, b) => b.imp.start - a.imp.start)) {
          const url =
            l.kind === 'live' ? next.get(l.target).url : l.kind === 'vendor' ? this.vendorUrl(l.target) : l.target;
          const text = l.imp.dynamic ? JSON.stringify(url) : url;
          code = code.slice(0, l.imp.start) + text + code.slice(l.imp.end);
        }
        code += `\n//# sourceURL=live:///${path}`;
        record.url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
        this.urlToPath.set(record.url, path);
        record.ns = await import(/* @vite-ignore */ record.url);
        next.set(path, record);
        created.push(record);
      } catch (err) {
        addError(path, err);
      }
    }
    // Keep loaded-but-unaffected modules that the walk did not reach (should be rare).
    for (const [p, r] of prev) if (!next.has(p) && files.has(p) && !graph.has(p) && !failed.has(p)) next.set(p, r);

    const stage = { ok: errors.length === 0, errors, prev, next, created, rebuilt: created.map((r) => r.path) };
    if (!stage.ok) this._dispose(created);
    return stage;
  }

  activate(stage) {
    this._swapCss(stage.prev, stage.next);
    this.records = stage.next;
    this._emit();
  }

  rollback(stage) {
    this._swapCss(stage.next, stage.prev);
    this.records = stage.prev;
    this._dispose(stage.created);
    this._emit();
  }

  finalize(stage) {
    const replaced = [...stage.prev.values()].filter((r) => stage.next.get(r.path) !== r);
    this._dispose(replaced);
  }

  _emit() {
    for (const fn of this.swapListeners) {
      try {
        fn(this);
      } catch (err) {
        reportError(err, 'loader');
      }
    }
  }

  _swapCss(from, to) {
    for (const r of from.values()) if (r.style && to.get(r.path) !== r) { r.style.remove(); r.style = null; }
    for (const r of to.values()) {
      if (r.css == null || r.style) continue;
      r.style = document.createElement('style');
      r.style.dataset.live = r.path;
      r.style.textContent = r.css;
      document.head.appendChild(r.style);
    }
  }

  _dispose(records) {
    for (const r of records) {
      if (r.style) { r.style.remove(); r.style = null; }
      try {
        r.ns?.dispose?.();
      } catch (err) {
        reportError(err, `dispose ${r.path}`);
      }
    }
  }

  mapUrls(text) {
    return String(text).replace(/blob:[^\s)'"]+/g, (u) => (this.urlToPath.has(u) ? `live:///${this.urlToPath.get(u)}` : u));
  }
}
