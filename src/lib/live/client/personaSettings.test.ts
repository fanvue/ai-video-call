import { describe, expect, it } from "vitest";
import { DEFAULT_PERSONA_ID } from "@/lib/live/contract";
import {
  initialPersonaSettings,
  personaModeFor,
  personaOptionLabel,
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
      personas: [{ id: "long-only", note: "", name: "", addedAt: "" }],
      canRegister: true,
    });
    settings = updatePersonaMode(settings, "swap", { attested: true });
    settings = withRegisteredPersona(
      settings,
      "swap",
      "upload-bbbbbbbbbbbb",
      "Ava",
    );

    expect(settings.swap.personas).toHaveLength(1);
    expect(settings.swap.personas[0]).toMatchObject({
      id: "upload-bbbbbbbbbbbb",
      note: "Registered upload",
      name: "Ava",
    });
    expect(settings.swap.personaId).toBe("upload-bbbbbbbbbbbb");
    // The name field is cleared once a registration completes.
    expect(settings.swap.name).toBe("");
    expect(settings.swap.registerStatus).toBe("Registered as Ava");
    expect(settings.longlive.personaId).toBe(DEFAULT_PERSONA_ID);
    expect(settings.longlive.personas).toEqual([
      { id: "long-only", note: "", name: "", addedAt: "" },
    ]);
    expect(settings.longlive.attested).toBe(false);
    expect(settings.longlive.registerStatus).toBeNull();
    expect(settings.swap.canRegister).toBe(false);
  });

  it("registering an id already listed does not duplicate it", () => {
    const listed = updatePersonaMode(initialPersonaSettings(), "swap", {
      personas: [
        {
          id: "upload-cccccccccccc",
          note: "Registered upload",
          name: "Ava",
          addedAt: "",
        },
      ],
    });
    const again = withRegisteredPersona(
      listed,
      "swap",
      "upload-cccccccccccc",
      "Ava",
    );
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
      { id: DEFAULT_PERSONA_ID, note: "", name: "", addedAt: "" },
    ]);
  });

  it("labels a named persona with its local added time, and falls back to the id when unnamed", () => {
    // Computed rather than hardcoded so the expectation holds under any test-runner time zone.
    const addedAt = "2026-09-23T17:03:00+01:00";
    const date = new Date(addedAt);
    const day = date.getDate().toString().padStart(2, "0");
    const month = date.toLocaleString(undefined, { month: "short" });
    const hours = date.getHours().toString().padStart(2, "0");
    const minutes = date.getMinutes().toString().padStart(2, "0");
    expect(
      personaOptionLabel({
        id: "upload-aaaaaaaaaaaa",
        note: "",
        name: "Ava",
        addedAt,
      }),
    ).toBe(`Ava · ${day} ${month} ${hours}:${minutes}`);
    expect(
      personaOptionLabel({
        id: "upload-aaaaaaaaaaaa",
        note: "",
        name: "",
        addedAt: "",
      }),
    ).toBe("upload-aaaaaaaaaaaa");
    // A name with no parseable addedAt (an old entry backfilled by hand) still shows the name.
    expect(
      personaOptionLabel({
        id: "x",
        note: "",
        name: "Ava",
        addedAt: "not-a-date",
      }),
    ).toBe("Ava");
  });
});
