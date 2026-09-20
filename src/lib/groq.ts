import OpenAI from "openai";
import { env } from "@/env";

let groqInstance: OpenAI | null = null;
const getGroqInstance = (): OpenAI => {
  if (groqInstance === null) {
    groqInstance = new OpenAI({
      apiKey: env.GROQ_API_KEY,
      baseURL: "https://api.groq.com/openai/v1",
    });
  }
  return groqInstance;
};

export const GROQ_TEXT_MODEL = "openai/gpt-oss-120b";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export const createGroqChatCompletion = async ({
  model = GROQ_TEXT_MODEL,
  messages,
  temperature,
  reasoningEffort,
  responseFormat,
}: {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  reasoningEffort?: "low" | "medium" | "high";
  responseFormat?: { type: "json_object" };
}) =>
  getGroqInstance().chat.completions.create({
    model,
    messages,
    response_format: responseFormat,
    ...(temperature !== undefined ? { temperature } : {}),
    ...(reasoningEffort !== undefined
      ? { reasoning_effort: reasoningEffort }
      : {}),
  });

// Groq retires vision models without notice (scout 404s in prod); try each in order, remember the first that works.
export const GROQ_VISION_MODELS = [
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "meta-llama/llama-4-maverick-17b-128e-instruct",
  "llama-3.2-90b-vision-preview",
  "llama-3.2-11b-vision-preview",
] as const;
export const GROQ_VISION_MODEL = GROQ_VISION_MODELS[0];
let visionModelIndex = 0;

const isModelNotFound = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "status" in error &&
  (error as { status?: unknown }).status === 404;

export const createGroqVisionCompletion = async ({
  model,
  imageUrl,
  prompt,
  responseFormat,
}: {
  model?: string;
  imageUrl: string;
  prompt: string;
  responseFormat?: { type: "json_object" };
}) => {
  const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
    { type: "text", text: prompt },
    { type: "image_url", image_url: { url: imageUrl } },
  ];
  const candidates = model
    ? [model]
    : GROQ_VISION_MODELS.slice(visionModelIndex);
  for (const [offset, candidate] of candidates.entries()) {
    try {
      const completion = await getGroqInstance().chat.completions.create({
        model: candidate,
        response_format: responseFormat,
        messages: [{ role: "user", content }],
      });
      if (!model) {
        visionModelIndex += offset;
      }
      return completion;
    } catch (error) {
      if (!isModelNotFound(error) || offset === candidates.length - 1) {
        throw error;
      }
      console.warn(
        `groq vision: model ${candidate} not available, trying next`,
      );
    }
  }
  throw new Error("groq vision: no model available");
};
