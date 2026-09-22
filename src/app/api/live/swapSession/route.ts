import { NextResponse } from "next/server";
import { env } from "@/env";
import { getCurrentUser } from "@/lib/fanvue";

// Hands a signed-in user the Swap service URL with the shared token in the query string, since a
// browser WebSocket cannot set headers. The token never appears in client code or the bundle.
export async function POST() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!env.SWAP_WS_URL || !env.SWAP_TOKEN) {
    return NextResponse.json(
      { error: "Swap service is not configured" },
      { status: 503 },
    );
  }
  const url = new URL(env.SWAP_WS_URL);
  url.searchParams.set("token", env.SWAP_TOKEN);
  return NextResponse.json({ url: url.toString() });
}
