import importlib.util
import math
import sys
import unittest
from pathlib import Path

import numpy as np

SPEC = importlib.util.spec_from_file_location("part_scan_pipeline", Path(__file__).with_name("pipeline.py"))
pipeline = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
sys.modules[SPEC.name] = pipeline
SPEC.loader.exec_module(pipeline)


class MetricMathTests(unittest.TestCase):
    def test_similarity_recovers_metric_transform(self):
        source = np.array([[0, 0, 0], [1, 0, 0], [0, 2, 0], [0, 0, 3], [1, 2, 3]], dtype=float)
        angle = 0.41
        rotation = np.array([
            [math.cos(angle), -math.sin(angle), 0],
            [math.sin(angle), math.cos(angle), 0],
            [0, 0, 1],
        ])
        target = pipeline.apply_similarity(source, 20.0, rotation, np.array([5, -8, 3]))
        scale, recovered_rotation, translation, rms = pipeline.similarity_transform(source, target)
        self.assertAlmostEqual(scale, 20.0, places=8)
        self.assertLess(rms, 1e-8)
        np.testing.assert_allclose(
            pipeline.apply_similarity(source, scale, recovered_rotation, translation), target, atol=1e-8
        )

    def test_oriented_bbox_of_rotated_known_box(self):
        box = np.array([[x, y, z] for x in (-20, 20) for y in (-10, 10) for z in (-5, 5)], dtype=float)
        angle = 0.63
        rotation = np.array([
            [math.cos(angle), -math.sin(angle), 0],
            [math.sin(angle), math.cos(angle), 0],
            [0, 0, 1],
        ])
        extents, _, axes = pipeline.oriented_bbox(box @ rotation.T)
        np.testing.assert_allclose(extents, [40, 20, 10], atol=1e-7)
        self.assertAlmostEqual(np.linalg.det(axes), 1.0, places=7)

    @unittest.skipIf(pipeline.cv2 is None, "opencv-contrib-python is not installed")
    def test_sharpness_prefers_edges(self):
        flat = np.zeros((64, 64, 3), dtype=np.uint8)
        edged = flat.copy()
        edged[:, 32:] = 255
        self.assertGreater(pipeline.sharpness_score(edged), pipeline.sharpness_score(flat))


if __name__ == "__main__":
    unittest.main()
