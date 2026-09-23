# SEED_FACE_TONE_LOCK: the seed's face ellipse is pulled toward the session's first face, and nothing outside the face moves.
# Run: cd services/swap && ../../.venv-fal/bin/python -m unittest -v test_seed_face_tone_lock
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "longlive"))

import cv2  # noqa: E402
import numpy as np  # noqa: E402

import swap_core  # noqa: E402
from test_swap_tail_seed import FakeSwapTailEngine  # noqa: E402


class FakeFace:
    def __init__(self, kps):
        self.kps = np.array(kps, dtype=np.float32)
        self.bbox = np.array([*self.kps.min(axis=0) - 40, *self.kps.max(axis=0) + 40], dtype=np.float32)


class ToneEngine:
    # Only what face_tone_lock touches, so the real crop, stats and paste run without onnx models.
    template = np.array(swap_core.FFHQ_TEMPLATE, dtype=np.float32) * swap_core.RESTORE_SIZE
    aligned_face_crop = swap_core.SwapEngine.aligned_face_crop
    face_ellipse_stats = staticmethod(swap_core.SwapEngine.face_ellipse_stats)
    face_tone_lock = swap_core.SwapEngine.face_tone_lock


def face_at(center_x, center_y, scale=1.0):
    template = np.array(swap_core.FFHQ_TEMPLATE, dtype=np.float32) * 120 * scale
    return FakeFace(template - template.mean(axis=0) + (center_x, center_y))


def ellipse_mean(engine, frame, face):
    crop, _ = engine.aligned_face_crop(frame, [face])
    return engine.face_ellipse_stats(crop)[0]


class FaceToneLockTest(unittest.TestCase):
    def setUp(self):
        rng = np.random.default_rng(7)
        self.frame = np.clip(rng.normal(150, 20, (480, 640, 3)), 0, 255).astype(np.uint8)
        self.face = face_at(320, 220)
        self.engine = ToneEngine()

    def test_pulls_the_face_mean_toward_the_reference_by_the_blend(self):
        before = ellipse_mean(self.engine, self.frame, self.face)
        reference = (before + np.array([-30.0, 0.0, 0.0], np.float32), np.array([15.0, 5.0, 5.0], np.float32))
        locked, ok = self.engine.face_tone_lock(self.frame, [self.face], reference)
        self.assertTrue(ok)
        after = ellipse_mean(self.engine, locked, self.face)
        # Halfway (TONE_LOCK_BLEND) toward a reference 30 darker in L, give or take the feathered edge.
        self.assertAlmostEqual(float(before[0] - after[0]), 30 * swap_core.TONE_LOCK_BLEND, delta=3.0)

    def test_leaves_everything_outside_the_face_untouched(self):
        before = ellipse_mean(self.engine, self.frame, self.face)
        locked, _ = self.engine.face_tone_lock(self.frame, [self.face], (before - 30, np.array([5.0] * 3, np.float32)))
        np.testing.assert_array_equal(locked[:60], self.frame[:60])
        np.testing.assert_array_equal(locked[:, :150], self.frame[:, :150])

    def test_no_face_or_no_reference_returns_the_frame_as_is(self):
        stats = (np.zeros(3, np.float32), np.ones(3, np.float32))
        self.assertIs(self.engine.face_tone_lock(self.frame, [], stats)[0], self.frame)
        self.assertFalse(self.engine.face_tone_lock(self.frame, [self.face], None)[1])

    def test_locks_the_biggest_face(self):
        small = face_at(120, 380, scale=0.4)
        before = ellipse_mean(self.engine, self.frame, self.face)
        reference = (before - 30, np.array([15.0, 5.0, 5.0], np.float32))
        locked, _ = self.engine.face_tone_lock(self.frame, [small, self.face], reference)
        self.assertGreater(float(before[0] - ellipse_mean(self.engine, locked, self.face)[0]), 10)


class SwapTailToneLockTest(unittest.TestCase):
    class Engine(FakeSwapTailEngine):
        def __init__(self):
            super().__init__()
            self.tone_calls = []

        def face_tone_lock(self, frame, faces, stats):
            self.tone_calls.append((frame, faces, stats))
            return "toned-frame", True

    def test_locks_the_swapped_tail_before_encoding_when_given_reference_stats(self):
        engine = self.Engine()
        stats, _ = swap_core.SwapEngine.swap_tail(engine, "clip.mp4", "source-face", tone_reference_stats="ref")
        self.assertEqual(engine.tone_calls, [("swapped-frame", ["face"], "ref")])
        self.assertEqual(engine.png_calls, ["toned-frame"])
        self.assertTrue(stats["tone_locked"])

    def test_without_reference_the_seed_goes_out_as_swapped(self):
        engine = self.Engine()
        stats, _ = swap_core.SwapEngine.swap_tail(engine, "clip.mp4", "source-face")
        self.assertEqual(engine.tone_calls, [])
        self.assertEqual(engine.png_calls, ["swapped-frame"])
        self.assertFalse(stats["tone_locked"])


class SwapTailFromUrlToneFrameTest(unittest.TestCase):
    def test_the_tone_frame_feeds_colour_stats_only_and_never_the_swap_source(self):
        engine = mock.Mock()
        engine.swap_tail.return_value = ({"swap_ms": 0, "had_face": True, "tone_locked": True, "similarity_before": None,
                                          "similarity_after": None, "enhance_ms": 0, "sharpness_before": None,
                                          "sharpness_after": None}, b"png")
        with mock.patch.object(swap_core, "check_swap_options"), mock.patch.object(
            swap_core, "persona_source_face", return_value="persona-face"
        ), mock.patch.object(swap_core, "tone_reference_stats", return_value="face-stats") as stats, mock.patch.object(
            swap_core, "download"
        ), mock.patch("builtins.print"):
            swap_core.swap_tail_from_url(engine, "https://x.fal.media/a.mp4", "/personas", "synth-persona-01",
                                         tone_frame_url="https://x.fal.media/first.png")
        stats.assert_called_once_with(engine, "https://x.fal.media/first.png", face=True)
        _, source_face = engine.swap_tail.call_args.args
        self.assertEqual(source_face, "persona-face")
        self.assertEqual(engine.swap_tail.call_args.kwargs["tone_reference_stats"], "face-stats")

    def test_a_tone_frame_that_fails_to_load_still_seeds_the_swapped_tail(self):
        engine = mock.Mock()
        engine.swap_tail.return_value = ({"swap_ms": 0, "had_face": True, "tone_locked": False, "similarity_before": None,
                                          "similarity_after": None, "enhance_ms": 0, "sharpness_before": None,
                                          "sharpness_after": None}, b"png")
        with mock.patch.object(swap_core, "check_swap_options"), mock.patch.object(
            swap_core, "persona_source_face", return_value="persona-face"
        ), mock.patch.object(swap_core, "tone_reference_stats", side_effect=ValueError("no face")), mock.patch.object(
            swap_core, "download"
        ), mock.patch("builtins.print"):
            result = swap_core.swap_tail_from_url(engine, "https://x.fal.media/a.mp4", "/personas", "synth-persona-01",
                                                  tone_frame_url="https://x.fal.media/first.png")
        self.assertIsNone(engine.swap_tail.call_args.kwargs["tone_reference_stats"])
        self.assertIn("last_frame_base64", result)


if __name__ == "__main__":
    unittest.main()
