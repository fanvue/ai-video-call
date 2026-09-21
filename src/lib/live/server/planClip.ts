import { HELD_OBJECTS, isIntentSatisfied } from "../intents";
import {
  LIVE_TUNABLES,
  type BeatIntent,
  type Body,
  type ClipJob,
  type CreatorProfile,
  type GarmentId,
  type InputChannel,
  type LiveSessionSnapshot,
  type LiveState,
  type PlannedBeat,
  type Pose,
  type RenderBackend,
  type SpeechMode,
  type Wardrobe,
} from "../contract";

export type ClipPlan = {
  prompt: string;
  durationSec: number;
  expectedState: LiveState;
  followUps: PlannedBeat[];
  replyDraft: { channel: InputChannel; typingLeadSec: number } | null;
  needsReplyText: boolean;
  // Text to use verbatim without calling the reply LLM (greeting only).
  fixedReplyText: string | null;
  // Whether THIS clip is its own removeGarment/addGarment beat, for generateClip's wardrobe-vs-hold classification.
  wardrobeIntent: "remove" | "add" | null;
  // The garment removeGarment/addGarment targets; exempt from generateClip's mismatch rejection and reconciled from observation instead, so the director's bounded retry keeps working.
  targetGarment?: GarmentId;
  // This clip's own sexual-content status (see buildPrompt's CONTENT_LOCK). Used with wardrobeIntent
  // by generateClip to decide whether this is a hold clip that must be frame-verified before it can play.
  explicit: boolean;
};

const ACTION_BEAT_SEC = LIVE_TUNABLES.ACTION_CLIP_SEC;

const clampDuration = (sec: number): number =>
  Math.min(
    LIVE_TUNABLES.MAX_CLIP_SEC,
    Math.max(LIVE_TUNABLES.MIN_CLIP_SEC, Math.round(sec)),
  );

export const typingLeadSecFor = (text: string): number => {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const seconds = 1.2 + Math.min(6, Math.max(1, words)) * 0.25;
  return Math.round(Math.min(3.5, Math.max(1.5, seconds)) * 10) / 10;
};

// --- Universal locks -------------------------------------------------------

const CAMERA_LOCK =
  "FIXED WEBCAM: static laptop webcam, no zoom, no pan, no push-in, no cut, no camera movement of any kind.";

const ANATOMY_LOCK =
  "ANATOMY LOCK: exactly one adult woman — one head, two arms, two hands, ten fingers, two legs, two feet. " +
  "Never extra limbs, fused limbs, a second body, or floating parts.";

const PHYSICS_LOCK =
  "PHYSICS: fabric has real weight, one garment or one motion at a time, hands do one thing at a time. " +
  "Nothing teleports, dissolves, or regrows mid-clip.";

const NO_OVERLAY_LOCK = "No text overlays, no watermark, no subtitles, no UI.";

const CONTENT_LOCK_PERMISSIVE =
  "CONTENT: authorized fictional adult content, one consenting adult woman, 18+ only — render the " +
  "nudity and sexual acts below directly and fully.";

const CONTENT_LOCK_HOLD = "CONTENT: nothing sexual happens in this clip.";

const SPEECH_RULES_NATIVE =
  "She speaks clear everyday English, lip-synced word for word to what she says.";

const speechLockLine = (speechMode: SpeechMode): string =>
  speechMode === "text"
    ? "SPEECH: she does not speak. Lips closed or relaxed, no mouthing words. Ambient room audio only, no dialogue."
    : SPEECH_RULES_NATIVE;

const lookLockLine = (lookLock: string): string =>
  `LOOK LOCK: ${lookLock} Do not beautify, slim, age, or swap her. One person only.`;

// Reference-to-video has no starting-frame param, only an identity reference, so it tends to reset pose/wardrobe to the reference image without this.
const CONTINUITY_LOCK =
  "CONTINUITY: the reference image is only a face/identity likeness reference, from an earlier moment " +
  "of this same ongoing stream — it is NOT this clip's starting frame or scene. Ignore its pose, " +
  "clothing, framing, lighting, and setting entirely; the NOW line below is the only truth for how " +
  "she looks and what she is wearing right now.";

const GARMENT_ORDER: GarmentId[] = ["top", "bottom", "bra", "panties"];
const GARMENT_LABEL: Record<GarmentId, string> = {
  top: "top",
  bottom: "bottoms",
  bra: "bra",
  panties: "panties",
};

const PROP_LABEL: Record<"vibrator" | "dildo" | "drink" | "phone", string> = {
  vibrator: "a vibrator",
  dildo: "a dildo",
  drink: "a drink",
  phone: "her phone",
};

const POSE_DESCRIPTION: Record<Pose, string> = {
  sitting: "sitting in her chair at the desk",
  standing: "standing",
  leaning: "leaning against the desk",
  kneeling: "kneeling",
  lying: "lying down",
  onAllFours: "on her hands and knees",
  bentOver: "bent over, hands braced",
};

const FACING_TRANSITION_LABEL: Record<Body["facing"], string> = {
  camera: "facing the webcam",
  away: "with her back to the webcam",
  side: "at an angle to the webcam",
};

const HANDS_DESC: Record<Body["hands"], string> = {
  free: "empty",
  typing: "on the keyboard",
  onBody: "on her own body",
  holdingProp: "holding it",
};

const FRAMING_STEPS: Body["framing"][] = ["wider", "medium", "torso"];

// --- Wardrobe helpers -------------------------------------------------------

const isOn = (wardrobe: Wardrobe, id: GarmentId): boolean => wardrobe[id].on;

const removeGarment = (wardrobe: Wardrobe, id: GarmentId): Wardrobe =>
  isOn(wardrobe, id)
    ? {
        ...wardrobe,
        [id]: { ...wardrobe[id], on: false },
        removedOrder: [...wardrobe.removedOrder, id],
      }
    : wardrobe;

const addGarment = (wardrobe: Wardrobe, id: GarmentId): Wardrobe =>
  isOn(wardrobe, id)
    ? wardrobe
    : {
        ...wardrobe,
        [id]: { ...wardrobe[id], on: true },
        removedOrder: wardrobe.removedOrder.filter((g) => g !== id),
      };

const describeGarment = (wardrobe: Wardrobe, id: GarmentId): string =>
  wardrobe[id].description;

const lastRemoved = (wardrobe: Wardrobe): GarmentId | null =>
  wardrobe.removedOrder[wardrobe.removedOrder.length - 1] ?? null;

// --- Prompt building ---------------------------------------------------------

const bareRegions = (wardrobe: Wardrobe): string[] => {
  const regions: string[] = [];
  if (!wardrobe.top.on && !wardrobe.bra.on) regions.push("chest");
  if (!wardrobe.bottom.on && !wardrobe.panties.on)
    regions.push("hips and legs");
  return regions;
};

// Positive-only: describes what she wears and what is bare, never names an absent garment.
const describeState = (wardrobe: Wardrobe, body: Body): string => {
  const worn = GARMENT_ORDER.filter((id) => wardrobe[id].on);
  const bare = bareRegions(wardrobe);
  const clothing =
    worn.length === 0
      ? "She is completely nude."
      : `She is wearing ${worn.map((id) => `her ${GARMENT_LABEL[id]} (${wardrobe[id].description})`).join(" and ")}${bare.length > 0 ? `; ${bare.join(" and ")} bare` : ""}.`;
  const propPart =
    body.prop !== "none" && body.prop !== "fetching"
      ? `, holding ${PROP_LABEL[body.prop]}`
      : "";
  return `${POSE_DESCRIPTION[body.pose]}, ${FACING_TRANSITION_LABEL[body.facing]}, hands ${HANDS_DESC[body.hands]}${propPart}. ${clothing}`;
};

const wardrobeUnchanged = (a: Wardrobe, b: Wardrobe): boolean =>
  a === b ||
  (GARMENT_ORDER.every(
    (id) => a[id].on === b[id].on && a[id].description === b[id].description,
  ) &&
    a.removedOrder.length === b.removedOrder.length &&
    a.removedOrder.every((id, i) => id === b.removedOrder[i]));

// Matches the wardrobe-lock phrasing already scattered through the choreography library below, so
// the fallback line only fires when a clip's own action text doesn't already carry one.
const HAS_WARDROBE_LOCK_RE =
  /no clothing change|nothing (comes off|new appears)|stays exactly on her body|no garment is added, removed/i;

// Positive-only, like describeState: only names bra/panties as staying white when they're actually worn.
const wardrobeLockLine = (wardrobe: Wardrobe): string => {
  const wornColored = (["bra", "panties"] as const).filter(
    (id) => wardrobe[id].on,
  );
  const colorClause =
    wornColored.length > 0
      ? ` — her ${wornColored.map((id) => GARMENT_LABEL[id]).join(" and ")} stay white`
      : "";
  return `Her clothing stays exactly as described${colorClause}; nothing is put on or taken off.`;
};

// Requested-clip only: names this the one and only action, ahead of every lock, since a video model weights earlier tokens more heavily.
const ONLY_ACTION_LINE =
  "She performs only this one action for the entire clip — no turning away, no walking off, no clothing change beyond what is described here.";

const buildPrompt = (params: {
  state: LiveState;
  speechMode: SpeechMode;
  creator: CreatorProfile;
  action: string;
  nextWardrobe: Wardrobe;
  nextBody: Body;
  explicit: boolean;
  durationSec: number;
  // True for a fan/viewer-requested clip (reply/beat): leads with the action instead of the universal locks.
  leadWithAction?: boolean;
}): string => {
  const needsWardrobeLock =
    wardrobeUnchanged(params.state.wardrobe, params.nextWardrobe) &&
    !HAS_WARDROBE_LOCK_RE.test(params.action);
  const setupLines = [
    CAMERA_LOCK,
    ANATOMY_LOCK,
    lookLockLine(params.creator.lookLock),
    `ROOM: ${params.state.surroundings}`,
    `NOW: she is ${describeState(params.state.wardrobe, params.state.body)}`,
  ];
  const closingLines = [
    needsWardrobeLock ? wardrobeLockLine(params.nextWardrobe) : null,
    `By ${params.durationSec}s she is ${describeState(params.nextWardrobe, params.nextBody)}, still, eyes on the lens. The clip ends there.`,
    PHYSICS_LOCK,
    NO_OVERLAY_LOCK,
    params.explicit ? CONTENT_LOCK_PERMISSIVE : CONTENT_LOCK_HOLD,
    speechLockLine(params.speechMode),
  ];
  const lines = params.leadWithAction
    ? [params.action, ONLY_ACTION_LINE, ...setupLines, ...closingLines]
    : [...setupLines, params.action, ...closingLines];
  return lines.filter((line): line is string => line !== null).join(" ");
};

// --- Choreography library (planBeatIntent) ----------------------------------

export type BeatPlan = {
  physical: string;
  nextWardrobe: Wardrobe;
  nextBody: Body;
  durationSec: number;
  explicit: boolean;
};

// NEEDS_SITUP_POSES already repositions lying/onAllFours/bentOver/kneeling to sitting before a
// panties/bottom beat reaches here on the reply path, so "lying" mechanics below are for direct calls only.
type Posture = "standing" | "sitting" | "lying";

const posture = (pose: Body["pose"]): Posture =>
  pose === "standing" ? "standing" : pose === "lying" ? "lying" : "sitting";

// Appended to every wardrobe clip's action text (never part of the timeboxed mechanics above),
// as a second guard against the model inventing fabric that stretches, tears, or teleports.
const WARDROBE_PHYSICS_LINE =
  "The fabric moves only where her hands move it; it slides, folds and hangs with real weight and never vanishes, stretches, tears or teleports.";

const removalChoreo = (
  id: GarmentId,
  wardrobe: Wardrobe,
  body: Body,
): string => {
  const desc = describeGarment(wardrobe, id);
  switch (id) {
    case "bra":
      return (
        `0-3s: both hands reach behind her back and find the clasp of her ${desc}, unhooking it with ` +
        "a single hook release. 3-6s: her shoulders roll forward as the straps loosen and slide down " +
        "her upper arms. 6-9s: she brings one arm through, then the other. 9-13s: the cups fall " +
        "forward; she catches it in one hand, lowers it, and sets it out of frame. 13-15s: hands come " +
        "to rest, still, chest bare."
      );
    case "top":
      return (
        `0-3s: she crosses her arms at the hem of her ${desc} and gathers the fabric. 3-6s: she lifts ` +
        "it up over her torso and over her head, her head briefly covered. 6-9s: her arms come free " +
        "one at a time and her hair falls back. 9-13s: she sets it out of frame. 13-15s: hands rest, still."
      );
    case "panties": {
      switch (posture(body.pose)) {
        case "standing":
          return (
            `0-3s: thumbs hook the waistband of her ${desc} at her hips. 3-6s: she pushes it down ` +
            "over her hips to mid-thigh. 6-9s: she bends forward slightly, pushing it down to her " +
            "knees. 9-12s: she lifts one foot out, then the other. 12-13s: she straightens up, " +
            "holding them in one hand, and sets them aside. 13-15s: hands rest, still."
          );
        case "lying":
          return (
            `0-3s: her knees bend and her hips lift, the waistband of her ${desc} coming free at her ` +
            "hips. 3-6s: she slides it down her thighs. 6-9s: her legs raise. 9-13s: she pulls them " +
            "off over her feet, one at a time, and sets them aside. 13-15s: hands rest, still."
          );
        case "sitting":
        default:
          return (
            `0-3s: thumbs hook the waistband of her ${desc}. 3-6s: she lifts her hips off the seat ` +
            "and slides it down to her thighs. 6-9s: she sits back down. 9-13s: she pulls them down " +
            "past her knees and off over her feet, one at a time. 13-15s: hands rest, still."
          );
      }
    }
    case "bottom": {
      const isSkirt = /skirt/i.test(desc);
      if (isSkirt) {
        return (
          `0-3s: she unzips or unhooks her ${desc} at the hip. 3-6s: she lets it drop and settle at ` +
          "her feet. 6-9s: she steps out of it with each foot. 9-13s: she picks it up and sets it out " +
          "of frame. 13-15s: hands rest, still."
        );
      }
      return posture(body.pose) === "standing"
        ? `0-3s: thumbs hook the waistband of her ${desc} at her hips. 3-6s: she pushes it down over ` +
            "her hips to mid-thigh. 6-9s: she bends forward slightly, pushing it down to her knees. " +
            "9-12s: she lifts one foot out, then the other. 12-13s: she straightens up, holding them " +
            "in one hand, and sets them aside. 13-15s: hands rest, still."
        : `0-3s: thumbs hook the waistband of her ${desc}. 3-6s: she lifts her hips and slides it ` +
            "down to her thighs. 6-9s: she pulls them down past her knees and off over her feet, one " +
            "at a time. 9-13s: she sets them out of frame. 13-15s: hands rest, still.";
    }
  }
};

const dressChoreo = (id: GarmentId, wardrobe: Wardrobe, body: Body): string => {
  const desc = describeGarment(wardrobe, id);
  switch (id) {
    case "bra":
      return (
        `0-3s: she picks up her bra (${desc}) and brings it to her chest, cups in place. 3-6s: she ` +
        "threads one arm through a strap, then the other. 6-9s: she reaches behind her back and finds " +
        "the clasp. 9-13s: she hooks it closed, the straps settling on her shoulders. 13-15s: hands rest, still."
      );
    case "top":
      return (
        `0-3s: she picks up her top (${desc}) and gathers the hem in both hands. 3-6s: she lowers it ` +
        "over her head, arms finding the sleeves as it comes down. 6-9s: it settles over her torso, " +
        "her hair falling back into place. 9-13s: she smooths it down. 13-15s: hands rest, still."
      );
    case "panties":
      return posture(body.pose) === "standing"
        ? `0-3s: she picks up her panties (${desc}) and steps one foot in, then the other. 3-6s: she ` +
            "pulls them up her calves and past her knees. 6-9s: she bends forward slightly, drawing " +
            "them up her thighs. 9-13s: she straightens up, hooking the waistband into place at her " +
            "hips. 13-15s: hands rest, still."
        : `0-3s: she picks up her panties (${desc}) and slides one foot in, then the other, over her ` +
            "feet. 3-6s: she draws them up her calves and thighs. 6-9s: she lifts her hips off the " +
            "seat. 9-13s: she settles back down, the waistband in place at her hips. 13-15s: hands rest, still.";
    case "bottom": {
      const isSkirt = /skirt/i.test(desc);
      if (isSkirt) {
        return (
          `0-3s: she picks up her ${desc} and steps into it with each foot. 3-6s: she draws it up her ` +
          "legs to her hips. 6-9s: she settles it into place at her waist. 9-13s: she hooks or zips it " +
          "closed at the hip. 13-15s: hands rest, still."
        );
      }
      return posture(body.pose) === "standing"
        ? `0-3s: she picks up her ${desc} and steps one foot in, then the other. 3-6s: she pulls them ` +
            "up her legs and past her knees. 6-9s: she bends forward slightly, drawing them up her " +
            "thighs. 9-13s: she straightens up, fastening the waistband. 13-15s: hands rest, still."
        : `0-3s: she picks up her ${desc} and slides one foot in, then the other. 3-6s: she draws them ` +
            "up her calves and thighs. 6-9s: she lifts her hips. 9-13s: she settles back down, " +
            "fastening the waistband. 13-15s: hands rest, still.";
    }
  }
};

const EXPLICIT_ACTS = new Set([
  "grind",
  "spread",
  "doggy",
  "spank",
  "boobPlay",
]);

const planAct = (
  intent: Extract<BeatIntent, { type: "act" }>,
  wardrobe: Wardrobe,
  body: Body,
): BeatPlan => {
  switch (intent.act) {
    case "grind":
      return {
        physical:
          "Staying on her hands and knees, back arched, she rocks and grinds her hips in a slow, " +
          "steady rhythm toward the webcam — external movement only, no insertion.",
        nextWardrobe: wardrobe,
        nextBody: body,
        durationSec: ACTION_BEAT_SEC,
        explicit: true,
      };
    case "twerk": {
      const leadIn =
        body.pose !== "standing" ? "0-2s: she rises to her feet. " : "";
      return {
        physical:
          `${leadIn}Standing with her back to the webcam, she shakes and bounces her hips and ass ` +
          "to a beat only she can hear. No clothing changes.",
        nextWardrobe: wardrobe,
        nextBody: { ...body, pose: "standing", facing: "away" },
        durationSec: ACTION_BEAT_SEC,
        explicit: false,
      };
    }
    case "bounce":
      return {
        physical: (() => {
          const surface =
            body.pose === "standing" ? "on her heels" : "on her seat";
          const topLine = isOn(wardrobe, "top")
            ? `, her ${describeGarment(wardrobe, "top")} moving with her`
            : "";
          return `Hands free or resting lightly on her thighs, she bounces up and down ${surface} so her chest moves${topLine}. Nothing comes off, nothing else changes.`;
        })(),
        nextWardrobe: wardrobe,
        nextBody: body,
        durationSec: ACTION_BEAT_SEC,
        explicit: false,
      };
    case "spread": {
      if (intent.detail === "ass") {
        const alreadyBack =
          body.pose === "onAllFours" || body.pose === "bentOver";
        const leadIn = alreadyBack
          ? ""
          : "0-3s: she turns her hips away from the webcam and bends forward at the waist, settling into position. ";
        return {
          physical:
            `${leadIn}Facing away and bent forward, she reaches back with both hands and pulls her ` +
            "ass cheeks apart, holding them open toward the lens, looking back over her shoulder. No clothing changes.",
          nextWardrobe: wardrobe,
          nextBody: {
            ...body,
            pose: "bentOver",
            facing: "away",
            hands: "onBody",
            contact: "self",
          },
          durationSec: ACTION_BEAT_SEC,
          explicit: true,
        };
      }
      const legsLine =
        body.pose === "standing"
          ? "She steps her feet wide apart and bends forward slightly, legs spread toward the lens."
          : body.pose === "lying"
            ? "Lying down, she draws her knees up and lets them fall open, legs spread toward the lens."
            : "She draws her knees up and lets them fall open, legs spread toward the lens.";
      return {
        physical: `${legsLine} No clothing changes.`,
        nextWardrobe: wardrobe,
        nextBody: body,
        durationSec: ACTION_BEAT_SEC,
        explicit: true,
      };
    }
    case "sway":
      return {
        physical:
          "Bent over, she sways and arches her back, hips rocking slowly. No clothing changes.",
        nextWardrobe: wardrobe,
        nextBody: body,
        durationSec: ACTION_BEAT_SEC,
        explicit: false,
      };
    case "dance": {
      const leadIn =
        body.pose !== "standing" ? "0-2s: she rises to her feet. " : "";
      return {
        physical: `${leadIn}She sways her hips to a beat only she can hear, full body in frame. No clothing changes.`,
        nextWardrobe: wardrobe,
        nextBody: { ...body, pose: "standing" },
        durationSec: ACTION_BEAT_SEC,
        explicit: false,
      };
    }
    case "crawl":
      return {
        physical:
          "On her hands and knees, she crawls toward the fixed webcam, unhurried — the camera itself " +
          "never moves, only her body gets closer, filling more of the frame.",
        nextWardrobe: wardrobe,
        nextBody: {
          ...body,
          framing: body.framing === "wider" ? "medium" : "torso",
        },
        durationSec: ACTION_BEAT_SEC,
        explicit: false,
      };
    case "spin": {
      const leadIn =
        body.pose !== "standing"
          ? "0-2s: she rises to her feet."
          : "0-2s: she shifts her weight, ready to turn.";
      return {
        physical:
          `${leadIn} 2-8s: she turns a full 360-degree circle in ` +
          "place, showing her body from every angle; every garment she is wearing stays exactly on " +
          "her body the entire turn. 8-11s: she settles standing, facing the webcam, holding still.",
        nextWardrobe: wardrobe,
        nextBody: { ...body, pose: "standing", facing: "camera" },
        durationSec: ACTION_BEAT_SEC,
        explicit: false,
      };
    }
    case "gesture":
      return {
        physical:
          "She gives a warm wave and smiles at the webcam, maybe a small wink or a blown kiss. " +
          "No clothing changes, nothing new appears.",
        nextWardrobe: wardrobe,
        nextBody: body,
        durationSec: LIVE_TUNABLES.IDLE_CLIP_SEC,
        explicit: false,
      };
    case "tongue":
      return {
        physical:
          "She sticks her tongue out playfully or slowly licks her lips, holding her exact pose. " +
          "No clothing changes, nothing new appears.",
        nextWardrobe: wardrobe,
        nextBody: body,
        durationSec: LIVE_TUNABLES.IDLE_CLIP_SEC,
        explicit: false,
      };
    case "tease":
      return {
        physical:
          intent.detail ??
          "TEASE ONLY, no removal. She toys at the edge of a garment, holds it, then lets it settle back. Nothing comes off.",
        nextWardrobe: wardrobe,
        nextBody: body,
        durationSec: ACTION_BEAT_SEC,
        explicit: false,
      };
    case "doggy":
      return {
        physical:
          "0-4s: she lowers herself onto her hands and knees on the bed, turning her hips toward the " +
          "webcam as she settles — she does not stand up or turn a full circle, the turn happens as " +
          "part of the same movement. 4-8s: on her hands and knees, back arched, she rocks her hips in " +
          "a slow, steady rhythm. 8-11s: she glances back over her shoulder at the lens, still rocking. " +
          "No clothing changes.",
        nextWardrobe: wardrobe,
        nextBody: {
          ...body,
          pose: "onAllFours",
          facing: "away",
          hands: "free",
          contact: "none",
        },
        durationSec: ACTION_BEAT_SEC,
        explicit: true,
      };
    case "spank": {
      const turnsToSide = body.facing === "camera";
      return {
        physical:
          "One hand comes around and spanks her own ass cheek, a few firm slaps, visible skin " +
          `reaction, eyes on the lens${turnsToSide ? " — she turns her hips to the side as part of the same motion" : ""}. ` +
          "No clothing changes.",
        nextWardrobe: wardrobe,
        nextBody: turnsToSide ? { ...body, facing: "side" } : body,
        durationSec: ACTION_BEAT_SEC,
        explicit: true,
      };
    }
    case "boobPlay": {
      const layer = isOn(wardrobe, "bra")
        ? describeGarment(wardrobe, "bra")
        : isOn(wardrobe, "top")
          ? describeGarment(wardrobe, "top")
          : null;
      const overFabric = layer ? ` over her ${layer}` : "";
      return {
        physical:
          `Both hands come up and cup her own breasts${overFabric}, squeezing gently, thumbs circling ` +
          "slowly over where her nipples are. No clothing changes.",
        nextWardrobe: wardrobe,
        nextBody: body,
        durationSec: ACTION_BEAT_SEC,
        explicit: true,
      };
    }
  }
};

// A held real prop (not "none"/"fetching") occupies a hand; any intent other than actually
// fetching or using that prop first sets it down in the same clip instead of a separate one.
const isHoldingRealProp = (body: Body): boolean =>
  body.hands === "holdingProp" &&
  body.prop !== "none" &&
  body.prop !== "fetching";

// Poses the panties/bottom removal choreography can't be performed from directly — she needs to
// reposition (sit up) in the same clip first.
const NEEDS_SITUP_POSES = new Set<Body["pose"]>([
  "lying",
  "onAllFours",
  "bentOver",
  "kneeling",
]);

const PROP_SETDOWN_SEC = 1;
const SIT_UP_SEC = 2;

const propSetDownLine = (
  prop: Exclude<Body["prop"], "none" | "fetching">,
): string =>
  `0-${PROP_SETDOWN_SEC}s: she sets ${PROP_LABEL[prop]} down out of frame.`;

const SIT_UP_LINE = `0-${SIT_UP_SEC}s: she shifts to sit up on the edge of the bed.`;

// Shifts a choreo's "<start>-<end>s:" time-boxes by offsetSec (clamped to the beat's own duration,
// e.g. 15s for a wardrobe beat vs 11s otherwise) so a lead-in can precede it.
const shiftChoreoTimes = (
  physical: string,
  offsetSec: number,
  capSec: number,
): string =>
  physical.replace(/(\d+)-(\d+)s:/g, (_match, start: string, end: string) => {
    const shiftedStart = Math.min(capSec, Number(start) + offsetSec);
    const shiftedEnd = Math.min(capSec, Number(end) + offsetSec);
    return `${shiftedStart}-${shiftedEnd}s:`;
  });

// The choreography library itself, with no lead-in handling — every request performs entirely
// from the body it is given.
const planBeatIntentCore = (
  intent: BeatIntent,
  wardrobe: Wardrobe,
  body: Body,
  baselineBody: Body,
): BeatPlan => {
  switch (intent.type) {
    case "removeGarment":
      return {
        physical: `${removalChoreo(intent.garment, wardrobe, body)} ${WARDROBE_PHYSICS_LINE}`,
        nextWardrobe: removeGarment(wardrobe, intent.garment),
        nextBody: { ...body, hands: "free", contact: "none" },
        durationSec: LIVE_TUNABLES.MAX_CLIP_SEC,
        explicit: true,
      };
    case "addGarment":
      return {
        physical: `${dressChoreo(intent.garment, wardrobe, body)} ${WARDROBE_PHYSICS_LINE}`,
        nextWardrobe: addGarment(wardrobe, intent.garment),
        nextBody: body,
        durationSec: LIVE_TUNABLES.MAX_CLIP_SEC,
        explicit: false,
      };
    case "pose":
      return {
        physical:
          `She moves from her current pose into ${POSE_DESCRIPTION[intent.pose]}, turning as she settles ` +
          `so she ends up ${FACING_TRANSITION_LABEL[intent.facing]}. The fixed webcam does not move. She ` +
          "does not spin or turn a full circle. No clothing changes.",
        nextWardrobe: wardrobe,
        nextBody: { ...body, pose: intent.pose, facing: intent.facing },
        durationSec: ACTION_BEAT_SEC,
        explicit: false,
      };
    case "framing":
      return {
        physical:
          "She moves relative to the fixed webcam, unhurried — the camera itself never moves, only " +
          "her distance changes, adjusting how much of her fills the frame.",
        nextWardrobe: wardrobe,
        nextBody: { ...body, framing: intent.framing },
        durationSec: ACTION_BEAT_SEC,
        explicit: false,
      };
    case "fetchProp":
      return {
        physical: `One hand reaches off-screen and returns holding one ${intent.prop}, her weight visibly gripping it. Only one object is visible.`,
        nextWardrobe: wardrobe,
        nextBody: { ...body, prop: intent.prop, hands: "holdingProp" },
        durationSec: ACTION_BEAT_SEC,
        explicit: false,
      };
    case "useProp": {
      const useLine =
        intent.mode === "mouth"
          ? "She brings it to her mouth and sucks/licks it there, mouth only, never lower."
          : "She holds it against herself and uses it externally against her skin, external contact only, eyes on the lens.";
      return {
        physical: `${useLine} Only one object is visible.`,
        nextWardrobe: wardrobe,
        nextBody: { ...body, hands: "holdingProp", contact: "self" },
        durationSec: ACTION_BEAT_SEC,
        explicit: true,
      };
    }
    case "rest": {
      const propLine = HELD_OBJECTS.has(body.prop)
        ? `She sets the ${body.prop} down out of frame. `
        : "";
      const handLine =
        body.hands === "onBody" ? "Her hand eases off her own body. " : "";
      // Rest settles all the way back to her baseline resting pose, not just free hands — otherwise
      // "resting" could still leave her kneeling or bent over from whatever she was just doing.
      const poseChanged =
        body.pose !== baselineBody.pose || body.facing !== baselineBody.facing;
      const poseLine = poseChanged
        ? `She settles back into ${POSE_DESCRIPTION[baselineBody.pose]}, turning to end up ` +
          `${FACING_TRANSITION_LABEL[baselineBody.facing]}. `
        : "";
      return {
        physical: `${propLine}${handLine}${poseLine}Her hands come to rest, empty, still.`,
        nextWardrobe: wardrobe,
        nextBody: { ...baselineBody },
        durationSec: ACTION_BEAT_SEC,
        explicit: false,
      };
    }
    case "touch": {
      const coveringDesc = wardrobe.panties.on
        ? `over her ${describeGarment(wardrobe, "panties")}`
        : wardrobe.bottom.on
          ? `over her ${describeGarment(wardrobe, "bottom")}`
          : "over her bare skin";
      const positionLine =
        body.pose === "standing"
          ? "standing with her legs slightly apart, one hand slides down the front of her body"
          : body.pose === "lying" || body.pose === "onAllFours"
            ? "she reaches one hand back between her legs"
            : "sitting with her knees apart, one hand slides down between her legs";
      return {
        physical:
          `0-2s: ${positionLine}, her fingers settling ${coveringDesc}. 2-8s: her fingers rub in a ` +
          `steady rhythm ${coveringDesc}, external contact only, never inserting. 8-11s: her hips rock ` +
          "gently and her breathing quickens, fingers still moving, eyes on the lens.",
        nextWardrobe: wardrobe,
        nextBody: { ...body, hands: "onBody", contact: "self" },
        durationSec: ACTION_BEAT_SEC,
        explicit: true,
      };
    }
    case "act":
      return planAct(intent, wardrobe, body);
    case "hold":
      return {
        physical: intent.line,
        nextWardrobe: wardrobe,
        nextBody: body,
        durationSec: LIVE_TUNABLES.IDLE_CLIP_SEC,
        explicit: false,
      };
    case "verbatim":
      return {
        physical:
          `She does exactly this, one clear continuous action, and holds the result: "${intent.text}". ` +
          "The fixed webcam does not move; she stays fully in frame throughout. No garment is added, " +
          "removed, or shifted while she does it.",
        nextWardrobe: wardrobe,
        nextBody: body,
        durationSec: ACTION_BEAT_SEC,
        explicit: RE_SEXUAL_NOUN.test(intent.text),
      };
  }
};

// One clip, from wherever she currently is: prepends a short lead-in and re-times the
// choreography when the request can't be performed directly from the current body.
export const planBeatIntent = (
  intent: BeatIntent,
  state: LiveState,
): BeatPlan => {
  const { wardrobe, body, baselineBody } = state;

  if (
    isHoldingRealProp(body) &&
    intent.type !== "fetchProp" &&
    intent.type !== "useProp" &&
    intent.type !== "rest"
  ) {
    const prop = body.prop as Exclude<Body["prop"], "none" | "fetching">;
    const freedBody: Body = {
      ...body,
      prop: "none",
      hands: "free",
      contact: "none",
    };
    const base = planBeatIntentCore(intent, wardrobe, freedBody, baselineBody);
    return {
      ...base,
      physical: `${propSetDownLine(prop)} ${shiftChoreoTimes(base.physical, PROP_SETDOWN_SEC, base.durationSec)}`,
    };
  }

  if (
    (intent.type === "removeGarment" || intent.type === "addGarment") &&
    (intent.garment === "panties" || intent.garment === "bottom") &&
    NEEDS_SITUP_POSES.has(body.pose)
  ) {
    const sittingBody: Body = { ...body, pose: "sitting" };
    const base = planBeatIntentCore(
      intent,
      wardrobe,
      sittingBody,
      baselineBody,
    );
    return {
      ...base,
      physical: `${SIT_UP_LINE} ${shiftChoreoTimes(base.physical, SIT_UP_SEC, base.durationSec)}`,
    };
  }

  return planBeatIntentCore(intent, wardrobe, body, baselineBody);
};

// --- Reply intent catalog ---------------------------------------------------

const GARMENT_PATTERN: Record<GarmentId, RegExp> = {
  top: /\b(top|shirt|tee|blouse|tank)\b/i,
  bottom: /\b(bottoms?|pants|shorts|skirt|trousers)\b/i,
  bra: /\bbra\b/i,
  panties: /\b(panties|thong|underwear|knickers)\b/i,
};

const offPatternFor = (nouns: string): RegExp =>
  new RegExp(
    `\\b(?:take|pull|slide|rip)\\s+(?:your |the |ur )?(?:${nouns})(?:\\s+(?:off|down))?\\b|` +
      `\\b(?:${nouns})\\s+off\\b|\\bremove\\s+(?:your |the |ur )?(?:${nouns})\\b|` +
      `\\b(?:take|pull|slide|rip)\\s+(?:off|down)\\s+(?:your |the |ur )?(?:${nouns})\\b`,
    "i",
  );

const GARMENT_OFF_PATTERN: Record<GarmentId, RegExp> = {
  top: offPatternFor("top|shirt|tee|blouse|tank"),
  bottom: offPatternFor("bottoms?|pants|shorts|skirt|trousers"),
  bra: offPatternFor("bra"),
  panties: offPatternFor("panties|thong|underwear|knickers"),
};

const RE_ONE_PIECE_OFF = offPatternFor(
  "dress|one[- ]piece|romper|jumpsuit|lingerie|outfit",
);
const RE_OFF_VERB = /\b(off|remove|take off|slide off|pull down|down|strip)\b/i;
const RE_GENERIC_OFF = /\b(take|pull|slide|rip) it off\b/i;
const RE_DRESS =
  /\b(put (your |the )?(top|shirt|bra|bottoms?|panties|clothes) (back )?on|get dressed|cover (yourself )?up|dress (yourself )?up?)\b/i;
const RE_EVERYTHING =
  /\b(naked|nude|get naked|everything off|all off|nothing on)\b|\bstrip\b(?:\s+(?:it all|everything))?/i;
const RE_TEASE_STRAP = /\b(bra strap|strap tease|shoulder strap)\b/i;
const RE_TEASE_WAIST =
  /\b(panty tease|waistband (tease|snap|pull)|flash (your |ur )?panties)\b/i;
const RE_TEASE_HEM =
  /\b(tease|lift (your |the )?(top|hem|shirt)|flash (your |ur )?(top|chest|tits)|peek)\b/i;
const RE_REVEAL_CHEST =
  /\b(show|see|let (me|us) see)\s+(me |us )?(your |ur |that |her )?(tits?|boobs?|breasts?|chest|nipples?)\b/i;
const RE_REVEAL_GENITALS =
  /\b(show|see|let (me|us) see)\s+(me |us )?(your |ur |that |her )?(pussy|cunt|vagina)\b/i;
const RE_FACE_CAMERA =
  /\b(face (the )?(camera|webcam|lens)|face me|look at me)\b/i;
const RE_FACE_AWAY =
  /\b(turn around|turn your back|face away|show (me )?(your |ur )?ass|from behind|booty)\b/i;
const RE_TOY_ANY = /\b(dildos?|vibrators?|vibes?|wands?|toys?)\b/i;
const RE_TOY_DILDO = /\bdildos?\b/i;
const RE_INSERT =
  /\b(insert|inside (her|your|my)|stick it in|in (her|your|my) (pussy|cunt|ass|butt))\b/i;
const RE_SUCK = /\b(suck|blowjob|blow job)\b/i;
// Breast-noun phrasing is intentionally excluded here — that routes to boobPlay/bounce instead.
const RE_TOUCH =
  /\b(touch (yourself|your (pussy|clit))|masturbat\w*|finger\w*\s+(yourself|your pussy)|insert (your |a )?fingers?|play with (yourself|your (pussy|clit))|rub (your|ur) (clit|pussy)|rub (your (pussy|clit)|yourself)|joi|jerk[\s-]?off|get yourself off|make yourself cum|cum for me|orgasm\w*)\b/i;
const RE_DANCE = /\b(dance|sway)\b/i;
const RE_DRINK = /\b(drink|sip|water|coffee|tea)\b/i;
const RE_TIP = /\b(tip(ped)?|thank you|thanks)\b/i;
const RE_SMALL_TALK =
  /\b(hi|hello|hey|how are you|you('re| are) (cute|hot|beautiful|gorgeous)|nice (smile|eyes)|good morning|good evening)\b/i;

const RE_GESTURE =
  /\b(wave|blow (me |us )?a kiss|wink at me|smile (for|at) (me|us|the camera))\b/i;
const RE_TONGUE =
  /\b(show (me |us )?(your |ur )?tongue|stick out (your |ur )?tongue|lick (your |ur )?lips)\b/i;
const RE_BOUNCE =
  /\b((jiggle|bounce|shake) (your |ur |her |those |them )?(tits|boobs|chest|titties)|bounce for me)\b/i;
const RE_DOGGY = /\b(doggy\w*|all fours|hands and knees)\b/i;
const RE_SPANK =
  /\bspank(s|ing)?\b|\bslap (your |ur |that )?(ass|butt|booty|cheeks?)\b|\bsmack (your |ur |that )?(ass|butt|booty)\b/i;
const RE_SQUEEZE =
  /\b(squeeze|grab|cup|grope) (your |ur |those |them )?(tits|boobs|chest|ass|butt|booty)\b/i;
const RE_BOOB_PLAY =
  /\b(rub|hold|cup|massage|play with) (your |ur |those |them )?(tits|boobs|chest|nipples)\b/i;
const RE_BEND = /\bbend(ing)?\s+over\b/i;
const RE_CRAWL = /\bcrawl(ing)?\b/i;
const RE_SPREAD_LEGS = /\b(spread|open) (your |ur )?legs\b/i;
const RE_SPREAD_ASS =
  /\bspread (your |ur )?(ass|cheeks)\b|\bshow (me |us )?(your |ur )?ass(hole)?\b/i;
const RE_TWERK =
  /\bshake (your |ur |that |her )?(ass|booty)\b|\bshake it\b|\btwerk\w*\b|\bbooty\b/i;
const RE_COME_CLOSER =
  /\b(come closer|move closer|get closer|closer to (the )?camera)\b/i;
const RE_BACK_UP = /\b(back up|move back|step back|further away|get back)\b/i;
const RE_SPIN =
  /\bspins?\b|\bspinning\b|\bdo a spin\b|\bfull (turn|circle|360)\b|\b360\b/i;

const RE_GENERIC_ACTION =
  /\b(show|do|try|give|move|walk|stand|pose|face|look|point|lift|raise|lower|open|close|hold|grab|pull|push|rotate|flex|stretch|arch|squat|jump|hop|shake|wiggle|roll|flip|spank|slap|smack|squeeze|cup|grope|rub|lick|suck|kiss|bite|twist|jiggle|bounce|spread|finger|ride|hump|tease|flash|strip|undress|tug|pinch|flick|thrust|kneel|crawl|sit|lie|lay|turn|bend|wave|blow)\b/i;

// Sexual/body nouns that make an unrecognized-but-physical (verbatim) request explicit content.
const RE_SEXUAL_NOUN =
  /\b(tits?|boobs?|ass|pussy|clit|nipples?|cum|fuck\w*|suck\w*|dildo|vibrator|naked|nude)\b/i;

const RE_POSE: Partial<Record<Pose, RegExp>> = {
  standing: /\b(stand up|get up|on your feet)\b/i,
  sitting: /\b(sit( down)?|sit back down)\b/i,
  leaning: /\blean(ing)?\b/i,
  lying: /\b(lie down|lay down|on your back|on the bed|on the floor)\b/i,
  kneeling: /\b(kneel|on your knees)\b/i,
};

const dressIntents = (
  text: string,
  wardrobe: Wardrobe,
): BeatIntent[] | null => {
  if (!RE_DRESS.test(text)) return null;
  const named = GARMENT_ORDER.find(
    (id) => GARMENT_PATTERN[id].test(text) && !isOn(wardrobe, id),
  );
  const garment = named ?? lastRemoved(wardrobe);
  if (!garment) {
    return [
      {
        type: "hold",
        line: "She is already fully dressed. She smiles and stays exactly as she is.",
      },
    ];
  }
  return [{ type: "addGarment", garment }];
};

const stripAllIntents = (text: string): BeatIntent[] | null =>
  RE_EVERYTHING.test(text)
    ? GARMENT_ORDER.map((garment) => ({
        type: "removeGarment" as const,
        garment,
      }))
    : null;

const teaseIntents = (
  text: string,
  wardrobe: Wardrobe,
): BeatIntent[] | null => {
  if (RE_TEASE_STRAP.test(text)) {
    return [
      {
        type: "act",
        act: "tease",
        detail:
          `She slides her bra strap (${describeGarment(wardrobe, "bra")}) off one shoulder with a ` +
          "finger, holds it, then lets it snap back. Nothing comes off.",
      },
    ];
  }
  if (RE_TEASE_WAIST.test(text)) {
    return [
      {
        type: "act",
        act: "tease",
        detail:
          `She hooks a thumb in her panties (${describeGarment(wardrobe, "panties")}) waistband, tugs ` +
          "it out, and lets it snap back. Nothing comes off.",
      },
    ];
  }
  if (RE_TEASE_HEM.test(text) && !RE_OFF_VERB.test(text)) {
    return [
      {
        type: "act",
        act: "tease",
        detail:
          `She lifts the hem of her top (${describeGarment(wardrobe, "top")}) a few inches, holds it, ` +
          "then lets it drop. The top stays on.",
      },
    ];
  }
  return null;
};

const stripGarmentIntents = (text: string): BeatIntent[] | null => {
  const target =
    GARMENT_ORDER.find((id) => GARMENT_OFF_PATTERN[id].test(text)) ??
    (RE_GENERIC_OFF.test(text) || RE_ONE_PIECE_OFF.test(text)
      ? "top"
      : undefined);
  return target ? [{ type: "removeGarment", garment: target }] : null;
};

const revealIntents = (text: string): BeatIntent[] | null => {
  const garments: GarmentId[] = RE_REVEAL_CHEST.test(text)
    ? ["top", "bra"]
    : RE_REVEAL_GENITALS.test(text)
      ? ["bottom", "panties"]
      : [];
  return garments.length > 0
    ? garments.map((garment) => ({ type: "removeGarment" as const, garment }))
    : null;
};

const poseIntents = (text: string, body: Body): BeatIntent[] | null => {
  const poseEntry = (Object.entries(RE_POSE) as [Pose, RegExp][]).find(
    ([, re]) => re.test(text),
  );
  const wantsFaceCamera = RE_FACE_CAMERA.test(text);
  const wantsFaceAway = RE_FACE_AWAY.test(text) && !wantsFaceCamera;
  if (!poseEntry && !wantsFaceCamera && !wantsFaceAway) return null;
  const pose = poseEntry?.[0] ?? body.pose;
  const facing: Body["facing"] = wantsFaceCamera
    ? "camera"
    : wantsFaceAway
      ? "away"
      : body.facing;
  return [{ type: "pose", pose, facing }];
};

const gestureIntents = (text: string): BeatIntent[] | null =>
  RE_GESTURE.test(text) ? [{ type: "act", act: "gesture" }] : null;

const tongueIntents = (text: string): BeatIntent[] | null =>
  RE_TONGUE.test(text) ? [{ type: "act", act: "tongue" }] : null;

const bounceIntents = (text: string): BeatIntent[] | null =>
  RE_BOUNCE.test(text) ? [{ type: "act", act: "bounce" }] : null;

const doggyIntents = (text: string): BeatIntent[] | null =>
  RE_DOGGY.test(text) ? [{ type: "act", act: "doggy" }] : null;

const spankIntents = (text: string): BeatIntent[] | null =>
  RE_SPANK.test(text) ? [{ type: "act", act: "spank" }] : null;

// squeeze/grab/cup/grope routes to boobPlay for a chest noun, or ass-spread for an ass noun.
const squeezeIntents = (text: string): BeatIntent[] | null => {
  const match = RE_SQUEEZE.exec(text);
  if (!match) return null;
  const isAss = /\b(ass|butt|booty)\b/i.test(match[3] ?? "");
  return isAss
    ? [{ type: "act", act: "spread", detail: "ass" }]
    : [{ type: "act", act: "boobPlay" }];
};

const boobPlayIntents = (text: string): BeatIntent[] | null =>
  RE_BOOB_PLAY.test(text) ? [{ type: "act", act: "boobPlay" }] : null;

const bendOverIntents = (text: string, body: Body): BeatIntent[] | null => {
  if (!RE_BEND.test(text)) return null;
  const wantsAway = RE_FACE_AWAY.test(text);
  const wantsCamera = RE_FACE_CAMERA.test(text);
  const facing: Body["facing"] = wantsAway
    ? "away"
    : wantsCamera
      ? "camera"
      : body.facing === "side"
        ? "camera"
        : body.facing;
  return [
    { type: "pose", pose: "bentOver", facing },
    { type: "act", act: "sway" },
  ];
};

const crawlIntents = (text: string): BeatIntent[] | null =>
  RE_CRAWL.test(text)
    ? [
        { type: "pose", pose: "onAllFours", facing: "camera" },
        { type: "act", act: "crawl" },
      ]
    : null;

const spreadIntents = (text: string, body: Body): BeatIntent[] | null => {
  if (RE_SPREAD_ASS.test(text)) {
    return [{ type: "act", act: "spread", detail: "ass" }];
  }
  if (!RE_SPREAD_LEGS.test(text)) return null;
  const pose: Pose =
    body.pose === "standing" || body.pose === "lying" ? body.pose : "sitting";
  return [
    { type: "pose", pose, facing: "camera" },
    { type: "act", act: "spread", detail: "legs" },
  ];
};

const twerkIntents = (text: string): BeatIntent[] | null =>
  RE_TWERK.test(text) ? [{ type: "act", act: "twerk" }] : null;

const spinIntents = (text: string): BeatIntent[] | null =>
  RE_SPIN.test(text) ? [{ type: "act", act: "spin" }] : null;

const comeCloserIntents = (text: string, body: Body): BeatIntent[] | null => {
  if (!RE_COME_CLOSER.test(text)) return null;
  const idx = FRAMING_STEPS.indexOf(body.framing);
  const framing =
    FRAMING_STEPS[Math.min(idx + 1, FRAMING_STEPS.length - 1)] ?? body.framing;
  return [{ type: "framing", framing }];
};

const backUpIntents = (text: string, body: Body): BeatIntent[] | null => {
  if (!RE_BACK_UP.test(text)) return null;
  const idx = FRAMING_STEPS.indexOf(body.framing);
  const framing = FRAMING_STEPS[Math.max(idx - 1, 0)] ?? body.framing;
  return [{ type: "framing", framing }];
};

const toyIntents = (text: string): BeatIntent[] | null => {
  if (!RE_TOY_ANY.test(text)) return null;
  const toy: "dildo" | "vibrator" = RE_TOY_DILDO.test(text)
    ? "dildo"
    : "vibrator";
  const mode: "mouth" | "external" =
    RE_INSERT.test(text) || RE_SUCK.test(text) ? "mouth" : "external";
  return [
    { type: "fetchProp", prop: toy },
    { type: "useProp", mode },
  ];
};

const touchIntents = (text: string): BeatIntent[] | null =>
  RE_TOUCH.test(text) ? [{ type: "touch" }] : null;

const danceIntents = (text: string): BeatIntent[] | null =>
  RE_DANCE.test(text) ? [{ type: "act", act: "dance" }] : null;

const drinkIntents = (text: string): BeatIntent[] | null =>
  RE_DRINK.test(text)
    ? [
        { type: "fetchProp", prop: "drink" },
        { type: "hold", line: "She takes a small sip, unhurried." },
        { type: "rest" },
      ]
    : null;

const tipIntents = (text: string): BeatIntent[] | null =>
  RE_TIP.test(text)
    ? [
        {
          type: "hold",
          line: "She notices the tip, looks into the webcam, smiles, and blows one kiss.",
        },
      ]
    : null;

const smallTalkIntents = (text: string): BeatIntent[] | null =>
  RE_SMALL_TALK.test(text)
    ? [
        {
          type: "hold",
          line: "She smiles warmly at the webcam and holds her exact pose.",
        },
      ]
    : null;

const genericActionIntents = (text: string): BeatIntent[] | null =>
  RE_GENERIC_ACTION.test(text)
    ? [{ type: "verbatim", text: text.trim().slice(0, 300) }]
    : null;

const fallbackIntents = (): BeatIntent[] => [
  {
    type: "hold",
    line: "She gives a friendly acknowledgement and holds her exact pose.",
  },
];

const negatedIntents = (): BeatIntent[] => [
  {
    type: "hold",
    line: "She hears the request but stays exactly as she is, smiling, and keeps going.",
  },
];

const CORRECTION_GARMENT_WORDS = "top|shirt|bra|bottoms?|panties";
const RE_GARMENT_CORRECTION = new RegExp(
  `\\bnot\\s+(?:the\\s+|your\\s+|ur\\s+)?(${CORRECTION_GARMENT_WORDS})\\b[^,]*,\\s*(?:the\\s+|your\\s+|ur\\s+)?(${CORRECTION_GARMENT_WORDS})\\b`,
  "i",
);

const garmentWordToId = (word: string): GarmentId => {
  const lower = word.toLowerCase();
  if (lower === "shirt") return "top";
  if (lower.startsWith("bottom")) return "bottom";
  if (lower === "bra") return "bra";
  return "panties";
};

const garmentCorrectionIntents = (text: string): BeatIntent[] | null => {
  const match = RE_GARMENT_CORRECTION.exec(text);
  if (!match?.[2]) return null;
  return [{ type: "removeGarment", garment: garmentWordToId(match[2]) }];
};

const matchIntents = (
  text: string,
  wardrobe: Wardrobe,
  body: Body,
): BeatIntent[] | null =>
  dressIntents(text, wardrobe) ??
  stripAllIntents(text) ??
  teaseIntents(text, wardrobe) ??
  stripGarmentIntents(text) ??
  revealIntents(text) ??
  gestureIntents(text) ??
  tongueIntents(text) ??
  spankIntents(text) ??
  squeezeIntents(text) ??
  boobPlayIntents(text) ??
  bounceIntents(text) ??
  doggyIntents(text) ??
  bendOverIntents(text, body) ??
  crawlIntents(text) ??
  spreadIntents(text, body) ??
  twerkIntents(text) ??
  spinIntents(text) ??
  comeCloserIntents(text, body) ??
  backUpIntents(text, body) ??
  poseIntents(text, body) ??
  toyIntents(text) ??
  touchIntents(text) ??
  danceIntents(text) ??
  drinkIntents(text) ??
  tipIntents(text) ??
  smallTalkIntents(text) ??
  genericActionIntents(text) ??
  null;

// --- Negation ----------------------------------------------------------------

const RE_NEGATION_CUE =
  /\b(don'?t|do not|doesn'?t|does not|didn'?t|did not|never mind|never|won'?t|stop)\b/i;
const RE_NO_CUE = /\bno\b(?!\s+way\b)/i;

const isNegatedClause = (clause: string): boolean =>
  RE_NEGATION_CUE.test(clause) || RE_NO_CUE.test(clause);

// The intent types that change wardrobe, contact, or apply a toy — content-safety gating cares
// about these specifically when deciding whether a negation should actually cancel the act.
const EXPLICIT_INTENT_TYPES = new Set([
  "removeGarment",
  "addGarment",
  "useProp",
  "touch",
]);

const intentIsExplicit = (intent: BeatIntent): boolean =>
  EXPLICIT_INTENT_TYPES.has(intent.type) ||
  (intent.type === "act" && EXPLICIT_ACTS.has(intent.act));

// --- Multi-act clause splitting ----------------------------------------------

const STRONG_CLAUSE_SPLIT = /\b(?:and then|after that|then|next)\b|,/gi;

const splitClauses = (
  text: string,
  wardrobe: Wardrobe,
  body: Body,
): string[] => {
  const strongParts = text
    .split(STRONG_CLAUSE_SPLIT)
    .map((part) => part.trim())
    .filter(Boolean);
  const parts = strongParts.length > 0 ? strongParts : [text.trim()];
  const result: string[] = [];
  for (const part of parts) {
    const andMatch = /\band\b/i.exec(part);
    if (!andMatch) {
      result.push(part);
      continue;
    }
    const left = part.slice(0, andMatch.index).trim();
    const right = part.slice(andMatch.index + andMatch[0].length).trim();
    if (
      left &&
      right &&
      matchIntents(left, wardrobe, body) &&
      matchIntents(right, wardrobe, body)
    ) {
      result.push(left, right);
    } else {
      result.push(part);
    }
  }
  return result;
};

const dedupeConsecutiveIntents = (intents: BeatIntent[]): BeatIntent[] =>
  intents.filter(
    (intent, i) =>
      i === 0 || JSON.stringify(intent) !== JSON.stringify(intents[i - 1]),
  );

// Contract caps followUps at 6, plus the primary beat itself.
const MAX_TOTAL_BEATS = 7;

const capIntents = (intents: BeatIntent[]): BeatIntent[] => {
  if (intents.length > MAX_TOTAL_BEATS) {
    console.warn(
      `resolveIntents: request resolved to ${intents.length} intents, dropping the tail beyond ${MAX_TOTAL_BEATS}`,
    );
    return intents.slice(0, MAX_TOTAL_BEATS);
  }
  return intents;
};

// Clause-to-clause state isn't simulated here; a stale default self-filters via isIntentSatisfied later.
const resolveIntents = (
  text: string,
  wardrobe: Wardrobe,
  body: Body,
): BeatIntent[] => {
  const correction = garmentCorrectionIntents(text);
  if (correction) {
    return capIntents(dedupeConsecutiveIntents(correction));
  }

  const clauses = splitClauses(text, wardrobe, body);
  const allIntents: BeatIntent[] = [];

  for (const clause of clauses) {
    const intents = matchIntents(clause, wardrobe, body);
    if (isNegatedClause(clause)) {
      const negatesRealAct = intents?.some(intentIsExplicit) ?? false;
      if (negatesRealAct || !intents) {
        allIntents.push(...negatedIntents());
        continue;
      }
    }
    if (!intents) {
      // In a multi-step message an uncatalogued clause still must surface as a beat, not vanish (was silently dropping middle asks); a lone message falls through below to the friendlier generic hold instead.
      const trimmed = clause.trim();
      if (clauses.length > 1 && trimmed.length > 0) {
        allIntents.push({ type: "verbatim", text: trimmed.slice(0, 300) });
      }
      continue;
    }
    allIntents.push(...intents);
  }

  if (allIntents.length === 0) {
    allIntents.push(...fallbackIntents());
  }

  return capIntents(dedupeConsecutiveIntents(allIntents));
};

const alreadyLine = (intent: BeatIntent): string => {
  switch (intent.type) {
    case "removeGarment":
      return `Her ${GARMENT_LABEL[intent.garment]} is already off. She stays exactly as she is and smiles.`;
    case "addGarment":
      return `She is already wearing her ${GARMENT_LABEL[intent.garment]}. She stays exactly as she is and smiles.`;
    case "pose":
    case "framing":
    case "fetchProp":
    case "rest":
      return "She is already exactly there. She holds the pose and smiles.";
    default:
      return "She holds her exact pose and smiles.";
  }
};

// Drops as many leading intents as are already true of `state`; since none of them change
// anything, the state used for this check never needs to advance between them.
const leadingSatisfiedCount = (
  intents: BeatIntent[],
  state: LiveState,
): number => {
  let i = 0;
  while (
    i < intents.length &&
    isIntentSatisfied(intents[i] as BeatIntent, state)
  ) {
    i += 1;
  }
  return i;
};

// --- Job handlers ------------------------------------------------------------

const GREETING_LINE =
  "hey everyone, so glad you're here! say hi or tell me what you want";

const planGreeting = (
  session: LiveSessionSnapshot,
  speechMode: SpeechMode,
): ClipPlan => {
  const { state, creator } = session;
  const nextBody = { ...state.baselineBody };
  const action =
    "GREETING: she looks up and notices the room, a few viewers already here, gives a warm wave and " +
    "smile, then settles back into exactly the pose and framing she started in.";
  const expectedState: LiveState = { ...state, body: nextBody };
  const durationSec = LIVE_TUNABLES.ACTION_CLIP_SEC;
  const prompt = buildPrompt({
    state,
    speechMode,
    creator,
    action,
    nextWardrobe: state.wardrobe,
    nextBody,
    explicit: false,
    durationSec,
  });
  return {
    prompt,
    durationSec,
    expectedState,
    followUps: [],
    replyDraft: {
      channel: "chat",
      typingLeadSec: typingLeadSecFor(GREETING_LINE),
    },
    needsReplyText: false,
    fixedReplyText: GREETING_LINE,
    wardrobeIntent: null,
    explicit: false,
  };
};

// Rotates so idle clips don't all read as the identical frozen loop; picked from elapsed time so it stays deterministic/testable, and never changes pose/clothing/props (idle clips loop start=end).
const IDLE_LIFE_VARIANTS: readonly string[] = [
  "breathing, blinking, a glance at the chat, a tiny weight shift, a tuck of her hair",
  "glancing over at her screen as if reading something in the chat, a small smile, then her eyes back on the lens",
  "a slow blink, rolling her shoulders once in a small stretch, then settling back still",
  "glancing down and to the side for a moment as if thinking, then back up at the lens with a smile",
  "adjusting her hair or glasses with one hand, her eyes flicking to the chat and back",
];
// If she's already holding her phone, reading it in place is more natural than the generic catalogue.
const IDLE_PHONE_VARIANT =
  "glancing down at the phone already in her hand, thumb moving briefly like she's reading something, then looking back up at the lens";

const idleLifeLine = (elapsedSec: number, hasPhone: boolean): string => {
  if (hasPhone) return IDLE_PHONE_VARIANT;
  const index =
    Math.floor(elapsedSec / LIVE_TUNABLES.IDLE_CLIP_SEC) %
    IDLE_LIFE_VARIANTS.length;
  return IDLE_LIFE_VARIANTS[index] ?? (IDLE_LIFE_VARIANTS[0] as string);
};

const planIdle = (session: LiveSessionSnapshot): ClipPlan => {
  const { state, creator } = session;
  // Idle never advances an act, even mid-act: a self-touch pauses; a held prop stays put.
  const nextBody: Body =
    state.body.contact === "self"
      ? {
          ...state.body,
          contact: "none",
          hands: state.body.hands === "onBody" ? "free" : state.body.hands,
        }
      : state.body;
  const pauseLine =
    state.body.contact === "self"
      ? "Her hand that was on her own body eases off and rests at her side or on her leg — she is paused, not mid-act."
      : state.body.hands === "holdingProp"
        ? "The current prop stays held still in her hand; she does not use it this clip."
        : "";
  const lifeLine = idleLifeLine(session.elapsedSec, nextBody.prop === "phone");
  const action = [
    `IDLE, between requests. She stays ${nextBody.pose}, exactly as she is right now, for the entire clip — ` +
      `only small grounded life on top of that fixed pose: ${lifeLine}. This is a static hold, not a scene ` +
      "with a beginning and an end.",
    `FORBIDDEN this clip: no change of pose category (if she is ${nextBody.pose} now, she never sits, stands, ` +
      "kneels, or lies down — she stays exactly that way start to finish), no clothing change, no new prop, " +
      "no sexual act starting or continuing, no leaving frame.",
    "Her hands stay exactly where the first frame shows them — never onto her own clothes, never onto a new object.",
    pauseLine,
    "The clip must END in the same pose, framing, expression baseline, and hand position it started in — " +
      "treat any motion as a small excursion that always returns to the exact start.",
  ]
    .filter(Boolean)
    .join(" ");
  const expectedState: LiveState = { ...state, body: nextBody };
  const durationSec = LIVE_TUNABLES.IDLE_CLIP_SEC;
  const prompt = buildPrompt({
    state,
    speechMode: "text", // no dialogue in this job; native speech would invent mouthing
    creator,
    action,
    nextWardrobe: state.wardrobe,
    nextBody,
    explicit: false,
    durationSec,
  });
  return {
    prompt,
    durationSec,
    expectedState,
    followUps: [],
    replyDraft: null,
    needsReplyText: false,
    fixedReplyText: null,
    wardrobeIntent: null,
    explicit: false,
  };
};

const planCheckIn = (
  session: LiveSessionSnapshot,
  job: Extract<ClipJob, { kind: "checkIn" }>,
  speechMode: SpeechMode,
): ClipPlan => {
  const { state, creator } = session;
  const action =
    "She stays in her exact pose, glances at the chat, and gives a short check-in — small grounded " +
    "life only, nothing else changes.";
  const durationSec = LIVE_TUNABLES.ACTION_CLIP_SEC;
  const prompt = buildPrompt({
    state,
    speechMode,
    creator,
    action,
    nextWardrobe: state.wardrobe,
    nextBody: state.body,
    explicit: false,
    durationSec,
  });
  return {
    prompt,
    durationSec,
    expectedState: state,
    followUps: [],
    replyDraft: { channel: job.channel, typingLeadSec: 0 },
    needsReplyText: true,
    fixedReplyText: null,
    wardrobeIntent: null,
    explicit: false,
  };
};

// Laptop lead-in from her chair with a free hand, her phone otherwise; eats into the beat's own time window like the prop-setdown/sit-up lead-ins above rather than growing it.
const typingLeadLine = (device: "laptop" | "phone", leadSec: number): string =>
  device === "laptop"
    ? `0-${leadSec}s: she glances at the chat and types a quick reply on her laptop, eyes flicking between the screen and the lens.`
    : `0-${leadSec}s: she glances at the chat, picks up her phone, types a quick reply, then sets it back down.`;

const planReply = (
  session: LiveSessionSnapshot,
  job: Extract<ClipJob, { kind: "reply" }>,
  speechMode: SpeechMode,
): ClipPlan => {
  const { state, creator } = session;
  const intents = resolveIntents(job.text, state.wardrobe, state.body);
  const dropped = leadingSatisfiedCount(intents, state);
  const allSatisfied = dropped >= intents.length;
  const lastIntent = intents[intents.length - 1];
  const first: BeatIntent = allSatisfied
    ? { type: "hold", line: alreadyLine(lastIntent as BeatIntent) }
    : (intents[dropped] as BeatIntent);
  const restIntents = allSatisfied ? [] : intents.slice(dropped + 1);

  const beatPlan = planBeatIntent(first, state);
  const durationSec = clampDuration(beatPlan.durationSec);

  let physical = beatPlan.physical;
  // Only the first reply after a genuine idle stretch opens on typing — a rapid back-to-back
  // exchange would show her "typing" before every single message, which reads as slow, not real.
  if (job.channel === "chat" && job.precededByIdle) {
    const leadSec = Math.max(1, Math.round(typingLeadSecFor(job.text)));
    const device: "laptop" | "phone" =
      state.body.pose === "sitting" && state.body.hands === "free"
        ? "laptop"
        : "phone";
    physical =
      `${typingLeadLine(device, leadSec)} ` +
      shiftChoreoTimes(beatPlan.physical, leadSec, durationSec);
  }

  const expectedState: LiveState = {
    ...state,
    wardrobe: beatPlan.nextWardrobe,
    body: beatPlan.nextBody,
  };
  const prompt = buildPrompt({
    state,
    speechMode,
    creator,
    action: physical,
    nextWardrobe: beatPlan.nextWardrobe,
    nextBody: beatPlan.nextBody,
    explicit: beatPlan.explicit,
    durationSec,
    leadWithAction: true,
  });

  // One slot reserved below for the plan's own terminal return-to-idle step.
  let cappedFollowUps = restIntents;
  if (cappedFollowUps.length > 5) {
    console.warn(
      `planReply: ${cappedFollowUps.length} follow-up intents resolved, dropping the tail beyond the contract's 6-beat cap`,
    );
    cappedFollowUps = cappedFollowUps.slice(0, 5);
  }
  // Every plan ends on an explicit return-to-idle step; nextJob() drops it as a no-op if she's
  // already at baseline, so this is free when the request's own last beat already settles her.
  const lastPlannedIntent =
    cappedFollowUps[cappedFollowUps.length - 1] ?? first;
  if (lastPlannedIntent.type !== "rest") {
    cappedFollowUps = [...cappedFollowUps, { type: "rest" }];
  }
  const followUps: PlannedBeat[] = cappedFollowUps.map((intent, index) => ({
    id: `${job.requestId}-follow-${index}`,
    intent,
    attempt: 0,
    // Lets the director cancel only this request's dependents if a step of it fails.
    requestId: job.requestId,
  }));

  // Matches the physical lead-in gate above: no idle stretch, no typing beat anywhere in the reply.
  const typingLeadSec =
    job.channel === "chat" && job.precededByIdle
      ? typingLeadSecFor(job.text)
      : 0;

  const wardrobeIntent: ClipPlan["wardrobeIntent"] =
    first.type === "removeGarment"
      ? "remove"
      : first.type === "addGarment"
        ? "add"
        : null;
  const targetGarment: GarmentId | undefined =
    first.type === "removeGarment" || first.type === "addGarment"
      ? first.garment
      : undefined;

  return {
    prompt,
    durationSec,
    expectedState,
    followUps,
    replyDraft: { channel: job.channel, typingLeadSec },
    needsReplyText: true,
    fixedReplyText: null,
    wardrobeIntent,
    targetGarment,
    explicit: beatPlan.explicit,
  };
};

const planBeat = (
  session: LiveSessionSnapshot,
  job: Extract<ClipJob, { kind: "beat" }>,
): ClipPlan => {
  const { state, creator } = session;
  const beatPlan = planBeatIntent(job.beat.intent, state);
  const durationSec = clampDuration(beatPlan.durationSec);
  const expectedState: LiveState = {
    ...state,
    wardrobe: beatPlan.nextWardrobe,
    body: beatPlan.nextBody,
  };
  const prompt = buildPrompt({
    state,
    speechMode: "text", // no dialogue in this job; native speech would invent mouthing
    creator,
    action: beatPlan.physical,
    nextWardrobe: beatPlan.nextWardrobe,
    nextBody: beatPlan.nextBody,
    explicit: beatPlan.explicit,
    durationSec,
    leadWithAction: true,
  });
  const followUps: PlannedBeat[] = [];
  const beatIntent = job.beat.intent;
  const wardrobeIntent: ClipPlan["wardrobeIntent"] =
    beatIntent.type === "removeGarment"
      ? "remove"
      : beatIntent.type === "addGarment"
        ? "add"
        : null;
  const targetGarment: GarmentId | undefined =
    beatIntent.type === "removeGarment" || beatIntent.type === "addGarment"
      ? beatIntent.garment
      : undefined;
  return {
    prompt,
    durationSec,
    expectedState,
    followUps,
    replyDraft: null,
    needsReplyText: false,
    fixedReplyText: null,
    wardrobeIntent,
    targetGarment,
    explicit: beatPlan.explicit,
  };
};

export const planClip = ({
  session,
  job,
  speechMode,
  backend = "turbo",
}: {
  session: LiveSessionSnapshot;
  job: ClipJob;
  speechMode: SpeechMode;
  backend?: RenderBackend;
}): ClipPlan => {
  const plan = ((): ClipPlan => {
    switch (job.kind) {
      case "greeting":
        return planGreeting(session, speechMode);
      case "idle":
        return planIdle(session);
      case "checkIn":
        return planCheckIn(session, job, speechMode);
      case "reply":
        return planReply(session, job, speechMode);
      case "beat":
        return planBeat(session, job);
    }
  })();
  // Greeting has no "earlier moment" yet (the reference image IS its starting frame).
  return backend === "reference" && job.kind !== "greeting"
    ? { ...plan, prompt: `${CONTINUITY_LOCK} ${plan.prompt}` }
    : plan;
};
