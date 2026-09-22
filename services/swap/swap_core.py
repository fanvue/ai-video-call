# Host-agnostic core of the Swap service; fal (app.py) and Modal (modal_app.py) both wrap it.
from __future__ import annotations

import base64
import os
import subprocess
import threading
import tempfile
import time
import urllib.request
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
from typing import Any

# inswapper_128 is research-only licensed (commercial license needed before this leaves the spike); deepinsight's repo is gated so this is a public mirror.
INSWAPPER_URL = "https://huggingface.co/ezioruan/inswapper_128.onnx/resolve/main/inswapper_128.onnx"
# FaceFusion's ONNX exports of GPEN-BFR, a restorer that runs on the onnxruntime we already have (gfpgan's basicsr build is broken on Python 3.11 images).
# 256 is plenty for a 480P clip where the face is ~150px wide and runs ~4x faster than 512 (140 ms/frame on an A10G).
GPEN_URLS = {
    256: "https://github.com/facefusion/facefusion-assets/releases/download/models-3.0.0/gpen_bfr_256.onnx",
    512: "https://github.com/facefusion/facefusion-assets/releases/download/models-3.0.0/gpen_bfr_512.onnx",
}
RESTORE_SIZE = 256
GPEN_URL = GPEN_URLS[RESTORE_SIZE]
# How much of the restored face replaces the swapped one; 1.0 looks waxy, FaceFusion defaults to 0.8.
RESTORE_BLEND = 0.8
MAX_CLIP_FRAMES = 30 * 20
# Typical turbo clip size, used only for the warm-up pass.
INPUT_WIDTH = 542
INPUT_HEIGHT = 988
# Frames in flight across threads; onnxruntime and OpenCV release the GIL, so the GPU stays busy while
# another frame is being decoded or pasted. Sequential was 34 to 46 ms/frame on an A10G.
WORKERS = 3

REQUIREMENTS = [
    "insightface==0.7.3",
    "onnxruntime-gpu==1.19.2",
    "opencv-python-headless==4.10.0.84",
    "numpy<2",
]

# FFHQ alignment template GPEN was trained on (five landmarks, normalised to the crop).
FFHQ_TEMPLATE = [
    [0.37691676, 0.46864664],
    [0.62285697, 0.46912813],
    [0.50123859, 0.61331904],
    [0.39308822, 0.72541100],
    [0.61150205, 0.72490465],
]


@dataclass
class ClipSwapStats:
    frames: int
    frames_with_face: int
    fps: float
    swap_ms: int
    ms_per_frame: float
    # ArcFace cosine of the last frame against the reference, before and after the swap.
    similarity_before: float | None
    similarity_after: float | None
    restored: bool
    # Cumulative per-stage time, to see where a slow clip went.
    detect_ms: int
    swap_stage_ms: int
    restore_ms: int
    download_ms: int = 0


# The default EXHAUSTIVE cuDNN search made the first clip on a fresh container ~8x slower than the second.
PROVIDERS = [("CUDAExecutionProvider", {"cudnn_conv_algo_search": "HEURISTIC"})]


class SwapEngine:
    def __init__(self, inswapper_path: str, gpen_path: str | None = None) -> None:
        import insightface
        import numpy as np

        # Frames only need boxes and landmarks; buffalo_l's other four models would run per face otherwise.
        self.detector = insightface.app.FaceAnalysis(
            name="buffalo_l",
            allowed_modules=["detection"],
            providers=PROVIDERS,
        )
        self.detector.prepare(ctx_id=0, det_size=(640, 640))
        self.identity = insightface.app.FaceAnalysis(
            name="buffalo_l",
            allowed_modules=["detection", "recognition"],
            providers=PROVIDERS,
        )
        self.identity.prepare(ctx_id=0, det_size=(640, 640))
        self.swapper = insightface.model_zoo.get_model(
            inswapper_path, providers=PROVIDERS
        )
        self.restorer = None
        if gpen_path:
            import onnxruntime

            self.restorer = onnxruntime.InferenceSession(
                gpen_path, providers=PROVIDERS
            )
            self.restorer_input = self.restorer.get_inputs()[0].name
            print("restorer providers:", self.restorer.get_providers())
        self.template = np.array(FFHQ_TEMPLATE, dtype=np.float32) * RESTORE_SIZE
        self.warm_up()

    def warm_up(self) -> None:
        # Runs each network once so kernel selection happens at container start, not on the first clip.
        import numpy as np

        blank = np.zeros((INPUT_HEIGHT, INPUT_WIDTH, 3), dtype=np.uint8)
        self.detector.get(blank)
        self.identity.get(blank)
        if self.restorer is not None:
            tensor = np.zeros((1, 3, RESTORE_SIZE, RESTORE_SIZE), dtype=np.float32)
            self.restorer.run(None, {self.restorer_input: tensor})

    def decode_image(self, data: bytes):
        import cv2
        import numpy as np

        return cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)

    def encode_jpeg(self, frame) -> bytes:
        import cv2

        ok, buffer = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 90])
        if not ok:
            raise RuntimeError("jpeg encode failed")
        return buffer.tobytes()

    def reference_face(self, data_uri: str):
        header, _, payload = data_uri.partition(",")
        if not header.startswith("data:image/"):
            raise ValueError("reference must be an image data URI")
        image = self.decode_image(base64.b64decode(payload))
        faces = self.identity.get(image)
        if not faces:
            # The detector misses a face that fills the whole photo; give it some border to work with.
            import cv2

            height, width = image.shape[:2]
            padded = cv2.copyMakeBorder(
                image, height // 2, height // 2, width // 2, width // 2, cv2.BORDER_REPLICATE
            )
            faces = self.identity.get(padded)
        if len(faces) != 1:
            raise ValueError(f"reference must contain exactly one face, found {len(faces)}")
        return faces[0]

    def restore_face(self, frame, face):
        import cv2
        import numpy as np

        matrix, _ = cv2.estimateAffinePartial2D(
            face.kps.astype(np.float32), self.template, method=cv2.LMEDS
        )
        if matrix is None:
            return frame
        crop = cv2.warpAffine(
            frame, matrix, (RESTORE_SIZE, RESTORE_SIZE), borderMode=cv2.BORDER_REPLICATE
        )
        tensor = crop[:, :, ::-1].astype(np.float32) / 127.5 - 1.0
        tensor = np.transpose(tensor, (2, 0, 1))[None]
        (output,) = self.restorer.run(None, {self.restorer_input: tensor})
        restored = np.clip((output[0].transpose(1, 2, 0) + 1.0) * 127.5, 0, 255)
        restored = restored[:, :, ::-1].astype(np.uint8)
        blended = cv2.addWeighted(restored, RESTORE_BLEND, crop, 1.0 - RESTORE_BLEND, 0)
        return paste_patch(frame, blended, matrix)

    def swap_frame(self, frame, source_face, faces, timings: dict[str, float] | None = None):
        out = frame
        for face in faces:
            started = time.perf_counter()
            # insightface's own paste_back blends the whole frame in float; paste_patch touches only the face box.
            patch, matrix = self.swapper.get(out, face, source_face, paste_back=False)
            out = paste_patch(out, patch, matrix)
            swapped_at = time.perf_counter()
            if self.restorer is not None:
                out = self.restore_face(out, face)
            if timings is not None:
                timings["swap"] += swapped_at - started
                timings["restore"] += time.perf_counter() - swapped_at
        return out

    def similarity(self, frame, source_face) -> float | None:
        import numpy as np

        faces = self.identity.get(frame)
        if not faces:
            return None
        face = max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
        return float(np.dot(face.normed_embedding, source_face.normed_embedding))

    def swap_clip(
        self, video_path: str, source_face, output_path: str
    ) -> tuple[ClipSwapStats, bytes]:
        import cv2

        started = time.perf_counter()
        capture = cv2.VideoCapture(video_path)
        if not capture.isOpened():
            raise ValueError("could not open the clip")
        fps = capture.get(cv2.CAP_PROP_FPS) or 24.0
        width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
        # Re-encode video from the raw frames we pipe in and copy the source audio track, if any.
        writer = subprocess.Popen(
            [
                "ffmpeg", "-loglevel", "error", "-y",
                "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{width}x{height}",
                "-r", f"{fps}", "-i", "pipe:0",
                "-i", video_path,
                "-map", "0:v:0", "-map", "1:a:0?", "-c:a", "copy",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
                "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-shortest",
                output_path,
            ],
            stdin=subprocess.PIPE,
        )
        assert writer.stdin is not None

        frames = 0
        frames_with_face = 0
        timings = {"detect": 0.0, "swap": 0.0, "restore": 0.0}
        timings_lock = threading.Lock()
        last_frame = None
        last_swapped = None

        def process(frame):
            local = {"detect": 0.0, "swap": 0.0, "restore": 0.0}
            detect_started = time.perf_counter()
            faces = self.detector.get(frame)
            local["detect"] = time.perf_counter() - detect_started
            swapped = self.swap_frame(frame, source_face, faces, local)
            with timings_lock:
                for key, value in local.items():
                    timings[key] += value
            return swapped, bool(faces)

        pending: deque = deque()
        try:
            with ThreadPoolExecutor(max_workers=WORKERS) as pool:
                def drain_one() -> None:
                    nonlocal frames, frames_with_face, last_frame, last_swapped
                    frame, future = pending.popleft()
                    swapped, had_face = future.result()
                    writer.stdin.write(swapped.tobytes())
                    frames_with_face += had_face
                    last_frame = frame
                    last_swapped = swapped
                    frames += 1

                submitted = 0
                while submitted < MAX_CLIP_FRAMES:
                    ok, frame = capture.read()
                    if not ok:
                        break
                    pending.append((frame, pool.submit(process, frame)))
                    submitted += 1
                    if len(pending) >= WORKERS * 2:
                        drain_one()
                while pending:
                    drain_one()
        finally:
            capture.release()
            writer.stdin.close()
            writer.wait()
        if writer.returncode != 0:
            raise RuntimeError(f"ffmpeg exited with {writer.returncode}")
        if frames == 0 or last_swapped is None or last_frame is None:
            raise ValueError("the clip had no frames")

        swap_ms = int((time.perf_counter() - started) * 1000)
        stats = ClipSwapStats(
            frames=frames,
            frames_with_face=frames_with_face,
            fps=round(fps, 2),
            swap_ms=swap_ms,
            ms_per_frame=round(swap_ms / frames, 1),
            similarity_before=self.similarity(last_frame, source_face),
            similarity_after=self.similarity(last_swapped, source_face),
            restored=self.restorer is not None,
            detect_ms=int(timings["detect"] * 1000),
            swap_stage_ms=int(timings["swap"] * 1000),
            restore_ms=int(timings["restore"] * 1000),
        )
        return stats, self.encode_jpeg(last_swapped)


def paste_patch(frame, patch, matrix):
    # `matrix` maps frame -> patch. Blends the warped patch back with a feathered box mask, only
    # inside the frame region the patch lands on; the full-frame float blend was most of the per-frame cost.
    import cv2
    import numpy as np

    size = patch.shape[0]
    margin = max(size // 10, 4)
    mask = np.zeros((size, size), dtype=np.float32)
    mask[margin:-margin, margin:-margin] = 1.0
    mask = cv2.GaussianBlur(mask, (0, 0), margin / 2)

    inverse = cv2.invertAffineTransform(matrix)
    height, width = frame.shape[:2]
    corners = np.array([[0, 0, 1], [size, 0, 1], [0, size, 1], [size, size, 1]], dtype=np.float32)
    projected = corners @ inverse.T
    x0 = max(0, int(np.floor(projected[:, 0].min())))
    y0 = max(0, int(np.floor(projected[:, 1].min())))
    x1 = min(width, int(np.ceil(projected[:, 0].max())) + 1)
    y1 = min(height, int(np.ceil(projected[:, 1].max())) + 1)
    if x1 <= x0 or y1 <= y0:
        return frame
    shifted = inverse.copy()
    shifted[:, 2] -= (x0, y0)
    roi_size = (x1 - x0, y1 - y0)
    pasted = cv2.warpAffine(patch, shifted, roi_size).astype(np.float32)
    alpha = cv2.warpAffine(mask, shifted, roi_size)[:, :, None]
    out = frame.copy()
    region = out[y0:y1, x0:x1].astype(np.float32)
    out[y0:y1, x0:x1] = (pasted * alpha + region * (1.0 - alpha)).astype(np.uint8)
    return out


def token_allowed(supplied: str | None) -> bool:
    # Fail closed: no SWAP_TOKEN configured means nobody gets in, not everybody.
    expected = os.environ.get("SWAP_TOKEN")
    return bool(expected) and supplied == expected


def bearer_token(authorization: str | None) -> str | None:
    if not authorization or not authorization.startswith("Bearer "):
        return None
    return authorization[len("Bearer ") :]


def download(url: str, path: str) -> None:
    with urllib.request.urlopen(url, timeout=60) as response, open(path, "wb") as file:
        while True:
            chunk = response.read(1 << 20)
            if not chunk:
                break
            file.write(chunk)


def swap_clip_from_url(
    engine: SwapEngine, video_url: str, reference_data_uri: str
) -> dict[str, Any]:
    with tempfile.TemporaryDirectory() as directory:
        source_path = os.path.join(directory, "source.mp4")
        started = time.perf_counter()
        download(video_url, source_path)
        download_ms = int((time.perf_counter() - started) * 1000)
        with open(source_path, "rb") as file:
            result = swap_clip_from_bytes(engine, file.read(), reference_data_uri)
    result["stats"]["download_ms"] = download_ms
    stats = result["stats"]
    print(
        f"swapClip: frames={stats['frames']} download_ms={download_ms} swap_ms={stats['swap_ms']} "
        f"ms_per_frame={stats['ms_per_frame']} similarity={stats['similarity_before']}->{stats['similarity_after']}",
        flush=True,
    )
    return result


def swap_clip_from_bytes(
    engine: SwapEngine, video: bytes, reference_data_uri: str
) -> dict[str, Any]:
    # Response: base64 mp4 + base64 JPEG of the swapped last frame (the next clip's seed) + stats.
    source_face = engine.reference_face(reference_data_uri)
    with tempfile.TemporaryDirectory() as directory:
        source_path = os.path.join(directory, "source.mp4")
        output_path = os.path.join(directory, "swapped.mp4")
        with open(source_path, "wb") as file:
            file.write(video)
        stats, last_frame = engine.swap_clip(source_path, source_face, output_path)
        with open(output_path, "rb") as file:
            swapped = file.read()
    return {
        "video_base64": base64.b64encode(swapped).decode("ascii"),
        "last_frame_base64": base64.b64encode(last_frame).decode("ascii"),
        "stats": asdict(stats),
    }
