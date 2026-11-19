# squeakxrlib

A native peer for redaw sessions, so that Squeak (and other native programs) can join a session
like a browser tab does: it joins the room from an invite link and keeps the session's Automerge
document in sync.

It speaks the same protocols as the page:

- signaling: `live/net/signaling.js` and `room.js` (topic hash, HKDF + AES-GCM sealed messages)
- WebRTC mesh: negotiated data channels `mesh`/`sync`/`blob`, 8-byte fragment header (`room.js`)
- documents: automerge-repo messages in the CBOR `hello`/`msg` envelope of `live/net/docs.js`
- presence: a name in `presence`, and answers to `presence-ping`
- writes follow `shared.js`: strings under 256 UTF-16 units become collaborative text, longer
  ones plain strings; integers become `int`, other numbers `f64`

Built with Rust: [`webrtc`](https://crates.io/crates/webrtc) 0.21 and
[`automerge`](https://crates.io/crates/automerge) 0.12.

## Layout

```
src/peer.rs       the peer: room (signaling, WebRTC) and automerge-repo sync, in one actor task
src/doc.rs        JSON paths into the document ("state/timeline.layers/order/0")
src/crypto.rs     signaling topic and encryption (tested against the page's WebCrypto output)
src/signaling.rs  y-webrtc-style signaling client
src/link.rs       invite links
src/ffi.rs        C API, see include/redaw_peer.h
src/main.rs       redaw-peer-cli
squeak/           Squeak FFI wrapper (RedawPeerLibrary, RedawPeer)
```

## Build

```sh
cargo build --release   # target/release/redaw_peer.dll (.so/.dylib) and redaw-peer-cli
cargo test --lib
```

On Windows ARM64 the `ring` crate needs `clang` on the PATH.

## CLI

```sh
redaw-peer-cli "<invite link>" status
redaw-peer-cli "<invite link>" get meta/name
redaw-peer-cli "<invite link>" watch state/timeline.clips
redaw-peer-cli "<invite link>" put state/some.key '{"a":1}'   # or "-" to read stdin, "@file"
redaw-peer-cli "<invite link>" delete state/some.key
redaw-peer-cli "<invite link>" save session.automerge
```

`RUST_LOG=info` shows the room's connection steps.

## Squeak

File in `squeak/RedawPeer.st` (needs the FFI and JSON packages), then:

```smalltalk
RedawPeerLibrary modulePath: 'C:\...\squeakxrlib\target\release\redaw_peer.dll'.
peer := RedawPeer link: '<invite link>' name: 'Squeak'.
peer waitSynced: 10000.
peer at: 'meta/name'.
peer at: 'state/some.key' put: (Dictionary new at: 'a' put: 1; yourself).
peer whenChangedDo: [Transcript showln: (peer jsonAt: 'state/timeline.clips')].
peer close.
```

Nothing calls back into the VM from network threads: Squeak polls (`version`, `whenChangedDo:`).
After an image restart a `RedawPeer` rejoins the room on its next use.
