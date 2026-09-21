import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/fal/uploadImage", () => ({
  uploadReferenceImageToFal: vi.fn(),
}));
vi.mock("@/lib/fanvue", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@/lib/groq", () => ({ createGroqVisionCompletion: vi.fn() }));

const { uploadReferenceImageToFal } = await import("@/lib/fal/uploadImage");
const { getCurrentUser } = await import("@/lib/fanvue");
const { createGroqVisionCompletion } = await import("@/lib/groq");
const { POST } = await import("./route");

const jsonBody = (body: unknown) =>
  new Request("https://example.com/api/live/reference", {
    method: "POST",
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.mocked(getCurrentUser).mockResolvedValue({ id: "user-1" } as never);
  vi.mocked(uploadReferenceImageToFal).mockResolvedValue(
    "https://fal.example.com/anchor.jpg",
  );
});

describe("POST /api/live/reference — canon wardrobe", () => {
  it("always starts bra/panties white even when the capture reports a different color", async () => {
    vi.mocked(createGroqVisionCompletion).mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              bra: { description: "black lace bra" },
              panties: { description: "black lace panties" },
              lookLock: "long dark hair",
              surroundings: "bedroom desk",
              framing: "wider",
            }),
          },
        },
      ],
    } as never);

    const response = await POST(
      jsonBody({ imageBase64: "abcd", contentType: "image/jpeg" }),
    );
    const data = (await response.json()) as {
      wardrobe: {
        bra: { description: string; on: boolean };
        panties: { description: string; on: boolean };
        top: { on: boolean };
        bottom: { on: boolean };
      };
    };

    expect(data.wardrobe.bra).toEqual({ on: true, description: "white bra" });
    expect(data.wardrobe.panties).toEqual({
      on: true,
      description: "white panties",
    });
    expect(data.wardrobe.top.on).toBe(false);
    expect(data.wardrobe.bottom.on).toBe(false);
  });

  it("stays white canon when capture fails entirely", async () => {
    vi.mocked(createGroqVisionCompletion).mockRejectedValue(
      new Error("refused"),
    );

    const response = await POST(
      jsonBody({ imageBase64: "abcd", contentType: "image/jpeg" }),
    );
    const data = (await response.json()) as {
      wardrobe: {
        bra: { description: string };
        panties: { description: string };
      };
      captured: boolean;
    };

    expect(data.captured).toBe(false);
    expect(data.wardrobe.bra.description).toBe("white bra");
    expect(data.wardrobe.panties.description).toBe("white panties");
  });
});
