# redaw

A page that is live-programmed from inside itself: an in-page LLM agent (any OpenAI-compatible API) edits the
page's own modules through a chat panel, and the chat is one of those modules.

```sh
npm install
cp .env.example .env   # set OPENAI_API_KEY (only the dev proxy reads it), optionally OPENAI_BASE_URL / OPENAI_MODEL
npm run dev
```

Without a key in `.env`, the page calls the endpoint directly with a key from the chat
settings, stored in the browser (or none, for local servers like Ollama). That is also
how a static `npm run build` works.

## Commit messages

Hooks append the human prompts behind each commit to its message, verbatim. Sonnet picks the
prompts that contributed to the staged diff from:

- Claude Code transcripts of this repo;
- the page chat, which the dev server logs to `.redaw/chat.jsonl` (gitignored).

Prompts whose work is still uncommitted are carried over in `.git/commit-prompts/` and
offered again at the next commit. Agent decisions are summarised only when the prompts alone
don't explain a change. `npm install` and `npm run dev` turn the hooks on (unless the clone
already has a `core.hooksPath`); by hand:

```sh
git config core.hooksPath .githooks
```

They need `claude` and Python 3.11+ (`python3`) on the PATH. If the hook can't run (either is missing, or the
Sonnet call fails), the commit is aborted with the reason; `SKIP_PROMPT_HOOK=1` skips it for
one commit. Rebases, cherry-picks and reverts keep their messages untouched.

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
vite/signal.js  dev-only y-webrtc-compatible signaling relay at ws /__live/signal
live/           the live modules (entry: main.jsx)
  chat/         the chat UI + agent loop + tools + system prompt
  app/          the workspace you build in
  net/          multiplayer: sessions, sync, blobs (see Multiplayer)
  ui/           shared UI: floating windows
scripts/e2e.mjs end-to-end rig: dev server + headless tabs with separate profiles (e2e/README.md)
```

## How a change happens

1. Edits from the agent go into its chat's own overlay (`chat:<session id>`, a buffer other chats don't see; a session started on a change works in that change's overlay). Nothing runs yet. `try_changes` runs them live without committing, until kept or discarded.
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
- Floating windows (draggable, resizable, collapsible, persisted) are shared: register a kind with `registerWindowKind(kind, { render })` from `live/ui/FloatingWindow.jsx` at import time, export the returned function as (or call it from) `dispose()`, and open windows with `openWindow(kind, props)` from `live/ui/windows.js`. See the comment at the top of `windows.js`.
- State that everyone in a session should see goes through `shared(key, signal, opts)` from `live/net/shared.js` instead of `db.sync`; name user-level changes with `act(label, fn)` so they show up as one undoable action. See Multiplayer.

## Multiplayer

A **session** is one [Automerge](https://automerge.org) document plus a room of peers editing it. The
session pill (bottom right) opens the Session window: rename it, copy the invite link, see who's
connected, undo recent actions, switch between sessions or join one from a link.

- **Invite link**: `…/#doc=automerge:<id>&room=<secret>&signal=<ws(s) URL>`. The room secret is the
  only credential: whoever has the link can join and edit, so share it like a password. It never
  reaches an HTTP server (it's in the fragment). The link names its signaling server, so everyone
  meets on the same one.
- **Transport** (`net/room.js`): a full WebRTC mesh (meant for up to ~20 trusted peers). The
  signaling server only relays connection setup between peers who know the room's topic (a hash of
  the secret), and that traffic is encrypted with a key derived from the secret. After that, data
  goes peer to peer.
- **What's shared** is decided per signal by the code that owns it (`net/shared.js`): today masks and
  the layer stack. Per-machine fields (an input device) stay local, and everything else (selection,
  windows, chats, your code) is local unless a module shares it. Since everyone may run different
  code, writes are per entity and field, and fields that your code doesn't know about are kept.
  A module that starts sharing a new key just writes it; peers without that code ignore it.
- **Presence** (`net/presence.js`): others' cursors (interpolated), playheads and selected clips
  show on the timeline in their colour, with their name. It's never stored. Toggle it in the Session
  window or with Alt+P. Other modules share more with `presence.publish(key, signal)`.
- **History** (`net/history.js`): every change you make is an action in your local history. Undo
  reverts an action wherever nobody has changed the value since. Restore sets one entity, one key or
  everything back to how it was after any action. Both write a new change; nobody's history is
  rewound.
- **Files** (`net/blobs.js`): large data (models, clip vectors) is stored by content hash in the
  browser's private file system (OPFS) and fetched from peers that have it, in chunks that are
  verified and resumable.

### Signaling server

`npm run dev` and `vite preview` serve one at `ws(s)://<host>/__live/signal`, and new sessions use it
by default. That works for tabs on this machine, or on your LAN if you start Vite with `--host`. To
join with people elsewhere, run a public one: any [y-webrtc](https://github.com/yjs/y-webrtc)
signaling server works. For example, on a small VPS:

```sh
PORT=4444 npx -y -p y-webrtc y-webrtc-signaling
```

Put it behind TLS (browsers on https pages need `wss://`), e.g. with Caddy:

```
signal.example.org {
  reverse_proxy localhost:4444
}
```

Then set `REDAW_SIGNAL_URL=wss://signal.example.org` in `.env` so new sessions use it, or switch an
existing session under Session › Signaling server (everyone then needs the new link). The server
sees only encrypted connection offers and peers' IP addresses, never session data.

Peers behind strict NATs may fail to connect with STUN alone; add a TURN server to `ICE_SERVERS` in
`live/net/room.js` if that happens.

