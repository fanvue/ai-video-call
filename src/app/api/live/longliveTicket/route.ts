import { NextResponse } from "next/server";
import { env } from "@/env";
import { getCurrentUser } from "@/lib/fanvue";
import { mintLongLiveTicket } from "@/lib/live/server/longliveTicket";

export async function POST() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!env.LONGLIVE_TOKEN || !env.LONGLIVE_URL) {
    return NextResponse.json(
      { error: "LongLive is not configured" },
      { status: 503 },
    );
  }
  // The shared secret signs the ticket here and never leaves the server; never log the ticket.
  const { ticket, expiresAt } = mintLongLiveTicket(
    env.LONGLIVE_TOKEN,
    Date.now(),
  );
  return NextResponse.json({ ticket, url: env.LONGLIVE_URL, expiresAt });
}
