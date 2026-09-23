# WebSocket contract test against a fake engine, no GPU. Needs fastapi + modal (the .venv-fal has both).
# Run: cd services/longlive && ../../.venv-fal/bin/python -m unittest -v test_service
import asyncio
import json
import os
import struct
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

    def test_restart_rebuilds_the_session_with_monotonic_frames(self):
        self.engine.block_s = 0.2
        frames, texts = [], []
        with self.client.websocket_connect(f"/ws?ticket={self.ticket()}") as ws:
            ws.send_text(self.start_message())
            ws.receive_text()
            ws.send_text(json.dumps({"type": "prompt", "prompt": "old scene", "id": "p1"}))
            ws.send_text(json.dumps({"type": "restart", "id": "r1", "referenceImageUrl": png_data_uri(), "prompt": "she kneels"}))
            while len(frames) < 29 * 2 + 32 * 2:
                message = ws.receive()
                if message.get("bytes") is not None:
                    frames.append(struct.unpack(">I", message["bytes"][:4])[0])
                elif message.get("text") is not None:
                    texts.append(json.loads(message["text"]))
            ws.send_text(json.dumps({"type": "stop"}))
            self.assertEqual(self.close_code(ws), 1000)
        self.assertEqual(frames, list(range(len(frames))))
        restarted = [t for t in texts if t["type"] == "restarted"]
        self.assertEqual([t["id"] for t in restarted], ["r1"])
        # The first frame after the restart carries the index the ack named.
        self.assertGreater(restarted[0]["atFrame"], 0)
        self.assertIn(restarted[0]["atFrame"], frames)
        self.assertEqual(self.engine.prompts[-1], "she kneels")
        # The queued prompt belonged to the old scene and is dropped by the restart.
        self.assertNotIn("old scene", self.engine.prompts)

    def test_restart_with_a_bad_image_keeps_the_session(self):
        texts, frames = [], 0
        with self.client.websocket_connect(f"/ws?ticket={self.ticket()}") as ws:
            ws.send_text(self.start_message())
            ws.receive_text()
            ws.send_text(json.dumps({"type": "restart", "id": "r1", "referenceImageUrl": "data:image/png;base64,bm90IGFuIGltYWdl", "prompt": "p"}))
            while frames < 29 + 32 * 2:
                message = ws.receive()
                if message.get("bytes") is not None:
                    frames += 1
                elif message.get("text") is not None:
                    texts.append(json.loads(message["text"]))
            ws.send_text(json.dumps({"type": "stop"}))
            self.assertEqual(self.close_code(ws), 1000)
        self.assertIn({"type": "restartFailed", "id": "r1", "message": "restart image fetch failed"}, texts)
        self.assertFalse([t for t in texts if t["type"] in ("restarted", "error")])

    def test_reanchor_without_id_closes_4400(self):
        with self.client.websocket_connect(f"/ws?ticket={self.ticket()}") as ws:
            ws.send_text(self.start_message())
            ws.receive_text()
            ws.send_text(json.dumps({"type": "reanchor"}))
            self.assertEqual(self.close_code(ws), 4400)

    def test_client_disconnect_stops_generation(self):
        with self.client.websocket_connect(f"/ws?ticket={self.ticket()}") as ws:
            ws.send_text(self.start_message())
            ws.receive_text()
            ws.receive_bytes()
        self.assertTrue(self.engine.stopped.wait(3))


if __name__ == "__main__":
    unittest.main()
