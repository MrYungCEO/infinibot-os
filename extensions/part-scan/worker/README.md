# Part Scan worker

This container turns a calibrated photo set into a metric, textured GLB. COLMAP performs feature extraction, matching and sparse reconstruction; OpenMVS densifies, meshes, refines and textures it. `pipeline.py` derives scale from triangulated ChArUco corners, removes the board plane, and writes `model.glb`, `dims.json`, and `preview.png` into the mounted scan directory.

## Build and run

The image intentionally uses CUDA 12.8 and compiles for `CMAKE_CUDA_ARCHITECTURES="89;120"`. Blackwell RTX 5090/5080 cards are `sm_120`; older CUDA 12.4 images cannot run their kernels.

```bash
docker build -t infinibot/part-scan-worker:cuda12.8 extensions/part-scan/worker
docker run --rm --gpus all \
  -v /absolute/path/to/scan:/scan \
  infinibot/part-scan-worker:cuda12.8 \
  --scan-dir /scan --marker-square-mm 20 --marker-dictionary DICT_5X5_100 \
  --board-cols 5 --board-rows 7 --quality balanced
```

For local CLI mode, install COLMAP and OpenMVS on `PATH`, then install Python packages:

```bash
python3 -m pip install numpy scipy opencv-contrib-python-headless trimesh pillow
python3 extensions/part-scan/worker/pipeline.py --scan-dir /absolute/path/to/scan
```

Run the math/QA tests without COLMAP or OpenMVS:

```bash
python3 -m unittest extensions/part-scan/worker/test_pipeline.py
python3 extensions/part-scan/worker/pipeline.py --synthetic-test
```

## Accuracy checklist

- Print the ChArUco PDF/SVG at **100% / actual size** and verify one square with calipers.
- Lock focus, exposure, ISO, white balance, and focal length. The capture UI requests those constraints when the camera supports them.
- Use two large diffuse lights and eliminate hard moving shadows.
- Apply removable scanning spray to shiny, transparent, or featureless black parts.
- Capture **60–100 photos**, ten degrees apart, at **2–3 heights**. Keep the whole part and several board corners in view.
- Do not move the part relative to the board during a scan. A turntable under both is fine; turning only the part breaks the metric reference.
- Reprojection error below roughly 0.8 px and scale RMS below roughly 0.2 mm are healthy targets for hand-size parts. Validate critical dimensions with calipers.

Progress is emitted as one JSON object per line, for example `{"stage":"openmvs-mesh","progress":0.72}`. Any other stdout/stderr is retained in `job.json` as a bounded log tail.
