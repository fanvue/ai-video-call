import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/fanvue";
import { upscaleFrame } from "@/lib/live/server/upscaleFrame";

export const maxDuration = 60;

const bodySchema = z.object({ frameUrl: z.url() });

// Called by the client AFTER a clip is already playing, never blocking clipReady — see
// pipeline.ts's post-settle upscale call. Fails open: a failed/timed-out upscale is a no-op.
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

  const result = await upscaleFrame(parsed.data.frameUrl);
  return NextResponse.json({
    url: result?.url ?? null,
    costUsd: result?.costUsd ?? 0,
  });
}
