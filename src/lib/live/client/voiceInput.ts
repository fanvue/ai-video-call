// Web Speech API push-to-talk plumbing, ported from the legacy call page.
export type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

export type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  start: () => void;
  stop: () => void;
};

export type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
};

export const UTTERANCE_COMMIT_MS = 700;

// Speech recognition sometimes repeats the whole utterance back (interim + final overlap);
// collapse an exact doubled phrase before it reaches chat.
export const collapseRepeatedTranscript = (text: string): string => {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return cleaned;
  }
  const words = cleaned.split(" ");
  if (words.length >= 4 && words.length % 2 === 0) {
    const half = words.length / 2;
    const first = words.slice(0, half).join(" ");
    const second = words.slice(half).join(" ");
    if (first.toLowerCase() === second.toLowerCase()) {
      return first;
    }
  }
  const lower = cleaned.toLowerCase();
  for (let size = Math.floor(words.length / 2); size >= 2; size -= 1) {
    const phrase = words.slice(0, size).join(" ");
    if (lower === `${phrase.toLowerCase()} ${phrase.toLowerCase()}`) {
      return phrase;
    }
  }
  return cleaned;
};

export const getSpeechRecognitionCtor = (): SpeechRecognitionCtor | null => {
  if (typeof window === "undefined") {
    return null;
  }
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};
