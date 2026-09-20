# Live Engine

Interactive AI live stream: a creator persona rendered as a continuous chain of short video
clips, driven by fan requests from chat. This document is the contract between the server
engine (`src/lib/live/server`) and the client pipeline (`src/lib/live/client`). Shared types
live in `src/lib/live/contract.ts` and are the only coupling between the two halves.

## Goals

1. **Continuous.** The stream never freezes. Every clip is >= 10s. While clip N plays, clip
   N+1 is already rendering, seeded from clip N's last frame. Playback is gapless.
2. **Stateful and grounded.** One typed `LiveState` (body, wardrobe, props, pose, scene) is the
   single source of truth. Every prompt is derived from it. Every rendered frame is checked
   against it before it becomes the next seed, and repaired if it drifted. Nothing appears,
   disappears, or changes unless a job transitions the state.
3. **Requests drive the scene, idle never does.** Idle clips hold the current state with small
   grounded life (breathing, blinking, small shifts, glancing at the chat). Only `reply` /
   `beat` / `settle` / `redress` jobs may change `LiveState`.
4. **Chat-first.** She reads and types on camera before acting. Her text reply lands in the
   chat panel in sync with her typing beat. Speech is off by default (`speechMode: "text"`);
   the video model's native speech is unreliable and is kept only as an experimental mode.
5. **Real.** Human biology and physics. One garment at a time, fabric has weight, hands do one
   thing, no props unless fetched on camera, no camera moves (fixed laptop webcam), no
   duplicated limbs, no morphing.
6. **Generic.** A `CreatorProfile` (look, scenes, baseline state, allowed acts, tip menu) is
   data, not code. Rendering backends and text backends sit behind interfaces.

## Architecture

```
Client (browser)                                  Server (Next route handlers, stateless)
┌──────────────────────────────┐                  ┌──────────────────────────────────────┐
│ LiveDirector (pure reducer)  │  POST /api/live  │ planClip(state, job) -> ClipPlan      │
│  - LiveState                 │  /clip           │ renderClip(plan, seed) -> video       │
│  - job queue                 │ ───────────────► │ extractLastFrame                      │
│  - redress / settle timers   │                  │ guardFrame(frame, expected) -> issues │
│ ClipPipeline (1-ahead chain) │ ◄─────────────── │ repairFrame(frame, expected, anchor)  │
│  - inflight job              │  ClipResult      │ writeReply (text LLM)                  │
│  - ready buffer              │                  └──────────────────────────────────────┘
│ GaplessPlayer (2 <video>)    │
│ ChatSync (typing lead)       │
└──────────────────────────────┘
```

The server is stateless: the client sends the full `LiveSessionSnapshot` with every job and
receives the next state back. This runs on Vercel serverless without shared memory. Moving
state to a session store (Redis) later only changes the transport, not the engine.

## Clip chain: anchors and loops

Generation is slower than playback (render ~10s, frame extract ~3s, guard ~2s, repair or
identity correction ~10s when they fire), so a strict one-in-flight chain cannot hold a buffer.
The chain therefore has two modes:

- **Anchored idle.** An idle clip is rendered with `image_url` = `end_image_url` = the current
  anchor frame, so it starts and ends on the same frame (`ClipResult.loops = true`,
  `seedFrameUrl` = the anchor). Idle clips are interchangeable: the client keeps
  `IDLE_BUFFER_TARGET` ready and up to `IDLE_MAX_INFLIGHT` rendering in parallel, all from one
  anchor. Guard and identity correction run on the anchor off the critical path; a repaired
  anchor replaces the old one and the stockpile is rebuilt from it.
- **Chained action.** `greeting`, `reply`, `beat`, `settle`, `redress` and `checkIn` are
  seeded from the frame currently on the anchor and chain frame to frame. Their last frame
  (guarded, repaired) becomes the new anchor. When the anchor changes, buffered idle loops from
  the old anchor are discarded and new ones are rendered from the new anchor immediately.

Invariants:

- A request's first clip is submitted the moment the request arrives, seeded from the current
  anchor; it does not wait for in-flight idles. It plays at the first clip boundary after it is
  ready. Idle loops fill the boundaries before that.
- A chained clip's seed is always the previous chained clip's `seedFrameUrl`.
- Every clip commits `state`. Idle loops commit the unchanged state.
- Minimum clip duration is 10s; maximum 15s (fal limit). Idle = 10s.
- The stream is shown as live once `PRIME_CLIPS` clips are ready after the greeting.
- The reference backend has no end-frame parameter, so idle loops are not available on it; it
  falls back to a strict one-in-flight chain and is marked experimental in the UI.

## Request latency policy

1. Immediately: the reply job is submitted from the current anchor, and the fan sees
   "typing…" in chat. The reply text lands at `typingLeadSec` into the reply clip.
2. Idle loops already buffered keep playing until the reply clip is ready; then it plays at the
   next boundary. Idle renders in flight for the old anchor are left to finish and discarded
   (cost logged) once the anchor changes.
3. Follow-up beats chain after the reply, then `settle` returns her to the baseline pose. The
   settle clip's last frame is the new anchor.

## Wardrobe and props

- `Wardrobe` is a per-garment record (`top`, `bottom`, `bra`, `panties`, each `on | off`, plus a
  description string captured at greeting from the reference photo). Strip and redress move one
  garment at a time. The prompt names the exact garment as described.
- After `REDRESS_AFTER_IDLE_MS` (120000) with no request while any garment is off, the director
  queues `redress` jobs (one garment per clip, reverse order of removal).
- Props: `none | fetching | <toyId>`. A toy must be fetched on camera (one clip) before it can
  be held, and is put down before the next unrelated request.

## Frame guard

After every render: extract last frame → `guardFrame(frame, expectedState)` using a vision
model returning `{ topOn, bottomOn, visibleProps[], pose, extraPeople, extraLimbs }` →
compare with expected → if mismatch, `repairFrame(frame, expectedState, anchorFrame)` with the
image edit model (explicit instructions: restore garment X, remove object Y, keep pose,
background, framing; identity from anchor). Guard failures (model refusal, timeout) are logged
and skipped; repair is never attempted blind. Identity re-anchoring against the original
upload continues to run on the existing 45s cadence.

## Speech

`speechMode`:

- `text` (default): she does not speak; ambient room audio only; replies are typed.
- `native`: the video model renders speech (existing behaviour, experimental, gibberish-prone).

A TTS + lip-sync stage is out of scope for this pass; the `SpeechMode` union and prompt
builder are the extension point.

## Monetisation hooks (data model only)

`CreatorProfile.tipMenu` lists priced requests. The UI shows the menu and marks a request as
`paid` in the transcript. No payment execution exists in this repo; that stays with Fanvue's
payment stack behind human approval.

## File ownership

- Server: `src/lib/live/server/**`, `src/app/api/live/**`, `src/lib/fal/**`, `src/lib/groq.ts`.
- Client: `src/lib/live/client/**`, `src/app/call/**`, `src/components/**`, `src/app/globals.css`.
- Shared: `src/lib/live/contract.ts` (change only by agreement; both halves import it).
- Legacy `src/lib/aiVideo/**` and `src/app/api/ai-video/**` are deleted once the new paths
  replace them. Tests move with the logic.

## Quality bar

- `pnpm lint`, `npx tsc --noEmit`, `pnpm test` clean.
- Director and pipeline are pure/injectable and unit tested with fakes (no network, fake timers).
- Prompt builders are unit tested per intent: every catalogued request maps to a beat with the
  expected state transition and never removes an unrequested garment or adds a prop.
- No `any`, no non-null assertions without a stated reason, no swallowed errors without a log.

## Server implementation notes

- `planClip.ts` is pure (no network) and holds the entire prompt library and intent catalog.
  It composes a fixed set of locks (camera, anatomy, look, wardrobe, prop, body, physics,
  overlay, speech) onto every job, then a job-specific action line, then an explicit end-state
  line naming the post-clip wardrobe/pose. The reply intent catalog is a priority chain of
  small pure matchers (dress, strip-all, tease, strip-one, pose, toy, touch, dance, drink, tip,
  small-talk, fallback); the first match wins, the fallback never changes state.
- Chat-first typing lead is estimated from the fan's own request length at plan time (before the
  reply LLM has run), since render must start immediately in parallel with reply generation. The
  final `ClipResult.reply.typingLeadSec` is recomputed from the actual reply text once it lands,
  clamped to the clip's already-committed duration.
- `correctFrameIdentityDrift` (in `src/lib/fal/requestFrameIdentityCorrection.ts`) now takes a
  `prompt` override so `frameGuard.repairFrame` can reuse the same nano-banana edit endpoint with
  an issue-specific instruction instead of the generic drift-correction prompt.
- `vitest.config.ts` declares the `@/` alias (vitest does not read `tsconfig.json` paths on its
  own) and stubs the env vars `@/env` requires, so server modules can be unit tested without a
  real `.env`.
- Env vars needed at runtime: `FAL_KEY`, `GROQ_API_KEY` (both already required by `@/env`).
