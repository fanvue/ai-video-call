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
# Back on GPEN-256 (Non-Commercial, same as inswapper for this spike): RestoreFormer++ only ships at 512, which measured ~105ms/frame of restorer time alone vs GPEN-256's documented ~4x faster rate, and credit is too tight right now to run the slower model.
RESTORER_URL = "https://github.com/facefusion/facefusion-assets/releases/download/models-3.0.0/gpen_bfr_256.onnx"
RESTORE_SIZE = 256
# FaceFusion's Real-ESRGAN x2 export (float32, dynamic shape): restores the clip's last frame before it seeds the next
# clip, so the chain stops compounding the i2v blur. Runs on the GPU that is already warm; the fal upscaler timed out.
ENHANCER_URL = "https://github.com/facefusion/facefusion-assets/releases/download/models-3.0.0/real_esrgan_x2_fp16.onnx"
# Full-strength output over-sharpens into a painted look (Laplacian 139 on a frame whose first generation measured 72); half puts a 5th-generation frame back at first-generation sharpness (70).
ENHANCE_BLEND = 0.5
# Prod frames above this Laplacian variance came out of the enhancer softer (108 -> 98, 128 -> 112): the x2 model denoises texture it did not need to rebuild. Only frames the chain has already blurred go through it.
ENHANCE_MAX_SHARPNESS = 80.0
# The chain drifts the other way too: prod seeds climbed from Laplacian 63 to 160 over a 3 minute session (the blotchy, over-textured torso), and nothing pulled them back. Above the band the seed is softened toward the target before it renders the next clip.
SEED_SHARPNESS_MAX = 95.0
SEED_SHARPNESS_TARGET = 75.0
SOFTEN_SIGMA = 1.2
# Chained renders also inflate contrast and saturation and warm the skin (see the degrade-gen sheet). Each seed's LAB moments are pulled halfway back toward the session's first frame: a leaky correction that bounds the drift but still lets a real scene change (a garment coming off) shift the tone.
TONE_LOCK_BLEND = 0.5
# FaceFusion's HyperSwap 1a (256 px, same ArcFace w600k_r50 identity as buffalo_l); the bake-off candidate against inswapper_128.
HYPERSWAP_URL = "https://github.com/facefusion/facefusion-assets/releases/download/models-3.3.0/hyperswap_1a_256.onnx"
SWAP_SIZE = 256
SWAP_MODELS = ("inswapper", "hyperswap")
# How much of the restored face replaces the swapped one; 1.0 looks waxy, FaceFusion defaults to 0.8. Down from 0.8: at 0.8 on every frame the face read contoured and over-sharpened by the fourth or fifth clip of a session.
RESTORE_BLEND = 0.5
# Off: it forced the upload's lighting onto every scene, so the face read as a lighter pasted mask against the neck. The drift it was added for came from seeding the chain with swapped frames, fixed at the source in generateClip.
COLOR_LOCK_BLEND = 0.0
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

# FaceFusion's arcface_128 alignment template, the crop HyperSwap was trained on.
ARCFACE_128_TEMPLATE = [
    [0.36167656, 0.40387734],
    [0.63696719, 0.40235469],
    [0.50019687, 0.56044219],
    [0.38710391, 0.72160547],
    [0.61507734, 0.72034453],
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
    # Seed restoration of the last frame: Laplacian variance before and after, and its cost.
    enhanced: bool = False
    enhance_ms: int = 0
    sharpness_before: float | None = None
    sharpness_after: float | None = None


# The default EXHAUSTIVE cuDNN search made the first clip on a fresh container ~8x slower than the second.
PROVIDERS = [("CUDAExecutionProvider", {"cudnn_conv_algo_search": "HEURISTIC"})]


class SwapEngine:
    def __init__(
        self,
        inswapper_path: str,
        restorer_path: str | None = None,
        enhancer_path: str | None = None,
        hyperswap_path: str | None = None,
    ) -> None:
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
        if restorer_path:
            import onnxruntime

            self.restorer = onnxruntime.InferenceSession(
                restorer_path, providers=PROVIDERS
            )
            self.restorer_input = self.restorer.get_inputs()[0].name
            # RestoreFormer++'s export carries internal feature-map outputs after the restored image; only output 0 is the image.
            self.restorer_output = self.restorer.get_outputs()[0].name
            print("restorer providers:", self.restorer.get_providers())
        self.enhancer = None
        if enhancer_path:
            import onnxruntime

            self.enhancer = onnxruntime.InferenceSession(
                enhancer_path, providers=PROVIDERS
            )
            self.enhancer_input = self.enhancer.get_inputs()[0].name
            print("enhancer providers:", self.enhancer.get_providers())
        self.hyperswap = None
        if hyperswap_path:
            import onnxruntime

            self.hyperswap = onnxruntime.InferenceSession(
                hyperswap_path, providers=PROVIDERS
            )
            # The export is fp16 in places; feed each input in the dtype it declares instead of guessing.
            self.hyperswap_inputs = {
                i.name: (np.float16 if "float16" in i.type else np.float32)
                for i in self.hyperswap.get_inputs()
            }
            print("hyperswap providers:", self.hyperswap.get_providers(), self.hyperswap_inputs)
        self.template = np.array(FFHQ_TEMPLATE, dtype=np.float32) * RESTORE_SIZE
        self.swap_template = np.array(ARCFACE_128_TEMPLATE, dtype=np.float32) * SWAP_SIZE
        self.warm_up()

    def warm_up(self) -> None:
        # Runs each network once so kernel selection happens at container start, not on the first clip.
        import numpy as np

        blank = np.zeros((INPUT_HEIGHT, INPUT_WIDTH, 3), dtype=np.uint8)
        self.detector.get(blank)
        self.identity.get(blank)
        if self.restorer is not None:
            tensor = np.zeros((1, 3, RESTORE_SIZE, RESTORE_SIZE), dtype=np.float32)
            self.restorer.run([self.restorer_output], {self.restorer_input: tensor})
        if self.enhancer is not None:
            self.enhance_frame(blank)
        if self.hyperswap is not None:
            feed = {
                name: np.zeros((1, 512) if name == "source" else (1, 3, SWAP_SIZE, SWAP_SIZE), dtype=dtype)
                for name, dtype in self.hyperswap_inputs.items()
            }
            self.hyperswap.run(None, feed)

    # A light Gaussian blended in just far enough to bring an over-textured seed back to the target sharpness; the blend weight is bisected so the correction is proportional, never a fixed blur.
    def soften_frame(self, frame, target: float):
        import cv2

        blurred = cv2.GaussianBlur(frame, (0, 0), SOFTEN_SIGMA)
        low, high = 0.0, 1.0
        best = frame
        for _ in range(6):
            alpha = (low + high) / 2
            candidate = cv2.addWeighted(blurred, alpha, frame, 1.0 - alpha, 0)
            if self.sharpness(candidate) > target:
                low = alpha
            else:
                high = alpha
            best = candidate
        return best

    @staticmethod
    def frame_lab_stats(frame):
        import cv2

        lab = cv2.cvtColor(frame, cv2.COLOR_BGR2LAB).astype("float32").reshape(-1, 3)
        return lab.mean(axis=0), lab.std(axis=0)

    # Whole-frame version of color_lock against the session's first frame, blended by TONE_LOCK_BLEND.
    def tone_lock(self, frame, ref_stats):
        import cv2
        import numpy as np

        ref_mean, ref_std = ref_stats
        lab = cv2.cvtColor(frame, cv2.COLOR_BGR2LAB).astype(np.float32)
        flat = lab.reshape(-1, 3)
        mean = flat.mean(axis=0)
        std = np.where(flat.std(axis=0) < 1e-3, 1.0, flat.std(axis=0))
        locked = np.clip((lab - mean) / std * ref_std + ref_mean, 0, 255).astype(np.uint8)
        locked = cv2.cvtColor(locked, cv2.COLOR_LAB2BGR)
        return cv2.addWeighted(locked, TONE_LOCK_BLEND, frame, 1.0 - TONE_LOCK_BLEND, 0)

    @staticmethod
    def sharpness(frame) -> float:
        import cv2

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        return float(cv2.Laplacian(gray, cv2.CV_64F).var())

    # 2x Real-ESRGAN on the whole frame, then back to the clip size: sharpens and denoises without changing the framing.
    def enhance_frame(self, frame):
        import cv2
        import numpy as np

        height, width = frame.shape[:2]
        tensor = frame[:, :, ::-1].astype(np.float32) / 255.0
        tensor = np.transpose(tensor, (2, 0, 1))[None]
        (output,) = self.enhancer.run(None, {self.enhancer_input: tensor})
        upscaled = np.clip(output[0].transpose(1, 2, 0), 0.0, 1.0) * 255.0
        upscaled = upscaled[:, :, ::-1].astype(np.uint8)
        restored = cv2.resize(upscaled, (width, height), interpolation=cv2.INTER_AREA)
        return cv2.addWeighted(restored, ENHANCE_BLEND, frame, 1.0 - ENHANCE_BLEND, 0)

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

    # Lossless for the chain seed: a JPEG round trip per generation was one more thing the next render compounded.
    def encode_png(self, frame) -> bytes:
        import cv2

        ok, buffer = cv2.imencode(".png", frame, [cv2.IMWRITE_PNG_COMPRESSION, 3])
        if not ok:
            raise RuntimeError("png encode failed")
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
        face = faces[0]
        face.ref_lab = self.face_lab_stats(image, face)
        return face

    # LAB mean/std of the reference photo's own aligned face crop, so every later frame can be pulled back toward it.
    def face_lab_stats(self, frame, face):
        import cv2
        import numpy as np

        matrix, _ = cv2.estimateAffinePartial2D(
            face.kps.astype(np.float32), self.template, method=cv2.LMEDS
        )
        if matrix is None:
            return None
        crop = cv2.warpAffine(
            frame, matrix, (RESTORE_SIZE, RESTORE_SIZE), borderMode=cv2.BORDER_REPLICATE
        )
        lab = cv2.cvtColor(crop, cv2.COLOR_BGR2LAB).astype(np.float32).reshape(-1, 3)
        return lab.mean(axis=0), lab.std(axis=0)

    # Pulls a swapped/restored crop's LAB tone toward the reference photo's own, so per-clip restoration bias
    # (warmth, saturation) never compounds across a long session instead of resetting from the true upload each time.
    def color_lock(self, crop, ref_lab):
        import cv2
        import numpy as np

        if ref_lab is None:
            return crop
        ref_mean, ref_std = ref_lab
        lab = cv2.cvtColor(crop, cv2.COLOR_BGR2LAB).astype(np.float32)
        mean = lab.reshape(-1, 3).mean(axis=0)
        std = np.where(lab.reshape(-1, 3).std(axis=0) < 1e-3, 1.0, lab.reshape(-1, 3).std(axis=0))
        locked = np.clip((lab - mean) / std * ref_std + ref_mean, 0, 255).astype(np.uint8)
        return cv2.cvtColor(locked, cv2.COLOR_LAB2BGR)

    def restore_face(self, frame, face, source_face):
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
        (output,) = self.restorer.run([self.restorer_output], {self.restorer_input: tensor})
        restored = np.clip((output[0].transpose(1, 2, 0) + 1.0) * 127.5, 0, 255)
        restored = restored[:, :, ::-1].astype(np.uint8)
        blended = cv2.addWeighted(restored, RESTORE_BLEND, crop, 1.0 - RESTORE_BLEND, 0)
        locked = self.color_lock(blended, getattr(source_face, "ref_lab", None))
        blended = cv2.addWeighted(locked, COLOR_LOCK_BLEND, blended, 1.0 - COLOR_LOCK_BLEND, 0)
        return paste_patch(frame, blended, matrix)

    # The next clip's seed: the swapped last frame, restored only when the chain has already blurred it.
    def finish_seed(self, last_swapped):
        enhance_ms = 0
        enhanced = False
        sharpness_before = round(self.sharpness(last_swapped), 1)
        sharpness_after = sharpness_before
        seed_frame = last_swapped
        if self.enhancer is not None and sharpness_before < ENHANCE_MAX_SHARPNESS:
            enhance_started = time.perf_counter()
            seed_frame = self.enhance_frame(last_swapped)
            enhance_ms = int((time.perf_counter() - enhance_started) * 1000)
            enhanced = True
            sharpness_after = round(self.sharpness(seed_frame), 1)
        elif sharpness_before > SEED_SHARPNESS_MAX:
            enhance_started = time.perf_counter()
            seed_frame = self.soften_frame(last_swapped, SEED_SHARPNESS_TARGET)
            enhance_ms = int((time.perf_counter() - enhance_started) * 1000)
            enhanced = True
            sharpness_after = round(self.sharpness(seed_frame), 1)
        return seed_frame, enhance_ms, enhanced, sharpness_before, sharpness_after

    # Only the clip's last frame, swapped and finished the same way swap_clip finishes it, so the next clip can render while the full swap is still queued. Decodes just the tail with ffmpeg instead of walking the clip.
    # Decodes just the clip's last frame with ffmpeg instead of walking the clip.
    def read_tail_frame(self, video_path: str):
        import cv2
        import numpy as np

        capture = cv2.VideoCapture(video_path)
        if not capture.isOpened():
            raise ValueError("could not open the clip")
        width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
        capture.release()
        frame_bytes = width * height * 3
        frame = None
        # -sseof is relative to the container end; a video track shorter than the audio can leave the window empty.
        for tail_sec in ("0.3", "1.5"):
            raw = subprocess.run(
                [
                    "ffmpeg", "-loglevel", "error", "-sseof", f"-{tail_sec}", "-i", video_path, "-an",
                    "-f", "rawvideo", "-pix_fmt", "bgr24", "pipe:1",
                ],
                check=True,
                capture_output=True,
            ).stdout
            if len(raw) >= frame_bytes:
                frame_count = len(raw) // frame_bytes
                last = np.frombuffer(raw[(frame_count - 1) * frame_bytes : frame_count * frame_bytes], dtype=np.uint8)
                frame = last.reshape((height, width, 3)).copy()
                break
        if frame is None:
            raise ValueError("the clip had no frames")
        return frame

    def swap_tail(self, video_path: str, source_face) -> tuple[dict[str, Any], bytes]:
        started = time.perf_counter()
        frame = self.read_tail_frame(video_path)
        faces = self.detector.get(frame)
        swapped = self.swap_frame(frame, source_face, faces)
        swap_ms = int((time.perf_counter() - started) * 1000)
        seed_frame, enhance_ms, enhanced, sharpness_before, sharpness_after = self.finish_seed(swapped)
        stats = {
            "swap_ms": swap_ms,
            "had_face": bool(faces),
            "similarity_before": self.similarity(frame, source_face),
            "similarity_after": self.similarity(swapped, source_face),
            "enhanced": enhanced,
            "enhance_ms": enhance_ms,
            "sharpness_before": sharpness_before,
            "sharpness_after": sharpness_after,
        }
        return stats, self.encode_jpeg(seed_frame)

    # HyperSwap's own crop and tensor contract (FaceFusion face_swapper: arcface_128 template at 256, (x/255 - 0.5)/0.5 RGB in, the inverse out); returns the swapped crop and the frame-to-crop matrix like insightface's paste_back=False path.
    def hyperswap_patch(self, frame, face, source_face):
        import cv2
        import numpy as np

        matrix, _ = cv2.estimateAffinePartial2D(
            face.kps.astype(np.float32), self.swap_template, method=cv2.RANSAC, ransacReprojThreshold=100
        )
        if matrix is None:
            return None, None
        crop = cv2.warpAffine(
            frame, matrix, (SWAP_SIZE, SWAP_SIZE), borderMode=cv2.BORDER_REPLICATE, flags=cv2.INTER_AREA
        )
        target = (crop[:, :, ::-1].astype(np.float32) / 255.0 - 0.5) / 0.5
        target = np.transpose(target, (2, 0, 1))[None]
        feed = {
            "source": source_face.normed_embedding.reshape(1, -1).astype(self.hyperswap_inputs["source"]),
            "target": target.astype(self.hyperswap_inputs["target"]),
        }
        # Output 0 is the swapped crop; the export carries extra outputs after it.
        output = self.hyperswap.run(None, feed)[0]
        swapped = output[0].astype(np.float32).transpose(1, 2, 0) * 0.5 + 0.5
        swapped = (np.clip(swapped, 0.0, 1.0)[:, :, ::-1] * 255.0).astype(np.uint8)
        return swapped, matrix

    def swap_frame(
        self, frame, source_face, faces, timings: dict[str, float] | None = None, model: str = "inswapper"
    ):
        out = frame
        for face in faces:
            started = time.perf_counter()
            if model == "hyperswap" and self.hyperswap is not None:
                patch, matrix = self.hyperswap_patch(out, face, source_face)
                if patch is None:
                    continue
            else:
                # insightface's own paste_back blends the whole frame in float; paste_patch touches only the face box.
                patch, matrix = self.swapper.get(out, face, source_face, paste_back=False)
            out = paste_patch(out, patch, matrix)
            swapped_at = time.perf_counter()
            if self.restorer is not None:
                out = self.restore_face(out, face, source_face)
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
        self, video_path: str, source_face, output_path: str, model: str = "inswapper"
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
            swapped = self.swap_frame(frame, source_face, faces, local, model)
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
        seed_frame, enhance_ms, enhanced, sharpness_before, sharpness_after = self.finish_seed(last_swapped)
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
            enhanced=enhanced,
            enhance_ms=enhance_ms,
            sharpness_before=sharpness_before,
            sharpness_after=sharpness_after,
        )
        return stats, self.encode_jpeg(seed_frame)


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
        f"ms_per_frame={stats['ms_per_frame']} similarity={stats['similarity_before']}->{stats['similarity_after']} "
        f"enhance_ms={stats['enhance_ms']} sharpness={stats['sharpness_before']}->{stats['sharpness_after']}",
        flush=True,
    )
    return result


def swap_tail_from_url(
    engine: SwapEngine, video_url: str, reference_data_uri: str
) -> dict[str, Any]:
    source_face = engine.reference_face(reference_data_uri)
    with tempfile.TemporaryDirectory() as directory:
        source_path = os.path.join(directory, "source.mp4")
        started = time.perf_counter()
        download(video_url, source_path)
        download_ms = int((time.perf_counter() - started) * 1000)
        stats, seed_jpeg = engine.swap_tail(source_path, source_face)
    stats["download_ms"] = download_ms
    print(
        f"swapTail: download_ms={download_ms} swap_ms={stats['swap_ms']} had_face={stats['had_face']} "
        f"similarity={stats['similarity_before']}->{stats['similarity_after']} "
        f"enhance_ms={stats['enhance_ms']} sharpness={stats['sharpness_before']}->{stats['sharpness_after']}",
        flush=True,
    )
    return {"last_frame_base64": base64.b64encode(seed_jpeg).decode("ascii"), "stats": stats}


# The session's first frame is the same URL for every seed of that session, so its LAB moments are computed once per container.
_tone_stats_cache: dict[str, Any] = {}
_tone_stats_lock = threading.Lock()


def tone_reference_stats(engine: SwapEngine, url: str):
    with _tone_stats_lock:
        cached = _tone_stats_cache.get(url)
    if cached is not None:
        return cached
    with urllib.request.urlopen(url, timeout=30) as response:
        image = engine.decode_image(response.read())
    if image is None:
        raise ValueError("tone reference is not an image")
    stats = engine.frame_lab_stats(image)
    with _tone_stats_lock:
        if len(_tone_stats_cache) >= 16:
            _tone_stats_cache.clear()
        _tone_stats_cache[url] = stats
    return stats


# The raw last frame, unswapped, finished like every other seed (enhanced once the chain has blurred it): the next chain clip's seed. fal's ffmpeg-api took 5 to 6 s for the same frame on the reply path.
def last_frame_from_url(
    engine: SwapEngine, video_url: str, tone_reference_url: str | None = None
) -> dict[str, Any]:
    with tempfile.TemporaryDirectory() as directory:
        source_path = os.path.join(directory, "source.mp4")
        started = time.perf_counter()
        download(video_url, source_path)
        download_ms = int((time.perf_counter() - started) * 1000)
        frame = engine.read_tail_frame(source_path)
    tone_locked = False
    if tone_reference_url:
        # Tone is a quality feature, not a guard: a reference that fails to load leaves the seed as rendered.
        try:
            frame = engine.tone_lock(frame, tone_reference_stats(engine, tone_reference_url))
            tone_locked = True
        except Exception as error:  # noqa: BLE001
            print(f"lastFrame: tone reference failed: {error}", flush=True)
    seed_frame, enhance_ms, enhanced, sharpness_before, sharpness_after = engine.finish_seed(frame)
    total_ms = int((time.perf_counter() - started) * 1000)
    print(
        f"lastFrame: download_ms={download_ms} tone_locked={tone_locked} enhance_ms={enhance_ms} enhanced={enhanced} "
        f"sharpness={sharpness_before}->{sharpness_after} total_ms={total_ms}",
        flush=True,
    )
    return {
        "last_frame_base64": base64.b64encode(engine.encode_png(seed_frame)).decode("ascii"),
        "stats": {
            "download_ms": download_ms,
            "tone_locked": tone_locked,
            "enhance_ms": enhance_ms,
            "enhanced": enhanced,
            "sharpness_before": sharpness_before,
            "sharpness_after": sharpness_after,
            "total_ms": total_ms,
        },
    }


def swap_tail_from_bytes(
    engine: SwapEngine, video: bytes, reference_data_uri: str
) -> dict[str, Any]:
    source_face = engine.reference_face(reference_data_uri)
    with tempfile.TemporaryDirectory() as directory:
        source_path = os.path.join(directory, "source.mp4")
        with open(source_path, "wb") as file:
            file.write(video)
        stats, seed_jpeg = engine.swap_tail(source_path, source_face)
    return {"last_frame_base64": base64.b64encode(seed_jpeg).decode("ascii"), "stats": stats}


def swap_clip_from_bytes(
    engine: SwapEngine, video: bytes, reference_data_uri: str, model: str = "inswapper"
) -> dict[str, Any]:
    # Response: base64 mp4 + base64 JPEG of the swapped last frame (the next clip's seed) + stats.
    if model not in SWAP_MODELS:
        raise ValueError(f"unknown swap model {model!r}")
    source_face = engine.reference_face(reference_data_uri)
    with tempfile.TemporaryDirectory() as directory:
        source_path = os.path.join(directory, "source.mp4")
        output_path = os.path.join(directory, "swapped.mp4")
        with open(source_path, "wb") as file:
            file.write(video)
        stats, last_frame = engine.swap_clip(source_path, source_face, output_path, model)
        with open(output_path, "rb") as file:
            swapped = file.read()
    return {
        "video_base64": base64.b64encode(swapped).decode("ascii"),
        "last_frame_base64": base64.b64encode(last_frame).decode("ascii"),
        "stats": asdict(stats),
    }
