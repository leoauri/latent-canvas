# Blobs move between peers: round trip, a 200 MB file, resume after reload, a corrupted chunk

`S` below stands for `__redaw.runtime.loader.get('net/blobs.js')`, `R` for
`__redaw.runtime.loader.get('net/room.js')`. Write them out in full in each `eval`/`wait` (each
eval is its own function). JOIN means, in that tab:
`() => { const R = __redaw.runtime.loader.get('net/room.js'); R.join({ room: 'blobtest-0123456789abcdef', signal: R.defaultSignalURL() }); return true }`.
OPEN means: wait (20 s) until `Object.values(R.peers.value).some(p => p.state === 'open')`.
Use fresh tab names (e.g. A1, B1, C1 if A/B/C were used before) so storage starts empty; below they
are A, B, C. Long evals: the rig's eval waits for the returned promise.

1. `A goto`, `B goto`. In each, wait (20 s) until `S` is truthy, then JOIN, then OPEN.
2. Round trip. In A:
   `async () => { window.__h = await S.put(new TextEncoder().encode('hello blobs'), { name: 'hello.txt', type: 'text/plain' }); return window.__h }`
   — must be `sha256-9c62a72e8f647f9cdbf0d02ad36d1cb09a0c8ccb12eac704624e38d5bd3dd157` (the hash is
   defined by content only). In B: `async () => { const f = await S.ensure('<that hash>'); return [await f.text(), f.name, S.has('<that hash>')] }`
   — must be `["hello blobs", "hello.txt", true]`.
3. 200 MB. In A, build and store a random file:
   `async () => { const parts = []; for (let i = 0; i < 200; i++) { const b = new Uint8Array(1 << 20); for (let o = 0; o < b.length; o += 65536) crypto.getRandomValues(b.subarray(o, o + 65536)); parts.push(b); } parts.push(new Uint8Array(12345)); window.__big = await S.put(new Blob(parts), { name: 'big.bin' }); return window.__big }`
   In B: `async () => { const t0 = performance.now(); const f = await S.ensure('<big hash>'); return { ms: Math.round(performance.now() - t0), size: f.size, ok: (await S.hashOf(f)) === '<big hash>' } }`
   — `size` must be 209727545 and `ok` true. Report `ms` (seen: ~5–6 s on localhost).
4. Resume after reload. In A, store another file like step 3 but without the extra 12345-byte part
   and with name `resume.bin` (save as `window.__r`). In B: `() => { S.ensure('<r hash>'); return true }`.
   The transfer is fast (~5 s), so interrupt it from inside the page: in B,
   `() => new Promise((res) => { const iv = setInterval(() => { if ((S.index.value['<r hash>']?.have ?? 0) >= 60) { clearInterval(iv); location.reload(); res(true); } }, 5); })`
   (the eval may report an error because the page navigated; that's fine). Then wait
   until `S` is truthy, and in B: `async () => { await S.ready(); return S.index.value['<r hash>'] }`
   — `have` must be > 0 and < 200 (`complete: false`). JOIN and OPEN in B, then:
   `async () => { const before = S.index.value['<r hash>'].have; const r0 = S.stats.received; const f = await S.ensure('<r hash>'); return { before, received: S.stats.received - r0, size: f.size, ok: (await S.hashOf(f)) === '<r hash>' } }`
   — `ok` true, size 209715200, and `received` must be about `(200 - before) * 1048576` (not the
   whole file).
5. Corrupted chunk. In A, store a 20 MB random file (`new Uint8Array(20 << 20)` filled as above,
   name `corrupt.bin`, save as `window.__c`) and make A's next two chunk responses corrupt:
   `() => { window.__bad = 2; const orig = RTCDataChannel.prototype.send; RTCDataChannel.prototype.send = function (d) { if (window.__bad > 0 && d instanceof Uint8Array && d.length > 1000 && d[8] === 6 && d[4] === 0 && d[5] === 0) { window.__bad--; d = d.slice(); d[d.length - 1] ^= 0xff; } return orig.call(this, d); }; return true }`
   In B: `async () => { const rj = S.stats.rejected; const f = await S.ensure('<c hash>'); return { rejected: S.stats.rejected - rj, size: f.size, ok: (await S.hashOf(f)) === '<c hash>' } }`
   — `rejected` 2, size 20971520, `ok` true. `B console` must show two warnings
   `blobs: chunk … failed verification`.
6. Two sources. `C goto`, wait for `S`, JOIN, and wait (20 s) until C has 2 open peers. In C:
   `async () => { let peers = 0; const iv = setInterval(() => peers = Math.max(peers, S.transfers.value['<big hash>']?.peers.length ?? 0), 100); const f = await S.ensure('<big hash>'); clearInterval(iv); return { peers, size: f.size } }`
   — `peers` must be 2 (fetched from A and B at once), size 209727545.
7. Peers leave mid-transfer. In C: `() => { window.__r = null; S.ensure('<r hash>').then(async f => window.__r = { size: f.size, ok: (await S.hashOf(f)) === '<r hash>' }); return true }`;
   the transfer is fast, so cut it off from inside the page: in C,
   `() => new Promise((res) => { const iv = setInterval(() => { if ((S.index.value['<r hash>']?.have ?? 0) >= 50) { clearInterval(iv); R.leave(); res(S.index.value['<r hash>'].have); } }, 5); })`
   — returns a count < 200. In C wait (20 s) until `S.transfers.value['<r hash>']?.state === 'waiting'`
   and check `window.__r` is still null. JOIN in C; wait (60 s) until `window.__r` — `{ size: 209715200, ok: true }`.
8. In C: `async () => { await S.remove('<r hash>'); return [S.has('<r hash>'), '<r hash>' in S.index.value, await S.get('<r hash>')] }`
   — `[false, false, null]`.
