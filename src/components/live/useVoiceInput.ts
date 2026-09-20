"use client";

// Push-to-talk over the Web Speech API, ported from the legacy call page's mic handling.
import { useCallback, useRef, useState } from "react";
import {
  UTTERANCE_COMMIT_MS,
  collapseRepeatedTranscript,
  getSpeechRecognitionCtor,
  type SpeechRecognitionLike,
} from "@/lib/live/client/voiceInput";

export function useVoiceInput(onCommit: (text: string) => void) {
  const [micArmed, setMicArmed] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const acceptSpeechRef = useRef(false);
  const draftTextRef = useRef("");
  const speechBufferRef = useRef("");
  const lastCommittedRef = useRef("");
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const commit = useCallback(() => {
    const combined = [speechBufferRef.current, draftTextRef.current]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    speechBufferRef.current = "";
    draftTextRef.current = "";
    if (!combined) {
      return;
    }
    const cleaned = collapseRepeatedTranscript(combined);
    if (cleaned.length < 2 || cleaned === lastCommittedRef.current) {
      return;
    }
    lastCommittedRef.current = cleaned;
    onCommit(cleaned);
  }, [onCommit]);

  const scheduleCommit = useCallback(() => {
    if (commitTimerRef.current) {
      clearTimeout(commitTimerRef.current);
    }
    commitTimerRef.current = setTimeout(() => {
      commitTimerRef.current = null;
      commit();
    }, UTTERANCE_COMMIT_MS);
  }, [commit]);

  const stop = useCallback(() => {
    acceptSpeechRef.current = false;
    if (commitTimerRef.current) {
      clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }
    draftTextRef.current = "";
    speechBufferRef.current = "";
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setMicArmed(false);
  }, []);

  const start = useCallback(() => {
    setMicError(null);
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      setMicError("This browser can't use the mic. Type instead.");
      return;
    }
    if (recognitionRef.current) {
      acceptSpeechRef.current = true;
      setMicArmed(true);
      return;
    }
    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognition.onresult = (event) => {
      if (!acceptSpeechRef.current) {
        return;
      }
      let interim = "";
      let finalText = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const piece = result?.[0]?.transcript?.trim();
        if (!piece) {
          continue;
        }
        if (result.isFinal) {
          finalText = finalText ? `${finalText} ${piece}` : piece;
        } else {
          interim = interim ? `${interim} ${piece}` : piece;
        }
      }
      if (finalText) {
        speechBufferRef.current = [speechBufferRef.current, finalText]
          .filter(Boolean)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        draftTextRef.current = "";
        scheduleCommit();
      }
      if (interim) {
        draftTextRef.current = interim;
        scheduleCommit();
      }
    };
    recognition.onerror = (event) => {
      if (
        event.error === "not-allowed" ||
        event.error === "service-not-allowed"
      ) {
        setMicError("Mic blocked. Type a message instead.");
        setMicArmed(false);
      }
    };
    recognition.onend = () => {
      if (recognitionRef.current === recognition) {
        try {
          recognition.start();
        } catch {
          // Already running; browsers can fire onend while a restart is in flight.
        }
      }
    };
    recognitionRef.current = recognition;
    acceptSpeechRef.current = true;
    try {
      recognition.start();
      setMicArmed(true);
    } catch {
      setMicArmed(false);
      setMicError("Mic blocked. Type a message instead.");
    }
  }, [scheduleCommit]);

  return { micArmed, micError, start, stop };
}
