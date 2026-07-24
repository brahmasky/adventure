/**
 * Shared text hygiene for external/hostile strings (extracted verbatim from bounty-intake,
 * spec 2026-07-22 §5). Every string derived from an external venue, API response, or mail
 * body passes through here before entering any digest, ledger line, or Telegram render.
 */

// C0/C1 controls, bidi overrides/isolates, zero-width + BOM.
const STRIP_RE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF\u202A-\u202E\u2066-\u2069]/g;

/**
 * Remove every character in the shared strip class — ONE definition for every external
 * text floor (M1/M2: the radar slimmers and the extract parse floor must strip exactly
 * what sanitizeVenueText strips; a second hand-rolled class would drift).
 */
export function stripHostileChars(value: string): string {
  return value.replace(STRIP_RE, "");
}

export function sanitizeVenueText(raw: unknown, maxChars: number): string {
  if (typeof raw !== "string") return "";
  const flat = raw.replace(/[\r\n\t\u2028\u2029\u0085]+/g, " ").replace(STRIP_RE, "").replace(/\s{2,}/g, " ").trim();
  const points = Array.from(flat);
  return points.length > maxChars ? `${points.slice(0, maxChars).join("")}…` : flat;
}

export function escapeForTelegram(text: string): string {
  // Venue-derived strings are rendered inert (spec §3): no markdown/link spoofing.
  return text.replace(/([[\]()*_`~])/g, "");
}
