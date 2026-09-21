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

// Falls back only when vision capture fails outright. Assumes lingerie rather than full outerwear —
// claiming an outer garment that isn't in the photo is the failure mode that actually got reported.
const DEFAULT_WARDROBE: Wardrobe = {
  top: { on: false, description: "top" },
  bottom: { on: false, description: "bottoms" },
  bra: { on: true, description: "bra" },
  panties: { on: true, description: "panties" },
  removedOrder: [],
};

const CAPTURE_PROMPT =
  "Look at this reference photo of an adult woman. Describe her current outfit and her surroundings for a " +
  'video generation prompt library. Return ONLY JSON: {"top":{"on":bool,"description":"..."},' +
  '"bottom":{"on":bool,"description":"..."},"bra":{"on":bool,"description":"..."},' +
  '"panties":{"on":bool,"description":"..."},"lookLock":"...","surroundings":"..."}. ' +
  "top/bottom are outer garments only (shirt, dress, pants, skirt) — a bra or panties never counts as a top or " +
  "bottom. If she is in lingerie only, with no separate outer garment visible over the bra or panties, set " +
  "top.on and bottom.on to false. Set on:true for a garment only if you can actually see it worn in the photo; " +
  "never guess a garment is on because a woman would typically be wearing one. Each description is a short exact " +
  "phrase (color, fabric, style) of that garment as it is visible now, or a generic phrase if it is off. lookLock " +
  "describes hair, skin tone, and build only — never a real person's identity. surroundings is a short factual " +
  "description of the actual room and camera setup visible in the background of THIS photo (furniture, lighting, " +
  "wall, any webcam/desk framing) — never an invented or generic room, only what is actually visible.";

type WardrobeCapture = {
  top?: { on?: boolean; description?: string };
  bottom?: { on?: boolean; description?: string };
  bra?: { on?: boolean; description?: string };
  panties?: { on?: boolean; description?: string };
  lookLock?: string;
  surroundings?: string;
};

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
  // Never guess an outer garment is on when the model omits `on` — that's the misreported-lingerie bug.
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
    top: garment("top", "top", false),
    bottom: garment("bottom", "bottoms", false),
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
    captured,
  });
}
