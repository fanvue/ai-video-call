import { beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "longlive-route-secret-0123456789abcdef";
const mockEnv: { LONGLIVE_TOKEN?: string; LONGLIVE_URL?: string } = {};

vi.mock("@/lib/fanvue", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@/env", () => ({ env: mockEnv }));

const { getCurrentUser } = await import("@/lib/fanvue");
const { POST } = await import("./route");

beforeEach(() => {
  vi.mocked(getCurrentUser).mockReset();
  mockEnv.LONGLIVE_TOKEN = SECRET;
  mockEnv.LONGLIVE_URL = "wss://example-longlive.modal.run";
});

describe("POST /api/live/longliveTicket", () => {
  it("rejects unauthenticated requests", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null as never);
    const response = await POST();
    expect(response.status).toBe(401);
  });

  it("answers 503 when the service is not configured", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({ id: "user-1" } as never);
    mockEnv.LONGLIVE_TOKEN = undefined;
    expect((await POST()).status).toBe(503);
    mockEnv.LONGLIVE_TOKEN = SECRET;
    mockEnv.LONGLIVE_URL = undefined;
    expect((await POST()).status).toBe(503);
  });

  it("returns a ticket, the service url and the expiry, never the secret", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({ id: "user-1" } as never);
    const response = await POST();
    const text = await response.text();
    const data = JSON.parse(text) as {
      ticket: string;
      url: string;
      expiresAt: number;
    };
    expect(response.status).toBe(200);
    expect(data.url).toBe("wss://example-longlive.modal.run");
    expect(data.ticket).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(data.expiresAt).toBeGreaterThan(Date.now());
    expect(text).not.toContain(SECRET);
  });
});
