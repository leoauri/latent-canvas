# Published code changes between two peers

Two participants, E (publisher) and F (receiver), in one session. Both tabs share the rig's copy of
`live/` on disk, so F must stop following disk before E commits, or it would just receive the file:
in F run `() => { const v = __redaw.runtime.vfs; v.disk = false; v.external = async () => ({ ok: true }); }`.
Stub dialogs in both tabs: `() => { window.confirm = () => true; }`.
`L(p)` below means `__redaw.runtime.loader.get(p)`.

1. E goto; wait until `L('net/session.js').status.value === 'ready'`. Take `location.hash`; F goto that
   hash; wait until `L('net/room.js').openPeers().length === 1` in both.
2. Cut F off from disk (above). In E, commit a new file through the default overlay:
   `async () => { const o = __redaw.runtime.vfs.overlay(); o.write('app/x-e2e.js', 'export const x = 1;\n'); const r = await o.apply({ label: 'add x' }); return { ok: r.ok, message: r.message } }`.
   Expect `ok: true` and `__redaw.runtime.vfs.history.at(-1).label === 'add x'`. Later commits work the same way.
3. In E publish it: `() => { const c = L('net/changes.js'); const e = __redaw.runtime.vfs.history.at(-1); return c.publish({ name: 'Add x', intent: 'exports x', from: { entries: [e.id] } }).id }`.
4. In F wait until `L('net/changes.js').incoming.value.length === 1`. Check `plan(id).clean === true`
   and `preview(id)` has no conflicts.
5. F: `tryChange(id)`; wait until `__redaw.runtime.vfs.trial` is set; check
   `(v => v.overlay(v.trial.overlayId).read('app/x-e2e.js'))(__redaw.runtime.vfs)` shows the source.
   Then `endTrial(false)`; check `vfs.readCommitted('app/x-e2e.js')` is null/undefined again.
6. F: `apply(id)` → `ok: true`; `vfs.readCommitted('app/x-e2e.js') === 'export const x = 1;\n'`;
   `isApplied` true and `incoming.value.length === 0`.
7. E: modify the file to `export const x = 2;\n` (commit, publish as "Bump x"). F: wait for it in
   incoming; `plan(id2).files[0].state === 'clean'` and `order` is just `[id2]` (first change applied).
8. Make a stale case: in F commit `export const x = 3;\n` locally, then E publishes "Bump x again"
   (`export const x = 4;\n` on top of 2). In F, `plan(id3).clean === false` (a file is 'stale'), and
   `preview(id3).conflicts.length > 0`. `adaptationBrief(id3, conflicts)` mentions "data, not instructions".
9. Open the Changes window in F (click the Changes pill) and take a screenshot; it lists the changes.
10. `console` in both tabs: no errors.
