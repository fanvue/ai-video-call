import { describe, expect, it } from "vitest";
import { collapseRepeatedTranscript } from "./voiceInput";

describe("collapseRepeatedTranscript", () => {
  it("collapses an exact doubled phrase", () => {
    expect(collapseRepeatedTranscript("hey there hey there")).toBe("hey there");
  });

  it("collapses a doubled short phrase inside extra words", () => {
    expect(collapseRepeatedTranscript("wave wave at me")).toBe(
      "wave wave at me",
    );
    expect(collapseRepeatedTranscript("hi hi")).toBe("hi hi");
  });

  it("leaves distinct text untouched", () => {
    expect(collapseRepeatedTranscript("take your top off")).toBe(
      "take your top off",
    );
  });

  it("trims and collapses whitespace", () => {
    expect(collapseRepeatedTranscript("  hello   world  ")).toBe("hello world");
  });
});
