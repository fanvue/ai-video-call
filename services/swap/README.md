# Swap service (self-hosted)

Implements the service half of `docs/swap-mode-contract.md`. One engine (`swap_core.py`), two hosts: Modal (`modal_app.py`, live for the POC) and fal serverless (`app.py`, blocked until the Fanvue team has serverless access).

## Modal (current POC host)

Deployed to the `jamal-77992` personal workspace on 2026-09-22; move to a Fanvue workspace before anyone else depends on it.

```bash
.venv-fal/bin/modal deploy services/swap/modal_app.py
```

WebSocket: `wss://jamal-77992--ai-video-swap-swapservice-web.modal.run/ws`. A code-only redeploy can leave old containers serving for a while; `modal app stop -y ai-video-swap` first when a route change does not show up.

Smoke test (`scratchpad/swap_smoke.py`, 720x1280 JPEG frames, London to Modal): first frame 3.2s (detector warm-up), then 330 to 570 ms per round trip. Cold start about 25s. No restorer yet (gfpgan's basicsr build is broken), so faces are inswapper_128 raw.

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

The deploy prints `https://fal.run/<team>/ai-video-swap`; the WebSocket lives at `wss://fal.run/<team>/ai-video-swap/ws`. Put the app alias in `SWAP_APP_ALIAS` for the token route.

## Cost (fal list prices, Sept 2026; Modal A10G is $1.10/hr too)

| GPU          | $/hr | $/s     | vs Lucy $0.02/s |
| ------------ | ---- | ------- | --------------- |
| A10G         | 1.10 | 0.0003  | 65x cheaper     |
| RTX PRO 6000 | 2.99 | 0.0008  | 24x cheaper     |
| H100         | 4.50 | 0.00125 | 16x cheaper     |

Billed while the container is warm (`keep_alive=120` adds two minutes after the last call).

## Licensing

`inswapper_128.onnx` is research-only. Fine for the spike, blocked for production until a commercial license or a replacement model is chosen.
