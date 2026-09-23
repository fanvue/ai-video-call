import { describe, expect, it } from "vitest";
import { DEFAULT_PERSONA_ID } from "@/lib/live/contract";
import {
  initialPersonaSettings,
  personaModeFor,
  personaOptionsFor,
  submittedPersona,
  updatePersonaMode,
  withRegisteredPersona,
} from "./personaSettings";

describe("persona settings", () => {
  it("changing one mode's selection leaves the other untouched", () => {
    const start = initialPersonaSettings();
    const swapChanged = updatePersonaMode(start, "swap", { personaId: "" });
    expect(swapChanged.longlive).toEqual(start.longlive);
    expect(swapChanged.swap.personaId).toBe("");

    const longliveChanged = updatePersonaMode(swapChanged, "longlive", {
      personaId: "upload-aaaaaaaaaaaa",
      attested: true,
    });
    expect(longliveChanged.swap).toEqual(swapChanged.swap);
  });

  it("lists, register state and attestation are per mode", () => {
    let settings = updatePersonaMode(initialPersonaSettings(), "longlive", {
      personas: [{ id: "long-only", note: "" }],
      canRegister: true,
    });
    settings = updatePersonaMode(settings, "swap", { attested: true });
    settings = withRegisteredPersona(settings, "swap", "upload-bbbbbbbbbbbb");

    expect(settings.swap.personas).toEqual([
      { id: "upload-bbbbbbbbbbbb", note: "Registered upload" },
    ]);
    expect(settings.swap.personaId).toBe("upload-bbbbbbbbbbbb");
    expect(settings.longlive.personaId).toBe(DEFAULT_PERSONA_ID);
    expect(settings.longlive.personas).toEqual([{ id: "long-only", note: "" }]);
    expect(settings.longlive.attested).toBe(false);
    expect(settings.longlive.registerStatus).toBeNull();
    expect(settings.swap.canRegister).toBe(false);
  });

  it("registering an id already listed does not duplicate it", () => {
    const listed = updatePersonaMode(initialPersonaSettings(), "swap", {
      personas: [{ id: "upload-cccccccccccc", note: "Registered upload" }],
    });
    const again = withRegisteredPersona(listed, "swap", "upload-cccccccccccc");
    expect(again.swap.personas).toHaveLength(1);
  });

  it("submits only the active mode's id, under its own key", () => {
    const settings = updatePersonaMode(
      updatePersonaMode(initialPersonaSettings(), "longlive", {
        personaId: "long-pick",
      }),
      "swap",
      { personaId: "swap-pick" },
    );
    expect(submittedPersona(settings, "longlive")).toEqual({
      personaId: "long-pick",
    });
    expect(submittedPersona(settings, "swap")).toEqual({
      swapPersonaId: "swap-pick",
    });
    expect(submittedPersona(settings, "turbo")).toEqual({});
    const off = updatePersonaMode(settings, "swap", { personaId: "" });
    expect(submittedPersona(off, "swap")).toEqual({});
  });

  it("maps only LongLive and swap to a persona mode", () => {
    expect(personaModeFor("longlive")).toBe("longlive");
    expect(personaModeFor("swap")).toBe("swap");
    expect(personaModeFor("turbo")).toBeNull();
  });

  it("keeps the seed persona selectable before the list loads", () => {
    expect(personaOptionsFor(initialPersonaSettings().swap)).toEqual([
      { id: DEFAULT_PERSONA_ID, note: "" },
    ]);
  });
});
