// Director mode: an LLM plans each reply clip's timed beats from the full live state; the catalogue stays the fallback.
import { z } from "zod";
import {
  GROQ_TEXT_MODEL,
  createGroqChatCompletion,
  stripThinkBlock,
} from "@/lib/groq";
import { createOpenRouterCompletion } from "@/lib/openrouter";
import {
  LIVE_TUNABLES,
  bodySchema,
  garmentIdSchema,
  isSwapSession,
  poseSchema,
  type ClipJob,
  type CreatorProfile,
  type GarmentId,
  type LiveSessionSnapshot,
  type LiveState,
  type RenderBackend,
  type SceneProp,
  type SpeechMode,
  type Wardrobe,
} from "../contract";
import { correctActionTypos } from "./actionTypos";
import { HARD_LIMIT_CUE_RE, MINOR_CUE_RE } from "./contentSafety";
import {
  DIRECTOR_SYSTEM_PROMPT,
  directorUserMessage,
  type DirectorInput,
} from "./directorPrompt";
import {
  ANATOMY_LOCK,
  CLIP_ENDS_LINE,
  CONTENT_LOCK_PERMISSIVE,
  GARMENT_PHYSICS_LINE,
  NO_OVERLAY_LOCK,
  PHYSICS_LOCK,
  addGarment,
  cameraLockLine,
  currentSceneProps,
  describeState,
  lookLockLine,
  planClip,
  removeGarment,
  speechLockLine,
  typingLeadSecFor,
  wardrobeLockLine,
  type ClipPlan,
} from "./planClip";
import { isRefusal } from "./writeReply";

// "provider:model", as orBench names models. Provisional: the model parseIntents uses, until the orBench director suite picks one.
export const DIRECTOR_MODEL = `groq:${GROQ_TEXT_MODEL}`;

const GARMENT_IDS: GarmentId[] = ["top", "bottom", "bra", "panties"];
const TRANSCRIPT_ENTRIES = 8;
// A repair call needs about this long to land; with less budget left the catalogue plans the clip instead.
const MIN_REPAIR_MS = 1_500;
// No h3 prompt limit is enforced anywhere; the longest catalogue reply prompt measured 2,742 characters, so the Director stays near what already renders.
const DIRECTOR_PROMPT_MAX_CHARS = 3_000;
const MIN_BEAT_CHARS = 40;

// Schema bounds sit a little above the lengths the prompt asks for, so a few characters over costs no repair call.
const directorPlanSchema = z.object({
  refusal: z.null().optional(),
  interpretation: z.array(z.string().min(1).max(120)).min(1).max(6),
  composition: z.enum(["simultaneous", "sequence", "mixed"]),
  reconciliation: z.string().max(400),
  framing: bodySchema.shape.framing,
  explicit: z.boolean(),
  beats: z
    .array(
      z.object({
        fromSec: z.number().int().min(0).max(15),
        toSec: z.number().int().min(1).max(15),
        action: z.string().min(8).max(300),
        wardrobe: z
          .array(
            z.object({ garment: garmentIdSchema, to: z.enum(["off", "on"]) }),
          )
          .max(4)
          .optional(),
      }),
    )
    .min(1)
    .max(6),
  props: z
    .array(
      z.object({
        item: z.string().min(1).max(60),
        kind: z.enum(["vibrator", "dildo", "drink", "phone", "other"]),
        source: z.enum(["held", "inFrame", "room", "offscreen"]),
        fromWhere: z.string().min(1).max(120),
        fetchBeat: z.number().int().min(0).max(5).nullable().optional(),
        useBeat: z.number().int().min(0).max(5),
        ends: z.enum(["held", "placed", "offscreen"]),
        endsWhere: z.string().min(1).max(120),
      }),
    )
    .max(4),
  endState: z.object({
    wardrobe: z.object({
      top: z.boolean(),
      bottom: z.boolean(),
      bra: z.boolean(),
      panties: z.boolean(),
    }),
    pose: poseSchema,
    facing: bodySchema.shape.facing,
    hands: bodySchema.shape.hands,
    contact: bodySchema.shape.contact,
    prop: z.enum(["none", "vibrator", "dildo", "drink", "phone"]),
    framing: bodySchema.shape.framing,
  }),
  endDescription: z.string().min(1).max(260),
});
export type DirectorPlan = z.infer<typeof directorPlanSchema>;

const isTrackedProp = (prop: string): boolean =>
  prop !== "none" && prop !== "fetching";

// An explicit ask to come closer or step back: the only reason her distance to the fixed webcam may change.
const DISTANCE_REQUEST_RE =
  /\b(closer|nearer|step(?:s|ping)? back|move(?:s|ing)? back|back(?:s|ing)? up|(?:further|farther) (?:back|away)|(?:toward|towards|away from) the (?:camera|lens|webcam))\b/i;
const TOY_KINDS = new Set(["dildo", "vibrator"]);
// A toy still in use at the hold: the next clip's NOW line would put it in her hand while h3 still draws it inside her.
const TOY_ENGAGED_RE =
  /\b(inside|insert\w*|penetrat\w*|half[- ]in\w*|in her (?:mouth|vagina|pussy|ass|anus)|at her (?:lips|mouth)|on her (?:lower|upper) lip|between her (?:lips|labia)|against her (?:clit|vulva|labia|pussy|lips|mouth|entrance|anus|ass|nipples?|breasts?|crotch))\b/i;
const PENETRATION_RE =
  /\b(insert\w*|penetrat\w*|inside her|(?:slides?|pushes?|eases?|sinks?) (?:it|the [\w-]+(?: [\w-]+)?) (?:in|into))\b/i;

// Physical consistency against frame 0; each message is written to be sent back to the model as a repair instruction.
export const validateDirectorPlan = (
  plan: DirectorPlan,
  input: DirectorInput,
): string[] => {
  const errors: string[] = [];
  const { beats } = plan;
  if (beats[0]?.fromSec !== 0) errors.push("beats[0].fromSec must be 0");
  beats.forEach((beat, i) => {
    if (beat.toSec <= beat.fromSec)
      errors.push(`beats[${i}] must end after it starts`);
    const previous = beats[i - 1];
    if (previous && beat.fromSec !== previous.toSec)
      errors.push(`beats[${i}].fromSec must equal beats[${i - 1}].toSec`);
  });
  const last = beats[beats.length - 1];
  if (last && last.toSec !== input.clipSec)
    errors.push(`the last beat must end at ${input.clipSec}`);
  if (last && (last.toSec - last.fromSec < 1 || (last.wardrobe?.length ?? 0)))
    errors.push(
      "the last beat must be a still hold of at least 1 s with no garment change",
    );

  const worn = Object.fromEntries(
    GARMENT_IDS.map((id) => [id, input.now.wardrobe[id].on]),
  ) as Record<GarmentId, boolean>;
  const inRoom = new Set(
    GARMENT_IDS.filter((id) => input.now.wardrobe[id].inRoom),
  );
  beats.forEach((beat, i) =>
    beat.wardrobe?.forEach(({ garment, to }) => {
      const outer =
        garment === "panties" ? "bottom" : garment === "bra" ? "top" : null;
      if (to === "off") {
        if (!worn[garment])
          errors.push(
            `beats[${i}]: ${garment} is not on, so it cannot come off`,
          );
        if (outer && worn[outer])
          errors.push(
            `beats[${i}]: the ${outer} comes off before the ${garment}`,
          );
        inRoom.add(garment);
      } else {
        if (worn[garment] || !inRoom.has(garment))
          errors.push(
            `beats[${i}]: ${garment} is not lying in the room, so it cannot go on`,
          );
        if (outer && worn[outer])
          errors.push(
            `beats[${i}]: the ${garment} goes on before the ${outer}`,
          );
      }
      worn[garment] = to === "on";
    }),
  );
  GARMENT_IDS.forEach((id) => {
    if (plan.endState.wardrobe[id] !== worn[id])
      errors.push(
        `endState.wardrobe.${id} must be ${worn[id]} to match the beats`,
      );
  });
  if (plan.endState.framing !== plan.framing)
    errors.push("endState.framing must equal framing");
  const startFraming = input.now.body.framing;
  if (
    plan.framing !== startFraming &&
    !DISTANCE_REQUEST_RE.test(plan.interpretation.join("; "))
  )
    errors.push(
      `framing must stay ${startFraming}: she moves nearer or farther only when the viewer asks her to come closer or step back`,
    );

  const startProp = input.now.body.prop;
  plan.props.forEach((prop, i) => {
    if (prop.source === "held" && prop.kind !== startProp)
      errors.push(`props[${i}]: she is not holding a ${prop.kind} at frame 0`);
    if (prop.useBeat >= beats.length)
      errors.push(`props[${i}].useBeat is not a beat`);
    if (prop.kind === "other" && prop.ends === "held")
      errors.push(`props[${i}]: an "other" item cannot stay held at the end`);
    if (prop.source !== "offscreen") return;
    const fetchBeat = prop.fetchBeat ?? null;
    const fetch = fetchBeat === null ? undefined : beats[fetchBeat];
    if (fetchBeat === null || !fetch) {
      errors.push(`props[${i}]: an off-screen item needs its fetchBeat`);
      return;
    }
    if (fetch.toSec - fetch.fromSec < 2)
      errors.push(`props[${i}]: the fetch beat must last at least 2 s`);
    if (prop.useBeat <= fetchBeat)
      errors.push(`props[${i}]: useBeat must come after fetchBeat`);
  });
  const inScene = input.now.props.filter((prop) => prop.at !== "offscreen");
  plan.props.forEach((prop, i) => {
    const existing =
      prop.kind === "other"
        ? undefined
        : inScene.find((scene) => scene.kind === prop.kind);
    if (existing && prop.source === "offscreen")
      errors.push(
        `props[${i}]: the ${existing.item} is already ${existing.at === "held" ? "in her hand" : existing.where}; use that one instead of fetching another`,
      );
  });
  const kinds = plan.props
    .filter((prop) => prop.kind !== "other")
    .map((prop) => prop.kind);
  if (new Set(kinds).size !== kinds.length)
    errors.push("only one of each prop exists: one props entry per kind");
  const toys = plan.props.filter((prop) => TOY_KINDS.has(prop.kind));
  if (
    last &&
    toys.length > 0 &&
    TOY_ENGAGED_RE.test(
      [last.action, plan.endDescription, ...toys.map((t) => t.endsWhere)].join(
        " ",
      ),
    )
  )
    errors.push(
      "by the last beat the toy is drawn out of her and held in a named hand or set down on a named surface, never inside her, at her mouth or against her",
    );
  plan.props.forEach((prop, i) => {
    if (
      TOY_KINDS.has(prop.kind) &&
      prop.ends === "held" &&
      !/\b(left|right) hand\b/i.test(prop.endsWhere)
    )
      errors.push(
        `props[${i}].endsWhere must name the hand holding it and where that hand rests`,
      );
  });
  const { pose: endPose, facing: endFacing } = plan.endState;
  if (
    (endPose === "onAllFours" || endPose === "bentOver") &&
    endFacing === "camera" &&
    beats.some((beat) => PENETRATION_RE.test(beat.action))
  )
    errors.push(
      "from all fours or bent over, penetration is visible only with her back or side to the webcam: facing away or side, looking back over her shoulder",
    );
  const heldAtEnd = plan.props.filter((prop) => prop.ends === "held");
  const endProp = plan.endState.prop;
  if (heldAtEnd.length > 1)
    errors.push("at most one prop can stay held at the end");
  const heldProp = heldAtEnd[0];
  if (heldProp && heldProp.kind !== endProp)
    errors.push(
      `endState.prop must be ${heldProp.kind}, the prop held at the end`,
    );
  if (
    !heldProp &&
    endProp !== "none" &&
    (endProp !== startProp || plan.props.some((p) => p.source === "held"))
  )
    errors.push(`endState.prop ${endProp} is not held at the end by any prop`);
  if (
    isTrackedProp(startProp) &&
    endProp !== startProp &&
    !plan.props.some((p) => p.source === "held")
  )
    errors.push(
      `she holds a ${startProp} at frame 0: add its props entry saying where it goes`,
    );
  if ((plan.endState.hands === "holdingProp") !== (endProp !== "none"))
    errors.push(
      "endState.hands is holdingProp exactly when endState.prop is not none",
    );
  return errors;
};

type DirectorOutcome =
  | { kind: "plan"; plan: DirectorPlan }
  | { kind: "hold"; reason: string }
  | { kind: "repair"; errors: string[] }
  | { kind: "fallback"; reason: string };

// Safety runs on the raw text first, so a cue anywhere in the output fails closed whatever the rest parses to.
export const judgeDirectorOutput = (
  raw: string,
  input: DirectorInput,
): DirectorOutcome => {
  if (MINOR_CUE_RE.test(raw)) return { kind: "hold", reason: "minorCue" };
  if (HARD_LIMIT_CUE_RE.test(raw))
    return { kind: "hold", reason: "hardLimitCue" };
  let json: unknown;
  try {
    const text = stripThinkBlock(raw);
    json = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? text);
  } catch {
    return isRefusal(raw)
      ? { kind: "fallback", reason: "refusal" }
      : {
          kind: "repair",
          errors: ["the output was not one valid JSON object"],
        };
  }
  const refusal =
    typeof json === "object" && json !== null && "refusal" in json
      ? (json as { refusal: unknown }).refusal
      : null;
  if (refusal !== null && refusal !== undefined)
    return {
      kind: "hold",
      reason: `directorRefusal:${String(refusal).slice(0, 20)}`,
    };
  const parsed = directorPlanSchema.safeParse(json);
  if (!parsed.success) {
    return {
      kind: "repair",
      errors: parsed.error.issues
        .slice(0, 8)
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    };
  }
  const errors = validateDirectorPlan(parsed.data, input);
  return errors.length > 0
    ? { kind: "repair", errors }
    : { kind: "plan", plan: parsed.data };
};

export type DirectorMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export const directorMessagesFor = (
  input: DirectorInput,
): DirectorMessage[] => [
  { role: "system", content: DIRECTOR_SYSTEM_PROMPT },
  { role: "user", content: directorUserMessage(input) },
];

// The groq: prefix goes to Groq, anything else to OpenRouter, whose budget guard runs inside createOpenRouterCompletion.
export const callDirectorModel = async (
  model: string,
  messages: DirectorMessage[],
  timeoutMs: number,
): Promise<{ content: string; costUsd: number }> => {
  if (model.startsWith("groq:")) {
    const completion = await createGroqChatCompletion({
      model: model.slice("groq:".length),
      reasoningEffort: "low",
      temperature: 0.3,
      responseFormat: { type: "json_object" },
      messages,
    });
    return {
      content: completion.choices[0]?.message?.content?.trim() ?? "",
      costUsd: 0,
    };
  }
  const result = await createOpenRouterCompletion({
    model: model.replace(/^openrouter:/, ""),
    messages,
    temperature: 0.3,
    jsonObject: true,
    timeoutMs: Math.max(1, Math.round(timeoutMs)),
    quiet: true,
  });
  return { content: result.content, costUsd: result.costUsd };
};

export const directorInputFor = ({
  state,
  creator,
  transcript,
  request,
  speechMode,
  clipSec,
}: {
  state: LiveState;
  creator: CreatorProfile;
  transcript: LiveSessionSnapshot["transcript"];
  request: string;
  speechMode: SpeechMode;
  clipSec: number;
}): DirectorInput => ({
  clipSec,
  speechMode,
  performer: { displayName: creator.displayName, look: creator.lookLock },
  room: state.surroundings,
  world: state.world,
  now: {
    wardrobe: Object.fromEntries(
      GARMENT_IDS.map((id) => [
        id,
        {
          on: state.wardrobe[id].on,
          description: state.wardrobe[id].description,
          inRoom:
            !state.wardrobe[id].on && state.wardrobe.removedOrder.includes(id),
        },
      ]),
    ) as DirectorInput["now"]["wardrobe"],
    body: state.body,
    props: currentSceneProps(state),
  },
  // Role and text only: viewer handles are not needed to plan the motion.
  recentChat: transcript.slice(-TRANSCRIPT_ENTRIES).map((entry) => ({
    from: entry.role,
    text: entry.text.slice(0, 300),
  })),
  request: request.slice(0, 500),
});

// --- Prompt assembly ---------------------------------------------------------

const DIRECTOR_FOCUS_LINE =
  "She performs exactly these timed steps, in this order, and nothing else.";

const CONTENT_LOCK_NON_EXPLICIT =
  "CONTENT: authorized fictional content, one consenting adult woman, 18+ only; nothing sexual happens in this clip.";

const trimAtWord = (text: string, max: number): string => {
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[,;:.]+$/, "")}.`;
};

// Shortens the longest beat until the timed lines fit; the locks after them are never cut.
const fitBeats = (beats: DirectorPlan["beats"], budget: number): string => {
  const actions = beats.map((beat) => beat.action);
  const render = () =>
    beats
      .map((beat, i) => `${beat.fromSec}-${beat.toSec}s: ${actions[i]}`)
      .join(" ");
  let text = render();
  for (let guard = 0; text.length > budget && guard < 50; guard += 1) {
    const longest = actions.reduce(
      (best, action, i) =>
        action.length > (actions[best]?.length ?? 0) ? i : best,
      0,
    );
    const current = actions[longest] ?? "";
    const target = Math.max(
      MIN_BEAT_CHARS,
      current.length - (text.length - budget) - 1,
    );
    const trimmed = trimAtWord(current, target);
    if (trimmed.length >= current.length) break;
    actions[longest] = trimmed;
    text = render();
  }
  return text;
};

const lowerFirst = (text: string): string =>
  text.charAt(0).toLowerCase() + text.slice(1).replace(/\.$/, "");

export const buildDirectorPrompt = ({
  plan,
  state,
  nextWardrobe,
  creator,
  speechMode,
  durationSec,
  explicit,
}: {
  plan: DirectorPlan;
  state: LiveState;
  nextWardrobe: Wardrobe;
  creator: CreatorProfile;
  speechMode: SpeechMode;
  durationSec: number;
  explicit: boolean;
}): string => {
  const holdsWardrobe = GARMENT_IDS.every(
    (id) => state.wardrobe[id].on === nextWardrobe[id].on,
  );
  const locks = [
    cameraLockLine(plan.framing),
    ANATOMY_LOCK,
    lookLockLine(creator.lookLock),
    `ROOM: ${state.surroundings}`,
    `NOW: she is ${describeState(state.wardrobe, state.body, currentSceneProps(state))}`,
    holdsWardrobe ? wardrobeLockLine(nextWardrobe) : null,
    `By ${durationSec}s she is ${lowerFirst(plan.endDescription)}, still. ${CLIP_ENDS_LINE}`,
    PHYSICS_LOCK,
    holdsWardrobe ? null : GARMENT_PHYSICS_LINE,
    NO_OVERLAY_LOCK,
    explicit ? CONTENT_LOCK_PERMISSIVE : CONTENT_LOCK_NON_EXPLICIT,
    speechLockLine(speechMode),
  ]
    .filter((line): line is string => line !== null)
    .join(" ");
  const beats = fitBeats(
    plan.beats,
    DIRECTOR_PROMPT_MAX_CHARS - locks.length - DIRECTOR_FOCUS_LINE.length - 2,
  );
  return `${beats} ${DIRECTOR_FOCUS_LINE} ${locks}`;
};

// --- ClipPlan -----------------------------------------------------------------

const wardrobeAfter = (wardrobe: Wardrobe, plan: DirectorPlan): Wardrobe =>
  plan.beats
    .flatMap((beat) => beat.wardrobe ?? [])
    .reduce(
      (current, change) =>
        change.to === "off"
          ? removeGarment(current, change.garment)
          : addGarment(current, change.garment),
      wardrobe,
    );

// Each prop replaces the earlier entry of its kind (or its name, for an "other" item), so the scene holds one of each.
const scenePropsAfter = (state: LiveState, plan: DirectorPlan): SceneProp[] =>
  plan.props
    .reduce<SceneProp[]>(
      (props, prop) => [
        ...props.filter((scene) =>
          prop.kind === "other"
            ? scene.item !== prop.item
            : scene.kind !== prop.kind,
        ),
        {
          item: prop.item,
          kind: prop.kind,
          at: prop.ends,
          where: prop.endsWhere,
        },
      ],
      currentSceneProps(state),
    )
    .slice(-6);

export const directorClipPlan = ({
  plan,
  session,
  job,
  speechMode,
  durationSec,
}: {
  plan: DirectorPlan;
  session: LiveSessionSnapshot;
  job: Extract<ClipJob, { kind: "reply" }>;
  speechMode: SpeechMode;
  durationSec: number;
}): ClipPlan => {
  const { state, creator } = session;
  const nextWardrobe = wardrobeAfter(state.wardrobe, plan);
  const { pose, facing, hands, contact, prop, framing } = plan.endState;
  const firstChange = plan.beats.flatMap((beat) => beat.wardrobe ?? [])[0];
  const removes = plan.beats.some((beat) =>
    beat.wardrobe?.some((change) => change.to === "off"),
  );
  // Matches the catalogue: taking a garment off is explicit content even when no act follows.
  const explicit = plan.explicit || removes;
  const beatLines = plan.beats
    .map((beat) => `${beat.fromSec}-${beat.toSec}s: ${beat.action}`)
    .join(" ");
  return {
    prompt: buildDirectorPrompt({
      plan,
      state,
      nextWardrobe,
      creator,
      speechMode,
      durationSec,
      explicit,
    }),
    durationSec,
    expectedState: {
      ...state,
      wardrobe: nextWardrobe,
      body: { pose, facing, hands, contact, prop, framing },
      sceneProps: scenePropsAfter(state, plan),
    },
    // The whole request plays in this one clip, and the next one chains from where it ends.
    followUps: [],
    replyDraft: {
      channel: job.channel,
      typingLeadSec:
        job.channel === "chat" && job.precededByIdle
          ? typingLeadSecFor(job.text)
          : 0,
    },
    needsReplyText: true,
    fixedReplyText: null,
    wardrobeIntent: firstChange
      ? firstChange.to === "off"
        ? "remove"
        : "add"
      : null,
    targetGarment: firstChange?.garment,
    explicit,
    replyPhysical: `${plan.interpretation.join("; ")}. ${beatLines}`,
  };
};

// --- Director step ------------------------------------------------------------

const HOLD_LINE =
  "She smiles softly, gives a small slow shake of her head, and settles back into her pose, hands resting where they were.";
// Fixed so the reply LLM never sees a request that tripped a hard limit.
const DECLINE_REPLY = "not that, babe. ask me something else";

const holdPlan = (
  args: DirectArgs,
  reason: string,
  started: number,
): ClipPlan => {
  console.log(
    `directClip: hold reason=${reason} model=${DIRECTOR_MODEL} ms=${Date.now() - started}`,
  );
  const plan = planClip({
    ...args,
    parsedIntents: [{ type: "hold", line: HOLD_LINE }],
  });
  return { ...plan, needsReplyText: false, fixedReplyText: DECLINE_REPLY };
};

class DirectorTimeoutError extends Error {}

const withinMs = <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DirectorTimeoutError()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

type DirectArgs = {
  session: LiveSessionSnapshot;
  job: Extract<ClipJob, { kind: "reply" }>;
  speechMode: SpeechMode;
  backend: RenderBackend;
};

// Runs for every reply on both planners, so the catalogue never renders a request that trips a hard limit either.
export const hardLimitHold = (args: DirectArgs): ClipPlan | null => {
  const request = correctActionTypos(args.job.text);
  if (MINOR_CUE_RE.test(request)) return holdPlan(args, "minorCue", Date.now());
  if (HARD_LIMIT_CUE_RE.test(request))
    return holdPlan(args, "hardLimitCue", Date.now());
  return null;
};

// Null falls back to the catalogue; a hard-limit cue returns a hold clip, never the catalogue.
export const directClip = async (
  args: DirectArgs,
): Promise<ClipPlan | null> => {
  const { session, job, speechMode, backend } = args;
  const started = Date.now();
  const request = correctActionTypos(job.text);
  const held = hardLimitHold(args);
  if (held) return held;
  const fallback = (reason: string): null => {
    console.log(
      `directClip: fallback reason=${reason} model=${DIRECTOR_MODEL} ms=${Date.now() - started}`,
    );
    return null;
  };
  if (!isSwapSession(backend)) return fallback("backend");

  const durationSec =
    backend === "wan14b"
      ? LIVE_TUNABLES.WAN14B_CLIP_SEC
      : LIVE_TUNABLES.SWAP_ACTION_CLIP_SEC;
  const input = directorInputFor({
    state: session.state,
    creator: session.creator,
    transcript: session.transcript,
    request,
    speechMode,
    clipSec: durationSec,
  });
  const deadline = started + LIVE_TUNABLES.DIRECTOR_BUDGET_MS;
  const messages = directorMessagesFor(input);
  const ask = async (
    conversation: DirectorMessage[],
  ): Promise<DirectorOutcome & { raw?: string }> => {
    try {
      const { content } = await withinMs(
        callDirectorModel(DIRECTOR_MODEL, conversation, deadline - Date.now()),
        deadline - Date.now(),
      );
      return { ...judgeDirectorOutput(content, input), raw: content };
    } catch (error) {
      if (!(error instanceof DirectorTimeoutError))
        console.warn("directClip: director call failed", error);
      return {
        kind: "fallback",
        reason: error instanceof DirectorTimeoutError ? "timeout" : "error",
      };
    }
  };

  let outcome = await ask(messages);
  let repaired = false;
  if (outcome.kind === "repair") {
    if (deadline - Date.now() < MIN_REPAIR_MS) return fallback("invalid");
    repaired = true;
    outcome = await ask([
      ...messages,
      { role: "assistant", content: outcome.raw ?? "" },
      {
        role: "user",
        content: `That plan has these problems: ${outcome.errors.join("; ")}. Return the corrected JSON object only.`,
      },
    ]);
  }
  switch (outcome.kind) {
    case "hold":
      return holdPlan(args, outcome.reason, started);
    case "fallback":
      return fallback(outcome.reason);
    case "repair":
      return fallback("invalid");
    case "plan":
      console.log(
        `directClip: model=${DIRECTOR_MODEL} ms=${Date.now() - started} composition=${outcome.plan.composition} beats=${outcome.plan.beats.length} repaired=${repaired} fallback=none`,
      );
      return directorClipPlan({
        plan: outcome.plan,
        session,
        job,
        speechMode,
        durationSec,
      });
  }
};
