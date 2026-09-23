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


def write_indexed_clip(path: str, frames: int = FRAMES, audio_sec: float = FRAMES / 24) -> None:
    # Frame i is one flat grey level, so its index survives the lossy x264 encode (only the first 78 stay distinct).
    with tempfile.TemporaryDirectory() as directory:
        for index in range(frames):
            cv2.imwrite(os.path.join(directory, f"{index:03d}.png"), np.full((64, 64, 3), 20 + index * 3 % 236, np.uint8))
        subprocess.run(
            [
                "ffmpeg", "-loglevel", "error", "-y", "-framerate", "24", "-i", os.path.join(directory, "%03d.png"),
                "-f", "lavfi", "-i", f"sine=frequency=440:duration={audio_sec}",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "10", "-c:a", "aac", path,
            ],
            check=True,
        )


def swap(path: str, output: str) -> None:
    swap_core.SwapEngine.swap_clip(FakeSwapEngine(), path, None, output, workers=2, recipe="longlive")


def audio_duration(path: str) -> float:
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=duration", "-of", "csv=p=0", path],
        capture_output=True, text=True, check=True,
    )
    return float(probe.stdout.strip())


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

    def test_the_writer_keeps_every_frame_and_caps_the_audio_to_them(self):
        # Audio a second longer than the video: the output keeps all 120 frames and only their 5 s of audio.
        with tempfile.TemporaryDirectory() as directory:
            source = os.path.join(directory, "source.mp4")
            write_indexed_clip(source, frames=120, audio_sec=6)
            whole = os.path.join(directory, "whole.mp4")
            swap(source, whole)
            self.assertEqual(len(frame_levels(whole)), 120)
            self.assertAlmostEqual(audio_duration(whole), 5, delta=0.05)
            head = os.path.join(directory, "head.mp4")
            swap_core.trim_frames(source, head, None, 100)
            head_swapped = os.path.join(directory, "head-swapped.mp4")
            swap(head, head_swapped)
            self.assertEqual(len(frame_levels(head_swapped)), 100)
            self.assertAlmostEqual(audio_duration(head_swapped), 100 / 24, delta=0.05)

    def test_writer_args_drop_shortest_and_cap_the_audio_input(self):
        # ffmpeg 4.4 with -shortest dropped a clip's last 40 frames; the local ffmpeg does not, so the args are pinned too.
        args = swap_core.writer_args(480, 832, 24.0, 100, "in.mp4", "out.mp4")
        self.assertNotIn("-shortest", args)
        audio_input = args.index("in.mp4")
        self.assertEqual(args[audio_input - 3 : audio_input], ["-t", "4.166667", "-i"])
        self.assertNotIn("-t", swap_core.writer_args(480, 832, 24.0, 0, "in.mp4", "out.mp4"))

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
