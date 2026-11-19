# Multiplayer stress test

`e2e/stress.mjs` drives N browser tabs (separate profiles, so separate peers) through one shared
session. It tries to produce the failures listed below, then checks whether the peers agree and
whether anything broke.

```sh
E2E_PORT=5680 node scripts/e2e.mjs up             # rig: scratch copy of live/, tabs, central log
E2E_PORT=5680 node e2e/stress.mjs --peers 6        # all phases except soak
E2E_PORT=5680 node e2e/stress.mjs --phases storm,race --scale 0.3
E2E_PORT=5680 node e2e/stress.mjs --phases soak --soak 10
E2E_PORT=5680 node scripts/e2e.mjs down
```

- The rig copies `live/` when it starts. Run `up` again after editing live code.
- Tabs boot with `__REDAW_NO_DISK__`, so their commits don't write into the scratch tree.
- Timings depend on the machine: arm the power watch first and discard runs taken under throttling.

## Observing a run

- **Central log**: `e2e/out/<run>/events.jsonl` gets one line per event: `{t, tab, kind, text}`.
  - It holds every tab's console, page errors with stacks, crashes, failed requests, loads and closes.
  - It also holds driver notes (`node scripts/e2e.mjs log '<text>'`).
  - Follow it live with `tail -f e2e/out/<run>/events.jsonl`.
- **Metrics**: every 2 s each tab logs a `[stress:metrics]` line with:
  - sync lag measured by probe stamps;
  - event-loop stalls, long tasks and heap;
  - document size, and save/load time on every 5th report;
  - peer count and invariant breaches.
- **Live inspection**:
  - `node scripts/e2e.mjs P3 eval '__stress.snapshot({bytes:true})'` returns digests, counts, invariants, peers and recovery state.
  - Use `P3 screenshot` to see the page.
- **Report**: `stress-report.json` / `.md` in the run dir lists, per phase:
  - convergence time;
  - problems (errors and warnings, minus known noise);
  - invariant breaches;
  - metrics and outcomes.

## In-page agent (`agent.js`)

The driver evaluates `agent.js` in each tab, which installs `window.__stress`:

| call | does |
| --- | --- |
| `chaos({rate, weights})` | Random user-level actions. Most of them hit a hot set of entities (the first 3, 60% of the time). See the list below. |
| `quiet()` / `stop()` | Stop writing (the probe keeps running) / stop everything. |
| `snapshot({bytes})` | Digests of the document heads, the document (minus probes) and the rendered view (local fields stripped). Also counts, presence, recovery and invariants. With bytes: save/load of the whole document. |
| `race({role, layerId, clipId})` | At the same moment, one peer removes a layer and its clip while the others edit them. |
| `poison(kind)` / `unpoison()` | Write a malformed value as a buggy or newer peer might, then put state and code back. |
| `partition(on)` | Leave the room, or rejoin it. |
| `codeChange({file, follows})` | An agent-style edit through the chat tools (create plus `apply_changes`). It is auto-published. |
| `incorporate()` | Apply every clean incoming change, and report why the others aren't clean. |

The chaos actions are:

- layer insert, remove, rename, hue, move and pass-through;
- mask add, cut and clear;
- clip add, remove, move, drag (25 writes/s) and bring-to-front;
- selection, cursor, undo and restore.

Each peer stamps `doc['stress:<name>'] = {n, at}` once a second. Each key is top-level so no map is
created concurrently. Every other peer measures how long the stamp took to arrive.

## Breaking points and the phase that targets each

| # | Breaking point | Phase | Seen? / status |
| --- | --- | --- | --- |
| 1 | Concurrent edits to one field or one list order diverge or flap between values | storm | converges |
| 2 | Removing an entity while someone else edits it resurrects it as a partial entity | race, storm | **yes**: undoing a field change after someone removed the entity brought back `{passThrough:false}`. Fixed: undo/restore no longer create an entity just to set one of its fields |
| 3 | Dependent data outlives its owner: masks of a layer removed while being masked | race, storm | **yes**. Now swept: the stack removes masks of layers that are gone from the document |
| 4 | Two peers create the same container (`d.x ??= {}`) at once: Automerge keeps one, and the other's contents are lost | storm, churn | **yes** (lost probe stamps, `code.changes`). Containers are now created with the document, and older documents are migrated on open |
| 5 | A rejoining or reloading peer re-seeds state that others already have, or its old state wins | churn | |
| 6 | A long partition produces a merge that is too big, or one side's work disappears | partition | |
| 7 | Sync throughput: write storms build up lag, stall the event loop, or grow memory | storm, soak | lag p95 and loop stalls rise with peers × rate |
| 8 | Document growth: history makes save/load and joining slow | soak | |
| 9 | Code changes published at the same time go stale or conflict. Follow-ups refer to changes not yet received | code | **yes**: most become stale under contention |
| 10 | Malformed values from a buggy or newer peer crash every page that renders them | poison | **yes**: crashed everyone. Now validated in `shared()` (bad entities are skipped and reported once). Malformed containers read as empty and are replaced on write |
| 11 | Undo or restore under concurrency reverts other people's work | storm (undo/restore actions) | |
| 12 | Long strings (code sources) stored as collaborative text cost one CRDT op per character: slow to write, load and sync, and the document grows | code, poison (`huge-string`) | **yes**: about 60× slower than an immutable string. A 2 MB name crashed two of six renderers under load. Now strings of 256+ chars and published sources are stored whole (`ImmutableString`) |
| 13 | A page's signal falls out of step with its document, and the view stays wrong until the next edit | every phase (view digests) | not found: the one divergence seen was the digest counting `undefined` keys. `shared()` now checks after each write and re-reads if they differ (`shared: drift` in the log) |

## Poison kinds

- **Bad entities**:
  - `layer-bad-type`, `layer-no-fields`, `layer-name-object`;
  - `item-null`, `mask-nan`;
  - `clip-bad-length`, `clip-missing-hash`;
  - `masked-string`.
- **Broken containers**: `order-unknown-id`, `state-key-array`.
- **Size and changes**:
  - `huge-string`;
  - `change-bad`, a malformed published change.

Each kind is written, judged on every page (recovery? errors? invariants?), then undone. Pages in
recovery are reloaded before the next kind.
