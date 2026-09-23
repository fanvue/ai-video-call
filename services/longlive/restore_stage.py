# Per-session client for the second-GPU face pass (persona swap and restore). Cosmetic only: every failure path returns the block's original frames. No GPU imports so tests run anywhere.
from __future__ import annotations

import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from dataclasses import dataclass, field
from typing import Any, Callable

# A block is 32 frames, 1.33 s at 24 fps; generation leads by the measured lag, so a 2 s budget still keeps the client's jitter buffer.
RESTORE_TIMEOUT_S = 2.0
# Budget kept back from the remote wait for compositing the reply onto the originals.
COMPOSE_RESERVE_S = 0.2
# Consecutive failures before the session stops calling; a cold or broken restore GPU should cost at most this many timeouts.
MAX_CONSECUTIVE_FAILURES = 3
# Two blocks in flight so the round trip overlaps the next block's decode instead of adding to it.
MAX_INFLIGHT = 2
# Round trips live at once: MAX_INFLIGHT queued for the emitter, one it is collecting, one the decoder holds while the queue is full.
MAX_OUTSTANDING = MAX_INFLIGHT + 2
# Failures this soon after the first block went out do not count: the session-start burst ran every block past budget in prod while compute was 0.7 s.
WARMUP_GRACE_S = 8.0
# Once tripped, one block every this often tests the GPU in the background, so a blip costs seconds of raw faces rather than the session.
PROBE_INTERVAL_S = 10.0


class PassthroughCodec:
    """Sends the frames as they are; a reply frame is replacement JPEG bytes, or None to keep the original."""

    def pack(self, jpegs: list[bytes]):
        return jpegs, None

    def unpack(self, jpegs: list[bytes], state, replies: list) -> list[bytes]:
        if not all(reply is None or isinstance(reply, bytes) for reply in replies):
            raise ValueError("passthrough replies must be bytes or None")
        return [original if reply is None else reply for original, reply in zip(jpegs, replies)]

    def close(self) -> None:
        pass


class BlockingCall:
    """A blocking remote call behind the get/cancel handle; Modal's spawn()+get() added about 2.5 s over .remote() per block in the face A/B."""

    def __init__(self, pool: ThreadPoolExecutor, fn: Callable[[], Any]):
        self._future = pool.submit(fn)

    def get(self, timeout: float):
        return self._future.result(timeout=timeout)

    def cancel(self) -> None:
        # Drops a call still queued here; one already sent finishes remotely and is discarded, and the server drops blocks already past budget.
        self._future.cancel()


@dataclass
class RestoreTicket:
    jpegs: list[bytes]
    future: Future | None
    submitted_at: float
    deadline: float
    call: Any = None
    probe: bool = False
    started_at: float | None = None
    sent_at: float | None = None
    abandoned: bool = False
    cancel_sent: bool = False
    lock: threading.Lock = field(default_factory=threading.Lock)


@dataclass
class RestoreOutcome:
    jpegs: list[bytes]
    restored: bool
    round_trip_ms: float | None
    compute_ms: float | None = None
    swapped: int = 0


class RestoreStage:
    def __init__(
        self,
        spawn: Callable[[list[bytes]], Any],
        warm: Callable[[], object] | None = None,
        *,
        codec=None,
        timeout_s: float = RESTORE_TIMEOUT_S,
        max_failures: int = MAX_CONSECUTIVE_FAILURES,
        grace_s: float = WARMUP_GRACE_S,
        probe_interval_s: float = PROBE_INTERVAL_S,
        log: Callable[[str], None] = lambda line: print(line, flush=True),
    ):
        # `spawn(frames)` starts the remote call and returns a handle with get(timeout=) and cancel(), like a Modal FunctionCall.
        self._spawn = spawn
        self._codec = codec or PassthroughCodec()
        self._timeout_s = timeout_s
        self._max_failures = max_failures
        self._grace_s = grace_s
        self._probe_interval_s = probe_interval_s
        self._log = log
        self._lock = threading.Lock()
        # One thread per live round trip plus the warm-up, so no block's budget burns waiting for a local thread.
        self._pool = ThreadPoolExecutor(MAX_OUTSTANDING + 1)
        self._grace_until: float | None = None
        # Set while tripped by failures; a warm-up failure leaves it None, so that trip is final.
        self._probe_at: float | None = None
        self.consecutive_failures = 0
        self.tripped = False
        self.fail_open = 0
        self.skipped_warming = 0
        self.restored_blocks = 0
        self.cancelled = 0
        # Blocks before the restore GPU is up go out unrestored and do not count as failures.
        self._warm: Future | None = self._pool.submit(warm) if warm is not None else None

    def _ready(self) -> bool:
        warm = self._warm
        if warm is None:
            return True
        if not warm.done():
            return False
        if warm.exception() is not None:
            with self._lock:
                if not self.tripped:
                    self.tripped = True
                    self._log(f"[longlive] face restore warm-up failed, off for this session: {warm.exception()!r}")
            return False
        return True

    def submit(self, jpegs: list[bytes]) -> RestoreTicket:
        now = time.monotonic()
        ticket = RestoreTicket(list(jpegs), None, now, now + self._timeout_s)
        if not self.tripped:
            if self._ready():
                with self._lock:
                    if self._grace_until is None:
                        self._grace_until = now + self._grace_s
                ticket.future = self._pool.submit(self._round_trip, ticket)
            elif not self.tripped:
                self.skipped_warming += 1
        elif self._take_probe(now):
            ticket.probe = True
            ticket.future = self._pool.submit(self._round_trip, ticket)
            ticket.future.add_done_callback(lambda future: self._probe_done(ticket, future))
        return ticket

    def _take_probe(self, now: float) -> bool:
        with self._lock:
            if self._probe_at is None or now < self._probe_at:
                return False
            # Cleared while the probe is out, so only one block tests the GPU at a time.
            self._probe_at = None
            return True

    def _probe_done(self, ticket: RestoreTicket, future: Future) -> None:
        if future.cancelled():
            return
        error = future.exception()
        elapsed = time.monotonic() - ticket.submitted_at
        if error is None and elapsed <= self._timeout_s:
            with self._lock:
                self.tripped = False
                self.consecutive_failures = 0
                self._probe_at = None
            self._log(f"[longlive] face restore back on, probe block round trip {elapsed * 1000:.0f} ms")
            return
        with self._lock:
            self._probe_at = time.monotonic() + self._probe_interval_s
        reason = repr(error) if error is not None else f"{elapsed * 1000:.0f} ms, over the {self._timeout_s:.1f}s budget"
        self._log(f"[longlive] face restore probe failed ({reason}), next in {self._probe_interval_s:.0f}s")

    def _cancel(self, ticket: RestoreTicket) -> None:
        # future.cancel() cannot stop a call already running remotely; the handle's cancel does, so late blocks never pile up on the GPU.
        with ticket.lock:
            call = ticket.call
            if call is None or ticket.cancel_sent:
                return
            ticket.cancel_sent = True
        try:
            call.cancel()
        except Exception as error:  # noqa: BLE001 - a failed cancel only means the GPU finishes a block nobody reads.
            self._log(f"[longlive] face restore cancel failed: {error!r}")
        with self._lock:
            self.cancelled += 1

    def _round_trip(self, ticket: RestoreTicket):
        ticket.started_at = time.monotonic()
        frames, state = self._codec.pack(ticket.jpegs)
        ticket.sent_at = time.monotonic()
        call = self._spawn(frames)
        with ticket.lock:
            ticket.call = call
            abandoned = ticket.abandoned
        if abandoned:
            self._cancel(ticket)
            raise FutureTimeout("abandoned before the call started")
        wait = ticket.deadline - COMPOSE_RESERVE_S - time.monotonic()
        try:
            if wait <= 0:
                raise FutureTimeout("no budget left after spawn")
            reply = call.get(timeout=wait)
        except Exception:
            self._cancel(ticket)
            raise
        if not isinstance(reply, dict) or reply.get("expired"):
            raise ValueError("restore reply expired or malformed")
        replies = reply.get("frames")
        if not isinstance(replies, list) or len(replies) != len(ticket.jpegs):
            raise ValueError(f"restore returned {len(replies) if isinstance(replies, list) else type(replies).__name__} frames for {len(ticket.jpegs)}")
        compute_ms = reply.get("computeMs")
        swapped = reply.get("swapped", 0)
        replied_at = time.monotonic()
        jpegs = self._codec.unpack(ticket.jpegs, state, replies)
        # Splits the round trip so a slow block shows whether it waited locally, packed, sat in transport or composited.
        timing = (
            f"queued {_ms(ticket.started_at - ticket.submitted_at)}, pack {_ms(ticket.sent_at - ticket.started_at)}, "
            f"call {_ms(replied_at - ticket.sent_at)} (remote receive delay {_fmt(reply.get('receiveDelayMs'))}, compute {_fmt(compute_ms)}), "
            f"compose {_ms(time.monotonic() - replied_at)}"
        )
        return jpegs, compute_ms, swapped if isinstance(swapped, int) else 0, timing

    def collect(self, ticket: RestoreTicket) -> RestoreOutcome:
        """Waits at most until the ticket's deadline; any error, timeout or malformed reply sends the originals."""
        # A probe never holds the stream: while tripped the lead has no restore lag left to absorb a 2 s wait.
        if ticket.future is None or ticket.probe:
            return RestoreOutcome(ticket.jpegs, False, None)
        remaining = ticket.deadline - time.monotonic()
        try:
            jpegs, compute_ms, swapped, timing = ticket.future.result(timeout=max(remaining, 0.0))
            if len(jpegs) != len(ticket.jpegs):
                raise ValueError(f"composited {len(jpegs)} frames for {len(ticket.jpegs)}")
        except FutureTimeout:
            with ticket.lock:
                ticket.abandoned = True
            if not ticket.future.done():
                self._cancel(ticket)
            return self._failed(ticket, f"timed out after {self._timeout_s:.1f}s")
        except Exception as error:  # noqa: BLE001 - restore is cosmetic; any failure sends the block unrestored.
            return self._failed(ticket, repr(error))
        with self._lock:
            self.consecutive_failures = 0
            self.restored_blocks += 1
            # Any success proves the GPU answers in budget; only a warm-up failure trips with nothing sent, so this never undoes it.
            rearmed = self.tripped
            self.tripped = False
            self._probe_at = None
        round_trip_ms = (time.monotonic() - ticket.submitted_at) * 1000
        self._log(f"[longlive] face restore round trip {round_trip_ms:.0f} ms: {timing}")
        if rearmed:
            self._log("[longlive] face restore back on after a block landed in budget")
        compute = float(compute_ms) if isinstance(compute_ms, (int, float)) and not isinstance(compute_ms, bool) else None
        return RestoreOutcome(jpegs, True, round_trip_ms, compute, swapped)

    def _failed(self, ticket: RestoreTicket, reason: str) -> RestoreOutcome:
        now = time.monotonic()
        with self._lock:
            self.fail_open += 1
            in_grace = self._grace_until is not None and ticket.submitted_at < self._grace_until
            if not in_grace:
                self.consecutive_failures += 1
            trip = not self.tripped and self.consecutive_failures >= self._max_failures
            if trip:
                self.tripped = True
                self._probe_at = now + self._probe_interval_s
        grace = ", warm-up grace, not counted" if in_grace else ""
        self._log(f"[longlive] face restore failed open ({reason}{grace}), block sent unrestored")
        if trip:
            self._log(
                f"[longlive] face restore off after {self._max_failures} consecutive failures, probing a block every {self._probe_interval_s:.0f}s"
            )
        return RestoreOutcome(ticket.jpegs, False, None)

    def close(self) -> None:
        self._pool.shutdown(wait=False, cancel_futures=True)
        self._codec.close()


def _ms(seconds: float) -> str:
    return f"{seconds * 1000:.0f} ms"


def _fmt(ms) -> str:
    return f"{ms:.0f} ms" if isinstance(ms, (int, float)) and not isinstance(ms, bool) else "n/a"

