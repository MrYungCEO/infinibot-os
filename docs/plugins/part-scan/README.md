# Part Scan

Part Scan is a manifest-v2 InfiniBot plugin that converts a guided camera orbit into a dimensionally scaled, color-textured 3D part model. Its control-UI page is `/part-scan`; its agent tool is `part_scan`; and its RPC namespace is `partscan.*`.

> Dimensional photogrammetry is a measurement aid, not metrology certification. For a well-shot hand-size part, a practical target is about **±0.2 mm**. Validate critical dimensions with calibrated calipers or a CMM.

## Architecture

```text
browser camera
  └─ sharpness gate + 36 sectors × 3 heights
      └─ partscan.uploadImage
          └─ <state>/plugin-data/part-scan/scans/<id>/images/
              └─ one-at-a-time job runner
                  ├─ Docker: CUDA 12.8 worker (RTX sm_89 + sm_120)
                  └─ local-cli: pipeline.py + installed COLMAP/OpenMVS
                      ├─ OpenCV ChArUco detection + blurry-frame rejection
                      ├─ COLMAP feature matching + sparse SfM
                      ├─ triangulated ChArUco corners → metric similarity transform
                      ├─ OpenMVS dense cloud → mesh → refine → texture
                      └─ board crop + GLB + dimensions + preview
```

Every scan is self-contained:

```text
<state>/plugin-data/part-scan/scans/<id>/
├── scan.json
├── images.json
├── images/*.jpg
├── job.json
├── model.glb
├── dims.json
└── preview.png
```

`job.json` is atomically updated through `capturing → queued → processing → done|failed`. It records a stage, monotonic 0–1 progress, a bounded log tail, and a clear error. Only one reconstruction runs at a time. Cancellation sends SIGTERM, then SIGKILL after five seconds if necessary. A gateway restart marks an interrupted job recoverably failed; captured images remain and can be processed again.

Progress is also broadcast as `partscan.job.progress`. GLB, preview, printable-board, and fixture files are served only through declared protected plugin routes.

## Configuration

| Field | Default | Meaning |
|---|---:|---|
| `workerMode` | `off` | `docker`, `local-cli`, or `off`. Off fails safely with setup guidance. |
| `workerImage` | `infinibot/part-scan-worker:cuda12.8` | Docker image tag. |
| `gpu` | `true` | Adds `docker run --gpus all`. |
| `markerSquareMm` | `20` | Physical ChArUco chess square length. Print at 100%. |
| `markerDictionary` | `DICT_5X5_100` | OpenCV ArUco dictionary. |
| `boardCols` / `boardRows` | `5` / `7` | ChArUco square count. |
| `quality` | `balanced` | `fast`, `balanced`, or `high` OpenMVS settings. |

The canonical plugin id is `part-scan`. Its manifest declares `rpcNamespace: "partscan"` so the public API remains the ergonomic `partscan.*` while the package, route, and data directory retain the human-readable hyphenated id.

## Hardware shopping list

- Stable turntable large enough for the mat and part to rotate together
- Printed ChArUco mat on flat, rigid, matte stock; verify square size with calipers
- Color checker for repeatable color and optional white-balance normalization
- Two large soft lights or diffused LED panels
- Camera capable of locked exposure, focus, ISO, white balance, and focal length
- Optional removable scanning spray for glossy, transparent, or featureless black parts
- NVIDIA GPU for the Docker worker; RTX 5090/5080 uses Blackwell `sm_120`

## Capture recipe

1. Put the part and ChArUco mat on the same rigid turntable. Do not rotate only the part.
2. Fill the frame while retaining the whole part and several board corners.
3. Lock focus/exposure/white balance. The UI requests supported track constraints after access is granted.
4. Capture 60–100 sharp photos around the object, roughly every 10°, using two or three height passes.
5. Use diffuse light. Spray shiny, transparent, or black surfaces when natural features are insufficient.
6. Check `dims.json`: low reprojection error and ChArUco scale RMS indicate a healthy reconstruction. Inspect the textured mesh for holes before trusting volume.

## Viewer and exports

`<part-scan-viewer>` uses Three.js `GLTFLoader` and `OrbitControls`, with damping, optional auto-rotation, floor/grid, a dimension box, projected millimetre labels, reset, and GLB/STL downloads. It works inline on scan detail and as a draggable floating overlay through the shared `draggable-overlay` helper.

A dependency-free generated GLB fixture represents a colored **40 × 20 × 10 mm** box. Open `/part-scan?viewer=sample` to verify model loading and dimension labels without a real reconstruction.

## Worker setup

See [`extensions/part-scan/worker/README.md`](../../../extensions/part-scan/worker/README.md). Do not substitute a CUDA 12.4 base for RTX 50-series cards: it lacks `sm_120` support. The Dockerfile compiles COLMAP and OpenMVS for `CMAKE_CUDA_ARCHITECTURES="89;120"`.

## Roadmap

- Mobile companion capture with resumable uploads and haptic sector guidance
- Depth-camera fusion for phones/tablets and structured-light sensors
- Camera calibration profiles and lens-distortion health checks
- Multi-marker boards and coded turntable angle ingestion
- Measurement annotations, tolerance bands, hole/cylinder fitting, and CAD-friendly export
- Distributed/federated worker selection and resumable dense reconstruction
