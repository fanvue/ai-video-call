import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
  server: {
    OAUTH_CLIENT_ID: z.string().min(1),
    OAUTH_CLIENT_SECRET: z.string().min(1),
    OAUTH_ISSUER_BASE_URL: z.url().default("https://auth.fanvue.com"),
    OAUTH_REDIRECT_URI: z.url().optional(),
    OAUTH_SCOPES: z.string(),
    OAUTH_RESPONSE_MODE: z.enum(["query", "form_post"]).optional(),
    OAUTH_PROMPT: z.string().optional(),
    BASE_URL: z.url().optional(),
    SESSION_COOKIE_NAME: z.string().default("fanvue_oauth"),
    SESSION_SECRET: z
      .string()
      .min(16, { message: "SESSION_SECRET must be at least 32 characters" }),
    API_BASE_URL: z.url().default("https://api.fanvue.com"),
    FAL_KEY: z.string().min(1),
    GROQ_API_KEY: z.string().min(1),
    // Self-hosted Swap service (services/swap); either unset makes every swap clip report "failed".
    SWAP_SERVICE_URL: z.url().optional(),
    SWAP_TOKEN: z.string().min(16).optional(),
    // Test-only language and vision models; unset leaves every OpenRouter option unavailable.
    OPENROUTER_API_KEY: z.string().min(1).optional(),
    // One-off token for running /api/live/orBench without a browser session; removed after each bench.
    BENCH_TOKEN: z.string().min(32).optional(),
    // LongLive realtime service (services/longlive); either unset makes the ticket route answer 503.
    LONGLIVE_TOKEN: z.string().min(32).optional(),
    LONGLIVE_URL: z.url().optional(),
  },
  runtimeEnv: {
    OAUTH_CLIENT_ID: process.env.OAUTH_CLIENT_ID,
    OAUTH_CLIENT_SECRET: process.env.OAUTH_CLIENT_SECRET,
    OAUTH_ISSUER_BASE_URL: process.env.OAUTH_ISSUER_BASE_URL,
    OAUTH_REDIRECT_URI: process.env.OAUTH_REDIRECT_URI,
    OAUTH_SCOPES: process.env.OAUTH_SCOPES,
    OAUTH_RESPONSE_MODE: process.env.OAUTH_RESPONSE_MODE as
      "query" | "form_post" | undefined,
    OAUTH_PROMPT: process.env.OAUTH_PROMPT,
    BASE_URL: process.env.BASE_URL,
    SESSION_COOKIE_NAME: process.env.SESSION_COOKIE_NAME,
    SESSION_SECRET: process.env.SESSION_SECRET,
    API_BASE_URL: process.env.API_BASE_URL,
    FAL_KEY: process.env.FAL_KEY,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    SWAP_SERVICE_URL: process.env.SWAP_SERVICE_URL,
    SWAP_TOKEN: process.env.SWAP_TOKEN,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    BENCH_TOKEN: process.env.BENCH_TOKEN,
    LONGLIVE_TOKEN: process.env.LONGLIVE_TOKEN,
    LONGLIVE_URL: process.env.LONGLIVE_URL,
  },
  emptyStringAsUndefined: true,
});

export const oauthConfig = {
  issuerBaseURL: env.OAUTH_ISSUER_BASE_URL,
  clientId: env.OAUTH_CLIENT_ID,
  clientSecret: env.OAUTH_CLIENT_SECRET,
  redirectUri: env.OAUTH_REDIRECT_URI,
};
