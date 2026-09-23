import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/fanvue";
import {
  creatorProfileSchema,
  inputChannelSchema,
  intentParserSchema,
  liveStateSchema,
  speechModeSchema,
  transcriptEntrySchema,
} from "@/lib/live/contract";
import {
  planLongLiveCheckIn,
  planLongLiveGreeting,
  planLongLiveRequest,
} from "@/lib/live/server/longlivePrompt";
import { writeCheckIn, writeReply } from "@/lib/live/server/writeReply";

export const maxDuration = 30;

// requestText absent is the session's opening prompt (or a check-in), which has no fan ask to reply to.
const bodySchema = z.object({
  creator: creatorProfileSchema,
  state: liveStateSchema,
  transcript: z.array(transcriptEntrySchema).max(40),
  requestText: z.string().min(1).max(2000).optional(),
  channel: inputChannelSchema.default("chat"),
  speechMode: speechModeSchema.default("text"),
  // The Advanced "Request understanding" setting, applied exactly as clip mode applies it.
  intentParser: intentParserSchema.default("regex"),
  // True once the clothing in `state` has been seen on the stream, so prompts may name it.
  wardrobeObserved: z.boolean().default(false),
  checkIn: z.boolean().default(false),
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
  const {
    creator,
    state,
    transcript,
    requestText,
    channel,
    speechMode,
    intentParser,
    wardrobeObserved,
    checkIn,
  } = parsed.data;

  if (checkIn) {
    const step = planLongLiveCheckIn(creator, state, wardrobeObserved);
    // A failed line still lets the check-in motion play; she just says nothing.
    const reply = await writeCheckIn({
      transcript,
      creator,
      channel,
      world: state.world,
      speechMode,
    }).catch(() => null);
    return NextResponse.json({
      prompt: step.prompt,
      settlePrompt: step.settlePrompt,
      state: step.nextState,
      reply: reply?.text ?? null,
      wardrobeCheck: step.wardrobeCheck,
    });
  }

  if (!requestText) {
    const step = planLongLiveGreeting(creator, state);
    return NextResponse.json({
      prompt: step.prompt,
      settlePrompt: step.settlePrompt,
      state: step.nextState,
      reply: null,
      wardrobeCheck: step.wardrobeCheck,
    });
  }

  try {
    // Both are Groq calls with no dependency on each other, so the action rewrite adds no latency on top of the reply.
    const [step, reply] = await Promise.all([
      planLongLiveRequest(creator, state, requestText, {
        intentParser,
        wardrobeObserved,
      }),
      writeReply({
        transcript,
        requestText,
        physical: LONGLIVE_PHYSICAL,
        creator,
        channel,
        world: state.world,
        speechMode,
      }),
    ]);
    return NextResponse.json({
      prompt: step.prompt,
      settlePrompt: step.settlePrompt,
      state: step.nextState,
      reply: reply.text,
      wardrobeCheck: step.wardrobeCheck,
      handoff: step.handoff,
      fallbackPrompt: step.fallbackPrompt,
    });
  } catch (error) {
    console.warn("live/longlivePrompt: compose failed", error);
    return NextResponse.json(
      { error: "Could not compose LongLive prompt" },
      { status: 502 },
    );
  }
}
