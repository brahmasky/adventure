import { resolveTimeZone, wallClockToInstant } from "../prompt/tz-convert.js";

/**
 * Scheduler v1 spec + next-run math (B10b, ADR 0017). A schedule is a tiny declarative
 * spec (weekly/daily/once) plus an IANA timezone stored BESIDE it — the wall-clock time
 * is the user's contract ("every Monday 08:00 Sydney"), so next-run computation converts
 * wall-clock → instant per occurrence via the DST-correct fixed-point solver in
 * src/prompt/tz-convert.ts (never a cached UTC offset, which breaks at every DST edge).
 */
export type ScheduleWeekday = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";

export type ScheduleSpec =
  | { kind: "weekly"; day: ScheduleWeekday; at: string }
  | { kind: "daily"; at: string }
  | { kind: "once"; at_iso: string };

/** getUTCDay() order — index into it with a calendar date's day-of-week. */
const WEEKDAYS: readonly ScheduleWeekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const AT_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Tolerant parse of a stored/model-supplied spec: any bad shape (wrong kind, malformed
 * "HH:MM", non-string fields, invalid JSON when a string is passed) degrades to `null` —
 * a corrupt row or a hallucinated spec must surface as a refusal, never a throw.
 */
export function parseScheduleSpec(value: unknown): ScheduleSpec | null {
  let raw: unknown = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof raw !== "object" || raw === null) return null;
  const spec = raw as Record<string, unknown>;
  if (spec.kind === "weekly") {
    if (typeof spec.day !== "string" || !WEEKDAYS.includes(spec.day as ScheduleWeekday)) return null;
    if (typeof spec.at !== "string" || !AT_PATTERN.test(spec.at)) return null;
    return { kind: "weekly", day: spec.day as ScheduleWeekday, at: spec.at };
  }
  if (spec.kind === "daily") {
    if (typeof spec.at !== "string" || !AT_PATTERN.test(spec.at)) return null;
    return { kind: "daily", at: spec.at };
  }
  if (spec.kind === "once") {
    if (typeof spec.at_iso !== "string" || !Number.isFinite(Date.parse(spec.at_iso))) return null;
    return { kind: "once", at_iso: spec.at_iso };
  }
  return null;
}

/** The calendar date of `instant` rendered in `tz`, as {y, m, d} (en-CA = ISO order). */
function localDateParts(instant: Date, tz: string): { y: number; m: number; d: number } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const p = Object.fromEntries(fmt.formatToParts(instant).map((part) => [part.type, part.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day) };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * The first firing instant STRICTLY AFTER `afterIso`, as a UTC ISO string; `null` when it
 * cannot be computed (bad tz, a `once` already in the past). weekly/daily walk CALENDAR
 * dates (pure UTC-day arithmetic — never instant+24h, which skips a local date across a
 * DST spring-forward) starting from `afterIso`'s local date in `tz`, ≤8 iterations, and
 * convert each candidate wall-clock via the DST-correct solver. This is also the MISFIRE
 * policy's advance step: after a missed fire the tick recomputes from NOW, so downtime
 * yields exactly one catch-up fire, never a burst.
 */
export function computeNextRunAt(spec: ScheduleSpec, tz: string, afterIso: string): string | null {
  const afterMs = Date.parse(afterIso);
  if (!Number.isFinite(afterMs)) return null;
  if (spec.kind === "once") {
    const at = Date.parse(spec.at_iso);
    if (!Number.isFinite(at) || at <= afterMs) return null;
    return new Date(at).toISOString();
  }
  const zone = resolveTimeZone(tz);
  if (!zone) return null;
  const start = localDateParts(new Date(afterMs), zone);
  const anchor = Date.UTC(start.y, start.m - 1, start.d);
  for (let i = 0; i <= 8; i += 1) {
    const day = new Date(anchor + i * 86_400_000);
    if (spec.kind === "weekly" && WEEKDAYS[day.getUTCDay()] !== spec.day) continue;
    const when = `${day.getUTCFullYear()}-${pad2(day.getUTCMonth() + 1)}-${pad2(day.getUTCDate())} ${spec.at}`;
    const instant = wallClockToInstant(when, zone);
    if (instant && instant.getTime() > afterMs) return instant.toISOString();
  }
  return null;
}

/** Render `iso` as a "YYYY-MM-DD HH:MM" wall-clock in `tz` (the digest/list rendering). */
export function formatInstantInZone(iso: string, tz: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** One human line for a spec (list rows, digests): "weekly mon 08:00" | "daily 08:00" | "once <iso>". */
export function describeScheduleSpec(spec: ScheduleSpec): string {
  if (spec.kind === "weekly") return `weekly ${spec.day} ${spec.at}`;
  if (spec.kind === "daily") return `daily ${spec.at}`;
  return `once ${spec.at_iso}`;
}

/** Max chars of the model-supplied goal stored on a schedule (it becomes a future turn text). */
export const SCHEDULE_GOAL_CHAR_CAP = 300;

/**
 * Write-time neutralization of the model-supplied goal (the time-convert digest-sanitizer
 * conventions): the goal is rendered into step digests and the /schedule list, AND replayed
 * verbatim as a future turn's message — so flatten CR/LF plus the Unicode line separators
 * U+2028/U+2029 and NEL U+0085 (forged-frame-line class — a goal must never fabricate a
 * second `/schedule` list row; same coverage the episodic fact-sanitizer got in Phase M),
 * replace `→` (converted-row forgery), neutralize `time_claims:` (guard-arming marker), and
 * cap. All substitutions are NON-DELETING; empty-after-sanitizing is the caller's refusal
 * signal.
 */
export function sanitizeScheduleGoal(value: string): string {
  const flat = value
    .replace(/[\r\n\u2028\u2029\u0085]+/g, " ")
    .replace(/→/g, "-")
    .replace(/time_claims:/gi, "time_claims ")
    .trim();
  const capped = flat.length > SCHEDULE_GOAL_CHAR_CAP ? flat.slice(0, SCHEDULE_GOAL_CHAR_CAP) : flat;
  return /time_claims$/i.test(capped) ? `${capped}-` : capped;
}

/** Whether the scheduler is armed (`HOUGE_SCHEDULER_ENABLED`). DEFAULT OFF — the
 *  `schedule_task` tool is unlisted AND the daemon tick never fires unless this is
 *  truthy (armed-listing, like http_fetch). Accepts 1/true/yes/on. */
export function resolveSchedulerEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.HOUGE_SCHEDULER_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/** Active (state='enabled') schedules allowed per chat before schedule_task refuses. */
export const DEFAULT_SCHEDULER_MAX_PER_CHAT = 10;

export function resolveSchedulerMaxPerChat(env: NodeJS.ProcessEnv): number {
  const n = Number(env.HOUGE_SCHEDULER_MAX_PER_CHAT);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_SCHEDULER_MAX_PER_CHAT;
}
