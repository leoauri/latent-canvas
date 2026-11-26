# One canvas, several views: canvas space and portals

The canvas of a large session is about 75 m long. On the floor it cannot be taken in from one
place, so the canvas can also be shown on **maps**: plates (80 × 50 cm to start) that can be panned,
zoomed and resized, and are carried like sand tables. The floor, any number of maps, or both show
the same canvas, and each map marks on the canvas where it looks.

## The idea

```
SRWorld
 ├─ SRRedawSessionView                 (isApp; its transform = where the floor canvas lies)
 │   ├─ SRRedawCanvasPortal            the floor: draws the canvas space at the view's place
 │   ├─ SRRedawLayersFeature           panes stay in the world
 │   └─ SRRedawCodeChangesFeature
 ├─ SRRedawCanvasWindow  "Map 1"       (isApp, wantsGrab; plate, rim, buttons, status)
 │   ├─ SRRedawCanvasPortal            clipper: the map; scale = zoom, offset = pan
 │   └─ SRRedawPlateResizer × 4        corner handles
 └─ SRRedawCanvasWindow  "Map 2"  ...

canvas space (an SRObject outside the world tree, owned by the view)
 ├─ plane                              the grey canvas
 ├─ SRRedawClipsFeature  ├─ SRRedawNotesFeature  ├─ SRRedawStackFeature (with the crosscut)
 ├─ SRRedawPlayheadFeature  ├─ SRRedawAudioFeature  ├─ SRRedawRecordFeature
 └─ "Map n region": SRRedawMapMarker + label, one per map
```

The canvas features draw into the **canvas space**, in the view's local coordinates (the canvas is
the XY plane, `+z` up from it). The canvas space is not in the world tree, so the frame neither
steps nor renders it, and the cursor does not see its geometry. **Portals** draw it and take input
for it. There is one copy of the canvas, one playhead, one audio feature, one set of layer switches:
whatever is changed in one view shows in the other.

This is SqueakXR's own pattern: `SRMiniView` draws a subtree again under another transform for the
halos. It works because every object draws with `withTransform: self globalTransform`, which
multiplies onto Raylib's matrix stack ([architecture, section 4](squeakxr-architecture.md#4-rendering)).

## SRRedawCanvasPortal

**Drawing** (`renderOn:`): walk the canvas space, collect the objects that render (`isRendering`),
draw each inside `aRenderer withTransform: self globalTransform do: [...]`. An object that fails is
marked `badRender` and skipped, as `SRFrame` would, and the error goes to the world's log.

**Input**: the portal's `collisionGeometry` is an `SRRedawPortalCollision`. Its `rayIntersection:`
maps the cursor's ray into canvas space (`inverseTransformation`), casts it among the canvas
objects (`SRRay>>castAll:`), takes the nearest hit (inside the plate, for a window) and answers it
mapped back into the world, with the portal as its object. The cursor's dot lands on the actual
canvas object.

The event the hand then sends has a point but no ray, so `dispatch:` casts once more, along the
whole line from the cursor's ray origin through that point (`canvasHitAt:from:`, `originOf:`), and
hands the event to the canvas object it hits, with the point in canvas space. From there it bubbles
as usual (`cursorMode`). The playhead's slab, its Play sign and the crosscut's buttons therefore
work unchanged in any portal: they compare canvas points with canvas geometry. The origin must be
the cursor's (`SRPointRayCursor>>redawRay`), not the hand's position: on the desktop they differ,
and a short re-cast starting near the point can begin inside thin geometry.

On a map's portal the trigger starts a drag instead (below); analog events (thumb stick, wheel) go
to the map.

Flying down onto the floor canvas still stops on it: the floor portal answers
`intersectsBoxCenter:halfExtents:` with the canvas slab. A window's portal answers false, since its
plate carries its own collision.

## SRRedawCanvasWindow: a map

- **Plate**: 80 × 50 cm to start (`size`, `extent:`), a dark slab with a light rim marking the edge
  that cuts. Grab it anywhere (squeeze), on the canvas too, to carry it.
- **Resizing**: a grab handle at each corner, as SqueakXR's panels have (`SRResizer`), shown while a
  hand aims a grab at it. `SRRedawPlateResizer` is a subclass: `SRResizer` measures a Morph in its
  panel's XY plane, the plate lies in the window's XZ plane. Dragging pins the opposite corner and
  sets the plate's extent (30 × 20 cm to 4 × 3 m); `keepCanvasWhile:` shifts `center` so the canvas
  stays where it lies while the plate grows over it. The scale stays: a larger plate shows more.
- **Many maps**: *New map* (canvas menu, remote, each map) opens another; each is numbered and
  coloured (`number`, `color`, its rim). `SRRedawSessionView>>windows` holds them; closing the last
  one puts the canvas back on the floor.
- **Region markers**: each map draws its region (`canvasRect`) as one rectangle in its colour
  (`SRRedawMapMarker`: a unit box scaled to the region, 6 % fill, outline), labelled
  `Map n  1:28`, into the canvas space (`attachMarker`). `layoutPortal` and `layoutPlate`, which
  every pan, zoom, drag and resize goes through, call `updateMarker`, so it moves in the same frame
  as the map. Being part of the canvas, the markers show on the floor and in every map: a zoomed-out
  map shows where the others look. Its centre is `origin + corner / 2`, not `Rectangle>>center`,
  which rounds to whole numbers (whole metres here).
- **Play** / **Stop** and **Rec** / **Armed** / **Stop rec** are the first two buttons. The buttons
  wrap into rows along the front edge as the width needs (`layoutPlate`).
- **Mapping** (`layoutPortal`): the portal lies the canvas down (`-90°` about x, so the page's top
  runs away from the front edge), scales it by `zoom` and shifts it so that canvas point `center`
  sits over the plate's middle, `canvasHeight` (3 cm) above it.
- **Fit** shows the whole canvas; **+** / **-** zoom by 1.5 about the middle; **<** / **>** pan by
  40 %; **Follow** keeps the playhead in the middle; **Floor** switches the floor canvas off and on;
  **New map** opens another; **Close** closes this map.
- **Trigger drag** pans in both directions: a press on the plate or its canvas starts a drag
  (`startDrag:`), and every frame (`followDrag`) the canvas point first under the hand's ray is
  kept under it (`keep:under:`, where the ray meets the canvas plane, `canvasPointOn:`). A press
  released before the point moved 1 cm on the plate is a click: it goes to the canvas object
  then (the cue, crosscut buttons), on release instead of press. The plate's buttons act on press.
  The ray is the cursor's own (`SRPointRayCursor>>redawRay`); on the desktop it starts about 60 cm
  below the eye, so a plate higher than that is hit from below, where drags work but clicks
  cannot reach the canvas. New windows open 80 cm below the eye.
- **Thumb stick** while pointing at it: sideways pans along time, forward/back zooms about the
  point aimed at. **Mouse wheel**: zoom in steps of 1.2 about that point. Zoom runs from half the
  fitting zoom to 8:1 (`maxZoom`): a latent frame, 2.7 mm on the floor, is 2 cm wide on the plate.
- **Status**: the scale and the time range on the plate. The scale (`scaleText`) keeps one decimal
  below 1:10 (`1:1.4`, `1:28`) and reads the other way round when a map magnifies (`1.5:1`).

`SRRedawSessionView` keeps the modes consistent: `toggleFloor` opens a map before the floor goes
off, and closing the last map (`closeWindow:`) puts the floor back on. The canvas menu offers
*Canvas on the floor*, *New map* and *Close all maps*; the remote has a *New map* button.

## Clipping: a plate, not a box

Only the plate's outline cuts. What stands on the canvas (latent columns, layer sheets up to
1.5 m × zoom, the crosscut, notes) rises above the plate freely, like things stacked on a table.
Mathematically the clip volume is a prism without lid or floor.

Two steps: the window decides what to draw at all, and a fragment test cuts what crosses the
plate's edge.

- **Choosing**: while a window's portal draws, `SRRedawCanvasPortal class>>active` answers it. The
  latent field asks it for each strip (`showsCanvasRectFrom:to:`, a strip's rectangle mapped onto
  the plate) and skips the strips that lie entirely off the plate.
- **Cutting**, per fragment, in world space:
  - **Raylib's batch** (cubes, box batches, 3D text, lines) is drawn with `redawClip` while the
    window's portal draws: Raylib's default shader plus one test. The batch's vertices are already
    in world space.
  - **The latent field** draws meshes through `DrawMesh`. In this Raylib the `matModel` uniform
    includes the matrix stack, so `fragPosition` in `redawLatent` is in world space too (a first
    version assumed canvas space and cut nothing). It reads the same rows from
    `SRRedawCanvasPortal class>>clip`, which are zero (clipping nothing) outside a clipping portal.

The test, in both shaders:

```glsl
vec4 p = vec4(fragPosition, 1.0);
vec3 q = vec3(dot(clip[0], p), dot(clip[1], p), dot(clip[2], p));
if (any(greaterThan(abs(q), vec3(0.5)))) discard;
```

`clip[0]` and `clip[2]` are the plate's x and depth rows divided by its size
(`SRRedawCanvasWindow>>clipRowsFor:`); `clip[1]`, height, is zero.

### Cutting the data instead

The domain-specific alternative is to choose the clips inside the window and shorten the ones at its
edges. Only the clips on the edges would need new meshes, and that could happen asynchronously,
after a pan or zoom has settled. The choosing half is done (above). The shortening half is left out
for now: the fragment test already cuts exactly, also during a pan, while a rebuilt edge would lag
behind it; and notes, mask rectangles, sheets, flow lines, the waveform and the crosscut would each
need their own rule. If the fragment test turns out costly on the Quest, edge meshes rebuilt after
the interaction are the way to go.

## Measurements (Windows desktop, Expericanvas session, 2026-11-25)

| Mode | Frame time |
|---|---|
| floor only | 15.3 ms |
| window only | 16.0 ms |
| both | 20.8 ms |

Mean of the middle 21 of 40 `Raylib getFrameTime` samples, before strips off the plate were skipped.
The canvas space holds 268 objects, 259 of which draw, most of them note text lines. Later, with
most layers switched off and strips skipped: both 13–16 ms, the window's portal hidden 14 ms. The
samples are noisy (one run while a screenshot was written gave 30.8 ms).

## Limits and next steps

- Things outside the canvas space are not in the maps: the panes, the remote, the latent panel.
- A plate above the desktop hand is hit from below: drags work, clicks cannot reach its canvas.
- The marker's outline is a 1-pixel line, thin from far away.
- Only latent strips are skipped when off the plate; notes and other objects are drawn and cut.
- The latent columns keep their floor height in metres times zoom: at the fitting zoom they are a
  few millimetres. A separate height exaggeration for the window would help.
- Not yet tried on the Quest: both shaders are transpiled to GLSL ES 300 and are in the cache.
