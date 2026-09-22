import { NextResponse } from "next/server";
import { z } from "zod";
import { uploadReferenceImageToFal } from "@/lib/fal/uploadImage";
import { getCurrentUser } from "@/lib/fanvue";
import { createGroqVisionCompletion } from "@/lib/groq";
import { SURROUNDINGS_BY_SCENE } from "@/lib/live/client/defaultLiveState";
import {
  LIVE_TUNABLES,
  sceneIdSchema,
  type Wardrobe,
} from "@/lib/live/contract";
import { stageSeed } from "@/lib/live/server/stageSeed";

export const maxDuration = 60;

const bodySchema = z.object({
  imageBase64: z.string().min(1),
  contentType: z.union([z.literal("image/jpeg"), z.literal("image/png")]),
  // Selected room; with it the reference step also stages the in-scene still the greeting starts on.
  sceneId: sceneIdSchema.optional(),
  // Swap mode sets the scene in its reference-to-video greeting instead, so it skips the still.
  stage: z.boolean().optional(),
});

// She always starts a session in lingerie — top/bottom start off, bra/panties white, regardless of what capture reports.
const DEFAULT_WARDROBE: Wardrobe = {
  top: { on: false, description: "top" },
  bottom: { on: false, description: "bottoms" },
  bra: { on: true, description: "white bra" },
  panties: { on: true, description: "white panties" },
  removedOrder: [],
};

// Bra/panties are fixed canon (white), so this only needs identity/scene facts, not a lingerie judgment.
const CAPTURE_PROMPT =
  "Look at this reference photo of an adult woman, who is starting this session in lingerie. Describe " +
  "her, her surroundings, and camera framing. Return ONLY JSON: " +
  '{"lookLock":"...","surroundings":"...","framing":"wider|medium|torso"}. ' +
  "lookLock describes hair, skin tone, and build only — never a real person's identity. " +
  "surroundings is a short factual description of the actual room and camera setup visible in the " +
  "background of THIS photo (furniture, lighting, wall, any webcam/desk framing) — never an invented or " +
  "generic room, only what is actually visible. framing is how much of her body this exact photo shows: " +
  '"wider" for full body or most of it, "medium" for roughly waist-up, "torso" for a tight chest-up or ' +
  "closer crop — match the actual crop of this photo, not a guess.";

type WardrobeCapture = {
  lookLock?: string;
  surroundings?: string;
  framing?: string;
};

const FRAMING_VALUES = new Set(["wider", "medium", "torso"]);

const parseCapture = (raw: string): WardrobeCapture | null => {
  const cleaned = raw.replace(/^```json\s*|\s*```$/g, "").trim();
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

  // The vision capture only needs pixels, not a hosted URL, so it starts on the data URI instead of waiting on the fal upload.
  const captureLook = async (): Promise<WardrobeCapture | null> => {
    try {
      const completion = await createGroqVisionCompletion({
        imageUrl: `data:${contentType};base64,${imageBase64}`,
        prompt: CAPTURE_PROMPT,
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
  const [anchorFrameUrl, capture] = await Promise.all([
    uploadReferenceImageToFal(Buffer.from(imageBase64, "base64"), contentType),
    captureLook(),
  ]);
  const staged =
    LIVE_TUNABLES.STAGE_SEED && sceneId && parsed.data.stage !== false
      ? await stageSeed({
          referenceUrl: anchorFrameUrl,
          sceneId,
          lookLock: "an adult woman with a natural build",
        })
      : null;
  const captured = capture !== null;
  const capturedFraming = FRAMING_VALUES.has(capture?.framing ?? "")
    ? (capture?.framing as "wider" | "medium" | "torso")
    : undefined;

  return NextResponse.json({
    anchorFrameUrl,
    // The greeting's first frame. A staged still already shows the selected room and the canon lingerie, so the prompt no longer contradicts the seed.
    seedFrameUrl: staged?.url ?? anchorFrameUrl,
    staged: staged !== null,
    stageCostUsd: staged?.costUsd ?? 0,
    wardrobe: DEFAULT_WARDROBE,
    lookLock:
      capture?.lookLock?.slice(0, 600) || "an adult woman with a natural build",
    // Staged: the still is the room, so its preset describes what the first clip shows; otherwise the photo's own background.
    surroundings:
      staged && sceneId
        ? SURROUNDINGS_BY_SCENE[sceneId]
        : capture?.surroundings?.slice(0, 400) || undefined,
    framing: staged ? "medium" : capturedFraming,
    captured,
  });
}
