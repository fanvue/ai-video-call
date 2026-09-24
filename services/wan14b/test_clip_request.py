# Pure request checks: no GPU, no network.
# Run: cd services/wan14b && ../../.venv-fal/bin/python -m unittest -v test_clip_request
import base64
import unittest
from unittest import mock

import clip_request as cr

JPEG = b"\xff\xd8\xff\xe0" + b"0" * 64
PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 64


class FrameCountTest(unittest.TestCase):
    def test_default_is_81(self):
        self.assertEqual(cr.frame_count(), 81)

    def test_accepts_4k_plus_1_in_range(self):
        for n in (17, 33, 49, 81):
            self.assertEqual(cr.frame_count(num_frames=n), n)

    def test_rejects_off_grid_or_out_of_range(self):
        for n in (16, 80, 13, 85, 0, -3):
            with self.assertRaises(ValueError):
                cr.frame_count(num_frames=n)

    def test_rejects_bool_and_float_frames(self):
        for n in (True, 81.0, "81"):
            with self.assertRaises(ValueError):
                cr.frame_count(num_frames=n)

    def test_duration_rounds_to_grid_and_clamps(self):
        self.assertEqual(cr.frame_count(duration_s=5), 81)
        self.assertEqual(cr.frame_count(duration_s=3), 49)
        self.assertEqual(cr.frame_count(duration_s=0.1), 17)
        self.assertEqual(cr.frame_count(duration_s=30), 81)

    def test_duration_rejects_nan_and_bool(self):
        for d in (float("nan"), True, "5"):
            with self.assertRaises(ValueError):
                cr.frame_count(duration_s=d)

    def test_both_is_an_error(self):
        with self.assertRaises(ValueError):
            cr.frame_count(num_frames=81, duration_s=5)


class PromptTest(unittest.TestCase):
    def test_strips_and_limits(self):
        self.assertEqual(cr.check_prompt("  hi  "), "hi")
        for bad in ("", "   ", None, 3, "x" * (cr.MAX_PROMPT_CHARS + 1)):
            with self.assertRaises(ValueError):
                cr.check_prompt(bad)


class ImageInputTest(unittest.TestCase):
    def test_base64_and_data_uri(self):
        encoded = base64.b64encode(JPEG).decode()
        self.assertEqual(cr.decode_base64_image(encoded), JPEG)
        self.assertEqual(cr.decode_base64_image(f"data:image/png;base64,{base64.b64encode(PNG).decode()}"), PNG)

    def test_rejects_non_image_and_bad_base64(self):
        with self.assertRaises(ValueError):
            cr.decode_base64_image(base64.b64encode(b"GIF89a....").decode())
        with self.assertRaises(ValueError):
            cr.decode_base64_image("not base64!!")
        with self.assertRaises(ValueError):
            cr.decode_base64_image("data:image/png,rawtext")

    def test_rejects_oversize(self):
        with self.assertRaises(ValueError):
            cr.check_image_bytes(JPEG + b"0" * cr.MAX_IMAGE_BYTES)

    def test_exactly_one_source(self):
        with self.assertRaises(ValueError):
            cr.seed_image_bytes(None, None)
        with self.assertRaises(ValueError):
            cr.seed_image_bytes("https://x/y.jpg", base64.b64encode(JPEG).decode())

    def test_url_must_be_https(self):
        for bad in ("http://x/y.jpg", "file:///etc/passwd", "ftp://x/y", "https://"):
            with self.assertRaises(ValueError):
                cr.check_image_url(bad)
        self.assertEqual(cr.check_image_url("https://blob.example/y.jpg"), "https://blob.example/y.jpg")

    def test_fetch_checks_scheme_before_network(self):
        with mock.patch("urllib.request.urlopen") as urlopen:
            with self.assertRaises(ValueError):
                cr.fetch_image("http://x/y.jpg")
            urlopen.assert_not_called()


    def test_tone_reference_is_optional_and_single_source(self):
        self.assertIsNone(cr.tone_reference_bytes(None, None))
        self.assertEqual(cr.tone_reference_bytes(None, base64.b64encode(PNG).decode()), PNG)
        with self.assertRaises(ValueError):
            cr.tone_reference_bytes("https://x/y.png", base64.b64encode(PNG).decode())
        with mock.patch("urllib.request.urlopen") as urlopen:
            with self.assertRaises(ValueError):
                cr.tone_reference_bytes("http://x/y.png", None)
            urlopen.assert_not_called()

    def test_prompt_cap_fits_planner_prompts(self):
        self.assertEqual(cr.check_prompt("x" * 3000), "x" * 3000)


class SeedGateTest(unittest.TestCase):
    def test_fails_closed(self):
        with self.assertRaises(ValueError):
            cr.seed_gate(None)
        with self.assertRaises(ValueError):
            cr.seed_gate(cr.SEED_MIN_SIMILARITY - 0.01)
        cr.seed_gate(cr.SEED_MIN_SIMILARITY)
        cr.seed_gate(0.9)


if __name__ == "__main__":
    unittest.main()
