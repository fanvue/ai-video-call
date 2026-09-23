import { NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/env";
import { getCurrentUser } from "@/lib/fanvue";
import { personaOptionSchema } from "@/lib/live/contract";
import { mintLongLiveTicket } from "@/lib/live/server/longliveTicket";
import { personaRegistrar } from "@/lib/live/server/personaRegistrar";

// Swap mode's list comes from the swap app's CPU persona store (services/swap/persona_store.py), so the setup screen never wakes a GPU; a cold CPU container answers in seconds.
export const maxDuration = 60;

const listingSchema = z.object({ personas: z.array(personaOptionSchema) });

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!env.SWAP_TOKEN || !env.SWAP_PERSONA_URL) {
    return NextResponse.json(
      { error: "Swap persona store is not configured" },
      { status: 503 },
    );
  }
  const canRegister = personaRegistrar(user) !== null;
  try {
    const url = new URL("/personas", env.SWAP_PERSONA_URL);
    url.searchParams.set(
      "ticket",
      mintLongLiveTicket(env.SWAP_TOKEN, Date.now()).ticket,
    );
    const response = await fetch(url, {
      signal: AbortSignal.timeout(50_000),
    });
    const parsed = listingSchema.safeParse(
      await response.json().catch(() => null),
    );
    if (!response.ok || !parsed.success) {
      console.warn(`live/swapPersonas: listing failed (${response.status})`);
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
    console.warn("live/swapPersonas: listing failed", error);
    return NextResponse.json({ personas: [], canRegister });
  }
}
