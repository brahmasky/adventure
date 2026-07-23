import { resolveTimeZone, wallClockToInstant } from "../prompt/tz-convert.js";
import type { ScheduledTaskRow } from "./run-store.js";

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
  | { kind: "once"; at_iso: string }
  | { kind: "once"; in_minutes: number };

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
    // Relative form FIRST — "N分钟后" asks were reaching us as planner-computed at_iso
    // with the wrong UTC offset (live gate 07-15: prose said 18:04 Sydney, at_iso said
    // 19:04). in_minutes keeps the clock math code-side; the tool description steers
    // planners here for anything relative.
    if (spec.in_minutes !== undefined) {
      if (
        typeof spec.in_minutes !== "number" ||
        !Number.isInteger(spec.in_minutes) ||
        spec.in_minutes < 1 ||
        spec.in_minutes > ONCE_IN_MINUTES_MAX
      ) {
        return null;
      }
      return { kind: "once", in_minutes: spec.in_minutes };
    }
    if (typeof spec.at_iso !== "string" || !Number.isFinite(Date.parse(spec.at_iso))) return null;
    return { kind: "once", at_iso: spec.at_iso };
  }
  return null;
}

/** One week — a relative one-shot beyond that should be an absolute (or recurring) ask. */
export const ONCE_IN_MINUTES_MAX = 10_080;

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
    if ("in_minutes" in spec) {
      // Code-side clock math: anchored to `afterIso` (creation time). Only ever computed
      // once — the tick disables a fired `once` row, so a misfire can't re-anchor it.
      return new Date(afterMs + spec.in_minutes * 60_000).toISOString();
    }
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

/**
 * The IANA zone to render human-facing times in when there is no per-item tz (e.g. the
 * /status daemon/errors/rating lines). Per-schedule rows already carry their own `tz`; this
 * is only the fallback display zone. Defaults to Sydney (all schedules use it); overridable
 * via HOUGE_DISPLAY_TZ. Houge's own lessons #10/#15: render in the user's local zone, not UTC.
 */
export function resolveDisplayZone(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOUGE_DISPLAY_TZ?.trim() || "Australia/Sydney";
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
  return "in_minutes" in spec ? `once +${spec.in_minutes}min` : `once ${spec.at_iso}`;
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

/** `/schedule` reply when the chat has no visible (enabled/failed) schedules. */
export const SCHEDULE_LIST_EMPTY_TEXT =
  "No schedules for this chat yet. Ask Houge in plain language to schedule a recurring task.";

/** Goal preview length on a `/schedule` list row. */
export const SCHEDULE_GOAL_PREVIEW_CHARS = 60;

/** Display-name length on a `/schedule` list row (after the guard preamble is stripped). */
export const SCHEDULE_DISPLAY_NAME_CHARS = 40;

/** Marks the dedup-guard preamble the planner prepends to a schedule goal (never user-facing). */
const SCHEDULE_GUARD_MARKER = /此定时任务|绝不要再创建/;

/**
 * The human-facing name for a schedule's stored goal: strips a dedup-guard parenthetical
 * (full-width `（…）` or half-width `(…)`) whose content carries the guard marker — that
 * preamble ("此定时任务已存在…绝不要再创建新的定时任务") is internal plumbing steering the
 * planner, and must NEVER show in the /schedule list. Then trims a separator left where the
 * group sat and caps to a readable length.
 */
export function scheduleDisplayName(goal: string): string {
  const name = goal
    .replace(/（[^）]*）|\([^)]*\)/g, (group) => (SCHEDULE_GUARD_MARKER.test(group) ? "" : group))
    .replace(/\s+/g, " ")
    .replace(/^[\s：:，,、·—-]+/, "")
    .trim();
  return name.length > SCHEDULE_DISPLAY_NAME_CHARS
    ? `${name.slice(0, SCHEDULE_DISPLAY_NAME_CHARS)}…`
    : name;
}

/**
 * Render the schedule list (B10b; moved from gateway in scheduler v2 — the
 * schedule_task list verb and the /schedule command share ONE renderer): one line per
 * non-disabled schedule. Failed rows keep their line, prefixed `⚠ failed · ` (the
 * owner must see a schedule that stopped retrying). Disabled rows are history — omitted.
 */
export function formatScheduleListText(rows: ScheduledTaskRow[]): string {
  const visible = rows.filter((row) => row.state !== "disabled");
  if (visible.length === 0) return SCHEDULE_LIST_EMPTY_TEXT;
  return visible.map((row) => formatScheduleLine(row)).join("\n");
}

function formatScheduleLine(row: ScheduledTaskRow): string {
  const spec = parseScheduleSpec(row.spec_json);
  const cadence = spec ? describeScheduleSpec(spec) : "unreadable spec";
  // City only — the full IANA zone is redundant once the wall-clock is rendered in it.
  const city = row.tz.split("/").pop() ?? row.tz;
  const name = scheduleDisplayName(row.goal);
  const nextLocal = formatInstantInZone(row.next_run_at, row.tz);
  const prefix = row.state === "failed" ? "⚠ failed · " : "";
  // The id trails, de-emphasized — /schedule cancel matches it EXACTLY (run-store
  // getScheduledTask/cancelScheduledTask are `WHERE schedule_id = ?`), so the full id stays.
  return `${prefix}${name} · ${cadence} (${city}) · 下次 ${nextLocal} · ${row.schedule_id}`;
}
