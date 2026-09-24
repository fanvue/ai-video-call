// Server-side hard limits shared by the LongLive action path and the Director; a match fails closed to a neutral hold, never to another planner.

// A request with a minor cue fails closed to the neutral reaction, before it reaches the LLM or a template.
export const MINOR_CUE_RE =
  /\b(teen\w*|child\w*|kid|kids|minor|minors|underage|under-age|schoolgirl\w*|school uniform|loli\w*|little girl|barely legal|jailbait)\b/i;

// Conservative lexicon for the other hard limits (incest, animals, non-consent, scat, gore); the Director's own refusal covers what words cannot, such as real named people.
export const HARD_LIMIT_CUE_RE =
  /\b(incest\w*|step[- ]?(sister|sis|brother|bro|daughter|son|mom|mum|dad|mother|father)s?|bestiality|zoophil\w*|rape|raped|raping|rapist|non-?consensual|nonconsent|drugged|unconscious|scat|gore)\b/i;
