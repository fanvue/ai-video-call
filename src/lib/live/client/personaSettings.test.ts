import { describe, expect, it } from "vitest";
import { DEFAULT_PERSONA_ID } from "@/lib/live/contract";
import {
  initialPersonaSettings,
  personaOptionLabel,
  personaOptionsFor,
  submittedPersona,
  withRegisteredPersona,
} from "./personaSettings";

describe("persona settings", () => {
  it("registering adds the upload, selects it and clears the name field", () => {
    const settings = withRegisteredPersona(
      { ...initialPersonaSettings(), attested: true, name: "Ava" },
      "upload-bbbbbbbbbbbb",
      "Ava",
    );

    expect(settings.personas).toHaveLength(1);
    expect(settings.personas[0]).toMatchObject({
      id: "upload-bbbbbbbbbbbb",
      note: "Registered upload",
      name: "Ava",
    });
    expect(settings.personaId).toBe("upload-bbbbbbbbbbbb");
    // The name field is cleared once a registration completes.
    expect(settings.name).toBe("");
    expect(settings.registerStatus).toBe("Registered as Ava");
  });

  it("registering an id already listed does not duplicate it", () => {
    const listed = {
      ...initialPersonaSettings(),
      personas: [
        {
          id: "upload-cccccccccccc",
          note: "Registered upload",
          name: "Ava",
          addedAt: "",
        },
      ],
    };
    const again = withRegisteredPersona(listed, "upload-cccccccccccc", "Ava");
    expect(again.personas).toHaveLength(1);
  });

  it("submits the picked id as the swap source, and nothing when Off", () => {
    const settings = { ...initialPersonaSettings(), personaId: "swap-pick" };
    expect(submittedPersona(settings)).toEqual({ swapPersonaId: "swap-pick" });
    expect(submittedPersona({ ...settings, personaId: "" })).toEqual({});
  });

  it("keeps the seed persona selectable before the list loads", () => {
    expect(personaOptionsFor(initialPersonaSettings())).toEqual([
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
