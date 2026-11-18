// Agent tools, as OpenAI-style function definitions. The file tool keeps the schema of the
// common str_replace text editor; its writes go to the VFS buffer and only run after apply_changes.
import { vfs, loader, logs, runScript } from '@live/runtime';
import { extensionTool, extensionToolDefs } from './extensions.js';

const custom = (name, description, properties, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});

export const tools = [
  custom(
    'str_replace_based_edit_tool',
    'View, create and edit live files. Edits are buffered and only run after apply_changes.\n' +
      '- view: a file (with line numbers; view_range [start, end], end -1 = to the end) or a directory listing (path "" = root).\n' +
      '- create: write file_text to path, overwriting any existing file.\n' +
      '- str_replace: replace old_str (must match exactly once, whitespace included) with new_str.\n' +
      '- insert: insert insert_text after line insert_line (0 = at the top).',
    {
      command: { type: 'string', enum: ['view', 'create', 'str_replace', 'insert'] },
      path: { type: 'string', description: 'Path relative to the live root, e.g. "app/Workspace.jsx"' },
      view_range: { type: 'array', items: { type: 'integer' }, description: 'view: [start, end], 1-based' },
      file_text: { type: 'string', description: 'create: full file contents' },
      old_str: { type: 'string', description: 'str_replace: exact text to replace' },
      new_str: { type: 'string', description: 'str_replace: replacement text' },
      insert_line: { type: 'integer', description: 'insert: line after which to insert' },
      insert_text: { type: 'string', description: 'insert: text to insert' },
    },
    ['command', 'path'],
  ),
  custom(
    'list_modules',
    'Module map of the live file system: every file with its load state, imports (live deps and packages), importers, exports, and buffered (unapplied) changes. Also lists bundled packages and recent applied transactions. Call this first to orient yourself.',
    {},
  ),
  custom(
    'delete_file',
    'Buffer the deletion of a live file. Like edits, it only takes effect on apply_changes.',
    { path: { type: 'string', description: 'Path relative to the live root, e.g. "app/Old.jsx"' } },
    ['path'],
  ),
  custom(
    'apply_changes',
    'Atomically apply all buffered edits: evaluate the new versions of changed modules and their importers, swap them into the running page, re-render, then watch the whole page for errors (from any module) for observe_ms, optionally running a check script. If anything fails the swap is rolled back, the page returns to its previous state, and the buffer is kept so you can fix and re-apply. On success the changes are committed (persisted, and written to disk under the dev server).',
    {
      label: { type: 'string', description: 'Short description of the change set, shown in history.' },
      observe_ms: { type: 'integer', description: 'How long to watch for errors after the swap. Default 800.' },
      check: {
        type: 'string',
        description:
          'Optional async JS body run after the swap (same scope as eval_js: modules(path), vfs, loader, vendor, runtime, document). Throw to fail the transaction, e.g. `if (!document.querySelector(".counter")) throw new Error("counter not rendered")`.',
      },
      include_console_errors: {
        type: 'boolean',
        description: 'Count console.error calls as failures (default true). Thrown/uncaught errors always count.',
      },
    },
  ),
  custom(
    'discard_changes',
    'Drop buffered edits without applying them (all, or the given paths).',
    { paths: { type: 'array', items: { type: 'string' } } },
  ),
  custom(
    'revert_applied',
    'Undo the last `count` committed transactions (yours, the user\'s, or disk edits), as a transaction with the same error checks. Use when an applied change turned out wrong, or the user asks to go back.',
    { count: { type: 'integer', description: 'Default 1.' } },
  ),
  custom(
    'eval_js',
    'Run JavaScript in the page (async function body: top-level await works, `return` a value to see it). In scope: modules(path) -> namespace of the running module, vfs, loader, vendor, runtime, plus all browser globals. Console output during the run is returned. Not transactional: side effects stay. Use it to inspect the DOM, call into modules, and verify behaviour.',
    {
      code: { type: 'string' },
      timeout_ms: { type: 'integer', description: 'Default 10000. Cannot interrupt synchronous infinite loops.' },
    },
    ['code'],
  ),
  custom(
    'read_console',
    'Read the page log (console output, uncaught errors, render errors) captured since boot. Pass since_id to read only newer entries.',
    {
      since_id: { type: 'integer' },
      limit: { type: 'integer', description: 'Default 50.' },
      errors_only: { type: 'boolean' },
    },
  ),
];

export const toolDefs = () => [...tools, ...extensionToolDefs()];

// ---- execution ---------------------------------------------------------------------

const ok = (id, content) => ({ type: 'tool_result', tool_use_id: id, content });
const fail = (id, content) => ({ type: 'tool_result', tool_use_id: id, content, is_error: true });

// Compatible servers rarely enforce the schemas: check inputs before running anything.
function validate(input, spec) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'input must be an object';
  for (const [key, type] of Object.entries(spec)) {
    const required = !type.endsWith('?');
    const t = type.replace('?', '');
    const v = input[key];
    if (v === undefined) {
      if (required) return `missing required "${key}"`;
      continue;
    }
    const actual = Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v;
    if (actual !== t && !(t === 'number' && actual === 'integer')) return `"${key}" must be ${t}`;
  }
  return null;
}

const SPECS = {
  list_modules: {},
  delete_file: { path: 'string' },
  apply_changes: { label: 'string?', observe_ms: 'integer?', check: 'string?', include_console_errors: 'boolean?' },
  discard_changes: { paths: 'array?' },
  revert_applied: { count: 'integer?' },
  eval_js: { code: 'string', timeout_ms: 'integer?' },
  read_console: { since_id: 'integer?', limit: 'integer?', errors_only: 'boolean?' },
};

/** ctx: { session } of the chat running the tool. */
export async function runTool(block, ctx = {}) {
  const { id, name, input } = block;
  try {
    if (name === 'str_replace_based_edit_tool') return editor(id, input);
    const ext = extensionTool(name);
    if (ext) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return fail(id, 'input must be an object');
      return ok(id, await ext.run(input, ctx));
    }
    const spec = SPECS[name];
    if (!spec) return fail(id, `unknown tool ${name}`);
    const problem = validate(input, spec);
    if (problem) return fail(id, JSON.stringify({ INVALID_INPUT: problem, received: input }));
    switch (name) {
      case 'list_modules':
        return ok(id, moduleMap());
      case 'delete_file':
        vfs.remove(livePath(input.path));
        return ok(id, `Buffered deletion of ${livePath(input.path)}. Call apply_changes to run it.`);
      case 'apply_changes':
        return applyChanges(id, input);
      case 'discard_changes':
        return ok(id, `Discarded buffered changes: ${vfs.discard(input.paths?.map(livePath)).join(', ') || '(none)'}`);
      case 'revert_applied': {
        const r = await vfs.revert(input.count ?? 1);
        if (!r.ok) return fail(id, `Revert failed${r.message ? ': ' + r.message : ''}\n${formatErrors(r.errors)}`);
        return ok(id, `Reverted: ${r.reverted.map((e) => e.label).join(', ')}. Rebuilt: ${r.rebuilt.join(', ') || '-'}`);
      }
      case 'eval_js':
        return evalJs(id, input);
      case 'read_console': {
        const entries = logs.read({
          since: input.since_id ?? 0,
          limit: input.limit ?? 50,
          levels: input.errors_only ? ['error'] : undefined,
        });
        return ok(id, entries.map((e) => `#${e.id} [${e.level}${e.source !== 'console' ? ' ' + e.source : ''}] ${e.text}`).join('\n') || '(no entries)');
      }
    }
  } catch (err) {
    return fail(id, String(err?.message || err));
  }
}

/** Accept "x.jsx", "/x.jsx", "live/x.jsx", "/live/x.jsx". */
function livePath(p) {
  return String(p ?? '').replace(/^\/+/, '').replace(/^live(\/|$)/, '');
}

function formatErrors(errors = []) {
  return errors.map((e) => `- ${e.path}: ${e.message}`).join('\n');
}

// ---- text editor ---------------------------------------------------------------------

function editor(id, input) {
  const path = livePath(input?.path);
  switch (input?.command) {
    case 'view': {
      const files = vfs.list();
      const isDir = !path || files.some((f) => f.startsWith(path + '/'));
      if (isDir && vfs.read(path) === undefined) {
        const pending = new Map(vfs.status().map((s) => [s.path, s.kind]));
        const under = files.filter((f) => !path || f.startsWith(path + '/'));
        const deleted = [...pending].filter(([p, k]) => k === 'deleted' && (!path || p.startsWith(path + '/')));
        const lines = under.map((f) => `${f}  (${vfs.read(f).split('\n').length} lines)${pending.has(f) ? '  [' + pending.get(f) + ', unapplied]' : ''}`);
        for (const [p] of deleted) lines.push(`${p}  [deleted, unapplied]`);
        return ok(id, lines.join('\n') || '(empty)');
      }
      const src = vfs.read(path);
      if (src === undefined) return fail(id, `File not found: ${path}`);
      const all = src.split('\n');
      let [start, end] = input.view_range || [1, all.length];
      if (end === -1) end = all.length;
      const body = all
        .slice(start - 1, end)
        .map((l, i) => `${String(start + i).padStart(6)}\t${l}`)
        .join('\n');
      return ok(id, body);
    }
    case 'create': {
      if (typeof input.file_text !== 'string') return fail(id, 'create needs file_text');
      const existed = vfs.read(path) !== undefined;
      vfs.write(path, input.file_text);
      return ok(id, `${existed ? 'Overwrote' : 'Created'} ${path} (buffered, not running yet).`);
    }
    case 'str_replace': {
      const src = vfs.read(path);
      if (src === undefined) return fail(id, `File not found: ${path}`);
      if (typeof input.old_str !== 'string' || !input.old_str) return fail(id, 'old_str is required');
      const hits = [];
      for (let i = src.indexOf(input.old_str); i !== -1; i = src.indexOf(input.old_str, i + 1))
        hits.push(src.slice(0, i).split('\n').length);
      if (hits.length === 0) return fail(id, 'No match found for replacement. Please check your text and try again.');
      if (hits.length > 1)
        return fail(id, `Found ${hits.length} matches (lines ${hits.join(', ')}). Include more context so old_str is unique.`);
      vfs.write(path, src.replace(input.old_str, () => input.new_str ?? ''));
      return ok(id, `Edited ${path} (buffered, not running yet).`);
    }
    case 'insert': {
      const src = vfs.read(path);
      if (src === undefined) return fail(id, `File not found: ${path}`);
      const text = input.insert_text ?? input.new_str;
      if (typeof text !== 'string') return fail(id, 'insert needs insert_text');
      const lines = src.split('\n');
      const at = input.insert_line;
      if (!Number.isInteger(at) || at < 0 || at > lines.length) return fail(id, `insert_line must be 0..${lines.length}`);
      lines.splice(at, 0, ...text.split('\n'));
      vfs.write(path, lines.join('\n'));
      return ok(id, `Inserted into ${path} after line ${at} (buffered, not running yet).`);
    }
    default:
      return fail(id, `Unsupported command: ${input?.command}`);
  }
}

// ---- other tools -----------------------------------------------------------------------

function moduleMap() {
  const graph = new Map(loader.graph().map((g) => [g.path, g]));
  const pending = new Map(vfs.status().map((s) => [s.path, s]));
  const lines = ['# Live files (path | lines | state | deps | packages | imported by | exports)'];
  for (const path of new Set([...vfs.list(), ...pending.keys()])) {
    const g = graph.get(path);
    const p = pending.get(path);
    const src = vfs.read(path);
    lines.push(
      [
        path,
        src === undefined ? '-' : src.split('\n').length,
        (g ? 'loaded' : 'not loaded') + (p ? `, ${p.kind} (unapplied${p.stale ? ', STALE base' : ''})` : ''),
        g?.deps.join(', ') || '-',
        g?.packages.join(', ') || '-',
        g?.importedBy.join(', ') || '-',
        g?.exports.join(', ') || '-',
      ].join(' | '),
    );
  }
  lines.push('', `# Entry: ${loader.entry}`, `# Packages: ${Object.keys(loader.vendor).sort().join(', ')}`);
  const hist = vfs.history.slice(-8).reverse();
  lines.push('# Recent transactions (newest first):');
  for (const h of hist) lines.push(`- ${new Date(h.time).toLocaleTimeString()} ${h.label}: ${h.changes.map((c) => c.path).join(', ')}`);
  if (!hist.length) lines.push('- (none)');
  return lines.join('\n');
}

async function applyChanges(id, input) {
  const r = await vfs.apply({
    label: input.label,
    observeMs: input.observe_ms ?? 800,
    check: input.check,
    includeConsole: input.include_console_errors ?? true,
  });
  if (r.ok) {
    const warn = r.warnings?.length ? `\nWarnings:\n${r.warnings.join('\n')}` : '';
    return ok(id, r.message || `Applied and committed: ${r.changed.join(', ')}. Re-evaluated: ${r.rebuilt.join(', ') || '-'}.${warn}`);
  }
  const what = {
    conflict: 'Not applied: buffer conflicts with the committed files.',
    evaluate: 'Not applied: modules failed to compile/evaluate. The page was not touched; the buffer is kept.',
    observe: 'Applied, but errors occurred while observing the page, so the change was ROLLED BACK. The buffer is kept.',
    committed: 'Applied and committed, but errors were reported:',
  }[r.phase];
  return fail(id, `${what}\n${formatErrors(r.errors)}`);
}

async function evalJs(id, { code, timeout_ms = 10000 }) {
  const output = [];
  const off = logs.on((e) => output.push(`[${e.level}] ${e.text}`));
  let timer;
  try {
    const result = await Promise.race([
      runScript(code),
      new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`timed out after ${timeout_ms}ms`)), timeout_ms))),
    ]);
    const shown = result === undefined ? 'undefined' : logs.format(result);
    return ok(id, `${output.length ? 'Console:\n' + output.join('\n') + '\n\n' : ''}Result: ${clip(shown)}`);
  } catch (err) {
    return fail(id, `${output.length ? 'Console:\n' + output.join('\n') + '\n\n' : ''}${loader.mapUrls(err?.stack || String(err))}`);
  } finally {
    clearTimeout(timer);
    off();
  }
}

const clip = (s, n = 20000) => (s.length > n ? s.slice(0, n) + `… (${s.length - n} more chars)` : s);
