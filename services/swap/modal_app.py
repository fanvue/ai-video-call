# Modal host for the Swap service, used for the POC while fal serverless access is pending.
# Deploy: .venv-fal/bin/modal deploy services/swap/modal_app.py
import os
import sys
import threading
import time
from pathlib import Path

import modal
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, StrictBool

# The persona allowlist is LongLive's persona.py, imported rather than copied so both swaps share one gate.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "longlive"))

from swap_core import (  # noqa: E402
    CROSSFACE_GHOST_URL,
    DEFAULT_SWAP_MODEL,
    ENHANCER_URL,
    FACE_RECIPE,
    FACE_RECIPES,
    GFPGAN_URL,
    GHOST_1_URL,
    HYPERSWAP_1C_URL,
    HYPERSWAP_URL,
    INSWAPPER_FP16_URL,
    INSWAPPER_URL,
    OCCLUDER_URL,
    REQUIREMENTS,
    RESTORER_URL,
    SWAP_MODELS,
    SwapEngine,
    bearer_token,
    face_crop_from_data_uri,
    last_frame_from_url,
    profile_networks,
    swap_clip_from_bytes,
    swap_clip_from_url,
    swap_tail_from_bytes,
    swap_tail_from_url,
    token_allowed,
)

app = modal.App("ai-video-swap")
# Read-only for the GPU swap: registration goes through LongLive's route or the CPU store below; a missing volume fails the deploy instead of leaving an empty allowlist.
personas_volume = modal.Volume.from_name("persona-faces").read_only()
PERSONA_ROOT = "/personas"
# Picks up `modal volume put` and registered personas without a reload on every clip.
PERSONA_RELOAD_S = 30.0
# Writable only for the CPU store below, which serves swap mode's persona list and registration.
personas_store_volume = modal.Volume.from_name("persona-faces")
# No CUDA base, no models: the list and registration are file and JSON work. swap_core is here only because this module imports it at load; its top level is stdlib.
persona_image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("fastapi", "uvicorn")
    .add_local_python_source("persona", "protocol", "persona_store", "swap_core")
)

# onnxruntime-gpu needs the CUDA 12 + cuDNN 9 runtime libraries on the image or it silently falls back to CPU.
image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04", add_python="3.11"
    )
    # The image ships a cuda apt repo whose index fails apt-get update; the CUDA libs are already on disk so drop it.
    .run_commands(
        "rm -f /etc/apt/sources.list.d/cuda*.list /etc/apt/sources.list.d/nvidia*.list",
        "apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 wget build-essential clang ffmpeg && rm -rf /var/lib/apt/lists/*",
    )
    # Modal's bundled Python has clang++ baked into sysconfig, which insightface's Cython build uses.
    .env({"CC": "clang", "CXX": "clang++"})
    .pip_install(*REQUIREMENTS, "fastapi", "uvicorn")
    .run_commands(
        "mkdir -p /models",
        f"wget -q -O /models/inswapper_128.onnx {INSWAPPER_URL}",
        f"wget -q -O /models/restorer.onnx {RESTORER_URL}",
        f"wget -q -O /models/real_esrgan_x2.onnx {ENHANCER_URL}",
        f"wget -q -O /models/hyperswap_1a_256.onnx {HYPERSWAP_URL}",
        f"wget -q -O /models/inswapper_128_fp16.onnx {INSWAPPER_FP16_URL}",
        f"wget -q -O /models/hyperswap_1c_256.onnx {HYPERSWAP_1C_URL}",
        f"wget -q -O /models/ghost_1_256.onnx {GHOST_1_URL}",
        f"wget -q -O /models/crossface_ghost.onnx {CROSSFACE_GHOST_URL}",
        f"wget -q -O /models/gfpgan_1.4.onnx {GFPGAN_URL}",
        f"wget -q -O /models/xseg_1.onnx {OCCLUDER_URL}",
        # insightface otherwise downloads the 275MB buffalo_l pack on every cold start.
        "python -c \"from insightface.utils.storage import ensure_available; ensure_available('models', 'buffalo_l', root='/root/.insightface')\"",
    )
    # fp16 GFPGAN with its norms kept fp32: longlive 46.6 -> 34.6 ms/frame on 6 turbo clips (A10G, same container), paired ArcFace +0.0012, 67 dB PSNR vs fp32.
    .add_local_file(Path(__file__).parent / "onnx_fp16.py", "/root/onnx_fp16.py", copy=True)
    .run_commands("python /root/onnx_fp16.py /models/gfpgan_1.4.onnx /models/gfpgan_1.4_fp16.onnx")
    .add_local_python_source("swap_core", "persona")
)


class SwapClipRequest(BaseModel):
    video_url: str
    # The swap source is a manifest persona; an uploaded reference sent here is ignored, never swapped in.
    persona_id: str | None = None
    # Split swap: frames [start_frame, end_frame) only, so a reply's two halves swap on two containers at once; check_frame_range 422s a bad range. Absent, the whole clip.
    start_frame: int | None = None
    end_frame: int | None = None
    model: str = DEFAULT_SWAP_MODEL
    # "Face lock" under Advanced: "longlive" swaps in LongLive's persona recipe (kept eyes/mouth, GFPGAN restore) instead of the legacy pass.
    recipe: str = FACE_RECIPE
    # "Hand mask" under Advanced: overrides OCCLUSION_MASK for this clip; strict so a "false" string is a 422, not a truthy mask.
    occlusion_mask: StrictBool | None = None


class SwapTailRequest(SwapClipRequest):
    # The session's first clip's seed; the tail's face tone is pulled toward it (SEED_FACE_TONE_LOCK).
    tone_reference_url: str | None = None


class FaceCropRequest(BaseModel):
    reference_image: str


class LastFrameRequest(BaseModel):
    video_url: str
    tone_reference_url: str | None = None


@app.cls(
    image=image,
    # A10G over L40S: ~1.10 vs 1.95 $/hr, and credit is nearly gone; GPEN-256 needs far less GPU headroom than the 512 restorer did. L4 as a fallback: Modal logged "waiting to be scheduled on a GPU_A10G worker" mid-session and the pool ran on one GPU, which showed as holds.
    gpu=["A10G", "L4"],
    # Detection, paste-back and the x264 encode are CPU work; Modal's default fractional core starves them.
    cpu=8,
    secrets=[modal.Secret.from_name("ai-video-swap-token")],
    volumes={PERSONA_ROOT: personas_volume},
    # Swaps arrive every few seconds during a call, so a minute without one means the call ended; shorter idle billing after each session, and the upload warm-up covers the next cold start (~11 s).
    scaledown_window=60,
    # A join burst needs up to 4 real swaps in flight; one per container beats 3 sharing one GPU.
    max_containers=4,
    # Prod showed 8 to 15 s of queueing per clip when a fourth swap arrived and its container was still starting; keep two warm spares while the app has traffic.
    buffer_containers=2,
    # Scale to zero between sessions: the client warms containers when a photo is uploaded, ahead of the first swap.
    min_containers=0,
    timeout=600,
)
# One clip per container at a time: 3 packed onto one GPU measured ~3x slower per frame, not free concurrency.
@modal.concurrent(max_inputs=1)
class SwapService:
    @modal.enter()
    def setup(self) -> None:
        self.engine = SwapEngine(
            "/models/inswapper_128.onnx",
            "/models/restorer.onnx",
            "/models/real_esrgan_x2.onnx",
            "/models/hyperswap_1a_256.onnx",
            "/models/inswapper_128_fp16.onnx",
            onnx_swapper_paths={
                "hyperswap_1c": "/models/hyperswap_1c_256.onnx",
                "ghost_1": "/models/ghost_1_256.onnx",
                "crossface_ghost": "/models/crossface_ghost.onnx",
            },
            gfpgan_path="/models/gfpgan_1.4_fp16.onnx",
            occluder_path="/models/xseg_1.onnx",
        )
        self.persona_lock = threading.Lock()
        self.personas_reloaded_at = 0.0

    def fresh_personas(self) -> str:
        with self.persona_lock:
            if time.monotonic() - self.personas_reloaded_at >= PERSONA_RELOAD_S:
                try:
                    personas_volume.reload()
                    self.personas_reloaded_at = time.monotonic()
                except Exception as error:  # noqa: BLE001 - a stale view still fails closed on anything it cannot resolve.
                    print(f"swap: persona volume reload failed: {error!r}", flush=True)
        return PERSONA_ROOT

    # Modal-authenticated path for smoke tests and the swapper bake-off from a laptop, so no clip needs a public URL; its defaults match the web path.
    @modal.method()
    def swap_clip_bytes(
        self, video: bytes, persona_id: str, model: str = DEFAULT_SWAP_MODEL, options: dict | None = None
    ) -> dict:
        return swap_clip_from_bytes(self.engine, video, self.fresh_personas(), persona_id, model, options)

    # Sequential per-network latency on one real frame, to see which stage bounds the per-frame cost.
    @modal.method()
    def profile_bytes(self, video: bytes, persona_id: str, runs: int = 30) -> dict:
        return profile_networks(self.engine, video, self.fresh_personas(), persona_id, runs)

    @modal.method()
    def face_crop_bytes(self, reference_image: str) -> dict:
        return face_crop_from_data_uri(self.engine, reference_image)

    @modal.method()
    def swap_tail_bytes(self, video: bytes, persona_id: str) -> dict:
        return swap_tail_from_bytes(self.engine, video, self.fresh_personas(), persona_id)

    @modal.asgi_app()
    def web(self):
        api = FastAPI()
        engine = self.engine

        @api.get("/health")
        def health() -> dict[str, str]:
            return {"status": "ok"}

        @api.post("/lastFrame")
        def last_frame(
            body: LastFrameRequest, authorization: str | None = Header(default=None)
        ) -> dict:
            if not token_allowed(bearer_token(authorization)):
                raise HTTPException(status_code=403, detail="unauthorized")
            try:
                return last_frame_from_url(engine, body.video_url, body.tone_reference_url)
            except ValueError as error:
                raise HTTPException(status_code=422, detail=str(error)) from error

        @api.post("/faceCrop")
        def face_crop(
            body: FaceCropRequest, authorization: str | None = Header(default=None)
        ) -> dict:
            if not token_allowed(bearer_token(authorization)):
                raise HTTPException(status_code=403, detail="unauthorized")
            try:
                return face_crop_from_data_uri(engine, body.reference_image)
            except ValueError as error:
                raise HTTPException(status_code=422, detail=str(error)) from error

        @api.post("/swapTail")
        def swap_tail(
            body: SwapTailRequest, authorization: str | None = Header(default=None)
        ) -> dict:
            if not token_allowed(bearer_token(authorization)):
                raise HTTPException(status_code=403, detail="unauthorized")
            if body.recipe not in FACE_RECIPES:
                raise HTTPException(status_code=400, detail=f"unknown face recipe {body.recipe!r}")
            try:
                return swap_tail_from_url(
                    engine,
                    body.video_url,
                    self.fresh_personas(),
                    body.persona_id,
                    recipe=body.recipe,
                    tone_frame_url=body.tone_reference_url,
                    occlusion_mask=body.occlusion_mask,
                )
            except ValueError as error:
                raise HTTPException(status_code=422, detail=str(error)) from error

        # Sync handler on purpose: FastAPI runs it in a worker thread so the GPU loop never blocks the event loop.
        @api.post("/swapClip")
        def swap_clip(
            body: SwapClipRequest, authorization: str | None = Header(default=None)
        ) -> dict:
            if not token_allowed(bearer_token(authorization)):
                raise HTTPException(status_code=403, detail="unauthorized")
            if body.model not in SWAP_MODELS:
                raise HTTPException(status_code=422, detail=f"unknown swap model {body.model!r}")
            if body.recipe not in FACE_RECIPES:
                raise HTTPException(status_code=400, detail=f"unknown face recipe {body.recipe!r}")
            try:
                return swap_clip_from_url(
                    engine,
                    body.video_url,
                    self.fresh_personas(),
                    body.persona_id,
                    body.model,
                    recipe=body.recipe,
                    occlusion_mask=body.occlusion_mask,
                    start_frame=body.start_frame,
                    end_frame=body.end_frame,
                )
            except ValueError as error:
                raise HTTPException(status_code=422, detail=str(error)) from error

        return api


# Swap mode's persona list and registration without waking a GPU: tokens are minted by the Vercel routes with SWAP_TOKEN, checked here with LongLive's protocol.py.
@app.cls(
    image=persona_image,
    cpu=0.25,
    memory=256,
    secrets=[modal.Secret.from_name("ai-video-swap-token")],
    volumes={PERSONA_ROOT: personas_store_volume},
    scaledown_window=15,
    # One container, so registrations serialise on its write lock.
    max_containers=1,
    min_containers=0,
    timeout=60,
)
@modal.concurrent(max_inputs=8)
class PersonaStore:
    @modal.asgi_app()
    def web(self):
        from persona_store import build_persona_api

        return build_persona_api(
            PERSONA_ROOT,
            lambda: os.environ.get("SWAP_TOKEN"),
            personas_store_volume.reload,
            personas_store_volume.commit,
        )
