import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { initialPersonaSettings } from "@/lib/live/client/personaSettings";
import { SetupScreen, setupSubmitFor, showsSwapTuning } from "./SetupScreen";

// No DOM in this suite, so the first paint is rendered to markup and the toggle rule is tested directly.
const markup = () =>
  renderToStaticMarkup(
    createElement(SetupScreen, {
      busy: false,
      error: null,
      onSubmit: () => undefined,
    }),
  );

describe("SetupScreen render mode", () => {
  it("offers Premium beside Swap, with Swap selected by default", () => {
    const html = markup();
    expect(html).toContain('role="radiogroup" aria-label="Render"');
    expect(html).toMatch(
      /<input type="radio" name="renderMode" checked="" value="swap"\/>/,
    );
    expect(html).toMatch(
      /<input type="radio" name="renderMode" value="wan14b"\/>/,
    );
    expect(html).toContain("Premium (slower, best likeness)");
    expect(html).toContain("About 16 s to make each 5 s clip on one H100");
  });

  it("shows Face lock and Hand mask for Swap only", () => {
    expect(showsSwapTuning("swap")).toBe(true);
    expect(showsSwapTuning("wan14b")).toBe(false);
    expect(showsSwapTuning("commercial")).toBe(false);
  });

  it("offers Commercial as a third mode", () => {
    const html = markup();
    expect(html).toMatch(
      /<input type="radio" name="renderMode" value="commercial"\/>/,
    );
    expect(html).toContain("Commercial (no face swap)");
    expect(html).toContain("Licence-clean comparison: h3 only, no face swap");
  });
});

describe("SetupScreen session limits", () => {
  const fields = {
    file: new File(["x"], "me.jpg", { type: "image/jpeg" }),
    sceneId: "bedroom" as const,
    displayName: " Aria ",
    voiceExperimental: false,
    renderMode: "swap" as const,
    planner: "catalogue" as const,
    swapFaceLock: true,
    swapHandMask: false,
    personaSettings: { ...initialPersonaSettings(), personaId: "aria" },
    maxMinutesInput: "15",
    costCapInput: "40",
  };

  it("starts with 15 minutes and a $40 cap filled in", () => {
    const html = markup();
    expect(html).toContain("Max minutes");
    expect(html).toContain("Spend cap ($)");
    expect(html).toMatch(/max="30" step="1" class="[^"]*" value="15"/);
    expect(html).toMatch(/max="100" step="any" class="[^"]*" value="40"/);
  });

  it("submits the chosen minutes and cap", () => {
    const submit = setupSubmitFor({
      ...fields,
      maxMinutesInput: "20",
      costCapInput: "55.5",
    });
    expect(submit).toMatchObject({
      maxMinutes: 20,
      costCapUsd: 55.5,
      displayName: "Aria",
      renderMode: "swap",
      swapFaceLock: true,
      swapPersonaId: "aria",
    });
  });

  it("clamps out-of-range limits and falls back to the defaults on empty or invalid input", () => {
    expect(
      setupSubmitFor({ ...fields, maxMinutesInput: "90", costCapInput: "0" }),
    ).toMatchObject({ maxMinutes: 30, costCapUsd: 1 });
    expect(
      setupSubmitFor({ ...fields, maxMinutesInput: "", costCapInput: "abc" }),
    ).toMatchObject({ maxMinutes: 15, costCapUsd: 40 });
  });

  it("drops the swap persona and tuning for Commercial", () => {
    const submit = setupSubmitFor({ ...fields, renderMode: "commercial" });
    expect(submit.renderMode).toBe("commercial");
    expect(submit.swapPersonaId).toBeUndefined();
    expect(submit.swapFaceLock).toBe(false);
    expect(submit.swapHandMask).toBe(false);
    expect(submit).toMatchObject({ maxMinutes: 15, costCapUsd: 40 });
  });
});

describe("SetupScreen planner", () => {
  const fields = {
    file: new File(["x"], "me.jpg", { type: "image/jpeg" }),
    sceneId: "bedroom" as const,
    displayName: "Aria",
    voiceExperimental: false,
    swapFaceLock: true,
    swapHandMask: false,
    personaSettings: initialPersonaSettings(),
    maxMinutesInput: "15",
    costCapInput: "40",
  };

  it("offers both planners with the catalogue selected by default", () => {
    const html = markup();
    expect(html).toContain("Planner");
    expect(html).toContain(
      '<option value="catalogue" selected="">Catalogue (fast)</option>',
    );
    expect(html).toContain(
      '<option value="director">Director (LLM, any action)</option>',
    );
  });

  it("submits the chosen planner for every render mode", () => {
    for (const renderMode of ["swap", "wan14b", "commercial"] as const) {
      expect(
        setupSubmitFor({ ...fields, renderMode, planner: "director" }).planner,
      ).toBe("director");
    }
  });
});
