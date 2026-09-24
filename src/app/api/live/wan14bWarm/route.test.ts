import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const envMock = vi.hoisted(() => ({
  WAN14B_SERVICE_URL: "https://wan14b.test" as string | undefined,
  SWAP_TOKEN: "0123456789abcdef0123456789abcdef" as string | undefined,
}));
vi.mock("@/env", () => ({ env: envMock }));

const getCurrentUser = vi.fn();
vi.mock("@/lib/fanvue", () => ({
  getCurrentUser: () => getCurrentUser(),
}));

const { POST } = await import("./route");

describe("POST /api/live/wan14bWarm", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    getCurrentUser.mockResolvedValue({ id: "user-1" });
    envMock.WAN14B_SERVICE_URL = "https://wan14b.test";
    envMock.SWAP_TOKEN = "0123456789abcdef0123456789abcdef";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects anonymous callers before touching the service", async () => {
    getCurrentUser.mockResolvedValue(null);
    expect((await POST()).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends one authenticated warm call and reports warm", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    const response = await POST();
    expect(await response.json()).toEqual({ warm: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://wan14b.test/warm");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer 0123456789abcdef0123456789abcdef",
    );
  });

  it("reports not warm on a service error or a timeout", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 503 }));
    expect(await (await POST()).json()).toEqual({ warm: false });
    fetchMock.mockRejectedValueOnce(
      new DOMException("The operation timed out.", "TimeoutError"),
    );
    expect(await (await POST()).json()).toEqual({ warm: false });
  });

  it("is 503 without the token", async () => {
    envMock.SWAP_TOKEN = undefined;
    expect((await POST()).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
