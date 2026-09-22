# Swap mode: self-hosted identity swap per clip over the Turbo pipeline

Status: service live on Modal for the POC (see `services/swap/README.md`); fal host written but blocked on serverless access for the Fanvue team. Client and server halves shipped: `swap` render backend, `generateClip` sends every rendered turbo clip through `server/swapClip.ts`, the swapped mp4 plays and its swapped last frame seeds the next clip, the studio overlay shows the per-clip swap report.

## Why

Director (fal minimax) and Lucy (Decart via fal) both enforce provider-side content policy on the live stream and cannot be configured otherwise. They are labelled SFW only in the setup screen. The clip backends (Turbo, Reference) already run with fal's documented `enable_safety_checker: false`, which fal permits for adult content between consenting adults. An identity-lock mode with the same content posture therefore has to run a model we host, with our own guards, not a third party's stream filter.

## What it is

The driving source is our own pre-rendered turbo clip, so there is no live frame stream: the server posts the finished clip to the swap service, which swaps the persona's face onto every frame (InsightFace `inswapper_128`), restores it (GPEN-BFR-256 via ONNX) and re-encodes the clip at its native frame rate with the source audio. Output runs at the clip's 24/25 fps with no transport latency; the cost is a few seconds of GPU time per clip before it can play.

Re-anchoring falls out of it: the swapped, restored last frame is the next clip's seed, so identity re-locks every clip instead of compounding. The service also reports the ArcFace cosine of the last frame against the reference before and after the swap, for a future gate that re-seeds from the original anchor when the underlying turbo identity has drifted too far.

The earlier per-frame JPEG-over-WebSocket transport (2 to 3 fps effective, 330 to 570 ms round trips) was replaced by this on 2026-09-22.

## Guards we keep (non-negotiable)

- Reference identity must be the synthetic persona photo from setup. No upload of a real person's face into this path; the existing `frameGuard` and reference vetting stay in front of it.
- 18+ only, one fictional adult. Existing frame checks run on the swapped clip, which is the one that plays.
- Service token never reaches the client. The server calls the service with a bearer token; the service fails closed when the token secret is missing.
- A swap failure is not a guard failure: the unswapped turbo clip plays and the overlay reports `failed` with the reason. No auto-retry.

## Service contract

- `POST /swapClip` with `Authorization: Bearer <SWAP_TOKEN>` and JSON `{ "video_url": "<mp4 url>", "reference_image": "<data uri>" }`.
- Response JSON: `video_base64` (h264 mp4, source audio copied), `last_frame_base64` (JPEG of the swapped last frame), `stats` (`frames`, `frames_with_face`, `fps`, `swap_ms`, `ms_per_frame`, `similarity_before`, `similarity_after`, `restored`).
- 403 without a valid token, 422 when the reference has no single face or the clip cannot be read, 500 on anything else.
- Detector every 2nd frame, swap and restore on every detected face, clips capped at 600 frames. A reference whose face fills the whole photo is retried with a replicated border, since the detector misses edge-to-edge faces.
- `GET /health` is unauthenticated and doubles as the warm-up probe (`/api/live/swapWarm`, called by the client when a swap session starts).

## Server contract

- `renderBackendSchema` includes `"swap"`; `renderClip.ts` maps swap to the turbo backend like Lucy.
- `generateClip`: render, then `swapClip` (fetch reference as a data URI, call the service, rehost the mp4 and last frame on fal storage), then frame checks and seed extraction run on the swapped clip. GPU cost is `swap_ms` at `LIVE_TUNABLES.SWAP_COST_PER_SEC_USD`.
- `clipResultSchema.swap` carries the report to the client; `StudioOverlay` renders it on the last-clip line.
- Env: `SWAP_SERVICE_URL` (https base of the Modal app) and `SWAP_TOKEN`; either missing makes every swap clip report `failed`.

## Open decisions

- Whether to chunk the swap (2 s segments, playback after the first) if the per-clip delay eats too much of the idle buffer.
- Re-anchor gate threshold on `similarity_before`; measure a session first.
- Restorer blend (0.8) and whether to add a full-frame upscaler; both are second-order next to the face.
- Moving the Modal app to a Fanvue workspace; the inswapper research-only license.
