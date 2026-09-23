import { NextResponse } from "next/server";
import { env } from "@/env";
import { getCurrentUser } from "@/lib/fanvue";

// A cold LongLive container takes about 2 min to load the model, so the setup screen wakes it when the mode is picked.
export const maxDuration = 300;

export async function POST() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!env.LONGLIVE_URL) {
    return NextResponse.json(
      { error: "LongLive is not configured" },
      { status: 503 },
    );
  }
  try {
    const healthUrl = new URL(
      "/health",
      env.LONGLIVE_URL.replace(/^ws/, "http"),
    );
    const response = await fetch(healthUrl, {
      signal: AbortSignal.timeout(290_000),
    });
    return NextResponse.json({ warm: response.ok });
  } catch (error) {
    console.warn("live/longliveWarm: health probe failed", error);
    return NextResponse.json({ warm: false });
  }
}
