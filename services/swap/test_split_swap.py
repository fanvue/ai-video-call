# A split swap (two frame ranges on two containers) must play back as the whole-clip swap: same frames, same order.
# Run: cd services/swap && ../../.venv-fal/bin/python -m unittest -v test_split_swap
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import cv2
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "longlive"))

import swap_core  # noqa: E402

FRAMES = 60
SPLIT = 25


class FakeDetector:
    def get(self, frame):
        return ["face"]


class FakeSwapEngine:
    # Duck-types what SwapEngine.swap_clip touches; the "swap" is a per-frame pure function, like longlive with KPS smoothing off.
    detector = FakeDetector()
    identity = FakeDetector()

    # *options: the recipe, restore and mask flags vary by branch; none of them change a pure per-frame fake.
    def swap_frame(self, frame, *options):
        return 255 - frame

    def finish_seed(self, last_swapped):
        return last_swapped, 0, False, 0.0, 0.0

    def similarity(self, frame, source_face):
        return None

    def encode_png(self, frame):
        return cv2.imencode(".png", frame)[1].tobytes()


def write_indexed_clip(path: str) -> None:
    # Frame i is one flat grey level, so its index survives the lossy x264 encode.
    with tempfile.TemporaryDirectory() as directory:
        for index in range(FRAMES):
            cv2.imwrite(os.path.join(directory, f"{index:03d}.png"), np.full((64, 64, 3), 20 + index * 3, np.uint8))
        subprocess.run(
            [
                "ffmpeg", "-loglevel", "error", "-y", "-framerate", "24", "-i", os.path.join(directory, "%03d.png"),
                "-f", "lavfi", "-i", "sine=frequency=440:duration=2.5", "-shortest",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "10", "-c:a", "aac", path,
            ],
            check=True,
        )


def swap(path: str, output: str) -> None:
    swap_core.SwapEngine.swap_clip(FakeSwapEngine(), path, None, output, workers=2, recipe="longlive")


def frame_levels(path: str) -> list[int]:
    capture = cv2.VideoCapture(path)
    levels = []
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        levels.append(int(round(float(frame.mean()))))
    capture.release()
    return levels


class SplitSwapTest(unittest.TestCase):
    def test_segments_concatenated_equal_the_whole_clip_swap(self):
        with tempfile.TemporaryDirectory() as directory:
            source = os.path.join(directory, "source.mp4")
            write_indexed_clip(source)
            whole = os.path.join(directory, "whole.mp4")
            swap(source, whole)
            parts = []
            for name, start, end in (("a", None, SPLIT), ("b", SPLIT, None)):
                segment = os.path.join(directory, f"{name}.mp4")
                swap_core.trim_frames(source, segment, start, end)
                swapped = os.path.join(directory, f"{name}-swapped.mp4")
                swap(segment, swapped)
                parts.append(frame_levels(swapped))
            whole_levels = frame_levels(whole)
            self.assertEqual(len(whole_levels), FRAMES)
            self.assertEqual([len(part) for part in parts], [SPLIT, FRAMES - SPLIT])
            joined = parts[0] + parts[1]
            # Grey levels 3 apart per frame: within 1 means the same frame, in the same place.
            self.assertTrue(all(abs(a - b) <= 1 for a, b in zip(joined, whole_levels)), (joined, whole_levels))
            self.assertEqual(joined, sorted(joined, reverse=True))

    def test_the_segments_keep_their_share_of_the_audio(self):
        with tempfile.TemporaryDirectory() as directory:
            source = os.path.join(directory, "source.mp4")
            write_indexed_clip(source)
            segment = os.path.join(directory, "b.mp4")
            swap_core.trim_frames(source, segment, SPLIT, None)
            probe = subprocess.run(
                ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "format=duration", "-of", "csv=p=0", segment],
                capture_output=True, text=True, check=True,
            )
            self.assertAlmostEqual(float(probe.stdout.strip()), (FRAMES - SPLIT) / 24, delta=0.1)

    def test_swap_clip_from_url_swaps_only_the_requested_frames(self):
        seen = []

        def fake_swap(engine, video, source_face, model, options):
            with tempfile.NamedTemporaryFile(suffix=".mp4") as file:
                file.write(video)
                file.flush()
                seen.append(frame_levels(file.name))
            return {"stats": {key: 0 for key in ("frames", "swap_ms", "ms_per_frame", "enhance_ms")} | {"recipe": "longlive", "restored": True, "similarity_before": None, "similarity_after": None, "sharpness_before": None, "sharpness_after": None}}

        with tempfile.TemporaryDirectory() as directory:
            source = os.path.join(directory, "source.mp4")
            write_indexed_clip(source)
            with mock.patch.object(swap_core, "download", side_effect=lambda _url, path: shutil.copy(source, path)), mock.patch.object(
                swap_core, "check_swap_options"
            ), mock.patch.object(swap_core, "persona_source_face", return_value="face"), mock.patch.object(
                swap_core, "swap_clip_with_face", side_effect=fake_swap
            ):
                swap_core.swap_clip_from_url(None, "https://x.fal.media/a.mp4", None, "synth-persona-01", start_frame=SPLIT)
                swap_core.swap_clip_from_url(None, "https://x.fal.media/a.mp4", None, "synth-persona-01")
        self.assertEqual([len(levels) for levels in seen], [FRAMES - SPLIT, FRAMES])
        self.assertLessEqual(abs(seen[0][0] - seen[1][SPLIT]), 1)

    def test_rejects_an_empty_or_negative_range(self):
        with self.assertRaises(ValueError):
            swap_core.check_frame_range(-1, None)
        with self.assertRaises(ValueError):
            swap_core.check_frame_range(30, 30)
        swap_core.check_frame_range(None, None)
        swap_core.check_frame_range(None, 100)
        swap_core.check_frame_range(100, None)


if __name__ == "__main__":
    unittest.main()
