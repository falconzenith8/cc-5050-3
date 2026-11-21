# glTF ⇄ USD scene exchange (declared subset)

A tool that converts **meshes, node hierarchy, instances and basic materials**
between **glTF 2.0** and a **declared subset of OpenUSD**, and renders the result
in both formats through **two real loaders** so the conversion can be inspected
rather than asserted.

The graphical entry point is the page served by Vite. The CLI is auxiliary and
calls the same implementation.

```
npm install
npm run dev            # -> open the printed URL, press "Convert & compare"
```

Everything the page shows is produced by the real pipeline: the React-free UI
calls `src/core/exchange.js`, which reads the selected file, writes the other
real format, **re-reads the file it just wrote**, and diffs the two worlds. The
viewports are built by the actual third-party loaders from the actual bytes of
those files — no fixture data, no precomputed positions.

---

## 1. Declared subset and boundaries

| | supported | explicitly out of scope |
|---|---|---|
| geometry | triangle meshes (`TRIANGLES`), indexed or not | other prim modes, morph targets, skinning |
| attributes | `POSITION`, `NORMAL`, `TEXCOORD_0` | other UV sets, tangents, colours |
| materials | `pbrMetallicRoughness` (`baseColorFactor`, `metallicFactor`, `roughnessFactor`), `doubleSided`, `alphaMode` (`OPAQUE`/`MASK`/`BLEND`) | `emissiveFactor`, `normalTexture`, `occlusionTexture`, `metallicRoughnessTexture`, `alphaCutoff` as a shader input, `clearcoat`, `transmission`, `sheen`, `iridescence`, `specular`, `IOR` |
| instancing | glTF `EXT_mesh_gpu_instancing`; USD `instanceable` placements and `PointInstancer` | nested instancing, instancing of non-mesh prims |
| hierarchy | `Xform`/`Mesh` node trees; full 4×4 local matrices | variants, payloads, time samples, animation |
| buffers | embedded `data:` URI buffers | external `.bin`, GLB |

Unsupported material inputs that a reader finds are recorded per material in
`degradedInputs` and listed by the UI under **Declared degradations** and in the
report's `degradedMaterials`. A conversion never silently drops them.

## 2. Format mapping

| concept | glTF | USDA (this tool) |
|---|---|---|
| scene frame | none — declared by the user (Y-up m / Z-up cm) | stage metadata `upAxis`, `metersPerUnit` |
| node | `node` with TRS or baked root | `def Xform` (or `def Mesh`) with `matrix4d xformOp:transform` + `xformOpOrder` |
| mesh | `mesh.primitives[0]` | `def Mesh` with `faceVertexCounts`, `faceVertexIndices`, `point3f[] points`, `normal3f[] normals`, `primvars:st` |
| material | `materials[]` (`pbrMetallicRoughness`) | `def Material` + `Shader "Surface"` (`UsdPreviewSurface`) |
| double-sided | `material.doubleSided` | **`uniform bool doubleSided = 1` on the Mesh** (USD keeps it on the geometry, not the material) |
| instance | `EXT_mesh_gpu_instancing` (one mesh + per-instance TRS accessors) | one `instanceable` prim per placement, all `prepend references`-ing one `class` prototype |
| shared geometry | the single mesh referenced by the instancing node | the `class Xform` prototype under `/_Prototypes` |
| per-placement material override | a second primitive reusing the same accessors with a different `material` | an `over`-only variant prototype that `prepend references` the base geometry and rebinds `material:binding` — no geometry bytes of its own |

A shared mesh is written **once**. Our fixture converts to 7 draws over 3
meshes (2.33× sharing); the report states this expansion factor and the verdict
fails if it changes, so a conversion cannot flatten instances without being
caught.

### Shared geometry with per-instance material overrides

A glTF `InstancedMesh` cannot carry a per-instance material, so the naive
conversion either repaints every placement at once or copies the geometry for
the one placement that differs. This build does neither: identity is keyed on a
`resourceKey` (one physical resource — one POSITION accessor / one prototype),
which is distinct from the IR mesh object id that a material-only override
legitimately duplicates. The override fixture (`scenes/override.gltf` /
`scenes/override.usda`) contains two same-named `Bracket` nodes under
different parents, a mirrored parent layer, and one material-only override
placement; on disk it has exactly one POSITION accessor (glTF) and one
authored `points` block plus an `over Mesh` rebind (USD).

`src/core/lineage.js` records, during every conversion, the reverse chain from
an output object back to its source node (by stable id/path, never by name),
geometry resource, parent transform chain and local override, and can disable
one mapping layer at a time — `parent`, `transform`, `geometry`, `material`,
`override` — each reversibly. Only the `geometry` layer mints a new
`resourceKey`; every other layer leaves the shared bytes untouched.
`src/core/edits.js` adds the command-based edit session whose tracker reports
the three evidence categories separately: parent-layer changes, resource
re-sharing, and true geometry copies.

### Why `instanceable` rather than `PointInstancer`

Both real loaders in this repo were measured: `@openusd-wasm/three-loader`
expands `instanceable` prims but renders **no** `PointInstancer` instances;
lightusd renders only the first `instanceable` placement and also ignores
`PointInstancer`. Authoring each placement as an `instanceable` prim referencing
one class prototype is therefore the encoding that keeps the geometry shared
**and** is observable in the loaders used to prove it. PointInstancer input is
read and preserved in the IR; it is reported as a loader limitation, not
silently dropped.

## 3. Axis, units, matrix order, normals — one interpretation

* **Canonical frame:** right-handed, **Y-up, metres**, used by every comparison.
  Once.
* **One root fix.** A USD stage declares `upAxis`/`metersPerUnit`; the reader
  derives a single matrix `F = S(metersPerUnit) · R(upAxis→Y)` and stores it as
  `scene.rootFix`. Node locals are never rewritten by it. Z-up → Y-up is
  `(x, y, z) → (x, z, −y)`, i.e. a −90° rotation about X. Authoring the same
  scene in Z-up centimetres means writing its content at
  `C = S(100) · R(Z→Y)⁻¹`, `(x, y, z) → (100x, −100z, 100y)`; the fixture does
  exactly that and a test compares the canonical worlds of both files. (An
  earlier fixture applied the forward rotation by mistake, which put the
  panels *below* the ground and made both viewports frame empty space — the
  kind of error this tool exists to catch.)
* **glTF** has no stage metadata, so the page asks for the source frame and
  applies the *same* `F`; on export `F` is baked into root nodes exactly once.
  Converting USD(Z-up, cm) → glTF and re-reading reproduces the canonical
  vertices to >99% overlap (see e2e artifact logs).
* **Matrix order.** `xformOpOrder = ["xformOp:transform"]` means one composed
  local; a parent's world is `parentWorld · local`, and an instance's world is
  `hostWorld · instanceMatrix · prototypeRow`. USDA text `((r0),(r1),(r2),(r3))`
  is row-major and our column-major array is the same 16 numbers in the same
  order — no transpose anywhere. The report publishes the root fix matrix and
  the worst hierarchy world delta (≈1e-7 for a round trip).
* **Normals.** USD stores vertex normals as authored; glTF reads them as
  authored. Neither writer re-derives normals from positions, so a non-uniform
  parent scale is not "corrected" behind the user's back. Non-uniform scale is
  part of the fixture (parent Y 0.5, child X 0.4) and both the loader panels and
  the IR are checked against it.

## 4. Negative scale / mirrored parts

The fixture has one mirrored panel (`scale = (-1, 1, 1)`, determinant −1).

Measured behaviour in `three.module.js`:

```js
const frontFaceCW = ( object.isMesh && object.matrixWorld.determinant() < 0 );
```

Winding is flipped **per object**, never per instance. A mirrored instance of an
`InstancedMesh` therefore keeps its original winding: a single-sided copy is
back-face culled and **disappears silently**. This was reproduced with a real
single-sided plane instance set: 4 656 px for the normal copy, **0 px** for the
mirrored copy.

So the tool cannot claim a loader fixes it. Instead:

* instance matrices are written verbatim (the mirror is preserved, never
  "fixed" by editing transforms);
* when an instance set's material is single-sided and the set contains a
  mirrored placement, the glTF writer emits a **`doubleSided` material variant
  for that instanced mesh only** (same accessors, same matrices);
* the trade-off is returned as a `mirror-facing` warning and shown in the report
  (`mirrorFacing.mitigation`) and under **Warnings** in the UI: those copies stay
  visible and become visible from both sides;
* `extras.usdgltf.mirrorPolicy` on the node states exactly this — the old,
  false "winding flipped per instance at load" claim is gone.

Verified in the real `GLTFLoader`: with the mitigation the mirrored copy renders
4 656 px instead of 0. `--no-mirror-fix` on the CLI (or
`writeGltf(..., { mirrorMitigation: false })`) reproduces the failure.

## 5. Comparison — what "fidelity" means here

A conversion is compared by re-reading the written file, never by trusting the
in-memory scene:

| check | what proves it |
|---|---|
| hierarchy | matched node paths; **world matrices** (not just vertex totals); worst Δ and the exact node |
| instances | every placement matched by geometry key + **world position**; mirrored flag preserved |
| sharing | expansion factor (draws ÷ unique meshes) must not change — flattening fails the verdict |
| visible triangles | triangles that survive back-face culling, with mirrored single-sided draws counted as culled |
| geometry | distinct vertex/triangle sets in world space (Jaccard overlap) |
| materials | colour/metal/rough/alpha/`doubleSided` plus the explicit degradation list |

The verdict is **not** "vertex totals match": equal vertex counts, a single
coinciding camera angle, or equal counts with different positions all fail
because placements are matched by world position and structural nodes by world
matrix.

## 6. Two real loaders

| loader | version | what it does in this build (measured) |
|---|---|---|
| three.js `GLTFLoader` | three r180 | `EXT_mesh_gpu_instancing` → one `InstancedMesh`; flips winding per object only |
| `@openusd-wasm/three-loader` | 0.0.17 (pxr WASM) | expands **all** `instanceable` placements at correct worlds; applies `convertZUp` rotation; has no `metersPerUnit` field, so it never scales; no `PointInstancer`; renders a class prototype's *base* material binding as an unnamed grey material, while stage-root and `over`-variant rebinds resolve |
| `lightusd` | 1.0.0 (WASM) | draws only the **first** placement of each `instanceable` prototype (measured 1 of 4 panels, 1 of 2 posts); no `PointInstancer`; applies neither up-axis nor unit |

The two real loaders are also driven headlessly against the override fixture
by `npm run verify:override`
(`tools/verify-override-loaders.mjs`), which asserts and records in
`tests/e2e/artifacts/override-loader-evidence.json` that both loaders show
isolated per-placement materials (the `BracketPaint` rebind resolves in each),
build one position attribute for the single shared geometry, and produce the
same world bounding box as the canonical IR. The openusd grey base-prototype
binding is recorded there as a loader limit, not treated as a conversion
failure.

The page's **Independent loader check** table reports triangles, placement count
and how many placements land at the IR's world positions, for whichever loaders
are selected. A shortfall is attributed to the loader, not hidden. Because the
USD loaders ignore parts of the stage frame, the panel applies only the missing
part (`Z-up→Y`, `cm→m`) as a **declared presentation fix** and labels it; the
file verdict is computed on the files and does not depend on it. OpenUSD (pxr)
is additionally used out-of-band in the e2e test to re-open the produced USDA and
confirm its `XformCache` world matrices against the page's placements.

## 7. Using the page

* **Source** format and file (glTF fixture plus the override fixture, Y-up m
  USDA, Z-up cm USDA, and the USDA override fixture).
* **Convert & compare** runs the exchange and both loaders.
* Left panel: expandable source hierarchy (instance/mirror badges, mesh and
  world position on select), instance sets with placement counts, materials with
  degraded inputs.
* Two viewports: each has loader buttons; orbit/zoom with the mouse. The
  independent loader check and the results (hierarchy Δ, placement table, geometry,
  facing, verdict, degradations, warnings) sit beside them.
* **Download outputs** saves the written file and the JSON report.

## 8. CLI (auxiliary)

```
node cli/exchange.mjs scenes/exchange.gltf            # -> scenes/out-exchange/exchange.usda
node cli/exchange.mjs scenes/exchange-zup.usda -o out # -> out/exchange-zup.gltf + report
npm run test                                          # core pipeline tests
npm run verify:override                               # two real loaders vs the override fixture
node tests/e2e/run-e2e.mjs                            # drives the page, writes artifacts/
```

`tests/e2e/artifacts/` contains the delivered evidence: written files, reports,
screenshots of both panels for each direction, and the OpenUSD re-read.

## 9. Fixture

`tools/build-scenes.mjs` builds one specification into three files:

* `scenes/exchange.gltf` — Y-up metres, two instance sets, one mirrored panel;
* `scenes/exchange-yup.usda` — same scene, Y-up metres;
* `scenes/exchange-zup.usda` — genuinely Z-up centimetres: a `matrix4d` on
  `World` rotates/scales into stage space, and the stage declares `upAxis = "Z"`,
  `metersPerUnit = 0.01`.

The hierarchy has a parent with non-uniform scale (Y 0.5) and a child with its
own non-uniform scale (X 0.4), four `instanceable` placements of one shared
panel (one mirrored) and a `PointInstancer` of two shared posts. The USD files
therefore cover **both** USD instance forms; the PointInstancer is the one the
real loaders in this build do not expand, which the loader audit reports.

`tools/build-override-scenes.mjs` (also run by `npm run scenes`) builds the
material-override scenario into `scenes/override.gltf` and
`scenes/override.usda`: two same-named `Bracket` nodes (one standalone under
`HolderA`, one host of an instancing set under the mirrored `MirrorRig`),
three draws over one physical geometry resource, and a single material-only
override placement bound to `BracketPaint`. Its behaviour is covered by
`tests/core/override.test.mjs` (isolation and sharing, both exchange
directions, lineage reverse-lookup, layer disable/undo, reparent→undo→clear
override, and the first-identity-confusion characterization).
