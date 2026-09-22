# Modal host for the Swap service, used for the POC while fal serverless access is pending.
# Deploy: .venv-fal/bin/modal deploy services/swap/modal_app.py
import modal
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

from swap_core import (
    ENHANCER_URL,
    HYPERSWAP_URL,
    INSWAPPER_URL,
    REQUIREMENTS,
    RESTORER_URL,
    SwapEngine,
    bearer_token,
    last_frame_from_url,
    swap_clip_from_bytes,
    swap_clip_from_url,
    swap_tail_from_bytes,
    swap_tail_from_url,
    token_allowed,
)

app = modal.App("ai-video-swap")

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
        # insightface otherwise downloads the 275MB buffalo_l pack on every cold start.
        "python -c \"from insightface.utils.storage import ensure_available; ensure_available('models', 'buffalo_l', root='/root/.insightface')\"",
    )
    .add_local_python_source("swap_core")
)


class SwapClipRequest(BaseModel):
    video_url: str
    reference_image: str


class LastFrameRequest(BaseModel):
    video_url: str


@app.cls(
    image=image,
    # A10G over L40S: ~1.10 vs 1.95 $/hr, and credit is nearly gone; GPEN-256 needs far less GPU headroom than the 512 restorer did. L4 as a fallback: Modal logged "waiting to be scheduled on a GPU_A10G worker" mid-session and the pool ran on one GPU, which showed as holds.
    gpu=["A10G", "L4"],
    # Detection, paste-back and the x264 encode are CPU work; Modal's default fractional core starves them.
    cpu=8,
    secrets=[modal.Secret.from_name("ai-video-swap-token")],
    # Long enough to survive the gap between a fan's sessions; a cold start is 60s+ (image pull + CUDA init).
    scaledown_window=600,
    # A join burst needs up to 4 real swaps in flight; one per container beats 3 sharing one GPU.
    max_containers=4,
    # Prod showed 8 to 15 s of queueing per clip when a fourth swap arrived and its container was still starting; keep two warm spares while the app has traffic.
    buffer_containers=2,
    # This account's GPU quota capped out at 2 concurrent L40S workers (Modal: "waiting to be scheduled" above this); re-check headroom before raising it on A10G.
    min_containers=2,
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
        )

    # Modal-authenticated path for smoke tests and the swapper bake-off from a laptop, so no clip needs a public URL; prod's web path stays on inswapper.
    @modal.method()
    def swap_clip_bytes(self, video: bytes, reference_image: str, model: str = "inswapper") -> dict:
        return swap_clip_from_bytes(self.engine, video, reference_image, model)

    @modal.method()
    def swap_tail_bytes(self, video: bytes, reference_image: str) -> dict:
        return swap_tail_from_bytes(self.engine, video, reference_image)

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
                return last_frame_from_url(engine, body.video_url)
            except ValueError as error:
                raise HTTPException(status_code=422, detail=str(error)) from error

        @api.post("/swapTail")
        def swap_tail(
            body: SwapClipRequest, authorization: str | None = Header(default=None)
        ) -> dict:
            if not token_allowed(bearer_token(authorization)):
                raise HTTPException(status_code=403, detail="unauthorized")
            try:
                return swap_tail_from_url(engine, body.video_url, body.reference_image)
            except ValueError as error:
                raise HTTPException(status_code=422, detail=str(error)) from error

        # Sync handler on purpose: FastAPI runs it in a worker thread so the GPU loop never blocks the event loop.
        @api.post("/swapClip")
        def swap_clip(
            body: SwapClipRequest, authorization: str | None = Header(default=None)
        ) -> dict:
            if not token_allowed(bearer_token(authorization)):
                raise HTTPException(status_code=403, detail="unauthorized")
            try:
                return swap_clip_from_url(engine, body.video_url, body.reference_image)
            except ValueError as error:
                raise HTTPException(status_code=422, detail=str(error)) from error

        return api
