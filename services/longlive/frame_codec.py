# LongLive-side codec for the second-GPU face pass: lighter frames out, face-region replies back, composited onto the untouched originals.
# A 32-frame block at JPEG 90 was about 1.9 MB, right at Modal's 2 MiB inline input limit; at 75 it is about 1 MB.
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

# Transport only: the frames that reach the viewer keep the engine's quality outside the face box.
TRANSPORT_QUALITY = 75
OUTPUT_QUALITY = 90
# The reply's pixels already carry the paste feather over the transport frame, so the box only needs a steep edge onto the original.
COVERAGE_GAIN = 4.0
WORKERS = 4


class RoiCodec:
    def __init__(self, workers: int = WORKERS):
        self._pool = ThreadPoolExecutor(workers)

    @staticmethod
    def _to_transport(jpeg: bytes):
        import cv2
        import numpy as np

        frame = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
        if frame is None:
            raise ValueError("undecodable JPEG")
        ok, encoded = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, TRANSPORT_QUALITY])
        if not ok:
            raise RuntimeError("transport encode failed")
        return encoded.tobytes(), frame

    def pack(self, jpegs: list[bytes]):
        packed = list(self._pool.map(self._to_transport, jpegs))
        return [transport for transport, _ in packed], [frame for _, frame in packed]

    @staticmethod
    def _compose(original: bytes, frame, reply) -> bytes:
        if reply is None:
            return original
        return compose(frame, reply)

    def unpack(self, jpegs: list[bytes], frames, replies: list) -> list[bytes]:
        return list(self._pool.map(self._compose, jpegs, frames, replies))

    def close(self) -> None:
        self._pool.shutdown(wait=False, cancel_futures=True)


def compose(frame, reply: dict) -> bytes:
    """Pastes one face-region reply onto the decoded original frame and encodes it for the viewer."""
    import cv2
    import numpy as np

    if not isinstance(reply, dict):
        raise ValueError(f"face reply must be a dict, got {type(reply).__name__}")
    x, y = reply.get("x"), reply.get("y")
    roi = cv2.imdecode(np.frombuffer(reply.get("roi", b""), np.uint8), cv2.IMREAD_COLOR)
    alpha = cv2.imdecode(np.frombuffer(reply.get("alpha", b""), np.uint8), cv2.IMREAD_GRAYSCALE)
    if roi is None or alpha is None or not isinstance(x, int) or not isinstance(y, int):
        raise ValueError("malformed face reply")
    height, width = roi.shape[:2]
    if alpha.shape != (height, width) or x < 0 or y < 0 or x + width > frame.shape[1] or y + height > frame.shape[0]:
        raise ValueError("face reply does not fit the frame")
    weight = np.clip(alpha.astype(np.float32) * (COVERAGE_GAIN / 255.0), 0.0, 1.0)[:, :, None]
    out = frame.copy()
    region = out[y : y + height, x : x + width].astype(np.float32)
    out[y : y + height, x : x + width] = (roi.astype(np.float32) * weight + region * (1.0 - weight)).astype(np.uint8)
    ok, encoded = cv2.imencode(".jpg", out, [cv2.IMWRITE_JPEG_QUALITY, OUTPUT_QUALITY])
    if not ok:
        raise RuntimeError("output encode failed")
    return encoded.tobytes()
