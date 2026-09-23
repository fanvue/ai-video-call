# CPU-only persona list and registration for swap mode, so neither wakes a GPU. Mirrors LongLive's /personas and
# /personas/register handlers (services/longlive/modal_app.py build_api) on the same persona.py and protocol.py checks.
from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import threading
import time
from datetime import datetime, timezone
from typing import Callable

# Module level, not in build_persona_api: FastAPI resolves the string annotations from postponed evaluation against these globals.
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from persona import add_registered, list_personas, registered_entry
from protocol import MAX_IMAGE_BYTES, ProtocolError, verify_register_token, verify_ticket

# Same table as LongLive's REGISTER_TYPES: extension and magic bytes per accepted type.
REGISTER_TYPES = {"image/jpeg": (".jpg", b"\xff\xd8\xff"), "image/png": (".png", b"\x89PNG\r\n\x1a\n")}


def build_persona_api(
    root: str,
    secret: Callable[[], str | None],
    reload: Callable[[], None],
    commit: Callable[[], None],
    now: Callable[[], float] = time.time,
):
    api = FastAPI()
    # One writer per container: add_registered reads, appends and renames the manifest.
    write_lock = threading.Lock()

    def fresh_personas() -> None:
        # Picks up entries registered through LongLive or added with `modal volume put`.
        try:
            reload()
        except Exception as error:  # noqa: BLE001 - a stale view still fails closed on anything it cannot resolve.
            print(f"[personas] persona volume reload failed: {error!r}", flush=True)

    @api.get("/health")
    def health() -> dict:
        return {"status": "ok"}

    @api.get("/personas")
    def persona_list(ticket: str | None = None):
        try:
            verify_ticket(ticket, secret(), now())
        except ProtocolError as error:
            return JSONResponse({"error": error.message}, status_code=401)
        fresh_personas()
        # Ids and notes only: never the images, file names or rights metadata.
        return {"personas": list_personas(root)}

    @api.post("/personas/register")
    async def persona_register(request: Request):
        try:
            body = await request.json()
        except ValueError:
            return JSONResponse({"error": "invalid json"}, status_code=400)
        if not isinstance(body, dict):
            return JSONResponse({"error": "body must be an object"}, status_code=400)
        try:
            claims = verify_register_token(body.get("token"), secret(), now())
        except ProtocolError as error:
            return JSONResponse({"error": error.message}, status_code=401)
        kind = REGISTER_TYPES.get(body.get("contentType"))
        encoded = body.get("imageBase64")
        if kind is None or not isinstance(encoded, str) or len(encoded) > MAX_IMAGE_BYTES * 4 // 3 + 4:
            return JSONResponse({"error": "imageBase64 and a jpeg or png contentType required"}, status_code=400)
        try:
            image = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError):
            return JSONResponse({"error": "imageBase64 is not base64"}, status_code=400)
        extension, magic = kind
        if not image.startswith(magic) or len(image) > MAX_IMAGE_BYTES:
            return JSONResponse({"error": "image does not match its contentType or is too large"}, status_code=400)
        sha256 = hashlib.sha256(image).hexdigest()
        # The token names one image; it cannot be replayed to register a different one.
        if sha256 != claims["sha256"]:
            return JSONResponse({"error": "token does not match the image"}, status_code=401)
        entry = registered_entry(sha256, extension, claims["uid"], datetime.now(timezone.utc).isoformat(timespec="seconds"))

        def write() -> bool:
            with write_lock:
                fresh_personas()
                created = add_registered(root, entry, image)
                if created:
                    commit()
                return created

        created = await asyncio.to_thread(write)
        return {"id": entry["id"], "created": created}

    return api
