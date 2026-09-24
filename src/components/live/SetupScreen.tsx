"use client";

import { useEffect, useRef, useState } from "react";
import {
  type PersonaOption,
  type SceneId,
  type SpeechMode,
} from "@/lib/live/contract";
import {
  initialPersonaSettings,
  personaOptionLabel,
  personaOptionsFor,
  submittedPersona,
  withRegisteredPersona,
} from "@/lib/live/client/personaSettings";
import type { PrepareStatus } from "@/lib/live/client/useLiveSession";

const SCENES: { id: SceneId; label: string }[] = [
  { id: "bedroom", label: "Bedroom" },
  { id: "office", label: "Home office" },
  { id: "livingRoom", label: "Living room" },
  { id: "kitchen", label: "Kitchen" },
];

// Swap is the default; Premium renders chain clips on our Wan 14B service and falls back to swap per clip.
export type RenderMode = "swap" | "wan14b";

const RENDER_MODES: { id: RenderMode; label: string; hint: string }[] = [
  {
    id: "swap",
    label: "Swap",
    hint: "Default and fastest",
  },
  {
    id: "wan14b",
    label: "Premium (slower, best likeness)",
    hint: "About 16 s to make each 5 s clip on one H100, about $4/hr while rendering",
  },
];

// Face lock and Hand mask tune the swap recipe; Premium swaps inside its own service, so they would do nothing there.
export const showsSwapTuning = (mode: RenderMode): boolean => mode === "swap";

export type SetupSubmit = {
  file: File;
  sceneId: SceneId;
  displayName: string;
  speechMode: SpeechMode;
  renderMode: RenderMode;
  swapFaceLock: boolean;
  swapHandMask: boolean;
  swapPersonaId?: string;
};

type PersonaLoader = () => Promise<{
  personas: PersonaOption[];
  canRegister: boolean;
}>;

type SetupScreenProps = {
  busy: boolean;
  error: string | null;
  onPrepare?: (file: File, sceneId: SceneId, stage: boolean) => void;
  // Swap mode's own list and registration, served without a GPU.
  loadSwapPersonas?: PersonaLoader;
  onRegisterSwapPersona?: (file: File, name: string) => Promise<{ id: string }>;
  preparation?: { status: PrepareStatus; seedUrl: string | null };
  onSubmit: (values: SetupSubmit) => void;
  // Picking Premium starts the Wan container's ~100 s boot while the rest of setup is filled in.
  onChoosePremium?: () => void;
};

// Long enough that flicking through the scenes does not stage a still ($0.03) for each one.
const PREPARE_DEBOUNCE_MS = 300;

const PREPARATION_LABEL: Record<PrepareStatus, string | null> = {
  idle: null,
  staging: "Staging her scene, 20 to 35 seconds",
  ready: "Scene ready",
  uploaded: "Photo ready",
  unstaged: "Scene staging unavailable, she starts from your photo",
  failed: "Could not prepare the photo, it will be retried on start",
};

export const SetupScreen = ({
  busy,
  error,
  onPrepare,
  loadSwapPersonas,
  onRegisterSwapPersona,
  preparation,
  onSubmit,
  onChoosePremium,
}: SetupScreenProps) => {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [sceneId, setSceneId] = useState<SceneId>("bedroom");
  const [displayName, setDisplayName] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [voiceExperimental, setVoiceExperimental] = useState(false);
  // On by default: the persona recipe held identity best in testing, for about 2.3x the swap GPU time.
  const [swapFaceLock, setSwapFaceLock] = useState(true);
  const [swapHandMask, setSwapHandMask] = useState(false);
  const [renderMode, setRenderMode] = useState<RenderMode>("swap");
  const [personaSettings, setPersonaSettings] = useState(
    initialPersonaSettings,
  );
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Staging is the slow part of the join (20 to 35 s), so it runs here and the call starts only once it has settled.
  const staging = preparation?.status === "staging";
  const canSubmit = Boolean(file) && !busy && !staging;
  const stagedUrl =
    preparation?.status === "ready" ? preparation.seedUrl : null;
  const preparationLabel = preparation
    ? PREPARATION_LABEL[preparation.status]
    : null;

  useEffect(() => {
    if (!file || !onPrepare) {
      return;
    }
    // Swap mode sets the scene inside its greeting, so the reference step skips the staged still.
    const timeoutId = setTimeout(
      () => onPrepare(file, sceneId, false),
      PREPARE_DEBOUNCE_MS,
    );
    return () => clearTimeout(timeoutId);
  }, [file, sceneId, onPrepare]);

  useEffect(() => {
    if (!loadSwapPersonas) {
      return;
    }
    let cancelled = false;
    loadSwapPersonas()
      .then(({ personas, canRegister }) => {
        if (cancelled) return;
        setPersonaSettings((current) => ({
          ...current,
          personas,
          canRegister,
        }));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [loadSwapPersonas]);

  const registeredName = personaSettings.name.trim();
  const registerUpload = () => {
    if (
      !file ||
      !personaSettings.attested ||
      !registeredName ||
      !onRegisterSwapPersona
    ) {
      return;
    }
    const setStatus = (registerStatus: string) =>
      setPersonaSettings((current) => ({ ...current, registerStatus }));
    setStatus("Registering…");
    onRegisterSwapPersona(file, registeredName)
      .then(({ id }) =>
        setPersonaSettings((current) =>
          withRegisteredPersona(current, id, registeredName),
        ),
      )
      .catch((e: unknown) =>
        setStatus(e instanceof Error ? e.message : "Registration failed"),
      );
  };

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-6 px-4 py-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-[var(--foreground)]">
          Set up your live
        </h1>
        <p className="text-sm text-[var(--muted)]">
          Upload a reference photo and pick a scene to start.
        </p>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png"
        className="hidden"
        onChange={(event) => {
          const picked = event.target.files?.[0] ?? null;
          setFile(picked);
          if (previewUrl) {
            URL.revokeObjectURL(previewUrl);
          }
          setPreviewUrl(picked ? URL.createObjectURL(picked) : null);
        }}
      />
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        aria-label="Choose a reference photo"
        className="flex aspect-[3/4] w-full items-center justify-center overflow-hidden rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)]"
      >
        {(stagedUrl ?? previewUrl) ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={stagedUrl ?? previewUrl ?? undefined}
            alt=""
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="text-sm text-[var(--muted)]">
            Choose a JPEG or PNG photo
          </span>
        )}
      </button>
      {preparationLabel ? (
        <p className="text-xs text-[var(--muted)]" role="status">
          {preparationLabel}
        </p>
      ) : null}

      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-[var(--foreground)]">
          Display name
        </span>
        <input
          type="text"
          value={displayName}
          maxLength={40}
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder="Her"
          className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--foreground)] outline-none"
        />
      </label>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium text-[var(--foreground)]">
          Scene
        </span>
        <div className="flex flex-wrap gap-2">
          {SCENES.map((scene) => (
            <button
              key={scene.id}
              type="button"
              onClick={() => setSceneId(scene.id)}
              aria-pressed={sceneId === scene.id}
              className={
                "rounded-full px-4 py-2 text-sm " +
                (sceneId === scene.id
                  ? "bg-[var(--foreground)] text-[var(--background)]"
                  : "border border-[var(--border)] text-[var(--foreground)]")
              }
            >
              {scene.label}
            </button>
          ))}
        </div>
      </div>

      <div
        className="flex flex-col gap-2"
        role="radiogroup"
        aria-label="Render"
      >
        <span className="text-sm font-medium text-[var(--foreground)]">
          Render
        </span>
        {RENDER_MODES.map((mode) => (
          <label
            key={mode.id}
            className="flex flex-col gap-0.5 text-sm text-[var(--foreground)]"
          >
            <span className="flex items-center gap-2">
              <input
                type="radio"
                name="renderMode"
                value={mode.id}
                checked={renderMode === mode.id}
                onChange={() => {
                  setRenderMode(mode.id);
                  if (mode.id === "wan14b") {
                    onChoosePremium?.();
                  }
                }}
              />
              {mode.label}
            </span>
            <span className="pl-6 text-xs text-[var(--muted)]">
              {mode.hint}
            </span>
          </label>
        ))}
      </div>

      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={() => setAdvancedOpen((open) => !open)}
          aria-expanded={advancedOpen}
          className="self-start text-sm text-[var(--muted)] underline"
        >
          Advanced
        </button>
        {advancedOpen ? (
          <div className="flex flex-col gap-2 rounded-xl border border-[var(--border)] p-3">
            <label className="flex items-center gap-2 text-xs text-[var(--muted)]">
              <input
                type="checkbox"
                checked={voiceExperimental}
                onChange={(event) => setVoiceExperimental(event.target.checked)}
              />
              Voice (experimental)
            </label>
            {showsSwapTuning(renderMode) ? (
              <>
                <p className="text-xs text-[var(--muted)]">
                  Each Turbo clip gets the persona face swapped in on our own
                  GPU before it plays, under a cent a clip. A 10 s reply&apos;s
                  first 4 s shows about 3.5 s after it renders (4.5 s with Face
                  lock) while the rest swaps alongside; the swapped last frame
                  seeds the next clip so identity re-locks every clip.
                </p>
                <div className="flex flex-col gap-1">
                  <label className="flex items-center gap-2 text-xs text-[var(--muted)]">
                    <input
                      type="checkbox"
                      checked={swapFaceLock}
                      onChange={(event) =>
                        setSwapFaceLock(event.target.checked)
                      }
                    />
                    Face lock
                  </label>
                  <p className="text-xs text-[var(--muted)]">
                    Persona swap plus GFPGAN face restore, as in LongLive; about
                    2.3x the swap GPU time
                  </p>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="flex items-center gap-2 text-xs text-[var(--muted)]">
                    <input
                      type="checkbox"
                      checked={swapHandMask}
                      onChange={(event) =>
                        setSwapHandMask(event.target.checked)
                      }
                    />
                    Hand mask
                  </label>
                  <p className="text-xs text-[var(--muted)]">
                    Keeps hands in front of the face crisp, but swaps run slower
                  </p>
                </div>
              </>
            ) : null}
            <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
              Persona
              <select
                value={personaSettings.personaId}
                onChange={(event) =>
                  setPersonaSettings((current) => ({
                    ...current,
                    personaId: event.target.value,
                  }))
                }
                className="rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] p-2 text-[var(--foreground)]"
              >
                <option value="">Off</option>
                {personaOptionsFor(personaSettings).map((option) => (
                  <option key={option.id} value={option.id}>
                    {personaOptionLabel(option)}
                  </option>
                ))}
              </select>
            </label>

            {personaSettings.canRegister && onRegisterSwapPersona ? (
              <div className="flex flex-col gap-2 text-xs text-[var(--muted)]">
                <label className="flex flex-col gap-1">
                  Name
                  <input
                    type="text"
                    value={personaSettings.name}
                    onChange={(event) =>
                      setPersonaSettings((current) => ({
                        ...current,
                        name: event.target.value,
                      }))
                    }
                    maxLength={40}
                    placeholder="So testers can tell faces apart"
                    className="rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] p-2 text-[var(--foreground)]"
                  />
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={personaSettings.attested}
                    onChange={(event) =>
                      setPersonaSettings((current) => ({
                        ...current,
                        attested: event.target.checked,
                      }))
                    }
                  />
                  This is a Fanvue-owned AI creator likeness, not a real person
                </label>
                <button
                  type="button"
                  disabled={
                    !file || !personaSettings.attested || !registeredName
                  }
                  onClick={registerUpload}
                  className="rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] p-2 text-[var(--foreground)] disabled:text-[var(--muted)]"
                >
                  Register this photo as a persona
                </button>
                {personaSettings.registerStatus ? (
                  <p>{personaSettings.registerStatus}</p>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <button
        type="button"
        disabled={!canSubmit}
        onClick={() => {
          if (!file) {
            return;
          }
          onSubmit({
            file,
            sceneId,
            displayName: displayName.trim(),
            speechMode: voiceExperimental ? "native" : "text",
            renderMode,
            // Hidden for Premium, so its swap fallback runs the default legacy recipe, the one the Wan service swaps with.
            swapFaceLock: showsSwapTuning(renderMode) && swapFaceLock,
            swapHandMask: showsSwapTuning(renderMode) && swapHandMask,
            ...submittedPersona(personaSettings),
          });
        }}
        className={
          "rounded-full px-4 py-3 text-sm font-semibold " +
          (canSubmit
            ? "bg-gradient-to-b from-[#ffd21a] to-[var(--accent)] text-[var(--accent-contrast)] shadow-[0_4px_14px_rgba(255,171,0,0.4)]"
            : "bg-[var(--surface-raised)] text-[var(--muted)]")
        }
      >
        {busy ? "Connecting…" : staging ? "Staging her scene…" : "Go live"}
      </button>

      {error ? (
        <p className="rounded-xl bg-[var(--danger)]/15 p-3 text-sm text-[var(--danger)]">
          {error}
        </p>
      ) : null}
    </div>
  );
};
