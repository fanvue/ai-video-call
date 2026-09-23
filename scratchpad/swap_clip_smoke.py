# Usage: .venv-fal/bin/python scratchpad/swap_clip_smoke.py <clip.mp4> <persona-id> [out.mp4]
import base64
import json
import sys
import time

import modal

video_path, persona_id = sys.argv[1], sys.argv[2]
out_path = sys.argv[3] if len(sys.argv) > 3 else "swap-clip-out.mp4"

with open(video_path, "rb") as file:
    video = file.read()

service = modal.Cls.from_name("ai-video-swap", "SwapService")()
started = time.perf_counter()
body = service.swap_clip_bytes.remote(video, persona_id)
wall_ms = int((time.perf_counter() - started) * 1000)
with open(out_path, "wb") as file:
    file.write(base64.b64decode(body["video_base64"]))
with open(out_path.replace(".mp4", "-last.jpg"), "wb") as file:
    file.write(base64.b64decode(body["last_frame_base64"]))
print(json.dumps({"wall_ms": wall_ms, **body["stats"]}, indent=2))
