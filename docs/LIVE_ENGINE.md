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
   against it before it becomes the next seed, and rejected if it drifted. Nothing appears,
   disappears, or changes unless a job transitions the state.
3. **Requests drive the scene, idle never does.** Idle clips hold the current state with small
   grounded life (breathing, blinking, small shifts, glancing at the chat). Only `reply` /
   `beat` jobs may change `LiveState`.
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
│  - redress / settle timers   │                  │ extractMidFrameUrl / extractLastFrame │
│ ClipPipeline (1-ahead chain) │ ◄─────────────── │ guardFrame(frame, expected, anchor)   │
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

Generation is slower than playback (render ~10s, frame extract ~3s, guard ~2s), so a strict
one-in-flight chain cannot hold a buffer. The chain therefore has two modes:

- **Anchored idle.** An idle clip is rendered with `image_url` = `end_image_url` = the current
  anchor frame, so it starts and ends on the same frame (`ClipResult.loops = true`,
  `seedFrameUrl` = the anchor). Idle clips are interchangeable: the client keeps
  `IDLE_BUFFER_TARGET` ready and up to `IDLE_MAX_INFLIGHT` rendering in parallel, all from one
  anchor (swap mode uses `SWAP_IDLE_BUFFER_TARGET` / `SWAP_IDLE_MAX_INFLIGHT`, two each, because a
  swapped filler takes longer to make than it plays). Each idle job carries a `durationSec` sized
  from the slowest of the last three idle productions plus `IDLE_HEADROOM_SEC`, clamped to
  `IDLE_CLIP_SEC`..`MAX_CLIP_SEC`, so the next filler is ready before the current one ends. In-flight
  idles are tracked per seed, so up to `SWAP_IDLE_MAX_INFLIGHT` (one more than the target) lets a
  bridge idle for a fresh chain tail start while old-anchor idles are still rendering. A rejected anchor frame is never adopted; the anchor only ever advances from an
  approved clip.
- **Staged seed.** With `STAGE_SEED` on, the reference step also renders one in-scene still
  (Seedream v4 edit: the upload's persona in the selected room, canon lingerie, eye-level medium shot;
  any "webcam" or "laptop camera" wording in the prompt drew her on a laptop screen instead,
  13 to 20 s, $0.03) alongside the look capture, and that still is the session seed; the upload
  stays the identity reference. The greeting then loops on it like an idle (plain
  `ACTION_CLIP_SEC`, never stretched), so the idles pre-stocked from it play straight after and
  the intro neither morphs from the photo nor holds. If staging fails or is refused, the seed is
  the upload, the greeting chains forward and nothing is pre-stocked (looping on the raw photo was
  tried and popped every clip). Swap mode never pre-stocks at the join: the looping greeting covers
  the gap and fillers swapping alongside it doubled the join time. Staging takes 17 to 35 s on every
  editor measured (Seedream v4 17 to 34 s, Seedream 4.5 75 s, Qwen edit plus 39 s, FLUX.2 edit 16 s;
  the requested size is ignored and the seed size does not change the render time), so it cannot fit
  a 15 s join. The fast editors are not an option for this still: FLUX.2 klein 4b/9b and FLUX.2
  turbo edit refuse the lingerie prompt (or the reference photo) with a content-policy 422, and
  nano-banana lite/2 return no image; refusals are logged, never reworded or retried. A ~5 s stager
  means self-hosting an edit model (e.g. Qwen-Image-Edit Lightning) on the swap GPU. The setup screen therefore runs it (`session.prepare`) as soon as a photo and scene are
  picked, shows the staged still in the preview when it lands, and holds "Go live" until it has
  settled; the connect itself is then the greeting render plus its swap. In the product this is a
  one-time persona setup, not a per-call cost.
- **Chained action.** `greeting` (off a raw upload), `reply`, `beat` and `checkIn` are
  seeded from the frame currently on the anchor and chain frame to frame. Their last frame
  (guarded against both canon and the identity anchor) becomes the new anchor. When the anchor
  changes, buffered idle loops from the old anchor are discarded and new ones are rendered from
  the new anchor immediately.
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
- The stream is shown as live once `PRIME_CLIPS` clips are ready after the greeting. Requests are
  accepted from the moment the pipeline starts; one sent during the intro queues behind the
  greeting and she is shown typing as soon as the greeting is on screen.
- **Boundary fallback.** The player warms each preloaded clip with a muted play and pause so the
  boundary play presents within a frame, then swaps `SWAP_LEAD_SEC` (0.12 s) before the current one
  ends. The lead stays short on purpose: an anchored idle only settles back onto its anchor in its
  last half second, and a 0.5 s lead cut that off, so every boundary read as a camera jump. If a
  one-shot clip reaches that point with nothing seeded from its tail ready, the player
  asks the pipeline for `nextFallbackClip()`: an idle of the same look from an earlier anchor,
  played as a cut. A cut beats a frozen frame; it is logged (`boundaryFallback`) so it can be
  counted.
- The reference backend has no end-frame parameter, so idle loops are not available on it; it
  falls back to a strict one-in-flight chain and is marked experimental in the UI.

## Request latency policy

1. Immediately: the reply job is submitted from the current anchor, and the fan sees
   "typing…" in chat. The reply text lands at `typingLeadSec` into the reply clip.
2. Idle loops already buffered keep playing until the reply clip is ready; then it plays at the
   next boundary. Idle renders in flight for the old anchor are left to finish and discarded
   (cost logged) once the anchor changes.
3. Follow-up beats chain after the reply. The last beat's last frame is the new anchor; she
   stays wherever the request left her (a `rest` beat is scheduled only after
   `REST_AFTER_IDLE_MS` of inactivity, and only puts down a prop / frees her hands).

## Wardrobe and props

- `Wardrobe` is a per-garment record (`top`, `bottom`, `bra`, `panties`, each `on | off`, plus a
  description string captured at greeting from the reference photo). Strip and redress move one
  garment at a time. The prompt names the exact garment as described.
- Canon: she always starts a session in a white bra and white panties, fixed regardless of what
  the capture prompt returns for the reference photo (`src/app/api/live/reference/route.ts`
  hardcodes `DEFAULT_WARDROBE`'s bra/panties colour; capture only ever reads lookLock/surroundings/
  framing). The video prompt's wardrobe line always names the colour, and the wardrobe-lock line on
  a non-wardrobe clip states the worn bra/panties stay white and unchanged.
- Nothing is ever put back on automatically; only a fan request (or a garment correction) adds a
  garment.
- Removal/dress clips run the full `MAX_CLIP_SEC` (15s), staged as mechanically explicit,
  time-boxed steps (clasp/straps for a bra, waistband/steps for panties or bottoms, etc.) ending in
  ~2s of stillness, plus a fabric-physics line — never a same-motion "rip it off".
- A facing change is always described as part of settling into the new pose or act (e.g. "turning
  as she settles"), never as a standalone spin/turn; `doggy` and ass-spread apply the same rule via
  an in-clip lead-in instead of a separate pose beat.
- An unrecognized but plainly physical request (`RE_GENERIC_ACTION`) is performed near-verbatim
  (the `verbatim` act) instead of falling back to a friendly acknowledgement hold.
- Props: `none | fetching | <toyId>`. A toy is fetched on camera (one clip) before it is used.
  If an unrelated request arrives while she holds it, she sets it down inside that request's own
  clip (a lead-in), never in a separate clip.

## Frame guard

> **Off by default** (`LIVE_TUNABLES.VERIFY_FRAMES: false`). In production the Groq vision model
> was 404ing / refusing, every unchecked frame on a fail-closed path rejected the clip, and each
> rejection cost a full re-render, so the first clip took 60-90s instead of ~12s. With the guard off
> a clip is never rejected or reconciled: canon is the plan, and only the last frame is extracted as
> the next seed (an extraction failure still rejects, because the chain would have no seed). Flip the
> tunable to `true` to restore everything below once a vision model is validated against real frames.

`guardFrame({ frameUrl, expected, anchorFrameUrl })` sends the vision model two images — the
session's untouched `anchorFrameUrl` first, the frame under check second — with a prompt asking for
`{ top, bottom, bra, panties, visibleProps[], pose, extraPeople, extraLimbs, sameWoman }`, validated
with a zod schema; an unparseable or schema-invalid response comes back `checked: false`, never
adopted. Each garment reports presence as `"present" | "absent" | "unknown"` (never guessed) plus a
`color` that is either a lowercase basic colour word or `"unknown"` (also never omitted). `sameWoman`
is `"yes" | "no" | "unknown"`, judged on face/hair/skin/build only — clothing, pose, nudity and
camera angle are explicitly excluded from that judgement.

Every `ClipResult` carries a `verdict: "approved" | "rejected"` and `rejectReason`. Canon is truth
for the seed frame: any checked frame showing a garment that disagrees with canon in **either**
direction — worn-but-should-be-off, or off-but-should-be-on — rejects the clip, not just the
worn-but-should-be-off case, and so does a colour mismatch on any present garment. The one
exception is a wardrobe clip's own target garment, which is exempt from both presence and colour
rejection and instead adopted from observation both ways (`reconcileState.ts`), so `director.ts`'s
bounded retry can re-attempt an unmet removal/add. Observed `"unknown"` (presence or colour) never
counts as a mismatch. `sameWoman === "no"` rejects with "identity drift" in every path, including
the fail-open one — identity is never allowed to fail open. `evaluateFrameChecks` in
`generateClip.ts` is the single place the presence/colour/identity rules live, for all four clip
kinds:

| Clip kind                                                     | Frames checked  | Unchecked frame                  | Checked-frame rejection                                                                                                                           |
| ------------------------------------------------------------- | --------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Idle                                                          | midpoint only   | rejects (fail closed)            | garment/colour mismatch, identity drift, extraPeople/extraLimbs                                                                                   |
| Hold (`wardrobeIntent === null && !explicit`)                 | midpoint + last | rejects (fail closed)            | garment/colour mismatch, identity drift, extraPeople/extraLimbs                                                                                   |
| Explicit non-wardrobe (`wardrobeIntent === null && explicit`) | midpoint + last | skips with a warning (fail open) | garment/colour mismatch, identity drift, extraPeople/extraLimbs on a checked frame                                                                |
| Wardrobe (`wardrobeIntent` `"remove"`\|`"add"`)               | midpoint + last | rejects (fail closed)            | any NON-target garment/colour mismatch, identity drift, extraPeople/extraLimbs; target garment reading `"unknown"` on the last frame also rejects |

The one remaining fail-open path (explicit non-wardrobe) exists so a persistent vision refusal
can't permanently block a legitimately requested clip; wardrobe clips no longer fail open, since an
unchecked garment swap is the case most worth blocking on. An approved clip reconciles pose
unconditionally; wardrobe is only ever reconciled for a wardrobe clip's own target garment (never
for a hold or explicit non-wardrobe clip, since there canon already matches or the clip was
rejected). A rejected clip adopts nothing — its state stays `plan.expectedState` untouched.
`buildPrompt` also adds a short "clothing stays exactly as described" line (naming the worn
bra/panties as staying white) to any clip whose action doesn't already carry an equivalent lock and
whose planned wardrobe doesn't change, as a second line of defense against the model changing
wardrobe when it wasn't asked to.

Frame repair (`repairFrame`, `src/lib/fal/requestFrameIdentityCorrection.ts`) was deleted with this
pass, along with periodic blind identity correction; a failing or identity-drifted clip is rejected
and retried as a whole clip instead of pixel-patched, with identity instead verified per checked
frame against `anchorFrameUrl` as described above. The reference photo itself is never fed into
video generation (`renderClip.ts`) — only into the vision guard's identity comparison.

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
- A `reply`/`beat` prompt leads with the requested action and a one-line "only this action, no
  turning, no walking off, no clothing change unless it's the wardrobe beat" constraint, ahead of
  the camera/anatomy/look locks (`buildPrompt`'s `leadWithAction`); greeting/idle/checkIn keep the
  locks-first order since they aren't a fan-requested action.
- **One clip per request, always.** A fan request performs entirely in the clip it's given, from
  whatever state she's currently in — there is no separate transition/precondition clip.
  `planBeatIntent` instead prepends a short in-clip lead-in sentence (setting a held prop down,
  sitting up from lying/onAllFours/bentOver/kneeling before a panties/bottom change, or rising to
  her feet before spin/dance/twerk) and re-times the rest of that beat's choreography to still fit
  `ACTION_CLIP_SEC`, rather than queuing the precondition as its own beat.
- Chat-first typing lead is estimated from the fan's own request length at plan time (before the
  reply LLM has run), since render must start immediately in parallel with reply generation. The
  final `ClipResult.reply.typingLeadSec` is recomputed from the actual reply text once it lands,
  clamped to the clip's already-committed duration. The typed-reply clip folds the first resolved
  beat into itself — typing for the lead, then that beat's action for the rest of a 15s clip — so
  a chat reply never costs two clips just to fit the typing lead in front of the act. The clip
  stays typing-only (the beat becomes a follow-up instead) only when the first beat holds the pose
  with nothing to fold in (small talk) or is a fetch, since fetch-then-use must stay two clips.
- `requestFrameIdentityCorrection.ts` and `frameGuard.repairFrame` are deleted; a drifted or
  otherwise failing frame is rejected and the whole clip re-rendered, not pixel-patched.
- Timing rule: `reply`, `beat`, `checkIn`, and `greeting` clips run `ACTION_CLIP_SEC` (11s — must
  stay above `IDLE_CLIP_SEC`'s 10s, both already at the fal floor, since `planReply` tells a
  hold-only beat from a real one by comparing the two); only `idle` starts at `IDLE_CLIP_SEC` and grows with measured production time. In swap mode every
  chain clip is stretched to `SWAP_ACTION_CLIP_SEC` (15s) with a hold appended to the prompt, because
  the next clip seeds from this one's last frame and takes 10 to 17s to make; a greeting that loops
  on a staged seed is exempt. Every
  clip is frame-verified before it can play or seed the next one (see "Frame guard"), so drift is
  caught clip by clip rather than compounding.
- `vitest.config.ts` declares the `@/` alias (vitest does not read `tsconfig.json` paths on its
  own) and stubs the env vars `@/env` requires, so server modules can be unit tested without a
  real `.env`.
- Env vars needed at runtime: `FAL_KEY`, `GROQ_API_KEY` (both already required by `@/env`).
