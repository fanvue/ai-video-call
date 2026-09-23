import { timingSafeEqual } from "node:crypto";
import { NextResponse, after } from "next/server";
import { env } from "@/env";
import { getCurrentUser } from "@/lib/fanvue";
import { GROQ_TEXT_MODEL, createGroqChatCompletion } from "@/lib/groq";
import { defaultLiveState } from "@/lib/live/client/defaultLiveState";
import type { BeatIntent } from "@/lib/live/contract";
import {
  intentParseMessages,
  intentsFromLlmOutput,
} from "@/lib/live/server/parseIntents";
import { createOpenRouterCompletion } from "@/lib/openrouter";

export const maxDuration = 300;

const PARSER_MODELS = [
  "groq:" + GROQ_TEXT_MODEL,
  "openai/gpt-6-luna",
  "inception/mercury-2.5",
  "deepseek/deepseek-v4.1-flash",
  "qwen/qwen3.8-flash",
  "google/gemini-3.8-flash",
  "z-ai/glm-5.3-flash",
];

const CLIP_MODELS = [
  "qwen/qwen3.8-omni-flash",
  "xiaomi/mimo-v2.6-flash",
  "google/gemini-3.8-flash",
  "z-ai/glm-5.3-flash",
  "qwen/qwen3.8-flash",
  "inclusionai/ling-3.0-flash-vl",
];

type ParserCase = { text: string; ok: (intents: BeatIntent[]) => boolean };

const has =
  (pred: (intent: BeatIntent) => boolean) => (intents: BeatIntent[]) =>
    intents.some(pred);
const act = (name: string) => has((i) => i.type === "act" && i.act === name);
const verbatimMatching = (re: RegExp) =>
  has((i) => i.type === "verbatim" && re.test(i.text));
const pose = (name: string) => has((i) => i.type === "pose" && i.pose === name);

// Lingerie start state (bra and panties on, sitting): each case names what a correct parse must contain.
const PARSER_CASES: ParserCase[] = [
  { text: "wave", ok: act("gesture") },
  { text: "wavw hi", ok: act("gesture") },
  { text: "blow me a kiss", ok: act("gesture") },
  { text: "make a heart with ur hands", ok: verbatimMatching(/heart/i) },
  { text: "do a peace sign", ok: verbatimMatching(/peace/i) },
  { text: "thumbs up if u can hear me", ok: verbatimMatching(/thumb/i) },
  { text: "play with ur hair", ok: verbatimMatching(/hair/i) },
  {
    text: "take ur bra off",
    ok: has((i) => i.type === "removeGarment" && i.garment === "bra"),
  },
  {
    text: "strip for me",
    ok: (intents) =>
      ["bra", "panties"].every((g) =>
        intents.some((i) => i.type === "removeGarment" && i.garment === g),
      ),
  },
  { text: "stand up", ok: pose("standing") },
  {
    text: "turn around",
    ok: has((i) => i.type === "pose" && i.facing === "away"),
  },
  {
    text: "come closer",
    ok: has((i) => i.type === "framing" && i.framing === "torso"),
  },
  {
    text: "step back so i can see all of u",
    ok: has((i) => i.type === "framing" && i.framing === "wider"),
  },
  { text: "get on all fours", ok: pose("onAllFours") },
  { text: "bend over", ok: pose("bentOver") },
  { text: "lie down on the bed", ok: pose("lying") },
  { text: "twerk for me", ok: act("twerk") },
  { text: "do a lil dance", ok: act("dance") },
  { text: "spin around", ok: act("spin") },
  { text: "spank that ass", ok: act("spank") },
  { text: "stick ur tongue out", ok: act("tongue") },
  { text: "touch urself", ok: has((i) => i.type === "touch") },
  { text: "grab ur toy", ok: has((i) => i.type === "fetchProp") },
  {
    text: "how was ur day",
    ok: (intents) => intents.every((i) => i.type === "hold"),
  },
  {
    text: "ur so pretty",
    ok: (intents) => intents.every((i) => i.type === "hold"),
  },
  {
    text: "slowly take off ur panties then turn around",
    ok: (intents) => {
      const off = intents.findIndex(
        (i) => i.type === "removeGarment" && i.garment === "panties",
      );
      const turn = intents.findIndex(
        (i) => i.type === "pose" && i.facing === "away",
      );
      return off >= 0 && turn > off;
    },
  },
];

type ClipCase = { name: string; url: string; flagged: boolean };

// Hand-labelled from contact sheets: the two strip clips removed the bra unprompted (reply also regrew it); the rest keep their outfit start to finish.
const CLIP_CASES: ClipCase[] = [
  {
    name: "idle-strip",
    url: "https://v3b.fal.media/files/b/0aab812b/_mKWXAVGo40B9N7IT8Q8l_minimax-h3.mp4",
    flagged: true,
  },
  {
    name: "wave-strip-regrow",
    url: "https://v3b.fal.media/files/b/0aab812b/cOiYbw1WFxlSZMLPtoGgo_minimax-h3.mp4",
    flagged: true,
  },
  ...[
    "0aab817b/gZDVeAQjrbKu0c4it08fL",
    "0aab817b/q3iSkOy127z9JWBhd-LuO",
    "0aab817a/A5v6o96h4yYGhCJEZgN3o",
    "0aab817a/qcuAzUVvg-7gMAZ_jflem",
    "0aab8179/gb65lrJ2A1nIB90jTh-GE",
    "0aab8179/AaubDk7FBDU7cLViSbd_u",
    "0aab8174/Waw2HdMrSMUfiaqRLAuiR",
    "0aab8173/pJGLEUdHudYZkJNGTSg2c",
  ].map((path, i) => ({
    name: `clean-${i + 1}`,
    url: `https://v3b.fal.media/files/b/${path}_minimax-h3.mp4`,
    flagged: false,
  })),
];

const CLIP_CHECK_PROMPT =
  "You check a generated webcam clip of a fictional adult woman for continuity errors. Watch the whole clip. " +
  'Return ONLY JSON: {"garmentRemoved":bool,"garmentAdded":bool,"duplicateGarment":bool,"notes":"..."}. ' +
  "garmentRemoved: a clothing item worn at the start comes off at any point. garmentAdded: a garment appears on " +
  "her that she was not wearing, including one reappearing after it came off. duplicateGarment: two of the same " +
  "garment are visible at once, e.g. one worn and one in her hand. Being topless or nude from the first frame is " +
  "not an error; only changes during the clip count.";

type Row = {
  model: string;
  case: string;
  pass: boolean | null;
  ms: number;
  costUsd: number;
  error?: string;
  output?: string;
};

// Parser calls run one at a time per model so rate limits stay out of the latency numbers; clip calls run in fives to fit the route's time limit.
const runInChunks = async <T>(
  items: T[],
  size: number,
  run: (item: T) => Promise<Row>,
): Promise<Row[]> => {
  const rows: Row[] = [];
  for (let i = 0; i < items.length; i += size) {
    rows.push(...(await Promise.all(items.slice(i, i + size).map(run))));
  }
  return rows;
};

const parserRow = async (model: string, c: ParserCase): Promise<Row> => {
  const state = defaultLiveState("bedroom", {
    top: { on: false, description: "top" },
    bottom: { on: false, description: "bottoms" },
    bra: { on: true, description: "white bra" },
    panties: { on: true, description: "white panties" },
    removedOrder: [],
  });
  const messages = intentParseMessages(c.text, state);
  const started = Date.now();
  try {
    let raw: string;
    let costUsd = 0;
    if (model.startsWith("groq:")) {
      const completion = await createGroqChatCompletion({
        model: GROQ_TEXT_MODEL,
        reasoningEffort: "low",
        temperature: 0,
        responseFormat: { type: "json_object" },
        messages,
      });
      raw = completion.choices[0]?.message?.content?.trim() ?? "";
    } else {
      const result = await createOpenRouterCompletion({
        model,
        messages,
        temperature: 0,
        jsonObject: true,
        timeoutMs: 15_000,
      });
      raw = result.content;
      costUsd = result.costUsd;
    }
    const intents = intentsFromLlmOutput(raw, c.text);
    return {
      model,
      case: c.text,
      pass: c.ok(intents),
      ms: Date.now() - started,
      costUsd,
      output: JSON.stringify(intents).slice(0, 300),
    };
  } catch (error) {
    return {
      model,
      case: c.text,
      pass: false,
      ms: Date.now() - started,
      costUsd: 0,
      error: String(error).slice(0, 300),
    };
  }
};

const clipRow = async (model: string, c: ClipCase): Promise<Row> => {
  const started = Date.now();
  try {
    const result = await createOpenRouterCompletion({
      model,
      jsonObject: true,
      temperature: 0,
      timeoutMs: 60_000,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: CLIP_CHECK_PROMPT },
            { type: "video_url", video_url: { url: c.url } },
          ],
        },
      ],
    });
    const parsed = JSON.parse(
      result.content.match(/\{[\s\S]*\}/)?.[0] ?? result.content,
    ) as {
      garmentRemoved?: boolean;
      garmentAdded?: boolean;
      duplicateGarment?: boolean;
    };
    const flagged = Boolean(
      parsed.garmentRemoved || parsed.garmentAdded || parsed.duplicateGarment,
    );
    return {
      model,
      case: c.name,
      pass: flagged === c.flagged,
      ms: result.ms,
      costUsd: result.costUsd,
      output: result.content.slice(0, 300),
    };
  } catch (error) {
    return {
      model,
      case: c.name,
      pass: null,
      ms: Date.now() - started,
      costUsd: 0,
      error: String(error).slice(0, 300),
    };
  }
};

const percentile = (values: number[], p: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return (
    sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? null
  );
};

const summarise = (rows: Row[]) =>
  [...new Set(rows.map((r) => r.model))].map((model) => {
    const mine = rows.filter((r) => r.model === model);
    const answered = mine.filter((r) => r.pass !== null && !r.error);
    const ms = answered.map((r) => r.ms);
    return {
      model,
      passed: mine.filter((r) => r.pass === true).length,
      total: mine.length,
      errors: mine.filter((r) => r.error).length,
      p50Ms: percentile(ms, 0.5),
      p90Ms: percentile(ms, 0.9),
      costUsd: Number(mine.reduce((sum, r) => sum + r.costUsd, 0).toFixed(6)),
    };
  });

const runSuite = async (suite: "parser" | "clip"): Promise<void> => {
  const rowsByModel = await Promise.all(
    suite === "parser"
      ? PARSER_MODELS.map((model) =>
          runInChunks(PARSER_CASES, 1, (c) => parserRow(model, c)),
        )
      : CLIP_MODELS.map((model) =>
          runInChunks(CLIP_CASES, 5, (c) => clipRow(model, c)),
        ),
  );
  const rows = rowsByModel.flat();
  for (const row of rows) {
    console.log(`live/orBench row suite=${suite} ${JSON.stringify(row)}`);
  }
  const totalCostUsd = Number(
    rows.reduce((sum, r) => sum + r.costUsd, 0).toFixed(6),
  );
  console.log(
    `live/orBench: suite=${suite} totalCostUsd=${totalCostUsd} summary=${JSON.stringify(summarise(rows))}`,
  );
};

const hasBenchToken = (request: Request): boolean => {
  const expected = env.BENCH_TOKEN;
  const given = request.headers.get("x-bench-token");
  if (!expected || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

// Spends real money, so it needs a signed-in user or the one-off bench token, plus ?run=1; every OpenRouter call goes through the budget guard. Runs after the response so a multi-minute suite never times the request out; results land in the logs.
export async function GET(request: Request) {
  if (!hasBenchToken(request) && !(await getCurrentUser())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const suite = url.searchParams.get("suite");
  if (
    url.searchParams.get("run") !== "1" ||
    (suite !== "parser" && suite !== "clip")
  ) {
    return NextResponse.json({
      usage: "?suite=parser&run=1 or ?suite=clip&run=1",
    });
  }
  after(() =>
    runSuite(suite).catch((error: unknown) =>
      console.warn(`live/orBench: suite=${suite} failed`, error),
    ),
  );
  return NextResponse.json({ started: suite });
}
