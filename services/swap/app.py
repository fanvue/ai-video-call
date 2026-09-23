# fal serverless host for the Swap service (docs/swap-mode-contract.md); deploy steps in README.md.
from __future__ import annotations

import fal
from fal.toolkit import download_file
from fastapi import Header, HTTPException
from pydantic import BaseModel

from swap_core import (
    ENHANCER_URL,
    INSWAPPER_URL,
    REQUIREMENTS,
    RESTORER_URL,
    SwapEngine,
    bearer_token,
    swap_clip_from_url,
    token_allowed,
)


class SwapClipRequest(BaseModel):
    video_url: str
    persona_id: str | None = None


class SwapApp(fal.App, keep_alive=120, min_concurrency=0, max_concurrency=2):
    machine_type = "GPU-A10G"
    requirements = REQUIREMENTS
    local_python_modules = ["swap_core"]

    def setup(self) -> None:
        inswapper = download_file(INSWAPPER_URL, target_dir="/data/models")
        restorer = download_file(RESTORER_URL, target_dir="/data/models")
        enhancer = download_file(ENHANCER_URL, target_dir="/data/models")
        self.engine = SwapEngine(str(inswapper), str(restorer), str(enhancer))

    @fal.endpoint("/swapClip")
    def swap_clip(
        self, body: SwapClipRequest, authorization: str | None = Header(default=None)
    ) -> dict:
        if not token_allowed(bearer_token(authorization)):
            raise HTTPException(status_code=403, detail="unauthorized")
        try:
            # No persona volume on fal yet, so the gate refuses every swap here (422) until one is mounted.
            return swap_clip_from_url(self.engine, body.video_url, None, body.persona_id)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
