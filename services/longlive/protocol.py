# Pure helpers for the LongLive WebSocket service (docs in the LongLive contract): ticket check, URL allowlist, message parsing. No GPU imports so tests run anywhere.
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import struct
from dataclasses import dataclass
from urllib.parse import urlsplit

from persona import is_valid_persona_id

CLOSE_BAD_TICKET = 4401
CLOSE_BAD_REQUEST = 4400

MAX_PROMPT_CHARS = 2000
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MIN_SECRET_CHARS = 32
# Width/height must land on the VAE (16x) and patch (2x) grid.
DIMENSION_STEP = 32
MIN_DIMENSION = 256
MAX_DIMENSION = 1280
# Portrait 704x1280 is the training token budget; anything bigger falls off the realtime curve.
MAX_PIXELS = 704 * 1280
MIN_FPS = 8
MAX_FPS = 30
# Purpose-bound so a browser's stream ticket can never register a persona, and a registration token can never open a stream.
REGISTER_PURPOSE = "persona-register"

_EXACT_HOSTS = {"fal.media", "v3.fal.media", "v3b.fal.media"}
_GCS_HOST = "storage.googleapis.com"
_GCS_PREFIX = "/falserverless/"


class ProtocolError(Exception):
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class StartMessage:
    reference_image_url: str
    prompt: str
    width: int
    height: int
    fps: int
    # Cosmetic second-GPU GFPGAN pass; on unless the client opts out.
    face_restore: bool = True
    # Allowlisted persona whose face the second GPU swaps in; None means no swap.
    persona_id: str | None = None


@dataclass(frozen=True)
class PromptMessage:
    prompt: str
    id: str


@dataclass(frozen=True)
class ReanchorMessage:
    id: str


@dataclass(frozen=True)
class StopMessage:
    pass


def _b64url_decode(part: str) -> bytes:
    return base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def sign_ticket(payload: dict, secret: str) -> str:
    payload_part = _b64url_encode(json.dumps(payload, separators=(",", ":")).encode())
    signature = hmac.new(secret.encode(), payload_part.encode("ascii"), hashlib.sha256).digest()
    return f"{payload_part}.{_b64url_encode(signature)}"


def verify_ticket(ticket: str | None, secret: str | None, now: float) -> str:
    """Returns the session id, or raises ProtocolError(4401)."""
    if not secret or len(secret) < MIN_SECRET_CHARS:
        # Fail closed: an unset secret must never let every ticket through.
        raise ProtocolError(CLOSE_BAD_TICKET, "server not configured")
    if not ticket or ticket.count(".") != 1:
        raise ProtocolError(CLOSE_BAD_TICKET, "bad ticket")
    payload_part, signature_part = ticket.split(".")
    try:
        signature = _b64url_decode(signature_part)
        payload = json.loads(_b64url_decode(payload_part))
    except (ValueError, UnicodeDecodeError):
        raise ProtocolError(CLOSE_BAD_TICKET, "bad ticket") from None
    expected = hmac.new(secret.encode(), payload_part.encode("ascii"), hashlib.sha256).digest()
    if not hmac.compare_digest(signature, expected):
        raise ProtocolError(CLOSE_BAD_TICKET, "bad ticket")
    if not isinstance(payload, dict):
        raise ProtocolError(CLOSE_BAD_TICKET, "bad ticket")
    exp, sid = payload.get("exp"), payload.get("sid")
    if isinstance(exp, bool) or not isinstance(exp, (int, float)) or not isinstance(sid, str) or not sid:
        raise ProtocolError(CLOSE_BAD_TICKET, "bad ticket")
    if exp <= now:
        raise ProtocolError(CLOSE_BAD_TICKET, "ticket expired")
    return sid


def verify_register_token(token: object, secret: str | None, now: float) -> dict:
    """Returns {"uid", "sha256"} from a server-minted persona registration token, or raises ProtocolError(4401)."""
    if not secret or len(secret) < MIN_SECRET_CHARS:
        raise ProtocolError(CLOSE_BAD_TICKET, "server not configured")
    if not isinstance(token, str) or token.count(".") != 1:
        raise ProtocolError(CLOSE_BAD_TICKET, "bad token")
    payload_part, signature_part = token.split(".")
    try:
        signature = _b64url_decode(signature_part)
        payload = json.loads(_b64url_decode(payload_part))
    except (ValueError, UnicodeDecodeError):
        raise ProtocolError(CLOSE_BAD_TICKET, "bad token") from None
    expected = hmac.new(secret.encode(), payload_part.encode("ascii"), hashlib.sha256).digest()
    if not hmac.compare_digest(signature, expected) or not isinstance(payload, dict):
        raise ProtocolError(CLOSE_BAD_TICKET, "bad token")
    exp, uid, sha256 = payload.get("exp"), payload.get("uid"), payload.get("sha256")
    if payload.get("purpose") != REGISTER_PURPOSE or isinstance(exp, bool) or not isinstance(exp, (int, float)):
        raise ProtocolError(CLOSE_BAD_TICKET, "bad token")
    if not isinstance(uid, str) or not uid or len(uid) > 128 or not isinstance(sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", sha256):
        raise ProtocolError(CLOSE_BAD_TICKET, "bad token")
    if exp <= now:
        raise ProtocolError(CLOSE_BAD_TICKET, "token expired")
    return {"uid": uid, "sha256": sha256}


def is_allowed_image_url(url: str) -> bool:
    try:
        parts = urlsplit(url)
    except ValueError:
        return False
    if parts.scheme != "https" or parts.username or parts.password or parts.port not in (None, 443):
        return False
    host = (parts.hostname or "").lower().rstrip(".")
    if host in _EXACT_HOSTS or host.endswith(".fal.media"):
        return True
    return host == _GCS_HOST and parts.path.startswith(_GCS_PREFIX)


def is_data_uri(url: str) -> bool:
    return url.startswith("data:image/") and ";base64," in url[:64]


def decode_data_uri(url: str) -> bytes:
    raw = base64.b64decode(url.split(",", 1)[1], validate=True)
    if len(raw) > MAX_IMAGE_BYTES:
        raise ProtocolError(CLOSE_BAD_REQUEST, "reference image too large")
    return raw


def _prompt_text(value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ProtocolError(CLOSE_BAD_REQUEST, "prompt required")
    if len(value) > MAX_PROMPT_CHARS:
        raise ProtocolError(CLOSE_BAD_REQUEST, "prompt too long")
    return value.strip()


def _dimension(value: object, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ProtocolError(CLOSE_BAD_REQUEST, f"{name} must be an integer")
    if value % DIMENSION_STEP or not MIN_DIMENSION <= value <= MAX_DIMENSION:
        raise ProtocolError(
            CLOSE_BAD_REQUEST, f"{name} must be a multiple of {DIMENSION_STEP} in {MIN_DIMENSION}..{MAX_DIMENSION}"
        )
    return value


def _message_id(message: dict, kind: str) -> str:
    message_id = message.get("id")
    if not isinstance(message_id, str) or not message_id or len(message_id) > 128:
        raise ProtocolError(CLOSE_BAD_REQUEST, f"{kind} id required")
    return message_id


def parse_client_message(
    text: str, *, allow_data_uri: bool = False
) -> StartMessage | PromptMessage | ReanchorMessage | StopMessage:
    try:
        message = json.loads(text)
    except ValueError:
        raise ProtocolError(CLOSE_BAD_REQUEST, "invalid json") from None
    if not isinstance(message, dict):
        raise ProtocolError(CLOSE_BAD_REQUEST, "message must be an object")
    kind = message.get("type")
    if kind == "stop":
        return StopMessage()
    if kind == "prompt":
        return PromptMessage(prompt=_prompt_text(message.get("prompt")), id=_message_id(message, "prompt"))
    if kind == "reanchor":
        return ReanchorMessage(id=_message_id(message, "reanchor"))
    if kind == "start":
        url = message.get("referenceImageUrl")
        if not isinstance(url, str) or not (
            is_allowed_image_url(url) or (allow_data_uri and is_data_uri(url))
        ):
            raise ProtocolError(CLOSE_BAD_REQUEST, "referenceImageUrl host not allowed")
        width = _dimension(message.get("width", 480), "width")
        height = _dimension(message.get("height", 832), "height")
        if width * height > MAX_PIXELS:
            raise ProtocolError(CLOSE_BAD_REQUEST, "resolution too large")
        fps = message.get("fps", 16)
        if isinstance(fps, bool) or not isinstance(fps, int) or not MIN_FPS <= fps <= MAX_FPS:
            raise ProtocolError(CLOSE_BAD_REQUEST, f"fps must be an integer in {MIN_FPS}..{MAX_FPS}")
        face_restore = message.get("faceRestore", True)
        if not isinstance(face_restore, bool):
            raise ProtocolError(CLOSE_BAD_REQUEST, "faceRestore must be a boolean")
        persona_id = message.get("personaId")
        # The id only names an allowlisted face; it never carries one.
        if persona_id is not None and not is_valid_persona_id(persona_id):
            raise ProtocolError(CLOSE_BAD_REQUEST, "personaId must be 1 to 64 of a-z, 0-9 and -")
        return StartMessage(
            reference_image_url=url,
            prompt=_prompt_text(message.get("prompt")),
            width=width,
            height=height,
            fps=fps,
            face_restore=face_restore,
            persona_id=persona_id,
        )
    raise ProtocolError(CLOSE_BAD_REQUEST, "unknown message type")


def pack_frame(index: int, jpeg: bytes) -> bytes:
    return struct.pack(">I", index) + jpeg
