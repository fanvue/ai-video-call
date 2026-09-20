import { NextResponse } from "next/server";
import { z } from "zod";
import { uploadReferenceImageToFal } from "@/lib/fal/uploadImage";
import { getCurrentUser } from "@/lib/fanvue";
import { createGroqVisionCompletion } from "@/lib/groq";
import type { Wardrobe } from "@/lib/live/contract";

const bodySchema = z.object({
  imageBase64: z.string().min(1),
  contentType: z.union([z.literal("image/jpeg"), z.literal("image/png")]),
});

const DEFAULT_WARDROBE: Wardrobe = {
  top: { on: true, description: "top" },
  bottom: { on: true, description: "bottoms" },
  bra: { on: true, description: "bra" },
  panties: { on: true, description: "panties" },
  removedOrder: [],
};

const CAPTURE_PROMPT =
  "Look at this reference photo of an adult woman. Describe her current outfit for a video generation " +
  'prompt library. Return ONLY JSON: {"top":{"on":bool,"description":"..."},"bottom":{"on":bool,"description":"..."},' +
  '"bra":{"on":bool,"description":"..."},"panties":{"on":bool,"description":"..."},"lookLock":"..."}. ' +
  "Each description is a short exact phrase (color, fabric, style) of that garment as it is visible now, or a generic " +
  "phrase if it is not visible. lookLock describes hair, skin tone, and build only — never a real person's identity.";

type WardrobeCapture = {
  top?: { on?: boolean; description?: string };
  bottom?: { on?: boolean; description?: string };
  bra?: { on?: boolean; description?: string };
  panties?: { on?: boolean; description?: string };
  lookLock?: string;
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
  const garment = (id: keyof WardrobeCapture, fallback: string) => ({
    on: (capture[id] as { on?: boolean } | undefined)?.on ?? true,
    description:
      (capture[id] as { description?: string } | undefined)?.description?.slice(
        0,
        80,
      ) || fallback,
  });
  return {
    top: garment("top", "top"),
    bottom: garment("bottom", "bottoms"),
    bra: garment("bra", "bra"),
    panties: garment("panties", "panties"),
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
    captured,
  });
}
