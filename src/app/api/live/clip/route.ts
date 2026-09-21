import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/fanvue";
import { clipRequestSchema, clipResultSchema } from "@/lib/live/contract";
import { generateClip } from "@/lib/live/server/generateClip";

// Without this, Vercel's platform default kills the function mid-render, reading as a freeze.
export const maxDuration = 300;

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = clipRequestSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  try {
    const result = await generateClip(parsed.data);
    return NextResponse.json(clipResultSchema.parse(result));
  } catch (error) {
    console.warn("live/clip: generateClip failed", error);
    return NextResponse.json(
      { error: "Clip generation failed" },
      { status: 502 },
    );
  }
}
