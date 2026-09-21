# Swap mode: self-hosted realtime identity swap over the Turbo pipeline

Status: contract only. Not built. Blocked on a fal serverless deploy (needs `fal auth login` by a human) and a GPU budget decision.

## Why

Director (fal minimax) and Lucy (Decart via fal) both enforce provider-side content policy on the live stream and cannot be configured otherwise. They are labelled SFW only in the setup screen. The clip backends (Turbo, Reference) already run with fal's documented `enable_safety_checker: false`, which fal permits for adult content between consenting adults. A live identity-lock mode with the same content posture therefore has to run a model we host, with our own guards, not a third party's stream filter.

## What it is

Same shape as Lucy mode: the Turbo pipeline renders motion into the hidden player, the capture canvas streams it, and a realtime service re-applies the persona's identity to every frame. The difference is the service: an open-source face-identity model (InsightFace `inswapper_128` plus a face restorer such as GFPGAN or CodeFormer) hosted as our own fal serverless app.

## Guards we keep (non-negotiable)

- Reference identity must be the synthetic persona photo from setup. No upload of a real person's face into this path; the existing `frameGuard` and reference vetting stay in front of it.
- 18+ only, one fictional adult. Existing frame checks remain on every rendered clip before it reaches the driving canvas.
- Server key never reaches the client. The realtime session is minted by our token route with an `allowed_apps` scoped to this app.
- No auto-retry on any guard rejection.

## Service contract (fal serverless)

- `fal.App` with `machine_type="GPU-A10G"` or better, `keep_alive = 120`, `min_concurrency = 1` while a session is live so the first frame is not a cold start.
- `setup()`: load InsightFace detector + `inswapper_128.onnx` + restorer once. Compute the persona face embedding from the reference image sent in the first message and cache it for the connection.
- Endpoint: `@fal.endpoint("/ws", is_websocket=True)`. Client sends binary JPEG frames (720x1280) at up to 24fps; server returns swapped JPEG frames in order. Skip, never queue, when behind by more than 2 frames.
- Control messages (JSON text frames): `{"type":"reference","image":"<data uri>"}` once; `{"type":"stop"}`.
- Target: under 60ms per frame on A10G at 720x1280 with detector on every 3rd frame and tracking between.

## Client contract

- `renderBackendSchema` gains `"swap"`; `renderClip.ts` maps swap to the turbo backend like Lucy.
- `swapStream.ts` mirrors `lucyStream.ts`: token route, open/close, cost per second from fal's GPU pricing, `streamClosed` reporting.
- Driving canvas identical to Lucy's (`LUCY_INPUT` sizing). Frames are pulled from the canvas via `canvas.toBlob("image/jpeg", 0.8)` on a fixed timer instead of `captureStream`, because the transport is a WebSocket, not WebRTC.
- Setup screen: `Swap (identity lock over Turbo, self-hosted, alpha)`.

## Open decisions

- GPU hourly cost versus Lucy's $0.02/s. A10G on fal is billed per second while the app is warm; keeping `min_concurrency = 1` for the whole call is the honest comparison.
- Restorer choice affects both identity fidelity and latency. Decide with a 30 second A/B on the same driving clips.
- Whether to move the transport to WebRTC later if JPEG-over-WebSocket latency is visible.
