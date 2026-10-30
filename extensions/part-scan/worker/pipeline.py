#!/usr/bin/env python3
"""Metric photogrammetry worker for the InfiniBot Part Scan plugin.

The heavy executables are deliberately subprocesses: COLMAP owns feature/SfM
and OpenMVS owns dense reconstruction, meshing, refinement, and texturing. This
module owns deterministic frame QA, ChArUco metric scale, board removal, GLB
export, dimensions, and the machine-readable JSON-line progress contract.
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

import numpy as np

try:
    import cv2
except ImportError:  # pure NumPy synthetic tests still give a useful result
    cv2 = None


def progress(stage: str, value: float, message: str | None = None) -> None:
    payload: dict[str, object] = {"stage": stage, "progress": max(0.0, min(1.0, value))}
    if message:
        payload["message"] = message
    print(json.dumps(payload, separators=(",", ":")), flush=True)


def similarity_transform(source: np.ndarray, target: np.ndarray) -> tuple[float, np.ndarray, np.ndarray, float]:
    """Umeyama least-squares similarity mapping source points onto target."""
    src = np.asarray(source, dtype=np.float64)
    dst = np.asarray(target, dtype=np.float64)
    if src.shape != dst.shape or src.ndim != 2 or src.shape[1] != 3 or len(src) < 3:
        raise ValueError("similarity_transform needs matching Nx3 arrays (N >= 3)")
    src_mean, dst_mean = src.mean(axis=0), dst.mean(axis=0)
    src_centered, dst_centered = src - src_mean, dst - dst_mean
    covariance = (dst_centered.T @ src_centered) / len(src)
    u, singular, vt = np.linalg.svd(covariance)
    sign = np.ones(3)
    if np.linalg.det(u) * np.linalg.det(vt) < 0:
        sign[-1] = -1
    rotation = u @ np.diag(sign) @ vt
    variance = np.mean(np.sum(src_centered * src_centered, axis=1))
    if variance < 1e-15:
        raise ValueError("source points have no spatial extent")
    scale = float(np.sum(singular * sign) / variance)
    translation = dst_mean - scale * (rotation @ src_mean)
    fitted = (scale * (rotation @ src.T)).T + translation
    rms = float(np.sqrt(np.mean(np.sum((fitted - dst) ** 2, axis=1))))
    return scale, rotation, translation, rms


def apply_similarity(points: np.ndarray, scale: float, rotation: np.ndarray, translation: np.ndarray) -> np.ndarray:
    return (scale * (rotation @ np.asarray(points, dtype=np.float64).T)).T + translation


def oriented_bbox(points: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """PCA oriented bounding box: (extents descending, center, world axes)."""
    pts = np.asarray(points, dtype=np.float64)
    if pts.ndim != 2 or pts.shape[1] != 3 or len(pts) < 4:
        raise ValueError("oriented_bbox needs at least four 3D points")
    centroid = pts.mean(axis=0)
    covariance = np.cov((pts - centroid).T, bias=True)
    eigenvalues, axes = np.linalg.eigh(covariance)
    axes = axes[:, np.argsort(eigenvalues)[::-1]]
    if np.linalg.det(axes) < 0:
        axes[:, -1] *= -1
    local = (pts - centroid) @ axes
    lo, hi = local.min(axis=0), local.max(axis=0)
    extents = hi - lo
    center = centroid + ((lo + hi) / 2) @ axes.T
    order = np.argsort(extents)[::-1]
    return extents[order], center, axes[:, order]


def sharpness_score(image: np.ndarray) -> float:
    if cv2 is None:
        raise RuntimeError("OpenCV is required for frame analysis")
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def gray_world(image: np.ndarray) -> np.ndarray:
    channels = image.astype(np.float32).mean(axis=(0, 1))
    target = float(channels.mean())
    gain = target / np.maximum(channels, 1.0)
    return np.clip(image.astype(np.float32) * gain, 0, 255).astype(np.uint8)


@dataclass
class Camera:
    model: str
    width: int
    height: int
    params: list[float]

    def matrix(self) -> np.ndarray:
        p = self.params
        if self.model in {"SIMPLE_PINHOLE", "SIMPLE_RADIAL", "RADIAL"}:
            f, cx, cy = p[:3]
            fx = fy = f
        elif self.model in {"PINHOLE", "OPENCV", "FULL_OPENCV", "OPENCV_FISHEYE"}:
            fx, fy, cx, cy = p[:4]
        else:
            raise ValueError(f"unsupported COLMAP camera model: {self.model}")
        return np.array([[fx, 0, cx], [0, fy, cy], [0, 0, 1]], dtype=np.float64)


@dataclass
class ImagePose:
    camera_id: int
    rotation: np.ndarray
    translation: np.ndarray


def quaternion_rotation(q: Sequence[float]) -> np.ndarray:
    w, x, y, z = q
    return np.array([
        [1 - 2 * (y*y + z*z), 2 * (x*y - z*w), 2 * (x*z + y*w)],
        [2 * (x*y + z*w), 1 - 2 * (x*x + z*z), 2 * (y*z - x*w)],
        [2 * (x*z - y*w), 2 * (y*z + x*w), 1 - 2 * (x*x + y*y)],
    ], dtype=np.float64)


def read_colmap_text(model_dir: Path) -> tuple[dict[int, Camera], dict[str, ImagePose]]:
    cameras: dict[int, Camera] = {}
    for line in (model_dir / "cameras.txt").read_text().splitlines():
        if not line or line.startswith("#"):
            continue
        fields = line.split()
        cameras[int(fields[0])] = Camera(fields[1], int(fields[2]), int(fields[3]), [float(x) for x in fields[4:]])
    poses: dict[str, ImagePose] = {}
    lines = [line for line in (model_dir / "images.txt").read_text().splitlines() if line and not line.startswith("#")]
    for index in range(0, len(lines), 2):
        fields = lines[index].split()
        poses[fields[9]] = ImagePose(
            camera_id=int(fields[8]),
            rotation=quaternion_rotation([float(x) for x in fields[1:5]]),
            translation=np.array([float(x) for x in fields[5:8]], dtype=np.float64),
        )
    return cameras, poses


def triangulate(observations: Sequence[tuple[np.ndarray, np.ndarray]]) -> np.ndarray:
    rows: list[np.ndarray] = []
    for projection, pixel in observations:
        rows.append(pixel[0] * projection[2] - projection[0])
        rows.append(pixel[1] * projection[2] - projection[1])
    _, _, vt = np.linalg.svd(np.stack(rows))
    homogeneous = vt[-1]
    if abs(homogeneous[3]) < 1e-12:
        raise ValueError("degenerate triangulation")
    return homogeneous[:3] / homogeneous[3]


def dictionary_by_name(name: str):
    if cv2 is None or not hasattr(cv2, "aruco"):
        raise RuntimeError("opencv-contrib (cv2.aruco) is required")
    dictionary_id = getattr(cv2.aruco, name, None)
    if dictionary_id is None:
        raise ValueError(f"unknown ArUco dictionary: {name}")
    return cv2.aruco.getPredefinedDictionary(dictionary_id)


def detect_charuco(images: Iterable[Path], cols: int, rows: int, square_mm: float, dictionary_name: str):
    dictionary = dictionary_by_name(dictionary_name)
    marker_mm = square_mm * 0.75
    board = cv2.aruco.CharucoBoard((cols, rows), square_mm, marker_mm, dictionary)
    detections: dict[str, dict[int, np.ndarray]] = {}
    scores: dict[str, float] = {}
    for image_path in images:
        image = cv2.imread(str(image_path))
        if image is None:
            continue
        scores[image_path.name] = sharpness_score(image)
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        marker_corners, marker_ids, _ = cv2.aruco.detectMarkers(gray, dictionary)
        if marker_ids is None or len(marker_ids) < 2:
            continue
        count, corners, ids = cv2.aruco.interpolateCornersCharuco(marker_corners, marker_ids, gray, board)
        if count is None or count < 4 or ids is None:
            continue
        detections[image_path.name] = {int(i): corner.astype(float) for i, corner in zip(ids.ravel(), corners.reshape(-1, 2))}
    return board, detections, scores


def estimate_metric_transform(
    model_dir: Path,
    board,
    detections: dict[str, dict[int, np.ndarray]],
) -> tuple[float, np.ndarray, np.ndarray, float, float]:
    cameras, poses = read_colmap_text(model_dir)
    grouped: dict[int, list[tuple[np.ndarray, np.ndarray]]] = {}
    for name, corners in detections.items():
        pose = poses.get(name)
        if pose is None:
            continue
        projection = cameras[pose.camera_id].matrix() @ np.column_stack((pose.rotation, pose.translation))
        for corner_id, pixel in corners.items():
            grouped.setdefault(corner_id, []).append((projection, pixel))
    object_points = np.asarray(board.getChessboardCorners(), dtype=float)
    reconstructed, metric = [], []
    reprojection: list[float] = []
    for corner_id, observations in grouped.items():
        if len(observations) < 2 or corner_id >= len(object_points):
            continue
        point = triangulate(observations)
        reconstructed.append(point)
        metric.append(object_points[corner_id])
        homogeneous = np.r_[point, 1.0]
        for projection, pixel in observations:
            projected = projection @ homogeneous
            projected = projected[:2] / projected[2]
            reprojection.append(float(np.linalg.norm(projected - pixel)))
    if len(reconstructed) < 6:
        raise RuntimeError("metric scale failed: fewer than 6 ChArUco corners triangulated across registered views")
    scale, rotation, translation, scale_error = similarity_transform(np.stack(reconstructed), np.stack(metric))
    reprojection_rms = float(np.sqrt(np.mean(np.square(reprojection)))) if reprojection else math.nan
    return scale, rotation, translation, scale_error, reprojection_rms


def run(command: Sequence[str], cwd: Path) -> None:
    progress("command", 0.0, " ".join(command))
    subprocess.run(list(command), cwd=cwd, check=True)


def prepare_images(scan_dir: Path, blur_threshold: float, white_balance: bool, board_args):
    source = sorted((scan_dir / "images").glob("*.jpg"))
    if len(source) < 3:
        raise RuntimeError("at least 3 JPEG frames are required")
    board, detections, scores = detect_charuco(source, *board_args)
    accepted = [path for path in source if scores.get(path.name, 0.0) >= blur_threshold]
    rejected = sorted(set(path.name for path in source) - set(path.name for path in accepted))
    if len(accepted) < 3:
        raise RuntimeError(f"only {len(accepted)} sharp frames remain (threshold {blur_threshold:.1f})")
    work_images = scan_dir / "work" / "images"
    if work_images.exists():
        shutil.rmtree(work_images)
    work_images.mkdir(parents=True)
    for image_path in accepted:
        target = work_images / image_path.name
        if white_balance:
            cv2.imwrite(str(target), gray_world(cv2.imread(str(image_path))))
        else:
            shutil.copy2(image_path, target)
    (scan_dir / "frame-qa.json").write_text(json.dumps({"scores": scores, "rejected": rejected}, indent=2))
    return board, detections, work_images, len(accepted), rejected


def find_mesh(work: Path) -> Path:
    candidates = sorted(
        [*work.glob("**/*texture*.obj"), *work.glob("**/*refine*.ply"), *work.glob("**/*mesh*.ply")],
        key=lambda item: item.stat().st_mtime,
    )
    if not candidates:
        raise RuntimeError("OpenMVS produced no textured OBJ or mesh PLY")
    return candidates[-1]


def export_outputs(scan_dir: Path, mesh_path: Path, transform, scale_error: float, reprojection_error: float) -> None:
    try:
        import trimesh
    except ImportError as exc:
        raise RuntimeError("trimesh is required to export GLB") from exc
    loaded = trimesh.load(mesh_path, force="scene", process=False)
    mesh = loaded.dump(concatenate=True) if isinstance(loaded, trimesh.Scene) else loaded
    scale, rotation, translation = transform
    mesh.vertices = apply_similarity(np.asarray(mesh.vertices), scale, rotation, translation)
    # ChArUco target coordinates put the board on z=0. Remove board/under-board
    # triangles while retaining geometry at least 0.35 mm above it.
    face_z = np.asarray(mesh.vertices)[np.asarray(mesh.faces)].mean(axis=1)[:, 2]
    keep = face_z > 0.35
    if int(keep.sum()) >= 4:
        mesh.update_faces(keep)
        mesh.remove_unreferenced_vertices()
    components = mesh.split(only_watertight=False)
    if components:
        mesh = max(components, key=lambda component: component.area)
    vertices = np.asarray(mesh.vertices)
    axis_extents = vertices.max(axis=0) - vertices.min(axis=0)
    obb_extents, _, _ = oriented_bbox(vertices)
    dims = {
        "bboxMm": {"length": float(axis_extents[0]), "width": float(axis_extents[1]), "height": float(axis_extents[2])},
        "orientedBboxMm": {"length": float(obb_extents[0]), "width": float(obb_extents[1]), "height": float(obb_extents[2])},
        "surfaceAreaMm2": float(mesh.area),
        "volumeMm3": float(abs(mesh.volume)) if mesh.is_watertight else None,
        "watertight": bool(mesh.is_watertight),
        "scaleSource": "ChArUco corner similarity transform",
        "reprojectionErrorPx": reprojection_error if math.isfinite(reprojection_error) else None,
        "scaleErrorMm": scale_error,
    }
    # GLB convention is metres; dimensions remain explicitly millimetres.
    glb_mesh = mesh.copy()
    glb_mesh.vertices = np.asarray(glb_mesh.vertices) / 1000.0
    glb_mesh.export(scan_dir / "model.glb", file_type="glb")
    (scan_dir / "dims.json").write_text(json.dumps(dims, indent=2))
    render_preview(vertices, np.asarray(mesh.faces), scan_dir / "preview.png")


def render_preview(vertices: np.ndarray, faces: np.ndarray, output: Path) -> None:
    if cv2 is None:
        raise RuntimeError("OpenCV is required to render preview.png")
    canvas = np.full((720, 960, 3), (22, 25, 32), dtype=np.uint8)
    direction = np.array([[0.82, -0.42], [0.48, 0.74], [-0.30, 0.52]])
    projected = (vertices - vertices.mean(axis=0)) @ direction
    span = np.maximum(projected.max(axis=0) - projected.min(axis=0), 1e-6)
    points = (projected - projected.min(axis=0)) / span
    points = points * np.array([760, 520]) + np.array([100, 100])
    order = np.argsort(vertices[faces].mean(axis=1)[:, 2])
    for face_index in order:
        polygon = np.rint(points[faces[face_index]]).astype(np.int32)
        cv2.fillConvexPoly(canvas, polygon, (188, 132, 38), lineType=cv2.LINE_AA)
        cv2.polylines(canvas, [polygon], True, (236, 192, 83), 1, cv2.LINE_AA)
    cv2.imwrite(str(output), canvas)


def synthetic_test() -> None:
    rng = np.random.default_rng(42)
    source = rng.normal(size=(40, 3))
    angle = 0.37
    rotation = np.array([[math.cos(angle), -math.sin(angle), 0], [math.sin(angle), math.cos(angle), 0], [0, 0, 1]])
    target = apply_similarity(source, 23.5, rotation, np.array([7.0, -12.0, 2.0]))
    scale, fitted_rotation, translation, rms = similarity_transform(source, target)
    assert abs(scale - 23.5) < 1e-9 and rms < 1e-9
    assert np.max(np.abs(apply_similarity(source, scale, fitted_rotation, translation) - target)) < 1e-8
    box = np.array([[x, y, z] for x in (-20, 20) for y in (-10, 10) for z in (-5, 5)], dtype=float)
    extents, _, _ = oriented_bbox(box @ rotation.T)
    assert np.allclose(extents, [40, 20, 10], atol=1e-7), extents
    progress("synthetic-test", 1.0, "similarity + OBB math passed")


def pipeline(args: argparse.Namespace) -> None:
    if cv2 is None:
        raise RuntimeError("opencv-contrib-python is not installed")
    scan_dir = args.scan_dir.resolve()
    work = scan_dir / "work"
    work.mkdir(parents=True, exist_ok=True)
    progress("frame-qa", 0.03, "checking sharpness and ChArUco coverage")
    board_args = (args.board_cols, args.board_rows, args.marker_square_mm, args.marker_dictionary)
    board, detections, image_dir, accepted, rejected = prepare_images(scan_dir, args.blur_threshold, args.white_balance, board_args)
    if len(detections) < 2:
        raise RuntimeError("ChArUco board was not detected in at least two sharp frames")
    progress("frame-qa", 0.08, f"accepted {accepted} frames; rejected {len(rejected)} blurry frames")

    database = work / "database.db"
    sparse = work / "sparse"
    dense = work / "dense"
    if database.exists(): database.unlink()
    if sparse.exists(): shutil.rmtree(sparse)
    if dense.exists(): shutil.rmtree(dense)
    sparse.mkdir()
    progress("colmap-features", 0.12)
    run(["colmap", "feature_extractor", "--database_path", str(database), "--image_path", str(image_dir), "--ImageReader.single_camera", "1"], work)
    progress("colmap-matching", 0.23)
    run(["colmap", "exhaustive_matcher", "--database_path", str(database), "--SiftMatching.use_gpu", "1"], work)
    progress("colmap-sfm", 0.34)
    run(["colmap", "mapper", "--database_path", str(database), "--image_path", str(image_dir), "--output_path", str(sparse)], work)
    model = sparse / "0"
    if not model.exists():
        raise RuntimeError("COLMAP could not produce a sparse reconstruction")
    text_model = work / "sparse-text"
    text_model.mkdir(exist_ok=True)
    run(["colmap", "model_converter", "--input_path", str(model), "--output_path", str(text_model), "--output_type", "TXT"], work)
    scale, rotation, translation, scale_error, reprojection = estimate_metric_transform(text_model, board, detections)
    progress("metric-scale", 0.44, f"ChArUco RMS {scale_error:.3f} mm; reprojection {reprojection:.3f} px")

    run(["colmap", "image_undistorter", "--image_path", str(image_dir), "--input_path", str(model), "--output_path", str(dense), "--output_type", "COLMAP"], work)
    quality = {"fast": (2, 3), "balanced": (1, 4), "high": (0, 6)}[args.quality]
    progress("openmvs-import", 0.50)
    run(["InterfaceCOLMAP", "-i", str(dense), "-o", "scene.mvs", "--image-folder", str(dense / "images")], work)
    progress("openmvs-dense", 0.60)
    run(["DensifyPointCloud", "scene.mvs", "--resolution-level", str(quality[0]), "--number-views", str(quality[1])], work)
    progress("openmvs-mesh", 0.72)
    run(["ReconstructMesh", "scene_dense.mvs"], work)
    progress("openmvs-refine", 0.81)
    run(["RefineMesh", "scene_dense_mesh.mvs", "--resolution-level", str(quality[0])], work)
    progress("openmvs-texture", 0.90)
    run(["TextureMesh", "scene_dense_mesh_refine.mvs", "--export-type", "obj"], work)
    progress("export", 0.96, "removing board plane and exporting GLB")
    export_outputs(scan_dir, find_mesh(work), (scale, rotation, translation), scale_error, reprojection)
    progress("complete", 1.0)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scan-dir", type=Path)
    parser.add_argument("--marker-square-mm", type=float, default=20.0)
    parser.add_argument("--marker-dictionary", default="DICT_5X5_100")
    parser.add_argument("--board-cols", type=int, default=5)
    parser.add_argument("--board-rows", type=int, default=7)
    parser.add_argument("--quality", choices=("fast", "balanced", "high"), default="balanced")
    parser.add_argument("--blur-threshold", type=float, default=80.0)
    parser.add_argument("--white-balance", action="store_true", help="Apply gray-world normalization before SfM")
    parser.add_argument("--synthetic-test", action="store_true", help="Run pure similarity/OBB checks without COLMAP")
    args = parser.parse_args()
    if not args.synthetic_test and args.scan_dir is None:
        parser.error("--scan-dir is required")
    return args


if __name__ == "__main__":
    try:
        options = parse_args()
        synthetic_test() if options.synthetic_test else pipeline(options)
    except Exception as error:
        progress("failed", 0.0, str(error))
        raise
