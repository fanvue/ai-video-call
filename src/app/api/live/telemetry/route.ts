import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/fanvue";

export const maxDuration = 10;

// Client-side playback events (buffer empty, player holds, connect stalls) that are otherwise invisible in production logs.
const bodySchema = z.object({
  event: z.string().min(1).max(40),
  detail: z
    .record(
      z.string(),
      z.union([z.string().max(200), z.number(), z.boolean(), z.null()]),
    )
    .default({}),
});

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const detail = Object.entries(parsed.data.detail)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  console.log(`live/telemetry: ${parsed.data.event} ${detail}`.trim());
  return NextResponse.json({ ok: true });
}
