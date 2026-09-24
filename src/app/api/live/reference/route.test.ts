import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/fal/uploadImage", () => ({
  uploadReferenceImageToFal: vi.fn(),
}));
vi.mock("@/lib/fanvue", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@/env", () => ({ env: {} }));
vi.mock("@/lib/groq", async (importOriginal) => ({
  createGroqVisionCompletion: vi.fn(),
  stripThinkBlock: (await importOriginal<typeof import("@/lib/groq")>())
    .stripThinkBlock,
}));
vi.mock("@/lib/live/server/stageSeed", () => ({ stageSeed: vi.fn() }));
vi.mock("@/lib/live/server/swapClip", () => ({
  swapServiceFaceCrop: vi.fn(),
}));

const { uploadReferenceImageToFal } = await import("@/lib/fal/uploadImage");
const { getCurrentUser } = await import("@/lib/fanvue");
const { createGroqVisionCompletion } = await import("@/lib/groq");
const { stageSeed } = await import("@/lib/live/server/stageSeed");
const { swapServiceFaceCrop } = await import("@/lib/live/server/swapClip");
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
  vi.mocked(swapServiceFaceCrop).mockReset();
  vi.mocked(swapServiceFaceCrop).mockResolvedValue(
    "https://fal.example.com/face.jpg",
  );
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
        lookLock: "long dark hair",
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

  it("stages with the fallback look when the capture fails", async () => {
    vi.mocked(createGroqVisionCompletion).mockRejectedValue(
      new Error("refused"),
    );
    await POST(
      jsonBody({
        imageBase64: "abcd",
        contentType: "image/jpeg",
        sceneId: "bedroom",
      }),
    );
    expect(stageSeed).toHaveBeenCalledWith(
      expect.objectContaining({
        lookLock: "an adult woman with a natural build",
      }),
    );
  });

  it("reads the capture after a Qwen3 <think> block", async () => {
    vi.mocked(createGroqVisionCompletion).mockResolvedValue({
      choices: [
        {
          message: {
            content: `<think>is it {"framing":"wider"}?</think>\n${JSON.stringify(
              {
                lookLock: "short red hair",
                surroundings: "a white wall",
                framing: "torso",
              },
            )}`,
          },
        },
      ],
    } as never);
    const response = await POST(
      jsonBody({ imageBase64: "abcd", contentType: "image/jpeg" }),
    );
    const data = (await response.json()) as {
      lookLock: string;
      framing: string;
      captured: boolean;
    };
    expect(data.captured).toBe(true);
    expect(data.lookLock).toBe("short red hair");
    expect(data.framing).toBe("torso");
  });

  it("does not stage without a scene", async () => {
    captureOk();
    await POST(jsonBody({ imageBase64: "abcd", contentType: "image/jpeg" }));
    expect(stageSeed).not.toHaveBeenCalled();
  });

  it("skips staging when the client opts out, keeping the upload as the seed", async () => {
    captureOk();
    const response = await POST(
      jsonBody({
        imageBase64: "abcd",
        contentType: "image/jpeg",
        sceneId: "bedroom",
        stage: false,
      }),
    );
    const data = (await response.json()) as {
      seedFrameUrl: string;
      staged: boolean;
    };
    expect(stageSeed).not.toHaveBeenCalled();
    expect(data.staged).toBe(false);
    expect(data.seedFrameUrl).toBe("https://fal.example.com/anchor.jpg");
  });
});

describe("POST /api/live/reference — identity face crop", () => {
  it("crops the face by default", async () => {
    captureOk();
    const response = await POST(
      jsonBody({ imageBase64: "abcd", contentType: "image/jpeg" }),
    );
    const data = (await response.json()) as { identityFrameUrl?: string };
    expect(swapServiceFaceCrop).toHaveBeenCalledOnce();
    expect(data.identityFrameUrl).toBe("https://fal.example.com/face.jpg");
  });

  it("skips the crop when the client opts out, so the swap service stays asleep", async () => {
    captureOk();
    const response = await POST(
      jsonBody({
        imageBase64: "abcd",
        contentType: "image/jpeg",
        sceneId: "bedroom",
        faceCrop: false,
      }),
    );
    const data = (await response.json()) as { identityFrameUrl?: string };
    expect(swapServiceFaceCrop).not.toHaveBeenCalled();
    expect(data.identityFrameUrl).toBeUndefined();
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

describe("POST /api/live/reference: male creator", () => {
  it("starts him in a t-shirt and boxer briefs with no bra, and captures and stages him as a man", async () => {
    captureOk();
    const response = await POST(
      jsonBody({
        imageBase64: "abcd",
        contentType: "image/jpeg",
        sceneId: "bedroom",
        gender: "male",
      }),
    );
    const data = (await response.json()) as {
      wardrobe: Record<string, { on: boolean; description: string }>;
    };
    expect(data.wardrobe).toMatchObject({
      top: { on: true, description: "white crew-neck t-shirt" },
      bra: { on: false },
      panties: { on: true, description: "grey boxer briefs" },
      removedOrder: [],
    });
    const capture = vi
      .mocked(createGroqVisionCompletion)
      .mock.calls.at(-1)?.[0].prompt;
    expect(capture).toContain("reference photo of an adult man");
    expect(capture).not.toMatch(/\b(she|her|woman|lingerie)\b/i);
    expect(stageSeed).toHaveBeenCalledWith(
      expect.objectContaining({
        persona: expect.objectContaining({ gender: "male" }),
      }),
    );
  });

  it("keeps a request with no gender on the female canon", async () => {
    captureOk();
    const response = await POST(
      jsonBody({ imageBase64: "abcd", contentType: "image/jpeg" }),
    );
    const data = (await response.json()) as {
      wardrobe: Record<string, { on: boolean; description: string }>;
    };
    expect(data.wardrobe.bra).toEqual({ on: true, description: "white bra" });
    expect(
      vi.mocked(createGroqVisionCompletion).mock.calls.at(-1)?.[0].prompt,
    ).toContain("reference photo of an adult woman");
  });
});
