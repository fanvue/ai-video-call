import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const envMock = vi.hoisted(() => ({
  SWAP_SERVICE_URL: "https://swap.test" as string | undefined,
  SWAP_TOKEN: "0123456789abcdef0123456789abcdef" as string | undefined,
}));
vi.mock("@/env", () => ({ env: envMock }));

const getCurrentUser = vi.fn();
vi.mock("@/lib/fanvue", () => ({
  getCurrentUser: () => getCurrentUser(),
}));

const { POST } = await import("./route");

describe("POST /api/live/swapWarm", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    getCurrentUser.mockResolvedValue({ id: "user-1" });
    envMock.SWAP_SERVICE_URL = "https://swap.test";
    envMock.SWAP_TOKEN = "0123456789abcdef0123456789abcdef";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects anonymous callers before touching the service", async () => {
    getCurrentUser.mockResolvedValue(null);
    const response = await POST();
    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("probes the service health endpoint three times, without the token, and reports warm", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    const response = await POST();
    expect(await response.json()).toEqual({ warm: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://swap.test/health");
    expect(init.headers).toBeUndefined();
  });

  it("is 503 when the service is not configured", async () => {
    envMock.SWAP_SERVICE_URL = undefined;
    const response = await POST();
    expect(response.status).toBe(503);
  });

  it("reports cold instead of failing when the probe errors", async () => {
    fetchMock.mockRejectedValue(new Error("timeout"));
    const response = await POST();
    expect(await response.json()).toEqual({ warm: false });
  });
});
