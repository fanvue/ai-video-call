# wan14b premium clip service (self-hosted, research POC)

Chained image-to-video clips from Wan2.1 I2V 14B 480P with the lightx2v 4-step distill LoRA fused. Each call renders one clip from a seed frame, swaps the allowlisted persona onto it (swap mode's inswapper fp16, legacy recipe), and returns the next clip's seed: the swapped last frame with swap mode's seed face tone lock applied. Not wired into the web app yet.

Fictional, company-owned synthetic personas only: `persona_id` must resolve in the `persona-faces` manifest (LongLive's `persona.py`), and the seed image must already show that persona (ArcFace >= 0.35), or the call is a 422.

## API

`POST /clip` with `Authorization: Bearer <SWAP_TOKEN>` (the `ai-video-swap-token` secret, same check as the swap service; 403 without it, everything refused if the secret is unset).

```json
{
  "persona_id": "synth-persona-01",
  "prompt": "a woman tilts her head and laughs softly, soft indoor light",
  "image_base64": "<seed jpeg/png, or data URI>",
  "image_url": null,
  "num_frames": 81,
  "duration_s": null,
  "seed": 42,
  "swap": true,
  "tone_reference_base64": "<the session's first seed; defaults to the persona photo>",
  "tone_reference_url": null
}
```

- Exactly one of `image_url` (https only, 10 MB cap) or `image_base64`; at most one of `tone_reference_url` or `tone_reference_base64`.
- `prompt` up to 4,000 characters (the app's planner prompts run about 2,000 to 2,300).
- `num_frames` is 4k+1 in 17..81, or `duration_s` rounds to that grid (16 fps, so 81 frames is 5.06 s). Default 81.
- Response: `{video_base64 (h264 mp4, 480x832, 16 fps), last_frame_base64 (PNG, next seed), last_frame_format, stats}`; `stats` carries `render_ms`, `decode_ms`, `swap_ms`, `encode_ms`, `total_ms`, `num_frames`, `fps`, `frames_with_face`, `tone_locked`, `similarity_after`.
- `POST /warm` (Bearer token): answers once the container has loaded Wan and the swap; the app's Premium warm-up. A cold one took 85.8 s in the smoke.
- Face detection pads the frame by half on every side when the raw pass finds nothing (`face_detect.py`): a Wan headshot's face is ~440 px of a 480 px frame, past SCRFD's range at det_size 640.
- `GET /health` (bearer token). Modal-authenticated `Wan14bService.clip_bytes(body)` for laptop smoke tests.

H100, `min_containers=0`, `scaledown_window=300`, `max_containers=2`, one clip per container.

## Deploy and smoke

```bash
# weights (once): scratchpad/wan14b/download.py fills the wan14b-weights volume (~47 GB)
.venv-fal/bin/modal deploy services/wan14b/modal_app.py
.venv-fal/bin/modal run services/wan14b/modal_app.py::smoke --seed-path scratchpad/synth-persona.jpeg
```

## Tests

```bash
cd services/wan14b && ../../.venv-fal/bin/python -m unittest -v test_clip_request test_seed_lock test_face_detect
```

## App integration (Premium render mode)

- `contract.ts`: `"wan14b"` backend, `isSwapSession`, `WAN14B_CLIP_SEC` (5), `WAN14B_NUM_FRAMES` (81), `WAN14B_COST_PER_SEC_USD` (H100 list price), `premium` report on clip results.
- `server/wan14bClip.ts`: posts to `/clip` with the session seed, persona and tone frame, rehosts the mp4 and PNG on fal storage like swap mode. URL from `WAN14B_SERVICE_URL` (defaults to the deployed app), auth is `SWAP_TOKEN`.
- `server/generateClip.ts`: chain clips render here and seed the next clip from the returned last frame (no `/swapTail`, no client clip swap); idles stay on swap; any error or timeout re-plans that clip on swap and records `premium.status = "fallback"`, which the client reports as the `premiumFallback` telemetry event.
- `server/planClip.ts`: chain clips fit to 5 s the way swap mode fits 10 s.
- `SetupScreen`: "Premium (slower, best likeness)" beside the default Swap; Face lock and Hand mask are hidden for it.
