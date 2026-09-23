import { DEFAULT_PERSONA_ID, type PersonaOption } from "@/lib/live/contract";

// Swap mode's swap source: the picked persona, its list and register state.
type PersonaSettings = {
  // "" is the Off option.
  personaId: string;
  personas: PersonaOption[];
  canRegister: boolean;
  attested: boolean;
  // The name typed for the next registration, not the selected persona's own name.
  name: string;
  registerStatus: string | null;
};

export const initialPersonaSettings = (): PersonaSettings => ({
  personaId: DEFAULT_PERSONA_ID,
  personas: [],
  canRegister: false,
  attested: false,
  name: "",
  registerStatus: null,
});

export const withRegisteredPersona = (
  settings: PersonaSettings,
  id: string,
  name: string,
): PersonaSettings => {
  const { personas } = settings;
  return {
    ...settings,
    personas: personas.some((persona) => persona.id === id)
      ? personas
      : [
          ...personas,
          {
            id,
            note: "Registered upload",
            name,
            addedAt: new Date().toISOString(),
          },
        ],
    personaId: id,
    // The name field is per-registration; clear it now that this upload is done.
    name: "",
    registerStatus: `Registered as ${name || id}`,
  };
};

// The seed persona stays selectable while a cold listing is still loading.
export const personaOptionsFor = (state: PersonaSettings): PersonaOption[] =>
  state.personas.some(({ id }) => id === DEFAULT_PERSONA_ID)
    ? state.personas
    : [
        { id: DEFAULT_PERSONA_ID, note: "", name: "", addedAt: "" },
        ...state.personas,
      ];

// "23 Sep 17:03" in the viewer's own time zone; null when addedAt is missing or unparseable.
const formatAddedAt = (addedAt: string): string | null => {
  if (!addedAt) return null;
  const date = new Date(addedAt);
  if (Number.isNaN(date.getTime())) return null;
  const day = date.getDate().toString().padStart(2, "0");
  const month = date.toLocaleString(undefined, { month: "short" });
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${day} ${month} ${hours}:${minutes}`;
};

// Picker label: "Name · 23 Sep 17:03", falling back to the id for an unnamed (older) entry.
export const personaOptionLabel = ({
  id,
  name,
  addedAt,
}: PersonaOption): string => {
  if (!name) return id;
  const stamp = formatAddedAt(addedAt);
  return stamp ? `${name} · ${stamp}` : name;
};

// Off (an empty id) submits no swap source, so clips play unswapped.
export const submittedPersona = (
  settings: PersonaSettings,
): { swapPersonaId?: string } =>
  settings.personaId ? { swapPersonaId: settings.personaId } : {};
