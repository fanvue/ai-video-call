# The swap source resolves only through the persona manifest and fails closed; no GPU, and the recipe checks need numpy + OpenCV.
# Run: cd services/swap && ../../.venv-fal/bin/python -m unittest -v test_persona_gate
import inspect
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "longlive"))

import swap_core  # noqa: E402
from swap_core import PersonaRejected, check_swap_options, persona_source_face  # noqa: E402

try:
    import numpy as np

    import face_restore
except ImportError as error:  # pragma: no cover - plain-python runs skip these.
    np = None
    SKIP_REASON = f"needs numpy + opencv: {error}"
else:
    SKIP_REASON = ""

GOOD = {
    "id": "synth-persona-01",
    "file": "synth-persona-01.jpg",
    "synthetic": True,
    "rightsHolder": "Fanvue",
}


class FakeEngine:
    def __init__(self, gfpgan: bool = True):
        self.loaded = []
        self.uploads = []
        self.gfpgan = object() if gfpgan else None
        # Recorded so a test can check swap_tail_from_url reaches the engine with the recipe it was given.
        self.tail_calls = []

    def swap_tail(self, video_path, source_face, recipe=swap_core.FACE_RECIPE, tone_reference_stats=None, occlusion_mask=None):
        self.tail_calls.append((video_path, source_face, recipe))
        return (
            {
                "swap_ms": 0,
                "had_face": True,
                "similarity_before": None,
                "similarity_after": None,
                "tone_locked": False,
                "enhance_ms": 0,
                "sharpness_before": None,
                "sharpness_after": None,
            },
            b"png-bytes",
        )

    def has_swap_model(self, model):
        return model in ("inswapper", "inswapper_fp16")

    def has_recipe(self, recipe):
        return recipe == "legacy" or (recipe == "longlive" and self.gfpgan is not None)

    def persona_face(self, persona):
        self.loaded.append(persona)
        return "persona-face"

    # Recorded so a test fails if anything tries to build a source face from an upload.
    def source_face_from_image(self, image):
        self.uploads.append(image)
        return "upload-face"


class PersonaGateTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = self.directory.name
        self.engine = FakeEngine()

    def tearDown(self):
        self.directory.cleanup()

    def write(self, entries, files=("synth-persona-01.jpg",)):
        for name in files:
            with open(os.path.join(self.root, name), "wb") as handle:
                handle.write(b"\xff\xd8\xff")
        with open(os.path.join(self.root, "manifest.json"), "w", encoding="utf-8") as handle:
            json.dump(entries, handle)

    def assert_refused(self, persona_id, reason):
        with mock.patch("builtins.print"), self.assertRaises(PersonaRejected) as caught:
            persona_source_face(self.engine, self.root, persona_id)
        self.assertIn(reason, str(caught.exception))
        self.assertEqual(self.engine.loaded, [])
        self.assertEqual(self.engine.uploads, [])

    def test_allowlisted_persona_is_the_source(self):
        self.write([GOOD])
        self.assertEqual(persona_source_face(self.engine, self.root, "synth-persona-01"), "persona-face")
        self.assertEqual(self.engine.loaded[0].path, os.path.join(self.root, "synth-persona-01.jpg"))

    def test_invalid_ids_fail_closed(self):
        self.write([GOOD])
        for persona_id in (None, "", "../synth-persona-01", "Synth-Persona-01", "synth-persona-01\n", 7, "x" * 65):
            self.assert_refused(persona_id, "invalid persona id")

    def test_unknown_id_fails_closed(self):
        self.write([GOOD])
        self.assert_refused("synth-persona-02", "not in manifest")

    def test_unvouched_entry_fails_closed(self):
        self.write([{**GOOD, "synthetic": False}])
        self.assert_refused("synth-persona-01", "not marked synthetic")
        self.write([{**GOOD, "rightsHolder": " "}])
        self.assert_refused("synth-persona-01", "no rightsHolder")

    def test_missing_manifest_fails_closed(self):
        self.assert_refused("synth-persona-01", "manifest unreadable")

    def test_no_store_fails_closed(self):
        with mock.patch("builtins.print"), self.assertRaises(PersonaRejected) as caught:
            persona_source_face(self.engine, None, "synth-persona-01")
        self.assertIn("no persona store", str(caught.exception))

    def test_refused_persona_never_downloads_or_swaps(self):
        with mock.patch.object(swap_core, "download") as download, mock.patch.object(
            swap_core, "swap_clip_with_face"
        ) as swap, mock.patch("builtins.print"):
            for call in (
                lambda: swap_core.swap_clip_from_url(self.engine, "https://x.fal.media/a.mp4", self.root, "nope"),
                lambda: swap_core.swap_tail_from_url(self.engine, "https://x.fal.media/a.mp4", self.root, "nope"),
                lambda: swap_core.swap_clip_from_bytes(self.engine, b"mp4", self.root, "nope"),
            ):
                with self.assertRaises(PersonaRejected):
                    call()
        download.assert_not_called()
        swap.assert_not_called()
        self.assertEqual(self.engine.uploads, [])

    def test_no_swap_entry_point_takes_an_upload(self):
        for fn in (
            swap_core.swap_clip_from_url,
            swap_core.swap_clip_from_bytes,
            swap_core.swap_tail_from_url,
            swap_core.swap_tail_from_bytes,
            swap_core.profile_networks,
        ):
            params = inspect.signature(fn).parameters
            self.assertIn("persona_id", params, fn.__name__)
            self.assertFalse([name for name in params if "reference" in name], fn.__name__)

    def test_recipe_without_its_model_fails(self):
        with self.assertRaises(ValueError):
            check_swap_options(FakeEngine(gfpgan=False), "inswapper_fp16", "longlive")
        with self.assertRaises(ValueError):
            check_swap_options(self.engine, "inswapper_fp16", "gpen")
        check_swap_options(self.engine, "inswapper_fp16", "longlive")
        check_swap_options(FakeEngine(gfpgan=False), "inswapper_fp16", "legacy")

    # Face lock (Advanced) sends "longlive" through swap_clip_from_url; it must reach swap_clip_with_face's options and gate before the download.
    def test_swap_clip_from_url_forwards_the_recipe_and_gates_before_download(self):
        self.write([GOOD])
        with mock.patch.object(
            swap_core, "download", side_effect=lambda _url, path: open(path, "wb").close()
        ) as download, mock.patch.object(swap_core, "swap_clip_with_face") as swap:
            swap.return_value = {
                "stats": {
                    "recipe": "longlive",
                    "restored": True,
                    "frames": 1,
                    "swap_ms": 0,
                    "ms_per_frame": 0,
                    "similarity_before": None,
                    "similarity_after": None,
                    "enhance_ms": 0,
                    "sharpness_before": None,
                    "sharpness_after": None,
                }
            }
            swap_core.swap_clip_from_url(
                self.engine,
                "https://x.fal.media/a.mp4",
                self.root,
                "synth-persona-01",
                "inswapper_fp16",
                "longlive",
            )
        swap.assert_called_once_with(
            self.engine, mock.ANY, "persona-face", "inswapper_fp16", {"recipe": "longlive"}
        )
        download.assert_called_once()

    def test_swap_clip_from_url_fails_closed_on_an_unknown_recipe_before_download(self):
        self.write([GOOD])
        with mock.patch.object(swap_core, "download") as download:
            with self.assertRaises(ValueError):
                swap_core.swap_clip_from_url(
                    self.engine,
                    "https://x.fal.media/a.mp4",
                    self.root,
                    "synth-persona-01",
                    "inswapper_fp16",
                    "gpen",
                )
        download.assert_not_called()

    # Same for /swapTail: the seed swap must honour and validate the recipe like swapClip does.
    def test_swap_tail_from_url_forwards_the_recipe(self):
        self.write([GOOD])
        with mock.patch.object(swap_core, "download") as download:
            swap_core.swap_tail_from_url(
                self.engine, "https://x.fal.media/a.mp4", self.root, "synth-persona-01", "longlive"
            )
        self.assertEqual(self.engine.tail_calls[-1][2], "longlive")
        download.assert_called_once()

    def test_swap_tail_from_url_defaults_to_the_legacy_recipe(self):
        self.write([GOOD])
        with mock.patch.object(swap_core, "download"):
            swap_core.swap_tail_from_url(
                self.engine, "https://x.fal.media/a.mp4", self.root, "synth-persona-01"
            )
        self.assertEqual(self.engine.tail_calls[-1][2], "legacy")

    def test_swap_tail_from_url_fails_closed_on_an_unknown_recipe_before_download(self):
        self.write([GOOD])
        with mock.patch.object(swap_core, "download") as download:
            with self.assertRaises(ValueError):
                swap_core.swap_tail_from_url(
                    self.engine, "https://x.fal.media/a.mp4", self.root, "synth-persona-01", "gpen"
                )
        download.assert_not_called()
        self.assertEqual(self.engine.tail_calls, [])


@unittest.skipIf(np is None, SKIP_REASON)
class RecipePortTest(unittest.TestCase):
    def test_keep_motion_matches_longlive(self):
        rng = np.random.default_rng(3)
        patch = rng.integers(0, 256, (128, 128, 3), dtype=np.uint8)
        original = rng.integers(0, 256, (128, 128, 3), dtype=np.uint8)
        ours = swap_core.keep_motion(patch, original, swap_core.MOTION_KEEP)
        theirs = face_restore.keep_motion(patch, original, face_restore.MOTION_KEEP)
        self.assertTrue(np.array_equal(ours, theirs))
        self.assertFalse(np.array_equal(ours, patch))

    def test_recipe_constants_match_longlive(self):
        self.assertEqual(swap_core.MOTION_KEEP, face_restore.MOTION_KEEP)
        self.assertEqual(swap_core.GFPGAN_BLEND, face_restore.SWAP_RESTORE_BLEND)
        self.assertEqual(swap_core.GFPGAN_SIZE, face_restore.RESTORE_SIZE)
        self.assertEqual(face_restore.SKIN_MATCH_BLEND, 0.0)


if __name__ == "__main__":
    unittest.main()
