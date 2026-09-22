# Swap service (self-hosted)

Implements the service half of `docs/swap-mode-contract.md`: `POST /swapClip` takes a rendered turbo clip URL plus the persona reference and returns the clip with the reference face swapped onto every frame (InsightFace inswapper_128) and restored (GPEN-BFR-512 via ONNX), re-encoded with ffmpeg at the source frame rate with the source audio. One engine (`swap_core.py`), two hosts: Modal (`modal_app.py`, live for the POC) and fal serverless (`app.py`, blocked until the Fanvue team has serverless access).

## Modal (current POC host)

Deployed to the `jamal-77992` personal workspace on 2026-09-22 (L40S, up to 3 containers); move to a Fanvue workspace before anyone else depends on it.

```bash
.venv-fal/bin/modal deploy services/swap/modal_app.py
```

Base URL: `https://jamal-77992--ai-video-swap-swapservice-web.modal.run` (Vercel `SWAP_SERVICE_URL`). Every call needs `Authorization: Bearer <SWAP_TOKEN>`; the token lives in the Modal secret `ai-video-swap-token` and in Vercel as `SWAP_TOKEN`. The service answers 403 without it and refuses everything if the secret is missing. A code-only redeploy can leave old containers serving for a while; `modal app stop -y ai-video-swap` first when a route change does not show up.

Smoke test: `.venv-fal/bin/python scratchpad/swap_clip_smoke.py <clip.mp4> <reference.jpg>` sends a local clip through the deployed class (Modal auth, no token needed) and writes the swapped mp4 and its last frame next to it.

Measured 2026-09-22 on a 101-frame 542x988 24fps clip: A10G sequential 49 ms/frame; three frames in flight 36 ms/frame; L40S with three in flight 16 ms/frame (detect 13, swap 13, restore 20 of thread time), so a 10s turbo clip costs about 4 to 5s of GPU time. Cold start adds about 35s, which is why the app pings `/health` twice when a swap session starts (two containers, since idle fillers and replies swap concurrently). Identity: ArcFace cosine to the reference went from -0.04 (a different persona) to 0.86 after the swap. GPEN-512 was 140 ms/frame for no visible gain on a 480P face, hence GPEN-256.

## fal (target host)

### Deploy (a human runs this, no login automation)

The `fal` on your Mac is a custom skill wrapper, not fal's CLI, so use fal's Python CLI in a venv:

```bash
python3 -m venv .venv-fal && . .venv-fal/bin/activate && pip install fal
```

```bash
.venv-fal/bin/fal auth login
```

```bash
.venv-fal/bin/fal deploy services/swap/app.py::SwapApp --app-name ai-video-swap
```

The deploy prints `https://fal.run/<team>/ai-video-swap`; point `SWAP_SERVICE_URL` at it.

## Cost (fal list prices, Sept 2026; Modal: A10G $1.10/hr, L40S $1.95/hr)

| GPU          | $/hr | $/s     | vs Lucy $0.02/s |
| ------------ | ---- | ------- | --------------- |
| A10G         | 1.10 | 0.0003  | 65x cheaper     |
| RTX PRO 6000 | 2.99 | 0.0008  | 24x cheaper     |
| H100         | 4.50 | 0.00125 | 16x cheaper     |

Billed while the container is warm (`keep_alive=120` adds two minutes after the last call).

## Licensing

`inswapper_128.onnx` is research-only. Fine for the spike, blocked for production until a commercial license or a replacement model is chosen.
