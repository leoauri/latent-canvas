# Two peers edit one session: shared state, local fields, undo, restore

`L(p)` stands for `__redaw.runtime.loader.get(p)`; `S` = `L('net/session.js')`, `St` = `L('app/stack/stack.js')`,
`M` = `L('app/timeline/layers.js')`, `Sh` = `L('net/shared.js')`, `H` = `L('net/history.js')`, `R` = `L('net/room.js')`.
Use fresh tab names (e.g. `P1`, `P2`) so profiles start empty. Allow ~1 s for changes to reach the other tab (use `wait`).

1. `P1 goto`; wait (20 s) for `S.status.value === 'ready'`; read `location.hash`.
2. `P2 goto '<hash>'`; wait (20 s) for `S.status.value === 'ready'`; wait (20 s) for `R.openPeers().length === 1` in both.
3. Both tabs: `St.stack.value.map(l => l.id)` must be identical (one layer).
4. P1: `Sh.act('rename', () => St.stack.value = St.stack.value.map(l => ({ ...l, name: 'From P1' })))`.
   P2: `Sh.act('hue', () => St.stack.value = St.stack.value.map(l => ({ ...l, hue: 42, inputDevice: 'mic-P2' })))`.
   Then in both, wait until the layer has `name === 'From P1'` and `hue === 42`. `inputDevice` must be `'mic-P2'` in P2 and absent in P1 (it's per machine).
5. P1: `M.addMaskArea(St.stack.value[0].id, { t: 1, dur: 2, y: 0, h: 50 })`. P2: wait until `M.layers.value.length === 1` and `M.masked.value[<that layer id>] === true`.
6. P1: `H.list().map(e => e.label)` contains `'rename'`. P1: `H.undo(H.list().find(e => e.label === 'rename').id).skipped` is `[]`; both tabs: wait until name is `'Latent recording'` and hue is still `42` (only P1's own change was reverted).
7. P2: `H.undoLast()` (reverts P2's 'hue'); both: wait until `hue` is undefined/null.
8. P1: `H.undoLast()` (reverts the mask); both: wait until `M.layers.value.length === 0`. Then P1: `H.restore(H.list().find(e => e.label.startsWith('edit masks')).id, { key: 'timeline.layers' })`; both: wait until `M.layers.value.length === 1`.
9. `P2 reload`; wait for `S.status.value === 'ready'`; `St.stack.value[0].inputDevice === 'mic-P2'` and `M.layers.value.length === 1`.
10. P1: `await S.create({ name: 'Second' })`; then `M.layers.value.length === 0` and `St.stack.value.length === 1`; `S.sessions.value.length === 2`. P2 is unaffected (still 1 mask). P1: `await S.open(S.sessions.value[1].doc)`; wait until `M.layers.value.length === 1` and `R.openPeers().length === 1`.
11. P1: click `button[title^=Session]` (the session pill; the Assets and Changes pills share `.net-pill`), then `text` (whole page) must contain `Invite link` and the session name. `screenshot`.
12. Both tabs' `console`: no `[pageerror]` / `[error]` lines.

## Clips (shared with vectors in the blob store)

13. In P1 add a clip: `() => { const d = new Float32Array(64*200); for (let i=0;i<d.length;i++) d[i]=Math.sin(i); __redaw.runtime.loader.get('app/timeline/clips.js').addClip({ id: 'c1', t: 1, y: 20, rate: 20, dim: 64, length: 200, data: d }) }`.
    In P2 wait until clip c1 exists with `data.length === 12800` and `data[5]` equal to P1's `Math.fround(Math.sin(5))`.
14. In P2 move it inside an action: `L('net/shared.js').act('move clip', () => L('app/timeline/clips.js').updateClip('c1', { t: 4 }))`. P1 sees `t === 4`.
15. The document holds `dataHash` (sha256-…) for c1 and no vector data: check
    `JSON.stringify(L('net/session.js').handle.value.doc().state['timeline.clips']).length < 2000`.
16. Reload P2; c1 is back with its data (from P2's own blob store).
17. In P1 remove c1 (`removeClip` or whatever clips.js exports for that); P2 no longer has it.

## Presence (cursors, playheads, selection)

18. P1: `L('net/changes.js').myName.value = 'Alice'`. P2: wait until
    `Object.values(L('net/presence.js').others.value)[0]?.name === 'Alice'`.
19. P1: `document.querySelector('.timeline').dispatchEvent(new PointerEvent('pointermove', { clientX: 400, clientY: 300, bubbles: true }))`.
    P2: wait until `.presence-cursor` is displayed with transform `translate(400px, 300px)` (same view
    in both tabs) and text `Alice`.
20. P1: add a clip, select it (`selectedId.value = id`), `seek(0.5)` and `play()` (Playhead.jsx). After
    ~2 s, P2's `.presence-playhead` transform x ≈ `timeToX(P1's time)` (within ~30 px) and a
    `.presence-selection` exists. P1: `stop()`.
21. P2: `L('net/presence.js').show.value = false` → no `.presence-cursor`/`.presence-playhead` elements.
