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

// Assume normally clothed when capture fails or the photo doesn't show her torso — assuming lingerie
// here was why she was already undressed in clip one on a face-only reference photo.
const DEFAULT_WARDROBE: Wardrobe = {
  top: { on: true, description: "casual top" },
  bottom: { on: true, description: "casual bottoms" },
  bra: { on: true, description: "bra" },
  panties: { on: true, description: "panties" },
  removedOrder: [],
};

const CAPTURE_PROMPT =
  "Look at this reference photo of an adult woman. Describe her current outfit, surroundings, and camera " +
  'framing for a video generation prompt library. Return ONLY JSON: {"torsoVisible":bool,' +
  '"top":{"on":bool,"description":"..."},"bottom":{"on":bool,"description":"..."},' +
  '"bra":{"on":bool,"description":"..."},"panties":{"on":bool,"description":"..."},' +
  '"lookLock":"...","surroundings":"...","framing":"wider|medium|torso"}. ' +
  "torsoVisible is false when the photo is cropped to face/head/shoulders only and does not show enough " +
  "of her chest or waist to judge what she is wearing — in that case still fill top/bottom/bra/panties " +
  "with your best guess, but torsoVisible:false is what matters, since the caller will ignore the guess " +
  "and assume ordinary clothing instead. top/bottom are outer garments only (shirt, dress, pants, skirt) " +
  "— a bra or panties never counts as a top or bottom. If torsoVisible is true and she is in lingerie " +
  "only, with no separate outer garment visible over the bra or panties, set top.on and bottom.on to " +
  "false. Set on:true for a garment only if you can actually see it worn in the photo; never guess a " +
  "garment is on because a woman would typically be wearing one. Each description is a short exact " +
  "phrase (color, fabric, style) of that garment as it is visible now, or a generic phrase if it is off. lookLock " +
  "describes hair, skin tone, and build only — never a real person's identity. surroundings is a short factual " +
  "description of the actual room and camera setup visible in the background of THIS photo (furniture, lighting, " +
  "wall, any webcam/desk framing) — never an invented or generic room, only what is actually visible. framing is " +
  'how much of her body this exact photo shows: "wider" for full body or most of it, "medium" for roughly ' +
  'waist-up, "torso" for a tight chest-up or closer crop — match the actual crop of this photo, not a guess.';

type WardrobeCapture = {
  torsoVisible?: boolean;
  top?: { on?: boolean; description?: string };
  bottom?: { on?: boolean; description?: string };
  bra?: { on?: boolean; description?: string };
  panties?: { on?: boolean; description?: string };
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

const toWardrobe = (capture: WardrobeCapture | null): Wardrobe => {
  if (!capture) return DEFAULT_WARDROBE;
  // With no torso in frame the model has nothing to base a guess on, so ignore whatever it returned.
  if (capture.torsoVisible === false) return DEFAULT_WARDROBE;
  const garment = (
    id: keyof WardrobeCapture,
    fallback: string,
    defaultOn: boolean,
  ) => ({
    on: (capture[id] as { on?: boolean } | undefined)?.on ?? defaultOn,
    description:
      (capture[id] as { description?: string } | undefined)?.description?.slice(
        0,
        80,
      ) || fallback,
  });
  return {
    top: garment("top", "top", true),
    bottom: garment("bottom", "bottoms", true),
    bra: garment("bra", "bra", true),
    panties: garment("panties", "panties", true),
    removedOrder: [],
  };
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
    wardrobe: toWardrobe(capture),
    lookLock:
      capture?.lookLock?.slice(0, 600) || "an adult woman with a natural build",
    surroundings: capture?.surroundings?.slice(0, 400) || undefined,
    framing: FRAMING_VALUES.has(capture?.framing ?? "")
      ? (capture?.framing as "wider" | "medium" | "torso")
      : undefined,
    captured,
  });
}
