# Per-session client for the second-GPU face restore. Cosmetic only: every failure path returns the block's original frames. No GPU imports so tests run anywhere.
from __future__ import annotations

import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from dataclasses import dataclass
from typing import Callable

# A block is 32 frames, 1.33 s at 24 fps: a round trip past this would start eating the client's jitter buffer.
RESTORE_TIMEOUT_S = 1.2
# Consecutive failures before the session stops calling; a cold or broken restore GPU should cost at most this many timeouts.
MAX_CONSECUTIVE_FAILURES = 3
# Two blocks in flight so the round trip overlaps the next block's decode instead of adding to it.
MAX_INFLIGHT = 2


@dataclass
class RestoreTicket:
    jpegs: list[bytes]
    future: Future | None
    submitted_at: float


@dataclass
class RestoreOutcome:
    jpegs: list[bytes]
    restored: bool
    round_trip_ms: float | None


class RestoreStage:
    def __init__(
        self,
        restore_block: Callable[[list[bytes]], list[bytes | None]],
        warm: Callable[[], object] | None = None,
        *,
        timeout_s: float = RESTORE_TIMEOUT_S,
        max_failures: int = MAX_CONSECUTIVE_FAILURES,
        log: Callable[[str], None] = lambda line: print(line, flush=True),
    ):
        self._restore_block = restore_block
        self._timeout_s = timeout_s
        self._max_failures = max_failures
        self._log = log
        self._lock = threading.Lock()
        self._pool = ThreadPoolExecutor(MAX_INFLIGHT + 1)
        self.consecutive_failures = 0
        self.tripped = False
        self.fail_open = 0
        self.skipped_warming = 0
        self.restored_blocks = 0
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
        future = None
        if not self.tripped:
            if self._ready():
                future = self._pool.submit(self._restore_block, jpegs)
            elif not self.tripped:
                self.skipped_warming += 1
        return RestoreTicket(jpegs, future, time.monotonic())

    def collect(self, ticket: RestoreTicket) -> RestoreOutcome:
        """Waits at most until the ticket's deadline; any error, timeout or malformed reply sends the originals."""
        if ticket.future is None:
            return RestoreOutcome(ticket.jpegs, False, None)
        remaining = ticket.submitted_at + self._timeout_s - time.monotonic()
        try:
            result = ticket.future.result(timeout=max(remaining, 0.0))
            if not isinstance(result, list) or len(result) != len(ticket.jpegs):
                raise ValueError(f"restore returned {len(result) if isinstance(result, list) else type(result).__name__} frames for {len(ticket.jpegs)}")
        except FutureTimeout:
            ticket.future.cancel()
            return self._failed(ticket, f"timed out after {self._timeout_s:.1f}s")
        except Exception as error:  # noqa: BLE001 - restore is cosmetic; any failure sends the block unrestored.
            return self._failed(ticket, repr(error))
        with self._lock:
            self.consecutive_failures = 0
            self.restored_blocks += 1
        # None means no face in that frame: the original bytes go out untouched.
        jpegs = [original if restored is None else restored for original, restored in zip(ticket.jpegs, result)]
        return RestoreOutcome(jpegs, True, (time.monotonic() - ticket.submitted_at) * 1000)

    def _failed(self, ticket: RestoreTicket, reason: str) -> RestoreOutcome:
        with self._lock:
            self.fail_open += 1
            self.consecutive_failures += 1
            trip = not self.tripped and self.consecutive_failures >= self._max_failures
            if trip:
                self.tripped = True
        self._log(f"[longlive] face restore failed open ({reason}), block sent unrestored")
        if trip:
            self._log(f"[longlive] face restore off for this session after {self._max_failures} consecutive failures")
        return RestoreOutcome(ticket.jpegs, False, None)

    def close(self) -> None:
        self._pool.shutdown(wait=False, cancel_futures=True)
