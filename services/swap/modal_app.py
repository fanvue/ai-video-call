# Modal host for the Swap service, used for the POC while fal serverless access is pending.
# Deploy: .venv-fal/bin/modal deploy services/swap/modal_app.py
import modal
from fastapi import FastAPI, WebSocket

from swap_core import INSWAPPER_URL, REQUIREMENTS, SwapEngine, serve_ws

app = modal.App("ai-video-swap")

# onnxruntime-gpu needs the CUDA 12 + cuDNN 9 runtime libraries on the image or it silently falls back to CPU.
image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04", add_python="3.11"
    )
    # The image ships a cuda apt repo whose index fails apt-get update; the CUDA libs are already on disk so drop it.
    .run_commands(
        "rm -f /etc/apt/sources.list.d/cuda*.list /etc/apt/sources.list.d/nvidia*.list",
        "apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 wget build-essential clang && rm -rf /var/lib/apt/lists/*",
    )
    # Modal's bundled Python has clang++ baked into sysconfig, which insightface's Cython build uses.
    .env({"CC": "clang", "CXX": "clang++"})
    .pip_install(*REQUIREMENTS, "fastapi", "uvicorn")
    .run_commands(
        "mkdir -p /models",
        f"wget -q -O /models/inswapper_128.onnx {INSWAPPER_URL}",
    )
    .add_local_python_source("swap_core")
)


@app.cls(
    image=image,
    gpu="A10G",
    secrets=[modal.Secret.from_name("ai-video-swap-token")],
    scaledown_window=120,
    max_containers=2,
    timeout=600,
)
class SwapService:
    @modal.enter()
    def setup(self) -> None:
        self.engine = SwapEngine("/models/inswapper_128.onnx")

    @modal.asgi_app()
    # WebSocket must be resolvable from module globals or FastAPI treats the parameter as a query field and rejects every handshake.
    def web(self):
        from fastapi.exceptions import WebSocketRequestValidationError

        api = FastAPI()
        engine = self.engine

        # FastAPI's default handler closes with a list as the reason, which Modal cannot serialise (HTTP 500 with no log).
        @api.exception_handler(WebSocketRequestValidationError)
        async def ws_validation(websocket: WebSocket, exc: WebSocketRequestValidationError):
            print("ws validation error:", exc.errors())
            await websocket.close(code=1008, reason="validation")

        @api.get("/health")
        def health() -> dict[str, str]:
            return {"status": "ok"}

        @api.websocket("/ws")
        async def ws(websocket: WebSocket) -> None:
            await serve_ws(engine, websocket)

        return api
