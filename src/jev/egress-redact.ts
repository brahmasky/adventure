/**
 * The one text seam before anything leaves for TypeSafe (ADR 0029 §4.5). Order: the broker masks the secret VALUES it
 * holds (when a broker exists), then code strips credential SHAPES Houge cannot know by value. Deterministic, so the
 * replay and the live path hash the same state. Ordinary words, dates and short numbers pass through.
 */
const SHAPES: Array<[RegExp, string]> = [
  // shell/heredoc bodies and long quoted literals: the material a steered command would hide (spec §4.5)
  [/<<-?\s*['"]?(\w+)['"]?[\s\S]*?(?:\n\1\b|$)/g, "<heredoc>"], // unterminated: strips to end of text
  [/(["'`])[A-Za-z0-9+/_=.~-]{40,}\1/g, "<literal>"], // opaque only (no whitespace): a quoted sentence is prose, not a secret
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, "Bearer <token>"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, "<token>"],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, "<token>"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "<token>"],
  [/\b[A-Fa-f0-9]{32,}\b/g, "<token>"],
  [/\b(?=[A-Za-z0-9+/_-]*[0-9+/_-])[A-Za-z0-9+/_-]{40,}={0,2}\b/g, "<token>"], // needs a digit or one of +/_- so a long plain word survives
  [/\bhttps?:\/\/[^\s<>"']+/g, "<url>"],
  [/\/Users\/[^/\s]+/g, "~"],
  // OTP-shaped codes (6–8 digits standing alone) and every Telegram id form (9+ digit ids, negative supergroup ids)
  [/(?<![\d.,])\d{6,8}(?![\d.,])/g, "<code>"],
  [/(?<![\d.])-?\d{9,}\b/g, "<id>"]
];

export function sanitizeJevText(text: string, brokerRedact?: (s: string) => string): string {
  let out = brokerRedact ? brokerRedact(text) : text;
  for (const [re, rep] of SHAPES) out = out.replace(re, rep);
  return out;
}
