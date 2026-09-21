# Continuity overhaul plan

Goal: a continuous, interactive stream where every clip is a physical continuation of the last frame,
requests queue in arrival order and complete one at a time, nothing a previous clip did is undone
unless asked, and acts (undressing, redressing, toys, pose changes) follow real body mechanics.

Scope: `src/lib/live/**` in this repo. Money/paywall stays data-model only. No changes to the model's
own safety behaviour. Adult content renders only when a request asks for it.

## 1. Root causes found in the audit

Evidence labels: CONFIRMED = reproduced with a test or read directly in the executed path.
ASSUMED = mechanism is consistent with the code and the reported symptoms but not yet measured live.

### RC1 (CONFIRMED by test) Follow-up beats lose their place in the queue

`director.clipCompleted` appends a reply's `followUps` with `queue.push` (director.ts:198-201). A fan
request that arrives while that reply is still rendering is inserted by `insertReplyIndex` into a queue
that does not yet contain those beats, so it lands at index 0. Probe test, starting in lingerie:

```
send "strip"            -> reply renders (bra beat inside it, panties beat as followUp)
send "suck the dildo"   -> arrives mid-render
reply completes         -> queue = [reply:suck the dildo, beat:panties]   (expected the reverse)
```

Result: fetch + dildo run first, then the stale panties beat runs holding a `nextState` computed before
the dildo existed (`prop: "none"`, `hands: "free"`), so the dildo teleports away and the prompt tells
her to undress while the seed frame shows her holding a toy. This is the "loop / wrong order / undoes
the last act" report.

### RC2 (CONFIRMED by code) Beats are pre-baked, not resolved at execution time

`PlannedBeat` carries final `physical` text and `nextState` (contract.ts:119-130), computed in
`planReply` against the wardrobe/body predicted at request time (planClip.ts:1603-1609). Any
interleaving (RC1) or any clip that did not do what was predicted makes every remaining beat wrong,
and there is no way to skip a beat that has become a no-op.

### RC3 (CONFIRMED by code) The state machine is open-loop

`generateClip` commits `plan.expectedState` as the new canon regardless of what the frame shows
(generateClip.ts:165-168). The guard runs on every chained clip and reports e.g. "bra should be off but
frame shows it on", but mid-chain that report is discarded: repair is skipped for reply/beat
(generateClip.ts:48, 138-141) and the observed wardrobe is never written back to state.

Consequence: the moment the video model under- or over-delivers once (leaves the bra on, or strips
fully when asked for one garment), canon and pixels diverge, and every following prompt contradicts
its own seed frame. The model resolves the contradiction on camera: garments regrow then come off
again ("strips 3 times"), or a visible garment the prompt says does not exist is redrawn as something
else ("invents clothing"). No amount of prompt wording fixes this; it is a control-loop defect.

### RC4 (ASSUMED) Prompt over-specification

Every clip prompt is ~1,800 characters of locks before the action: two CONTENT locks, GARMENT COUNT
LOCK, PHYSICS lock, WARDROBE LOCK with per-garment on/off guards, WARDROBE FREEZE, END STATE, END
STILL, and CONTINUITY on the reference backend. Absent garments are named 5-7 times per prompt ("bra
OFF", "bra stays off", "does not reappear", "no second garment"). H3 has no negative prompt; naming a
garment is a positive token for it. Each lock was added to patch a symptom and now overlaps the others.
The action itself is a single sentence buried at the end.

### RC5 (CONFIRMED by code) Compound clips

Every chat request folds a 3s typing beat plus the action into one 15s clip (planClip.ts:1547-1570),
with a phone-typing variant that overrides the PROP LOCK mid-clip. Toy requests are fetch + use. Two
distinct actions in one clip is where the model fills time by repeating or reversing the action.

### RC6 (CONFIRMED by code) Built-in undo behaviours

- `settle` returns body to `baselineBody` after every sequence whose body differs from baseline
  (director.ts:203-216). "Stand up" is followed by her sitting back down.
- `redress` re-dresses her after 120s idle (director.ts:238-250). With `MAX_SESSION_MS` = 180s it
  rarely fires, but it is an undo by design.

### RC7 (CONFIRMED by code) Mid-chain freeze

Idle stock is keyed to the current anchor (pipeline.ts:178-190, 334-357). Between beats of a chain
the display anchor is the chain tail, so no idle is playable and the player holds a still frame for
the full render latency of the next beat.

### RC8 (CONFIRMED by code) No removal mechanics

Undress beats say "she slowly takes off her bra and it leaves the frame" (planClip.ts:510-514,
590-596, 632-636). No hands, no order of motion, no pose precondition. Only `spinBeats` uses the
time-boxed choreography style that actually works (planClip.ts:1085-1092). "Removes her bra wrong" is
the model improvising the mechanics.

### Over-engineering to remove (each added to patch a symptom of RC1-RC3)

- `anchorHasBody` / `seedHasBody` threading across 6 files (my own addition; falls away with the
  prompt diet).
- `wardrobeReinforcementLine` ("WARDROBE FREEZE") and the "copy pixel-for-pixel" wording.
- `WARDROBE_COUNT_LOCK`, most of `PHYSICS_LOCK`, the long forms of both CONTENT locks.
- `endStateLine` + `END_STILL_LOCK` duplication.
- `isHoldOnly = firstBeat.durationSec === IDLE_CLIP_SEC` (planClip.ts:1558): a magic-number
  comparison standing in for an explicit flag.
- `repairFrame` for wardrobe/prop issues: pixel-editing the frame to match a prediction is the wrong
  direction once state follows the frame. Keep only for anatomy failures.
- `baselineBody` as a target she returns to. Keep only as the greeting's start pose.
- `checkIn`/`redress` idle stages: keep checkIn, drop redress.

## 2. Target design

Five rules, in priority order:

1. **State follows the frame.** After every chained clip, the guard's observation of wardrobe and prop
   is reconciled into canon. Prediction is only the fallback when the guard could not check.
2. **Beats are intents, resolved when they run.** A queued beat says _what_ ("remove bra"), and
   `planBeat` decides _how_ against the state that exists at that moment. A beat whose goal is already
   met is dropped without rendering.
3. **One physical action per clip.** Typing, fetching, undressing one garment, changing pose: each is
   its own clip or is not shown at all.
4. **Requests complete in arrival order, then she idles in the state she ended in.** A request's beats
   stay contiguous. Nothing returns her to an earlier pose or wardrobe unless a request asks. The only
   timer-driven change is putting a held object down after a long idle.
5. **Prompts state what is, briefly.** Appearance is described positively from current state (what
   she wears, what is bare); absent garments are never named; the action gets most of the prompt and
   is choreographed in time boxes.

### Contract changes

```ts
// contract.ts
type BeatIntent =
  | { type: "removeGarment"; garment: GarmentId }
  | { type: "addGarment"; garment: GarmentId }
  | { type: "pose"; pose: Pose; facing: Body["facing"] }
  | { type: "framing"; framing: Body["framing"] }
  | { type: "fetchProp"; prop: Prop }
  | { type: "useProp"; mode: "mouth" | "external" }
  | { type: "putDownProp" }
  | { type: "touch" }
  | { type: "act"; act: "twerk" | "grind" | "bounce" | "spread" | "sway" | "crawl" | "spin" | "gesture" | "tongue" | "tease"; detail?: string }
  | { type: "hold"; line: string }          // small talk, negation, "already off"
  | { type: "verbatim"; text: string };     // genericActionBeats

type PlannedBeat = { id: string; intent: BeatIntent; attempt: number };

// ClipResult gains what the guard saw, so the director can decide retries.
observed: { wardrobe?: Partial<Record<GarmentId, boolean>>; prop?: Prop | "unknown" } | null;
```

`ClipResult.state` is already reconciled server-side; `observed` is there for retry decisions and for
the studio overlay.

### Director changes

- `clipCompleted`: `queue.unshift(...followUpBeats)`; a request that arrived mid-render stays behind
  them.
- On a `beat` result whose intent is `removeGarment`/`addGarment` and `observed` shows it unmet and
  `attempt === 0`: re-queue the same intent at the front with `attempt: 1`. Never more than one retry.
- Before handing a beat to the pipeline, drop it if its intent is already satisfied by current state.
- Delete `settle` as a post-sequence job. Add a tick-driven `putDownProp` after `PUT_DOWN_AFTER_IDLE_MS`
  (proposed 20s) when `body.prop` is a held object. Delete `redress` scheduling. Keep `checkIn`.
- `baselineBody` stays in state only because the greeting reads it; nothing else does.

### Server changes

- `planReply` resolves text to `BeatIntent[]` (the existing regex catalog stays; each `*Beats`
  function returns intents instead of prose). The reply clip itself is either the first action beat
  (voice channel, or chat with typing dropped) or a short glance-and-type hold beat (chat, hold-only
  replies).
- `planBeat` is the single choreography entry point: `(intent, state) -> { physical, nextState, durationSec, explicit }`,
  with pose preconditions that insert a `pose` transition first where needed (panties/bottoms off
  need sitting or standing; bra off needs a free hand; anything from `lying` stands first).
- `generateClip`: after the guard, `reconcileState(plan.expectedState, guardReport)` becomes the
  committed state. `repairFrame` runs only for `extraPeople`/`extraLimbs`, only at chain end.
- New `buildPrompt` (see prompt spec below). Delete `wardrobeReinforcementLine`, `WARDROBE_COUNT_LOCK`,
  `CONTENT_LOCK_HOLD` long form, `endStateLine` + `END_STILL_LOCK` duplication, `seedHasBody`.

### Prompt spec (target, ~600-800 chars)

```
[frame]      Static laptop webcam, no camera motion, no cuts. One adult woman, real anatomy.
[identity]   LOOK: <lookLock>.  ROOM: <surroundings>.
[appearance] NOW: she is <pose>, <facing>, hands <hands>[, holding <prop>]. She is wearing <on garments with descriptions>; <bare regions> bare.   (or: She is completely nude.)
[action]     <time-boxed choreography, 2-4 boxes, hands named, one garment or one motion>
[end]        By <n>s she is <end appearance/pose>, still, eyes on the lens. The clip ends there.
[content]    hold clips: "Nothing sexual happens in this clip."  explicit clips: one-line permission.
[speech]     existing speechLockLine
```

Bare regions are derived: no top and no bra -> "chest bare"; no bottom and no panties -> "hips and
legs bare". Absent garments are never named.

### Choreography library (planBeat)

Per garment x start pose, time-boxed for an 11s clip, reversed for redress. Examples:

- **bra, sitting/standing**: 0-2s both hands reach behind her back, elbows out, and unhook the clasp.
  2-5s the straps slide off her shoulders one at a time and down her arms. 5-8s she brings the bra
  forward and off, sets it out of frame. 8-11s hands rest, still, chest bare.
- **panties, sitting**: 0-2s thumbs hook the waistband at her hips. 2-5s she lifts her hips off the
  chair and slides them down her thighs. 5-8s down past her knees, one foot out then the other,
  set out of frame. 8-11s she settles back, still.
- **panties, standing**: hook, bend forward, slide down, step out with each foot, straighten.
- **top, sitting/standing**: cross arms, grip the hem, pull up over her head, arms free, hair falls back.
- **bottoms, standing**: unfasten at the waist, slide down, step out. From sitting: stand first (pose beat).
- **fetch prop**: one hand reaches out of frame and returns with <prop>; other hand stays.
- **use prop, mouth**: existing policy (mouth only). **external**: existing policy.
- **pose**: weight shift, one grounded movement, settle.

Each line names which hand does what and what stays still. The pose precondition table lives next to
it so the planner inserts a transition beat rather than asking the model to do two things.

### Pipeline change (freeze fix)

Idle lane targets `chainTail ?? anchor`. Idles rendered from a chain tail become playable when that
chained clip finishes on screen, and become current-anchor stock when the chain promotes. Cost: about
one extra 10s idle per beat while a chain runs. Gate behind `LIVE_TUNABLES.BRIDGE_IDLES` so it can be
switched off for spend.

## 3. Phases

Each phase: contract first, implementation via a Cursor worker, unit tests, `tsc --noEmit`, vitest,
commit, push, then ONE live session by you against the deployed app with the fixed script in Phase 0.
Change one variable per live run.

| #   | Phase                                                                   | Files                                                                   | Tests                                                                          | Live check                                                                                                  |
| --- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| 0   | Baseline script + guard-report logging                                  | studio overlay, generateClip (log only)                                 | none                                                                           | 1 run, record guard issues per clip and video URLs                                                          |
| 1   | Director ordering + intent beats + no-op drop                           | contract, director, planClip (dispatcher), generateClip, useLiveSession | director ordering test (the probe above, as a real test), planBeat table tests | "strip" then "suck the dildo" typed 5s apart: expect bra, panties, fetch, mouth, in that order, no re-strip |
| 2   | Reconciliation + bounded retry                                          | generateClip, frameGuard (return observed), director                    | reconcile unit tests; retry-once test; guard unchecked -> prediction stands    | same script; expect at most one visible re-attempt, no regrowth                                             |
| 3   | Prompt diet                                                             | planClip buildPrompt                                                    | snapshot tests on prompt shape; absent garments not named                      | A/B vs Phase 2 on the same seed, 3 runs each                                                                |
| 4   | Choreography library + pose preconditions                               | planClip planBeat                                                       | one test per garment x pose                                                    | bra and panties removal look mechanically right; redress reverses                                           |
| 5   | Remove undo behaviours (settle, redress), add idle put-down             | director, planClip                                                      | tick tests                                                                     | "stand up" then silence: she stays standing; toy is set down after ~20s idle                                |
| 6   | Bridge idles                                                            | pipeline                                                                | pipeline tests                                                                 | no still-frame hold between beats                                                                           |
| 7   | Delete dead code (seedHasBody, reinforcement line, repair for wardrobe) | 6 files                                                                 | existing suites                                                                | none                                                                                                        |

Phases 1 and 2 are the fix for the reported bug; 3 and 4 are the realism work; 5-7 are cleanup.
Phase 3 is the only one that is a hypothesis rather than a defect fix, so it gets the A/B.

## 4. Decisions needed from you

1. **Typing on action requests.** Recommend: drop the typing animation from action clips (she glances
   at chat, then acts; the text reply still lands in chat after a short delay). Typing stays only on
   talk-only replies. Alternative: typing as its own 10s clip before every action, +1 render per
   request.
2. **Bridge idles** cost about one extra idle render per beat. On by default, or off until latency is
   measured?
3. **Retry policy** when the frame shows a removal did not happen: retry once (recommended), or accept
   and move on with no retry.

## 5. Out of scope

Money, paywall enforcement, viewer sim, gapless player internals, the reference backend's identity
behaviour, and anything touching the model's own safety checker.
