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
  registerStatus: string | null;
};

type PersonaSettings = Record<PersonaMode, PersonaModeState>;

const initialModeState = (): PersonaModeState => ({
  personaId: DEFAULT_PERSONA_ID,
  personas: [],
  canRegister: false,
  attested: false,
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
): PersonaSettings => {
  const { personas } = settings[mode];
  return updatePersonaMode(settings, mode, {
    personas: personas.some((persona) => persona.id === id)
      ? personas
      : [...personas, { id, note: "Registered upload" }],
    personaId: id,
    registerStatus: `Registered as ${id}`,
  });
};

// The seed persona stays selectable while a cold listing is still loading.
export const personaOptionsFor = (state: PersonaModeState): PersonaOption[] =>
  state.personas.some(({ id }) => id === DEFAULT_PERSONA_ID)
    ? state.personas
    : [{ id: DEFAULT_PERSONA_ID, note: "" }, ...state.personas];

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
