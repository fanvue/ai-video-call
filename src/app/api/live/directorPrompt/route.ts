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
    // A steering prompt directs the next moment against the session premise (see buildDirectorPremise), so it restates only what must not drift and what changes now.
    const speechLine =
      speechMode === "native"
        ? ` She says to camera, lip-synced: "${reply.text.replace(/"/g, "'")}".`
        : " She stays silent, reacting with her face and body.";
    const prompt = (
      `Same uncut webcam livestream, same woman (${creator.lookLock}), same room and camera, continuing from the current frame with no cut. ` +
      `A viewer just asked: "${requestText.replace(/"/g, "'")}". She does exactly that now, playfully and fully, looking into the lens.` +
      speechLine +
      " Only what this direction names changes; her face, hair, body and the room stay identical."
    ).slice(0, 2000);
    return NextResponse.json({ prompt, reply: reply.text });
  } catch (error) {
    console.warn("live/directorPrompt: writeReply failed", error);
    return NextResponse.json(
      { error: "Could not compose director prompt" },
      { status: 502 },
    );
  }
}
