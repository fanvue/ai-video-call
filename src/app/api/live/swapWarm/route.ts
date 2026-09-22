import { NextResponse } from "next/server";
import { env } from "@/env";
import { getCurrentUser } from "@/lib/fanvue";

// A cold swap container takes 60s+ (image pull, CUDA init, model load); the health probes make Modal
// start three while the reference upload and first turbo render are still in flight.
export const maxDuration = 120;

export async function POST() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!env.SWAP_SERVICE_URL || !env.SWAP_TOKEN) {
    return NextResponse.json(
      { error: "Swap service is not configured" },
      { status: 503 },
    );
  }
  try {
    // Three concurrent probes start three containers: two idle fillers and a reply swap in parallel.
    const responses = await Promise.all(
      [0, 1, 2].map(() =>
        fetch(new URL("/health", env.SWAP_SERVICE_URL as string), {
          signal: AbortSignal.timeout(110_000),
        }),
      ),
    );
    return NextResponse.json({ warm: responses.every((r) => r.ok) });
  } catch (error) {
    console.warn("live/swapWarm: health probe failed", error);
    return NextResponse.json({ warm: false });
  }
}
