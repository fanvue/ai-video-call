"use client";

import { useRef, useState } from "react";
import type { RenderBackend, SceneId, SpeechMode } from "@/lib/live/contract";

const SCENES: { id: SceneId; label: string }[] = [
  { id: "bedroom", label: "Bedroom" },
  { id: "office", label: "Home office" },
  { id: "livingRoom", label: "Living room" },
  { id: "kitchen", label: "Kitchen" },
];

export type SetupSubmit = {
  file: File;
  sceneId: SceneId;
  displayName: string;
  backend: RenderBackend;
  speechMode: SpeechMode;
};

type SetupScreenProps = {
  busy: boolean;
  error: string | null;
  onSubmit: (values: SetupSubmit) => void;
};

export const SetupScreen = ({ busy, error, onSubmit }: SetupScreenProps) => {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [sceneId, setSceneId] = useState<SceneId>("bedroom");
  const [displayName, setDisplayName] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [voiceExperimental, setVoiceExperimental] = useState(false);
  const [referenceModelExperimental, setReferenceModelExperimental] =
    useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const canSubmit = Boolean(file) && !busy;

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
        {previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={previewUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <span className="text-sm text-[var(--muted)]">
            Choose a JPEG or PNG photo
          </span>
        )}
      </button>

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
            <label className="flex items-center gap-2 text-xs text-[var(--muted)]">
              <input
                type="checkbox"
                checked={referenceModelExperimental}
                onChange={(event) =>
                  setReferenceModelExperimental(event.target.checked)
                }
              />
              Reference model (experimental)
            </label>
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
            backend: referenceModelExperimental ? "reference" : "turbo",
            speechMode: voiceExperimental ? "native" : "text",
          });
        }}
        className={
          "rounded-full px-4 py-3 text-sm font-semibold " +
          (canSubmit
            ? "bg-[var(--accent)] text-[var(--accent-contrast)]"
            : "bg-[var(--surface-raised)] text-[var(--muted)]")
        }
      >
        {busy ? "Connecting…" : "Go live"}
      </button>

      {error ? (
        <p className="rounded-xl bg-[var(--danger)]/15 p-3 text-sm text-[var(--danger)]">
          {error}
        </p>
      ) : null}
    </div>
  );
};
