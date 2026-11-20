# redaw

A page that is live-programmed from inside itself: an in-page LLM agent (any OpenAI-compatible API) edits the
page's own modules through a chat panel, and the chat is one of those modules.

```sh
npm install
cp .env.example .env   # set OPENAI_API_KEY (only the dev proxy reads it), optionally OPENAI_BASE_URL / OPENAI_MODEL
npm run dev
```

Without a key in `.env`, the page calls the endpoint directly with a key from the chat
settings, stored in the browser (or none, for local servers like Ollama). The chat settings
can also override the endpoint per browser, which bypasses the dev proxy. That is also
how a static `npm run build` works.

## Inspecting the page's IndexedDB

The dev server relays read-only queries to an open tab (`src/db-bridge.js`), so agents and
scripts outside the browser can debug page state, e.g. page-chat transcripts with their tool calls:

```sh
H='x-redaw: 1'; DB=http://localhost:5173/__live/db
curl -sH "$H" $DB                                  # databases, stores, counts
curl -sH "$H" $DB/redaw/kv/chat.index              # chat sessions, newest first
curl -sH "$H" $DB/redaw/chats/<id>                 # one transcript (messages incl. tool_use/tool_result)
curl -sH "$H" "$DB/redaw/kv?values"                # every key and value in a store
```

Typed arrays come back as `{ $type, length, head }` unless you add `?full`. Use `?jkey=<json>` for
keys that are not strings. With several tabs open, the first one to answer wins.

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
  vfs.js        virtual file system: base (IndexedDB ↔ disk) + per-session layers + overlays + history
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
4. On success the change is committed to the open session's own code (its **layer**):
   - saved to IndexedDB, with the session (store `redaw-layers`, one record per session);
   - not written to `live/`: code adapted to one session doesn't leak into others;
   - recorded in the session's history, so `revert_applied` can undo it.
5. `live/` on disk is the **base**, the code every session starts from. Edits there (your editor, an
   agent outside the browser, git) are pushed to the page by the watcher and applied without
   rollback. If the open session has its own version of the file, the edit is three-way merged
   under it; on conflict the session's version keeps running and a warning is logged.
6. Opening another session swaps its layer in; a new or joined session starts from the base. To
   move a feature from a session into the base, have an agent read the layer
   (`curl -sH 'x-redaw: 1' localhost:5173/__live/db/redaw-layers/layers/<doc url>`) and write it to
   `live/`, then commit with a trailer `Promotes-session: <doc url>` so the commit hook quotes the
   in-app prompts behind it (page-chat turns are logged with their session and wait until then).
   Peers get a session's code only as published changes.
7. At boot, IndexedDB and disk are reconciled per file for the base: the newer mtime wins, and deletions are tracked as tombstones.

## Conventions for live modules

- Preact with JSX, using the automatic runtime. Use `@preact/signals` for shared state.
- Import live modules by relative path, and bundled packages by name. To add a package, `npm i` it and add it to `src/vendor.js`.
- Re-evaluation resets component state. Keep state that should survive in `persist(key, init)` from `@live/runtime`.
- Export `dispose()` to clean up timers and listeners when a module is replaced.
- Importing a `.css` file injects it, and the style is swapped with the module.
- Floating windows (draggable, resizable, collapsible, persisted) are shared: register a kind with `registerWindowKind(kind, { render })` from `live/ui/FloatingWindow.jsx` at import time, export the returned function as (or call it from) `dispose()`, and open windows with `openWindow(kind, props)` from `live/ui/windows.js`. See the comment at the top of `windows.js`.
- To point users at something new, use the guide library in `live/ui/guide/guide.js`
  (`showGuide`, `checkGuide`; the comment at its top describes steps and navigation). Mark
  view-only controls (tabs, disclosures) `data-inert` so a guide may click them to navigate.
- State that everyone in a session should see goes through `shared(key, signal, opts)` from `live/net/shared.js` instead of `db.sync`; name user-level changes with `act(label, fn)` so they show up as one undoable action. See Multiplayer.

## Multiplayer

A **session** is one [Automerge](https://automerge.org) document plus a room of peers editing it. The
session pill (bottom right) opens the Session window: rename it, copy the invite link, see who's
connected, undo recent actions, switch between sessions or join one from a link.

- **Invite link**: `…/#doc=automerge:<id>&room=<secret>&signal=<ws(s) URL>`. The room secret is the
  only credential: whoever has the link can join and edit, so share it like a password. It never
  reaches an HTTP server (it's in the fragment). The link names its signaling server, so everyone
  meets on the same one. It points at this page unless `REDAW_PUBLIC_URL` names another instance
  (e.g. a public static build) for people to open it on.
- **Transport** (`net/room.js`): a full WebRTC mesh (meant for up to ~20 trusted peers). The
  signaling server only relays connection setup between peers who know the room's topic (a hash of
  the secret), and that traffic is encrypted with a key derived from the secret. After that, data
  goes peer to peer.
- **What's shared** is decided per signal by the code that owns it (`net/shared.js`): today masks and
  the layer stack. Per-machine fields (an input device) stay local, and everything else (selection,
  windows, chats, your code) is local unless a module shares it. Since everyone may run different
  code, writes are per entity and field, and fields that your code doesn't know about are kept.
  A module that starts sharing a new key just writes it; peers without that code ignore it.
  Entities that fail the owning module's `valid` check (a buggy or newer peer's values) are skipped
  on read, not rendered, so they can't crash your page.
- **Code changes** (`net/changes.js`, the Changes pill): what an agent commits waits in its chat as
  "Ready". You can keep asking for changes, which join it. **Approve & publish** hides its
  onboarding guide and publishes everything as one change. The agent marks a follow-up to an
  earlier change with that change's id (`follows`). A bubble over the pill announces new changes.
  Each change shows what it follows or builds on and who has incorporated it.
  The Changes window lists only these named bundles, each with its guide: the ones waiting for
  approval, your own (`net/bundles.js`) and your peers'. There is no manual publishing. Your
  bundles remember on this machine whether you publish them. A published bundle lives in the
  session document like tracks, so every peer has it, including peers who join later. **Unpublish**
  removes it from the session; peers who applied it keep it. **Publish again** restores it under
  the same id.
- **Onboarding guides** (`ui/guide/`): when an agent finishes a feature it attaches a small "this is
  new" guide: arrows with a few words, pointing at what it built. The guide shows when the agent's
  turn ends and travels with the published change, so peers who preview it see it too.
- **Previews**: while code runs on trial (not committed; session edits stay local), a frame around
  the screen names it, with Revert and Apply. It turns violet while an agent is still working on
  its preview, so nobody edits underneath it. One preview runs at a time; others asked for
  meanwhile queue up (`net/trials.js`), are listed in the frame, and start in turn.
- **Presence** (`net/presence.js`): others' cursors (interpolated) and selected clips
  show on the timeline in their colour, with their name. It's never stored. Toggle it in the Session
  window or with Alt+P. Other modules share more with `presence.publish(key, signal)`.
- **History** (`net/history.js`): every change you make is an action in your local history. Undo
  reverts an action wherever nobody has changed the value since. Restore sets one entity, one key or
  everything back to how it was after any action. Both write a new change; nobody's history is
  rewound.
- **Files** (`net/blobs.js`): large data (models, clip vectors) is stored by content hash in the
  browser's private file system (OPFS) and fetched from peers that have it, in chunks that are
  verified and resumable.

`e2e/stress.mjs` runs many peers through edit storms, races, partitions, reloads, concurrent code
changes and malformed writes. `e2e/stress/README.md` lists what each phase tries to break.

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

