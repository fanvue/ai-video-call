import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/fanvue";
import {
  creatorProfileSchema,
  garmentIdSchema,
  liveStateSchema,
} from "@/lib/live/contract";
import { observeLongLiveWardrobe } from "@/lib/live/server/longliveObserve";

export const maxDuration = 30;

// One 480x832 JPEG from the client's canvas is well under this; the cap keeps a bad client off the vision call.
const MAX_FRAME_BASE64 = 1_500_000;

const bodySchema = z.object({
  creator: creatorProfileSchema,
  state: liveStateSchema,
  garments: z.array(garmentIdSchema).min(1).max(4),
  frameBase64: z.string().min(1).max(MAX_FRAME_BASE64),
  referenceImageUrl: z.string().url().startsWith("https://"),
});

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
  const { creator, state, garments, frameBase64, referenceImageUrl } =
    parsed.data;
  // The vision model reads the frame from a data URI, as the reference route's capture does, so nothing is stored.
  const observation = await observeLongLiveWardrobe({
    creator,
    expected: state,
    garments,
    frameUrl: `data:image/jpeg;base64,${frameBase64}`,
    referenceImageUrl,
  });
  return NextResponse.json(observation);
}
