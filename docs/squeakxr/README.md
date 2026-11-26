# latent-canvas in SqueakXR

How the redaw canvas runs inside SqueakXR, a Squeak/Smalltalk framework for 3D and XR. The
code lives in a running Squeak image; `squeak/Redaw` in this repository is its file-out (package
`Redaw`, written with Git-S).

| Document | What it covers |
|---|---|
| [squeakxr-architecture.md](squeakxr-architecture.md) | SqueakXR itself: world process and frame, objects and transforms, rendering through Raylib, shaders, input, collision, menus. Read this first. |
| [redaw-xr.md](redaw-xr.md) | Redaw on top of it: the peer and session, the session view and its features, audio, recording, the latent columns, the layer sheets and the crosscut. |
| [canvas-portals.md](canvas-portals.md) | The canvas space and its portals: one canvas shown on the floor, in a zoomable window cut to a plate, or both. Clipping, input through a portal, the crosscut's controls. |

Day-by-day history, with screenshots and measurements, is in the journal of the `squeak`
repository (`journal/2026-11-23b` and later, "latent-canvas-xr" and "redaw").

## Where things are

| Package category | Contents |
|---|---|
| `Redaw-Peer` | `RedawPeer`, `RedawPeerLibrary` (FFI to `redaw_peer.dll`), `RedawSession`, `RedawClip` |
| `Redaw-Audio` | `RedawDecoder`, `RedawEncoder` (ONNX models run natively), `RedawLatentChain` and the ports of the session's JavaScript layer functions |
| `Redaw-XR` | everything drawn: `SRRedawSessionView`, the features, portals, window, panels, shaders |
| `Redaw-Tests` | `SRRedawCanvasPortalTest`, `SRRedawCanvasWindowTest` |

The native side (`squeakxrlib`, Rust) builds `redaw_peer.dll`: the Automerge/WebRTC peer, the
blob fetches and the encoder/decoder models, all behind a C ABI polled from Squeak.
