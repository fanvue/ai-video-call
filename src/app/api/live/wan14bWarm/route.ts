import { NextResponse } from "next/server";
import { env } from "@/env";
import { getCurrentUser } from "@/lib/fanvue";
import { LIVE_TUNABLES } from "@/lib/live/contract";

// A cold Premium container is about 100 s to ready (smoke: 100.8 s including one clip); the greeting waits on this call.
export const maxDuration = 150;

export async function POST() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!env.WAN14B_SERVICE_URL || !env.SWAP_TOKEN) {
    return NextResponse.json(
      { error: "Premium service is not configured" },
      { status: 503 },
    );
  }
  const startedAt = Date.now();
  try {
    // One probe on purpose: each concurrent call can start its own H100.
    const response = await fetch(new URL("/warm", env.WAN14B_SERVICE_URL), {
      method: "POST",
      headers: { Authorization: `Bearer ${env.SWAP_TOKEN}` },
      signal: AbortSignal.timeout(LIVE_TUNABLES.WAN14B_WARM_WAIT_MS),
    });
    console.log(
      `live/wan14bWarm: status=${response.status} ms=${Date.now() - startedAt}`,
    );
    return NextResponse.json({ warm: response.ok });
  } catch (error) {
    console.warn(
      `live/wan14bWarm: probe failed ms=${Date.now() - startedAt}`,
      error,
    );
    return NextResponse.json({ warm: false });
  }
}
