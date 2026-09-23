# Colour match, motion keep and the face-region reply codec on synthetic images. Needs numpy + OpenCV (the .venv-fal has both), no GPU.
# Run: cd services/longlive && ../../.venv-fal/bin/python -m unittest -v test_face_blend
import unittest

try:
    import cv2
    import numpy as np

    import face_restore
    from frame_codec import RoiCodec, compose
except ImportError as error:  # pragma: no cover - plain-python runs skip these.
    cv2 = None
    SKIP_REASON = f"needs numpy + opencv: {error}"
else:
    SKIP_REASON = ""

SKIN = (120, 150, 200)
PALE = (175, 190, 220)


def lab_mean(image, mask):
    return cv2.cvtColor(image.astype(np.uint8), cv2.COLOR_BGR2LAB).astype(np.float32)[mask].mean(0)


@unittest.skipIf(cv2 is None, SKIP_REASON)
class MatchToRingTest(unittest.TestCase):
    def scene(self, surround=SKIN):
        size = 200
        alpha = np.zeros((size, size), np.float32)
        cv2.ellipse(alpha, (100, 100), (50, 60), 0, 0, 360, 1.0, -1)
        alpha = cv2.GaussianBlur(alpha, (0, 0), 2)
        region = np.zeros((size, size, 3), np.float32)
        region[:] = surround
        # The generated face under the mask is skin a little darker than the ring.
        region[alpha > 0.1] = (110, 140, 190)
        rng = np.random.default_rng(0)
        pasted = np.clip(np.array(PALE, np.float32) + rng.normal(0, 6, (size, size, 3)), 0, 255).astype(np.float32)
        return pasted, region, alpha

    def ring(self, alpha):
        touched = alpha > face_restore.RING_INNER_ALPHA
        return ~touched & (cv2.dilate(touched.astype(np.uint8), np.ones((31, 31), np.uint8)) > 0)

    def test_full_blend_moves_the_face_to_the_ring_skin_tone(self):
        pasted, region, alpha = self.scene()
        before = lab_mean(pasted, alpha > 0.5)
        target = lab_mean(region, self.ring(alpha))
        matched = face_restore.match_to_ring(pasted, region, alpha, 1.0)
        after = lab_mean(matched, alpha > 0.5)
        self.assertGreater(np.abs(before - target).max(), 10)
        self.assertLess(np.abs(after - target).max(), 3.0)

    def test_partial_blend_goes_part_way(self):
        pasted, region, alpha = self.scene()
        before = lab_mean(pasted, alpha > 0.5)[0]
        full = lab_mean(face_restore.match_to_ring(pasted, region, alpha, 1.0), alpha > 0.5)[0]
        half = lab_mean(face_restore.match_to_ring(pasted, region, alpha, 0.5), alpha > 0.5)[0]
        self.assertAlmostEqual(half, (before + full) / 2, delta=1.5)

    def test_a_ring_without_skin_leaves_the_patch_alone(self):
        for surround in [(200, 60, 40), (250, 250, 250), (20, 20, 20)]:
            pasted, region, alpha = self.scene(surround)
            np.testing.assert_array_equal(face_restore.match_to_ring(pasted, region, alpha, 1.0), pasted)

    def test_a_skin_coloured_wall_far_from_the_face_tone_is_ignored(self):
        # A bright beige wall passes the YCrCb skin box but not the closeness-to-face test.
        pasted, region, alpha = self.scene((170, 205, 240))
        np.testing.assert_array_equal(face_restore.match_to_ring(pasted, region, alpha, 1.0), pasted)


@unittest.skipIf(cv2 is None, SKIP_REASON)
class KeepMotionTest(unittest.TestCase):
    def test_keeps_the_generated_eyes_and_mouth_only(self):
        patch = np.full((128, 128, 3), 200, np.uint8)
        original = np.zeros((128, 128, 3), np.uint8)
        kept = face_restore.keep_motion(patch, original, 0.5)
        (lx, ly) = face_restore.ARCFACE_128_TEMPLATE[0]
        self.assertAlmostEqual(float(kept[int(ly * 128), int(lx * 128), 0]), 100, delta=6)
        self.assertEqual(int(kept[5, 64, 0]), 200)
        np.testing.assert_array_equal(face_restore.keep_motion(patch, original, 0.0), patch)


def jpeg(image, quality=90):
    return cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, quality])[1].tobytes()


@unittest.skipIf(cv2 is None, SKIP_REASON)
class FaceRegionCodecTest(unittest.TestCase):
    def setUp(self):
        rng = np.random.default_rng(1)
        self.frame = cv2.GaussianBlur(rng.integers(0, 255, (120, 96, 3), dtype=np.uint8), (0, 0), 3)

    def test_reply_covers_only_the_changed_box_and_composites_back(self):
        out = self.frame.copy()
        out[40:80, 30:60] = (0, 255, 0)
        coverage = np.zeros(self.frame.shape[:2], np.float32)
        coverage[40:80, 30:60] = 1.0
        reply = face_restore.face_region_reply(out, coverage)
        self.assertEqual((reply["x"], reply["y"]), (30, 40))
        composed = cv2.imdecode(np.frombuffer(compose(self.frame, reply), np.uint8), cv2.IMREAD_COLOR).astype(np.int16)
        self.assertLess(np.abs(composed[45:75, 35:55] - (0, 255, 0)).mean(), 8)
        reference = cv2.imdecode(np.frombuffer(jpeg(self.frame), np.uint8), cv2.IMREAD_COLOR).astype(np.int16)
        self.assertLess(np.abs(composed[:30] - reference[:30]).mean(), 1.5)

    def test_no_coverage_means_no_reply(self):
        self.assertIsNone(face_restore.face_region_reply(self.frame, np.zeros(self.frame.shape[:2], np.float32)))

    def test_malformed_or_oversized_replies_raise(self):
        roi = jpeg(np.zeros((10, 10, 3), np.uint8))
        alpha = cv2.imencode(".png", np.full((10, 10), 255, np.uint8))[1].tobytes()
        for bad in [
            b"bytes",
            {"x": 0, "y": 0, "roi": b"nope", "alpha": alpha},
            {"x": 90, "y": 0, "roi": roi, "alpha": alpha},
            {"x": -1, "y": 0, "roi": roi, "alpha": alpha},
            {"x": 0, "y": 0, "roi": roi, "alpha": cv2.imencode(".png", np.zeros((4, 4), np.uint8))[1].tobytes()},
            {"x": "0", "y": 0, "roi": roi, "alpha": alpha},
        ]:
            with self.assertRaises(ValueError):
                compose(self.frame, bad)

    def test_codec_keeps_untouched_frames_byte_identical_and_shrinks_transport(self):
        codec = RoiCodec(workers=2)
        self.addCleanup(codec.close)
        originals = [jpeg(self.frame, 95), jpeg(self.frame[::-1].copy(), 95)]
        transport, frames = codec.pack(originals)
        self.assertTrue(all(len(t) < len(o) for t, o in zip(transport, originals)))
        out = codec.unpack(originals, frames, [None, None])
        self.assertEqual(out, originals)


if __name__ == "__main__":
    unittest.main()
