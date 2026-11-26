# SqueakXR architecture, as Redaw uses it

SqueakXR is a 3D and XR framework written in Squeak/Smalltalk. It draws through **Raylib**, talks
to headsets through **OpenXR** (rlOpenXR) and plays sound through **OpenAL**, all over FFI. The
same image runs on the Windows desktop (a flat window, or SteamVR), in WSL, and on a Quest
(Android, GLES 3).

Everything below was read from the running image (November 2026); class and selector names are
the real ones, so they can be looked up with the MCP tools (`get_source_code`, `list_methods`).

## 1. The image is the program

There is no source tree that the VM loads. Classes, compiled methods and live objects sit together
in the image; a method compiled through the MCP is part of the program at once. Packages are
written out to git with Git-S (`squeak/Redaw` here). Saving the image is a separate, archival step.

Consequences for working on Redaw:

- A change to a running object takes effect in the next frame. Instances survive class changes
  (`addInstVarName:` appends an instance variable and migrates every instance in place).
- A **modal dialog in the world process stops the frames it would be drawn in**. Anything that
  might prompt runs as `Project current addDeferredUIMessage: [...]` in the Morphic process.
- A **debugger in the world process freezes the world**. Code called every frame guards itself
  (`on: Error do:`) and keeps the error, as every Redaw feature does with `lastError`.

## 2. World, process and frame

`SRWorld` is the scene root and owns the loop. `SRWorld current` answers the running world.

```
SRWorld>>loop                       world process, priority 40 (Morphic and the MCP run at 30)
  doOneCycle
    runPendingBetweenFrameActions   blocks posted with addDeferredFrameMessage:
    SRFrame world:deltaTime:        initializeObjectLists: one walk over the tree collects
                                    the stepping, shining (lights) and rendering objects
    SRFrame>>process
      updateActions                 hands, cursors, input events (section 6)
      stepObjects                   step: deltaTime on each stepping object
      prepareFrame                  camera, beginDrawing / rlOpenXRBegin, beginMode3D
      renderObjects                 first pass; clearDepth; second pass
      completeFrame                 endDrawing / end of the XR frame
```

- The lists are built **once per frame, before stepping**. An object added during `step:` draws
  from the next frame on, one removed draws once more.
- **`addDeferredFrameMessage:` is the place for tree changes** that come from input or menus:
  those run inside the input traversal, which walks the very tree they would change.
- `SRFrame` catches errors per object: it marks the object `badStep` / `badRender` (skipped from
  then on) and opens a debugger. `continueRendering` / `continueStepping` re-enable it.
- An object steps if its class overrides `step:`, and renders if its class overrides
  `renderOn:`. Both are decided in `SRObject>>initialize`, so an instance made before such an
  override does not pick it up.
- `visible: false` hides only that object, not its children.

## 3. Objects and transforms

`SRObject` is the base of everything in a world: a tree (`addChild:`, `removeChild:`, `remove`,
`children`, `parent`, `world`), a transform, input handling and collision.

- **Transform**: local translation, rotation (`Quaternion`), scale (`Vector3`), composed into a
  `Matrix4x4` and kept lazily (`transformDirtyFlag`). `globalTransform` is the product along the
  parent chain. Setters exist on both sides (`translation:`, `globalTranslation:`,
  `globalRotation:`, `globalTransform:`).
- **Axes**: right-handed as Raylib and OpenXR are: `+x` right, `+y` up, **forward is `-z`**.
- **Units** are literals: `3cm`, `1.5m`, `4mm` answer metres.
- **Quaternion products** apply left first: `(Quaternion angle: -90 axis: Vector3 right) *
  (Quaternion angle: yaw axis: Vector3 up)` lays a plane down and then turns it about the vertical.
- **`Rectangle` and `Point` are made for pixels**: `Rectangle>>center` divides with `//` and answers
  whole numbers, which in metres means a metre at a time. Use `origin + corner / 2`.
- `Matrix4x4`: `localPointToGlobal:`, `globalPointToLocal:`, `localDirToGlobal:`,
  `inverseTransformation`, `composedWithLocal:` (`A composedWithLocal: B` = A·B), rows `a11`..`a34`
  with the translation in `a14 a24 a34`.
- `world` is found along the parent chain. An object outside any world (Redaw's canvas space, see
  [canvas-portals.md](canvas-portals.md)) answers `nil`, and neither steps nor renders by itself.

Primitives used by Redaw: `SRCube` (a box scaled to size, `drawWires:`, `ignoreCollision:`),
`SRTextField` (3D text, one line), `SRActionSign` (a labelled slab, a button), `SRMorphPanel`
(a Morphic morph on a textured quad), `SRMeshObject`.

## 4. Rendering

`SRRenderer` → `SRRaylibRenderer` → `SRRaylibRendererFlat` (desktop window),
`SRRaylibRendererXR` (headset), `SRRaylibRendererXRWithDesktopUser`.

Each object draws itself in `renderOn: aRenderer`, with **its own global transform**:

```smalltalk
SRRenderer>>withTransform: aMatrix4x4 do: aBlock
	Raylib rlPushMatrix; rlMultMatrixfMatf: aMatrix4x4 transposed.
	aBlock value.
	Raylib rlPopMatrix.
```

Because this multiplies onto whatever is on Raylib's matrix stack, **a subtree can be drawn a
second time under another transform** by wrapping its objects' `renderOn:` in one more
`withTransform:`. `SRMiniView` does that for the halos; Redaw's portals do it for the canvas.

Two drawing paths behave differently, and both matter for shaders:

| Path | Used by | Vertices reach the shader | Notes |
|---|---|---|---|
| **Raylib's batch** (`rlBegin`/`rlVertex3f`) | `drawCube`, `drawCubeWires`, 3D text, lines | already multiplied by the matrix stack on the CPU: **world space**; `mvp` = view·projection | Queued and flushed lazily. Depth mask, blend mode or shader changes need a flush first (`Raylib rlDrawRenderBatchActive`), or they apply to geometry queued earlier. `beginShaderModeShader:` / `endShaderMode` flush by themselves. |
| **`drawMesh:material:transform:`** | `SRMeshObject`, Redaw's latent field | in model space; `mvp` and `matModel` include the stack | Drawn at once, not batched. A shader computing `matModel * position` gets **world space**, as for the batch (checked on the Windows build: a clip given in world space cuts meshes correctly). |

Other rules:

- Translucency is not sorted. Redaw's `SRRedawBoxBatch` draws translucent boxes with the depth
  mask off (flushing before and after) so sheets do not hide each other.
- `renderInSecondPass` (halos, gizmos) draws after a depth clear: for overlays, not for
  transparency.
- Raylib's 3D text has ASCII glyphs only, takes bytes and draws one line; glyph quads write depth.
- **Screenshots**: `RlFunctions allInstances first takeScreenshotFileName: 'x.png'` in a deferred
  frame message writes into the VM's working directory. It reads the back buffer, which holds an
  older frame: after changing the scene, wait two or three frames (nested deferred messages).

## 5. Shaders

A shader is a class-side method marked `<shaderSource: #name>` that answers a Dictionary with
`#uniforms` (names), `#vert` and `#frag`, written once in **GLSL 450** with explicit locations.

- `SRShader transpileShaderNamed: #name` (or `transpileSource:` on the dictionary) runs `python3`,
  `glslang` and `spirv-cross` and stores **GLSL 330** (desktop) and **GLSL ES 300** (Quest) in
  `SRShader shaderCache`, which lives in the image. The Quest has no transpiler: a shader must be
  in the cache before the image is copied there. `SRShader canTranspile` tells whether the tools
  are on the PATH (on Windows: the LunarG Vulkan SDK).
- `SRShader named: #name` loads the variant for the renderer's `shaderVersion`;
  `uniformLocAt: #u` answers a location by name. Values go in with `setFloat:at:`, `setX:y:z:w:at:`
  or Raylib's `setShaderValueVShader:locIndex:value:uniformType:count:` (type 3 = vec4).
- Raylib's attribute and uniform names apply: `vertexPosition` (0), `vertexTexCoord` (1),
  `vertexColor` (3), `mvp`, `matModel`, `colDiffuse`, `texture0`.
- **No geometry stage**: `SRShader class>>stages` is `#(vert frag)`, and GLES 3 has none.
- Installing a new cache entry unloads the old shader. Do it between frames; materials built on
  the old one must be rebuilt.

Shaders in the image: `phong`, `morphicPanel`, `waterShader`, `skybox`, `holodeckGrid`, the SWAGame
ones, and Redaw's `redawLatent` and `redawClip`.

## 6. Input

Every frame, `updateActions` lets each hand's cursor cast a ray. `SRCursor>>targetsIn:` collects
all objects with a `collisionGeometry` that do not `ignoreCollision`; the nearest hit becomes the
hand's `cursorTarget` and `cursorPoint`. `SRSendInputAction>>run:` then sends events to the target:

| Event | When | Carries |
|---|---|---|
| `SRInputEventCursorEnter` / `Leave` / `Move` | target changes, every frame | `point` |
| `SRInputEventButton` | `#trigger #squeeze #topButton #bottomButton #menuButton` pressed or released | `button`, `pressed`, `point`, `hand` |
| `SRInputEventAnalog` | `#joystick` (a point), `#trigger`, `#squeeze`, `#wheel` while non-zero | `axis`, `value`, `point`; its `hand` is the action, not the hand |

Delivery: `target handleInput: event`. What happens next is the target's **`cursorMode`**:

- `SRCursorMode stop` (the default): `actOnInput:` (→ `onButtonPress:`, `onButtonRelease:`,
  `onAnalogInput:`, `onCursorMove:` ...) and mark the event handled.
- `SRCursorMode pass`: act on it, then pass it to the parent.
- `SRCursorMode ignore`: pass it to the parent without acting.

So a button made of an `SRActionSign` with `cursorMode: pass` lets its owner (a remote, a panel)
find which button was hit (`SRActionSign>>redawContains:` in Redaw). `SRActionSign>>onRaycast:`
is not sent by anything any more. Events have a point but no ray.

**Grabbing**: on a squeeze, `SRGrabAction>>run:` takes the cursor target's `grabTarget` and, if
it `canGrab` (it `wantsGrab` and no other hand holds it), moves it with the hand until release. Panels and remotes answer `wantsGrab` true and set their parts'
`grabTarget:` to themselves.

On the desktop, `SRXRInputEmulator` maps the mouse to the right hand: left button = trigger,
right button = grab, the wheel = `#wheel`.

## 7. Collision

`collisionGeometry` answers an `SRCollisionGeometry` (or nil): `SRCollisionBox`,
`SRCollisionPlane`, `SRCollisionSphere`, `SRCollisionRing`, `SRCompositeCollision`,
`SRCollisionNull`. Each answers:

- `rayIntersection: aRay` → an `SRIntersectionResult` (`point`, `object`, `distance`) or nil.
  The cursor uses it, and so does grabbing.
- `intersectsBoxCenter:halfExtents:` for the avatar's body: walking, and flying down onto
  something solid (`solidInBoxCenter:halfExtents:` asks every object, whatever its `isSolid`).

The geometry can be computed per query, which allows custom collision objects:
`SWAGameVoxelCollider` answers voxel hits, Redaw's `SRRedawPortalCollision` casts the ray again
inside the canvas space. Collision geometry is asked for every frame, outside the asking object's
own step: compute it defensively (`safeCollisionGeometry` drops a bad one).

## 8. Apps, menus, preferences

- An object that `isApp` gets the menu button's menu: `SRObject>>app` is the nearest ancestor that
  is one, and `SRMenu class>>appMenuFor:...` asks it to `addCustomMenuItemsTo: aMenu`
  (`addItem: labelOrBlock action: aBlock keepOpen: aBoolean`, `addSubmenuItemFor:filledBy:`).
  Labels can be blocks, read again after an action (`labelsChanged`).
- World menu entries are class methods with `<xrMenu: #(world apps redaw) label: ... priority: ...>`.
- Preferences are class methods with `<preference: ... category: ... type: ...>`; their values live
  in the image, which is copied and shared, so secrets do not belong there.

## 9. Audio

`SRAudioObject` and its subclasses wrap OpenAL. When audio is set up again, a new OpenAL context
is made, and buffers of the old one become invalid. OpenAL's error flag is sticky and checked by
the listener every step, so an error shows up far from its cause. Redaw follows the context
(`SRAudioObject class>>alContext`, `SRRedawAudioFeature>>followContext`).

## 10. Working on it through the MCP

The Windows image is reached through the `winsqueak` MCP tools (`evaluate`, `get_source_code`,
`list_methods`, ...). From experience:

- `compile:classified:` answers the selector; check it exactly, an error text may look similar.
- Image sources use CR line endings: text replacements written with LF do not match.
- Change the tree of a running world only between frames (`addDeferredFrameMessage:`).
- Keep evaluation results small, and keep no world or canvas in a global.
