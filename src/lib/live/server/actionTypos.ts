// Catalogued action verbs a one-key slip can be read back to. Shorter verbs (turn, bend, kiss, lick, sway) collide with real words at one edit, so they are left alone.
const ACTION_VERBS = [
  "wave",
  "spin",
  "strip",
  "dance",
  "twerk",
  "kneel",
  "crawl",
  "spank",
  "stand",
  "bounce",
  "jiggle",
  "squeeze",
  "undress",
  "tongue",
] as const;

// Real words within one keyboard slip of a verb above (checked against /usr/share/dict/words); never rewritten.
const REAL_WORDS = new Set([
  "save",
  "dave",
  "eave",
  "wade",
  "wage",
  "waved",
  "waver",
  "weave",
  "spun",
  "trip",
  "strop",
  "dancer",
  "dane",
  "knee",
  "keel",
  "craw",
  "drawl",
  "scrawl",
  "span",
  "sank",
  "sand",
  "stan",
  "strand",
  "ounce",
  "bouncer",
  "jingle",
  "juggle",
  "joggle",
  "squeezer",
  "tongued",
]);

const KEY_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
const KEY_POS = new Map<string, [number, number]>(
  KEY_ROWS.flatMap((row, r) =>
    [...row].map((key, i): [string, [number, number]] => [key, [r, i]]),
  ),
);

const adjacentKeys = (a: string, b: string): boolean => {
  const pa = KEY_POS.get(a);
  const pb = KEY_POS.get(b);
  return (
    !!pa &&
    !!pb &&
    a !== b &&
    Math.abs(pa[0] - pb[0]) <= 1 &&
    Math.abs(pa[1] - pb[1]) <= 1
  );
};

// One neighbouring-key substitution, one swapped pair, one stray neighbouring or doubled key, or one dropped key.
const isKeyboardSlip = (typed: string, verb: string): boolean => {
  if (typed.length === verb.length) {
    const diffs = [...typed].flatMap((c, i) => (c === verb[i] ? [] : [i]));
    if (diffs.length === 1) {
      const i = diffs[0] as number;
      return adjacentKeys(typed[i] as string, verb[i] as string);
    }
    if (diffs.length === 2) {
      const [i, j] = diffs as [number, number];
      return j === i + 1 && typed[i] === verb[j] && typed[j] === verb[i];
    }
    return false;
  }
  const [longer, shorter] =
    typed.length > verb.length ? [typed, verb] : [verb, typed];
  if (longer.length !== shorter.length + 1) return false;
  for (let i = 0; i < longer.length; i += 1) {
    if (longer.slice(0, i) + longer.slice(i + 1) !== shorter) continue;
    if (typed.length < verb.length) return true;
    const extra = longer[i] as string;
    const neighbours = [longer[i - 1], longer[i + 1]].filter(
      (c): c is string => !!c,
    );
    return neighbours.some((n) => n === extra || adjacentKeys(extra, n));
  }
  return false;
};

// "wavw" never matched the wave pattern and played as a generic hold; slipped action verbs are rewritten before intent matching.
export const correctActionTypos = (text: string): string =>
  text.replace(/[a-z]{3,}/gi, (word) => {
    const lower = word.toLowerCase();
    if (
      REAL_WORDS.has(lower) ||
      (ACTION_VERBS as readonly string[]).includes(lower)
    ) {
      return word;
    }
    const verb = ACTION_VERBS.find(
      (candidate) =>
        candidate.length >= 4 &&
        Math.abs(candidate.length - lower.length) <= 1 &&
        isKeyboardSlip(lower, candidate),
    );
    return verb ?? word;
  });
