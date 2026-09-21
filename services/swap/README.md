# Swap service (self-hosted, fal serverless)

Implements the service half of `docs/swap-mode-contract.md`. Not deployed yet.

## Deploy (a human runs this, no login automation)

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

## Cost (fal list prices, Sept 2026)

| GPU          | $/hr | $/s     | vs Lucy $0.02/s |
| ------------ | ---- | ------- | --------------- |
| A10G         | 1.10 | 0.0003  | 65x cheaper     |
| RTX PRO 6000 | 2.99 | 0.0008  | 24x cheaper     |
| H100         | 4.50 | 0.00125 | 16x cheaper     |

Billed while the container is warm (`keep_alive=120` adds two minutes after the last call).

## Licensing

`inswapper_128.onnx` is research-only. Fine for the spike, blocked for production until a commercial license or a replacement model is chosen.
