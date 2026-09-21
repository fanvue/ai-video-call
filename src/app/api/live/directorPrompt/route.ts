import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/fanvue";
import {
  creatorProfileSchema,
  inputChannelSchema,
  speechModeSchema,
  transcriptEntrySchema,
} from "@/lib/live/contract";
import { writeReply } from "@/lib/live/server/writeReply";

export const maxDuration = 30;

const bodySchema = z.object({
  creator: creatorProfileSchema,
  transcript: z.array(transcriptEntrySchema).max(40),
  world: z.string().max(420),
  requestText: z.string().min(1).max(2000),
  channel: inputChannelSchema,
  speechMode: speechModeSchema.default("text"),
});

// Director has no discrete clip to describe, so `physical` names the ongoing stream rather than
// a specific timed action — writeReply only uses it to ground the reply in what's happening.
const DIRECTOR_PHYSICAL =
  "she is live on an ongoing, uncut stream, steering it toward this ask";

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { creator, transcript, world, requestText, channel, speechMode } =
    parsed.data;

  try {
    const reply = await writeReply({
      transcript,
      requestText,
      physical: DIRECTOR_PHYSICAL,
      creator,
      channel,
      world,
      speechMode,
    });
    // The steering prompt sent to the director stream; kept short and physically descriptive,
    // matching the same look-lock the clip backends use.
    const prompt =
      `${creator.lookLock} Live webcam stream. ${requestText}`.slice(0, 900);
    return NextResponse.json({ prompt, reply: reply.text });
  } catch (error) {
    console.warn("live/directorPrompt: writeReply failed", error);
    return NextResponse.json(
      { error: "Could not compose director prompt" },
      { status: 502 },
    );
  }
}
