# Pure request checks for the wan14b premium clip service: frame count, seed image input, prompt, persona seed gate. No GPU imports.
from __future__ import annotations

import base64
import binascii
import urllib.parse
import urllib.request

FPS = 16
# Wan2.1's VAE packs 4 frames per latent after the first, so a clip is always 4k+1 frames.
MIN_FRAMES = 17
# 81 frames is the length the 480P model and the lightx2v 4-step LoRA were trained on; longer clips lose motion quality.
MAX_FRAMES = 81
DEFAULT_FRAMES = 81
MAX_PROMPT_CHARS = 800
MAX_IMAGE_BYTES = 10 * 1024 * 1024
# ArcFace cosine between the seed's face and the persona: chained Wan seeds measured 0.8 to 0.95, a different identity sits near 0.
SEED_MIN_SIMILARITY = 0.35
IMAGE_MAGIC = (b"\xff\xd8\xff", b"\x89PNG\r\n\x1a\n")


def frame_count(num_frames: object = None, duration_s: object = None) -> int:
    if num_frames is not None and duration_s is not None:
        raise ValueError("send num_frames or duration_s, not both")
    if num_frames is not None:
        # bool is an int subclass; True must not become a 1-frame clip.
        if isinstance(num_frames, bool) or not isinstance(num_frames, int):
            raise ValueError("num_frames must be an integer")
        if num_frames % 4 != 1 or not MIN_FRAMES <= num_frames <= MAX_FRAMES:
            raise ValueError(f"num_frames must be 4k+1 between {MIN_FRAMES} and {MAX_FRAMES}")
        return num_frames
    if duration_s is not None:
        if isinstance(duration_s, bool) or not isinstance(duration_s, (int, float)) or duration_s != duration_s:
            raise ValueError("duration_s must be a number")
        latents = round((float(duration_s) * FPS - 1) / 4)
        return min(MAX_FRAMES, max(MIN_FRAMES, 4 * latents + 1))
    return DEFAULT_FRAMES


def check_prompt(prompt: object) -> str:
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("prompt is required")
    if len(prompt) > MAX_PROMPT_CHARS:
        raise ValueError(f"prompt is longer than {MAX_PROMPT_CHARS} characters")
    return prompt.strip()


def check_image_bytes(data: bytes) -> bytes:
    if len(data) > MAX_IMAGE_BYTES:
        raise ValueError("image is larger than 10 MB")
    if not data.startswith(IMAGE_MAGIC):
        raise ValueError("image must be a JPEG or PNG")
    return data


def decode_base64_image(value: str) -> bytes:
    # Accepts a bare base64 string or a data URI, like the swap service's faceCrop.
    if value.startswith("data:"):
        header, _, value = value.partition(",")
        if ";base64" not in header:
            raise ValueError("data URI must be base64")
    if len(value) > MAX_IMAGE_BYTES * 4 // 3 + 4:
        raise ValueError("image is larger than 10 MB")
    try:
        data = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ValueError("image_base64 is not valid base64") from error
    return check_image_bytes(data)


def check_image_url(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    # https only: the seed usually comes from Vercel Blob or fal storage, and a plain http or file URL is never legitimate here.
    if parsed.scheme != "https" or not parsed.netloc:
        raise ValueError("image_url must be an https URL")
    return url


def fetch_image(url: str, timeout: float = 30.0) -> bytes:
    with urllib.request.urlopen(check_image_url(url), timeout=timeout) as response:
        data = response.read(MAX_IMAGE_BYTES + 1)
    return check_image_bytes(data)


def seed_image_bytes(image_url: str | None, image_base64: str | None) -> bytes:
    if bool(image_url) == bool(image_base64):
        raise ValueError("send exactly one of image_url or image_base64")
    if image_base64:
        return decode_base64_image(image_base64)
    return fetch_image(image_url)


def seed_gate(similarity: float | None) -> None:
    # Fail closed: the seed must already show the allowlisted persona, so the service never animates an arbitrary face.
    if similarity is None:
        raise ValueError("seed gate: no single face found in the seed image")
    if similarity < SEED_MIN_SIMILARITY:
        raise ValueError(f"seed gate: seed face does not match the persona ({similarity:.2f} < {SEED_MIN_SIMILARITY})")
