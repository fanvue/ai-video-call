import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/fal/uploadImage", () => ({
  uploadReferenceImageToFal: vi.fn(),
}));
vi.mock("@/lib/fanvue", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@/lib/groq", () => ({ createGroqVisionCompletion: vi.fn() }));
vi.mock("@/lib/live/server/stageSeed", () => ({ stageSeed: vi.fn() }));

const { uploadReferenceImageToFal } = await import("@/lib/fal/uploadImage");
const { getCurrentUser } = await import("@/lib/fanvue");
const { createGroqVisionCompletion } = await import("@/lib/groq");
const { stageSeed } = await import("@/lib/live/server/stageSeed");
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
  vi.mocked(stageSeed).mockReset();
  vi.mocked(stageSeed).mockResolvedValue(null);
});

const captureOk = () =>
  vi.mocked(createGroqVisionCompletion).mockResolvedValue({
    choices: [
      {
        message: {
          content: JSON.stringify({
            lookLock: "long dark hair",
            surroundings: "a grey studio backdrop",
            framing: "torso",
          }),
        },
      },
    ],
  } as never);

describe("POST /api/live/reference — staged seed", () => {
  it("stages the in-scene still alongside the capture and returns it as the seed with the scene's own surroundings", async () => {
    captureOk();
    vi.mocked(stageSeed).mockResolvedValue({
      url: "https://fal.example.com/staged.jpg",
      costUsd: 0.03,
    });
    const response = await POST(
      jsonBody({
        imageBase64: "abcd",
        contentType: "image/jpeg",
        sceneId: "bedroom",
      }),
    );
    const data = (await response.json()) as {
      anchorFrameUrl: string;
      seedFrameUrl: string;
      staged: boolean;
      stageCostUsd: number;
      surroundings: string;
      framing: string;
      lookLock: string;
    };
    expect(stageSeed).toHaveBeenCalledWith(
      expect.objectContaining({
        referenceUrl: "https://fal.example.com/anchor.jpg",
        sceneId: "bedroom",
      }),
    );
    expect(data.anchorFrameUrl).toBe("https://fal.example.com/anchor.jpg");
    expect(data.seedFrameUrl).toBe("https://fal.example.com/staged.jpg");
    expect(data.staged).toBe(true);
    expect(data.stageCostUsd).toBe(0.03);
    expect(data.surroundings).toMatch(/bedroom/);
    expect(data.framing).toBe("medium");
    expect(data.lookLock).toBe("long dark hair");
  });

  it("falls back to the upload as the seed, with the photo's own surroundings, when staging fails", async () => {
    captureOk();
    vi.mocked(stageSeed).mockResolvedValue(null);
    const response = await POST(
      jsonBody({
        imageBase64: "abcd",
        contentType: "image/jpeg",
        sceneId: "office",
      }),
    );
    const data = (await response.json()) as {
      seedFrameUrl: string;
      staged: boolean;
      surroundings: string;
      framing: string;
    };
    expect(data.seedFrameUrl).toBe("https://fal.example.com/anchor.jpg");
    expect(data.staged).toBe(false);
    expect(data.surroundings).toBe("a grey studio backdrop");
    expect(data.framing).toBe("torso");
  });

  it("does not stage without a scene", async () => {
    captureOk();
    await POST(jsonBody({ imageBase64: "abcd", contentType: "image/jpeg" }));
    expect(stageSeed).not.toHaveBeenCalled();
  });
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
