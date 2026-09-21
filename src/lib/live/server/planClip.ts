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
  "Never extra limbs, fused limbs, a second body, floating parts, or clothing fused into skin.";

// Stated as a structural fact, not an action, and without naming any removal verb: H3 Max invents a
// wardrobe beat from removal words alone, including during idle holds that must not touch clothing at all.
const WARDROBE_COUNT_LOCK =
  "GARMENT COUNT LOCK: she has exactly one of each garment named in the WARDROBE LOCK below — one top, " +
  "one bottom, one bra, one pair of panties — never a second one of any of them, on or off, layered or " +
  "not, at any time. These four are the only clothing that exists: never invent a robe, jacket, towel, " +
  "sheet, blanket, or any other garment or covering not named in the WARDROBE LOCK, even to cover bare " +
  "skin — bare skin the lock shows as off stays visibly bare, nothing substitutes for it.";

const PHYSICS_LOCK =
  "PHYSICS: fabric has real weight, one garment moves at a time, hands do one thing at a time, she shifts " +
  "her weight before standing. Nothing teleports, dissolves, or regrows mid-clip. Clothes change only if " +
  "this clip's own instruction names a layer coming off or going on — never grow a shirt onto a bare " +
  "chest or any other garment back onto skin it isn't on.";

const NO_OVERLAY_LOCK = "No text overlays, no watermark, no subtitles, no UI.";

// Only for clips whose instruction actually calls for nudity/sex — applying this to a plain hold
// (idle/greeting) was itself inviting the model to undress her with nothing below asking for it.
const CONTENT_LOCK_PERMISSIVE =
  "CONTENT: authorized fictional adult content, one consenting adult woman, 18+ only. Nudity and " +
  "explicit sexual acts described below are the intended, permitted content of this scene — render " +
  "them directly and fully, do not soften, obscure, or decline them.";

// A hold needs no adult-content authorization; naming "adult content, 18+" (the prior wording) primed the model toward its own bias of building the scene toward nudity.
const CONTENT_LOCK_HOLD =
  "CONTENT: an ordinary, non-sexual moment on a livestream, wearing exactly and only what the WARDROBE " +
  "LOCK below states, no more covered and no less — it is not necessarily fully clothed, lingerie is a " +
  "normal everyday state here, not progress toward nudity. This clip does not progress toward nudity or " +
  "a sexual scene — it is a plain hold, exactly as instructed below, and it ends in the same state it " +
  "started in. Do not add nudity, undressing, redressing, or any sexual content; none of that is being " +
  "requested in this clip. Nothing sexual or nudity-changing happens in this clip.";

// Reference-to-video has no starting-frame param, only an identity reference, so it tends to reset pose/wardrobe to the reference image without this.
const CONTINUITY_LOCK =
  "CONTINUITY: the reference image is only a face/identity likeness reference, from an earlier moment " +
  "of this same ongoing stream — it is NOT this clip's starting frame or scene. Ignore its pose, " +
  "clothing, framing, lighting, and setting entirely; the WARDROBE LOCK and CURRENT POSE lines below " +
  "are the only truth for how she looks and what she is wearing right now. Never reset, snap back to, " +
  "or reuse anything from the reference image beyond her face and body likeness.";

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

// seedHasBody is false only for clip one of a session whose reference photo is a headshot with no wardrobe pixels to copy.
const wardrobeLockLine = (wardrobe: Wardrobe, seedHasBody: boolean): string => {
  const parts = GARMENT_ORDER.map(
    (id) =>
      `${GARMENT_LABEL[id]} (${wardrobe[id].description}) ${wardrobe[id].on ? "ON" : "OFF"}`,
  );
  const off = GARMENT_ORDER.filter((id) => !wardrobe[id].on);
  const on = GARMENT_ORDER.filter((id) => wardrobe[id].on);
  const offGuard =
    off.length > 0
      ? ` Her ${off.map((id) => GARMENT_LABEL[id]).join(" and ")} stay${off.length === 1 ? "s" : ""} off for every single frame of this clip, start to finish, even briefly — nothing regrows there.`
      : "";
  const onGuard =
    on.length === 0
      ? ""
      : seedHasBody
        ? ` Copy her ${on.map((id) => GARMENT_LABEL[id]).join(" and ")} pixel-for-pixel from the seed frame — same color, fabric, and fit — for every single frame of this clip, start to finish, even briefly. Do not redraw ${on.length === 1 ? "it" : "them"} from memory of an earlier or later moment; nothing comes off there unless named below.`
        : ` The seed photo is a headshot and does not show her body, so there are no clothing pixels in it to copy — the description above is the complete and only truth of what she is wearing. Render her ${on.map((id) => GARMENT_LABEL[id]).join(" and ")} exactly as described, fully covering that part of her body, for every single frame of this clip; nothing is bare or exposed there unless named below.`;
  return (
    `WARDROBE LOCK, right now: ${parts.join("; ")}. Change only what this clip's instruction ` +
    "explicitly names — if nothing below names a garment, none moves. Default is no clothing change." +
    offGuard +
    onGuard
  );
};

// Restates only the untouched garments beside the action itself, skipping any this clip changes so it never contradicts that instruction.
const wardrobeReinforcementLine = (
  prevWardrobe: Wardrobe,
  nextWardrobe: Wardrobe,
  seedHasBody: boolean,
): string => {
  const unchanged = GARMENT_ORDER.filter(
    (id) => prevWardrobe[id].on === nextWardrobe[id].on,
  );
  if (unchanged.length === 0) return "";
  const changing = GARMENT_ORDER.length - unchanged.length;
  const parts = unchanged.map((id) => {
    const garment = nextWardrobe[id];
    if (!garment.on)
      return `her ${GARMENT_LABEL[id]} stays off and does not reappear`;
    return seedHasBody
      ? `copy her ${GARMENT_LABEL[id]} (${garment.description}) pixel-for-pixel from the seed frame`
      : `render her ${GARMENT_LABEL[id]} (${garment.description}) exactly as described, fully covering that part of her body — the seed photo is a headshot with no body pixels to copy`;
  });
  // Removing one garment (e.g. a top) sitting next to an untouched one (e.g. a bra) tends to make the
  // model flicker the untouched one too, since it's redrawing that whole area of the body anyway.
  const collisionGuard =
    changing > 0
      ? " Removing or adding the one garment named below never touches, loosens, or hides any of these — not even for a single frame, even though the action happens right beside them."
      : "";
  return (
    `WARDROBE FREEZE for the action below: ${parts.join("; ")} — copied exactly, not redrawn from ` +
    "memory of an earlier or later moment, for every single frame of it, including mid-motion, " +
    "mid-turn, or when her back or side is briefly toward the camera, not just the start and end." +
    collisionGuard
  );
};

const PROP_LABEL: Record<Prop, string> = {
  none: "empty",
  fetching: "reaching off-screen, nothing visible yet",
  vibrator: "a vibrator",
  dildo: "a dildo",
  drink: "a drink",
  phone: "her phone",
};

// state.surroundings was threaded through every clip's state but never read into the prompt, so the room drifted.
const sceneLockLine = (surroundings: string): string =>
  `SCENE LOCK: ${surroundings} This is the room for the entire call — never a different room, never a ` +
  "different camera setup.";

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
    `facing ${body.facing}, hands ${body.hands}, prop ${body.prop}. ` +
    // The clip runs longer than a one-off action takes; a short action followed by unfilled time is
    // exactly when the model fills the rest by repeating, reversing, or inventing a new action.
    "Reach this end state well before the clip ends, then hold completely still there for the " +
    "remainder — do not repeat the action, reverse it, or start anything new."
  );
};

const composeLocks = (
  state: LiveState,
  speechMode: SpeechMode,
  lookLock: string,
  // Overrides the body used for the PROP LOCK / CURRENT POSE lines only (e.g. phone typing, which
  // picks up an object mid-clip that the committed state doesn't hold). Never affects `expectedState`.
  lockBodyOverride?: Body,
  holdOnly?: boolean,
  seedHasBody = true,
): string[] => {
  const lockBody = lockBodyOverride ?? state.body;
  return [
    holdOnly ? CONTENT_LOCK_HOLD : CONTENT_LOCK_PERMISSIVE,
    CAMERA_LOCK,
    ANATOMY_LOCK,
    WARDROBE_COUNT_LOCK,
    lookLockLine(lookLock),
    sceneLockLine(state.surroundings),
    wardrobeLockLine(state.wardrobe, seedHasBody),
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
  // True for idle/greeting: nothing sexual is instructed, so don't invite it either.
  holdOnly?: boolean;
  // False only for clip one, when the reference photo is a headshot with no body pixels to copy from.
  seedHasBody?: boolean;
}): string => {
  const seedHasBody = params.seedHasBody ?? true;
  const locks = composeLocks(
    params.state,
    params.speechMode,
    params.creator.lookLock,
    params.lockBodyOverride,
    params.holdOnly,
    seedHasBody,
  );
  const reinforcement = wardrobeReinforcementLine(
    params.state.wardrobe,
    params.nextWardrobe,
    seedHasBody,
  );
  return [
    ...locks,
    params.action,
    ...(reinforcement ? [reinforcement] : []),
    endStateLine(params.nextWardrobe, params.nextBody),
  ].join(" ");
};

// --- Wardrobe helpers -------------------------------------------------------

// Whether this beat's own target is sexual/nudity-changing, the signal for CONTENT_LOCK gating.
const isExplicitAct = (
  prevWardrobe: Wardrobe,
  nextWardrobe: Wardrobe,
  nextBody: Body,
): boolean =>
  GARMENT_ORDER.some((id) => prevWardrobe[id].on !== nextWardrobe[id].on) ||
  nextBody.contact === "self" ||
  nextBody.prop === "vibrator" ||
  nextBody.prop === "dildo";

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
  // A sexual act that doesn't itself change wardrobe/contact (doggy, spread legs) still needs the
  // permissive CONTENT_LOCK, or it gets the hold lock telling the model nothing sexual happens here.
  explicit?: boolean;
};

const GARMENT_PATTERN: Record<GarmentId, RegExp> = {
  top: /\b(top|shirt|tee|blouse|tank)\b/i,
  bottom: /\b(bottoms?|pants|shorts|skirt|trousers)\b/i,
  bra: /\bbra\b/i,
  panties: /\b(panties|thong|underwear|knickers)\b/i,
};

// Binds the garment noun to a removal verb in one phrase, unlike matching each independently anywhere.
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

// A dress or one-piece is captured as the top garment; "dressed"/"dress up" are redress verbs, not this.
// Bound to a removal verb the same way every other garment is — "nice outfit, sit down" must not undress her.
const RE_ONE_PIECE_OFF = offPatternFor(
  "dress|one[- ]piece|romper|jumpsuit|lingerie|outfit",
);
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
// "show"/"see", not "flash" — flash is the tease-only phrasing above, this is an actual reveal request.
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
// Bare "spin"/"spin for me" is the common phrasing, not just "spin around" — match the verb alone.
const RE_SPIN =
  /\bspins?\b|\bspinning\b|\bdo a spin\b|\bfull (turn|circle|360)\b|\b360\b/i;

// Broad verb gate for a request with no dedicated beat below: only accepts it as a physical
// action if it plainly reads as one, so idle chit-chat still falls through to fallbackBeats.
const RE_GENERIC_ACTION =
  /\b(show|do|try|give|move|walk|stand|pose|face|look|point|lift|raise|lower|open|close|hold|grab|pull|push|rotate|flex|stretch|arch|squat|jump|hop|shake|wiggle|roll|flip)\b/i;

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
        "the exact garment visible now, no substitute, only one of it — and it leaves the frame. " +
        "Bare skin underneath, no second garment revealed. Nothing else comes off this clip.",
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
  const target =
    GARMENT_ORDER.find((id) => GARMENT_OFF_PATTERN[id].test(text)) ??
    (RE_GENERIC_OFF.test(text) || RE_ONE_PIECE_OFF.test(text)
      ? "top"
      : undefined);
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
        "the exact garment visible now, no substitute, only one of it — and it leaves the frame. " +
        "Bare skin underneath, no second garment revealed. No other garment moves.",
      nextWardrobe: removeGarment(wardrobe, target),
      nextBody: { ...body, hands: "free", contact: "none" },
      durationSec: ACTION_BEAT_SEC,
    },
  ];
};

// "Show me your tits" names a body part, not a removal verb, so without this it fell through to genericActionBeats, which explicitly bans clothing changes.
const revealBeats = (
  text: string,
  wardrobe: Wardrobe,
  body: Body,
): Beat[] | null => {
  const garments: GarmentId[] = RE_REVEAL_CHEST.test(text)
    ? ["top", "bra"]
    : RE_REVEAL_GENITALS.test(text)
      ? ["bottom", "panties"]
      : [];
  if (garments.length === 0) return null;
  const toRemove = garments.filter((id) => isOn(wardrobe, id));
  if (toRemove.length === 0) {
    return [
      {
        physical:
          "She is already showing exactly that. She holds the pose and smiles.",
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
        `She takes off her ${GARMENT_LABEL[id]} (${desc}) — the exact garment visible now, no ` +
        "substitute, only one of it — to show what was asked for, and it leaves the frame. Bare " +
        "skin underneath, no second garment revealed. No other garment moves.",
      nextWardrobe: next,
      nextBody: { ...body, hands: "free", contact: "none" },
      durationSec: ACTION_BEAT_SEC,
    });
    current = next;
  }
  return beats;
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
  beats.push({
    physical:
      "Staying on her hands and knees, back still arched, she rocks and grinds her hips in a slow, " +
      "steady rhythm toward the webcam, ass moving with each motion — external movement only, no insertion.",
    nextWardrobe: wardrobe,
    nextBody: { ...current, pose: "onAllFours", facing: "away" },
    durationSec: ACTION_BEAT_SEC,
    explicit: true,
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
  const swayBeat: Beat = {
    physical:
      `Bent over, ${FACING_TRANSITION_LABEL[targetFacing]}, she sways and arches her back, hips ` +
      "rocking slowly. No clothing changes.",
    nextWardrobe: wardrobe,
    nextBody: { ...body, pose: "bentOver", facing: targetFacing },
    durationSec: ACTION_BEAT_SEC,
  };
  if (body.pose === "bentOver" && body.facing === targetFacing) {
    return [swayBeat];
  }
  return [transitionBeat(wardrobe, body, "bentOver", targetFacing), swayBeat];
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
    explicit: true,
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
  // Policy: no insertion, ever. A direct insertion or suck/mouth ask uses it on/in her mouth only; anything else is external use.
  const useLine =
    RE_INSERT.test(text) || RE_SUCK.test(text)
      ? "She brings it to her mouth and sucks/licks it there, mouth only, never lower."
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

const spinBeats = (
  text: string,
  wardrobe: Wardrobe,
  body: Body,
): Beat[] | null => {
  if (!RE_SPIN.test(text)) return null;
  return [
    {
      physical:
        "0-2s: she stands up from her seated position, weight shifting naturally before she moves. " +
        "2-6s: she turns a full 360-degree circle in place to show her body from every angle; every " +
        "garment she is wearing moves naturally with her but stays exactly on her body the entire " +
        "turn, nothing slips, loosens, or disappears at any point, including the moment her back or " +
        "side is toward the camera. 6-8s: she completes the turn and settles back into the exact " +
        "pose and framing she started in, holding still. Full body stays in frame. The fixed webcam " +
        "never moves.",
      nextWardrobe: wardrobe,
      nextBody: body,
      durationSec: ACTION_BEAT_SEC,
    },
  ];
};

// Last resort before the static fallback: an unrecognized but plainly physical request (no beat
// above matched it) gets played through almost verbatim instead of being silently dropped.
const genericActionBeats = (
  text: string,
  wardrobe: Wardrobe,
  body: Body,
): Beat[] | null => {
  if (!RE_GENERIC_ACTION.test(text)) return null;
  return [
    {
      physical:
        `She does exactly this, one clear continuous action, and holds the result: "${text.trim()}". ` +
        "The fixed webcam does not move; she stays fully in frame throughout. This request is not " +
        "about clothing — no garment is added, removed, or shifted while she does it.",
      nextWardrobe: wardrobe,
      nextBody: body,
      durationSec: ACTION_BEAT_SEC,
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
  revealBeats(text, wardrobe, body) ??
  gestureBeats(text, wardrobe, body) ??
  tongueBeats(text, wardrobe, body) ??
  bounceBeats(text, wardrobe, body) ??
  doggyBeats(text, wardrobe, body) ??
  bendOverBeats(text, wardrobe, body) ??
  crawlBeats(text, wardrobe, body) ??
  spreadLegsBeats(text, wardrobe, body) ??
  twerkBeats(text, wardrobe, body) ??
  spinBeats(text, wardrobe, body) ??
  comeCloserBeats(text, wardrobe, body) ??
  backUpBeats(text, wardrobe, body) ??
  poseBeats(text, wardrobe, body) ??
  toyBeats(text, wardrobe, body) ??
  touchBeats(text, wardrobe, body) ??
  danceBeats(text, wardrobe, body) ??
  drinkBeats(text, wardrobe, body) ??
  tipBeats(text, wardrobe, body) ??
  smallTalkBeats(text, wardrobe, body) ??
  genericActionBeats(text, wardrobe, body) ??
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
        "the exact garment visible now, no substitute, only one of it, and it leaves the frame. " +
        "Bare skin underneath, no second garment revealed. No other garment moves.",
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

    const beats = matchBeats(clause, currentWardrobe, currentBody);
    // Only negate an undress/toy act it would otherwise cancel, not an unrelated request that
    // happens to sit next to "stop"/"no" with no comma (common in voice transcripts).
    const negatesRealAct =
      beats?.some(
        (beat) =>
          beat.explicit ||
          isExplicitAct(currentWardrobe, beat.nextWardrobe, beat.nextBody),
      ) ?? false;
    if (isNegatedClause(clause) && (negatesRealAct || !beats)) {
      for (const beat of negatedBeats(currentWardrobe, currentBody)) {
        allBeats.push(beat);
        currentWardrobe = beat.nextWardrobe;
        currentBody = beat.nextBody;
      }
      continue;
    }

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
    holdOnly: true,
    seedHasBody:
      session.seedFrameUrl !== session.anchorFrameUrl || session.anchorHasBody,
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
    `IDLE, between requests. She stays ${nextBody.pose}, exactly as she is right now, for the entire clip — ` +
      "only small grounded life on top of that fixed pose: breathing, blinking, a glance at the chat, a tiny " +
      "weight shift, a tuck of her hair. This is a static hold, not a scene with a beginning and an end.",
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
  const prompt = buildPrompt({
    state,
    speechMode: "text", // no dialogue in this job; native speech would invent mouthing
    creator,
    action,
    nextWardrobe: state.wardrobe,
    nextBody,
    holdOnly: true,
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
    holdOnly: true,
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
    holdOnly: !(
      firstBeat.explicit ||
      isExplicitAct(state.wardrobe, primaryNextWardrobe, primaryNextBody)
    ),
    lockBodyOverride,
  });

  const followUps: PlannedBeat[] = followUpBeats.map((beat, index) => ({
    id: `${job.requestId}-follow-${index}`,
    physical: beat.physical,
    durationSec: clampDuration(beat.durationSec),
    nextState: { wardrobe: beat.nextWardrobe, body: beat.nextBody },
    explicit: beat.explicit ?? false,
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
    holdOnly: !(
      job.beat.explicit || isExplicitAct(state.wardrobe, nextWardrobe, nextBody)
    ),
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
  // The seed frame still shows the prior act's pose; the model tends to just continue that rather
  // than transition out of it unless told explicitly, in plain words, that the act is over.
  const actIsOverLine =
    "SCENE CHANGE: whatever she was doing before this clip is now over and does not continue, " +
    "repeat, or restart at any point in this clip — this is a new, separate moment.";
  const action = bigDelta
    ? [
        actIsOverLine,
        `0-3s: she rises from ${POSE_DESCRIPTION[state.body.pose]}, one grounded step at a time. ` +
          `3-${ACTION_BEAT_SEC}s: she moves back to ${POSE_DESCRIPTION[nextBody.pose]} and settles there, still.`,
        putDownLine,
      ]
        .filter(Boolean)
        .join(" ")
    : [
        actIsOverLine,
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
    holdOnly: true,
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
    holdOnly: true,
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
      case "settle":
        return planSettle(session);
      case "redress":
        return planRedress(session, job);
    }
  })();
  // Greeting has no "earlier moment" yet — the reference image IS its starting frame, so telling
  // the model to ignore it (which is what this lock does for every later clip) is wrong here.
  return backend === "reference" && job.kind !== "greeting"
    ? { ...plan, prompt: `${CONTINUITY_LOCK} ${plan.prompt}` }
    : plan;
};
