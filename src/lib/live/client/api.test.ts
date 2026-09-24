import { afterEach, describe, expect, it, vi } from "vitest";
import { renderClip, uploadReference } from "./api";
import { defaultCreatorProfile } from "./defaultCreatorProfile";

vi.mock("@/lib/live/contract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/live/contract")>();
  // A full ClipResult fixture is out of scope here; the stream framing is what is under test.
  return {
    ...actual,
    clipResultSchema: actual.clipResultSchema.passthrough().partial(),
  };
});

const streamOf = (chunks: string[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    }),
    { headers: { "Content-Type": "application/x-ndjson" } },
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("renderClip over the NDJSON stream", () => {
  it("calls onRendered with the raw url, then resolves the result, across split chunks", async () => {
    const fetchMock = vi.fn(async () =>
      streamOf([
        '{"type":"rendered","videoUrl":"https://example.com/r',
        'aw.mp4"}\n{"type":"result","result":{"clipId":"c1"}}\n',
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onRendered = vi.fn();
    const result = await renderClip({} as never, onRendered);
    expect(onRendered).toHaveBeenCalledWith("https://example.com/raw.mp4");
    expect(result).toMatchObject({ clipId: "c1" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/live/clip",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "application/x-ndjson" }),
      }),
    );
  });

  it("falls back to the plain result when the answer is not a stream", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ clipId: "c2" })),
    );
    const onRendered = vi.fn();
    await expect(renderClip({} as never, onRendered)).resolves.toMatchObject({
      clipId: "c2",
    });
    expect(onRendered).not.toHaveBeenCalled();
  });

  it("throws the server's error line", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        streamOf(['{"type":"error","error":"Clip generation failed"}\n']),
      ),
    );
    await expect(renderClip({} as never, vi.fn())).rejects.toThrow(
      "Clip generation failed",
    );
  });

  it("throws when the stream ends without a result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        streamOf([
          '{"type":"rendered","videoUrl":"https://example.com/raw.mp4"}',
        ]),
      ),
    );
    await expect(renderClip({} as never, vi.fn())).rejects.toThrow(
      "without a result",
    );
  });

  it("keeps the plain JSON path without onRendered", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ clipId: "c1" })),
    );
    await expect(renderClip({} as never)).resolves.toMatchObject({
      clipId: "c1",
    });
  });
});

describe("creator gender from setup to the server", () => {
  it("sends the chosen gender with the reference upload", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 10, height: 10, close: () => undefined })),
    );
    vi.stubGlobal(
      "FileReader",
      class {
        result = "data:image/jpeg;base64,QUJD";
        onload: (() => void) | null = null;
        readAsDataURL() {
          this.onload?.();
        }
      },
    );
    const fetchMock = vi.fn<
      (url: string, init: { body: string }) => Promise<Response>
    >(
      async () =>
        new Response(JSON.stringify({ anchorFrameUrl: "https://a.b/c" }), {
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["x"], "me.jpg", { type: "image/jpeg" });
    await uploadReference(file, "bedroom", false, true, "male");
    await uploadReference(file, "bedroom", false, true);
    const bodies = fetchMock.mock.calls.map(
      ([, init]) => JSON.parse(init.body) as { gender?: string },
    );
    expect(bodies.map((body) => body.gender)).toEqual(["male", "female"]);
  });

  it("puts the gender on the creator profile, female when unset", () => {
    expect(defaultCreatorProfile("", "bedroom", "look", "male")).toMatchObject({
      gender: "male",
      displayName: "Him",
    });
    expect(defaultCreatorProfile("", "bedroom", "look")).toMatchObject({
      gender: "female",
      displayName: "Her",
    });
  });
});
