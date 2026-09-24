import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LobbyOverlay } from "./LobbyOverlay";

const markup = (premium: boolean) =>
  renderToStaticMarkup(
    createElement(LobbyOverlay, {
      displayName: "Aria",
      stage: premium ? "warmingPremium" : "capturingLook",
      viewerCount: 3,
      premium,
    }),
  );

describe("LobbyOverlay Premium warm-up step", () => {
  it("shows the warm-up as the current step in a Premium join", () => {
    expect(markup(true)).toContain(
      '<li aria-current="step" class="text-xs text-white">Warming up premium…</li>',
    );
  });

  it("never lists it for a Swap join", () => {
    expect(markup(false)).not.toContain("Warming up premium");
  });
});
