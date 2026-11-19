# Two peers meet in a session's room and exchange a message

`L(p)` below stands for `__redaw.runtime.loader.get(p)`; `R` for `L('net/room.js')`, `S` for `L('net/session.js')`.

1. `A goto`. In A, wait (20 s) until `S.status.value === 'ready'`, then `return location.hash` — it must contain `doc=automerge:`, `room=` and `signal=`.
2. `B goto '<that fragment>'`. In B, wait (20 s) until `S.status.value === 'ready'`.
3. In A and in B, wait (20 s) until `Object.values(R.peers.value).map(p => p.state)` is exactly `["open"]`.
4. In B: `window.__got = []; R.onMessage((from, m) => window.__got.push(m)); return true`.
5. In A: `R.broadcast({ hello: 'from A' })`.
6. In B, wait (5 s) until `window.__got` contains `{ hello: 'from A' }`.
7. Binary fragmentation: in B, `window.__bin = null; R.on('blob', (from, b) => (window.__bin = b.length)); return true`. In A: `const id = R.openPeers()[0]; R.send(id, 'blob', new Uint8Array(300000).fill(7)); return id`. In B, wait (5 s) until `window.__bin === 300000`.
8. In A: `R.leave()`. In B, wait (15 s) until `Object.keys(R.peers.value).length === 0`.
9. Both tabs' `console` show no `[pageerror]` and no `[error]` lines.
