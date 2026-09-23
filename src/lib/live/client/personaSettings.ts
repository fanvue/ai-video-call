import {
  DEFAULT_PERSONA_ID,
  type PersonaOption,
  type RenderBackend,
} from "@/lib/live/contract";

// LongLive's face lock and swap mode's swap source are separate settings, each with its own list and register state.
type PersonaMode = "longlive" | "swap";

type PersonaModeState = {
  // "" is the Off option.
  personaId: string;
  personas: PersonaOption[];
  canRegister: boolean;
  attested: boolean;
  // The name typed for the next registration, not the selected persona's own name.
  name: string;
  registerStatus: string | null;
};

type PersonaSettings = Record<PersonaMode, PersonaModeState>;

const initialModeState = (): PersonaModeState => ({
  personaId: DEFAULT_PERSONA_ID,
  personas: [],
  canRegister: false,
  attested: false,
  name: "",
  registerStatus: null,
});

export const initialPersonaSettings = (): PersonaSettings => ({
  longlive: initialModeState(),
  swap: initialModeState(),
});

export const personaModeFor = (backend: RenderBackend): PersonaMode | null =>
  backend === "longlive" || backend === "swap" ? backend : null;

export const updatePersonaMode = (
  settings: PersonaSettings,
  mode: PersonaMode,
  patch: Partial<PersonaModeState>,
): PersonaSettings => ({
  ...settings,
  [mode]: { ...settings[mode], ...patch },
});

export const withRegisteredPersona = (
  settings: PersonaSettings,
  mode: PersonaMode,
  id: string,
  name: string,
): PersonaSettings => {
  const { personas } = settings[mode];
  return updatePersonaMode(settings, mode, {
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
  });
};

// The seed persona stays selectable while a cold listing is still loading.
export const personaOptionsFor = (state: PersonaModeState): PersonaOption[] =>
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

// Only the active mode's selection is submitted, under that mode's own key.
export const submittedPersona = (
  settings: PersonaSettings,
  backend: RenderBackend,
): { personaId?: string; swapPersonaId?: string } => {
  if (backend === "longlive" && settings.longlive.personaId) {
    return { personaId: settings.longlive.personaId };
  }
  if (backend === "swap" && settings.swap.personaId) {
    return { swapPersonaId: settings.swap.personaId };
  }
  return {};
};
