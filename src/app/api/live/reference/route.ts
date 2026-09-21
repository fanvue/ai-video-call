import { NextResponse } from "next/server";
import { z } from "zod";
import { uploadReferenceImageToFal } from "@/lib/fal/uploadImage";
import { getCurrentUser } from "@/lib/fanvue";
import { createGroqVisionCompletion } from "@/lib/groq";
import type { Wardrobe } from "@/lib/live/contract";

export const maxDuration = 60;

const bodySchema = z.object({
  imageBase64: z.string().min(1),
  contentType: z.union([z.literal("image/jpeg"), z.literal("image/png")]),
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
  const { imageBase64, contentType } = parsed.data;

  const anchorFrameUrl = await uploadReferenceImageToFal(
    Buffer.from(imageBase64, "base64"),
    contentType,
  );

  let capture: WardrobeCapture | null = null;
  let captured = true;
  try {
    const completion = await createGroqVisionCompletion({
      imageUrl: anchorFrameUrl,
      prompt: CAPTURE_PROMPT,
      responseFormat: { type: "json_object" },
    });
    capture = parseCapture(
      completion.choices[0]?.message?.content?.trim() ?? "",
    );
    if (!capture) captured = false;
  } catch (error) {
    console.warn(
      "live/reference: wardrobe capture failed or refused, using defaults",
      error,
    );
    captured = false;
  }

  return NextResponse.json({
    anchorFrameUrl,
    wardrobe: DEFAULT_WARDROBE,
    lookLock:
      capture?.lookLock?.slice(0, 600) || "an adult woman with a natural build",
    surroundings: capture?.surroundings?.slice(0, 400) || undefined,
    framing: FRAMING_VALUES.has(capture?.framing ?? "")
      ? (capture?.framing as "wider" | "medium" | "torso")
      : undefined,
    captured,
  });
}
