import { NextResponse } from "next/server";
import { env } from "@/env";
import { getCurrentUser } from "@/lib/fanvue";

// A cold swap container takes ~35s to load its models; the health probe makes Modal start one while
// the reference upload and first turbo render are still in flight.
export const maxDuration = 60;

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
    // Two concurrent probes start two containers, since idle fillers and replies swap in parallel.
    const responses = await Promise.all(
      [0, 1].map(() =>
        fetch(new URL("/health", env.SWAP_SERVICE_URL as string), {
          signal: AbortSignal.timeout(55_000),
        }),
      ),
    );
    return NextResponse.json({ warm: responses.every((r) => r.ok) });
  } catch (error) {
    console.warn("live/swapWarm: health probe failed", error);
    return NextResponse.json({ warm: false });
  }
}
