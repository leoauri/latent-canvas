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
- blobs: `live/net/blobs.js` on the `blob` channel (WANT/HAVE, verified manifest, chunks checked
  against it); what the document refers to by hash, e.g. a clip's latents (`dataHash`: little-endian
  float32, frame-major) or a model layer's files, is fetched on request, kept in memory and served
  to peers that ask

Built with Rust: [`webrtc`](https://crates.io/crates/webrtc) 0.21 and
[`automerge`](https://crates.io/crates/automerge) 0.12.

## Layout

```
src/peer.rs       the peer: room (signaling, WebRTC), automerge-repo sync and blob transfers, in one actor task
src/blobs.rs      blob ids, manifests and the blob channel's messages
src/doc.rs        JSON paths into the document ("state/timeline.layers/order/0")
src/crypto.rs     signaling topic and encryption (tested against the page's WebCrypto output)
src/signaling.rs  y-webrtc-style signaling client
src/link.rs       invite links
src/model.rs      operator layers' streaming models (decoders and encoders) on tract, on worker threads
src/ffi.rs        C API, see include/redaw_peer.h
src/main.rs       redaw-peer-cli
squeak/           Squeak FFI wrapper (RedawPeerLibrary, RedawPeer)
```

## Build

```sh
cargo build --release   # target/release/redaw_peer.dll (.so/.dylib) and redaw-peer-cli
cargo test --lib
# encode a tone and decode it back with a session's models (files fetched with `blob … -o`)
REDAW_MODELS=path/to/models cargo test --release --test roundtrip -- --ignored --nocapture
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
redaw-peer-cli "<invite link>" blob sha256-… -o file          # a blob, e.g. a clip's dataHash
redaw-peer-cli "<invite link>" clips                          # every clip with its latent frames
redaw-peer-cli "<invite link>" clips --summary                # … per-dimension min / max / mean
redaw-peer-cli "<invite link>" encode voice.wav --t 4         # encoded by the encoder layer, added as a clip
```

`encode` serves the clip's latents for `--linger` seconds (15) afterwards, so the browsers can
fetch them.

`RUST_LOG=info` shows the room's connection steps.

## Squeak

Load in the repo with Git/s (needs the FFI and JSON packages), then:

```smalltalk
RedawPeerLibrary modulePath: 'C:\...\squeakxrlib\target\release\redaw_peer.dll'.
peer := RedawPeer link: '<invite link>' name: 'Squeak'.
peer waitSynced: 10000.
peer at: 'meta/name'.
peer at: 'state/some.key' put: (Dictionary new at: 'a' put: 1; yourself).
peer whenChangedDo: [Transcript showln: (peer jsonAt: 'state/timeline.clips')].
peer close.
```

Latents and other blobs: `peer fetchBlob: hash` starts a fetch, `peer blobStatus: hash` tells how
far it is, `peer blobAt: hash` answers the bytes once they are here, and
`peer latentsAt: clip dataHash dim: 4` answers an Array of FloatArrays (one per frame).

A live view for inspecting, kept up to date while the browsers change the session:

```smalltalk
session := RedawSession link: '<invite link>'.
session inspect.                       "document, layers, clips: update in place"
session clips first frames.            "RedawClip: an Array of FloatArrays"
(session clips first) dimension: 1.    "one latent dimension over time"
session close.
```

Audio models run in the library too, on the session's own operator layers (`RedawDecoder` and
`RedawEncoder`, both `RedawModel`s):

```smalltalk
"encode a sound with the session's encoder layer and add it to the timeline at 4s"
session addClipFromSound: (SampledSound fromWaveFileNamed: 'voice.wav') t: 4.
"or by hand"
encoder := RedawEncoder forLayer: session encoderLayer peer: session peer.
latents := encoder latentsOfSound: aSound.   "ByteArray: float32, frame-major, encoder channels wide"
session peer addClipLatents: latents dim: encoder channels rate: encoder frameRate t: 4 y: 200.
```

A clip's latents are served from the Squeak peer's memory: keep the session open until the
browsers have fetched them.

Nothing calls back into the VM from network threads: Squeak polls (`version`, `whenChangedDo:`).
After an image restart a `RedawPeer` rejoins the room on its next use.
