# Modal host for the LongLive realtime stream: one continuous LongLive-2.0-5B video per WebSocket session on one H100.
# Deploy: cd services/longlive && ../../.venv-fal/bin/modal deploy modal_app.py

import asyncio
import io
import json
import os
import queue
import threading
import time

import modal

from protocol import (
    CLOSE_BAD_REQUEST,
    MAX_IMAGE_BYTES,
    PromptMessage,
    ReanchorMessage,
    ProtocolError,
    StartMessage,
    StopMessage,
    decode_data_uri,
    is_allowed_image_url,
    is_data_uri,
    pack_frame,
    parse_client_message,
    verify_ticket,
)

app = modal.App("ai-video-longlive")
weights = modal.Volume.from_name("longlive-weights")

LONGLIVE_COMMIT = "6b36d20ec6f7958d29d11a704dfa64611a9f2572"
SESSION_CAP_S = 20 * 60
START_TIMEOUT_S = 20
MAX_CLIENT_LAG_S = 10
# Generation runs at most this far ahead of the client's playhead, so a prompt shows within about one block plus this.
LEAD_S = 1.0
# Smoke-test only: data: URIs skip the host allowlist, so it stays off unless set at deploy time.
ALLOW_DATA_URI = os.environ.get("LONGLIVE_ALLOW_DATA_URI") == "1"

image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("git", "ffmpeg", "libgl1", "libglib2.0-0")
    .pip_install("torch==2.8.0", "torchvision==0.23.0", index_url="https://download.pytorch.org/whl/cu128")
    # Prebuilt wheel: compiling flash-attn in the image build takes over an hour of builder time.
    .pip_install(
        "https://github.com/Dao-AILab/flash-attention/releases/download/v2.8.3/flash_attn-2.8.3+cu12torch2.8cxx11abiTRUE-cp310-cp310-linux_x86_64.whl"
    )
    .pip_install(
        "diffusers==0.31.0", "transformers>=4.49.0,<5", "tokenizers>=0.20.3", "accelerate>=1.1.1", "safetensors",
        "einops", "omegaconf", "easydict", "ftfy", "imageio", "imageio-ffmpeg", "av==13.1.0",
        "opencv-python-headless", "sentencepiece", "peft", "torchao==0.13.0", "tqdm", "pillow", "numpy<2.3",
        "fastapi", "httpx",
    )
    # Pinned upstream commit so a rebuild never picks up a pipeline change mid-POC.
    .run_commands(
        "git init /root/LongLive",
        f"git -C /root/LongLive fetch --depth 1 https://github.com/NVlabs/LongLive {LONGLIVE_COMMIT}",
        "git -C /root/LongLive checkout FETCH_HEAD",
        "rm -rf /root/LongLive/assets /root/LongLive/docs /root/LongLive/example",
    )
    .env(
        {
            "LONGLIVE_ALLOW_DATA_URI": "1" if ALLOW_DATA_URI else "0",
            "TOKENIZERS_PARALLELISM": "false",
            "LONGLIVE_LORA_PATH": os.environ.get("LONGLIVE_LORA_PATH", ""),
            "LONGLIVE_LORA_RANK": os.environ.get("LONGLIVE_LORA_RANK", "64"),
            "LONGLIVE_LORA_ALPHA": os.environ.get("LONGLIVE_LORA_ALPHA", ""),
        }
    )
    .add_local_python_source("engine", "protocol")
)


async def fetch_reference_image(url: str) -> bytes:
    if is_data_uri(url):
        return decode_data_uri(url)
    import httpx

    # No redirects: a 3xx could point the fetch at a host outside the allowlist.
    async with httpx.AsyncClient(follow_redirects=False, timeout=15) as client:
        async with client.stream("GET", url) as response:
            if response.status_code != 200:
                raise ProtocolError(CLOSE_BAD_REQUEST, f"reference image fetch failed ({response.status_code})")
            body = bytearray()
            async for chunk in response.aiter_bytes():
                body.extend(chunk)
                if len(body) > MAX_IMAGE_BYTES:
                    raise ProtocolError(CLOSE_BAD_REQUEST, "reference image too large")
            return bytes(body)


class StreamRun:
    """One session: a GPU thread generates blocks, the event loop sends frames and reads client messages."""

    def __init__(self, engine, websocket, start: StartMessage, loop: asyncio.AbstractEventLoop):
        self.engine = engine
        self.websocket = websocket
        self.start = start
        self.loop = loop
        self.outbox: asyncio.Queue = asyncio.Queue()
        self.stop_event = threading.Event()
        self.pending_lock = threading.Lock()
        self.pending: PromptMessage | None = None
        self.pending_reanchor: ReanchorMessage | None = None
        self.queued_frames = 0
        self.queued_lock = threading.Lock()
        self.stop_reason: tuple[int, str] | None = None
        self.first_frame_at: float | None = None
        self.period_s = 0.0

    def _emit(self, item) -> None:
        self.loop.call_soon_threadsafe(self.outbox.put_nowait, item)

    def _emit_text(self, payload: dict) -> None:
        self._emit(("text", json.dumps(payload)))

    def _finish(self, code: int, reason: str) -> None:
        if self.stop_reason is None:
            self.stop_reason = (code, reason)
        self.stop_event.set()
        self._emit(None)

    def generate(self, reference: bytes) -> None:
        from PIL import Image

        engine, start = self.engine, self.start
        handoff: queue.Queue = queue.Queue(maxsize=1)
        decoder = None
        try:
            print(f"[longlive] start prompt: {start.prompt}", flush=True)
            engine.start(Image.open(io.BytesIO(reference)), start.prompt, start.width, start.height)
            self._emit_text(
                {"type": "ready", "width": start.width, "height": start.height, "fps": start.fps, "loadMs": round(engine.load_ms)}
            )
            decoder = threading.Thread(target=self._decode_loop, args=(handoff,), daemon=True)
            decoder.start()
            session_started = time.monotonic()
            scheduled = 0
            while not self.stop_event.is_set():
                if time.monotonic() - session_started > SESSION_CAP_S:
                    self._emit_text({"type": "error", "message": "session time limit reached"})
                    self._finish(1000, "session cap")
                    break
                if self.first_frame_at is not None:
                    # A block takes up to two pipeline periods to reach the client (diffuse, then decode), so start it that early plus LEAD_S.
                    lead_frames = (LEAD_S + 2 * self.period_s) * start.fps
                    played = (time.monotonic() - self.first_frame_at) * start.fps
                    ahead = scheduled - played
                    if ahead > lead_frames:
                        self.stop_event.wait((ahead - lead_frames) / start.fps)
                        continue
                with self.pending_lock:
                    pending, self.pending = self.pending, None
                    reanchor, self.pending_reanchor = self.pending_reanchor, None
                if pending is not None:
                    print(f"[longlive] prompt {pending.id}: {pending.prompt}", flush=True)
                    at_frame = engine.switch_prompt(pending.prompt)
                    self._emit_text({"type": "promptApplied", "id": pending.id, "atFrame": at_frame})
                if reanchor is not None:
                    at_frame = engine.reanchor()
                    self._emit_text({"type": "reanchored", "id": reanchor.id, "atFrame": at_frame})
                block = engine.diffuse_block()
                scheduled += block.frame_count
                while not self.stop_event.is_set():
                    try:
                        handoff.put(block, timeout=0.5)
                        break
                    except queue.Full:
                        continue
        except Exception as error:  # noqa: BLE001 - any GPU-side failure must reach the client as an error frame, then close.
            print(f"[longlive] generation failed: {error!r}", flush=True)
            self._emit_text({"type": "error", "message": "generation failed"})
            self._finish(1011, "generation failed")
        finally:
            self.stop_event.set()
            if decoder is not None:
                decoder.join()
            engine.stop()
            self._finish(1000, "stopped")

    def _decode_loop(self, handoff: queue.Queue) -> None:
        fps = self.start.fps
        try:
            while not self.stop_event.is_set():
                try:
                    block = handoff.get(timeout=0.5)
                except queue.Empty:
                    continue
                result = self.engine.decode_block(block)
                with self.queued_lock:
                    self.queued_frames += len(result.jpegs)
                    queued = self.queued_frames
                if queued > MAX_CLIENT_LAG_S * fps:
                    self._emit_text({"type": "error", "message": "client fell too far behind"})
                    self._finish(1011, "client lag")
                    return
                for offset, jpeg in enumerate(result.jpegs):
                    self._emit(("frame", pack_frame(result.first_frame_index + offset, jpeg)))
                if self.first_frame_at is None:
                    self.first_frame_at = time.monotonic()
                # Diffusion and decode overlap, so the slower stage sets the sustainable rate.
                period_ms = max(result.recache_ms + result.diffusion_ms, result.decode_ms + result.encode_ms)
                self.period_s = period_ms / 1000
                self._emit_text(
                    {
                        "type": "stats",
                        "genFps": round(len(result.jpegs) / self.period_s, 2),
                        "blockMs": round(period_ms),
                        "decodeMs": round(result.decode_ms),
                        "queueFrames": queued,
                        "diffusionMs": round(result.diffusion_ms),
                        "recacheMs": round(result.recache_ms),
                        "encodeMs": round(result.encode_ms),
                    }
                )
        except Exception as error:  # noqa: BLE001 - same contract as the diffusion thread: report, then close.
            print(f"[longlive] decode failed: {error!r}", flush=True)
            self._emit_text({"type": "error", "message": "generation failed"})
            self._finish(1011, "decode failed")

    async def send_loop(self) -> None:
        while True:
            item = await self.outbox.get()
            if item is None:
                return
            kind, payload = item
            if kind == "frame":
                await self.websocket.send_bytes(payload)
                with self.queued_lock:
                    self.queued_frames -= 1
            else:
                await self.websocket.send_text(payload)

    async def receive_loop(self) -> None:
        from starlette.websockets import WebSocketDisconnect

        try:
            while not self.stop_event.is_set():
                message = parse_client_message(await self.websocket.receive_text(), allow_data_uri=ALLOW_DATA_URI)
                if isinstance(message, StopMessage):
                    self._finish(1000, "client stop")
                    return
                if isinstance(message, PromptMessage):
                    # Last one wins: a newer request inside the same block replaces the queued one.
                    with self.pending_lock:
                        self.pending = message
                if isinstance(message, ReanchorMessage):
                    with self.pending_lock:
                        self.pending_reanchor = message
                # A second start is ignored; the contract sends it exactly once.
        except WebSocketDisconnect:
            self._finish(1000, "client closed")
        except ProtocolError as error:
            self._emit_text({"type": "error", "message": error.message})
            self._finish(error.code, error.message)


def build_api(engine, session_lock: asyncio.Lock):
    from fastapi import FastAPI, WebSocket
    from starlette.websockets import WebSocketDisconnect

    api = FastAPI()

    @api.get("/health")
    async def health() -> dict:
        return {"status": "ok", "busy": session_lock.locked(), "loadMs": round(engine.load_ms)}

    @api.websocket("/ws")
    async def stream(websocket: WebSocket, ticket: str | None = None) -> None:
        # Accept first: a close before accept becomes an HTTP 403 and the client never sees the 4401 code.
        await websocket.accept()
        try:
            verify_ticket(ticket, os.environ.get("LONGLIVE_TOKEN"), time.time())
        except ProtocolError as error:
            await websocket.close(code=error.code, reason=error.message)
            return
        if session_lock.locked():
            await websocket.send_text(json.dumps({"type": "error", "message": "busy"}))
            await websocket.close(code=1013, reason="busy")
            return
        async with session_lock:
            try:
                first = parse_client_message(
                    await asyncio.wait_for(websocket.receive_text(), START_TIMEOUT_S), allow_data_uri=ALLOW_DATA_URI
                )
                if not isinstance(first, StartMessage):
                    raise ProtocolError(CLOSE_BAD_REQUEST, "first message must be start")
                reference = await fetch_reference_image(first.reference_image_url)
            except ProtocolError as error:
                await websocket.send_text(json.dumps({"type": "error", "message": error.message}))
                await websocket.close(code=error.code, reason=error.message)
                return
            except asyncio.TimeoutError:
                await websocket.close(code=CLOSE_BAD_REQUEST, reason="start timeout")
                return
            except WebSocketDisconnect:
                return
            except Exception as error:  # noqa: BLE001 - a failed fetch is a client-visible 4400, never a crash.
                print(f"[longlive] reference fetch failed: {error!r}", flush=True)
                await websocket.send_text(json.dumps({"type": "error", "message": "reference image fetch failed"}))
                await websocket.close(code=CLOSE_BAD_REQUEST)
                return

            run = StreamRun(engine, websocket, first, asyncio.get_running_loop())
            receiver = asyncio.create_task(run.receive_loop())
            generator = asyncio.create_task(asyncio.to_thread(run.generate, reference))
            try:
                await run.send_loop()
            except (WebSocketDisconnect, RuntimeError):
                run._finish(1000, "client closed")
            finally:
                run.stop_event.set()
                receiver.cancel()
                # The GPU thread must finish before the lock frees, or the next session would share the model.
                await generator
                code, reason = run.stop_reason or (1000, "done")
                try:
                    await websocket.close(code=code, reason=reason)
                except RuntimeError:
                    pass

    return api


@app.cls(
    image=image,
    gpu="H100",
    cpu=8,
    memory=65536,
    volumes={"/weights": weights},
    secrets=[modal.Secret.from_name("longlive-token")],
    # One H100 at most: the account caps at 2 concurrent GPUs and each session needs a whole card.
    max_containers=1,
    min_containers=0,
    # Long enough that a container woken from the setup screen is still warm when the viewer goes live.
    scaledown_window=300,
    # Past the 20 min session cap, so the cap closes the socket rather than the platform.
    timeout=25 * 60,
)
# Several inputs so /health never queues behind a live session; the session lock below keeps it to one stream per GPU.
@modal.concurrent(max_inputs=4)
class LongLiveService:
    @modal.enter()
    def load(self) -> None:
        from engine import EngineOptions, LongLiveEngine

        self.engine = LongLiveEngine(EngineOptions())
        self.session_lock = asyncio.Lock()
        warmup_ms = self.engine.warmup()
        print(f"[longlive] model loaded in {self.engine.load_ms / 1000:.1f}s, warm-up {warmup_ms / 1000:.1f}s", flush=True)

    @modal.asgi_app()
    def serve(self):
        return build_api(self.engine, self.session_lock)
