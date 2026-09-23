# Allowlist of company-owned synthetic personas the face swap may use as its source. Pure file and JSON checks, no GPU imports.
# The only swap source is a manifest entry on the persona-faces volume; everything here fails closed and says why.
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass

PERSONA_ID_RE = re.compile(r"[a-z0-9-]{1,64}")
# The human-facing label testers pick to tell faces apart; the file on disk is still hash-named.
PERSONA_NAME_RE = re.compile(r"[A-Za-z0-9 .\-_']{1,40}")
MANIFEST_NAME = "manifest.json"
# Only these land in the volume; a registered upload is stored under its hash, never a client-chosen name.
IMAGE_EXTENSIONS = (".jpg", ".jpeg", ".png")
MAX_NOTE_CHARS = 200
MAX_NAME_CHARS = 40


@dataclass(frozen=True)
class Persona:
    id: str
    path: str
    note: str
    name: str
    added_at: str


def is_valid_persona_id(value: object) -> bool:
    # fullmatch, not match: "$" would also accept a trailing newline.
    return isinstance(value, str) and bool(PERSONA_ID_RE.fullmatch(value))


def is_valid_persona_name(value: object) -> bool:
    # fullmatch, not match: same trailing-newline trap as the persona id. strip() rejects an all-space name,
    # which the charset alone would let through.
    return isinstance(value, str) and bool(value.strip()) and bool(PERSONA_NAME_RE.fullmatch(value))


def _read_manifest(root: str) -> list:
    with open(os.path.join(root, MANIFEST_NAME), encoding="utf-8") as handle:
        entries = json.load(handle)
    if not isinstance(entries, list):
        raise ValueError("manifest must be a JSON list")
    return entries


def _check_entry(root: str, entry: object) -> tuple[Persona | None, str]:
    if not isinstance(entry, dict):
        return None, "entry is not an object"
    persona_id = entry.get("id")
    if not is_valid_persona_id(persona_id):
        return None, "entry id is invalid"
    # Both attestations are required on every entry; a missing or non-true flag is not a persona.
    if entry.get("synthetic") is not True:
        return None, f"{persona_id}: not marked synthetic"
    rights = entry.get("rightsHolder")
    if not isinstance(rights, str) or not rights.strip():
        return None, f"{persona_id}: no rightsHolder"
    name = entry.get("file")
    # A bare file name only: no directories, so an entry can never point outside the volume.
    if not isinstance(name, str) or not name or os.path.basename(name) != name or name.startswith("."):
        return None, f"{persona_id}: bad file name"
    if not name.lower().endswith(IMAGE_EXTENSIONS):
        return None, f"{persona_id}: file is not an image"
    path = os.path.join(root, name)
    if not os.path.isfile(path):
        return None, f"{persona_id}: file missing"
    # A symlink planted in the volume must not reach a file outside it.
    if os.path.dirname(os.path.realpath(path)) != os.path.realpath(root):
        return None, f"{persona_id}: file outside the persona volume"
    note = entry.get("note")
    display_name = entry.get("name")
    added_at = entry.get("addedAt")
    return Persona(
        persona_id,
        path,
        note[:MAX_NOTE_CHARS] if isinstance(note, str) else "",
        # Old entries predate the name field; fall back to "" so the picker shows the id instead.
        display_name[:MAX_NAME_CHARS] if isinstance(display_name, str) else "",
        added_at if isinstance(added_at, str) else "",
    ), ""


def resolve_persona(root: str, persona_id: object) -> tuple[Persona | None, str]:
    """(persona, "") for a valid allowlisted id, else (None, reason). Never raises."""
    if not is_valid_persona_id(persona_id):
        return None, "invalid persona id"
    try:
        entries = _read_manifest(root)
    except (OSError, ValueError) as error:
        return None, f"manifest unreadable: {error.__class__.__name__}"
    matches = [entry for entry in entries if isinstance(entry, dict) and entry.get("id") == persona_id]
    if not matches:
        return None, f"{persona_id}: not in manifest"
    # Duplicate ids are ambiguous, so neither is trusted.
    if len(matches) > 1:
        return None, f"{persona_id}: duplicate manifest entries"
    return _check_entry(root, matches[0])


def list_personas(root: str) -> list[dict]:
    """Only what the picker needs: id, note, name and addedAt of the entries that would resolve."""
    try:
        entries = _read_manifest(root)
    except (OSError, ValueError):
        return []
    listed = []
    for entry in entries:
        persona, _ = resolve_persona(root, entry.get("id") if isinstance(entry, dict) else None)
        if persona is not None:
            listed.append(
                {"id": persona.id, "note": persona.note, "name": persona.name, "addedAt": persona.added_at}
            )
    return listed


def registered_entry(sha256: str, extension: str, added_by: str, added_at: str, name: str) -> dict:
    if not re.fullmatch(r"[0-9a-f]{64}", sha256):
        raise ValueError("sha256 must be 64 lowercase hex")
    if extension not in (".jpg", ".png"):
        raise ValueError("extension must be .jpg or .png")
    if not is_valid_persona_name(name):
        raise ValueError("name must be 1-40 chars of letters, digits, space, . - _ '")
    persona_id = f"upload-{sha256[:12]}"
    return {
        "id": persona_id,
        "file": f"{persona_id}{extension}",
        "synthetic": True,
        "rightsHolder": "Fanvue",
        "addedBy": added_by,
        "addedAt": added_at,
        "sha256": sha256,
        "attested": True,
        "name": name,
        "note": "Registered upload, attested Fanvue-owned AI likeness",
    }


def add_registered(root: str, entry: dict, image: bytes) -> bool:
    """Writes the image then the manifest entry; False when that id is already registered (same hash, same image)."""
    try:
        entries = _read_manifest(root)
    except FileNotFoundError:
        entries = []
    if any(isinstance(existing, dict) and existing.get("id") == entry["id"] for existing in entries):
        return False
    with open(os.path.join(root, entry["file"]), "wb") as handle:
        handle.write(image)
    temporary = os.path.join(root, f".{MANIFEST_NAME}.tmp")
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump([*entries, entry], handle, indent=1)
    # Write then rename, so a failed write never leaves a truncated manifest behind.
    os.replace(temporary, os.path.join(root, MANIFEST_NAME))
    return True
