# Fail-open, cancellation, ordering and circuit-breaker behaviour of the face-restore stage, no GPU.
# Run: cd services/longlive && python -m unittest -v test_restore_stage
import threading
import time
import unittest

from restore_stage import RestoreStage

FRAMES = [b"a", b"b", b"c"]


class FakeCall:
    """Stands in for a Modal FunctionCall: runs the work on a thread, get() times out, cancel() is recorded."""

    def __init__(self, work, frames):
        self.cancelled = threading.Event()
        self._done = threading.Event()
        self._result = None
        self._error = None

        def run():
            try:
                self._result = work(frames)
            except Exception as error:  # noqa: BLE001 - surfaced from get(), like a remote exception.
                self._error = error
            self._done.set()

        threading.Thread(target=run, daemon=True).start()

    def get(self, timeout=None):
        if not self._done.wait(timeout):
            raise TimeoutError("call timed out")
        if self._error is not None:
            raise self._error
        return self._result

    def cancel(self):
        self.cancelled.set()


def reply(frames, compute_ms=12.0, swapped=0):
    return {"frames": frames, "computeMs": compute_ms, "swapped": swapped}


class RestoreStageTest(unittest.TestCase):
    def stage(self, work, warm=None, **kwargs):
        self.logs = []
        self.calls = []

        def spawn(frames):
            call = FakeCall(work, frames)
            self.calls.append(call)
            return call

        stage = RestoreStage(spawn, warm, log=self.logs.append, **kwargs)
        self.addCleanup(stage.close)
        return stage

    def run_block(self, stage, frames=FRAMES):
        return stage.collect(stage.submit(list(frames)))

    def test_restored_frames_replace_originals_and_none_keeps_the_original(self):
        stage = self.stage(lambda jpegs: reply([b"A", None, b"C"], compute_ms=40.5, swapped=2))
        outcome = self.run_block(stage)
        self.assertEqual(outcome.jpegs, [b"A", b"b", b"C"])
        self.assertTrue(outcome.restored)
        self.assertIsNotNone(outcome.round_trip_ms)
        self.assertEqual((outcome.compute_ms, outcome.swapped), (40.5, 2))
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

    def test_wrong_frame_count_and_malformed_replies_fail_open(self):
        for bad in [reply([b"A"]), [b"A", b"B", b"C"], {"frames": "nope"}, reply([1, 2, 3]), {"expired": True}]:
            stage = self.stage(lambda jpegs, bad=bad: bad)
            self.assertEqual(self.run_block(stage).jpegs, FRAMES, bad)
            self.assertEqual(stage.fail_open, 1)

    def test_timeout_fails_open_and_cancels_the_remote_call(self):
        release = threading.Event()
        self.addCleanup(release.set)
        stage = self.stage(lambda jpegs: release.wait(5) and reply(jpegs), timeout_s=0.3)
        started = time.monotonic()
        outcome = self.run_block(stage)
        self.assertLess(time.monotonic() - started, 1.0)
        self.assertEqual(outcome.jpegs, FRAMES)
        self.assertFalse(outcome.restored)
        self.assertEqual(stage.fail_open, 1)
        self.assertTrue(self.calls[0].cancelled.wait(1))
        deadline = time.monotonic() + 1
        while stage.cancelled == 0 and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual(stage.cancelled, 1)

    def test_a_late_reply_never_replaces_frames_after_the_deadline(self):
        stage = self.stage(lambda jpegs: time.sleep(0.4) or reply([b"LATE"] * len(jpegs)), timeout_s=0.2)
        self.assertEqual(self.run_block(stage).jpegs, FRAMES)
        time.sleep(0.4)
        self.assertEqual(self.run_block(stage, [b"x"]).jpegs, [b"x"])

    def test_slow_spawn_is_abandoned_then_cancelled_once_it_returns(self):
        release = threading.Event()
        self.addCleanup(release.set)
        self.logs = []
        calls = []

        def spawn(frames):
            release.wait(5)
            call = FakeCall(lambda f: reply(f), frames)
            calls.append(call)
            return call

        stage = RestoreStage(spawn, None, timeout_s=0.1, log=self.logs.append)
        self.addCleanup(stage.close)
        self.assertEqual(stage.collect(stage.submit(FRAMES)).jpegs, FRAMES)
        release.set()
        deadline = time.monotonic() + 2
        while not calls and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue(calls[0].cancelled.wait(1))

    def test_blocks_come_back_in_submission_order_whatever_order_calls_finish(self):
        delays = {b"1": 0.15, b"2": 0.0, b"3": 0.05}
        stage = self.stage(lambda jpegs: time.sleep(delays[jpegs[0]]) or reply([jpegs[0].upper() + b"!"]))
        tickets = [stage.submit([key]) for key in (b"1", b"2", b"3")]
        self.assertEqual([stage.collect(ticket).jpegs for ticket in tickets], [[b"1!"], [b"2!"], [b"3!"]])

    def test_breaker_trips_after_consecutive_failures_and_stops_calling(self):
        def boom(jpegs):
            raise RuntimeError("nope")

        stage = self.stage(boom, max_failures=3)
        for _ in range(6):
            self.assertEqual(self.run_block(stage).jpegs, FRAMES)
        self.assertEqual(len(self.calls), 3)
        self.assertTrue(stage.tripped)
        self.assertEqual(stage.fail_open, 3)
        self.assertTrue(any("off for this session" in line for line in self.logs))

    def test_timeouts_trip_the_breaker_too(self):
        release = threading.Event()
        self.addCleanup(release.set)
        stage = self.stage(lambda jpegs: release.wait(5) and reply(jpegs), timeout_s=0.25, max_failures=2)
        for _ in range(4):
            self.run_block(stage)
        self.assertTrue(stage.tripped)
        self.assertEqual(len(self.calls), 2)
        self.assertTrue(all(call.cancelled.wait(1) for call in self.calls))

    def test_a_success_resets_the_consecutive_count(self):
        results = iter([RuntimeError(), RuntimeError(), reply(FRAMES), RuntimeError(), RuntimeError()])

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
        stage = self.stage(lambda jpegs: reply([b"R"] * len(jpegs)), warm=lambda: warmed.wait(5))
        self.assertEqual(self.run_block(stage).jpegs, FRAMES)
        self.assertEqual((self.calls, stage.skipped_warming, stage.fail_open), ([], 1, 0))
        warmed.set()
        stage._warm.result(1)
        self.assertEqual(self.run_block(stage).jpegs, [b"R"] * 3)

    def test_failed_warm_up_turns_restore_off(self):
        def cold():
            raise RuntimeError("no GPU")

        stage = self.stage(lambda jpegs: reply(jpegs), warm=cold)
        stage._warm.exception(1)
        self.assertEqual(self.run_block(stage).jpegs, FRAMES)
        self.assertTrue(stage.tripped)
        self.assertEqual(self.calls, [])

    def test_codec_packs_before_the_call_and_unpacks_after(self):
        class Codec:
            def pack(self, jpegs):
                return [j + b"-t" for j in jpegs], "state"

            def unpack(self, jpegs, state, replies):
                return [f"{state}:{r}".encode() for r in replies]

            def close(self):
                pass

        seen = []
        stage = self.stage(lambda frames: seen.append(frames) or reply(["x", "y", "z"]), codec=Codec())
        self.assertEqual(self.run_block(stage).jpegs, [b"state:x", b"state:y", b"state:z"])
        self.assertEqual(seen, [[b"a-t", b"b-t", b"c-t"]])


if __name__ == "__main__":
    unittest.main()
