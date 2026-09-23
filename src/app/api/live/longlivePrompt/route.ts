import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/fanvue";
import {
  creatorProfileSchema,
  inputChannelSchema,
  liveStateSchema,
  speechModeSchema,
  transcriptEntrySchema,
} from "@/lib/live/contract";
import {
  planLongLiveGreeting,
  planLongLiveRequest,
} from "@/lib/live/server/longlivePrompt";
import { writeReply } from "@/lib/live/server/writeReply";

export const maxDuration = 30;

// requestText absent is the session's opening prompt, which has no fan ask to reply to.
const bodySchema = z.object({
  creator: creatorProfileSchema,
  state: liveStateSchema,
  transcript: z.array(transcriptEntrySchema).max(40),
  requestText: z.string().min(1).max(2000).optional(),
  channel: inputChannelSchema.default("chat"),
  speechMode: speechModeSchema.default("text"),
});

// Like director, LongLive has no discrete clip to describe, so `physical` names the ongoing stream.
const LONGLIVE_PHYSICAL =
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
  const { creator, state, transcript, requestText, channel, speechMode } =
    parsed.data;

  if (!requestText) {
    const step = planLongLiveGreeting(creator, state);
    return NextResponse.json({
      prompt: step.prompt,
      settlePrompt: step.settlePrompt,
      state: step.nextState,
      reply: null,
    });
  }

  try {
    const step = planLongLiveRequest(creator, state, requestText);
    const reply = await writeReply({
      transcript,
      requestText,
      physical: LONGLIVE_PHYSICAL,
      creator,
      channel,
      world: state.world,
      speechMode,
    });
    return NextResponse.json({
      prompt: step.prompt,
      settlePrompt: step.settlePrompt,
      state: step.nextState,
      reply: reply.text,
    });
  } catch (error) {
    console.warn("live/longlivePrompt: compose failed", error);
    return NextResponse.json(
      { error: "Could not compose LongLive prompt" },
      { status: 502 },
    );
  }
}
