# fal serverless host for the Swap service (docs/swap-mode-contract.md); deploy steps in README.md.
from __future__ import annotations

import fal
from fal.toolkit import download_file
from fastapi import WebSocket

from swap_core import INSWAPPER_URL, REQUIREMENTS, SwapEngine, serve_ws


class SwapApp(fal.App, keep_alive=120, min_concurrency=0, max_concurrency=2):
    machine_type = "GPU-A10G"
    requirements = REQUIREMENTS
    local_python_modules = ["swap_core"]

    def setup(self) -> None:
        model_path = download_file(INSWAPPER_URL, target_dir="/data/models")
        self.engine = SwapEngine(str(model_path))

    @fal.endpoint("/ws", is_websocket=True)
    async def ws(self, websocket: WebSocket) -> None:
        await serve_ws(self.engine, websocket)
