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
});
export type PlannedBeat = z.infer<typeof plannedBeatSchema>;

export const clipJobSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("greeting") }),
  z.object({ kind: z.literal("idle") }),
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

export const renderBackendSchema = z.enum(["turbo", "reference"]);
export type RenderBackend = z.infer<typeof renderBackendSchema>;

export const speechModeSchema = z.enum(["text", "native"]);
export type SpeechMode = z.infer<typeof speechModeSchema>;

// Request / response

export const liveSessionSnapshotSchema = z.object({
  creator: creatorProfileSchema,
  state: liveStateSchema,
  // Last frame of the previous clip (guarded). The reference photo for greeting.
  seedFrameUrl: z.url(),
  // Untouched upload. Identity anchor the guard compares every checked frame against.
  anchorFrameUrl: z.url(),
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
});
export type ClipResult = z.infer<typeof clipResultSchema>;

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
  // A chain job (reply/beat) gets 3 attempts total; idle stays at 2 (1 retry).
  CHAIN_MAX_ATTEMPTS: 3,
  // Clips to have ready before the stream is shown as live.
  PRIME_CLIPS: 1,
  // Swap to the next clip this far before the current one ends, to hide the decode gap.
  SWAP_LEAD_SEC: 0.12,
  ABANDON_INFLIGHT_MS: 3_000,
  REST_AFTER_IDLE_MS: 20_000,
  CHECK_IN_AFTER_IDLE_MS: 90_000,
  // Below this gap since the last activity, a reply is treated as part of a fast back-and-forth and skips the typing lead-in; at or above it, she was genuinely idling and opens on typing.
  TYPING_LEAD_AFTER_IDLE_MS: 8_000,
  // How often the seed a chain job leaves behind gets upscaled in the background (see upscaleChainTailInBackground). Per-clip was too frequent: it competed with actual render calls for fal capacity and slowed clip turnaround.
  UPSCALE_INTERVAL_MS: 60_000,
  TRANSCRIPT_WINDOW: 40,
  // Spend cap: every session auto-ends here regardless of activity.
  MAX_SESSION_MS: 180_000,
  // Cumulative render spend cap: the pipeline stops dispatching new jobs once reached.
  SESSION_COST_CAP_USD: 8,
} as const;
