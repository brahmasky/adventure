import { computeNextRunAt, formatInstantInZone, parseScheduleSpec, type ScheduleSpec } from "../run/schedule-spec.js";
import type { RunStore, ScheduleExpiryRow } from "../run/run-store.js";

/** 2b-ii §5.5: the expiry pattern on schedule-born runs and the code-built time shift. */
export const SCHEDULE_HINT_MIN = 2;
const DAY_MS = 24 * 60 * 60 * 1000;
export interface ScheduleHint { schedule_id: string; hour: number; dates: string[] }

const localHour = (iso: string, tz: string): number => Number(formatInstantInZone(iso, tz).slice(11, 13));
const localDate = (iso: string, tz: string): string => formatInstantInZone(iso, tz).slice(0, 10);

/** The median local hour of the instants; an even count takes the later middle (ties → the later hour). */
export function medianLocalHour(times: readonly string[], tz: string): number | null {
  if (times.length === 0) return null;
  const hours = times.map((t) => localHour(t, tz)).sort((a, b) => a - b);
  return hours[Math.floor(hours.length / 2)]!;
}

export function shiftSpec(spec: ScheduleSpec, hour: number): ScheduleSpec | null {
  if (spec.kind === "once") return null;
  const at = `${String(hour).padStart(2, "0")}:${spec.at.slice(3)}`;
  return spec.kind === "daily" ? { kind: "daily", at } : { kind: "weekly", day: spec.day, at };
}

/** Per capability: SCHEDULE_HINT_MIN or more expiries on runs of ONE schedule at ONE local hour within 14 days. */
export function scheduleHints(store: RunStore, now: string, tz: string): Map<string, ScheduleHint> {
  const since = new Date(Date.parse(now) - 14 * DAY_MS).toISOString();
  const by = new Map<string, ScheduleExpiryRow[]>();
  for (const e of store.listExpiredApprovalsOnSchedules(since)) {
    const k = `${e.capability}|${e.schedule_id}|${localHour(e.resolved_at, tz)}`;
    by.set(k, [...(by.get(k) ?? []), e]);
  }
  const out = new Map<string, ScheduleHint>();
  for (const [k, rows] of by) {
    if (rows.length < SCHEDULE_HINT_MIN) continue;
    const [capability, schedule_id, hour] = k.split("|") as [string, string, string];
    out.set(capability, { schedule_id, hour: Number(hour), dates: [...new Set(rows.map((r) => localDate(r.resolved_at, tz)))].sort() });
  }
  return out;
}

/** The proposal's draft: before (the row now), after (the shifted spec and its next fire); null when the spec cannot shift. */
export function scheduleDraft(store: RunStore, hint: ScheduleHint, now: string, tz: string): { draft_json: string; evidence: string } | null {
  const row = store.getScheduledTask(hint.schedule_id);
  const spec = row ? parseScheduleSpec(row.spec_json) : null;
  if (!row || !spec) return null;
  const hour_to = medianLocalHour(store.userTurnTimesSince(new Date(Date.parse(now) - 14 * DAY_MS).toISOString()), tz) ?? (hint.hour + 1) % 24;
  const shifted = shiftSpec(spec, hour_to);
  const next_run_at = shifted ? computeNextRunAt(shifted, row.tz, now) : null;
  if (!shifted || !next_run_at || hour_to === hint.hour) return null;
  const draft = { schedule_id: row.schedule_id, hour_from: hint.hour, hour_to, before: { spec_json: row.spec_json, tz: row.tz, next_run_at: row.next_run_at },
    after: { spec_json: JSON.stringify(shifted), tz: row.tz, next_run_at } };
  return { draft_json: JSON.stringify(draft), evidence: `${hint.dates.length} expiries at ${String(hint.hour).padStart(2, "0")}:00 (${hint.dates.join(", ")})` };
}
