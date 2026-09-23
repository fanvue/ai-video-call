import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const envMock = vi.hoisted(() => ({
  OPENROUTER_API_KEY: "test-key" as string | undefined,
}));
vi.mock("@/env", () => ({ env: envMock }));

const usageResponse = (usage: number) =>
  new Response(JSON.stringify({ data: { usage } }), { status: 200 });

describe("assertOpenRouterBudget", () => {
  beforeEach(() => {
    vi.resetModules();
    envMock.OPENROUTER_API_KEY = "test-key";
  });
  afterEach(() => vi.unstubAllGlobals());

  it("allows a call while key usage is under the ceiling", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(usageResponse(20_550)));
    const { assertOpenRouterBudget } = await import("./openrouter");
    await expect(assertOpenRouterBudget()).resolves.toBe("test-key");
  });

  it("refuses once key usage reaches the $100 ceiling", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(usageResponse(20_606.46)));
    const { assertOpenRouterBudget } = await import("./openrouter");
    await expect(assertOpenRouterBudget()).rejects.toThrow(/budget spent/);
  });

  it("fails closed when the usage read fails or has no usage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 500 })),
    );
    const first = await import("./openrouter");
    await expect(first.assertOpenRouterBudget()).rejects.toThrow(/500/);
    vi.resetModules();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ data: {} }), { status: 200 }),
        ),
    );
    const second = await import("./openrouter");
    await expect(second.assertOpenRouterBudget()).rejects.toThrow(/no usage/);
  });

  it("fails closed without a key", async () => {
    envMock.OPENROUTER_API_KEY = undefined;
    const { assertOpenRouterBudget } = await import("./openrouter");
    await expect(assertOpenRouterBudget()).rejects.toThrow(/not configured/);
  });
});
