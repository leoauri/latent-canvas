# Redaw in SqueakXR

latent-canvas-xr shows a live redaw session in SqueakXR: the canvas of clips in latent space, the
layer stack, notes and tour, with sound decoded natively and takes recorded into the session. The
basics of SqueakXR it builds on are in [squeakxr-architecture.md](squeakxr-architecture.md).

## 1. From the session to the image

```
redaw page (browser) ── Automerge doc over WebRTC ──┐
                                                    │  signalling wss://, TLS (rustls)
redaw_peer.dll (squeakxrlib, Rust) ─────────────────┘  peer named "Squeak"
   │  C ABI, polled: document, blobs (latents, ONNX models), encoder/decoder jobs
RedawPeerLibrary / RedawPeer (FFI)
RedawSession     merges the document in its own process, below the world's priority;
                 #updated is stamped after a merge, so readers never see half of one
RedawClip        t, y, rate, dim, length, dataHash, frames (Float32Arrays, kept in the image)
SRRedawSessionView and its features (Redaw-XR)
```

The document is read, never written, except for recorded takes. Live data belongs to other people:
every feature reads under `on: Error do:` and keeps what failed in `lastError`.

## 2. The session view and its features

`SRRedawSessionView` maps page coordinates onto a plane: time along `+x` at the page's default
zoom (`pixelsPerSecond` 100), the page's y down along `-y`, `metersPerPixel` 2 mm. `localPointFor:`
and `pagePointFor:` convert; `pagePointAt:y:` turns seconds into page pixels. Clips are
`clipHeight` (10 px) tall, the canvas grows to cover every feature's `pageBounds` plus a margin.

Each part is an `SRRedawFeature`, switched on and off on its own (`enable:`, `disable:`,
`toggle:`, the canvas menu's *Show >*):

| Feature | Draws / does |
|---|---|
| `SRRedawClipsFeature` | a dark plate per clip and a column per latent frame on it (section 4) |
| `SRRedawNotesFeature` | the example tour (yellow pins) and chat notes, as text above the canvas |
| `SRRedawStackFeature` | the layer stack as translucent sheets, the output waveform, flow lines, the crosscut (section 5) |
| `SRRedawPlayheadFeature` | the white cursor, the cue, the red input dot; a slab over the canvas that places the cue where you point |
| `SRRedawAudioFeature` | renders clips through the ported layer functions and the decoder, plays them through OpenAL |
| `SRRedawRecordFeature` | arms the latent layer, records takes, encodes them and adds them as clips |
| `SRRedawLayersFeature` | a pane: one slab per layer, its parameters and function source |
| `SRRedawCodeChangesFeature` | a pane: the code changes shared through the document, in a Morphic browser |

The first six draw on the canvas and live in the view's **canvas space**, shown by portals; the
two panes are the view's children in the world. See [canvas-portals.md](canvas-portals.md).

The cycle, every frame in `SRRedawSessionView>>step:`:

1. `refresh` each feature. The default compares `session updated` with what it saw and, if
   newer, sends `update`, which reads the document and answers whether its content changed.
   Features that animate (playhead, crosscut, audio) do their per-frame work here too.
2. If anything changed, the page bounds are recomputed. If they moved, every feature is laid out
   again, otherwise only the changed ones: `relayout` = `clear` (drop the children) + `layout`.

`canvasLift` raises the canvas so the layers behind the latent layer (input, encoder) fit below
it; `fitLift` applies it relative to where the user carried the canvas.

## 3. Controls

- **World menu** *Apps > Redaw*: open the session of the preference *Redaw invite link* (kept to
  `doc`, `room`, `signal`), bring it here, controls, other link, close.
- **The canvas menu** (menu button on the canvas, a map or a pane): Play/Stop, arm recording,
  next tour stop, controls, latent view, lay the canvas here, *Canvas on the floor*, *New map*,
  *Close all maps*, *Flatten / Spread the layers*, *Show >*, close.
- **The remote** `SRRedawTransport`: a panel to carry, with the time and Play, Tour >, Canvas,
  Rec, Latents, New map.
- **The maps** `SRRedawCanvasWindow`: Play, Rec, zoom, Fit, Follow, pan, Floor, New map, Close;
  trigger drag pans, the wheel and stick zoom, corner handles resize. See
  [canvas-portals.md](canvas-portals.md).
- **The latent view** `SRRedawLatentPanel`: the buttons of `SRRedawLatentStyle` (colour, height,
  where the dimensions go, count, order, grid, gain, gap).
- **The crosscut** on the canvas: per-layer on/off, Flatten, Play, Rec, All on (section 5).

Buttons are `SRActionSign`s with `cursorMode: pass`; their owner finds the one under the hit point
(`redawContains:`) and presses it (`redawPress`). Actions that change the tree are posted with
`addDeferredFrameMessage:`.

## 4. Latent columns

Each latent frame (128 values, 75 per second) is a column. `SRRedawLatentStrip` holds a static
mesh (a box per frame, 20 vertices, up to 3000 frames per strip for 16-bit indices) and an R32F
texture, one row per frame: the 128 values, length, movement and the page's RGB. Strips are cached
per `{dataHash. rate. depth}`.

One `SRRedawLatentField` draws all strips with the `redawLatent` shader. The vertex shader raises
each column by the chosen height (length, movement, one dimension), the fragment shader colours
cells by the chosen mode; all of it comes from uniforms set by `SRRedawLatentStyle>>applyTo:stats:`,
so switching a mode rebuilds nothing. `SRRedawLatentStats` holds the session's scales and the
dimensions ranked by variance.

## 5. Layer sheets and the crosscut

`SRRedawStackFeature` gives every layer of the stack a translucent sheet, 15 cm apart in data-flow
order: the latent layer is the canvas, the layers behind it lie below. Masked layers show their
mask rectangles; the output sheet shows each clip's envelope. Flow lines rise from each clip with
a node on each layer that operates on it (as `operatesAt()` in the page's `layers.js`).

The **crosscut** is a plane that moves with the playhead through all sheets. Where it meets a sheet
it shows the layer's colour (only inside masks this moment passes through), the signal of the clips
under the playhead glows on its way to the output, and on the near edge it labels every layer with
its name and what it does. Its controls:

| Control | Effect |
|---|---|
| `on` / `off` beside each label | draws that layer or not: its sheet, masks, rim, flow and glow nodes. The latent layer's switch hides the clips' columns, the output's the waveform, *tour* and *notes* the notes. |
| **Flatten** / **Spread** | sheets 4 mm apart instead of 15 cm: one plane, order kept. The labels stack in rows above the canvas, the canvas is lowered. |
| **Play** / **Stop**, **Rec** | as on the remote; the labels follow the state |
| **All on** | every layer drawn again |

What is shown is per machine, like the page's own view settings, and is not written to the document.
