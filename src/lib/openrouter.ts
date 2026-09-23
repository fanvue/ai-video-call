import { env } from "@/env";

// The shared key has no spend limit, so the spike caps itself: the key's usage read on 2026-09-23 ($20,506.46) plus $100. Other traffic on the key counts too, so this trips early, never late.
const USAGE_CEILING_USD = 20_606.46;
const USAGE_CACHE_MS = 20_000;

let usageCache: { usd: number; at: number } | null = null;

const readKeyUsage = async (apiKey: string): Promise<number> => {
  if (usageCache && Date.now() - usageCache.at < USAGE_CACHE_MS) {
    return usageCache.usd;
  }
  const res = await fetch("https://openrouter.ai/api/v1/key", {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`key usage check failed: ${res.status}`);
  const { data } = (await res.json()) as { data?: { usage?: number } };
  if (typeof data?.usage !== "number") {
    throw new Error("key usage check returned no usage");
  }
  usageCache = { usd: data.usage, at: Date.now() };
  return data.usage;
};

// Fails closed: a missing key, a failed usage read or a spent budget all refuse the call.
export const assertOpenRouterBudget = async (): Promise<string> => {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not configured");
  const usage = await readKeyUsage(apiKey);
  if (usage >= USAGE_CEILING_USD) {
    throw new Error(
      `OpenRouter budget spent: key usage $${usage.toFixed(2)} >= ceiling $${USAGE_CEILING_USD}`,
    );
  }
  return apiKey;
};

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "video_url"; video_url: { url: string } };

export type OpenRouterMessage = {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
};

export type OpenRouterResult = {
  content: string;
  costUsd: number;
  ms: number;
};

export const createOpenRouterCompletion = async ({
  model,
  messages,
  temperature,
  jsonObject,
  timeoutMs = 30_000,
  quiet = false,
}: {
  model: string;
  messages: OpenRouterMessage[];
  temperature?: number;
  jsonObject?: boolean;
  timeoutMs?: number;
  // Batch callers log their own totals; Vercel caps log lines per request.
  quiet?: boolean;
}): Promise<OpenRouterResult> => {
  const apiKey = await assertOpenRouterBudget();
  const started = Date.now();
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      usage: { include: true },
      ...(temperature !== undefined ? { temperature } : {}),
      ...(jsonObject ? { response_format: { type: "json_object" } } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const ms = Date.now() - started;
  const body = (await res.json().catch(() => null)) as {
    choices?: { message?: { content?: string | null } }[];
    usage?: { cost?: number };
    error?: { message?: string };
  } | null;
  if (!res.ok || !body) {
    throw new Error(
      `openrouter ${model} ${res.status}: ${body?.error?.message ?? "no body"}`.slice(
        0,
        300,
      ),
    );
  }
  const costUsd = body.usage?.cost ?? 0;
  if (!quiet) {
    console.log(
      `openrouter: model=${model} ms=${ms} costUsd=${costUsd.toFixed(6)}`,
    );
  }
  return {
    content: body.choices?.[0]?.message?.content?.trim() ?? "",
    costUsd,
    ms,
  };
};
