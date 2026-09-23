import { NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/env";
import { getCurrentUser } from "@/lib/fanvue";
import { personaOptionSchema } from "@/lib/live/contract";
import { mintLongLiveTicket } from "@/lib/live/server/longliveTicket";
import { personaRegistrar } from "@/lib/live/server/personaRegistrar";

// The manifest lives on the LongLive container, which can be mid cold start when the setup screen asks.
export const maxDuration = 300;

const listingSchema = z.object({ personas: z.array(personaOptionSchema) });

export async function GET() {
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
  const canRegister = personaRegistrar(user) !== null;
  try {
    const url = new URL("/personas", env.LONGLIVE_URL.replace(/^ws/, "http"));
    url.searchParams.set(
      "ticket",
      mintLongLiveTicket(env.LONGLIVE_TOKEN, Date.now()).ticket,
    );
    const response = await fetch(url, {
      signal: AbortSignal.timeout(290_000),
    });
    const parsed = listingSchema.safeParse(
      await response.json().catch(() => null),
    );
    if (!response.ok || !parsed.success) {
      console.warn(`live/personas: listing failed (${response.status})`);
      return NextResponse.json({ personas: [], canRegister });
    }
    // Rebuilt field by field so nothing beyond id, note, name and addedAt can reach the browser.
    return NextResponse.json({
      personas: parsed.data.personas.map(({ id, note, name, addedAt }) => ({
        id,
        note,
        name,
        addedAt,
      })),
      canRegister,
    });
  } catch (error) {
    console.warn("live/personas: listing failed", error);
    return NextResponse.json({ personas: [], canRegister });
  }
}
