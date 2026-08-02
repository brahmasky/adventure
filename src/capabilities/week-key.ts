// Panel week identity + schedule resolution (Idea Radar R2, spec §4).
//
// `computeWeekKey` renders the fire instant's LOCAL calendar date in the panel tz and runs the
// ISO-8601 week algorithm on that local date. Rationale (spec §4): Sunday 09:00 Sydney is
// Saturday UTC, and a `mon 08:00` Sydney config is Sunday UTC — a UTC-based week would mislabel
// briefs, snapshots and dedupe keys for Monday-morning configs.
import type { ScheduleWeekday } from "../run/schedule-spec.js";

const DAY_MS = 86_400_000;

/** The local {y, m, d} of `instant` in `tz`; invalid tz falls back to UTC parts (never throws). */
function localDateParts(instant: Date, tz: string): { y: number; m: number; d: number } {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
  } catch {
    // Invalid IANA name → UTC fallback. A misconfigured HOUGE_RADAR_TZ must skew the label,
    // never crash the tick.
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
  }
  const parts = fmt.formatToParts(instant);
  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  return { y: get("year"), m: get("month"), d: get("day") };
}

/**
 * The ISO-8601 week (`YYYY-Www`, zero-padded) containing `nowIso` **as seen in `tz`**.
 *
 * Algorithm (Thursday rule): a date's ISO week is the week of its Thursday, and the ISO year is
 * that Thursday's calendar year. We compute the local Y-M-D via Intl, re-house it in a pure
 * UTC calendar container (no clock component), shift to the week's Thursday, and count weeks
 * from Jan 1 of the Thursday's year (week 1 is by construction the week of the year's first
 * Thursday). Total function: invalid tz → UTC parts; an unparseable instant degrades to the
 * epoch (callers pass store-controlled ISO strings, so this is a never-crash floor, not a path).
 */
export function computeWeekKey(nowIso: string, tz: string): string {
  const parsed = Date.parse(nowIso);
  const instant = Number.isFinite(parsed) ? new Date(parsed) : new Date(0);
  const { y, m, d } = localDateParts(instant, tz);

  // Pure calendar math on the LOCAL date, using UTC accessors as a tz-free date container.
  const target = Date.UTC(y, m - 1, d);
  const isoWeekday = (new Date(target).getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  const thursday = target + (3 - isoWeekday) * DAY_MS;
  const isoYear = new Date(thursday).getUTCFullYear();
  const jan1 = Date.UTC(isoYear, 0, 1);
  const week = Math.floor((thursday - jan1) / (7 * DAY_MS)) + 1;

  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/** Resolved weekly panel slot. `null` from {@link resolvePanelAt} means the panel is OFF. */
export interface PanelSchedule {
  day: ScheduleWeekday;
  at: string;
}

const PANEL_WEEKDAYS: ReadonlySet<string> = new Set([
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat"
]);

/** Same shape as schedule-spec's AT_PATTERN: zero-padded 24h `HH:MM` (so `9:00` is malformed). */
const PANEL_AT_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The documented default slot: Sunday 09:00 (panel tz). */
export const PANEL_DEFAULT_SCHEDULE: PanelSchedule = { day: "sun", at: "09:00" };

/**
 * The shared weekly-slot grammar (spec §4, EXACT — one parser for the panel AND the skill
 * re-verify advisor, so the grammars can never drift):
 *   - `undefined` → a copy of `fallback`;
 *   - trim+lowercase `"off"` → `null` (the tick never fires — no interval fallback);
 *   - else trim → lowercase → split on whitespace → exactly 2 tokens, token 1 ∈ the
 *     `ScheduleWeekday` union, token 2 zero-padded `HH:MM`;
 *   - anything malformed → a copy of `fallback` (the /status line renders the RESOLVED
 *     slot, so a swallowed typo is visible there — never a throw, never a half-parse).
 */
export function parseWeeklyAt(
  raw: string | undefined,
  fallback: { day: ScheduleWeekday; at: string }
): { day: ScheduleWeekday; at: string } | null {
  if (raw === undefined) return { ...fallback };
  const folded = raw.trim().toLowerCase();
  if (folded === "off") return null;
  const tokens = folded.split(/\s+/);
  if (tokens.length !== 2) return { ...fallback };
  const [day, at] = tokens as [string, string];
  if (!PANEL_WEEKDAYS.has(day)) return { ...fallback };
  if (!PANEL_AT_PATTERN.test(at)) return { ...fallback };
  return { day: day as ScheduleWeekday, at };
}

/** Resolve `HOUGE_RADAR_PANEL_AT` via the shared grammar (default `sun 09:00`). */
export function resolvePanelAt(env: NodeJS.ProcessEnv): PanelSchedule | null {
  return parseWeeklyAt(env.HOUGE_RADAR_PANEL_AT, PANEL_DEFAULT_SCHEDULE);
}
