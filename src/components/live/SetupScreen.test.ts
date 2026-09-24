import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SetupScreen, showsSwapTuning } from "./SetupScreen";

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
  });
});
