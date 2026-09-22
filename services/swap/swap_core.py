# Host-agnostic core of the Swap service; fal (app.py) and Modal (modal_app.py) both wrap it.
from __future__ import annotations

import base64
import json
import time
import traceback
from typing import Any, Protocol

# InsightFace inswapper_128 is research-only licensed; a commercial license is
# required before this leaves the spike.
# deepinsight's own repo is gated (401); this is a public mirror of the same file.
INSWAPPER_URL = "https://huggingface.co/ezioruan/inswapper_128.onnx/resolve/main/inswapper_128.onnx"
GFPGAN_URL = "https://github.com/TencentARC/GFPGAN/releases/download/v1.3.4/GFPGANv1.4.pth"
INPUT_WIDTH = 720
INPUT_HEIGHT = 1280
DETECT_EVERY_N_FRAMES = 3
MAX_FRAME_LAG = 2

# gfpgan is left out: its basicsr dependency has a broken cuda-toolkit setup_requires on Python 3.11 images. Restorer is opt-in via SwapEngine(restore=True) once that is solved.
REQUIREMENTS = [
    "insightface==0.7.3",
    "onnxruntime-gpu==1.19.2",
    "opencv-python-headless==4.10.0.84",
    "numpy<2",
]


class WebSocketLike(Protocol):
    async def accept(self) -> None: ...
    async def receive(self) -> dict[str, Any]: ...
    async def send_text(self, data: str) -> None: ...
    async def send_bytes(self, data: bytes) -> None: ...
    async def close(self, code: int = 1000, reason: str = "") -> None: ...


class SwapEngine:
    def __init__(self, inswapper_path: str, restore: bool = False) -> None:
        import insightface

        self.detector = insightface.app.FaceAnalysis(
            name="buffalo_l", providers=["CUDAExecutionProvider"]
        )
        self.detector.prepare(ctx_id=0, det_size=(640, 640))
        self.swapper = insightface.model_zoo.get_model(
            inswapper_path, providers=["CUDAExecutionProvider"]
        )
        self.restorer = None
        if restore:
            from gfpgan import GFPGANer

            self.restorer = GFPGANer(
                model_path=GFPGAN_URL, upscale=1, arch="clean", channel_multiplier=2
            )

    def decode_jpeg(self, data: bytes):
        import cv2
        import numpy as np

        return cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)

    def encode_jpeg(self, frame) -> bytes:
        import cv2

        ok, buffer = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 82])
        if not ok:
            raise RuntimeError("jpeg encode failed")
        return buffer.tobytes()

    def reference_face(self, data_uri: str):
        header, _, payload = data_uri.partition(",")
        if not header.startswith("data:image/"):
            raise ValueError("reference must be an image data URI")
        image = self.decode_jpeg(base64.b64decode(payload))
        faces = self.detector.get(image)
        if len(faces) != 1:
            raise ValueError(f"reference must contain exactly one face, found {len(faces)}")
        return faces[0]

    def swap_frame(self, frame, source_face, faces):
        out = frame
        for face in faces:
            out = self.swapper.get(out, face, source_face, paste_back=True)
        if self.restorer is None:
            return out
        _, _, restored = self.restorer.enhance(
            out, has_aligned=False, only_center_face=False, paste_back=True
        )
        return restored if restored is not None else out


async def serve_ws(engine: SwapEngine, websocket: WebSocketLike) -> None:
    # Protocol: first text frame is {"type":"reference","image":"<data uri>"}; then binary JPEG
    # frames (720x1280) in, swapped JPEG frames out, in order; {"type":"stop"} ends the session.
    await websocket.accept()
    source_face = None
    last_faces: list[Any] = []
    frame_index = 0
    pending = 0
    try:
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                return
            text = message.get("text")
            if text is not None:
                control = json.loads(text)
                if control.get("type") == "reference":
                    try:
                        source_face = engine.reference_face(control["image"])
                        await websocket.send_text(json.dumps({"type": "ready"}))
                    except ValueError as error:
                        await websocket.send_text(
                            json.dumps({"type": "error", "reason": str(error)})
                        )
                        await websocket.close(code=1008, reason="bad reference")
                        return
                elif control.get("type") == "stop":
                    await websocket.close(code=1000, reason="stopped")
                    return
                continue

            data = message.get("bytes")
            if data is None or source_face is None:
                continue
            pending += 1
            # Skip, never queue, when the client is ahead of us.
            if pending > MAX_FRAME_LAG:
                pending -= 1
                continue
            started = time.perf_counter()
            frame = engine.decode_jpeg(data)
            if frame.shape[1] != INPUT_WIDTH or frame.shape[0] != INPUT_HEIGHT:
                import cv2

                frame = cv2.resize(frame, (INPUT_WIDTH, INPUT_HEIGHT))
            if frame_index % DETECT_EVERY_N_FRAMES == 0 or not last_faces:
                last_faces = engine.detector.get(frame)
            frame_index += 1
            swapped = engine.swap_frame(frame, source_face, last_faces)
            await websocket.send_bytes(engine.encode_jpeg(swapped))
            pending -= 1
            elapsed_ms = (time.perf_counter() - started) * 1000
            if frame_index % 30 == 0:
                await websocket.send_text(
                    json.dumps({"type": "metrics", "frame_ms": round(elapsed_ms, 1)})
                )
    except Exception as error:  # surface, never swallow: the client shows the failure
        traceback.print_exc()
        await websocket.send_text(json.dumps({"type": "error", "reason": str(error)}))
        await websocket.close(code=1011, reason="swap failed")
