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

export const GROQ_VISION_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";

export const createGroqVisionCompletion = async ({
  model = GROQ_VISION_MODEL,
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
  return getGroqInstance().chat.completions.create({
    model,
    response_format: responseFormat,
    messages: [{ role: "user", content }],
  });
};
