# Modal host for the Swap service, used for the POC while fal serverless access is pending.
# Deploy: .venv-fal/bin/modal deploy services/swap/modal_app.py
import modal
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

from swap_core import (
    GPEN_URL,
    INSWAPPER_URL,
    REQUIREMENTS,
    SwapEngine,
    bearer_token,
    swap_clip_from_bytes,
    swap_clip_from_url,
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
        f"wget -q -O /models/gpen_bfr.onnx {GPEN_URL}",
    )
    .add_local_python_source("swap_core")
)


class SwapClipRequest(BaseModel):
    video_url: str
    reference_image: str


@app.cls(
    image=image,
    gpu="A10G",
    # Detection, paste-back and the x264 encode are CPU work; Modal's default fractional core starves them.
    cpu=4,
    secrets=[modal.Secret.from_name("ai-video-swap-token")],
    scaledown_window=120,
    max_containers=2,
    timeout=600,
)
class SwapService:
    @modal.enter()
    def setup(self) -> None:
        self.engine = SwapEngine("/models/inswapper_128.onnx", "/models/gpen_bfr.onnx")

    # Modal-authenticated path for smoke tests from a laptop, so no clip needs a public URL.
    @modal.method()
    def swap_clip_bytes(self, video: bytes, reference_image: str) -> dict:
        return swap_clip_from_bytes(self.engine, video, reference_image)

    @modal.asgi_app()
    def web(self):
        api = FastAPI()
        engine = self.engine

        @api.get("/health")
        def health() -> dict[str, str]:
            return {"status": "ok"}

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
