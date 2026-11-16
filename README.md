# redaw

A page that is live-programmed from inside itself: an in-page Claude agent edits the
page's own modules through a chat panel, and the chat is one of those modules.

```sh
npm install
cp .env.example .env   # set ANTHROPIC_API_KEY (only the dev proxy reads it), optionally ANTHROPIC_BASE_URL
npm run dev
```

Without a key in `.env`, the chat asks for one and stores it in the browser. That is also
how a static `npm run build` works.

## Commit messages

Hooks append the human prompts behind each commit to its message, verbatim. Sonnet picks the
prompts that contributed to the staged diff from:

- Claude Code transcripts of this repo;
- the page chat, which the dev server logs to `.redaw/chat.jsonl` (gitignored).

Prompts whose work is still uncommitted are carried over in `.git/commit-prompts/` and
offered again at the next commit. Agent decisions are summarised only when the prompts alone
don't explain a change. Enable the hooks once per clone:

```sh
git config core.hooksPath .githooks
```

They need `claude` and `uv` on the PATH. They never block a commit, and `SKIP_PROMPT_HOOK=1`
turns them off for one commit.

## Layout

```
src/            bootstrap — the only code the agent cannot edit
  boot.js       starts everything; root error boundary + recovery panel (Ctrl+Alt+Z reverts)
  loader.js     in-page ES module loader: sucrase (JSX/TS) → blob URLs, staged swaps, module graph
  vfs.js        virtual file system: committed (IndexedDB ↔ disk) + pending buffer + history
  errors.js     error bus: console, window errors, rejections, render errors
  runtime.js    what modules get from '@live/runtime' (persist, vfs, loader, logs, runScript)
  vendor.js     bundled packages that live modules may import by name
vite/live-plugin.js   dev-only disk API (/__live/files), watcher → page, build-time bundle
live/           the live modules (entry: main.jsx)
  chat/         the chat UI + agent loop + tools + system prompt
  app/          the workspace you build in
```

## How a change happens

1. Edits from the agent go into the pending buffer. Nothing runs yet.
2. `apply_changes` is a transaction:
   - stage: compile and evaluate the changed modules plus everything that imports them, next to the old instances;
   - swap them in and re-render from the root;
   - optionally run a check script;
   - watch the whole page for errors for `observe_ms`.
3. Any error, from any module, rolls back to the old instances. The buffer is kept, and the errors go back to the agent.
4. On success the change is committed:
   - saved to IndexedDB;
   - written to `live/` when the dev server is running;
   - recorded in the history, so `revert_applied` can undo it.
5. Edits you make in your editor are pushed to the page by the watcher and applied without rollback. They also land in the history.
6. At boot, IndexedDB and disk are reconciled per file: the newer mtime wins, and deletions are tracked as tombstones.

## Conventions for live modules

- Preact with JSX, using the automatic runtime. Use `@preact/signals` for shared state.
- Import live modules by relative path, and bundled packages by name. To add a package, `npm i` it and add it to `src/vendor.js`.
- Re-evaluation resets component state. Keep state that should survive in `persist(key, init)` from `@live/runtime`.
- Export `dispose()` to clean up timers and listeners when a module is replaced.
- Importing a `.css` file injects it, and the style is swapped with the module.
