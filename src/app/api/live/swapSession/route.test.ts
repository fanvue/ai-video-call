import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/fanvue", () => ({ getCurrentUser: vi.fn() }));
const envMock = vi.hoisted(() => ({
  env: {
    SWAP_WS_URL: "wss://swap.example.com/ws" as string | undefined,
    SWAP_TOKEN: "0123456789abcdef0123" as string | undefined,
  },
}));
vi.mock("@/env", () => envMock);

const { getCurrentUser } = await import("@/lib/fanvue");
const { POST } = await import("./route");

beforeEach(() => {
  vi.mocked(getCurrentUser).mockReset();
  envMock.env.SWAP_WS_URL = "wss://swap.example.com/ws";
  envMock.env.SWAP_TOKEN = "0123456789abcdef0123";
});

describe("POST /api/live/swapSession", () => {
  it("rejects unauthenticated requests", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null as never);
    const response = await POST();
    expect(response.status).toBe(401);
  });

  it("returns the service URL with the token as a query param", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({ id: "user-1" } as never);
    const response = await POST();
    const body = (await response.json()) as { url: string };
    expect(response.status).toBe(200);
    expect(body.url).toBe(
      "wss://swap.example.com/ws?token=0123456789abcdef0123",
    );
  });

  it("fails closed with 503 when the service is not configured", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({ id: "user-1" } as never);
    envMock.env.SWAP_TOKEN = undefined;
    const response = await POST();
    expect(response.status).toBe(503);
  });
});
