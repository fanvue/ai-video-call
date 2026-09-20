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

// A one-off action (a strip, a pose change, a toy beat) reads fine at ~8s; the contract's 10s
// floor (fal's own minimum) still clamps it up via clampDuration.
const ACTION_BEAT_SEC = 8;

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
};

const FACING_LABEL: Record<Body["facing"], string> = {
  camera: "the webcam",
  away: "away from the webcam",
  side: "to the side of the webcam",
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
): string[] => [
  CAMERA_LOCK,
  ANATOMY_LOCK,
  lookLockLine(lookLock),
  wardrobeLockLine(state.wardrobe),
  propLockLine(state.body.prop),
  bodyLockLine(state.body),
  PHYSICS_LOCK,
  NO_OVERLAY_LOCK,
  speechLockLine(speechMode),
];

const buildPrompt = (params: {
  state: LiveState;
  speechMode: SpeechMode;
  creator: CreatorProfile;
  action: string;
  nextWardrobe: Wardrobe;
  nextBody: Body;
}): string => {
  const locks = composeLocks(
    params.state,
    params.speechMode,
    params.creator.lookLock,
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
const RE_DRESS =
  /\b(put (your |the )?(top|shirt|bra|bottoms?|panties|clothes) (back )?on|get dressed|cover (yourself )?up|dress (yourself )?up?)\b/i;
const RE_EVERYTHING =
  /\b(naked|nude|get naked|strip (it all|everything)?|everything off|all off|nothing on)\b/i;
const RE_TEASE_STRAP = /\b(bra strap|strap tease|shoulder strap)\b/i;
const RE_TEASE_WAIST =
  /\b(panty tease|waistband (tease|snap|pull)|flash (your |ur )?panties)\b/i;
const RE_TEASE_HEM =
  /\b(tease|lift (your |the )?(top|hem|shirt)|flash (your |ur )?(top|chest|tits)|peek)\b/i;
const RE_FACE_CAMERA =
  /\b(face (the )?(camera|webcam|lens)|face me|look at me|come closer)\b/i;
const RE_FACE_AWAY =
  /\b(turn around|turn your back|face away|show (me )?(your |ur )?ass|from behind|booty)\b/i;
const RE_TOY_ANY = /\b(dildo|vibrator|vibe|wand|toy)\b/i;
const RE_TOY_DILDO = /\bdildo\b/i;
const RE_INSERT =
  /\b(insert|inside (her|your|my)|stick it in|in (her|your|my) (pussy|cunt|ass|butt))\b/i;
const RE_TOUCH =
  /\b(touch (yourself|your (pussy|clit))|masturbat\w*|finger\w* yourself|play with (yourself|your (pussy|clit))|rub (your (pussy|clit)|yourself)|joi|jerk[\s-]?off)\b/i;
const RE_DANCE = /\b(dance|sway|twerk)\b/i;
const RE_DRINK = /\b(drink|sip|water|coffee|tea)\b/i;
const RE_TIP = /\b(tip(ped)?|thank you|thanks)\b/i;
const RE_SMALL_TALK =
  /\b(hi|hello|hey|how are you|you('re| are) (cute|hot|beautiful|gorgeous)|nice (smile|eyes)|good morning|good evening)\b/i;

const RE_POSE: Partial<Record<Pose, RegExp>> = {
  standing: /\b(stand up|get up|on your feet)\b/i,
  sitting: /\b(sit( down)?|sit back down)\b/i,
  leaning: /\blean(ing)?\b/i,
  lying: /\b(lie down|lay down|on your back|on the bed|on the floor)\b/i,
  onAllFours: /\b(doggy\w*|all fours|hands and knees)\b/i,
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
    (RE_ONE_PIECE.test(text) ? "top" : undefined);
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
  const facingText =
    nextFacing === "camera"
      ? "facing the webcam"
      : nextFacing === "away"
        ? "with her back to the webcam"
        : "at an angle to the webcam";
  return [
    {
      physical:
        `She moves from her current pose into ${POSE_DESCRIPTION[nextPose]}, ${facingText}. ` +
        "The fixed webcam does not move. No clothing changes.",
      nextWardrobe: wardrobe,
      nextBody,
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
  // Policy: any toy use is mouth-only, never vaginal or anal, however the fan phrases the ask.
  const useLine = RE_INSERT.test(text)
    ? "She brings it to her mouth and uses it there instead — mouth only, never lower."
    : "She uses it on her mouth, lips wrapped around it, eyes on the lens.";
  if (body.prop === "none") {
    return [
      {
        physical:
          "One hand reaches off-screen to fetch an object. Nothing is visible in her hand yet.",
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
  return [
    {
      physical:
        "One hand moves onto her own body and stays there, fingers visibly attached, touching herself. " +
        "The other arm supports her. No second person, no toy unless one is already held.",
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

const resolveBeats = (text: string, wardrobe: Wardrobe, body: Body): Beat[] => {
  const groundedBody = dropUnrelatedProp(text, body);
  return (
    dressBeats(text, wardrobe, groundedBody) ??
    stripAllBeats(text, wardrobe, groundedBody) ??
    teaseBeats(text, wardrobe, groundedBody) ??
    stripGarmentBeats(text, wardrobe, groundedBody) ??
    poseBeats(text, wardrobe, groundedBody) ??
    toyBeats(text, wardrobe, groundedBody) ??
    touchBeats(text, wardrobe, groundedBody) ??
    danceBeats(text, wardrobe, groundedBody) ??
    drinkBeats(text, wardrobe, groundedBody) ??
    tipBeats(text, wardrobe, groundedBody) ??
    smallTalkBeats(text, wardrobe, groundedBody) ??
    fallbackBeats(wardrobe, groundedBody)
  );
};

// --- Job handlers ------------------------------------------------------------

const GREETING_LINE = "hey, i'm here! say hi or tell me what you want";

const planGreeting = (
  session: LiveSessionSnapshot,
  speechMode: SpeechMode,
): ClipPlan => {
  const { state, creator } = session;
  const nextBody = { ...state.baselineBody };
  const action =
    "GREETING: she notices the fan joining, gives a small wave and warm smile, then settles into her " +
    "baseline pose with hands moving to the keyboard.";
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
    durationSec: LIVE_TUNABLES.IDLE_CLIP_SEC,
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
    durationSec: LIVE_TUNABLES.IDLE_CLIP_SEC,
    expectedState: state,
    followUps: [],
    replyDraft: { channel: job.channel, typingLeadSec: 0 },
    needsReplyText: true,
    fixedReplyText: null,
  };
};

const canTypeFrom = (body: Body): boolean =>
  body.pose === "sitting" && (body.hands === "free" || body.hands === "typing");

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

  const canType = job.channel === "chat" && canTypeFrom(state.body);
  const typingLeadSec = canType ? typingLeadSecFor(job.text) : 0;

  let primaryPhysical: string;
  let primaryNextWardrobe = firstBeat.nextWardrobe;
  let primaryNextBody = firstBeat.nextBody;
  let durationSec: number;
  let followUpBeats: Beat[];

  if (canType) {
    const typingLine =
      `TYPING FIRST: for the first ${typingLeadSec.toFixed(1)}s she reads the chat, glances at it, and ` +
      "types her reply on the off-screen keyboard. Mouth closed, silent.";
    const fitsInClip =
      typingLeadSec + firstBeat.durationSec <= LIVE_TUNABLES.MAX_CLIP_SEC;
    if (fitsInClip) {
      primaryPhysical = `${typingLine} Then, for the rest of the clip: ${firstBeat.physical}`;
      durationSec = clampDuration(typingLeadSec + firstBeat.durationSec);
      followUpBeats = restBeats;
    } else {
      primaryPhysical = `${typingLine} She finishes typing and holds, ready to act next.`;
      primaryNextWardrobe = state.wardrobe;
      primaryNextBody = state.body;
      durationSec = clampDuration(typingLeadSec + 1);
      followUpBeats = [firstBeat, ...restBeats];
    }
  } else {
    primaryPhysical = firstBeat.physical;
    durationSec = clampDuration(firstBeat.durationSec);
    followUpBeats = restBeats;
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
    action: primaryPhysical,
    nextWardrobe: primaryNextWardrobe,
    nextBody: primaryNextBody,
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
    action: job.beat.physical,
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
  const action = bigDelta
    ? `She rises from ${POSE_DESCRIPTION[state.body.pose]} and moves back to ${POSE_DESCRIPTION[nextBody.pose]}, ` +
      "one grounded step at a time, putting away the current prop if she is holding one."
    : `She settles back into ${POSE_DESCRIPTION[nextBody.pose]}, hands returning to the keyboard. ` +
      "Wardrobe stays exactly as it is.";
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
    action,
    nextWardrobe,
    nextBody: state.body,
  });
  return {
    prompt,
    durationSec:
      ACTION_BEAT_SEC < LIVE_TUNABLES.MIN_CLIP_SEC
        ? LIVE_TUNABLES.MIN_CLIP_SEC
        : ACTION_BEAT_SEC,
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
