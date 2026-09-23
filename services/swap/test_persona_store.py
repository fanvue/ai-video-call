# Swap mode's CPU persona endpoint: listing includes registered uploads and every registration gate fails closed. Needs fastapi + httpx (the .venv-fal has both), no GPU.
# Run: cd services/swap && ../../.venv-fal/bin/python -m unittest -v test_persona_store
import base64
import hashlib
import hmac
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "longlive"))

from persona import registered_entry, resolve_persona  # noqa: E402

try:
    from fastapi.testclient import TestClient

    from persona_store import build_persona_api
except ImportError as error:  # pragma: no cover - plain-python runs skip these.
    TestClient = None
    SKIP_REASON = f"needs fastapi + httpx: {error}"
else:
    SKIP_REASON = ""

SECRET = "swap-persona-secret-0123456789abcdef"
NOW = 1_800_000_000.0
JPEG = b"\xff\xd8\xff\xe0" + b"synthetic-test-image"
PNG = b"\x89PNG\r\n\x1a\n" + b"synthetic-test-image"
SEED = {"id": "synth-persona-01", "file": "synth-persona-01.jpg", "synthetic": True, "rightsHolder": "Fanvue", "note": "Seed"}


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def sign(payload: dict, secret: str = SECRET) -> str:
    # The wire format personaRegistrar.ts and longliveTicket.ts mint: base64url(JSON) "." base64url(HMAC-SHA256).
    part = b64url(json.dumps(payload).encode())
    return f"{part}.{b64url(hmac.new(secret.encode(), part.encode('ascii'), hashlib.sha256).digest())}"


def register_token(image: bytes = JPEG, **overrides) -> str:
    payload = {"purpose": "persona-register", "uid": "user-uuid-1", "sha256": hashlib.sha256(image).hexdigest(), "exp": NOW + 300}
    payload.update(overrides)
    return sign(payload)


@unittest.skipIf(TestClient is None, SKIP_REASON)
class PersonaStoreTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = self.directory.name
        with open(os.path.join(self.root, "synth-persona-01.jpg"), "wb") as handle:
            handle.write(JPEG)
        unvouched = {**SEED, "id": "not-synthetic", "file": "not-synthetic.jpg", "synthetic": False}
        with open(os.path.join(self.root, "not-synthetic.jpg"), "wb") as handle:
            handle.write(JPEG)
        with open(os.path.join(self.root, "manifest.json"), "w", encoding="utf-8") as handle:
            json.dump([SEED, unvouched], handle)
        self.secret = SECRET
        self.reloads = 0
        self.commits = 0
        api = build_persona_api(self.root, lambda: self.secret, self.reload, self.commit, now=lambda: NOW)
        self.client = TestClient(api)

    def tearDown(self):
        self.directory.cleanup()

    def reload(self):
        self.reloads += 1

    def commit(self):
        self.commits += 1

    def ticket(self, **overrides):
        return sign({"sid": "s-1", "exp": NOW + 300, **overrides})

    def register(
        self,
        image: bytes = JPEG,
        content_type: str = "image/jpeg",
        token: str | None = None,
        name: str | None = "Ava",
        **extra,
    ):
        body = {
            "token": register_token(image) if token is None else token,
            "imageBase64": base64.b64encode(image).decode(),
            "contentType": content_type,
            "name": name,
            **extra,
        }
        return self.client.post("/personas/register", json=body)

    def manifest(self):
        with open(os.path.join(self.root, "manifest.json"), encoding="utf-8") as handle:
            return json.load(handle)

    def test_list_needs_a_valid_ticket(self):
        for ticket in (None, "", "abc", self.ticket(exp=NOW - 1), sign({"sid": "s", "exp": NOW + 300}, "other-secret-0123456789abcdef0000")):
            params = {} if ticket is None else {"ticket": ticket}
            self.assertEqual(self.client.get("/personas", params=params).status_code, 401, ticket)

    def test_list_includes_registered_uploads_and_only_ids_notes_names_and_addedat(self):
        self.assertEqual(self.register().status_code, 200)
        listing = self.client.get("/personas", params={"ticket": self.ticket()}).json()["personas"]
        upload_id = f"upload-{hashlib.sha256(JPEG).hexdigest()[:12]}"
        self.assertEqual([p["id"] for p in listing], ["synth-persona-01", upload_id])
        self.assertTrue(all(set(p) == {"id", "note", "name", "addedAt"} for p in listing))
        # SEED predates the name field; the fallback keeps it listed under its id.
        self.assertEqual(listing[0]["name"], "")
        self.assertEqual(listing[1]["name"], "Ava")
        self.assertGreater(self.reloads, 0)

    def test_registration_writes_longlives_entry_format(self):
        response = self.register(PNG, "image/png", name="Ava Two")
        sha = hashlib.sha256(PNG).hexdigest()
        self.assertEqual(response.json(), {"id": f"upload-{sha[:12]}", "created": True})
        entry = self.manifest()[-1]
        expected = registered_entry(sha, ".png", "user-uuid-1", entry["addedAt"], "Ava Two")
        self.assertEqual(entry, expected)
        with open(os.path.join(self.root, expected["file"]), "rb") as handle:
            self.assertEqual(handle.read(), PNG)
        self.assertEqual(self.commits, 1)
        # The swap gate accepts what the store wrote.
        persona, reason = resolve_persona(self.root, expected["id"])
        self.assertIsNotNone(persona, reason)
        self.assertEqual(persona.name, "Ava Two")

    def test_registration_rejects_a_missing_or_invalid_name(self):
        for name in (None, "", "   ", "x" * 41, "Ava\n", "Ava/2"):
            self.assert_rejected(self.register(name=name), 400)

    def test_second_registration_of_the_same_image_is_not_created_again(self):
        self.register()
        self.assertEqual(self.register().json()["created"], False)
        self.assertEqual(self.commits, 1)
        self.assertEqual(len(self.manifest()), 3)

    def assert_rejected(self, response, status):
        self.assertEqual(response.status_code, status, response.text)
        self.assertEqual(len(self.manifest()), 2)
        self.assertEqual(self.commits, 0)

    def test_token_gates(self):
        sha = hashlib.sha256(JPEG).hexdigest()
        for token in (
            "",
            "not-a-token",
            register_token(exp=NOW - 1),
            register_token(purpose="stream"),
            register_token(uid=""),
            register_token(sha256="A" * 64),
            sign({"purpose": "persona-register", "uid": "u", "sha256": sha, "exp": NOW + 300}, "other-secret-0123456789abcdef0000"),
            # A token for another image cannot register this one.
            register_token(PNG),
        ):
            with self.subTest(token=token[:24]):
                self.assert_rejected(self.register(token=token), 401)

    def test_unset_or_short_secret_fails_closed(self):
        for secret in (None, "", "short-secret"):
            self.secret = secret
            self.assert_rejected(self.register(), 401)
            self.assertEqual(self.client.get("/personas", params={"ticket": self.ticket()}).status_code, 401)

    def test_image_gates(self):
        self.assert_rejected(self.register(content_type="image/gif"), 400)
        self.assert_rejected(self.register(PNG, "image/jpeg", token=register_token(PNG)), 400)
        body = {"token": register_token(), "imageBase64": "!!not base64!!", "contentType": "image/jpeg"}
        self.assert_rejected(self.client.post("/personas/register", json=body), 400)
        oversized = {"token": register_token(), "imageBase64": "A" * (10 * 1024 * 1024 * 4 // 3 + 8), "contentType": "image/jpeg"}
        self.assert_rejected(self.client.post("/personas/register", json=oversized), 400)

    def test_accepted_types_match_longlive(self):
        import ast

        from persona_store import REGISTER_TYPES

        # Read LongLive's table from source: its modal_app imports the GPU stack.
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "longlive", "modal_app.py"), encoding="utf-8") as handle:
            tree = ast.parse(handle.read())
        node = next(n for n in tree.body if isinstance(n, ast.Assign) and getattr(n.targets[0], "id", None) == "REGISTER_TYPES")
        self.assertEqual(REGISTER_TYPES, ast.literal_eval(node.value))

    def test_body_gates(self):
        self.assert_rejected(self.client.post("/personas/register", content=b"{", headers={"content-type": "application/json"}), 400)
        self.assert_rejected(self.client.post("/personas/register", json=["token"]), 400)


if __name__ == "__main__":
    unittest.main()
