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
from functools import lru_cache
from typing import Any

# inswapper_128 is research-only licensed (commercial license needed before this leaves the spike); deepinsight's repo is gated so this is a public mirror.
INSWAPPER_URL = "https://huggingface.co/ezioruan/inswapper_128.onnx/resolve/main/inswapper_128.onnx"
# FaceFusion's fp16 export of the same weights, float32 in and out: 9.5 vs 17.6 ms per call on an A10G.
INSWAPPER_FP16_URL = "https://github.com/facefusion/facefusion-assets/releases/download/models-3.0.0/inswapper_128_fp16.onnx"
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
# Off: the ESRGAN-below-80 / soften-above-95 pair oscillated seed to seed and left skin blotchy; the seed now goes out exactly as swapped.
SEED_FINISH = False
# Off: whole-frame LAB stats are dominated by background and garment, so the lock shifted skin tone toward whatever filled the frame.
SEED_TONE_LOCK = False
# The face-only version: LAB moments of the aligned face ellipse, pulled TONE_LOCK_BLEND of the way back toward the session's first clip's face, so the seed's lighting and skin tone stop compounding without the background steering it.
SEED_FACE_TONE_LOCK = True
# Share of the Reinhard-matched patch kept over the raw swap: pulls the face toward the render's neck and skin without flattening its own shading.
PATCH_COLOR_MATCH_BLEND = 0.6
# EMA weight for the zero-phase landmark smoothing in swap_clip; per-frame detector jitter made the pasted patch shimmer.
# 0.7 over 0.5: on 6 turbo clips paste-placement wobble fell 0.595 -> 0.319 px with fast-frame error at the 0.68 px noise floor (max 3.1 px); 0.5 reached 1.2 px (max 6.0) on head turns.
KPS_SMOOTH_ALPHA = 0.7
# Off: on a 362-frame persona clip smoothing left output landmark wobble unchanged (0.565 vs 0.562 px) while holding the whole clip in memory and adding ~0.9 ms/frame.
# Rechecked on 6 turbo clips (A10G): output wobble 0.597 -> 0.576 px and added face flicker -0.865 -> -0.885 grey levels at alpha 0.7, for +1.3 ms/frame; still off.
KPS_SMOOTH = False
# FaceFusion's HyperSwap 1a (256 px, same ArcFace w600k_r50 identity as buffalo_l); the bake-off candidate against inswapper_128.
HYPERSWAP_URL = "https://github.com/facefusion/facefusion-assets/releases/download/models-3.3.0/hyperswap_1a_256.onnx"
# Bake-off runners-up (swap-bakeoff REPORT): hyperswap_1c was the sharpest (ArcFace 0.849), ghost_1 the only Apache-2.0 swapper (0.832); picked per session from the Advanced swap profile.
HYPERSWAP_1C_URL = "https://github.com/facefusion/facefusion-assets/releases/download/models-3.3.0/hyperswap_1c_256.onnx"
GHOST_1_URL = "https://github.com/facefusion/facefusion-assets/releases/download/models-3.0.0/ghost_1_256.onnx"
# GHOST takes its own identity latent, mapped from the raw ArcFace embedding by this converter.
CROSSFACE_GHOST_URL = "https://github.com/facefusion/facefusion-assets/releases/download/models-3.4.0/crossface_ghost.onnx"
SWAP_SIZE = 256
SWAP_MODELS = ("inswapper", "inswapper_fp16", "hyperswap", "hyperswap_1c", "ghost_1")
# fp16 matched fp32 at 46.7 dB PSNR and the same ArcFace (0.936) on a 362-frame clip, 13.4 vs 20.8 ms/frame.
DEFAULT_SWAP_MODEL = "inswapper_fp16"
# How much of the restored face replaces the swapped one; 1.0 looks waxy, FaceFusion defaults to 0.8. Down from 0.8: at 0.8 on every frame the face read contoured and over-sharpened by the fourth or fifth clip of a session.
RESTORE_BLEND = 0.5
# Per-frame GPEN off: at 0.5 it still airbrushed the face, and it was 13 of ~34 ms/frame (A10G, 362-frame persona clip: 33.6 -> 20.9 ms, ArcFace 0.92 -> 0.94).
RESTORE_FRAMES = False
# Off: it forced the upload's lighting onto every scene, so the face read as a lighter pasted mask against the neck. The drift it was added for came from seeding the chain with swapped frames, fixed at the source in generateClip.
COLOR_LOCK_BLEND = 0.0
# "longlive" is LongLive's persona recipe: part of the generated eyes and mouth kept through the swap, no colour match, GFPGAN 1.4 over the face. "legacy" is the Reinhard-matched swap with no per-frame restore.
FACE_RECIPES = ("legacy", "longlive")
# Legacy stays default: on 3 turbo clips (A10G, synth-persona-01) longlive lost ArcFace 0.910 -> 0.878 and frame stability 0.985 -> 0.982, left neck tone flat, and cost 45 vs 14 ms/frame.
FACE_RECIPE = "legacy"
# Same public facefusion-assets export LongLive's face GPU runs.
GFPGAN_URL = "https://github.com/facefusion/facefusion-assets/releases/download/models-3.0.0/gfpgan_1.4.onnx"
GFPGAN_SIZE = 512
# LongLive's SWAP_RESTORE_BLEND: full strength reads waxy.
GFPGAN_BLEND = 0.6
# LongLive's MOTION_KEEP: the full swap damped blinks and speech in its face A/B.
MOTION_KEEP = 0.35
# FaceFusion's xseg_1 occluder (DeepFaceLab XSeg, GPL-3.0, research-only like inswapper): a visible-face mask, so a hand or hair in front of the face stays on top of the swap.
OCCLUDER_URL = "https://github.com/facefusion/facefusion-assets/releases/download/models-3.1.0/xseg_1.onnx"
OCCLUDER_SIZE = 256
# Grows xseg's visible-face mask (px at OCCLUDER_SIZE) so only occluders are cut: its tight outline plus FaceFusion's post-process handed brows and jaw back to the render, ArcFace 0.914 -> 0.850; 24 px measured 0.914 with the hand still kept.
OCCLUDER_GROW = 24
# Off: xseg is ~19 ms per face on an A10G (6 turbo clips: legacy 15.5 -> 25.4, fp16 longlive 34.6 -> 45.5 ms/frame, ArcFace unchanged); it stops the face being pasted over a hand in front of it.
# The default only: a request's occlusion_mask (the Hand mask toggle) overrides it per clip.
OCCLUSION_MASK = False
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

# FaceFusion's arcface_112_v1 template, the crop GHOST was trained on.
ARCFACE_112_V1_TEMPLATE = [
    [0.35473214, 0.45658929],
    [0.64526786, 0.45658929],
    [0.50000000, 0.61154464],
    [0.37913393, 0.77687500],
    [0.62086607, 0.77687500],
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
    recipe: str = FACE_RECIPE
    occlusion_mask: bool = False


# The default EXHAUSTIVE cuDNN search made the first clip on a fresh container ~8x slower than the second.
PROVIDERS = [("CUDAExecutionProvider", {"cudnn_conv_algo_search": "HEURISTIC"})]


class PersonaRejected(ValueError):
    pass


class SwapEngine:
    def __init__(
        self,
        inswapper_path: str,
        restorer_path: str | None = None,
        enhancer_path: str | None = None,
        hyperswap_path: str | None = None,
        inswapper_fp16_path: str | None = None,
        onnx_swapper_paths: dict[str, str] | None = None,
        gfpgan_path: str | None = None,
        occluder_path: str | None = None,
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
        self.swapper_fp16 = (
            insightface.model_zoo.get_model(inswapper_fp16_path, providers=PROVIDERS)
            if inswapper_fp16_path
            else None
        )
        self.restorer = None
        if restorer_path and RESTORE_FRAMES:
            import onnxruntime

            self.restorer = onnxruntime.InferenceSession(
                restorer_path, providers=PROVIDERS
            )
            self.restorer_input = self.restorer.get_inputs()[0].name
            # RestoreFormer++'s export carries internal feature-map outputs after the restored image; only output 0 is the image.
            self.restorer_output = self.restorer.get_outputs()[0].name
            print("restorer providers:", self.restorer.get_providers())
        self.gfpgan = None
        if gfpgan_path:
            import onnxruntime

            self.gfpgan = onnxruntime.InferenceSession(gfpgan_path, providers=PROVIDERS)
            self.gfpgan_input = self.gfpgan.get_inputs()[0].name
            print("gfpgan providers:", self.gfpgan.get_providers())
        self.gfpgan_template = np.array(FFHQ_TEMPLATE, dtype=np.float32) * GFPGAN_SIZE
        self.occluder = None
        # Loaded whenever a path is given, since any request can turn the mask on; the default off costs only its VRAM and warm-up.
        if occluder_path:
            import onnxruntime

            self.occluder = onnxruntime.InferenceSession(occluder_path, providers=PROVIDERS)
            self.occluder_input = self.occluder.get_inputs()[0].name
            print("occluder providers:", self.occluder.get_providers())
        # Persona source faces by (path, mtime, size), so a replaced file is embedded again.
        self.persona_faces: dict[tuple[str, float, int], Any] = {}
        self.persona_faces_lock = threading.Lock()
        self.enhancer = None
        if enhancer_path and SEED_FINISH:
            import onnxruntime

            self.enhancer = onnxruntime.InferenceSession(
                enhancer_path, providers=PROVIDERS
            )
            self.enhancer_input = self.enhancer.get_inputs()[0].name
            print("enhancer providers:", self.enhancer.get_providers())
        # 256 px FaceFusion swappers (HyperSwap, GHOST), loaded on first use so test profiles do not slow the default cold start.
        self.onnx_swapper_paths = dict(onnx_swapper_paths or {})
        if hyperswap_path:
            self.onnx_swapper_paths.setdefault("hyperswap", hyperswap_path)
        self.onnx_swappers: dict[str, dict[str, Any]] = {}
        self.onnx_swapper_lock = threading.Lock()
        if DEFAULT_SWAP_MODEL in self.onnx_swapper_paths:
            self.onnx_swapper(DEFAULT_SWAP_MODEL)
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
            self.restorer.run([self.restorer_output], {self.restorer_input: tensor})
        if self.enhancer is not None:
            self.enhance_frame(blank)
        if self.gfpgan is not None:
            self.gfpgan.run(None, {self.gfpgan_input: np.zeros((1, 3, GFPGAN_SIZE, GFPGAN_SIZE), dtype=np.float32)})
        if self.occluder is not None:
            self.occluder.run(None, {self.occluder_input: np.zeros((1, OCCLUDER_SIZE, OCCLUDER_SIZE, 3), dtype=np.float32)})
        for swapper in self.onnx_swappers.values():
            feed = {
                name: np.zeros((1, 512) if name == "source" else (1, 3, SWAP_SIZE, SWAP_SIZE), dtype=dtype)
                for name, dtype in swapper["inputs"].items()
            }
            swapper["session"].run([swapper["output"]], feed)

    def has_swap_model(self, model: str) -> bool:
        return model in ("inswapper", "inswapper_fp16") or model in self.onnx_swapper_paths

    def has_occluder(self) -> bool:
        return self.occluder is not None

    def has_recipe(self, recipe: str) -> bool:
        return recipe == "legacy" or (recipe == "longlive" and self.gfpgan is not None)

    def onnx_swapper(self, model: str) -> dict[str, Any]:
        import numpy as np
        import onnxruntime

        with self.onnx_swapper_lock:
            if model in self.onnx_swappers:
                return self.onnx_swappers[model]
            session = onnxruntime.InferenceSession(self.onnx_swapper_paths[model], providers=PROVIDERS)
            is_ghost = model.startswith("ghost")
            swapper = {
                "session": session,
                # The exports are fp16 in places; feed each input in the dtype it declares instead of guessing.
                "inputs": {i.name: (np.float16 if "float16" in i.type else np.float32) for i in session.get_inputs()},
                # Output 0 is the swapped crop; GHOST also returns decoder feature maps that would otherwise be copied to host every frame.
                "output": session.get_outputs()[0].name,
                "template": np.array(ARCFACE_112_V1_TEMPLATE if is_ghost else ARCFACE_128_TEMPLATE, dtype=np.float32) * SWAP_SIZE,
                "converter": (
                    onnxruntime.InferenceSession(self.onnx_swapper_paths["crossface_ghost"], providers=PROVIDERS)
                    if is_ghost
                    else None
                ),
            }
            print(f"{model} providers:", session.get_providers(), swapper["inputs"], flush=True)
            self.onnx_swappers[model] = swapper
            return swapper

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

    # The swap source comes from an allowlisted persona file only (persona_source_face), never from a session upload.
    def persona_face(self, persona):
        stat = os.stat(persona.path)
        key = (persona.path, stat.st_mtime, stat.st_size)
        with self.persona_faces_lock:
            cached = self.persona_faces.get(key)
        if cached is not None:
            return cached
        with open(persona.path, "rb") as file:
            image = self.decode_image(file.read())
        if image is None:
            raise PersonaRejected(f"{persona.id}: image unreadable")
        try:
            face = self.source_face_from_image(image)
        except ValueError as error:
            raise PersonaRejected(f"{persona.id}: {error}") from error
        with self.persona_faces_lock:
            if len(self.persona_faces) >= 16:
                self.persona_faces.clear()
            self.persona_faces[key] = face
        return face

    def source_face_from_image(self, image):
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

    # Aligned RESTORE_SIZE crop of the biggest face plus its frame-to-crop matrix, or (None, None) when it cannot be aligned.
    def aligned_face_crop(self, frame, faces):
        import cv2
        import numpy as np

        if not faces:
            return None, None
        face = max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
        matrix, _ = cv2.estimateAffinePartial2D(face.kps.astype(np.float32), self.template, method=cv2.LMEDS)
        if matrix is None:
            return None, None
        crop = cv2.warpAffine(frame, matrix, (RESTORE_SIZE, RESTORE_SIZE), borderMode=cv2.BORDER_REPLICATE)
        return crop, matrix

    # LAB mean/std inside the face ellipse only: face_lab_stats' full crop still mixes in hair and background.
    @staticmethod
    def face_ellipse_stats(crop):
        import cv2
        import numpy as np

        region = (face_ellipse_mask(crop.shape[0]) > 0.5).astype(np.uint8)
        mean, std = cv2.meanStdDev(cv2.cvtColor(crop, cv2.COLOR_BGR2LAB), mask=region)
        return mean.reshape(3).astype(np.float32), std.reshape(3).astype(np.float32)

    # Reinhard-matches the face ellipse toward ref_stats and keeps TONE_LOCK_BLEND of it under the feathered face mask; returns (frame, locked).
    def face_tone_lock(self, frame, faces, ref_stats):
        import cv2
        import numpy as np

        crop, matrix = self.aligned_face_crop(frame, faces)
        if crop is None or ref_stats is None:
            return frame, False
        ref_mean, ref_std = ref_stats
        mean, std = self.face_ellipse_stats(crop)
        # A flat channel (std ~0) keeps its spread and only shifts its mean.
        scale = np.where(std < 1e-3, 1.0, ref_std / np.maximum(std, 1e-3)).astype(np.float32)
        # The per-pixel transform runs on the frame itself, not a pasted crop: paste_patch's warp round trip cut face Laplacian 22 -> 17 on a seed the lock barely changed.
        lab = cv2.cvtColor(frame, cv2.COLOR_BGR2LAB).astype(np.float32)
        locked = cv2.cvtColor(np.clip((lab - mean) * scale + ref_mean, 0, 255).astype(np.uint8), cv2.COLOR_LAB2BGR)
        height, width = frame.shape[:2]
        mask = cv2.warpAffine(face_ellipse_mask(RESTORE_SIZE), cv2.invertAffineTransform(matrix), (width, height))
        alpha = (mask * TONE_LOCK_BLEND)[:, :, None]
        return (locked.astype(np.float32) * alpha + frame.astype(np.float32) * (1.0 - alpha)).astype(np.uint8), True

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

    # LongLive's face GPU pass: GFPGAN 1.4 on the aligned 512 FFHQ crop, GFPGAN_BLEND of it over the swapped face, pasted under the feathered ellipse.
    def gfpgan_face(self, frame, face, visible=None, visible_matrix=None):
        import cv2
        import numpy as np

        matrix, _ = cv2.estimateAffinePartial2D(face.kps.astype(np.float32), self.gfpgan_template, method=cv2.LMEDS)
        if matrix is None:
            return frame
        crop = cv2.warpAffine(frame, matrix, (GFPGAN_SIZE, GFPGAN_SIZE), borderMode=cv2.BORDER_REPLICATE)
        tensor = (crop[:, :, ::-1].astype(np.float32) / 127.5 - 1.0).transpose(2, 0, 1)[None]
        output = self.gfpgan.run(None, {self.gfpgan_input: np.ascontiguousarray(tensor)})[0][0]
        restored = np.clip((output.transpose(1, 2, 0) + 1.0) * 127.5, 0, 255)[:, :, ::-1].astype(np.uint8)
        blended = cv2.addWeighted(restored, GFPGAN_BLEND, crop, 1.0 - GFPGAN_BLEND, 0)
        # The occluder ran on the swap crop; carry its mask into this crop so GFPGAN does not repaint the hand the swap left alone.
        if visible is not None:
            visible = cv2.warpAffine(visible, chain_affine(matrix, visible_matrix), (GFPGAN_SIZE, GFPGAN_SIZE), borderValue=1.0)
        return paste_patch(frame, blended, matrix, visible)

    # Visible-face mask for the swap crop at `size`: the xseg occluder runs on the same alignment at OCCLUDER_SIZE.
    def occlusion_mask(self, frame, matrix, size: int):
        import cv2
        import numpy as np

        scaled = matrix * (OCCLUDER_SIZE / size)
        crop = cv2.warpAffine(frame, scaled, (OCCLUDER_SIZE, OCCLUDER_SIZE), borderMode=cv2.BORDER_REPLICATE)
        raw = self.occluder.run(None, {self.occluder_input: crop[None].astype(np.float32) / 255.0})[0][0, :, :, 0]
        return visible_face_mask(raw, size)

    # The next clip's seed: the swapped last frame, restored only when the chain has already blurred it.
    def finish_seed(self, last_swapped):
        enhance_ms = 0
        enhanced = False
        sharpness_before = round(self.sharpness(last_swapped), 1)
        sharpness_after = sharpness_before
        seed_frame = last_swapped
        if not SEED_FINISH:
            return seed_frame, enhance_ms, enhanced, sharpness_before, sharpness_after
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

    def swap_tail(
        self,
        video_path: str,
        source_face,
        restore: bool = RESTORE_FRAMES,
        recipe: str = FACE_RECIPE,
        tone_reference_stats=None,
        occlusion_mask: bool | None = None,
    ) -> tuple[dict[str, Any], bytes]:
        started = time.perf_counter()
        frame = self.read_tail_frame(video_path)
        faces = self.detector.get(frame)
        swapped = self.swap_frame(frame, source_face, faces, restore=restore, recipe=recipe, occlusion=occlusion_mask)
        swap_ms = int((time.perf_counter() - started) * 1000)
        tone_locked = False
        if tone_reference_stats is not None and SEED_FACE_TONE_LOCK:
            # The swap keeps the tail's landmarks, so the detection above still aligns the swapped face.
            swapped, tone_locked = self.face_tone_lock(swapped, faces, tone_reference_stats)
        seed_frame, enhance_ms, enhanced, sharpness_before, sharpness_after = self.finish_seed(swapped)
        stats = {
            "swap_ms": swap_ms,
            "had_face": bool(faces),
            "similarity_before": self.similarity(frame, source_face),
            "similarity_after": self.similarity(swapped, source_face),
            "tone_locked": tone_locked,
            "occlusion_mask": occlusion_on(occlusion_mask),
            "enhanced": enhanced,
            "enhance_ms": enhance_ms,
            "sharpness_before": sharpness_before,
            "sharpness_after": sharpness_after,
        }
        # Lossless like /lastFrame: this seed_frame becomes the next chain clip's seed, and a JPEG round trip here is one more thing the next render would compound.
        return stats, self.encode_png(seed_frame)

    # FaceFusion face_swapper's crop and tensor contract for HyperSwap and GHOST (model template at 256, (x/255 - 0.5)/0.5 RGB in, the inverse out); returns the swapped crop and the frame-to-crop matrix like insightface's paste_back=False path.
    def onnx_patch(self, frame, face, source_face, model: str):
        import cv2
        import numpy as np

        swapper = self.onnx_swapper(model)
        matrix, _ = cv2.estimateAffinePartial2D(
            face.kps.astype(np.float32), swapper["template"], method=cv2.RANSAC, ransacReprojThreshold=100
        )
        if matrix is None:
            return None, None
        crop = cv2.warpAffine(
            frame, matrix, (SWAP_SIZE, SWAP_SIZE), borderMode=cv2.BORDER_REPLICATE, flags=cv2.INTER_AREA
        )
        target = (crop[:, :, ::-1].astype(np.float32) / 255.0 - 0.5) / 0.5
        target = np.transpose(target, (2, 0, 1))[None]
        if swapper["converter"] is not None:
            raw = source_face.embedding.astype(np.float32).reshape(1, 512)
            source = swapper["converter"].run(None, {"input": raw})[0].reshape(1, -1)
        else:
            source = source_face.normed_embedding.reshape(1, -1)
        feed = {
            "source": source.astype(swapper["inputs"]["source"]),
            "target": target.astype(swapper["inputs"]["target"]),
        }
        output = swapper["session"].run([swapper["output"]], feed)[0]
        swapped = output[0].astype(np.float32).transpose(1, 2, 0) * 0.5 + 0.5
        swapped = (np.clip(swapped, 0.0, 1.0)[:, :, ::-1] * 255.0).astype(np.uint8)
        return swapped, matrix

    def swap_frame(
        self,
        frame,
        source_face,
        faces,
        timings: dict[str, float] | None = None,
        model: str = DEFAULT_SWAP_MODEL,
        restore: bool = True,
        recipe: str = FACE_RECIPE,
        occlusion: bool | None = None,
    ):
        import cv2

        masked = occlusion_on(occlusion) and self.occluder is not None
        out = frame
        for face in faces:
            started = time.perf_counter()
            if model in self.onnx_swapper_paths:
                patch, matrix = self.onnx_patch(out, face, source_face, model)
                if patch is None:
                    continue
            else:
                swapper = self.swapper_fp16 if model == "inswapper_fp16" and self.swapper_fp16 is not None else self.swapper
                # insightface's own paste_back blends the whole frame in float; paste_patch touches only the face box.
                patch, matrix = swapper.get(out, face, source_face, paste_back=False)
            size = patch.shape[0]
            original = cv2.warpAffine(frame, matrix, (size, size), borderMode=cv2.BORDER_REPLICATE)
            if recipe == "longlive":
                # The motion mask sits on ArcFace-128 eye and mouth positions; GHOST's 112 template puts them a few pixels off, still inside the soft ellipses.
                patch = keep_motion(patch, original, MOTION_KEEP)
            else:
                patch = match_patch_color(patch, original, face_ellipse_mask(size))
            visible = self.occlusion_mask(frame, matrix, size) if masked else None
            out = paste_patch(out, patch, matrix, visible)
            swapped_at = time.perf_counter()
            if recipe == "longlive":
                out = self.gfpgan_face(out, face, visible, matrix)
            elif restore and self.restorer is not None:
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
        self,
        video_path: str,
        source_face,
        output_path: str,
        model: str = DEFAULT_SWAP_MODEL,
        detect_every: int = 1,
        restore: bool = RESTORE_FRAMES,
        workers: int = WORKERS,
        recipe: str = FACE_RECIPE,
        occlusion_mask: bool | None = None,
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

        def detect(frame):
            detect_started = time.perf_counter()
            faces = self.detector.get(frame)
            with timings_lock:
                timings["detect"] += time.perf_counter() - detect_started
            return faces

        def process(frame, faces):
            local = {"swap": 0.0, "restore": 0.0}
            if faces is None:
                faces = detect(frame)
            swapped = self.swap_frame(frame, source_face, faces, local, model, restore, recipe, occlusion_mask)
            with timings_lock:
                for key, value in local.items():
                    timings[key] += value
            return swapped, bool(faces)

        pending: deque = deque()
        try:
            with ThreadPoolExecutor(max_workers=workers) as pool:
                def drain_one() -> None:
                    nonlocal frames, frames_with_face, last_frame, last_swapped
                    frame, future = pending.popleft()
                    swapped, had_face = future.result()
                    writer.stdin.write(swapped.tobytes())
                    frames_with_face += had_face
                    last_frame = frame
                    last_swapped = swapped
                    frames += 1

                def emit(frame, faces) -> None:
                    pending.append((frame, pool.submit(process, frame, faces)))
                    if len(pending) >= workers * 2:
                        drain_one()

                submitted = 0
                if detect_every <= 1 and not KPS_SMOOTH:
                    while submitted < MAX_CLIP_FRAMES:
                        ok, frame = capture.read()
                        if not ok:
                            break
                        emit(frame, None)
                        submitted += 1
                elif detect_every <= 1:
                    # Decode and detect the whole clip first (MAX_CLIP_FRAMES bounds memory) so landmarks can be smoothed across neighbouring frames before any swap.
                    decoded = []
                    detections = []
                    while len(decoded) < MAX_CLIP_FRAMES:
                        ok, frame = capture.read()
                        if not ok:
                            break
                        decoded.append(frame)
                        detections.append(pool.submit(detect, frame))
                    all_faces = smooth_faces([future.result() for future in detections])
                    for index, faces in enumerate(all_faces):
                        emit(decoded[index], faces)
                        decoded[index] = None
                    submitted = len(all_faces)
                else:
                    # Detection on every Nth frame only, landmarks interpolated between; a window whose face moved too far or changed count is detected frame by frame instead.
                    ok, frame = capture.read()
                    if ok:
                        key_faces = pool.submit(detect, frame).result()
                        emit(frame, key_faces)
                        submitted = 1
                    while ok and submitted < MAX_CLIP_FRAMES:
                        window = []
                        while len(window) < detect_every and submitted + len(window) < MAX_CLIP_FRAMES:
                            ok, frame = capture.read()
                            if not ok:
                                break
                            window.append(frame)
                        if not window:
                            break
                        next_faces = pool.submit(detect, window[-1]).result()
                        between = interpolate_faces(key_faces, next_faces, len(window) - 1)
                        if between is None:
                            between = [future.result() for future in [pool.submit(detect, f) for f in window[:-1]]]
                        for mid_frame, mid_faces in zip(window[:-1], between):
                            emit(mid_frame, mid_faces)
                        emit(window[-1], next_faces)
                        submitted += len(window)
                        key_faces = next_faces
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
            restored=recipe == "longlive" or (restore and self.restorer is not None),
            detect_ms=int(timings["detect"] * 1000),
            swap_stage_ms=int(timings["swap"] * 1000),
            restore_ms=int(timings["restore"] * 1000),
            enhanced=enhanced,
            enhance_ms=enhance_ms,
            sharpness_before=sharpness_before,
            sharpness_after=sharpness_after,
            recipe=recipe,
            occlusion_mask=occlusion_on(occlusion_mask) and self.occluder is not None,
        )
        return stats, self.encode_png(seed_frame)


# A face that moves further than this share of its eye distance between two detected frames is detected frame by frame instead.
INTERPOLATE_MAX_SHIFT = 0.35


def interpolate_faces(start_faces, end_faces, count: int):
    import numpy as np
    from insightface.app.common import Face

    if count <= 0:
        return []
    if not start_faces and not end_faces:
        return [[] for _ in range(count)]
    if len(start_faces) != 1 or len(end_faces) != 1:
        return None
    start, end = start_faces[0], end_faces[0]
    eye_distance = float(np.linalg.norm(start.kps[1] - start.kps[0]))
    shift = float(np.linalg.norm(end.kps - start.kps, axis=1).max())
    if shift > max(6.0, INTERPOLATE_MAX_SHIFT * eye_distance):
        return None
    faces = []
    for index in range(count):
        t = (index + 1) / (count + 1)
        faces.append(
            [
                Face(
                    bbox=start.bbox * (1 - t) + end.bbox * t,
                    kps=(start.kps * (1 - t) + end.kps * t).astype(np.float32),
                    det_score=min(float(start.det_score), float(end.det_score)),
                )
            ]
        )
    return faces


# Zero-phase EMA over runs of single-face frames; a run breaks where the count changes or the face jumps further than INTERPOLATE_MAX_SHIFT of its eye distance.
def smooth_faces(faces_per_frame, alpha: float = KPS_SMOOTH_ALPHA):
    import numpy as np
    from insightface.app.common import Face

    smoothed = list(faces_per_frame)
    runs: list[list[int]] = []
    for index, faces in enumerate(faces_per_frame):
        if faces is None or len(faces) != 1:
            continue
        if runs and runs[-1][-1] == index - 1:
            previous, current = faces_per_frame[index - 1][0], faces[0]
            eye_distance = float(np.linalg.norm(previous.kps[1] - previous.kps[0]))
            shift = float(np.linalg.norm(current.kps - previous.kps, axis=1).max())
            if shift <= INTERPOLATE_MAX_SHIFT * eye_distance:
                runs[-1].append(index)
                continue
        runs.append([index])
    for run in runs:
        if len(run) < 2:
            continue
        kps = ema_zero_phase(np.stack([faces_per_frame[i][0].kps for i in run]).astype(np.float32), alpha)
        bbox = ema_zero_phase(np.stack([faces_per_frame[i][0].bbox for i in run]).astype(np.float32), alpha)
        for offset, index in enumerate(run):
            smoothed[index] = [
                Face(bbox=bbox[offset], kps=kps[offset], det_score=faces_per_frame[index][0].det_score)
            ]
    return smoothed


def ema_zero_phase(values, alpha: float):
    forward = values.copy()
    for index in range(1, len(forward)):
        forward[index] = alpha * values[index] + (1.0 - alpha) * forward[index - 1]
    backward = forward.copy()
    for index in range(len(backward) - 2, -1, -1):
        backward[index] = alpha * forward[index] + (1.0 - alpha) * backward[index + 1]
    return backward


# Soft ellipse over the face in an aligned crop; inset by the feather so it reaches ~0 before the crop edge and never leaves a seam.
@lru_cache(maxsize=8)
def face_ellipse_mask(size: int):
    import cv2
    import numpy as np

    feather = max(size / 12.0, 2.0)
    ys, xs = np.ogrid[:size, :size]
    inside = ((xs + 0.5 - 0.5 * size) / (0.42 * size)) ** 2 + ((ys + 0.5 - 0.55 * size) / (0.5 * size)) ** 2 <= 1.0
    mask = inside.astype(np.float32)
    inset = int(round(feather))
    mask[:inset, :] = 0.0
    mask[-inset:, :] = 0.0
    mask[:, :inset] = 0.0
    mask[:, -inset:] = 0.0
    mask = cv2.GaussianBlur(mask, (0, 0), feather / 3)
    mask.setflags(write=False)
    return mask


# Soft eye and mouth regions of an ArcFace-128 crop, ported from LongLive's face_restore.motion_mask.
@lru_cache(maxsize=4)
def motion_mask(size: int):
    import cv2
    import numpy as np

    mask = np.zeros((size, size), np.float32)
    (lx, ly), (rx, ry), _, (mlx, mly), (mrx, mry) = ARCFACE_128_TEMPLATE
    for cx, cy, ax, ay in ((lx, ly, 0.11, 0.07), (rx, ry, 0.11, 0.07), ((mlx + mrx) / 2, (mly + mry) / 2, 0.17, 0.09)):
        cv2.ellipse(mask, (int(cx * size), int(cy * size)), (int(ax * size), int(ay * size)), 0, 0, 360, 1.0, -1)
    mask = cv2.GaussianBlur(mask, (0, 0), size / 32)
    mask.setflags(write=False)
    return mask


# Lets `keep` of the generated eyes and mouth through the swapped patch, so blinks and speech are not flattened.
def keep_motion(patch, original, keep: float):
    import numpy as np

    if keep <= 0:
        return patch
    weight = (motion_mask(patch.shape[0]) * keep)[:, :, None]
    return (patch.astype(np.float32) * (1.0 - weight) + original.astype(np.float32) * weight).astype(np.uint8)


# Reinhard LAB transfer of the swapped patch's moments onto the original crop's inside the face mask, then blended back by PATCH_COLOR_MATCH_BLEND.
def match_patch_color(patch, original, mask, blend: float = PATCH_COLOR_MATCH_BLEND):
    import cv2
    import numpy as np

    region = (mask > 0.5).astype(np.uint8)
    if not region.any():
        return patch
    patch_lab_u8 = cv2.cvtColor(patch, cv2.COLOR_BGR2LAB)
    patch_mean, patch_std = (v.reshape(3).astype(np.float32) for v in cv2.meanStdDev(patch_lab_u8, mask=region))
    original_mean, original_std = (
        v.reshape(3).astype(np.float32) for v in cv2.meanStdDev(cv2.cvtColor(original, cv2.COLOR_BGR2LAB), mask=region)
    )
    # A flat channel (std ~0) keeps its spread and only shifts its mean.
    scale = np.where(patch_std < 1e-3, 1.0, original_std / np.maximum(patch_std, 1e-3)).astype(np.float32)
    patch_lab = patch_lab_u8.astype(np.float32)
    matched = np.clip((patch_lab - patch_mean) * scale + original_mean, 0, 255).astype(np.uint8)
    matched = cv2.cvtColor(matched, cv2.COLOR_LAB2BGR)
    return cv2.addWeighted(matched, blend, patch, 1.0 - blend, 0)


def paste_patch(frame, patch, matrix, visible=None):
    # `matrix` maps frame -> patch. Blends the warped patch back with a feathered elliptical face mask, only
    # inside the frame region the patch lands on; the full-frame float blend was most of the per-frame cost.
    # `visible` (patch-sized, 0..1) cuts occluders out of that mask.
    import cv2
    import numpy as np

    size = patch.shape[0]
    mask = face_ellipse_mask(size) if visible is None else face_ellipse_mask(size) * visible

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


# FaceFusion's occluder post-process: resize to the crop, blur, then keep only the confident half so the cut edge is soft but a hand is fully excluded.
def visible_face_mask(raw, size: int, grow: int = OCCLUDER_GROW):
    import cv2
    import numpy as np

    raw = np.clip(raw, 0.0, 1.0).astype(np.float32)
    if grow > 0:
        raw = cv2.dilate(raw, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * grow + 1, 2 * grow + 1)))
    mask = cv2.resize(raw, (size, size))
    return (np.clip(cv2.GaussianBlur(mask, (0, 0), 5.0 * size / 128), 0.5, 1.0) - 0.5) * 2.0


# `outer` after the inverse of `inner` (both 2x3, frame -> crop): maps inner's crop onto outer's.
def chain_affine(outer, inner):
    import cv2
    import numpy as np

    inverse = cv2.invertAffineTransform(inner)
    return np.hstack([outer[:, :2] @ inverse[:, :2], (outer[:, :2] @ inverse[:, 2] + outer[:, 2])[:, None]])


def token_allowed(supplied: str | None) -> bool:
    # Fail closed: no SWAP_TOKEN configured means nobody gets in, not everybody.
    expected = os.environ.get("SWAP_TOKEN")
    return bool(expected) and supplied == expected


def bearer_token(authorization: str | None) -> str | None:
    if not authorization or not authorization.startswith("Bearer "):
        return None
    return authorization[len("Bearer ") :]


# The only swap source: an allowlisted persona resolved by LongLive's persona.py against the manifest under `root`. Fails closed with the reason; the caller plays the clip unswapped.
def persona_source_face(engine: SwapEngine, root: str | None, persona_id: object):
    from persona import resolve_persona

    if root is None:
        reason = "no persona store on this host"
    else:
        persona, reason = resolve_persona(root, persona_id)
        if persona is not None:
            return engine.persona_face(persona)
    print(f"swap: persona gate refused ({reason}), clip stays unswapped", flush=True)
    raise PersonaRejected(f"persona gate: {reason}")


def occlusion_on(requested: bool | None) -> bool:
    return OCCLUSION_MASK if requested is None else requested


def check_swap_options(engine: SwapEngine, model: str, recipe: str, occlusion_mask: bool | None = None) -> None:
    if model not in SWAP_MODELS:
        raise ValueError(f"unknown swap model {model!r}")
    # Fail instead of silently swapping with inswapper under another model's name.
    if not engine.has_swap_model(model):
        raise ValueError(f"{model} is not available on this engine")
    if recipe not in FACE_RECIPES:
        raise ValueError(f"unknown face recipe {recipe!r}")
    # Same for a recipe whose restore model is not loaded.
    if not engine.has_recipe(recipe):
        raise ValueError(f"{recipe} recipe is not available on this engine")
    # A requested hand mask with no occluder loaded would paste the face over the hand under the mask's name.
    if occlusion_on(occlusion_mask) and not engine.has_occluder():
        raise ValueError("occlusion mask is not available on this engine")


def download(url: str, path: str) -> None:
    with urllib.request.urlopen(url, timeout=60) as response, open(path, "wb") as file:
        while True:
            chunk = response.read(1 << 20)
            if not chunk:
                break
            file.write(chunk)


def check_frame_range(start_frame: int | None, end_frame: int | None) -> None:
    if start_frame is not None and start_frame < 0:
        raise ValueError("start_frame must be >= 0")
    if end_frame is not None and end_frame <= (start_frame or 0):
        raise ValueError("end_frame must be after start_frame")


# One segment of a split swap, frames [start_frame, end_frame): lossless, so the swap sees the same pixels a whole-clip pass would, and the audio is cut to the same span.
def trim_frames(source_path: str, output_path: str, start_frame: int | None, end_frame: int | None) -> None:
    import cv2

    capture = cv2.VideoCapture(source_path)
    fps = capture.get(cv2.CAP_PROP_FPS) or 24.0
    capture.release()
    start = start_frame or 0
    select = f"gte(n\\,{start})" if end_frame is None else f"between(n\\,{start}\\,{end_frame - 1})"
    atrim = f"atrim=start={start / fps:.6f}" + ("" if end_frame is None else f":end={end_frame / fps:.6f}")
    subprocess.run(
        [
            "ffmpeg", "-loglevel", "error", "-y", "-i", source_path,
            "-vf", f"select='{select}',setpts=N/FRAME_RATE/TB",
            "-af", f"{atrim},asetpts=PTS-STARTPTS",
            "-map", "0:v:0", "-map", "0:a:0?",
            "-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", "-pix_fmt", "yuv420p", "-c:a", "aac",
            output_path,
        ],
        check=True,
    )


def swap_clip_from_url(
    engine: SwapEngine,
    video_url: str,
    persona_root: str | None,
    persona_id: object,
    model: str = DEFAULT_SWAP_MODEL,
    recipe: str = FACE_RECIPE,
    occlusion_mask: bool | None = None,
    start_frame: int | None = None,
    end_frame: int | None = None,
) -> dict[str, Any]:
    # Gate before the download, so a refused persona costs nothing.
    check_swap_options(engine, model, recipe, occlusion_mask)
    source_face = persona_source_face(engine, persona_root, persona_id)
    check_frame_range(start_frame, end_frame)
    with tempfile.TemporaryDirectory() as directory:
        source_path = os.path.join(directory, "source.mp4")
        started = time.perf_counter()
        download(video_url, source_path)
        download_ms = int((time.perf_counter() - started) * 1000)
        if start_frame is not None or end_frame is not None:
            trimmed_path = os.path.join(directory, "segment.mp4")
            trim_started = time.perf_counter()
            trim_frames(source_path, trimmed_path, start_frame, end_frame)
            source_path = trimmed_path
            print(f"swapClip: range={start_frame}:{end_frame} trim_ms={int((time.perf_counter() - trim_started) * 1000)}", flush=True)
        with open(source_path, "rb") as file:
            options: dict[str, Any] = {"recipe": recipe}
            if occlusion_mask is not None:
                options["occlusion_mask"] = occlusion_mask
            result = swap_clip_with_face(engine, file.read(), source_face, model, options)
    result["stats"]["download_ms"] = download_ms
    stats = result["stats"]
    print(
        f"swapClip: persona={persona_id} model={model} recipe={stats['recipe']} occlusion_mask={occlusion_on(occlusion_mask)} restored={stats['restored']} frames={stats['frames']} download_ms={download_ms} swap_ms={stats['swap_ms']} "
        f"ms_per_frame={stats['ms_per_frame']} similarity={stats['similarity_before']}->{stats['similarity_after']} "
        f"enhance_ms={stats['enhance_ms']} sharpness={stats['sharpness_before']}->{stats['sharpness_after']}",
        flush=True,
    )
    return result


def swap_tail_from_url(
    engine: SwapEngine,
    video_url: str,
    persona_root: str | None,
    persona_id: object,
    recipe: str = FACE_RECIPE,
    # Colour stats only, never a swap source: the identity still comes from persona_source_face below.
    tone_frame_url: str | None = None,
    occlusion_mask: bool | None = None,
) -> dict[str, Any]:
    check_swap_options(engine, DEFAULT_SWAP_MODEL, recipe, occlusion_mask)
    source_face = persona_source_face(engine, persona_root, persona_id)
    reference_stats = None
    if tone_frame_url and SEED_FACE_TONE_LOCK:
        # Tone is a quality feature, not a guard: a reference that fails to load leaves the seed as swapped.
        try:
            reference_stats = tone_reference_stats(engine, tone_frame_url, face=True)
        except Exception as error:  # noqa: BLE001
            print(f"swapTail: tone reference failed: {error}", flush=True)
    with tempfile.TemporaryDirectory() as directory:
        source_path = os.path.join(directory, "source.mp4")
        started = time.perf_counter()
        download(video_url, source_path)
        download_ms = int((time.perf_counter() - started) * 1000)
        stats, seed_png = engine.swap_tail(
            source_path, source_face, recipe=recipe, tone_reference_stats=reference_stats, occlusion_mask=occlusion_mask
        )
    stats["download_ms"] = download_ms
    print(
        f"swapTail: download_ms={download_ms} swap_ms={stats['swap_ms']} had_face={stats['had_face']} "
        f"tone_locked={stats['tone_locked']} occlusion_mask={occlusion_on(occlusion_mask)} "
        f"similarity={stats['similarity_before']}->{stats['similarity_after']} "
        f"enhance_ms={stats['enhance_ms']} sharpness={stats['sharpness_before']}->{stats['sharpness_after']}",
        flush=True,
    )
    return {"last_frame_base64": base64.b64encode(seed_png).decode("ascii"), "stats": stats}


# The session's first frame is the same URL for every seed of that session, so its LAB moments are computed once per container.
_tone_stats_cache: dict[str, Any] = {}
_tone_stats_lock = threading.Lock()


# face=True: the reference's face-ellipse moments (SEED_FACE_TONE_LOCK) instead of the whole frame's.
def tone_reference_stats(engine: SwapEngine, url: str, face: bool = False):
    key = (url, face)
    with _tone_stats_lock:
        cached = _tone_stats_cache.get(key)
    if cached is not None:
        return cached
    with urllib.request.urlopen(url, timeout=30) as response:
        image = engine.decode_image(response.read())
    if image is None:
        raise ValueError("tone reference is not an image")
    if face:
        crop, _ = engine.aligned_face_crop(image, engine.detector.get(image))
        if crop is None:
            raise ValueError("tone reference has no face")
        stats = engine.face_ellipse_stats(crop)
    else:
        stats = engine.frame_lab_stats(image)
    with _tone_stats_lock:
        if len(_tone_stats_cache) >= 16:
            _tone_stats_cache.clear()
        _tone_stats_cache[key] = stats
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
    if tone_reference_url and SEED_TONE_LOCK:
        # Tone is a quality feature, not a guard: a reference that fails to load leaves the seed as rendered.
        try:
            frame = engine.tone_lock(frame, tone_reference_stats(engine, tone_reference_url))
            tone_locked = True
        except Exception as error:  # noqa: BLE001
            print(f"lastFrame: tone reference failed: {error}", flush=True)
    elif tone_reference_url and SEED_FACE_TONE_LOCK:
        try:
            reference = tone_reference_stats(engine, tone_reference_url, face=True)
            frame, tone_locked = engine.face_tone_lock(frame, engine.detector.get(frame), reference)
        except Exception as error:  # noqa: BLE001
            print(f"lastFrame: face tone reference failed: {error}", flush=True)
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


# Head-only crop of the reference for reference-to-video's identity image: the full photo's room and clothes were copied into the scene.
def face_crop_from_data_uri(engine: SwapEngine, data_uri: str, scale: float = 1.6, size: int = 512) -> dict[str, Any]:
    import cv2

    header, _, payload = data_uri.partition(",")
    if not header.startswith("data:image/"):
        raise ValueError("reference must be an image data URI")
    image = engine.decode_image(base64.b64decode(payload))
    height, width = image.shape[:2]
    # Replicated border: the detector misses a face that fills the photo, and the square crop may run past its edges.
    padded = cv2.copyMakeBorder(image, height, height, width, width, cv2.BORDER_REPLICATE)
    faces = engine.identity.get(padded)
    if len(faces) != 1:
        raise ValueError(f"reference must contain exactly one face, found {len(faces)}")
    x1, y1, x2, y2 = faces[0].bbox
    side = scale * max(x2 - x1, y2 - y1)
    # Centre a little above the bbox so the crop keeps the hair and stops above the shoulders.
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2 - 0.1 * (y2 - y1)
    left, top = int(round(cx - side / 2)), int(round(cy - side / 2))
    # Neutral grey past the photo's edges: replicated streaks read as scene content to the video model.
    plain = cv2.copyMakeBorder(image, height, height, width, width, cv2.BORDER_CONSTANT, value=(128, 128, 128))
    crop = plain[max(top, 0) : top + int(side), max(left, 0) : left + int(side)]
    crop = cv2.resize(crop, (size, size), interpolation=cv2.INTER_AREA)
    return {"crop_base64": base64.b64encode(engine.encode_jpeg(crop)).decode("ascii")}


def swap_tail_from_bytes(
    engine: SwapEngine, video: bytes, persona_root: str | None, persona_id: object
) -> dict[str, Any]:
    check_swap_options(engine, DEFAULT_SWAP_MODEL, FACE_RECIPE)
    source_face = persona_source_face(engine, persona_root, persona_id)
    with tempfile.TemporaryDirectory() as directory:
        source_path = os.path.join(directory, "source.mp4")
        with open(source_path, "wb") as file:
            file.write(video)
        stats, seed_png = engine.swap_tail(source_path, source_face)
    return {"last_frame_base64": base64.b64encode(seed_png).decode("ascii"), "stats": stats}


def swap_clip_from_bytes(
    engine: SwapEngine,
    video: bytes,
    persona_root: str | None,
    persona_id: object,
    model: str = DEFAULT_SWAP_MODEL,
    options: dict[str, Any] | None = None,
) -> dict[str, Any]:
    check_swap_options(
        engine, model, (options or {}).get("recipe", FACE_RECIPE), (options or {}).get("occlusion_mask")
    )
    source_face = persona_source_face(engine, persona_root, persona_id)
    return swap_clip_with_face(engine, video, source_face, model, options)


def swap_clip_with_face(
    engine: SwapEngine,
    video: bytes,
    source_face,
    model: str = DEFAULT_SWAP_MODEL,
    options: dict[str, Any] | None = None,
) -> dict[str, Any]:
    # Response: base64 mp4 + base64 PNG of the swapped last frame (the next clip's seed) + stats.
    with tempfile.TemporaryDirectory() as directory:
        source_path = os.path.join(directory, "source.mp4")
        output_path = os.path.join(directory, "swapped.mp4")
        with open(source_path, "wb") as file:
            file.write(video)
        stats, last_frame = engine.swap_clip(source_path, source_face, output_path, model, **(options or {}))
        with open(output_path, "rb") as file:
            swapped = file.read()
    return {
        "video_base64": base64.b64encode(swapped).decode("ascii"),
        "last_frame_base64": base64.b64encode(last_frame).decode("ascii"),
        "last_frame_format": "png",
        "stats": asdict(stats),
    }


def profile_networks(
    engine: SwapEngine, video: bytes, persona_root: str | None, persona_id: object, runs: int = 30
) -> dict[str, Any]:
    source_face = persona_source_face(engine, persona_root, persona_id)
    with tempfile.TemporaryDirectory() as directory:
        source_path = os.path.join(directory, "source.mp4")
        with open(source_path, "wb") as file:
            file.write(video)
        frame = engine.read_tail_frame(source_path)
    faces = engine.detector.get(frame)
    if not faces:
        raise ValueError("no face in the profiled frame")
    face = faces[0]

    def timed(fn) -> float:
        fn()
        started = time.perf_counter()
        for _ in range(runs):
            fn()
        return round((time.perf_counter() - started) * 1000 / runs, 2)

    result = {
        "detect_ms": timed(lambda: engine.detector.get(frame)),
        "inswapper_ms": timed(lambda: engine.swapper.get(frame, face, source_face, paste_back=False)),
        "full_frame_ms": timed(lambda: engine.swap_frame(frame, source_face, engine.detector.get(frame))),
    }
    if engine.restorer is not None:
        result["restore_ms"] = timed(lambda: engine.restore_face(frame, face, source_face))
    if engine.gfpgan is not None:
        result["gfpgan_ms"] = timed(lambda: engine.gfpgan_face(frame, face))
    for model in list(engine.onnx_swappers):
        result[f"{model}_ms"] = timed(lambda: engine.onnx_patch(frame, face, source_face, model))
    return result
