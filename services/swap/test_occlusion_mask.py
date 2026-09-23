# Occlusion mask plumbing (xseg visible-face mask into both pastes) on CPU with fakes; needs numpy + OpenCV, no onnx models.
# Run: cd services/swap && ../../.venv-fal/bin/python -m unittest -v test_occlusion_mask
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


class FakeFace:
    def __init__(self):
        self.kps = np.array([[40, 50], [80, 50], [60, 70], [45, 90], [75, 90]], np.float32)


class FakeSwapper:
    def get(self, frame, face, source_face, paste_back=False):
        matrix = np.array([[1.0, 0.0, -10.0], [0.0, 1.0, -10.0]])
        return np.full((128, 128, 3), 200, np.uint8), matrix


class FakeEngine:
    # Duck-types what SwapEngine.swap_frame touches, so the real method runs without onnx sessions.
    def __init__(self, occluder):
        self.swapper = self.swapper_fp16 = FakeSwapper()
        self.onnx_swapper_paths = {}
        self.restorer = None
        self.occluder = occluder
        self.occlusion_calls = []
        self.gfpgan_calls = []
        self.spread_calls = []

    def occlusion_mask(self, frame, matrix, size):
        self.occlusion_calls.append(size)
        return np.zeros((size, size), np.float32)

    def gfpgan_face(self, frame, face, visible=None, visible_matrix=None, blend=None):
        self.gfpgan_calls.append(visible)
        return frame

    def spread_lock(self, frame, face, ref_spread, visible=None, visible_matrix=None):
        self.spread_calls.append(visible)
        return frame


@unittest.skipIf(np is None, SKIP_REASON)
class VisibleFaceMaskTest(unittest.TestCase):
    def test_clear_face_is_fully_visible_and_a_covered_one_is_fully_hidden(self):
        np.testing.assert_allclose(swap_core.visible_face_mask(np.ones((256, 256), np.float32), 128), 1.0)
        np.testing.assert_allclose(swap_core.visible_face_mask(np.zeros((256, 256), np.float32), 128), 0.0)

    def test_hand_edge_is_soft_and_resized_to_the_crop(self):
        raw = np.ones((256, 256), np.float32)
        raw[:, :128] = 0.0
        mask = swap_core.visible_face_mask(raw, 128)
        self.assertEqual(mask.shape, (128, 128))
        self.assertEqual(float(mask[64, 5]), 0.0)
        self.assertEqual(float(mask[64, 122]), 1.0)
        self.assertTrue(((mask > 0.0) & (mask < 1.0)).any())

    def test_grow_gives_back_a_thin_edge_but_keeps_a_hand_hidden(self):
        raw = np.ones((256, 256), np.float32)
        raw[:, :12] = 0.0  # xseg's tight outline at the jaw
        raw[100:220, 80:200] = 0.0  # a hand over the face
        tight = swap_core.visible_face_mask(raw, 128, grow=0)
        grown = swap_core.visible_face_mask(raw, 128, grow=swap_core.OCCLUDER_GROW)
        self.assertLess(float(tight[64, 2]), 0.5)
        self.assertEqual(float(grown[64, 2]), 1.0)
        self.assertEqual(float(grown[80, 70]), 0.0)


@unittest.skipIf(np is None, SKIP_REASON)
class ChainAffineTest(unittest.TestCase):
    def test_maps_one_crop_onto_the_other(self):
        inner = np.array([[0.8, 0.1, -20.0], [-0.1, 0.8, 5.0]])
        outer = np.array([[2.0, -0.3, 40.0], [0.3, 2.0, -12.0]])
        point = np.array([123.0, 77.0, 1.0])
        in_inner = inner @ point
        chained = swap_core.chain_affine(outer, inner) @ np.append(in_inner, 1.0)
        np.testing.assert_allclose(chained, outer @ point, atol=1e-6)


@unittest.skipIf(np is None, SKIP_REASON)
class PastePatchVisibleTest(unittest.TestCase):
    def setUp(self):
        self.frame = np.full((200, 200, 3), 50, np.uint8)
        self.patch = np.full((128, 128, 3), 200, np.uint8)
        self.matrix = np.array([[1.0, 0.0, -30.0], [0.0, 1.0, -30.0]])

    def test_hidden_mask_leaves_the_frame_alone(self):
        out = swap_core.paste_patch(self.frame, self.patch, self.matrix, np.zeros((128, 128), np.float32))
        np.testing.assert_array_equal(out, self.frame)

    def test_all_visible_matches_the_plain_ellipse(self):
        plain = swap_core.paste_patch(self.frame, self.patch, self.matrix)
        visible = swap_core.paste_patch(self.frame, self.patch, self.matrix, np.ones((128, 128), np.float32))
        np.testing.assert_array_equal(plain, visible)
        self.assertGreater(int(plain[94, 94, 0]), 150)


@unittest.skipIf(np is None, SKIP_REASON)
class SwapFrameOcclusionTest(unittest.TestCase):
    def run_swap(self, enabled, occluder, recipe="legacy"):
        engine = FakeEngine(occluder)
        frame = np.full((200, 200, 3), 50, np.uint8)
        with mock.patch.object(swap_core, "OCCLUSION_MASK", enabled):
            out = swap_core.SwapEngine.swap_frame(engine, frame, "persona", [FakeFace()], model="inswapper_fp16", restore=False, recipe=recipe)
        return engine, frame, out

    def test_off_by_default_skips_the_occluder(self):
        self.assertFalse(swap_core.OCCLUSION_MASK)
        engine, frame, out = self.run_swap(swap_core.OCCLUSION_MASK, occluder=object())
        self.assertEqual(engine.occlusion_calls, [])
        self.assertFalse(np.array_equal(out, frame))

    def test_on_without_a_loaded_occluder_swaps_unmasked(self):
        engine, frame, out = self.run_swap(True, occluder=None)
        self.assertEqual(engine.occlusion_calls, [])
        self.assertFalse(np.array_equal(out, frame))

    def test_on_masks_the_swap_paste(self):
        engine, frame, out = self.run_swap(True, occluder=object())
        self.assertEqual(engine.occlusion_calls, [128])
        np.testing.assert_array_equal(out, frame)

    def test_longlive_hands_the_same_mask_to_gfpgan(self):
        engine, _, _ = self.run_swap(True, occluder=object(), recipe="longlive")
        self.assertEqual(len(engine.gfpgan_calls), 1)
        self.assertEqual(engine.gfpgan_calls[0].shape, (128, 128))

    # Face lock now runs "real": its spread lock gets the same mask, so a hand keeps its own tone.
    def test_real_hands_the_same_mask_to_the_spread_lock(self):
        engine, _, _ = self.run_swap(True, occluder=object(), recipe="real")
        self.assertEqual(len(engine.spread_calls), 1)
        self.assertEqual(engine.spread_calls[0].shape, (128, 128))

    # The Hand mask toggle: a request's flag wins over the module default in both directions.
    def test_request_flag_overrides_the_default(self):
        engine = FakeEngine(object())
        frame = np.full((200, 200, 3), 50, np.uint8)
        with mock.patch.object(swap_core, "OCCLUSION_MASK", False):
            swap_core.SwapEngine.swap_frame(engine, frame, "persona", [FakeFace()], model="inswapper_fp16", restore=False, occlusion=True)
        self.assertEqual(engine.occlusion_calls, [128])
        engine = FakeEngine(object())
        with mock.patch.object(swap_core, "OCCLUSION_MASK", True):
            swap_core.SwapEngine.swap_frame(engine, frame, "persona", [FakeFace()], model="inswapper_fp16", restore=False, occlusion=False)
        self.assertEqual(engine.occlusion_calls, [])


class OptionsEngine:
    def __init__(self, occluder):
        self.occluder = occluder

    def has_swap_model(self, model):
        return True

    def has_recipe(self, recipe):
        return True

    def has_occluder(self):
        return self.occluder is not None


class CheckOcclusionOptionTest(unittest.TestCase):
    def test_a_requested_mask_without_the_occluder_fails_closed(self):
        with self.assertRaises(ValueError):
            swap_core.check_swap_options(OptionsEngine(None), "inswapper_fp16", "legacy", True)

    def test_off_or_unset_needs_no_occluder(self):
        swap_core.check_swap_options(OptionsEngine(None), "inswapper_fp16", "legacy", False)
        swap_core.check_swap_options(OptionsEngine(None), "inswapper_fp16", "legacy")
        swap_core.check_swap_options(OptionsEngine(object()), "inswapper_fp16", "longlive", True)


class OcclusionEntryPointTest(unittest.TestCase):
    def test_swap_clip_from_url_forwards_the_flag_and_gates_before_download(self):
        with mock.patch.object(swap_core, "persona_source_face", return_value="face"), mock.patch.object(
            swap_core, "download"
        ) as download:
            with self.assertRaises(ValueError):
                swap_core.swap_clip_from_url(OptionsEngine(None), "https://x.fal.media/a.mp4", "/p", "synth-persona-01", occlusion_mask=True)
        download.assert_not_called()
        stats = {key: 0 for key in ("frames", "swap_ms", "ms_per_frame", "enhance_ms")}
        stats.update(recipe="legacy", occlusion_mask=True, restored=False, similarity_before=None, similarity_after=None,
                     sharpness_before=None, sharpness_after=None)
        with mock.patch.object(swap_core, "persona_source_face", return_value="face"), mock.patch.object(
            swap_core, "download", side_effect=lambda _url, path: open(path, "wb").close()
        ), mock.patch.object(swap_core, "swap_clip_with_face", return_value={"stats": stats}) as swap, mock.patch("builtins.print"):
            swap_core.swap_clip_from_url(OptionsEngine(object()), "https://x.fal.media/a.mp4", "/p", "synth-persona-01", occlusion_mask=True)
        self.assertEqual(swap.call_args.args[4], {"recipe": "legacy", "occlusion_mask": True})

    def test_swap_tail_from_url_forwards_the_flag(self):
        engine = mock.Mock()
        engine.swap_tail.return_value = ({"swap_ms": 0, "had_face": True, "tone_locked": False, "occlusion_mask": True,
                                          "similarity_before": None, "similarity_after": None, "enhance_ms": 0,
                                          "sharpness_before": None, "sharpness_after": None}, b"png")
        with mock.patch.object(swap_core, "check_swap_options") as check, mock.patch.object(
            swap_core, "persona_source_face", return_value="face"
        ), mock.patch.object(swap_core, "download"), mock.patch("builtins.print"):
            swap_core.swap_tail_from_url(engine, "https://x.fal.media/a.mp4", "/p", "synth-persona-01", occlusion_mask=True)
        self.assertEqual(check.call_args.args[3], True)
        self.assertEqual(engine.swap_tail.call_args.kwargs["occlusion_mask"], True)


try:
    import importlib.util

    from pydantic import ValidationError

    # By path: the longlive dir on sys.path has its own modal_app.
    _spec = importlib.util.spec_from_file_location("swap_modal_app", os.path.join(os.path.dirname(os.path.abspath(__file__)), "modal_app.py"))
    modal_app = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(modal_app)
except ImportError as error:  # pragma: no cover - runs without modal/fastapi skip the request contract.
    modal_app = None
    MODAL_SKIP = f"needs modal + fastapi: {error}"
else:
    MODAL_SKIP = ""


@unittest.skipIf(modal_app is None, MODAL_SKIP)
class OcclusionRequestTest(unittest.TestCase):
    def test_unset_leaves_the_service_default(self):
        self.assertIsNone(modal_app.SwapClipRequest(video_url="u").occlusion_mask)
        self.assertIsNone(modal_app.SwapTailRequest(video_url="u").occlusion_mask)

    def test_booleans_pass_through(self):
        self.assertTrue(modal_app.SwapClipRequest(video_url="u", occlusion_mask=True).occlusion_mask)
        self.assertFalse(modal_app.SwapTailRequest(video_url="u", occlusion_mask=False).occlusion_mask)

    def test_non_booleans_are_rejected(self):
        for value in ("false", "true", 1, 0, "yes"):
            for model in (modal_app.SwapClipRequest, modal_app.SwapTailRequest):
                with self.assertRaises(ValidationError, msg=f"{model.__name__} {value!r}"):
                    model(video_url="u", occlusion_mask=value)


if __name__ == "__main__":
    unittest.main()
