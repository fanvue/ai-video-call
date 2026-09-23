# Swap service (self-hosted)

Implements the service half of `docs/swap-mode-contract.md`: `POST /swapClip` takes a rendered turbo clip URL plus the persona reference and returns the clip with the reference face swapped onto every frame (InsightFace inswapper_128) and restored (GPEN-BFR-512 via ONNX), re-encoded with ffmpeg at the source frame rate with the source audio. One engine (`swap_core.py`), two hosts: Modal (`modal_app.py`, live for the POC) and fal serverless (`app.py`, blocked until the Fanvue team has serverless access).

## Modal (current POC host)

Deployed to the `jamal-77992` personal workspace on 2026-09-22 (L40S, up to 3 containers); move to a Fanvue workspace before anyone else depends on it.

```bash
.venv-fal/bin/modal deploy services/swap/modal_app.py
```

Base URL: `https://jamal-77992--ai-video-swap-swapservice-web.modal.run` (Vercel `SWAP_SERVICE_URL`). Every call needs `Authorization: Bearer <SWAP_TOKEN>`; the token lives in the Modal secret `ai-video-swap-token` and in Vercel as `SWAP_TOKEN`. The service answers 403 without it and refuses everything if the secret is missing. A code-only redeploy can leave old containers serving for a while; `modal app stop -y ai-video-swap` first when a route change does not show up.

Smoke test: `.venv-fal/bin/python scratchpad/swap_clip_smoke.py <clip.mp4> <reference.jpg>` sends a local clip through the deployed class (Modal auth, no token needed) and writes the swapped mp4 and its last frame next to it.

Measured 2026-09-22 on a 101-frame 542x988 24fps clip: A10G sequential 49 ms/frame; three frames in flight 36 ms/frame; L40S with three in flight 16 ms/frame (detect 13, swap 13, restore 20 of thread time), so a 10s turbo clip costs about 4 to 5s of GPU time. Cold start was 60 to 85s while insightface fetched the buffalo_l pack at boot; baking it into the image brings it to about 15s. The app still pings `/health` twice when a swap session starts (two containers, since idle fillers and replies swap concurrently), and the greeting only waits 25s for its swap so a cold container never blocks the join (the first clip then plays unswapped and is reported as `failed`). Identity: ArcFace cosine to the reference went from -0.04 (a different persona) to 0.86 after the swap. GPEN-512 was 140 ms/frame for no visible gain on a 480P face, hence GPEN-256.

## Swap source and face recipe (2026-09-23)

The swap source is a manifest persona only. `/swapClip` and `/swapTail` take `persona_id`, resolve it with LongLive's `services/longlive/persona.py` against the `persona-faces` volume (mounted read-only, reloaded at most every 30 s) and refuse anything else with a 422 `persona gate: <reason>`. The upload never reaches the swap. Tests: `cd services/swap && ../../.venv-fal/bin/python -m unittest -v test_persona_gate`.

Swap mode's persona list and registration are served by `PersonaStore` in `modal_app.py`, a CPU-only class (0.25 cpu, 256 MB, one container, 15 s scaledown) running `persona_store.py`, so the setup screen never wakes a GPU. `GET /personas?ticket=` and `POST /personas/register` mirror LongLive's handlers: the same `protocol.py` ticket and register-token checks (keyed by `SWAP_TOKEN`, which must be at least 32 characters or both fail closed), the same JPEG/PNG magic and 10 MB checks, and `persona.py`'s `registered_entry` / `add_registered` writing the shared `persona-faces` volume. The Next routes `/api/live/swapPersonas` and `/api/live/swapPersonaRegister` call it via `SWAP_PERSONA_URL` and keep the `@fanvue.com` session email, attestation and single audit line gates. Both LongLive and this store write the same manifest; each serialises its own writes, but a registration landing in both at the same instant could lose one entry (re-registering restores it). Tests: `../../.venv-fal/bin/python -m unittest -v test_persona_store`.

`FACE_RECIPE` picks the per-frame recipe: `legacy` (Reinhard colour match, no restore) or `longlive` (LongLive's MOTION_KEEP 0.35, no colour match, GFPGAN 1.4 at 0.6 on the 512 face crop). Measured on turbo480, crop480a and scene6_11s (277/277/264 frames, A10G, 3 workers, synth-persona-01), mean of the three:

| recipe | ArcFace to persona | frame-to-frame ID | face-neck abs dL | eye amp vs raw | mouth amp vs raw | ms/frame |
| ------ | ------------------ | ----------------- | ---------------- | -------------- | ---------------- | -------- |
| raw    | 0.600              | 0.972             | 15.05            | 1.00           | 1.00             |          |
| legacy | **0.910**          | **0.985**         | 14.51            | 0.90           | 0.84             | **14.0** |
| longlive | 0.878            | 0.982             | 14.91            | 0.84           | 0.88             | 45.4     |

Legacy stays the default. The longlive recipe's LongLive gains came from a stream with no colour match and a weaker raw face; on turbo clips it gives up identity, leaves neck tone unchanged and triples the per-frame cost (GFPGAN is ~21 of ~45 ms). The crop sheets show slightly smoother skin and no visible seam difference.

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
