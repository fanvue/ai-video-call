import { createGroqVisionCompletion } from "@/lib/groq";

const ROOM_PROMPT =
  "This is a frame from a fixed webcam. Describe only the room and the objects actually visible, not the person. " +
  'Return ONLY JSON: {"room":"..."}. room is one or two short factual sentences: the furniture she is on or at, ' +
  "the wall and window, the light source and its direction, then every other object in frame with where it sits " +
  "(left, right, behind her). Name nothing that is not visible; no laptop, desk or screen unless one is in frame.";

const ROOM_MAX_CHARS = 400;

// One vision read of a rendered frame; null on any failure so the caller keeps its current ROOM text.
export const captureRoom = async (frameUrl: string): Promise<string | null> => {
  try {
    const completion = await createGroqVisionCompletion({
      imageUrl: frameUrl,
      prompt: ROOM_PROMPT,
      responseFormat: { type: "json_object" },
    });
    const raw = completion.choices[0]?.message?.content?.trim() ?? "";
    const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? raw) as {
      room?: unknown;
    };
    return typeof parsed.room === "string" && parsed.room.trim()
      ? parsed.room.trim().slice(0, ROOM_MAX_CHARS)
      : null;
  } catch (error) {
    console.warn("captureRoom: room capture failed, keeping ROOM text", error);
    return null;
  }
};
