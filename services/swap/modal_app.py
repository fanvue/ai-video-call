# Modal host for the Swap service, used for the POC while fal serverless access is pending.
# Deploy: .venv-fal/bin/modal deploy services/swap/modal_app.py
from __future__ import annotations

import modal

from swap_core import INSWAPPER_URL, REQUIREMENTS, SwapEngine, serve_ws

app = modal.App("ai-video-swap")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libgl1", "libglib2.0-0", "wget")
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
    scaledown_window=120,
    max_containers=2,
    timeout=600,
)
class SwapService:
    @modal.enter()
    def setup(self) -> None:
        self.engine = SwapEngine("/models/inswapper_128.onnx")

    @modal.asgi_app()
    def web(self):
        from fastapi import FastAPI, WebSocket

        api = FastAPI()
        engine = self.engine

        @api.get("/health")
        def health() -> dict[str, str]:
            return {"status": "ok"}

        @api.websocket("/ws")
        async def ws(websocket: WebSocket) -> None:
            await serve_ws(engine, websocket)

        return api
