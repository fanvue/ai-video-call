// Shared contract between the client pipeline and the server engine. See docs/LIVE_ENGINE.md.
// Both halves import from here; neither may depend on the other's internals.

import { z } from "zod";

// Scene and creator

export const sceneIdSchema = z.enum([
  "bedroom",
  "office",
  "livingRoom",
  "kitchen",
]);
export type SceneId = z.infer<typeof sceneIdSchema>;

export const tipMenuItemSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).max(60),
  request: z.string().min(1).max(200),
  priceCents: z.number().int().min(0),
});
export type TipMenuItem = z.infer<typeof tipMenuItemSchema>;

export const creatorProfileSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1).max(40),
  // Free-text look lock captured from the reference photo (hair, skin, build). Never a real
  // person's identifying data; describes the rendered persona only.
  lookLock: z.string().max(600),
  sceneId: sceneIdSchema,
  tipMenu: z.array(tipMenuItemSchema).max(24),
});
export type CreatorProfile = z.infer<typeof creatorProfileSchema>;

// Live state (single source of truth)

export const garmentStateSchema = z.object({
  on: z.boolean(),
  // Exact description as seen in the reference frame ("black ribbed tank top"). Prompts name it.
  description: z.string().max(80),
});
export type GarmentState = z.infer<typeof garmentStateSchema>;

export const garmentIdSchema = z.enum(["top", "bottom", "bra", "panties"]);
export type GarmentId = z.infer<typeof garmentIdSchema>;

export const wardrobeSchema = z.object({
  top: garmentStateSchema,
  bottom: garmentStateSchema,
  bra: garmentStateSchema,
  panties: garmentStateSchema,
  // Removal order, most recent last. Putting garments back on reverses it.
  removedOrder: z.array(garmentIdSchema).max(4),
});
export type Wardrobe = z.infer<typeof wardrobeSchema>;

export const poseSchema = z.enum([
  "sitting",
  "standing",
  "leaning",
  "kneeling",
  "lying",
  "onAllFours",
  "bentOver",
]);
export type Pose = z.infer<typeof poseSchema>;

export const propSchema = z.enum([
  "none",
  "fetching",
  "vibrator",
  "dildo",
  "drink",
  "phone",
]);
export type Prop = z.infer<typeof propSchema>;

export const bodySchema = z.object({
  pose: poseSchema,
  facing: z.enum(["camera", "away", "side"]),
  hands: z.enum(["free", "typing", "onBody", "holdingProp"]),
  contact: z.enum(["none", "self"]),
  prop: propSchema,
  framing: z.enum(["wider", "medium", "torso"]),
});
export type Body = z.infer<typeof bodySchema>;

export const liveStateSchema = z.object({
  wardrobe: wardrobeSchema,
  body: bodySchema,
  // Baseline she settles back to after a request is satisfied (pose only; wardrobe is separate).
  baselineBody: bodySchema,
  // Short grounded description of the room and ambient life, carried clip to clip.
  world: z.string().max(420),
  // Fixed description of the place. Never changes during a session.
  surroundings: z.string().max(1000),
});
export type LiveState = z.infer<typeof liveStateSchema>;

// Which garments are on plus the whole body: two clips in the same key look the same, so one clean frame can stand for both.
export const stateFrameKey = (
  state: Pick<LiveState, "wardrobe" | "body">,
): string => {
  const { top, bottom, bra, panties } = state.wardrobe;
  const { pose, facing, hands, contact, prop, framing } = state.body;
  return [
    top.on,
    bottom.on,
    bra.on,
    panties.on,
    pose,
    facing,
    hands,
    contact,
    prop,
    framing,
  ].join("|");
};

// Transcript

export const inputChannelSchema = z.enum(["chat", "voice"]);
export type InputChannel = z.infer<typeof inputChannelSchema>;

export const transcriptEntrySchema = z.object({
  id: z.string().min(1),
  // "viewer" is another member of the room; the server treats their requests like a fan's.
  role: z.enum(["fan", "viewer", "creator"]),
  // Display handle for viewers; the fan and creator names come from the profile and session.
  handle: z.string().max(24).optional(),
  channel: inputChannelSchema,
  text: z.string().max(2000),
  atSec: z.number().min(0),
  paid: z.boolean().optional(),
  tipCents: z.number().int().min(0).optional(),
});
export type TranscriptEntry = z.infer<typeof transcriptEntrySchema>;

// Jobs

// A beat says WHAT to do; planBeat/planBeatIntent decide HOW when it actually runs.
export const beatIntentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("removeGarment"), garment: garmentIdSchema }),
  z.object({ type: z.literal("addGarment"), garment: garmentIdSchema }),
  z.object({
    type: z.literal("pose"),
    pose: poseSchema,
    facing: bodySchema.shape.facing,
  }),
  z.object({ type: z.literal("framing"), framing: bodySchema.shape.framing }),
  // Only these three are fetchable props; a drink/phone-only prop never gets used in an act.
  z.object({
    type: z.literal("fetchProp"),
    prop: z.enum(["vibrator", "dildo", "drink"]),
  }),
  z.object({
    type: z.literal("useProp"),
    mode: z.enum(["mouth", "external"]),
  }),
  // Puts a held object down and takes hands off her body.
  z.object({ type: z.literal("rest") }),
  z.object({ type: z.literal("touch") }),
  z.object({
    type: z.literal("act"),
    act: z.enum([
      "twerk",
      "grind",
      "bounce",
      "spread",
      "sway",
      "crawl",
      "spin",
      "gesture",
      "tongue",
      "tease",
      "dance",
      "doggy",
      "spank",
      "boobPlay",
    ]),
    detail: z.string().max(200).optional(),
  }),
  // Small talk, negation, "already off/already dressed" — a spoken/held line, not a physical change.
  z.object({ type: z.literal("hold"), line: z.string().min(1).max(300) }),
  // An unrecognized but plainly physical request, played through near-verbatim.
  z.object({ type: z.literal("verbatim"), text: z.string().min(1).max(300) }),
]);
export type BeatIntent = z.infer<typeof beatIntentSchema>;

export const plannedBeatSchema = z.object({
  id: z.string().min(1),
  intent: beatIntentSchema,
  // Bounded retry: 0 is the first attempt, 1 is the one allowed re-attempt. Never more.
  attempt: z.number().int().min(0).max(1),
  // The fan/viewer request this beat follows up on; undefined for director-originated beats.
  requestId: z.string().optional(),
  // A pose/framing/prop/greeting step ahead of the request's real action; the reply text waits for the action clip.
  setupOnly: z.boolean().optional(),
});
export type PlannedBeat = z.infer<typeof plannedBeatSchema>;

export const clipJobSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("greeting") }),
  z.object({
    kind: z.literal("idle"),
    // Set by the pipeline from measured idle production time so a filler plays at least as long as the next one takes to make.
    durationSec: z.number().int().min(10).max(15).optional(),
    // Deck position: each idle made from one pose gets its own small action, so replaying the deck does not read as one clip on repeat.
    variant: z.number().int().min(0).max(50).optional(),
  }),
  z.object({ kind: z.literal("checkIn"), channel: inputChannelSchema }),
  z.object({
    kind: z.literal("reply"),
    requestId: z.string().min(1),
    text: z.string().min(1).max(2000),
    channel: inputChannelSchema,
    paid: z.boolean().optional(),
    // Who asked: the fan on this device, or another viewer in the room.
    from: z.enum(["fan", "viewer"]).default("fan"),
    handle: z.string().max(24).optional(),
    // True when this reply follows a genuine idle stretch, not a rapid back-to-back request —
    // gates the typing lead-in so she isn't shown "typing" before every message in a fast exchange.
    precededByIdle: z.boolean().default(false),
  }),
  z.object({ kind: z.literal("beat"), beat: plannedBeatSchema }),
]);
export type ClipJob = z.infer<typeof clipJobSchema>;
export type ClipJobKind = ClipJob["kind"];

// "director" and "lucy" are live WebRTC streams, not clip-render backends; see directorStream.ts / lucyStream.ts.
// "swap" is our self-hosted per-clip identity swap over the turbo pipeline's output; see server/swapClip.ts.
// "longlive" is one uncut stream generated live on our own Modal GPU; see longliveStream.ts.
export const renderBackendSchema = z.enum([
  "turbo",
  "reference",
  "director",
  "lucy",
  "swap",
  "longlive",
]);
export type RenderBackend = z.infer<typeof renderBackendSchema>;

export const speechModeSchema = z.enum(["text", "native"]);
export type SpeechMode = z.infer<typeof speechModeSchema>;

// How a reply's text becomes actions: the regex catalogue, an LLM only when the catalogue found no action, or an LLM for every request.
export const intentParserSchema = z.enum(["regex", "hybrid", "llm"]);
export type IntentParser = z.infer<typeof intentParserSchema>;
export const INTENT_PARSER_LABELS: Record<IntentParser, string> = {
  regex: "Regex catalogue (fastest)",
  hybrid: "Hybrid (LLM when the catalogue finds no action)",
  llm: "LLM reads every request",
};

// LongLive persona face lock: the id names an allowlisted synthetic persona in the server's manifest, never an image.
export const personaIdSchema = z.string().regex(/^[a-z0-9-]{1,64}$/);
export const DEFAULT_PERSONA_ID = "synth-persona-01";
export const personaOptionSchema = z.object({
  id: personaIdSchema,
  note: z.string().max(200),
  // Old manifest entries predate this field; defaults to "" so the picker falls back to the id.
  name: z.string().max(40).default(""),
  addedAt: z.string().max(64).default(""),
});
export type PersonaOption = z.infer<typeof personaOptionSchema>;

// Swap-mode test profiles picked under Advanced, so a trial config sits beside the default instead of replacing it. swapModel is the Modal service's model name.
export const swapProfileSchema = z.enum(["default", "hyperswap_1c", "ghost_1"]);
export type SwapProfile = z.infer<typeof swapProfileSchema>;
export const SWAP_PROFILES: Record<
  SwapProfile,
  { label: string; swapModel: string }
> = {
  default: { label: "Default (inswapper fp16)", swapModel: "inswapper_fp16" },
  hyperswap_1c: {
    label: "HyperSwap 1c (sharper, weaker likeness)",
    swapModel: "hyperswap_1c",
  },
  ghost_1: { label: "GHOST 1 (Apache-2.0 licence)", swapModel: "ghost_1" },
};
// Undefined for the default profile so the service's own default model governs.
export const swapModelFor = (profile?: SwapProfile): string | undefined =>
  profile && profile !== "default"
    ? SWAP_PROFILES[profile].swapModel
    : undefined;

// Face lock under Advanced: on, swap requests carry LongLive's persona recipe (kept eyes/mouth, GFPGAN 1.4 restore) instead of the default legacy pass, at about 3x the swap GPU time.
export const swapRecipeSchema = z.enum(["legacy", "longlive"]);
export type SwapRecipe = z.infer<typeof swapRecipeSchema>;
// Undefined when off so the service's own default recipe (legacy) governs.
export const swapRecipeFor = (faceLock?: boolean): SwapRecipe | undefined =>
  faceLock ? "longlive" : undefined;

// Request / response

export const liveSessionSnapshotSchema = z.object({
  creator: creatorProfileSchema,
  state: liveStateSchema,
  // Last frame of the previous clip (guarded). The reference photo for greeting.
  seedFrameUrl: z.url(),
  // Untouched upload. Identity anchor the guard compares every checked frame against.
  anchorFrameUrl: z.url(),
  // Head-only crop of the upload: the identity image for reference-to-video chain clips, which copied the full photo's room and clothes into the scene.
  identityFrameUrl: z.url().optional(),
  // The session's first rendered frame (the greeting's tail): every later chain seed has its tone pulled back toward it, so the contrast and colour drift of chained renders stops compounding.
  toneFrameUrl: z.url().optional(),
  // First seed seen in each stateFrameKey. A chain clip that lands in a banked state ends on that frame and seeds from it, so chaining drifts once per new state instead of once per clip.
  stateFrames: z.record(z.string().max(200), z.url()).optional(),
  elapsedSec: z
    .number()
    .int()
    .min(0)
    .max(6 * 60 * 60),
  // Most recent entries only; the server does not need the whole history.
  transcript: z.array(transcriptEntrySchema).max(40),
});
export type LiveSessionSnapshot = z.infer<typeof liveSessionSnapshotSchema>;

export const clipRequestSchema = z.object({
  session: liveSessionSnapshotSchema,
  job: clipJobSchema,
  backend: renderBackendSchema.default("turbo"),
  speechMode: speechModeSchema.default("text"),
  swapProfile: swapProfileSchema.optional(),
  // Face lock toggle under Advanced; see swapRecipeFor. Absent is the same as off.
  swapFaceLock: z.boolean().optional(),
  // Hand mask toggle under Advanced: keeps a hand in front of the face on top of the swap. Absent is the same as off.
  swapHandMask: z.boolean().optional(),
  // Swap mode's swap source, resolved against the persona manifest; absent, clips play unswapped.
  personaId: personaIdSchema.optional(),
  intentParser: intentParserSchema.optional(),
  // Gates the reference backend's dual (identity + current-frame) reference; see consumeIdentityReferenceDue.
  useIdentityReference: z.boolean().default(false),
});
export type ClipRequest = z.infer<typeof clipRequestSchema>;

export const frameGuardReportSchema = z.object({
  checked: z.boolean(),
  issues: z.array(z.string().max(200)).max(12),
  repaired: z.boolean(),
});
export type FrameGuardReport = z.infer<typeof frameGuardReportSchema>;

// What the guard saw, for the director's retry decision and the studio overlay. Props are not
// reconciled this phase (vision misses small toys), so only wardrobe and pose are reported here.
export const observedStateSchema = z.object({
  wardrobe: z.object({
    top: z.boolean().optional(),
    bottom: z.boolean().optional(),
    bra: z.boolean().optional(),
    panties: z.boolean().optional(),
  }),
  // Only ever a valid pose — the guard drops its own "unknown" sentinel before this is built.
  pose: poseSchema.optional(),
});
export type ObservedState = z.infer<typeof observedStateSchema>;

// Swap backend only: what the self-hosted swap did to this clip. "failed" means the unswapped turbo clip is playing.
export const clipSwapReportSchema = z.object({
  // "pending": the clip is still the unswapped render; the client finishes the swap before playing it (see LIVE_ENGINE.md, two-phase swap).
  status: z.enum(["swapped", "failed", "pending"]),
  swapMs: z.number().int().min(0),
  frames: z.number().int().min(0),
  framesWithFace: z.number().int().min(0),
  msPerFrame: z.number().min(0),
  // ArcFace cosine of the last frame against the reference photo, before and after the swap.
  similarityBefore: z.number().nullable(),
  similarityAfter: z.number().nullable(),
  restored: z.boolean(),
  reason: z.string().max(300).nullable(),
  // The swapped video's frame rate; a split reply's head is frames / fps long.
  fps: z.number().min(0).optional(),
});
export type ClipSwapReport = z.infer<typeof clipSwapReportSchema>;

export const clipResultSchema = z.object({
  clipId: z.string().min(1),
  jobKind: z.enum(["greeting", "idle", "checkIn", "reply", "beat"]),
  videoUrl: z.url(),
  durationSec: z.number().int().min(10).max(15),
  // Guarded last frame. The client MUST use this as the next seed.
  seedFrameUrl: z.url(),
  // True when the clip starts and ends on the request's seed frame (idle loops). Such clips are
  // interchangeable: any number may be rendered in parallel from one anchor and played in any order.
  loops: z.boolean(),
  // State after this clip. The client MUST replace its state with this.
  state: liveStateSchema,
  reply: z
    .object({
      text: z.string().max(400),
      channel: inputChannelSchema,
      // Seconds into the clip at which her typed reply should land in chat.
      typingLeadSec: z.number().min(0).max(15),
    })
    .nullable(),
  // Further beats to run in order after this clip (from reply / checkIn / beat jobs).
  followUps: z.array(plannedBeatSchema).max(6),
  // This clip only sets up the request's action (see plannedBeatSchema.setupOnly), so its reply text is held for the action clip.
  setupOnly: z.boolean().optional(),
  guard: frameGuardReportSchema,
  observed: observedStateSchema.nullable(),
  // See docs/LIVE_ENGINE.md "Frame guard" for when a hold vs. non-hold clip is rejected.
  verdict: z.enum(["approved", "rejected"]),
  rejectReason: z.string().max(300).nullable(),
  timings: z.object({
    planMs: z.number().int().min(0),
    renderMs: z.number().int().min(0),
    frameMs: z.number().int().min(0),
    guardMs: z.number().int().min(0),
    repairMs: z.number().int().min(0),
    // Hold-clip two-frame (or idle one-frame) verification time; 0 on the non-hold path.
    verifyMs: z.number().int().min(0).optional(),
  }),
  costUsd: z.number().min(0),
  swap: clipSwapReportSchema.optional(),
});
export type ClipResult = z.infer<typeof clipResultSchema>;

// /api/live/clip streams NDJSON lines ("rendered", then "result" or "error") when the request accepts this type.
export const CLIP_STREAM_CONTENT_TYPE = "application/x-ndjson";

// Tunables shared by both halves

export const LIVE_TUNABLES = {
  // Vision frame guard (garment/colour/identity checks + rejection). Off: clips are never rejected or reconciled; only the seed frame is extracted. Groq vision was refusing/404ing in prod and each rejection cost a full re-render.
  VERIFY_FRAMES: false,
  // 10s is the fal h3-max floor (docs/LIVE_ENGINE.md); below it the API rejects the render.
  MIN_CLIP_SEC: 10,
  MAX_CLIP_SEC: 15,
  IDLE_CLIP_SEC: 10,
  // Must stay above IDLE_CLIP_SEC: planReply tells a hold-only beat from a real action by comparing
  // durationSec against IDLE_CLIP_SEC, and both are already at the fal floor.
  ACTION_CLIP_SEC: 11,
  // A chain reply always preempts idle the instant it's ready, so 1 idle is enough buffer.
  IDLE_BUFFER_TARGET: 1,
  IDLE_MAX_INFLIGHT: 1,
  // Swap mode makes a filler in 13 to 17s (render 3 to 4s + swap 8 to 13s), longer than it plays, so two are built at once or the buffer runs dry by a few seconds every clip.
  SWAP_IDLE_BUFFER_TARGET: 2,
  // One more than the target so a bridge idle for a fresh chain tail can start while two old-anchor idles are still in flight.
  SWAP_IDLE_MAX_INFLIGHT: 3,
  // Looping idles kept per settled pose and replayed in shuffled order; once full, no more idles render until the pose changes. Prod rendered one every 5 to 10 s while nobody typed, most of the spend and the swap queue replies waited behind.
  IDLE_DECK_SIZE: 3,
  // Swap latency is per frame (~40 ms), so a 15 s reply cost ~5 s more to swap than an 11 s one. Bridge idles from the reply's tail start when it renders, well before it plays, so it no longer needs the extra length to cover the next clip.
  // 10 s, the fal floor: with Face lock on (longlive, 39 to 46 ms a frame in prod) the 11th second was 25 frames, about 1.1 s of every reply's wait.
  SWAP_ACTION_CLIP_SEC: 10,
  // The first idle seeds from the greeting's tail and needs render + swap (~12 s) before it can play; an 11 s greeting ended 0.4 s before that landed and prod held 3.5 s on its last frame, so the greeting runs the full clip length to cover it.
  SWAP_GREETING_CLIP_SEC: 15,
  // Two-phase swap: the server swaps only the clip's last frame (about 1.5 s) so the next chain clip renders at once, and the client swaps the full clip in parallel before playing it. Off, the render call waits for the whole swap (about 7 s) before the chain can move.
  SWAP_DEFER_CLIP: true,
  // Off: replies, beats and check-ins stay on turbo. Reference-to-video held the raw face closer (ArcFace 0.64 vs 0.50) but in prod lifted every chained clip's sharpness from about 90 to 160-210 (the harsh, gaunt look), disabled the pose bank (no end frame), and still copied image 1 into the scene about once a session, first the full upload, then the head crop as a close-up.
  SWAP_CHAIN_FROM_REFERENCE: false,
  // h3-max render resolution for every clip backend. 768P rendered in 19 s against 9 s at 480P for a raw ArcFace gain of 0.02, and costs $0.04/s against $0.025/s.
  RENDER_RESOLUTION: "480P" as "480P" | "768P" | "1080P",
  // Pose bank (see stateFrames): off falls back to chaining every clip from its own last frame.
  SWAP_STATE_FRAMES: true,
  // Bounds the snapshot; states past this chain as before.
  STATE_FRAMES_MAX: 24,
  // Next idle length = measured idle production time + this headroom, clamped to the clip bounds.
  IDLE_HEADROOM_SEC: 1,
  // A chain job (reply/beat) gets 3 attempts total; idle stays at 2 (1 retry).
  CHAIN_MAX_ATTEMPTS: 3,
  // Clips to have ready before the stream is shown as live.
  PRIME_CLIPS: 1,
  // Start the next clip playing, hidden, this far before the current one ends; it is revealed on the outgoing clip's last frame (gaplessPlayer.untilClipEnds), so this only has to cover play-start latency, which ran past a 0.12 s lead on phones and froze or wrapped the outgoing clip.
  SWAP_LEAD_SEC: 0.4,
  // Boundary swaps hold the incoming clip on frame 0 until the outgoing one is on its last frame, then play and hard-cut. Measured in Chrome: the hidden early start revealed the next clip at frame 8 after skipping the outgoing's last 2, a 10-frame jump (face ~15 px on the swapseed chain) under a 320 ms ghosting dissolve, while the render's own seam is 0.6 px.
  FRAME_EXACT_BOUNDARY: true,
  // A reply arriving while an idle loops waits for the loop boundary only when the idle wraps within this many seconds; otherwise it cuts in at once through a blur dissolve. Always waiting for the wrap cost about half an idle per request (prod: 16 to 21 s dispatch to visible, 5 to 7 s of it spent waiting on the loop).
  CUT_IN_WAIT_MAX_SEC: 0.6,
  // Just after a wrap the idle is still on the anchor pose the reply starts from, so a reply that lands moments after the boundary cuts in now instead of waiting the whole loop (prod: landed 1 s late, seen 10 s later).
  // Past 0.4 s the idle has already moved off that anchor pose.
  CUT_IN_AFTER_WRAP_SEC: 0.4,
  // The swap account has two GPUs; a third swap request queues inside Modal and stretched a reply's swap from 9 to 12 s. One slot is reserved for the chain, fillers share the rest.
  // Raised to 3: the app now runs up to 4 A10G/L4 containers, warmed at upload and held by buffer_containers, so a third swap uses a container already billed; prod (Sept 23) ran fillers through one slot and they queued 12 to 50 s. The fourth container stays free for the chain's /swapTail seed.
  SWAP_MAX_CONCURRENT: 3,
  // Chain clips still play in order (pickNext waits on the head's swap), so two may swap at once; one at a time left a beat 11 to 23 s in the queue behind its reply's 13 s swap and held playback 3.2 s (prod, Face lock on).
  SWAP_CHAIN_MAX_CONCURRENT: 2,
  // A queued filler whose anchor no longer matches the cursor, the anchor, the chain tail or a queued chain clip can never play; skipping its swap frees the slot for one that can. Prod swapped several such fillers 30 to 50 s after they rendered.
  SWAP_SKIP_STALE_IDLE_SWAPS: true,
  // Download each swapped clip as soon as it lands instead of when the player pulls it, so a clip that lands after a boundary plays about a second sooner (prod: 1.3 to 2.3 s from swap landed to on screen).
  SWAP_PREFETCH_READY_CLIPS: true,
  // Start a reply's full swap from the clip route's render stream instead of after its seed swap, taking that 2 to 4 s off the reply's wait; at most one such early swap runs, outside the pipeline's swap slots.
  SWAP_EARLY_REPLY_SWAP: true,
  // Swap a reply's first SWAP_SPLIT_HEAD_FRAMES and the rest on two containers at once, so it plays once the head lands instead of the whole clip; skipped when no second container is free.
  SWAP_SPLIT_REPLY: true,
  // About 4.2 s at 24 fps: the rest (about 140 frames at 45 ms) lands while the head plays.
  SWAP_SPLIT_HEAD_FRAMES: 100,
  // ai-video-swap's max_containers (services/swap/modal_app.py); a request past it queues inside Modal.
  SWAP_SERVICE_CONTAINERS: 4,
  // The rest's swap still out this long before the head ends: its raw frames play instead, so the boundary does not freeze.
  SWAP_SPLIT_REST_LEAD_MS: 1000,
  // Timeupdate fires about four times a second, so a deferred cut-in on a looping element needs a wider boundary window than SWAP_LEAD_SEC or the wrap slips past it.
  CUT_IN_LEAD_SEC: 0.35,
  // Stage an in-scene still (selected room, canon lingerie) from the upload before the greeting; the raw photo's clothes and room otherwise contradict the prompt and the first clip visibly morphs.
  STAGE_SEED: true,
  STAGE_SEED_BUDGET_MS: 30_000,
  // The greeting's one vision read of its rendered room. Reads that land took about 1 to 1.5 s; in the two latest prod sessions every read ran into the old 6 s budget and the join waited the full 6 s for the preset ROOM text it kept anyway.
  ROOM_CAPTURE_BUDGET_MS: 2_500,
  ABANDON_INFLIGHT_MS: 3_000,
  REST_AFTER_IDLE_MS: 20_000,
  CHECK_IN_AFTER_IDLE_MS: 90_000,
  // Below this gap since the last activity, a reply is treated as part of a fast back-and-forth and skips the typing lead-in; at or above it, she was genuinely idling and opens on typing.
  TYPING_LEAD_AFTER_IDLE_MS: 8_000,
  // How often the seed a chain job leaves behind gets upscaled in the background (see upscaleChainTailInBackground). Per-clip was too frequent: it competed with actual render calls for fal capacity and slowed clip turnaround.
  UPSCALE_INTERVAL_MS: 60_000,
  // Wall-clock trigger for the dual identity reference (see consumeIdentityReferenceDue). Moot while MAX_CHAIN_CLIPS below is 1; kept so raising that count still bounds drift in time.
  IDENTITY_REFERENCE_INTERVAL_MS: 45_000,
  // Second trigger alongside the interval, in chain clips. 1 = every chain clip carries the identity reference: production logs showed dual-reference renders no slower than single (~5s either way), and the face was visibly drifting by clip ~10 when it was periodic. See consumeIdentityReferenceDue.
  IDENTITY_REFERENCE_MAX_CHAIN_CLIPS: 1,
  TRANSCRIPT_WINDOW: 40,
  // Spend cap: every session auto-ends here regardless of activity. 5 min now that swap mode holds the face that long.
  MAX_SESSION_MS: 300_000,
  // Cumulative render spend cap: the pipeline stops dispatching new jobs once reached.
  SESSION_COST_CAP_USD: 10,
  // Director (minimax/h3-max/director) bills per second of live stream, promo rate; list price is
  // $0.08/sec. There is also a $1.20 session minimum charge regardless of duration.
  DIRECTOR_COST_PER_SEC_USD: 0.02,
  // Lucy (decart/lucy-2-5/realtime) bills per second live; no documented session minimum, unlike director.
  LUCY_COST_PER_SEC_USD: 0.02,
  // Swap runs on our own Modal L40S at $1.95/hr; charged per clip on the service's reported swap time.
  SWAP_COST_PER_SEC_USD: 1.95 / 3600,
  // LongLive holds one Modal H100 (about $4/hr) for as long as its socket is open.
  LONGLIVE_COST_PER_SEC_USD: 4 / 3600,
  // Face restore holds a second Modal L40S ($1.95/hr) beside it while on.
  LONGLIVE_FACE_RESTORE_COST_PER_SEC_USD: 1.95 / 3600,
} as const;
