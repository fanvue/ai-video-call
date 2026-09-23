# Fail-open and circuit-breaker behaviour of the face-restore stage, no GPU.
# Run: cd services/longlive && python -m unittest -v test_restore_stage
import threading
import unittest

from restore_stage import RestoreStage

FRAMES = [b"a", b"b", b"c"]


class RestoreStageTest(unittest.TestCase):
    def stage(self, restore, warm=None, **kwargs):
        self.logs = []
        stage = RestoreStage(restore, warm, log=self.logs.append, **kwargs)
        self.addCleanup(stage.close)
        return stage

    def run_block(self, stage, frames=FRAMES):
        return stage.collect(stage.submit(list(frames)))

    def test_restored_frames_replace_originals_and_none_keeps_the_original(self):
        stage = self.stage(lambda jpegs: [b"A", None, b"C"])
        outcome = self.run_block(stage)
        self.assertEqual(outcome.jpegs, [b"A", b"b", b"C"])
        self.assertTrue(outcome.restored)
        self.assertIsNotNone(outcome.round_trip_ms)
        self.assertEqual((stage.fail_open, stage.consecutive_failures), (0, 0))

    def test_error_sends_the_block_unrestored(self):
        def boom(jpegs):
            raise RuntimeError("gpu gone")

        stage = self.stage(boom)
        outcome = self.run_block(stage)
        self.assertEqual(outcome.jpegs, FRAMES)
        self.assertFalse(outcome.restored)
        self.assertEqual(stage.fail_open, 1)
        self.assertTrue(any("failed open" in line for line in self.logs))

    def test_wrong_frame_count_fails_open(self):
        stage = self.stage(lambda jpegs: jpegs[:1])
        self.assertEqual(self.run_block(stage).jpegs, FRAMES)
        self.assertEqual(stage.fail_open, 1)

    def test_timeout_fails_open_without_waiting_for_the_call(self):
        release = threading.Event()
        self.addCleanup(release.set)
        stage = self.stage(lambda jpegs: release.wait(5) and jpegs, timeout_s=0.05)
        outcome = self.run_block(stage)
        self.assertEqual(outcome.jpegs, FRAMES)
        self.assertFalse(outcome.restored)
        self.assertEqual(stage.fail_open, 1)

    def test_breaker_trips_after_consecutive_failures_and_stops_calling(self):
        calls = []

        def boom(jpegs):
            calls.append(1)
            raise RuntimeError("nope")

        stage = self.stage(boom, max_failures=3)
        for _ in range(6):
            self.assertEqual(self.run_block(stage).jpegs, FRAMES)
        self.assertEqual(len(calls), 3)
        self.assertTrue(stage.tripped)
        self.assertEqual(stage.fail_open, 3)
        self.assertTrue(any("off for this session" in line for line in self.logs))

    def test_a_success_resets_the_consecutive_count(self):
        results = iter([RuntimeError(), RuntimeError(), FRAMES, RuntimeError(), RuntimeError()])

        def flaky(jpegs):
            result = next(results)
            if isinstance(result, Exception):
                raise result
            return result

        stage = self.stage(flaky, max_failures=3)
        for _ in range(5):
            self.run_block(stage)
        self.assertFalse(stage.tripped)
        self.assertEqual(stage.consecutive_failures, 2)

    def test_blocks_before_warm_up_pass_through_and_are_not_failures(self):
        warmed = threading.Event()
        self.addCleanup(warmed.set)
        calls = []
        stage = self.stage(lambda jpegs: calls.append(1) or [b"R"] * len(jpegs), warm=lambda: warmed.wait(5))
        self.assertEqual(self.run_block(stage).jpegs, FRAMES)
        self.assertEqual((calls, stage.skipped_warming, stage.fail_open), ([], 1, 0))
        warmed.set()
        stage._warm.result(1)
        self.assertEqual(self.run_block(stage).jpegs, [b"R"] * 3)

    def test_failed_warm_up_turns_restore_off(self):
        def cold():
            raise RuntimeError("no GPU")

        calls = []
        stage = self.stage(lambda jpegs: calls.append(1) or jpegs, warm=cold)
        stage._warm.exception(1)
        self.assertEqual(self.run_block(stage).jpegs, FRAMES)
        self.assertTrue(stage.tripped)
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
