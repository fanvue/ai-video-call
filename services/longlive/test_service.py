# WebSocket contract test against a fake engine, no GPU. Needs fastapi + modal (the .venv-fal has both).
# Run: cd services/longlive && ../../.venv-fal/bin/python -m unittest -v test_service
import asyncio
import base64
import hashlib
import json
import os
import shutil
import struct
import tempfile
import threading
import time
import unittest
from dataclasses import dataclass
from io import BytesIO

try:
    from fastapi.testclient import TestClient
    from PIL import Image
    from starlette.websockets import WebSocketDisconnect

    import modal_app
    from protocol import sign_ticket
    from restore_stage import PassthroughCodec
except ImportError as error:  # pragma: no cover - plain-python runs only get test_protocol.
    modal_app = None
    SKIP_REASON = f"needs fastapi + modal: {error}"
else:
    SKIP_REASON = ""

SECRET = "k" * 64


@dataclass
class FakeBlock:
    first_frame_index: int
    frame_count: int


@dataclass
class FakeResult:
    first_frame_index: int
    jpegs: list
    recache_ms: float = 0.0
    diffusion_ms: float = 5.0
    decode_ms: float = 5.0
    encode_ms: float = 1.0


class FakeEngine:
    load_ms = 1234.0

    def __init__(self, block_s: float = 0.05):
        self.block_s = block_s
        self.prompts: list[str] = []
        self.next_frame = 0
        self.blocks = 0
        self.stopped = threading.Event()
        self.reanchors: list[int] = []

    def start(self, image, prompt, width, height, seed=None):
        image.load()
        self.prompts.append(prompt)
        self.next_frame = 0
        self.blocks = 0

    def switch_prompt(self, prompt):
        self.prompts.append(prompt)
        return self.next_frame

    def reanchor(self):
        self.reanchors.append(self.blocks)
        return self.next_frame

    def diffuse_block(self):
        time.sleep(self.block_s)
        count = 29 if self.blocks == 0 else 32
        block = FakeBlock(self.next_frame, count)
        self.next_frame += count
        self.blocks += 1
        return block

    def decode_block(self, block):
        return FakeResult(block.first_frame_index, [b"\xff\xd8jpeg"] * block.frame_count)

    def stop(self):
        self.stopped.set()


class FakeCall:
    def __init__(self, result=None, error=None):
        self.result, self.error = result, error

    def get(self, timeout=None):
        if self.error is not None:
            raise self.error
        return self.result

    def cancel(self):
        pass


class FakeRestorer:
    def __init__(self, fail: bool = False, persona_ok: bool = True):
        self.fail = fail
        self.persona_ok = persona_ok
        self.calls = 0
        self.warms = 0
        # Every argument the face GPU was handed, so a test can prove the stream's reference never reaches it.
        self.seen: list = []

    def warm(self, persona_id=None):
        self.warms += 1
        self.seen.append(("warm", persona_id))
        return {"ok": True, "persona": None if persona_id is None else self.persona_ok}

    def spawn(self, frames, persona_id, restore):
        self.calls += 1
        self.seen.append(("spawn", list(frames), persona_id, restore))
        if self.fail:
            return FakeCall(error=RuntimeError("restore GPU down"))
        return FakeCall({"frames": [b"\xff\xd8restored" for _ in frames], "computeMs": 7.0, "swapped": len(frames) if persona_id else 0})


class DirPersonas:
    def __init__(self, root):
        self.root = root
        self.commits = 0

    def reload(self):
        pass

    def commit(self):
        self.commits += 1


def png_data_uri() -> str:
    import base64

    buffer = BytesIO()
    Image.new("RGB", (64, 64), (200, 100, 50)).save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()


@unittest.skipIf(modal_app is None, SKIP_REASON)
class ServiceTest(unittest.TestCase):
    def setUp(self):
        os.environ["LONGLIVE_TOKEN"] = SECRET
        self.engine = FakeEngine()
        self.client = TestClient(modal_app.build_api(self.engine, asyncio.Lock()))
        modal_app.ALLOW_DATA_URI = True

    def ticket(self, exp_offset=60, secret=SECRET):
        return sign_ticket({"sid": "t", "exp": int(time.time()) + exp_offset}, secret)

    def start_message(self, **overrides):
        message = {"type": "start", "referenceImageUrl": png_data_uri(), "prompt": "an adult woman smiles", "width": 480, "height": 832, "fps": 16}
        message.update(overrides)
        return json.dumps(message)

    def close_code(self, ws):
        while True:
            message = ws.receive()
            if message["type"] == "websocket.close":
                return message["code"]

    def test_health(self):
        self.assertEqual(self.client.get("/health").json(), {"status": "ok", "busy": False, "loadMs": 1234})

    def test_bad_and_expired_tickets_close_4401(self):
        for ticket in ["", "nope", self.ticket(exp_offset=-1), self.ticket(secret="z" * 64)]:
            with self.client.websocket_connect(f"/ws?ticket={ticket}") as ws:
                self.assertEqual(self.close_code(ws), 4401)

    def test_disallowed_host_closes_4400(self):
        with self.client.websocket_connect(f"/ws?ticket={self.ticket()}") as ws:
            ws.send_text(self.start_message(referenceImageUrl="https://example.com/a.png"))
            self.assertEqual(json.loads(ws.receive_text())["type"], "error")
            self.assertEqual(self.close_code(ws), 4400)

    def test_data_uri_rejected_unless_enabled(self):
        modal_app.ALLOW_DATA_URI = False
        with self.client.websocket_connect(f"/ws?ticket={self.ticket()}") as ws:
            ws.send_text(self.start_message())
            self.assertEqual(json.loads(ws.receive_text())["type"], "error")
            self.assertEqual(self.close_code(ws), 4400)

    def test_stream_prompt_last_wins_and_stop(self):
        self.engine.block_s = 0.3
        frames, texts = [], []
        with self.client.websocket_connect(f"/ws?ticket={self.ticket()}") as ws:
            ws.send_text(self.start_message())
            ready = json.loads(ws.receive_text())
            self.assertEqual(ready, {"type": "ready", "width": 480, "height": 832, "fps": 16, "loadMs": 1234})
            # Three requests inside one block: only the newest should be applied.
            for index in range(3):
                ws.send_text(json.dumps({"type": "prompt", "prompt": f"prompt {index}", "id": f"p{index}"}))
            while len(frames) < 29 + 32 * 2:
                message = ws.receive()
                if message.get("bytes") is not None:
                    frames.append(struct.unpack(">I", message["bytes"][:4])[0])
                elif message.get("text") is not None:
                    texts.append(json.loads(message["text"]))
            ws.send_text(json.dumps({"type": "stop"}))
            self.assertEqual(self.close_code(ws), 1000)
        self.assertEqual(frames, list(range(len(frames))))
        applied = [t for t in texts if t["type"] == "promptApplied"]
        self.assertEqual([t["id"] for t in applied], ["p2"])
        self.assertEqual(applied[0]["atFrame"], 29)
        self.assertEqual(self.engine.prompts, ["an adult woman smiles", "prompt 2"])
        stats = [t for t in texts if t["type"] == "stats"]
        self.assertTrue(stats and {"genFps", "blockMs", "decodeMs", "queueFrames"} <= stats[0].keys())
        self.assertTrue(self.engine.stopped.wait(2))

    def test_reanchor_is_applied_once_at_a_block_boundary_and_acknowledged(self):
        self.engine.block_s = 0.3
        texts = []
        with self.client.websocket_connect(f"/ws?ticket={self.ticket()}") as ws:
            ws.send_text(self.start_message())
            ws.receive_text()
            # Two inside one block collapse to one pin, like prompts.
            ws.send_text(json.dumps({"type": "reanchor", "id": "a1"}))
            ws.send_text(json.dumps({"type": "reanchor", "id": "a2"}))
            frames = 0
            while frames < 29 + 32 * 2:
                message = ws.receive()
                if message.get("bytes") is not None:
                    frames += 1
                elif message.get("text") is not None:
                    texts.append(json.loads(message["text"]))
            ws.send_text(json.dumps({"type": "stop"}))
            self.assertEqual(self.close_code(ws), 1000)
        acks = [t for t in texts if t["type"] == "reanchored"]
        self.assertEqual([t["id"] for t in acks], ["a2"])
        self.assertEqual(acks[0]["atFrame"], 29)
        self.assertEqual(self.engine.reanchors, [1])

    def test_reanchor_without_id_closes_4400(self):
        with self.client.websocket_connect(f"/ws?ticket={self.ticket()}") as ws:
            ws.send_text(self.start_message())
            ws.receive_text()
            ws.send_text(json.dumps({"type": "reanchor"}))
            self.assertEqual(self.close_code(ws), 4400)

    def personas(self):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root)
        with open(os.path.join(root, "synth-persona-01.jpg"), "wb") as handle:
            handle.write(b"\xff\xd8\xff persona")
        entry = {"id": "synth-persona-01", "file": "synth-persona-01.jpg", "synthetic": True, "rightsHolder": "Fanvue", "addedBy": "eng", "addedAt": "2026-09-23", "note": "Seed"}
        unvouched = {**entry, "id": "no-rights", "rightsHolder": ""}
        with open(os.path.join(root, "manifest.json"), "w") as handle:
            json.dump([entry, unvouched], handle)
        return DirPersonas(root)

    def stream_with_restorer(self, restorer, frame_target, personas=None, **start):
        client = TestClient(modal_app.build_api(self.engine, asyncio.Lock(), restorer, personas, face_codec=PassthroughCodec))
        self.engine.block_s = 0.1
        frames, texts = [], []
        with client.websocket_connect(f"/ws?ticket={self.ticket()}") as ws:
            ws.send_text(self.start_message(**start))
            ws.receive_text()
            while len(frames) < frame_target:
                message = ws.receive()
                if message.get("bytes") is not None:
                    frames.append((struct.unpack(">I", message["bytes"][:4])[0], message["bytes"][4:]))
                elif message.get("text") is not None:
                    texts.append(json.loads(message["text"]))
            ws.send_text(json.dumps({"type": "stop"}))
            self.assertEqual(self.close_code(ws), 1000)
        return frames, [t for t in texts if t["type"] == "stats"]

    def test_face_restore_replaces_frames_in_order(self):
        restorer = FakeRestorer()
        frames, stats = self.stream_with_restorer(restorer, 29 + 32 * 3)
        self.assertEqual([index for index, _ in frames], list(range(len(frames))))
        self.assertEqual(restorer.warms, 1)
        self.assertTrue(all(jpeg == b"\xff\xd8restored" for _, jpeg in frames))
        self.assertTrue(all(s["restored"] for s in stats))

    def test_failing_restore_passes_frames_through_in_order_and_trips_the_breaker(self):
        restorer = FakeRestorer(fail=True)
        frames, stats = self.stream_with_restorer(restorer, 29 + 32 * 5)
        self.assertEqual([index for index, _ in frames], list(range(len(frames))))
        self.assertTrue(all(jpeg == b"\xff\xd8jpeg" for _, jpeg in frames))
        self.assertEqual(restorer.calls, 3)
        self.assertFalse(any(s["restored"] for s in stats))
        self.assertTrue(stats[-1]["restoreOff"])
        self.assertEqual(stats[-1]["restoreFailOpen"], 3)

    def test_face_restore_false_never_calls_the_restore_gpu(self):
        restorer = FakeRestorer()
        frames, stats = self.stream_with_restorer(restorer, 29 + 32, faceRestore=False)
        self.assertEqual((restorer.warms, restorer.calls), (0, 0))
        self.assertTrue(all(jpeg == b"\xff\xd8jpeg" for _, jpeg in frames))
        self.assertNotIn("restored", stats[0])

    def test_allowlisted_persona_is_swapped_and_the_reference_never_reaches_the_face_gpu(self):
        restorer = FakeRestorer()
        reference = png_data_uri()
        frames, stats = self.stream_with_restorer(restorer, 29 + 32 * 2, self.personas(), personaId="synth-persona-01", referenceImageUrl=reference)
        self.assertEqual(restorer.seen[0], ("warm", "synth-persona-01"))
        spawns = [call for call in restorer.seen if call[0] == "spawn"]
        self.assertTrue(spawns and all(call[2] == "synth-persona-01" for call in spawns))
        raw_reference = base64.b64decode(reference.split(",", 1)[1])
        for call in restorer.seen:
            flat = repr(call).encode()
            self.assertNotIn(reference.encode()[:80], flat)
            self.assertFalse(any(isinstance(arg, list) and raw_reference in arg for arg in call))
        self.assertTrue(stats[-1]["personaLocked"])
        self.assertGreater(stats[-1]["personaSwapped"], 0)
        self.assertEqual(stats[-1]["restoreComputeMs"], 7)

    def test_unknown_or_unvouched_persona_runs_without_a_swap(self):
        for persona_id in ["someone-else", "no-rights"]:
            restorer = FakeRestorer()
            frames, stats = self.stream_with_restorer(restorer, 29 + 32, self.personas(), personaId=persona_id)
            self.assertEqual(restorer.seen[0], ("warm", None))
            self.assertTrue(all(call[2] is None for call in restorer.seen if call[0] == "spawn"))
            self.assertFalse(stats[-1]["personaLocked"])
            self.assertEqual(stats[-1]["personaSwapped"], 0)

    def test_unknown_persona_with_restore_off_never_calls_the_face_gpu(self):
        restorer = FakeRestorer()
        frames, stats = self.stream_with_restorer(restorer, 29 + 32, self.personas(), personaId="someone-else", faceRestore=False)
        self.assertEqual((restorer.warms, restorer.calls), (0, 0))
        self.assertTrue(all(jpeg == b"\xff\xd8jpeg" for _, jpeg in frames))

    def test_persona_the_face_gpu_cannot_load_turns_the_swap_off(self):
        restorer = FakeRestorer(persona_ok=False)
        frames, stats = self.stream_with_restorer(restorer, 29 + 32 * 3, self.personas(), personaId="synth-persona-01")
        self.assertTrue(all(call[2] is None for call in restorer.seen if call[0] == "spawn"))
        self.assertFalse(stats[-1]["personaLocked"])

    def test_no_persona_store_means_no_swap(self):
        restorer = FakeRestorer()
        self.stream_with_restorer(restorer, 29 + 32, None, personaId="synth-persona-01")
        self.assertEqual(restorer.seen[0], ("warm", None))

    def test_persona_listing_needs_a_ticket_and_shows_ids_and_notes_only(self):
        client = TestClient(modal_app.build_api(self.engine, asyncio.Lock(), None, self.personas()))
        self.assertEqual(client.get("/personas").status_code, 401)
        self.assertEqual(client.get(f"/personas?ticket={self.ticket(secret='z' * 64)}").status_code, 401)
        response = client.get(f"/personas?ticket={self.ticket()}")
        self.assertEqual(response.json(), {"personas": [{"id": "synth-persona-01", "note": "Seed", "name": "", "addedAt": "2026-09-23"}]})
        self.assertNotIn("rightsHolder", response.text)
        self.assertNotIn(".jpg", response.text)

    def register_body(self, image=b"\xff\xd8\xff new upload", **token_overrides):
        claims = {"purpose": "persona-register", "uid": "user-uuid-1", "sha256": hashlib.sha256(image).hexdigest(), "exp": int(time.time()) + 60}
        claims.update(token_overrides)
        return {"token": sign_ticket(claims, SECRET), "imageBase64": base64.b64encode(image).decode(), "contentType": "image/jpeg", "name": "Test persona"}

    def test_register_writes_a_vouched_entry_once(self):
        personas = self.personas()
        client = TestClient(modal_app.build_api(self.engine, asyncio.Lock(), None, personas))
        image = b"\xff\xd8\xff new upload"
        response = client.post("/personas/register", json=self.register_body(image))
        sha = hashlib.sha256(image).hexdigest()
        self.assertEqual(response.json(), {"id": f"upload-{sha[:12]}", "created": True})
        self.assertEqual(client.post("/personas/register", json=self.register_body(image)).json()["created"], False)
        self.assertEqual(personas.commits, 1)
        with open(os.path.join(personas.root, "manifest.json")) as handle:
            entry = json.load(handle)[-1]
        self.assertEqual((entry["addedBy"], entry["name"]), ("user-uuid-1", "Test persona"))
        self.assertEqual((entry["synthetic"], entry["attested"], entry["rightsHolder"], entry["sha256"]), (True, True, "Fanvue", sha))
        listed = client.get(f"/personas?ticket={self.ticket()}").json()["personas"]
        self.assertIn(f"upload-{sha[:12]}", [p["id"] for p in listed])

    def test_register_refuses_stream_tickets_mismatched_images_and_bad_types(self):
        client = TestClient(modal_app.build_api(self.engine, asyncio.Lock(), None, self.personas()))
        body = self.register_body()
        self.assertEqual(client.post("/personas/register", json={**body, "token": self.ticket()}).status_code, 401)
        self.assertEqual(client.post("/personas/register", json={**body, "imageBase64": base64.b64encode(b"\xff\xd8\xff other").decode()}).status_code, 401)
        self.assertEqual(client.post("/personas/register", json={**body, "contentType": "image/gif"}).status_code, 400)
        self.assertEqual(client.post("/personas/register", json={**body, "name": "<b>"}).status_code, 400)
        self.assertEqual(client.post("/personas/register", json={**body, "contentType": "image/png"}).status_code, 400)
        self.assertEqual(client.post("/personas/register", json=self.register_body(exp=int(time.time()) - 5)).status_code, 401)
        self.assertEqual(client.post("/personas/register", json=[]).status_code, 400)
        no_store = TestClient(modal_app.build_api(self.engine, asyncio.Lock(), None, None))
        self.assertEqual(no_store.post("/personas/register", json=body).status_code, 503)

    def test_health_warms_the_restore_gpu(self):
        restorer = FakeRestorer()
        client = TestClient(modal_app.build_api(self.engine, asyncio.Lock(), restorer))
        self.assertEqual(client.get("/health").json()["status"], "ok")
        deadline = time.monotonic() + 2
        while restorer.warms == 0 and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual(restorer.warms, 1)

    def test_client_disconnect_stops_generation(self):
        with self.client.websocket_connect(f"/ws?ticket={self.ticket()}") as ws:
            ws.send_text(self.start_message())
            ws.receive_text()
            ws.receive_bytes()
        self.assertTrue(self.engine.stopped.wait(3))


if __name__ == "__main__":
    unittest.main()
