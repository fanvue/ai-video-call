# The "real" face recipe (GFPGAN at REAL_GFPGAN_BLEND + spread_lock) and Face lock's switch onto it, on CPU with fakes; needs numpy + OpenCV, no onnx models.
# Run: cd services/swap && ../../.venv-fal/bin/python -m unittest -v test_real_recipe
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "longlive"))

import swap_core  # noqa: E402

try:
    import cv2
    import numpy as np
except ImportError as error:  # pragma: no cover - plain-python runs skip these.
    np = None
    SKIP_REASON = f"needs numpy + opencv: {error}"
else:
    SKIP_REASON = ""


class RecipeSwitchTest(unittest.TestCase):
    def test_face_lock_runs_real_and_the_switch_restores_longlive(self):
        self.assertIn("real", swap_core.FACE_RECIPES)
        with mock.patch.object(swap_core, "FACE_LOCK_REAL", True):
            self.assertEqual(swap_core.effective_recipe("longlive"), "real")
            self.assertEqual(swap_core.effective_recipe("legacy"), "legacy")
            self.assertEqual(swap_core.effective_recipe("real"), "real")
        with mock.patch.object(swap_core, "FACE_LOCK_REAL", False):
            self.assertEqual(swap_core.effective_recipe("longlive"), "longlive")

    def test_real_needs_gfpgan_loaded(self):
        engine = type("E", (), {"gfpgan": None, "has_recipe": swap_core.SwapEngine.has_recipe})()
        self.assertFalse(engine.has_recipe("real"))
        engine.gfpgan = object()
        self.assertTrue(engine.has_recipe("real"))

    # LongLive's own blend is untouched; the realism change lives only in the real recipe's constant.
    def test_longlive_blend_unchanged(self):
        self.assertEqual(swap_core.GFPGAN_BLEND, 0.6)
        self.assertLess(swap_core.REAL_GFPGAN_BLEND, swap_core.GFPGAN_BLEND)


class Shim:
    # The real SwapEngine methods spread_lock needs, without loading insightface.
    face_core_stats = swap_core.SwapEngine.face_core_stats
    spread_lock = swap_core.SwapEngine.spread_lock
    gfpgan_face = swap_core.SwapEngine.gfpgan_face

    def __init__(self):
        self.template = np.array(swap_core.FFHQ_TEMPLATE, np.float32) * swap_core.RESTORE_SIZE
        self.gfpgan_template = np.array(swap_core.FFHQ_TEMPLATE, np.float32) * swap_core.GFPGAN_SIZE


class FakeFace:
    # FFHQ landmarks scaled to a 160 px face at (40, 40), so the aligned crop sits inside the frame.
    def __init__(self):
        self.kps = (np.array(swap_core.FFHQ_TEMPLATE, np.float32) * 160 + 40).astype(np.float32)


@unittest.skipIf(np is None, SKIP_REASON)
class SpreadLockTest(unittest.TestCase):
    def setUp(self):
        rng = np.random.default_rng(3)
        # A high-contrast "made-up" face: strong luma noise around a mid grey.
        self.frame = np.clip(rng.normal(128, 45, (240, 240, 3)), 0, 255).astype(np.uint8)
        self.face = FakeFace()
        self.engine = Shim()

    def core_std(self, frame):
        return self.engine.face_core_stats(frame, self.face)[1]

    def test_pulls_the_face_spread_toward_the_reference_and_keeps_its_mean(self):
        mean, std = self.engine.face_core_stats(self.frame, self.face)
        ref = (mean + 40.0, std * 0.5)
        out = self.engine.spread_lock(self.frame, self.face, ref)
        after_mean, after_std = self.engine.face_core_stats(out, self.face)
        self.assertTrue((after_std < std).all())
        self.assertTrue((after_std > ref[1]).all())
        # The reference's mean is ignored: lighting stays the frame's.
        np.testing.assert_allclose(after_mean, mean, atol=3.0)

    def test_leaves_pixels_outside_the_face_box_alone(self):
        mean, std = self.engine.face_core_stats(self.frame, self.face)
        out = self.engine.spread_lock(self.frame, self.face, (mean, std * 0.5))
        np.testing.assert_array_equal(out[:5], self.frame[:5])
        np.testing.assert_array_equal(out[:, -5:], self.frame[:, -5:])

    def test_no_reference_spread_is_a_no_op(self):
        self.assertIs(self.engine.spread_lock(self.frame, self.face, None), self.frame)

    def test_hidden_region_keeps_its_tone(self):
        mean, std = self.engine.face_core_stats(self.frame, self.face)
        matrix, _ = cv2.estimateAffinePartial2D(self.face.kps, self.engine.template, method=cv2.LMEDS)
        hidden = np.zeros((swap_core.RESTORE_SIZE, swap_core.RESTORE_SIZE), np.float32)
        out = self.engine.spread_lock(self.frame, self.face, (mean, std * 0.5), hidden, matrix)
        np.testing.assert_array_equal(out, self.frame)

    def test_reference_spread_is_taken_from_the_image_the_landmarks_belong_to(self):
        # source_face_from_image pads a tight headshot; stats on the unpadded image with padded landmarks would sample the wrong pixels.
        image = np.random.default_rng(5).integers(0, 256, (200, 200, 3), dtype=np.uint8)
        padded_face = FakeFace()
        padded_face.kps = padded_face.kps + 100

        class Identity:
            def get(self, img):
                return [padded_face] if img.shape[0] > 200 else []

        engine = Shim()
        engine.identity = Identity()
        engine.face_lab_stats = lambda frame, f: None
        source = swap_core.SwapEngine.source_face_from_image(engine, image)
        padded = cv2.copyMakeBorder(image, 100, 100, 100, 100, cv2.BORDER_REPLICATE)
        expected = engine.face_core_stats(padded, padded_face)
        wrong = engine.face_core_stats(image, padded_face)
        np.testing.assert_allclose(source.ref_spread[0], expected[0])
        self.assertFalse(np.allclose(source.ref_spread[0], wrong[0]))


class FakeGfpgan:
    def run(self, _outputs, feed):
        # All-white restore, so the pasted value shows the blend used.
        return [np.ones((1, 3, swap_core.GFPGAN_SIZE, swap_core.GFPGAN_SIZE), np.float32)]


@unittest.skipIf(np is None, SKIP_REASON)
class GfpganBlendTest(unittest.TestCase):
    def run_blend(self, **kwargs):
        engine = Shim()
        engine.gfpgan = FakeGfpgan()
        engine.gfpgan_input = "input"
        frame = np.zeros((240, 240, 3), np.uint8)
        out = engine.gfpgan_face(frame, FakeFace(), **kwargs)
        # Face centre, where the paste mask is 1.
        return int(out[int(40 + 0.6 * 160), 120, 0])

    def test_default_is_longlives_blend_and_real_passes_its_own(self):
        self.assertAlmostEqual(self.run_blend(), round(255 * swap_core.GFPGAN_BLEND), delta=2)
        self.assertAlmostEqual(self.run_blend(blend=swap_core.REAL_GFPGAN_BLEND), round(255 * swap_core.REAL_GFPGAN_BLEND), delta=2)


class RecordingEngine:
    def __init__(self):
        self.swapper = self.swapper_fp16 = self
        self.onnx_swapper_paths = {}
        self.restorer = None
        self.occluder = None
        self.calls = []

    def get(self, frame, face, source_face, paste_back=False):
        return np.full((128, 128, 3), 200, np.uint8), np.array([[1.0, 0.0, -10.0], [0.0, 1.0, -10.0]])

    def gfpgan_face(self, frame, face, visible=None, visible_matrix=None, blend=swap_core.GFPGAN_BLEND):
        self.calls.append(("gfpgan", blend))
        return frame

    def spread_lock(self, frame, face, ref_spread, visible=None, visible_matrix=None):
        self.calls.append(("spread", ref_spread))
        return frame


@unittest.skipIf(np is None, SKIP_REASON)
class SwapFrameRecipeTest(unittest.TestCase):
    def run_recipe(self, recipe, lock_real):
        engine = RecordingEngine()
        source = type("Source", (), {"ref_spread": "persona-spread"})()
        frame = np.full((200, 200, 3), 50, np.uint8)
        face = type("Face", (), {"kps": np.array([[40, 50], [80, 50], [60, 70], [45, 90], [75, 90]], np.float32)})()
        with mock.patch.object(swap_core, "FACE_LOCK_REAL", lock_real):
            swap_core.SwapEngine.swap_frame(engine, frame, source, [face], model="inswapper_fp16", restore=False, recipe=recipe)
        return engine.calls

    def test_face_lock_runs_the_lower_blend_then_the_persona_spread(self):
        self.assertEqual(self.run_recipe("longlive", True), [("gfpgan", swap_core.REAL_GFPGAN_BLEND), ("spread", "persona-spread")])

    def test_switch_off_is_longlives_recipe_unchanged(self):
        self.assertEqual(self.run_recipe("longlive", False), [("gfpgan", swap_core.GFPGAN_BLEND)])

    def test_legacy_never_restores_or_locks(self):
        self.assertEqual(self.run_recipe("legacy", True), [])


if __name__ == "__main__":
    unittest.main()
