# Padded detection fallback and coordinate mapping, with a fake detector: no GPU, no real faces.
# Run: cd services/wan14b && ../../.venv-fal/bin/python -m unittest -v test_face_detect
import unittest
from types import SimpleNamespace

import numpy as np

import face_detect as fd

HEIGHT, WIDTH = 832, 480


class TightFaceDetector:
    # Mimics SCRFD on a Wan headshot: nothing on the raw frame, the face once the canvas is padded.
    def __init__(self, raw_hits=False):
        self.raw_hits = raw_hits
        self.shapes = []

    def get(self, bgr):
        self.shapes.append(bgr.shape[:2])
        dy, dx = fd.pad_offsets(HEIGHT, WIDTH)
        padded = bgr.shape[:2] == (HEIGHT + 2 * dy, WIDTH + 2 * dx)
        if not padded and not self.raw_hits:
            return []
        ox, oy = (dx, dy) if padded else (0, 0)
        return [SimpleNamespace(bbox=np.array([20 + ox, 100 + oy, 460 + ox, 600 + oy], np.float32),
                                kps=np.array([[150 + ox, 300 + oy], [330 + ox, 300 + oy], [240 + ox, 400 + oy],
                                              [170 + ox, 480 + oy], [310 + ox, 480 + oy]], np.float32))]


class DetectFacesTest(unittest.TestCase):
    def frame(self):
        return np.zeros((HEIGHT, WIDTH, 3), np.uint8)

    def test_unpadded_hit_is_returned_as_is(self):
        detector = TightFaceDetector(raw_hits=True)
        faces, padded = fd.detect_faces(detector, self.frame())
        self.assertFalse(padded)
        self.assertEqual(len(detector.shapes), 1)
        np.testing.assert_allclose(faces[0].bbox, [20, 100, 460, 600])

    def test_tight_face_found_on_padded_canvas_maps_back_to_frame_coordinates(self):
        detector = TightFaceDetector()
        faces, padded = fd.detect_faces(detector, self.frame())
        self.assertTrue(padded)
        self.assertEqual(detector.shapes, [(HEIGHT, WIDTH), (HEIGHT + 2 * 416, WIDTH + 2 * 240)])
        np.testing.assert_allclose(faces[0].bbox, [20, 100, 460, 600])
        np.testing.assert_allclose(faces[0].kps[0], [150, 300])
        np.testing.assert_allclose(faces[0].kps[4], [310, 480])

    def test_no_face_anywhere(self):
        class Blind:
            def get(self, bgr):
                return []

        self.assertEqual(fd.detect_faces(Blind(), self.frame()), ([], True))
        self.assertIsNone(fd.largest([]))

    def test_largest_picks_biggest_box(self):
        small = SimpleNamespace(bbox=[0, 0, 10, 10])
        big = SimpleNamespace(bbox=[0, 0, 50, 40])
        self.assertIs(fd.largest([small, big]), big)


if __name__ == "__main__":
    unittest.main()
