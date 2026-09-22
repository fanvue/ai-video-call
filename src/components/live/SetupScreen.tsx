"use client";

import { useEffect, useRef, useState } from "react";
import type { RenderBackend, SceneId, SpeechMode } from "@/lib/live/contract";
import type { PrepareStatus } from "@/lib/live/client/useLiveSession";

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
  onPrepare?: (file: File, sceneId: SceneId, stage: boolean) => void;
  preparation?: { status: PrepareStatus; seedUrl: string | null };
  onSubmit: (values: SetupSubmit) => void;
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
  preparation,
  onSubmit,
}: SetupScreenProps) => {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [sceneId, setSceneId] = useState<SceneId>("bedroom");
  const [displayName, setDisplayName] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [voiceExperimental, setVoiceExperimental] = useState(false);
  // Reference-to-video (single anchor image, periodic identity correction) held up better in
  // testing than the image-to-video/guard-repair chain, so it's the default over turbo or director.
  const [backend, setBackend] = useState<RenderBackend>("swap");
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
    const timeoutId = setTimeout(
      () => onPrepare(file, sceneId, backend !== "swap"),
      PREPARE_DEBOUNCE_MS,
    );
    return () => clearTimeout(timeoutId);
  }, [file, sceneId, backend, onPrepare]);

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
            <div
              role="radiogroup"
              aria-label="Render model"
              className="flex flex-col gap-2"
            >
              {(
                [
                  { value: "turbo", label: "Turbo" },
                  { value: "reference", label: "Reference" },
                  {
                    value: "director",
                    label: "Director (SFW only, live stream, alpha)",
                  },
                  {
                    value: "lucy",
                    label: "Lucy (SFW only, identity lock over Turbo, alpha)",
                  },
                  {
                    value: "swap",
                    label:
                      "Swap (recommended: identity lock per clip over Turbo)",
                  },
                ] as const
              ).map((option) => (
                <label
                  key={option.value}
                  className="flex items-center gap-2 text-xs text-[var(--muted)]"
                >
                  <input
                    type="radio"
                    name="renderBackend"
                    value={option.value}
                    checked={backend === option.value}
                    onChange={() => setBackend(option.value)}
                  />
                  {option.label}
                </label>
              ))}
            </div>
            {backend === "lucy" ? (
              <p className="text-xs text-[var(--muted)]">
                Turbo clips restyled live onto the reference photo; strongest
                face consistency, adds $0.02/s. Decart closes the stream on
                explicit content.
              </p>
            ) : null}
            {backend === "swap" ? (
              <p className="text-xs text-[var(--muted)]">
                Each Turbo clip gets the reference face swapped in and restored
                on our own GPU before it plays (about $1.95/hr of GPU time, a
                cent or two per clip). Adds about 5s per clip; the swapped last
                frame seeds the next clip so identity re-locks every clip.
              </p>
            ) : null}
            {backend === "director" ? (
              <p className="text-xs text-[var(--muted)]">
                fal&apos;s content policy rejects explicit requests; they show
                as failed asks.
              </p>
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
            backend,
            speechMode: voiceExperimental ? "native" : "text",
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
