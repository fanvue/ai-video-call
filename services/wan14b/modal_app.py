# Modal host for the wan14b premium clip service: one chained image-to-video clip per call, seeded, persona-swapped and tone-locked.
# Weights: the wan14b-weights volume (filled by scratchpad wan14b/download.py). Deploy: .venv-fal/bin/modal deploy services/wan14b/modal_app.py
import base64
import sys
import threading
import time
from pathlib import Path

import modal
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, StrictBool

HERE = Path(__file__).resolve().parent
# Auth, persona gate and face swap are the swap service's, imported rather than copied so both fail closed the same way.
sys.path.insert(0, str(HERE.parent / "swap"))
sys.path.insert(0, str(HERE.parent / "longlive"))

from clip_request import check_prompt, frame_count, seed_gate, seed_image_bytes  # noqa: E402
from swap_core import (  # noqa: E402
    INSWAPPER_FP16_URL,
    INSWAPPER_URL,
    PersonaRejected,
    bearer_token,
    persona_source_face,
    token_allowed,
)

app = modal.App("ai-video-wan14b")
weights = modal.Volume.from_name("wan14b-weights")
personas_volume = modal.Volume.from_name("persona-faces").read_only()
PERSONA_ROOT = "/personas"
PERSONA_RELOAD_S = 30.0

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "build-essential", "libgl1", "libglib2.0-0", "wget")
    .pip_install("torch==2.10.0", "torchvision==0.25.0", index_url="https://download.pytorch.org/whl/cu128")
    .pip_install(
        "diffusers==0.40.0", "transformers==5.17.0", "accelerate==1.15.0", "peft==0.21.0", "safetensors==0.8.0",
        "huggingface_hub[hf_xet]==1.32.0", "torchao==0.16.0", "kernels==0.17.1",
        "ftfy", "sentencepiece", "pillow", "numpy<2", "regex", "fastapi", "uvicorn",
    )
    # onnxruntime-gpu 1.22 finds torch's pip CUDA/cuDNN through preload_dlls, so the swap shares the H100 with Wan.
    .pip_install("insightface==0.7.3", "onnxruntime-gpu==1.22.0", "opencv-python-headless==4.10.0.84")
    .run_commands(
        "mkdir -p /models",
        f"wget -q -O /models/inswapper_128.onnx {INSWAPPER_URL}",
        f"wget -q -O /models/inswapper_128_fp16.onnx {INSWAPPER_FP16_URL}",
        "python -c \"from insightface.utils.storage import ensure_available; ensure_available('models', 'buffalo_l', root='/root/.insightface')\"",
    )
    .env({
        # The compile/autotune cache lives on the weights volume so a cold container reuses the last one's kernels.
        "TORCHINDUCTOR_CACHE_DIR": "/weights/inductor",
        "HF_HUB_CACHE": "/weights/hf-hub",
        "TOKENIZERS_PARALLELISM": "false",
        "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True",
    })
    .add_local_python_source("clip_request", "seed_lock", "engine", "swap_core", "persona")
)


class ClipRequest(BaseModel):
    persona_id: str
    prompt: str
    image_url: str | None = None
    image_base64: str | None = None
    num_frames: int | None = None
    duration_s: float | None = None
    seed: int | None = None
    # Swap the persona onto every output frame (swap mode's legacy recipe); the seed for the next clip is always swapped.
    swap: StrictBool = True
    # The session's first seed; the next seed's face tone is pulled toward it. Absent, the persona photo is the reference.
    tone_reference_base64: str | None = None


@app.cls(
    image=image,
    gpu="H100",
    cpu=8,
    memory=98304,
    secrets=[modal.Secret.from_name("ai-video-swap-token")],
    volumes={"/weights": weights, PERSONA_ROOT: personas_volume},
    # Scale to zero between sessions; a minute without a clip means the stream ended.
    min_containers=0,
    scaledown_window=60,
    # One stream per container: the chain is sequential, so a second container never speeds up one stream.
    max_containers=2,
    timeout=900,
)
# One clip per container at a time: a second 14B render on the same GPU just halves both.
@modal.concurrent(max_inputs=1)
class Wan14bService:
    @modal.enter()
    def setup(self) -> None:
        import onnxruntime

        onnxruntime.preload_dlls()
        from engine import WanEngine
        from swap_core import SwapEngine

        started = time.perf_counter()
        self.engine = WanEngine()
        self.swap = SwapEngine("/models/inswapper_128.onnx", inswapper_fp16_path="/models/inswapper_128_fp16.onnx")
        self.swap.warm_up()
        self.engine.warm_up()
        self.persona_lock = threading.Lock()
        self.personas_reloaded_at = 0.0
        print(f"wan14b: ready in {time.perf_counter() - started:.1f}s", flush=True)

    def fresh_personas(self) -> str:
        with self.persona_lock:
            if time.monotonic() - self.personas_reloaded_at >= PERSONA_RELOAD_S:
                try:
                    personas_volume.reload()
                    self.personas_reloaded_at = time.monotonic()
                except Exception as error:  # noqa: BLE001 - a stale view still fails closed on anything it cannot resolve.
                    print(f"wan14b: persona volume reload failed: {error!r}", flush=True)
        return PERSONA_ROOT

    def largest_face(self, bgr):
        faces = self.swap.detector.get(bgr)
        return max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1])) if faces else None

    def reference_stats(self, persona, tone_reference: bytes | None):
        import seed_lock

        bgr = self.swap.decode_image(tone_reference) if tone_reference else None
        if bgr is None:
            with open(persona.path, "rb") as handle:
                bgr = self.swap.decode_image(handle.read())
        face = self.largest_face(bgr)
        if face is None:
            return None
        stats, _ = seed_lock.face_stats(bgr, face.kps)
        return stats

    def render(self, body: dict) -> dict:
        import cv2
        import numpy as np
        from PIL import Image

        import clip_request
        import seed_lock
        from engine import encode_mp4
        from persona import resolve_persona

        started = time.perf_counter()
        prompt = check_prompt(body.get("prompt"))
        num_frames = frame_count(body.get("num_frames"), body.get("duration_s"))
        seed_bytes = seed_image_bytes(body.get("image_url"), body.get("image_base64"))
        tone_reference = body.get("tone_reference_base64")
        tone_bytes = clip_request.decode_base64_image(tone_reference) if tone_reference else None
        root = self.fresh_personas()
        source_face = persona_source_face(self.swap, root, body.get("persona_id"))
        persona, _ = resolve_persona(root, body.get("persona_id"))
        seed_bgr = self.swap.decode_image(seed_bytes)
        if seed_bgr is None:
            raise ValueError("seed image is unreadable")
        seed_gate(self.swap.similarity(seed_bgr, source_face))
        frames, timings = self.engine.generate(Image.fromarray(cv2.cvtColor(seed_bgr, cv2.COLOR_BGR2RGB)), prompt, num_frames,
                                               seed=42 if body.get("seed") is None else body["seed"])
        mark = time.perf_counter()
        if body.get("swap", True):
            from concurrent.futures import ThreadPoolExecutor

            def one(frame):
                bgr = cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)
                out = self.swap.swap_frame(bgr, source_face, self.swap.detector.get(bgr), model="inswapper_fp16",
                                           restore=False, recipe="legacy")
                return cv2.cvtColor(out, cv2.COLOR_BGR2RGB)

            with ThreadPoolExecutor(3) as pool:
                frames = np.stack(list(pool.map(one, frames)))
            last_bgr = cv2.cvtColor(frames[-1], cv2.COLOR_RGB2BGR)
        else:
            # Unswapped playback still seeds from a swapped tail, as swap mode's /swapTail does.
            last_bgr = cv2.cvtColor(frames[-1], cv2.COLOR_RGB2BGR)
            last_bgr = self.swap.swap_frame(last_bgr, source_face, self.swap.detector.get(last_bgr), model="inswapper_fp16",
                                            restore=False, recipe="legacy")
        timings["swap_ms"] = int((time.perf_counter() - mark) * 1000)
        face = self.largest_face(last_bgr)
        seed_out, tone_locked = seed_lock.tone_lock(last_bgr, face.kps if face is not None else None,
                                                    self.reference_stats(persona, tone_bytes))
        mark = time.perf_counter()
        video = encode_mp4(frames)
        timings["encode_ms"] = int((time.perf_counter() - mark) * 1000)
        timings["total_ms"] = int((time.perf_counter() - started) * 1000)
        stats = {**timings, "num_frames": int(frames.shape[0]), "fps": 16, "tone_locked": tone_locked,
                 "similarity_after": self.swap.similarity(seed_out, source_face)}
        print(f"wan14b: {stats}", flush=True)
        return {
            "video_base64": base64.b64encode(video).decode("ascii"),
            # Lossless: this frame seeds the next clip, and a JPEG round trip would compound across the chain.
            "last_frame_base64": base64.b64encode(cv2.imencode(".png", seed_out)[1].tobytes()).decode("ascii"),
            "last_frame_format": "png",
            "stats": stats,
        }

    # Modal-authenticated path for smoke tests from a laptop, same body as POST /clip.
    @modal.method()
    def clip_bytes(self, body: dict) -> dict:
        return self.render(body)

    @modal.asgi_app()
    def web(self):
        api = FastAPI()

        @api.get("/health")
        def health() -> dict[str, str]:
            return {"status": "ok"}

        # Sync handler on purpose: FastAPI runs it in a worker thread so the GPU work never blocks the event loop.
        @api.post("/clip")
        def clip(body: ClipRequest, authorization: str | None = Header(default=None)) -> dict:
            if not token_allowed(bearer_token(authorization)):
                raise HTTPException(status_code=403, detail="unauthorized")
            try:
                return self.render(body.model_dump())
            except (ValueError, PersonaRejected) as error:
                raise HTTPException(status_code=422, detail=str(error)) from error

        return api


@app.local_entrypoint()
def smoke(seed_path: str, persona_id: str = "synth-persona-01", out: str = "wan14b-smoke"):
    # Two chained clips through the deployed class: clip 2 seeds from clip 1's returned last frame.
    with open(seed_path, "rb") as handle:
        seed = base64.b64encode(handle.read()).decode("ascii")
    service = modal.Cls.from_name("ai-video-wan14b", "Wan14bService")()
    prompts = ["a woman sits facing the camera and smiles warmly, soft indoor light", "a woman tilts her head and laughs softly, soft indoor light"]
    for index, prompt in enumerate(prompts, 1):
        result = service.clip_bytes.remote({"persona_id": persona_id, "prompt": prompt, "image_base64": seed, "seed": index})
        Path(f"{out}-{index}.mp4").write_bytes(base64.b64decode(result["video_base64"]))
        Path(f"{out}-{index}-last.png").write_bytes(base64.b64decode(result["last_frame_base64"]))
        print(index, result["stats"])
        seed = result["last_frame_base64"]
