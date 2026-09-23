import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/fanvue";
import {
  CLIP_STREAM_CONTENT_TYPE,
  clipRequestSchema,
  clipResultSchema,
} from "@/lib/live/contract";
import { generateClip } from "@/lib/live/server/generateClip";

// Without this, Vercel's platform default kills the function mid-render, reading as a freeze.
export const maxDuration = 300;

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = clipRequestSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  // Opt-in stream: a "rendered" line the moment the clip renders, then the "result" line, so the client's full swap overlaps the seed swap.
  if (request.headers.get("accept")?.includes(CLIP_STREAM_CONTENT_TYPE)) {
    const encoder = new TextEncoder();
    const clipRequest = parsed.data;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (line: unknown) =>
          controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        try {
          const result = await generateClip(clipRequest, (videoUrl) =>
            send({ type: "rendered", videoUrl }),
          );
          send({ type: "result", result: clipResultSchema.parse(result) });
        } catch (error) {
          console.warn("live/clip: generateClip failed", error);
          send({ type: "error", error: "Clip generation failed" });
        }
        controller.close();
      },
    });
    return new Response(stream, {
      headers: { "Content-Type": CLIP_STREAM_CONTENT_TYPE },
    });
  }

  try {
    const result = await generateClip(parsed.data);
    return NextResponse.json(clipResultSchema.parse(result));
  } catch (error) {
    console.warn("live/clip: generateClip failed", error);
    return NextResponse.json(
      { error: "Clip generation failed" },
      { status: 502 },
    );
  }
}
