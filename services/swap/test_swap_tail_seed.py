# swap_tail's seed frame must be lossless PNG (see swap_core.encode_png), not JPEG.
# Run: cd services/swap && ../../.venv-fal/bin/python -m unittest -v test_swap_tail_seed
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "longlive"))

import swap_core  # noqa: E402


class FakeDetector:
    def __init__(self, faces):
        self._faces = faces

    def get(self, frame):
        return self._faces


class FakeSwapTailEngine:
    # Duck-types only what SwapEngine.swap_tail touches, so this runs the real method without onnx models.
    def __init__(self, faces=("face",)):
        self.detector = FakeDetector(list(faces))
        self.png_calls = []
        self.jpeg_calls = []

    def read_tail_frame(self, video_path):
        return "raw-frame"

    def swap_frame(self, frame, source_face, faces, restore, recipe, occlusion=None):
        return "swapped-frame"

    def finish_seed(self, swapped):
        return swapped, 0, False, 10.0, 10.0

    def similarity(self, frame, source_face):
        return 0.5

    def encode_png(self, frame):
        self.png_calls.append(frame)
        return b"png-bytes"

    def encode_jpeg(self, frame):
        self.jpeg_calls.append(frame)
        return b"jpeg-bytes"


class SwapTailSeedFormatTest(unittest.TestCase):
    def test_swap_tail_encodes_the_seed_as_png_not_jpeg(self):
        engine = FakeSwapTailEngine()
        stats, encoded = swap_core.SwapEngine.swap_tail(engine, "clip.mp4", "source-face")
        self.assertEqual(encoded, b"png-bytes")
        self.assertEqual(engine.png_calls, ["swapped-frame"])
        self.assertEqual(engine.jpeg_calls, [])
        self.assertTrue(stats["had_face"])
        self.assertEqual(stats["similarity_before"], 0.5)
        self.assertEqual(stats["similarity_after"], 0.5)

    def test_no_face_on_the_tail_still_encodes_png_and_reports_it(self):
        engine = FakeSwapTailEngine(faces=())
        stats, encoded = swap_core.SwapEngine.swap_tail(engine, "clip.mp4", "source-face")
        self.assertEqual(encoded, b"png-bytes")
        self.assertFalse(stats["had_face"])


if __name__ == "__main__":
    unittest.main()
