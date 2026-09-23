# Seed face tone lock on synthetic frames; needs numpy + OpenCV, no GPU.
# Run: cd services/wan14b && ../../.venv-fal/bin/python -m unittest -v test_seed_lock
import unittest

try:
    import cv2
    import numpy as np

    import seed_lock as sl
except ImportError as error:  # pragma: no cover - plain-python runs skip these.
    SKIP_REASON = f"needs numpy + opencv: {error}"
else:
    SKIP_REASON = ""

# Template landmarks placed on a 256 px face centred in a 480x832 frame.
KPS = None if SKIP_REASON else (sl.FFHQ_TEMPLATE * 256 + np.array([112, 200], np.float32))


def frame(value):
    out = np.full((832, 480, 3), 128, np.uint8)
    out[200:456, 112:368] = value
    return out


@unittest.skipIf(SKIP_REASON, SKIP_REASON)
class SeedLockTest(unittest.TestCase):
    def ref(self, value):
        stats, _ = sl.face_stats(frame(value), KPS)
        return stats

    def test_pulls_face_halfway_toward_reference(self):
        ref = self.ref((150, 150, 150))
        out, locked = sl.tone_lock(frame((90, 90, 90)), KPS, ref)
        self.assertTrue(locked)
        lum_ref = cv2.cvtColor(frame((150, 150, 150)), cv2.COLOR_BGR2LAB)[328, 240, 0]
        lum_in = cv2.cvtColor(frame((90, 90, 90)), cv2.COLOR_BGR2LAB)[328, 240, 0]
        lum_out = cv2.cvtColor(out, cv2.COLOR_BGR2LAB)[328, 240, 0]
        self.assertAlmostEqual(float(lum_out), (float(lum_ref) + float(lum_in)) / 2, delta=3)

    def test_background_untouched(self):
        out, _ = sl.tone_lock(frame((90, 90, 90)), KPS, self.ref((150, 150, 150)))
        np.testing.assert_array_equal(out[:100], frame((90, 90, 90))[:100])

    def test_matching_face_is_a_no_op(self):
        src = frame((120, 110, 100))
        out, locked = sl.tone_lock(src, KPS, self.ref((120, 110, 100)))
        self.assertTrue(locked)
        self.assertLessEqual(int(np.abs(out.astype(int) - src.astype(int)).max()), 2)

    def test_no_face_or_reference_leaves_seed(self):
        src = frame((90, 90, 90))
        for kps, ref in ((None, self.ref((150, 150, 150))), (KPS, None)):
            out, locked = sl.tone_lock(src, kps, ref)
            self.assertFalse(locked)
            self.assertIs(out, src)

    def test_zero_blend_is_identity(self):
        src = frame((90, 90, 90))
        out, _ = sl.tone_lock(src, KPS, self.ref((150, 150, 150)), blend=0.0)
        np.testing.assert_array_equal(out, src)


if __name__ == "__main__":
    unittest.main()
