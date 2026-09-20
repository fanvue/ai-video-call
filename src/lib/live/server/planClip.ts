import {
  LIVE_TUNABLES,
  type Body,
  type ClipJob,
  type CreatorProfile,
  type GarmentId,
  type InputChannel,
  type LiveSessionSnapshot,
  type LiveState,
  type PlannedBeat,
  type Pose,
  type Prop,
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
};

// Timing rule: chained action beats run the full ACTION_CLIP_SEC; explicit no-ops stay IDLE_CLIP_SEC.
const ACTION_BEAT_SEC = LIVE_TUNABLES.ACTION_CLIP_SEC;

const clampDuration = (sec: number): number =>
  Math.min(
    LIVE_TUNABLES.MAX_CLIP_SEC,
    Math.max(LIVE_TUNABLES.MIN_CLIP_SEC, Math.round(sec)),
  );

export const typingLeadSecFor = (text: string): number => {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  // Long enough to read as her typing a reply before the act starts, not a blink-and-miss beat.
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
  "PHYSICS: fabric has real weight, one garment moves at a time, hands do one thing at a time, she shifts " +
  "her weight before standing. Nothing teleports, dissolves, or regrows mid-clip.";

const NO_OVERLAY_LOCK = "No text overlays, no watermark, no subtitles, no UI.";

// Reply/beat/settle/redress clips chain: their last frame becomes the next clip's anchor, so it
// must land clean rather than mid-motion.
const END_STILL_LOCK =
  "Final second: settle to a still, stable end pose (no mid-motion blur) so the next clip can continue cleanly.";

const SPEECH_RULES_NATIVE =
  "She speaks clear everyday English, lip-synced word for word to what she says.";

const speechLockLine = (speechMode: SpeechMode): string =>
  speechMode === "text"
    ? "SPEECH: she does not speak. Lips closed or relaxed, no mouthing words. Ambient room audio only, no dialogue."
    : SPEECH_RULES_NATIVE;

const lookLockLine = (lookLock: string): string =>
  `LOOK LOCK: ${lookLock} Do not beautify, slim, age, or swap her. One person only.`;

const GARMENT_ORDER: GarmentId[] = ["top", "bottom", "bra", "panties"];
const GARMENT_LABEL: Record<GarmentId, string> = {
  top: "top",
  bottom: "bottoms",
  bra: "bra",
  panties: "panties",
};

const wardrobeLockLine = (wardrobe: Wardrobe): string => {
  const parts = GARMENT_ORDER.map(
    (id) =>
      `${GARMENT_LABEL[id]} (${wardrobe[id].description}) ${wardrobe[id].on ? "ON" : "OFF"}`,
  );
  return `WARDROBE LOCK, right now: ${parts.join("; ")}. Change only what this clip's instruction names.`;
};

const PROP_LABEL: Record<Prop, string> = {
  none: "empty",
  fetching: "reaching off-screen, nothing visible yet",
  vibrator: "a vibrator",
  dildo: "a dildo",
  drink: "a drink",
  phone: "her phone",
};

const propLockLine = (prop: Prop): string =>
  prop === "none"
    ? "PROP LOCK: her hands are empty. Nothing appears unless fetched on camera this clip."
    : `PROP LOCK: the only object in frame is ${PROP_LABEL[prop]}. Nothing else appears.`;

const POSE_DESCRIPTION: Record<Pose, string> = {
  sitting: "sitting in her chair at the desk",
  standing: "standing",
  leaning: "leaning against the desk",
  kneeling: "kneeling",
  lying: "lying down",
  onAllFours: "on her hands and knees",
  bentOver: "bent over, hands braced",
};

const FACING_LABEL: Record<Body["facing"], string> = {
  camera: "the webcam",
  away: "away from the webcam",
  side: "to the side of the webcam",
};

// Shared by every beat that turns/moves her: the transition beat's own physical line.
const FACING_TRANSITION_LABEL: Record<Body["facing"], string> = {
  camera: "facing the webcam",
  away: "with her back to the webcam",
  side: "at an angle to the webcam",
};

const HANDS_LABEL: Record<Body["hands"], string> = {
  free: "empty",
  typing: "on the off-screen keyboard",
  onBody: "on her own body",
  holdingProp: "holding the current prop",
};

const bodyLockLine = (body: Body): string =>
  `CURRENT POSE: ${POSE_DESCRIPTION[body.pose]}, facing ${FACING_LABEL[body.facing]}, ` +
  `hands ${HANDS_LABEL[body.hands]}, framing ${body.framing}.`;

const endStateLine = (wardrobe: Wardrobe, body: Body): string => {
  const parts = GARMENT_ORDER.map(
    (id) => `${GARMENT_LABEL[id]} ${wardrobe[id].on ? "on" : "off"}`,
  );
  return (
    `END STATE for this clip: ${parts.join(", ")}; pose ${body.pose}, ` +
    `facing ${body.facing}, hands ${body.hands}, prop ${body.prop}.`
  );
};

const composeLocks = (
  state: LiveState,
  speechMode: SpeechMode,
  lookLock: string,
  // Overrides the body used for the PROP LOCK / CURRENT POSE lines only (e.g. phone typing, which
  // picks up an object mid-clip that the committed state doesn't hold). Never affects `expectedState`.
  lockBodyOverride?: Body,
): string[] => {
  const lockBody = lockBodyOverride ?? state.body;
  return [
    CAMERA_LOCK,
    ANATOMY_LOCK,
    lookLockLine(lookLock),
    wardrobeLockLine(state.wardrobe),
    propLockLine(lockBody.prop),
    bodyLockLine(lockBody),
    PHYSICS_LOCK,
    NO_OVERLAY_LOCK,
    speechLockLine(speechMode),
  ];
};

const buildPrompt = (params: {
  state: LiveState;
  speechMode: SpeechMode;
  creator: CreatorProfile;
  action: string;
  nextWardrobe: Wardrobe;
  nextBody: Body;
  lockBodyOverride?: Body;
}): string => {
  const locks = composeLocks(
    params.state,
    params.speechMode,
    params.creator.lookLock,
    params.lockBodyOverride,
  );
  return [
    ...locks,
    params.action,
    endStateLine(params.nextWardrobe, params.nextBody),
  ].join(" ");
};

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

// --- Reply intent catalog ---------------------------------------------------

type Beat = {
  physical: string;
  nextWardrobe: Wardrobe;
  nextBody: Body;
  durationSec: number;
};

const GARMENT_PATTERN: Record<GarmentId, RegExp> = {
  top: /\b(top|shirt|tee|blouse|tank)\b/i,
  bottom: /\b(bottoms?|pants|shorts|skirt|trousers)\b/i,
  bra: /\bbra\b/i,
  panties: /\b(panties|thong|underwear|knickers)\b/i,
};

// A dress or one-piece is captured as the top garment; "dressed"/"dress up" are redress verbs, not this.
const RE_ONE_PIECE =
  /\b(dress|one[- ]piece|romper|jumpsuit|lingerie|outfit)\b/i;
const RE_OFF_VERB = /\b(off|remove|take off|slide off|pull down|down|strip)\b/i;
// A bare removal verb with no named garment ("take it off") means the top layer.
const RE_GENERIC_OFF = /\b(take|pull|slide|rip) it off\b/i;
const RE_DRESS =
  /\b(put (your |the )?(top|shirt|bra|bottoms?|panties|clothes) (back )?on|get dressed|cover (yourself )?up|dress (yourself )?up?)\b/i;
// Bare "strip" (no qualifier) must match on its own, not only "strip <it all|everything>".
const RE_EVERYTHING =
  /\b(naked|nude|get naked|everything off|all off|nothing on)\b|\bstrip\b(?:\s+(?:it all|everything))?/i;
const RE_TEASE_STRAP = /\b(bra strap|strap tease|shoulder strap)\b/i;
const RE_TEASE_WAIST =
  /\b(panty tease|waistband (tease|snap|pull)|flash (your |ur )?panties)\b/i;
const RE_TEASE_HEM =
  /\b(tease|lift (your |the )?(top|hem|shirt)|flash (your |ur )?(top|chest|tits)|peek)\b/i;
const RE_FACE_CAMERA =
  /\b(face (the )?(camera|webcam|lens)|face me|look at me)\b/i;
const RE_FACE_AWAY =
  /\b(turn around|turn your back|face away|show (me )?(your |ur )?ass|from behind|booty)\b/i;
const RE_TOY_ANY = /\b(dildos?|vibrators?|vibes?|wands?|toys?)\b/i;
const RE_TOY_DILDO = /\bdildos?\b/i;
const RE_INSERT =
  /\b(insert|inside (her|your|my)|stick it in|in (her|your|my) (pussy|cunt|ass|butt))\b/i;
const RE_TOUCH =
  /\b(touch (yourself|your (pussy|clit))|masturbat\w*|finger\w* yourself|insert (your |a )?fingers?|play with (yourself|your (pussy|clit))|rub (your (pussy|clit)|yourself)|joi|jerk[\s-]?off)\b/i;
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
  /\b(jiggle (your |ur |her )?(tits|boobs|chest)|bounce (your |ur |her )?(tits|boobs|chest)|bounce for me)\b/i;
const RE_DOGGY = /\b(doggy\w*|all fours|hands and knees)\b/i;
const RE_BEND = /\bbend(ing)?\s+over\b/i;
const RE_CRAWL = /\bcrawl(ing)?\b/i;
const RE_SPREAD = /\bspread (your |ur )?legs\b/i;
const RE_TWERK =
  /\bshake (your |ur |that |her )?(ass|booty)\b|\bshake it\b|\btwerk\w*\b|\bbooty\b/i;
const RE_COME_CLOSER =
  /\b(come closer|move closer|get closer|closer to (the )?camera)\b/i;
const RE_BACK_UP = /\b(back up|move back|step back|further away|get back)\b/i;

const RE_POSE: Partial<Record<Pose, RegExp>> = {
  standing: /\b(stand up|get up|on your feet)\b/i,
  sitting: /\b(sit( down)?|sit back down)\b/i,
  leaning: /\blean(ing)?\b/i,
  lying: /\b(lie down|lay down|on your back|on the bed|on the floor)\b/i,
  kneeling: /\b(kneel|on your knees)\b/i,
};

const dressBeats = (
  text: string,
  wardrobe: Wardrobe,
  body: Body,
): Beat[] | null => {
  if (!RE_DRESS.test(text)) return null;
  const named = GARMENT_ORDER.find(
    (id) => GARMENT_PATTERN[id].test(text) && !isOn(wardrobe, id),
  );
  const garment = named ?? lastRemoved(wardrobe);
  if (!garment) {
    return [
      {
        physical:
          "She is already fully dressed. She smiles and stays exactly as she is.",
        nextWardrobe: wardrobe,
        nextBody: body,
        durationSec: LIVE_TUNABLES.IDLE_CLIP_SEC,
      },
    ];
  }
  const desc = describeGarment(wardrobe, garment);
  return [
    {
      physical:
        `REDRESS, one garment. She picks up her ${GARMENT_LABEL[garment]} (${desc}), which is off, ` +
        "and puts it back on, grounded and unhurried. Nothing else changes.",
      nextWardrobe: addGarment(wardrobe, garment),
      nextBody: body,
      durationSec: ACTION_BEAT_SEC,
    },
  ];
};

const stripAllBeats = (
  text: string,
  wardrobe: Wardrobe,
  body: Body,
): Beat[] | null => {
  if (!RE_EVERYTHING.test(text)) return null;
  const toRemove = GARMENT_ORDER.filter((id) => isOn(wardrobe, id));
  if (toRemove.length === 0) {
    return [
      {
        physical:
          "She is already completely undressed. She holds the pose and smiles.",
        nextWardrobe: wardrobe,
        nextBody: body,
        durationSec: LIVE_TUNABLES.IDLE_CLIP_SEC,
      },
    ];
  }
  let current = wardrobe;
  const beats: Beat[] = [];
  for (const id of toRemove) {
    const desc = describeGarment(current, id);
    const next = removeGarment(current, id);
    beats.push({
      physical:
        `STRIP TEASE, one garment only. She slowly takes off her ${GARMENT_LABEL[id]} (${desc}) — ` +
        "the exact garment visible now, no substitute — and it leaves the frame. Nothing else comes off this clip.",
      nextWardrobe: next,
      nextBody: { ...body, hands: "free", contact: "none" },
      durationSec: ACTION_BEAT_SEC,
    });
    current = next;
  }
  return beats;
};

const teaseBeats = (
  text: string,
  wardrobe: Wardrobe,
  body: Body,
): Beat[] | null => {
  if (RE_TEASE_STRAP.test(text)) {
    return [
      {
        physical:
          `TEASE ONLY, no removal. She slides her bra strap (${describeGarment(wardrobe, "bra")}) ` +
          "off one shoulder with a finger, holds it, then lets it snap back. Nothing comes off.",
        nextWardrobe: wardrobe,
        nextBody: body,
        durationSec: ACTION_BEAT_SEC,
      },
    ];
  }
  if (RE_TEASE_WAIST.test(text)) {
    return [
      {
        physical:
          `TEASE ONLY, no removal. She hooks a thumb in her panties (${describeGarment(wardrobe, "panties")}) ` +
          "waistband, tugs it out, and lets it snap back. Nothing comes off.",
        nextWardrobe: wardrobe,
        nextBody: body,
        durationSec: ACTION_BEAT_SEC,
      },
    ];
  }
  if (RE_TEASE_HEM.test(text) && !RE_OFF_VERB.test(text)) {
    return [
      {
        physical:
          `TEASE ONLY, no removal. She lifts the hem of her top (${describeGarment(wardrobe, "top")}) ` +
          "a few inches, holds it, then lets it drop. The top stays on.",
        nextWardrobe: wardrobe,
        nextBody: body,
        durationSec: ACTION_BEAT_SEC,
      },
    ];
  }
  return null;
};

const stripGarmentBeats = (
  text: string,
  wardrobe: Wardrobe,
  body: Body,
): Beat[] | null => {
  if (!RE_OFF_VERB.test(text)) return null;
  const target =
    GARMENT_ORDER.find((id) => GARMENT_PATTERN[id].test(text)) ??
    (RE_ONE_PIECE.test(text) || RE_GENERIC_OFF.test(text) ? "top" : undefined);
  if (!target) return null;
  if (!isOn(wardrobe, target)) {
    return [
      {
        physical: `Her ${GARMENT_LABEL[target]} is already off. She stays exactly as she is and smiles.`,
        nextWardrobe: wardrobe,
        nextBody: body,
        durationSec: LIVE_TUNABLES.IDLE_CLIP_SEC,
      },
    ];
  }
  const desc = describeGarment(wardrobe, target);
  return [
    {
      physical:
        `STRIP TEASE, one garment only. She slowly takes off her ${GARMENT_LABEL[target]} (${desc}) — ` +
        "the exact garment visible now, no substitute — and it leaves the frame. No other garment moves.",
      nextWardrobe: removeGarment(wardrobe, target),
      nextBody: { ...body, hands: "free", contact: "none" },
      durationSec: ACTION_BEAT_SEC,
    },
  ];
};

const poseBeats = (
  text: string,
  wardrobe: Wardrobe,
  body: Body,
): Beat[] | null => {
  const poseEntry = (Object.entries(RE_POSE) as [Pose, RegExp][]).find(
    ([, re]) => re.test(text),
  );
  const wantsFaceCamera = RE_FACE_CAMERA.test(text);
  const wantsFaceAway = RE_FACE_AWAY.test(text) && !wantsFaceCamera;
  if (!poseEntry && !wantsFaceCamera && !wantsFaceAway) return null;
  const nextPose = poseEntry?.[0] ?? body.pose;
  const nextFacing: Body["facing"] = wantsFaceCamera
    ? "camera"
    : wantsFaceAway
      ? "away"
      : body.facing;
  const nextBody: Body = { ...body, pose: nextPose, facing: nextFacing };
  return [
    {
      physical:
        `She moves from her current pose into ${POSE_DESCRIPTION[nextPose]}, ${FACING_TRANSITION_LABEL[nextFacing]}. ` +
        "The fixed webcam does not move. No clothing changes.",
      nextWardrobe: wardrobe,
      nextBody,
      durationSec: ACTION_BEAT_SEC,
    },
  ];
};

// A transition beat used whenever a new intent needs a pose/facing the current state isn't in yet.
const transitionBeat = (
  wardrobe: Wardrobe,
  body: Body,
  targetPose: Pose,
  targetFacing: Body["facing"],
): Beat => ({
  physical:
    `She moves from her current pose into ${POSE_DESCRIPTION[targetPose]}, ${FACING_TRANSITION_LABEL[targetFacing]}. ` +
    "The fixed webcam does not move. No clothing changes.",
  nextWardrobe: wardrobe,
  nextBody: { ...body, pose: targetPose, facing: targetFacing },
  durationSec: ACTION_BEAT_SEC,
});

const gestureBeats = (
  text: string,
  wardrobe: Wardrobe,
  body: Body,
): Beat[] | null => {
  if (!RE_GESTURE.test(text)) return null;
  return [
    {
      physical:
        "She gives a warm wave and smiles at the webcam, maybe a small wink or a blown kiss. " +
        "No clothing changes, nothing new appears.",
      nextWardrobe: wardrobe,
      nextBody: body,
      durationSec: LIVE_TUNABLES.IDLE_CLIP_SEC,
    },
  ];
};

const tongueBeats = (
  text: string,
  wardrobe: Wardrobe,
  body: Body,
): Beat[] | null => {
  if (!RE_TONGUE.test(text)) return null;
  return [
    {
      physical:
        "She sticks her tongue out playfully or slowly licks her lips, holding her exact pose. " +
        "No clothing changes, nothing new appears.",
      nextWardrobe: wardrobe,
      nextBody: body,
      durationSec: LIVE_TUNABLES.IDLE_CLIP_SEC,
    },
  ];
};

const bounceBeats = (
  text: string,
  wardrobe: Wardrobe,
  body: Body,
): Beat[] | null => {
  if (!RE_BOUNCE.test(text)) return null;
  const physical = isOn(wardrobe, "top")
    ? `She bounces gently, her ${describeGarment(wardrobe, "top")} moving with her. Nothing comes off, nothing else changes.`
    : "She bounces gently, nothing else changes.";
  return [
    {
      physical,
      nextWardrobe: wardrobe,
      nextBody: body,
      durationSec: ACTION_BEAT_SEC,
    },
  ];
};

const doggyBeats = (
  text: string,
  wardrobe: Wardrobe,
  body: Body,
): Beat[] | null => {
  if (!RE_DOGGY.test(text)) return null;
  const beats: Beat[] = [];
  let current = body;
  if (current.pose !== "kneeling" && current.pose !== "onAllFours") {
    const t = transitionBeat(wardrobe, current, "kneeling", current.facing);
    beats.push(t);
    current = t.nextBody;
  }
  beats.push({
    physical:
      "From kneeling, she settles onto her hands and knees, back arched, facing away from the " +
      "webcam, then glances back over her shoulder at the lens. The fixed webcam does not move.",
    nextWardrobe: wardrobe,
    nextBody: { ...current, pose: "onAllFours", facing: "away" },
    durationSec: ACTION_BEAT_SEC,
  });
  return beats;
};

const bendOverBeats = (
  text: string,
  wardrobe: Wardrobe,
  body: Body,
): Beat[] | null => {
  if (!RE_BEND.test(text)) return null;
  const wantsAway = RE_FACE_AWAY.test(text);
  const wantsCamera = RE_FACE_CAMERA.test(text);
  const targetFacing: Body["facing"] = wantsAway
    ? "away"
    : wantsCamera
      ? "camera"
      : body.facing === "side"
        ? "camera"
        : body.facing;
  if (body.pose === "bentOver" && body.facing === targetFacing) {
    return [
      {
        physical: `She holds her bent-over pose, ${FACING_TRANSITION_LABEL[targetFacing]}. No clothing changes.`,
        nextWardrobe: wardrobe,
        nextBody: body,
        durationSec: ACTION_BEAT_SEC,
      },
    ];
  }
  return [transitionBeat(wardrobe, body, "bentOver", targetFacing)];
};

const crawlBeats = (
  text: string,
  wardrobe: Wardrobe,
  body: Body,
): Beat[] | null => {
  if (!RE_CRAWL.test(text)) return null;
  const beats: Beat[] = [];
  let current = body;
  if (current.pose !== "onAllFours" || current.facing !== "camera") {
    const t = transitionBeat(wardrobe, current, "onAllFours", "camera");
    beats.push(t);
    current = t.nextBody;
  }
  const nextFraming: Body["framing"] =
    current.framing === "wider" ? "medium" : "torso";
  beats.push({
    physical:
      "On her hands and knees, she crawls toward the fixed webcam, unhurried — the camera itself " +
      "never moves, only her body gets closer, filling more of the frame.",
    nextWardrobe: wardrobe,
    nextBody: { ...current, framing: nextFraming },
    durationSec: ACTION_BEAT_SEC,
  });
  return beats;
};

const spreadLegsBeats = (
  text: string,
  wardrobe: Wardrobe,
  body: Body,
): Beat[] | null => {
  if (!RE_SPREAD.test(text)) return null;
  const targetPose: Pose =
    body.pose === "sitting" || body.pose === "lying" ? body.pose : "sitting";
  const beats: Beat[] = [];
  let current = body;
  if (current.pose !== targetPose || current.facing !== "camera") {
    const t = transitionBeat(wardrobe, current, targetPose, "camera");
    beats.push(t);
    current = t.nextBody;
  }
  beats.push({
    physical: `She spreads her legs open, staying ${POSE_DESCRIPTION[targetPose]}, facing the webcam. No clothing changes.`,
    nextWardrobe: wardrobe,
    nextBody: current,
    durationSec: ACTION_BEAT_SEC,
  });
  return beats;
};

const twerkBeats = (
  text: string,
  wardrobe: Wardrobe,
  body: Body,
): Beat[] | null => {
  if (!RE_TWERK.test(text)) return null;
  const beats: Beat[] = [];
  let current = body;
  if (current.pose !== "standing" || current.facing !== "away") {
    const t = transitionBeat(wardrobe, current, "standing", "away");
    beats.push(t);
    current = t.nextBody;
  }
  beats.push({
    physical:
      "Standing with her back to the webcam, she shakes and bounces her hips and ass to a beat " +
      "only she can hear. No clothing changes.",
    nextWardrobe: wardrobe,
    nextBody: current,
    durationSec: ACTION_BEAT_SEC,
  });
  return beats;
};

const FRAMING_STEPS: Body["framing"][] = ["wider", "medium", "torso"];

const comeCloserBeats = (
  text: string,
  wardrobe: Wardrobe,
  body: Body,
): Beat[] | null => {
  if (!RE_COME_CLOSER.test(text)) return null;
  const idx = FRAMING_STEPS.indexOf(body.framing);
  const nextFraming =
    FRAMING_STEPS[Math.min(idx + 1, FRAMING_STEPS.length - 1)] ?? body.framing;
  return [
    {
      physical:
        "She moves closer to the fixed webcam, unhurried — the camera itself never moves, only her " +
        "body gets nearer, filling more of the frame.",
      nextWardrobe: wardrobe,
      nextBody: { ...body, framing: nextFraming },
      durationSec: ACTION_BEAT_SEC,
    },
  ];
};

const backUpBeats = (
  text: string,
  wardrobe: Wardrobe,
  body: Body,
): Beat[] | null => {
  if (!RE_BACK_UP.test(text)) return null;
  const idx = FRAMING_STEPS.indexOf(body.framing);
  const nextFraming = FRAMING_STEPS[Math.max(idx - 1, 0)] ?? body.framing;
  return [
    {
      physical:
        "She eases back away from the fixed webcam, unhurried — the camera itself never moves, her " +
        "full body settling further into frame.",
      nextWardrobe: wardrobe,
      nextBody: { ...body, framing: nextFraming },
      durationSec: ACTION_BEAT_SEC,
    },
  ];
};

const toyBeats = (
  text: string,
  wardrobe: Wardrobe,
  body: Body,
): Beat[] | null => {
  if (!RE_TOY_ANY.test(text)) return null;
  const toy: Prop = RE_TOY_DILDO.test(text) ? "dildo" : "vibrator";
  // Policy: no insertion, ever. A direct insertion ask redirects to mouth-only; anything else is external use.
  const useLine = RE_INSERT.test(text)
    ? "She brings it to her mouth and uses it there instead — mouth only, never lower."
    : "She holds it against herself and uses it externally against her skin, external contact only, eyes on the lens.";
  if (body.prop === "none") {
    return [
      {
        physical:
          "One hand reaches off-screen to fetch an object and returns; her pose doesn't change. " +
          "Nothing is visible in her hand yet.",
        nextWardrobe: wardrobe,
        nextBody: { ...body, prop: "fetching", hands: "free" },
        durationSec: ACTION_BEAT_SEC,
      },
      {
        physical: `The same hand returns holding one ${toy}, her own weight visibly gripping it. ${useLine} Only one object is visible.`,
        nextWardrobe: wardrobe,
        nextBody: { ...body, prop: toy, hands: "holdingProp", contact: "self" },
        durationSec: ACTION_BEAT_SEC,
      },
    ];
  }
  const heldToy =
    body.prop === "vibrator" || body.prop === "dildo" ? body.prop : toy;
  return [
    {
      physical: `She keeps the same ${heldToy} already in her hand. ${useLine} Only one object is visible.`,
      nextWardrobe: wardrobe,
      nextBody: {
        ...body,
        prop: heldToy,
        hands: "holdingProp",
        contact: "self",
      },
      durationSec: ACTION_BEAT_SEC,
    },
  ];
};

const touchBeats = (
  text: string,
  wardrobe: Wardrobe,
  body: Body,
): Beat[] | null => {
  if (!RE_TOUCH.test(text)) return null;
  const insertionNote = RE_INSERT.test(text)
    ? " She keeps it external only — no insertion, however it's asked."
    : "";
  return [
    {
      physical:
        "One hand moves onto her own body and stays there, fingers visibly attached, touching herself, " +
        `external contact only, never inserting.${insertionNote} The other arm supports her. No second ` +
        "person, no toy unless one is already held.",
      nextWardrobe: wardrobe,
      nextBody: { ...body, hands: "onBody", contact: "self" },
      durationSec: ACTION_BEAT_SEC,
    },
  ];
};

const danceBeats = (
  text: string,
  wardrobe: Wardrobe,
  body: Body,
): Beat[] | null => {
  if (!RE_DANCE.test(text)) return null;
  return [
    {
      physical:
        "She stands and sways her hips to a beat only she can hear, full body in frame, then eases back toward her seat. No clothing changes.",
      nextWardrobe: wardrobe,
      nextBody: { ...body, pose: "standing" },
      durationSec: ACTION_BEAT_SEC,
    },
  ];
};

const drinkBeats = (
  text: string,
  wardrobe: Wardrobe,
  body: Body,
): Beat[] | null => {
  if (!RE_DRINK.test(text)) return null;
  return [
    {
      physical:
        "One hand reaches off-screen to fetch an object. Nothing is visible in her hand yet.",
      nextWardrobe: wardrobe,
      nextBody: { ...body, prop: "fetching" },
      durationSec: ACTION_BEAT_SEC,
    },
    {
      physical:
        "The same hand returns holding one drink. She takes a small sip, unhurried.",
      nextWardrobe: wardrobe,
      nextBody: { ...body, prop: "drink", hands: "holdingProp" },
      durationSec: ACTION_BEAT_SEC,
    },
    {
      physical:
        "She sets the drink down out of frame. Her hands are empty again.",
      nextWardrobe: wardrobe,
      nextBody: { ...body, prop: "none", hands: "free" },
      durationSec: ACTION_BEAT_SEC,
    },
  ];
};

const tipBeats = (
  text: string,
  wardrobe: Wardrobe,
  body: Body,
): Beat[] | null => {
  if (!RE_TIP.test(text)) return null;
  return [
    {
      physical:
        "She notices the tip, looks into the webcam, smiles, and blows one kiss. Nothing else changes.",
      nextWardrobe: wardrobe,
      nextBody: body,
      durationSec: LIVE_TUNABLES.IDLE_CLIP_SEC,
    },
  ];
};

const smallTalkBeats = (
  text: string,
  wardrobe: Wardrobe,
  body: Body,
): Beat[] | null => {
  if (!RE_SMALL_TALK.test(text)) return null;
  return [
    {
      physical:
        "She smiles warmly at the webcam and holds her exact pose. No clothing changes, nothing new appears.",
      nextWardrobe: wardrobe,
      nextBody: body,
      durationSec: LIVE_TUNABLES.IDLE_CLIP_SEC,
    },
  ];
};

const fallbackBeats = (wardrobe: Wardrobe, body: Body): Beat[] => [
  {
    physical:
      "She gives a friendly acknowledgement and holds her exact pose. NO UNDRESSING LOCK: no clothing " +
      "changes this clip, nothing new appears.",
    nextWardrobe: wardrobe,
    nextBody: body,
    durationSec: LIVE_TUNABLES.IDLE_CLIP_SEC,
  },
];

// Continuing the same prop/act keeps it; an unrelated request puts down whatever is unrelated first.
const dropUnrelatedProp = (text: string, body: Body): Body => {
  const continuesProp =
    RE_TOY_ANY.test(text) || RE_DRINK.test(text) || RE_INSERT.test(text);
  if (body.prop === "none" || body.prop === "fetching" || continuesProp) {
    return body;
  }
  return {
    ...body,
    prop: "none",
    hands: body.hands === "holdingProp" ? "free" : body.hands,
    contact: body.hands === "holdingProp" ? "none" : body.contact,
  };
};

const HELD_OBJECT: Partial<Record<Prop, true>> = {
  vibrator: true,
  dildo: true,
  drink: true,
};

// An unrelated request first sets down whatever hand-held object was in play, as its own beat.
const putDownBeat = (
  wardrobe: Wardrobe,
  body: Body,
  groundedBody: Body,
): Beat[] =>
  body.hands === "holdingProp" &&
  groundedBody.hands !== "holdingProp" &&
  HELD_OBJECT[body.prop]
    ? [
        {
          physical: `She sets the ${body.prop} down out of frame. Her hands are empty again.`,
          nextWardrobe: wardrobe,
          nextBody: groundedBody,
          durationSec: ACTION_BEAT_SEC,
        },
      ]
    : [];

// The full catalog, excluding the fallback: null means "this clause doesn't match a known act".
const matchBeats = (
  text: string,
  wardrobe: Wardrobe,
  body: Body,
): Beat[] | null =>
  dressBeats(text, wardrobe, body) ??
  stripAllBeats(text, wardrobe, body) ??
  teaseBeats(text, wardrobe, body) ??
  stripGarmentBeats(text, wardrobe, body) ??
  gestureBeats(text, wardrobe, body) ??
  tongueBeats(text, wardrobe, body) ??
  bounceBeats(text, wardrobe, body) ??
  doggyBeats(text, wardrobe, body) ??
  bendOverBeats(text, wardrobe, body) ??
  crawlBeats(text, wardrobe, body) ??
  spreadLegsBeats(text, wardrobe, body) ??
  twerkBeats(text, wardrobe, body) ??
  comeCloserBeats(text, wardrobe, body) ??
  backUpBeats(text, wardrobe, body) ??
  poseBeats(text, wardrobe, body) ??
  toyBeats(text, wardrobe, body) ??
  touchBeats(text, wardrobe, body) ??
  danceBeats(text, wardrobe, body) ??
  drinkBeats(text, wardrobe, body) ??
  tipBeats(text, wardrobe, body) ??
  smallTalkBeats(text, wardrobe, body) ??
  null;

// --- Negation ----------------------------------------------------------------

// Excludes "no way" (an intensifier, not a negation) so "no way, take it off" still strips.
const RE_NEGATION_CUE =
  /\b(don'?t|do not|doesn'?t|does not|didn'?t|did not|never mind|never|won'?t|stop)\b/i;
const RE_NO_CUE = /\bno\b(?!\s+way\b)/i;

const isNegatedClause = (clause: string): boolean =>
  RE_NEGATION_CUE.test(clause) || RE_NO_CUE.test(clause);

const negatedBeats = (wardrobe: Wardrobe, body: Body): Beat[] => [
  {
    physical:
      "She hears the request but stays exactly as she is, smiling, and keeps going. " +
      "NO UNDRESSING LOCK: no clothing changes this clip, nothing new appears.",
    nextWardrobe: wardrobe,
    nextBody: body,
    durationSec: LIVE_TUNABLES.IDLE_CLIP_SEC,
  },
];

// "not the top, the bottoms": the second garment inherits the first clause's implied verb, so this
// runs before clause splitting (which would otherwise treat the comma as a hard act boundary).
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
  if (lower === "panties") return "panties";
  return "top";
};

const garmentCorrectionBeats = (
  text: string,
  wardrobe: Wardrobe,
  body: Body,
): Beat[] | null => {
  const match = RE_GARMENT_CORRECTION.exec(text);
  if (!match?.[2]) return null;
  const target = garmentWordToId(match[2]);
  if (!isOn(wardrobe, target)) {
    return [
      {
        physical: `Her ${GARMENT_LABEL[target]} is already off. She stays exactly as she is and smiles.`,
        nextWardrobe: wardrobe,
        nextBody: body,
        durationSec: LIVE_TUNABLES.IDLE_CLIP_SEC,
      },
    ];
  }
  const desc = describeGarment(wardrobe, target);
  return [
    {
      physical:
        `STRIP TEASE, one garment only. She slowly takes off her ${GARMENT_LABEL[target]} (${desc}), ` +
        "the exact garment visible now, no substitute, and it leaves the frame. No other garment moves.",
      nextWardrobe: removeGarment(wardrobe, target),
      nextBody: { ...body, hands: "free", contact: "none" },
      durationSec: ACTION_BEAT_SEC,
    },
  ];
};

// --- Multi-act clause splitting ----------------------------------------------

const STRONG_CLAUSE_SPLIT = /\b(?:and then|after that|then|next)\b|,/gi;

// A bare "and" only splits when both halves independently match a real act, so "bra and panties" stays one clause.
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
      matchBeats(left, wardrobe, body) &&
      matchBeats(right, wardrobe, body)
    ) {
      result.push(left, right);
    } else {
      result.push(part);
    }
  }
  return result;
};

const dedupeConsecutiveBeats = (beats: Beat[]): Beat[] =>
  beats.filter(
    (beat, i) => i === 0 || beat.physical !== beats[i - 1]?.physical,
  );

// Contract caps followUps at 6, plus the primary beat itself.
const MAX_TOTAL_BEATS = 7;

const resolveBeats = (text: string, wardrobe: Wardrobe, body: Body): Beat[] => {
  const correction = garmentCorrectionBeats(text, wardrobe, body);
  if (correction) {
    const grounded = dropUnrelatedProp(text, body);
    return dedupeConsecutiveBeats([
      ...putDownBeat(wardrobe, body, grounded),
      ...correction,
    ]);
  }

  const clauses = splitClauses(text, wardrobe, body);
  let currentWardrobe = wardrobe;
  let currentBody = body;
  const allBeats: Beat[] = [];

  for (const clause of clauses) {
    const grounded = dropUnrelatedProp(clause, currentBody);
    for (const beat of putDownBeat(currentWardrobe, currentBody, grounded)) {
      allBeats.push(beat);
      currentWardrobe = beat.nextWardrobe;
      currentBody = beat.nextBody;
    }

    if (isNegatedClause(clause)) {
      for (const beat of negatedBeats(currentWardrobe, currentBody)) {
        allBeats.push(beat);
        currentWardrobe = beat.nextWardrobe;
        currentBody = beat.nextBody;
      }
      continue;
    }

    const beats = matchBeats(clause, currentWardrobe, currentBody);
    if (!beats) continue;
    for (const beat of beats) {
      allBeats.push(beat);
      currentWardrobe = beat.nextWardrobe;
      currentBody = beat.nextBody;
    }
  }

  if (allBeats.length === 0) {
    allBeats.push(...fallbackBeats(wardrobe, body));
  }

  const deduped = dedupeConsecutiveBeats(allBeats);
  if (deduped.length > MAX_TOTAL_BEATS) {
    console.warn(
      `resolveBeats: request resolved to ${deduped.length} beats, dropping tail beyond ${MAX_TOTAL_BEATS}`,
    );
    return deduped.slice(0, MAX_TOTAL_BEATS);
  }
  return deduped;
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
    "smile, then settles back into exactly the pose and framing she started in, hands returning to " +
    "where they were, so the final frame matches the first frame.";
  const expectedState: LiveState = { ...state, body: nextBody };
  const prompt = buildPrompt({
    state,
    speechMode,
    creator,
    action,
    nextWardrobe: state.wardrobe,
    nextBody,
  });
  return {
    prompt,
    durationSec: LIVE_TUNABLES.ACTION_CLIP_SEC,
    expectedState,
    followUps: [],
    replyDraft: {
      channel: "chat",
      typingLeadSec: typingLeadSecFor(GREETING_LINE),
    },
    needsReplyText: false,
    fixedReplyText: GREETING_LINE,
  };
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
  const action = [
    "IDLE, between requests. Hold this exact state — only small grounded life: breathing, blinking, " +
      "a glance at the chat, a slow shift of weight, a tuck of her hair.",
    "FORBIDDEN this clip: no clothing change, no new prop, no sexual act starting or continuing, " +
      "no standing up, no leaving frame.",
    pauseLine,
    "LOOP: the clip must END in exactly the starting pose, framing, expression baseline, and hand " +
      "position it started in, so it can loop seamlessly. Treat the motion as a small excursion and " +
      "return — a breath, a glance to the chat, a small weight shift — always back to the exact start.",
  ]
    .filter(Boolean)
    .join(" ");
  const expectedState: LiveState = { ...state, body: nextBody };
  const prompt = buildPrompt({
    state,
    speechMode: "text", // no dialogue in this job; native speech would invent mouthing
    creator,
    action,
    nextWardrobe: state.wardrobe,
    nextBody,
  });
  return {
    prompt,
    durationSec: LIVE_TUNABLES.IDLE_CLIP_SEC,
    expectedState,
    followUps: [],
    replyDraft: null,
    needsReplyText: false,
    fixedReplyText: null,
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
  const prompt = buildPrompt({
    state,
    speechMode,
    creator,
    action,
    nextWardrobe: state.wardrobe,
    nextBody: state.body,
  });
  return {
    prompt,
    durationSec: LIVE_TUNABLES.ACTION_CLIP_SEC,
    expectedState: state,
    followUps: [],
    replyDraft: { channel: job.channel, typingLeadSec: 0 },
    needsReplyText: true,
    fixedReplyText: null,
  };
};

// Laptop typing only from her chair with a free hand; every other pose reaches for her phone instead.
const canLaptopType = (body: Body): boolean =>
  body.pose === "sitting" && (body.hands === "free" || body.hands === "typing");

const laptopTypingLine = (typingLeadSec: number): string =>
  `TYPING FIRST: for the first ${typingLeadSec.toFixed(1)}s she reads the chat, glances at it, and ` +
  "types her reply on the off-screen keyboard. Mouth closed, silent.";

const phoneTypingLine = (body: Body, typingLeadSec: number): string => {
  const setDown = HELD_OBJECT[body.prop]
    ? `she first sets the ${body.prop} she was holding down out of frame, then `
    : "";
  return (
    `TYPING FIRST: for the first ${typingLeadSec.toFixed(1)}s ${setDown}she picks up her phone from ` +
    "within reach, reads the chat on its screen, and types her reply with her thumbs, then sets the " +
    "phone back down out of frame before the action below. Mouth closed, silent."
  );
};

const planReply = (
  session: LiveSessionSnapshot,
  job: Extract<ClipJob, { kind: "reply" }>,
  speechMode: SpeechMode,
): ClipPlan => {
  const { state, creator } = session;
  const beats = resolveBeats(job.text, state.wardrobe, state.body);
  const [firstBeat, ...restBeats] = beats;
  // resolveBeats always returns at least the fallback beat.
  if (!firstBeat) {
    throw new Error("planReply: intent catalog resolved no beats");
  }

  const canType = job.channel === "chat";
  const typingLeadSec = canType ? typingLeadSecFor(job.text) : 0;

  let primaryPhysical: string;
  let primaryNextWardrobe = firstBeat.nextWardrobe;
  let primaryNextBody = firstBeat.nextBody;
  let durationSec: number;
  let followUpBeats: Beat[];
  let lockBodyOverride: Body | undefined;

  if (canType) {
    const usesPhoneTyping = !canLaptopType(state.body);
    const typingLine = usesPhoneTyping
      ? phoneTypingLine(state.body, typingLeadSec)
      : laptopTypingLine(typingLeadSec);
    // The phone she picks up mid-clip isn't the committed prop, but the PROP LOCK line must permit
    // it for this clip's own locks or it contradicts the typing action ("hands empty" vs "picks up her phone").
    if (usesPhoneTyping) lockBodyOverride = { ...state.body, prop: "phone" };

    // A held-pose beat (small talk) or a fetch stays its own clip; any real action folds into the
    // reply clip so a chat reply never costs two clips just to fit a typing lead in front of it.
    const isHoldOnly = firstBeat.durationSec === LIVE_TUNABLES.IDLE_CLIP_SEC;
    const isFetch = firstBeat.nextBody.prop === "fetching";
    if (isHoldOnly || isFetch) {
      primaryPhysical = `${typingLine} She finishes typing and holds, ready to act next.`;
      primaryNextWardrobe = state.wardrobe;
      primaryNextBody = state.body;
      durationSec = clampDuration(typingLeadSec + 1);
      followUpBeats = [firstBeat, ...restBeats];
    } else {
      primaryPhysical = `${typingLine} Then, for the rest of the clip: ${firstBeat.physical}`;
      durationSec = LIVE_TUNABLES.MAX_CLIP_SEC;
      followUpBeats = restBeats;
    }
  } else {
    primaryPhysical = firstBeat.physical;
    durationSec = clampDuration(firstBeat.durationSec);
    followUpBeats = restBeats;
  }

  if (followUpBeats.length > 6) {
    console.warn(
      `planReply: ${followUpBeats.length} follow-up beats resolved, dropping the tail beyond the contract's 6-beat cap`,
    );
    followUpBeats = followUpBeats.slice(0, 6);
  }

  const expectedState: LiveState = {
    ...state,
    wardrobe: primaryNextWardrobe,
    body: primaryNextBody,
  };
  const prompt = buildPrompt({
    state,
    speechMode,
    creator,
    action: `${primaryPhysical} ${END_STILL_LOCK}`,
    nextWardrobe: primaryNextWardrobe,
    nextBody: primaryNextBody,
    lockBodyOverride,
  });

  const followUps: PlannedBeat[] = followUpBeats.map((beat, index) => ({
    id: `${job.requestId}-follow-${index}`,
    physical: beat.physical,
    durationSec: clampDuration(beat.durationSec),
    nextState: { wardrobe: beat.nextWardrobe, body: beat.nextBody },
  }));

  return {
    prompt,
    durationSec,
    expectedState,
    followUps,
    replyDraft: { channel: job.channel, typingLeadSec },
    needsReplyText: true,
    fixedReplyText: null,
  };
};

const planBeat = (
  session: LiveSessionSnapshot,
  job: Extract<ClipJob, { kind: "beat" }>,
): ClipPlan => {
  const { state, creator } = session;
  const nextWardrobe = job.beat.nextState.wardrobe;
  const nextBody = job.beat.nextState.body;
  const expectedState: LiveState = {
    ...state,
    wardrobe: nextWardrobe,
    body: nextBody,
  };
  const prompt = buildPrompt({
    state,
    speechMode: "text", // no dialogue in this job; native speech would invent mouthing
    creator,
    action: `${job.beat.physical} ${END_STILL_LOCK}`,
    nextWardrobe,
    nextBody,
  });
  return {
    prompt,
    durationSec: clampDuration(job.beat.durationSec),
    expectedState,
    followUps: [],
    replyDraft: null,
    needsReplyText: false,
    fixedReplyText: null,
  };
};

const planSettle = (session: LiveSessionSnapshot): ClipPlan => {
  const { state, creator } = session;
  const nextBody = { ...state.baselineBody };
  const bigDelta = state.body.pose === "lying" || nextBody.pose === "lying";
  // The prop she's holding doesn't just vanish: name it and put it down before settling, on every transition.
  const propToPutDown =
    state.body.prop !== "none" &&
    state.body.prop !== "fetching" &&
    nextBody.prop === "none"
      ? state.body.prop
      : null;
  const putDownLine = propToPutDown
    ? `She sets the ${propToPutDown} down, out of frame but within reach, before settling.`
    : "";
  const action = bigDelta
    ? [
        `She rises from ${POSE_DESCRIPTION[state.body.pose]} and moves back to ${POSE_DESCRIPTION[nextBody.pose]}, one grounded step at a time.`,
        putDownLine,
      ]
        .filter(Boolean)
        .join(" ")
    : [
        putDownLine,
        `She settles back into ${POSE_DESCRIPTION[nextBody.pose]}, hands returning to the keyboard. Wardrobe stays exactly as it is.`,
      ]
        .filter(Boolean)
        .join(" ");
  const expectedState: LiveState = { ...state, body: nextBody };
  const prompt = buildPrompt({
    state,
    speechMode: "text", // no dialogue in this job; native speech would invent mouthing
    creator,
    action: `${action} ${END_STILL_LOCK}`,
    nextWardrobe: state.wardrobe,
    nextBody,
  });
  return {
    prompt,
    durationSec: LIVE_TUNABLES.ACTION_CLIP_SEC,
    expectedState,
    followUps: [],
    replyDraft: null,
    needsReplyText: false,
    fixedReplyText: null,
  };
};

const planRedress = (
  session: LiveSessionSnapshot,
  job: Extract<ClipJob, { kind: "redress" }>,
): ClipPlan => {
  const { state, creator } = session;
  const desc = describeGarment(state.wardrobe, job.garment);
  const nextWardrobe = addGarment(state.wardrobe, job.garment);
  const action =
    `REDRESS, one garment. She picks up her ${GARMENT_LABEL[job.garment]} (${desc}) and puts it back on, ` +
    "grounded and unhurried. No other garment moves.";
  const expectedState: LiveState = { ...state, wardrobe: nextWardrobe };
  const prompt = buildPrompt({
    state,
    speechMode: "text", // no dialogue in this job; native speech would invent mouthing
    creator,
    action: `${action} ${END_STILL_LOCK}`,
    nextWardrobe,
    nextBody: state.body,
  });
  return {
    prompt,
    durationSec: ACTION_BEAT_SEC,
    expectedState,
    followUps: [],
    replyDraft: null,
    needsReplyText: false,
    fixedReplyText: null,
  };
};

export const planClip = ({
  session,
  job,
  speechMode,
}: {
  session: LiveSessionSnapshot;
  job: ClipJob;
  speechMode: SpeechMode;
}): ClipPlan => {
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
    case "settle":
      return planSettle(session);
    case "redress":
      return planRedress(session, job);
  }
};
