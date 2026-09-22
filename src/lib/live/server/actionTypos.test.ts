import { describe, expect, it } from "vitest";
import { correctActionTypos } from "./actionTypos";

describe("correctActionTypos", () => {
  it("reads one-key slips of catalogued verbs back to the verb", () => {
    expect(correctActionTypos("wavw")).toBe("wave");
    expect(correctActionTypos("can you sipn for me")).toBe(
      "can you spin for me",
    );
    expect(correctActionTypos("twrek")).toBe("twerk");
    expect(correctActionTypos("dancee")).toBe("dance");
    expect(correctActionTypos("strp")).toBe("strip");
  });

  it("leaves real words and far-off keys alone", () => {
    expect(correctActionTypos("i have to save it, wade in")).toBe(
      "i have to save it, wade in",
    );
    expect(correctActionTypos("knee on the sand")).toBe("knee on the sand");
    expect(correctActionTypos("waxe")).toBe("waxe");
  });
});
