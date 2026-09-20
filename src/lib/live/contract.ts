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

export const wardrobeSchema = z.object({
  top: garmentStateSchema,
  bottom: garmentStateSchema,
  bra: garmentStateSchema,
  panties: garmentStateSchema,
  // Removal order, most recent last. Redress reverses it.
  removedOrder: z.array(z.enum(["top", "bottom", "bra", "panties"])).max(4),
});
export type Wardrobe = z.infer<typeof wardrobeSchema>;
export type GarmentId = keyof Omit<Wardrobe, "removedOrder">;

export const poseSchema = z.enum([
  "sitting",
  "standing",
  "leaning",
  "kneeling",
  "lying",
  "onAllFours",
]);
export type Pose = z.infer<typeof poseSchema>;

export const propSchema = z.enum([
  "none",
  "fetching",
  "vibrator",
  "dildo",
  "drink",
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
  role: z.enum(["fan", "creator"]),
  channel: inputChannelSchema,
  text: z.string().max(2000),
  atSec: z.number().min(0),
  paid: z.boolean().optional(),
});
export type TranscriptEntry = z.infer<typeof transcriptEntrySchema>;

// Jobs

export const plannedBeatSchema = z.object({
  id: z.string().min(1),
  // Grounded physical direction for one clip.
  physical: z.string().min(1).max(1200),
  durationSec: z.number().int().min(10).max(15),
  // State after this beat completes.
  nextState: liveStateSchema.pick({ wardrobe: true, body: true }),
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
  }),
  z.object({ kind: z.literal("beat"), beat: plannedBeatSchema }),
  z.object({ kind: z.literal("settle") }),
  z.object({
    kind: z.literal("redress"),
    garment: z.enum(["top", "bottom", "bra", "panties"]),
  }),
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
  // Last frame of the previous clip (guarded and repaired). The reference photo for greeting.
  seedFrameUrl: z.url(),
  // Untouched upload. Identity anchor for drift correction and repair.
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

export const clipResultSchema = z.object({
  clipId: z.string().min(1),
  jobKind: z.enum([
    "greeting",
    "idle",
    "checkIn",
    "reply",
    "beat",
    "settle",
    "redress",
  ]),
  videoUrl: z.url(),
  durationSec: z.number().int().min(10).max(15),
  // Guarded, repaired last frame. The client MUST use this as the next seed.
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
  // Further beats to run in order after this clip (only from reply / checkIn jobs).
  followUps: z.array(plannedBeatSchema).max(6),
  guard: frameGuardReportSchema,
  timings: z.object({
    planMs: z.number().int().min(0),
    renderMs: z.number().int().min(0),
    frameMs: z.number().int().min(0),
    guardMs: z.number().int().min(0),
    repairMs: z.number().int().min(0),
  }),
  costUsd: z.number().min(0),
});
export type ClipResult = z.infer<typeof clipResultSchema>;

// Tunables shared by both halves

export const LIVE_TUNABLES = {
  MIN_CLIP_SEC: 10,
  MAX_CLIP_SEC: 15,
  IDLE_CLIP_SEC: 10,
  // Idle loops to keep rendered ahead, and how many idle renders may run at once.
  IDLE_BUFFER_TARGET: 2,
  IDLE_MAX_INFLIGHT: 2,
  // Clips to have ready before the stream is shown as live.
  PRIME_CLIPS: 1,
  // Swap to the next clip this far before the current one ends, to hide the decode gap.
  SWAP_LEAD_SEC: 0.12,
  ABANDON_INFLIGHT_MS: 3_000,
  REDRESS_AFTER_IDLE_MS: 120_000,
  CHECK_IN_AFTER_IDLE_MS: 90_000,
  IDENTITY_ANCHOR_EVERY_SEC: 45,
  TRANSCRIPT_WINDOW: 40,
} as const;
