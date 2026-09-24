import { NextResponse } from "next/server";
import { z } from "zod";
import { uploadReferenceImageToFal } from "@/lib/fal/uploadImage";
import { getCurrentUser } from "@/lib/fanvue";
import { createGroqVisionCompletion, stripThinkBlock } from "@/lib/groq";
import { SURROUNDINGS_BY_SCENE } from "@/lib/live/client/defaultLiveState";
import {
  sceneIdSchema,
  type CreatorGender,
  type Wardrobe,
} from "@/lib/live/contract";
import { personaFor, type Persona } from "@/lib/live/persona";
import { stageRoomFor } from "@/lib/live/server/sceneRooms";
import { stageSeed } from "@/lib/live/server/stageSeed";
import { swapServiceFaceCrop } from "@/lib/live/server/swapClip";

export const maxDuration = 60;

const bodySchema = z.object({
  imageBase64: z.string().min(1),
  contentType: z.union([z.literal("image/jpeg"), z.literal("image/png")]),
  // Selected room; with it the reference step also stages the in-scene still the greeting starts on.
  sceneId: sceneIdSchema.optional(),
  // Swap mode sets the scene in its reference-to-video greeting instead, so it skips the still.
  stage: z.boolean().optional(),
  // LongLive streams from the whole seed, so it skips the crop rather than wake the swap GPUs it would queue behind.
  faceCrop: z.boolean().optional(),
  // Absent is female, as before male creators.
  gender: z.enum(["female", "male"]).optional(),
});

// She always starts a session in lingerie — top/bottom start off, bra/panties white, regardless of what capture reports.
// He starts in a white t-shirt and grey boxer briefs; his panties slot is his underwear and he never has a bra (off and never removed, so it can never appear).
const DEFAULT_WARDROBE: Record<CreatorGender, Wardrobe> = {
  female: {
    top: { on: false, description: "top" },
    bottom: { on: false, description: "bottoms" },
    bra: { on: true, description: "white bra" },
    panties: { on: true, description: "white panties" },
    removedOrder: [],
  },
  male: {
    top: { on: true, description: "white crew-neck t-shirt" },
    bottom: { on: false, description: "bottoms" },
    bra: { on: false, description: "bra" },
    panties: { on: true, description: "grey boxer briefs" },
    removedOrder: [],
  },
};

// Bra/panties are fixed canon (white), so this only needs identity/scene facts, not a lingerie judgment.
const capturePrompt = (p: Persona): string =>
  `Look at this reference photo of an adult ${p.noun}, who is starting this session in ${p.gender === "male" ? "underwear" : "lingerie"}. Describe ` +
  `${p.object}, ${p.possessive} surroundings, and camera framing. Return ONLY JSON: ` +
  '{"lookLock":"...","surroundings":"...","framing":"wider|medium|torso"}. ' +
  "lookLock describes hair, skin tone, and build only — never a real person's identity. " +
  "surroundings is a short factual description of the actual room and camera setup visible in the " +
  "background of THIS photo (furniture, lighting, wall, any webcam/desk framing) — never an invented or " +
  `generic room, only what is actually visible. framing is how much of ${p.possessive} body this exact photo shows: ` +
  '"wider" for full body or most of it, "medium" for roughly waist-up, "torso" for a tight chest-up or ' +
  "closer crop — match the actual crop of this photo, not a guess.";

type WardrobeCapture = {
  lookLock?: string;
  surroundings?: string;
  framing?: string;
};

const FRAMING_VALUES = new Set(["wider", "medium", "torso"]);

const parseCapture = (raw: string): WardrobeCapture | null => {
  const cleaned = stripThinkBlock(raw)
    .replace(/^```json\s*|\s*```$/g, "")
    .trim();
  const objectMatch = cleaned.match(/\{[\s\S]*\}/);
  try {
    return JSON.parse(objectMatch?.[0] ?? cleaned) as WardrobeCapture;
  } catch {
    return null;
  }
};

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { imageBase64, contentType, sceneId } = parsed.data;
  const persona = personaFor(parsed.data);

  // The vision capture only needs pixels, not a hosted URL, so it starts on the data URI instead of waiting on the fal upload.
  const captureLook = async (): Promise<WardrobeCapture | null> => {
    try {
      const completion = await createGroqVisionCompletion({
        imageUrl: `data:${contentType};base64,${imageBase64}`,
        prompt: capturePrompt(persona),
        responseFormat: { type: "json_object" },
      });
      return parseCapture(
        completion.choices[0]?.message?.content?.trim() ?? "",
      );
    } catch (error) {
      console.warn(
        "live/reference: wardrobe capture failed or refused, using defaults",
        error,
      );
      return null;
    }
  };
  // Without a crop, chain clips stay on turbo rather than hand reference-to-video the whole photo.
  const cropIdentity = async (): Promise<string | undefined> => {
    if (parsed.data.faceCrop === false) {
      return undefined;
    }
    try {
      return await swapServiceFaceCrop(
        `data:${contentType};base64,${imageBase64}`,
      );
    } catch (error) {
      console.warn("live/reference: face crop failed", error);
      return undefined;
    }
  };
  const [anchorFrameUrl, capture, identityFrameUrl] = await Promise.all([
    uploadReferenceImageToFal(Buffer.from(imageBase64, "base64"), contentType),
    captureLook(),
    cropIdentity(),
  ]);
  const lookLock =
    capture?.lookLock?.slice(0, 600) ||
    `an adult ${persona.noun} with a natural build`;
  // Stage an in-scene still (selected room, canon lingerie) from the upload before the greeting; the raw photo's clothes and room otherwise contradict the prompt and the first clip visibly morphs.
  const staged =
    sceneId && parsed.data.stage !== false
      ? await stageSeed({
          referenceUrl: anchorFrameUrl,
          sceneId,
          lookLock,
          persona,
        })
      : null;
  const captured = capture !== null;
  const capturedFraming = FRAMING_VALUES.has(capture?.framing ?? "")
    ? (capture?.framing as "wider" | "medium" | "torso")
    : undefined;

  return NextResponse.json({
    anchorFrameUrl,
    identityFrameUrl,
    // The greeting's first frame. A staged still already shows the selected room and the canon lingerie, so the prompt no longer contradicts the seed.
    seedFrameUrl: staged?.url ?? anchorFrameUrl,
    staged: staged !== null,
    stageCostUsd: staged?.costUsd ?? 0,
    wardrobe: DEFAULT_WARDROBE[persona.gender],
    lookLock,
    // Staged: the still is the room, so its preset describes what the first clip shows; otherwise the photo's own background.
    // Swap mode's greeting draws the room from stageRoomFor, so the chain prompts start from that same text instead of the upload's room.
    surroundings:
      staged && sceneId
        ? SURROUNDINGS_BY_SCENE[sceneId]
        : parsed.data.stage === false && sceneId
          ? stageRoomFor(sceneId, persona)
          : capture?.surroundings?.slice(0, 400) || undefined,
    framing: staged ? "medium" : capturedFraming,
    captured,
  });
}
