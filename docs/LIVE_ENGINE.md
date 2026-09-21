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
- **Bridge idles.** While a multi-beat chain is running, the idle lane targets the chain tail
  instead of the (stale) anchor, so an idle rendered from that tail is already playable the
  moment its chained clip is displayed, instead of holding a still frame for the next beat's
  render latency. Idles already sitting in the pool from an older anchor stay playable but stop
  counting toward the buffer target once the tail moves past them. When the tail is promoted to
  the anchor, its bridge idles are simply current-anchor stock from then on. Gated by
  `pipeline.ts`'s module-level `BRIDGE_IDLES` flag (on by default; off saves one idle render per
  beat).

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

`guardFrame(frame, expectedState)` uses a vision model returning `{ top, bottom, bra, panties,
visibleProps[], pose, extraPeople, extraLimbs }`, each garment `"present" | "absent" | "unknown"`
(never guessed) and validated with a zod schema — an unparseable or schema-invalid response comes
back `checked: false`, never adopted.

Every `ClipResult` carries a `verdict: "approved" | "rejected"` and `rejectReason`. Canon is truth
for the seed frame: any checked frame showing a garment that disagrees with canon in **either**
direction — worn-but-should-be-off, or off-but-should-be-on — rejects the clip, not just the
worn-but-should-be-off case. The one exception is a wardrobe clip's own target garment, which is
exempt from rejection and instead adopted from observation both ways (`reconcileState.ts`), so
`director.ts`'s bounded retry can re-attempt an unmet removal/add. Observed `"unknown"` never
counts as a mismatch. `evaluateFrameChecks` in `generateClip.ts` is the single place this rule
lives, for all four clip kinds:

| Clip kind                                                     | Frames checked  | Unchecked frame                  | Checked-frame rejection                                                      |
| ------------------------------------------------------------- | --------------- | -------------------------------- | ---------------------------------------------------------------------------- |
| Idle                                                          | midpoint only   | rejects (fail closed)            | any garment mismatch, extraPeople/extraLimbs                                 |
| Hold (`wardrobeIntent === null && !explicit`)                 | midpoint + last | rejects (fail closed)            | any garment mismatch, extraPeople/extraLimbs                                 |
| Explicit non-wardrobe (`wardrobeIntent === null && explicit`) | midpoint + last | skips with a warning (fail open) | any garment mismatch, extraPeople/extraLimbs on a checked frame              |
| Wardrobe (`wardrobeIntent` `"remove"`\|`"add"`)               | last only       | skips with a warning (fail open) | any NON-target garment mismatch, extraPeople/extraLimbs on the checked frame |

The fail-open paths exist so a persistent vision refusal can't permanently block a legitimately
requested clip. An approved clip reconciles pose unconditionally; wardrobe is only ever reconciled
for a wardrobe clip's own target garment (never for a hold or explicit non-wardrobe clip, since
there canon already matches or the clip was rejected). A rejected clip adopts nothing — its state
stays `plan.expectedState` untouched. `buildPrompt` also adds a short "clothing stays exactly as
described" line to any clip whose action doesn't already carry an equivalent lock and whose planned
wardrobe doesn't change, as a second line of defense against the model changing wardrobe when it
wasn't asked to.

Frame repair (`repairFrame`) was retired with this pass; a failing clip is rejected and retried as
a whole clip instead of pixel-patched. Identity re-anchoring against the original upload continues
to run on the existing 45s cadence.

## Job ordering, busy gate and abandonment

- **Reply insertion.** A new fan reply is inserted behind every already-queued beat and fan
  reply (several fan messages arriving mid-render run FIFO), ahead of any queued viewer reply,
  and ahead of background work (`checkIn`). Viewer requests are always appended at the end.
- **Busy gate.** `LiveDirector.tick(now, { busy })` is a no-op while `busy` is true, on top of
  the "queue non-empty" guard. `busy` covers a chain job in flight or not yet promoted/played
  (`ClipPipeline.isChainActive()`), or the clip on screen being a request/beat rather than idle
  filler, so `rest`/`checkIn` never schedule mid-request. Idle thresholds measure from
  `lastActivityAt`, which advances on every fan/viewer request and every non-idle `clipCompleted`.
- **Displayed vs. canon state.** The director's `liveState` (canon, used to plan the next step)
  advances at `clipCompleted`, as soon as a clip finishes rendering. The UI's displayed state
  advances only once that clip is on screen (`GaplessPlayer.onClipStarted` →
  `ClipPipeline.onClipStarted` / `applyLiveState`). `displayAnchorFrameUrl` likewise moves only
  on playback, never on a pull used to preload.
- **Request abandonment.** A chain job gets `LIVE_TUNABLES.CHAIN_MAX_ATTEMPTS` (3) attempts,
  a rejected verdict counting as a failure. On abandonment only that request's own queued beats
  are dropped (`LiveDirector.abandonRequest(requestId)`, via the `requestId` the server sets on
  follow-up beats; director-originated rest beats have none). A request queued behind the failed
  one starts immediately; `chainTail`/anchor stay where the last successful step left them.
- **Idempotent completion.** `clipCompleted` ignores a repeat delivery of a `clipId` it has
  already committed, so follow-ups, transcript and retries are never double-applied.
- **`world`** is dialogue memory only: it is read by `writeReply`/`writeCheckIn` and never enters
  the video prompt, wardrobe or body, so an approved clip adopting `nextWorld` cannot change
  physical canon.

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
  small-talk, fallback); the first match wins, the fallback never changes state. A request is
  split into ordered clauses (`then` / `and then` / `after that` / `next` / `,`, and a bare `and`
  only when both halves independently match an act) and each clause is negation-checked before
  being resolved, so "take your top off then shake your ass" chains two beats and "don't take
  your top off" locks against undressing instead of matching the strip verb.
- Chat-first typing lead is estimated from the fan's own request length at plan time (before the
  reply LLM has run), since render must start immediately in parallel with reply generation. The
  final `ClipResult.reply.typingLeadSec` is recomputed from the actual reply text once it lands,
  clamped to the clip's already-committed duration. The typed-reply clip folds the first resolved
  beat into itself — typing for the lead, then that beat's action for the rest of a 15s clip — so
  a chat reply never costs two clips just to fit the typing lead in front of the act. The clip
  stays typing-only (the beat becomes a follow-up instead) only when the first beat holds the pose
  with nothing to fold in (small talk) or is a fetch, since fetch-then-use must stay two clips.
- `correctFrameIdentityDrift` (in `src/lib/fal/requestFrameIdentityCorrection.ts`) now takes a
  `prompt` override so `frameGuard.repairFrame` can reuse the same nano-banana edit endpoint with
  an issue-specific instruction instead of the generic drift-correction prompt.
- Timing rule: `reply`, `beat`, `settle`, `redress`, `checkIn`, and `greeting` clips run
  `ACTION_CLIP_SEC` (11s — must stay above `IDLE_CLIP_SEC`'s 10s, both already at the fal floor,
  since `planReply` tells a hold-only beat from a real one by comparing the two); only `idle` stays
  at `IDLE_CLIP_SEC`. Every non-loop job now runs `guardFrame` (cheap, mid-chain included, so drift
  is caught beat-by-beat instead of compounding silently), but `repairFrame` (the slow pixel-edit
  step) only runs for the clip that ends the chain (`settle`/`redress`/`checkIn`/`greeting`) —
  `reply`/`beat` skip it so a flagged mid-chain beat doesn't hold up the next beat that's already
  queued behind it. Drift is bounded to one chain's length, not eliminated mid-chain.
- `vitest.config.ts` declares the `@/` alias (vitest does not read `tsconfig.json` paths on its
  own) and stubs the env vars `@/env` requires, so server modules can be unit tested without a
  real `.env`.
- Env vars needed at runtime: `FAL_KEY`, `GROQ_API_KEY` (both already required by `@/env`).
