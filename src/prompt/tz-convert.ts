/**
 * Deterministic timezone conversion for the loop (the `to_local_time` tool). The model
 * anchors "today/tomorrow" in its LOCAL timezone (temporalContext) but reads every source
 * time in the source/venue timezone — and it botches the arithmetic across the dateline
 * (a "noon ET" fixture is a day-after in Sydney). This module moves that arithmetic OUT of
 * the model and into code: given (wall-clock string, source tz) pairs it computes the
 * absolute instant, renders it in the local timezone, and — crucially — computes the
 * today/tomorrow/day-N label by comparing LOCAL CALENDAR DATES. Pure, zero-dep (`Intl`
 * only), never throws: a bad tz or unparseable time sets a per-item `error` and the other
 * items still resolve.
 */

/** One requested conversion: a wall-clock datetime and the timezone it is stated in. */
export interface LocalTimeItem {
  when: string;
  tz: string;
}

/** The resolved conversion. On success `local` + `relative_day` are set; on failure `error` is. */
export interface LocalTimeResult {
  when: string;
  tz: string;
  local?: string;
  relative_day?: string;
  error?: string;
}

const TIME_ZONE_ALIASES: Record<string, string> = {
  utc: "UTC",
  gmt: "UTC",
  et: "America/New_York",
  edt: "America/New_York",
  est: "America/New_York",
  "eastern time": "America/New_York",
  "us eastern": "America/New_York",
  "u s eastern": "America/New_York",
  ct: "America/Chicago",
  cdt: "America/Chicago",
  cst: "America/Chicago",
  "central time": "America/Chicago",
  "us central": "America/Chicago",
  "u s central": "America/Chicago",
  mt: "America/Denver",
  mdt: "America/Denver",
  mst: "America/Denver",
  "mountain time": "America/Denver",
  "us mountain": "America/Denver",
  "u s mountain": "America/Denver",
  pt: "America/Los_Angeles",
  pdt: "America/Los_Angeles",
  pst: "America/Los_Angeles",
  "pacific time": "America/Los_Angeles",
  "us pacific": "America/Los_Angeles",
  "u s pacific": "America/Los_Angeles",
  // Bare "BST" is a valid ICU zone id — for BANGLADESH Standard Time (+6). Football sources
  // mean British Summer Time, so it MUST be aliased to Europe/London BEFORE Intl sees it
  // (caught live 07-07: "20:00 BST" converted via Asia/Dhaka, 5h off).
  bst: "Europe/London",
  "british summer time": "Europe/London",
  aest: "Australia/Sydney",
  aedt: "Australia/Sydney"
};

function normalizeTimeZone(tz: string): string {
  const key = tz
    .trim()
    .toLowerCase()
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ");
  return TIME_ZONE_ALIASES[key] ?? tz;
}

/** Resolve common source labels, then require a zone `Intl` accepts. Exported so the
 *  to_local_time adapter can report the SAME zone `toLocalTimes` actually converts into
 *  (including its UTC fallback) on the result envelope (R1). */
export function resolveTimeZone(tz: string): string | undefined {
  const candidate = normalizeTimeZone(tz);
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: candidate });
    return candidate;
  } catch {
    return undefined;
  }
}

/** Wall-clock components pulled off an instant rendered in a timezone (en-CA, 00–23 hours). */
function tzParts(instant: Date, tz: string): Record<string, string> {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  return Object.fromEntries(fmt.formatToParts(instant).map((p) => [p.type, p.value]));
}

/**
 * The offset (ms) of `tz` at `instant`: render the instant in `tz`, read the wall-clock
 * back, interpret those components AS UTC, and subtract the instant. Positive = tz is ahead
 * of UTC (e.g. Sydney +10h). The offset depends on the date (DST), so callers evaluate it at
 * the candidate instant, not once globally.
 */
function offsetMs(instant: Date, tz: string): number {
  const p = tzParts(instant, tz);
  const asUTC = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return asUTC - instant.getTime();
}

const WHEN_PATTERN = /^\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/;

/**
 * Invert "wall-clock in tz" → absolute instant. `Intl` only formats instant → wall-clock,
 * so we solve the fixed point t = targetWallAsUTC − offset(t): guess the offset at the naive
 * instant, correct once at the corrected instant. Two evaluations converge everywhere except
 * the ambiguous hour of a DST fall-back, where it lands on a valid instant of that wall time.
 * This is DST-correct because the offset is measured AT the candidate date, not assumed.
 *
 * Exported (B10b) so the scheduler's next-run math (src/run/schedule-spec.ts) reuses this
 * solver instead of reimplementing DST arithmetic. Callers pass an ALREADY-RESOLVED IANA
 * zone (resolveTimeZone) — a garbage zone makes Intl throw.
 */
export function wallClockToInstant(when: string, tz: string): Date | undefined {
  const m = WHEN_PATTERN.exec(when);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s] = m;
  const [Y, Mo, D, H, Mi, S] = [Number(y), Number(mo), Number(d), Number(h), Number(mi), s ? Number(s) : 0];
  // Reject out-of-range wall-clock components (e.g. "24:00", "13-40", minute 70) instead of
  // letting Date.UTC silently roll them into a plausible-but-wrong instant — a garbage source
  // time must surface as a per-item error, not a confidently-wrong conversion.
  if (Mo < 1 || Mo > 12 || D < 1 || D > 31 || H > 23 || Mi > 59 || S > 59) return undefined;
  const target = Date.UTC(Y, Mo - 1, D, H, Mi, S);
  if (!Number.isFinite(target)) return undefined;
  // Catch non-existent calendar dates that Date.UTC overflows (e.g. Feb 30 → Mar 2).
  const back = new Date(target);
  if (back.getUTCMonth() !== Mo - 1 || back.getUTCDate() !== D) return undefined;
  let off = offsetMs(new Date(target), tz);
  off = offsetMs(new Date(target - off), tz);
  return new Date(target - off);
}

/** The local calendar date of `instant` in `tz`, as a whole-day count (for day diffing). */
function localDayNumber(instant: Date, tz: string): number {
  const p = tzParts(instant, tz);
  return Math.floor(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) / 86_400_000);
}

/** Map a signed whole-day difference (item − today) to a relative-day label. */
function relativeDayLabel(dayDiff: number): string {
  if (dayDiff === 0) return "today";
  if (dayDiff === 1) return "tomorrow";
  if (dayDiff === -1) return "yesterday";
  if (dayDiff > 1) return `in ${dayDiff} days`;
  return `${-dayDiff} days ago`;
}

/**
 * Convert each `{when, tz}` (a wall-clock time in its stated timezone) into `localTz`, with a
 * today/tomorrow/day-N label computed from LOCAL calendar dates relative to `now`. `now` and
 * `localTz` are injected (tests) or default to the real clock + runtime tz at the call site.
 * Never throws: a bad tz or unparseable `when` sets `error` on that item; the rest resolve.
 */
export function toLocalTimes(items: LocalTimeItem[], now: Date, localTz: string): LocalTimeResult[] {
  // Honor the never-throws contract even for a garbage `localTz` (a bad HOUGE_TIMEZONE reaching
  // a direct caller): fall back to UTC. The production path (resolveLocalTimeZone) already
  // rejects an invalid override before it gets here, so this is a belt-and-braces guard.
  const zone = resolveTimeZone(localTz) ?? "UTC";
  const todayDay = localDayNumber(now, zone);
  return items.map((item) => {
    const when = String(item.when ?? "");
    const tz = String(item.tz ?? "");
    const sourceZone = resolveTimeZone(tz);
    if (!sourceZone) {
      return { when, tz, error: `invalid timezone: ${tz}` };
    }
    let instant: Date | undefined;
    try {
      instant = wallClockToInstant(when, sourceZone);
    } catch {
      // An invalid `tz` makes Intl.DateTimeFormat throw a RangeError.
      return { when, tz, error: `invalid timezone: ${tz}` };
    }
    if (!instant) {
      return { when, tz, error: `unparseable datetime: ${when}` };
    }
    const p = tzParts(instant, zone);
    const local = `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
    const relative_day = relativeDayLabel(localDayNumber(instant, zone) - todayDay);
    return { when, tz, local, relative_day };
  });
}

/** Whether `to_local_time` is armed (`HOUGE_TIME_TOOL_ENABLED`). DEFAULT OFF — the tool is
 *  unlisted (unreachable) unless this is truthy (armed-listing, like http_fetch).
 *  Accepts 1/true/yes/on. */
export function resolveTimeToolEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.HOUGE_TIME_TOOL_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/** The local timezone the loop converts INTO: `HOUGE_TIMEZONE` override, else the runtime tz
 *  (Australia/Sydney on the daemon). IANA name; the converter validates it via Intl. */
export function resolveLocalTimeZone(env: NodeJS.ProcessEnv): string {
  const override = env.HOUGE_TIMEZONE?.trim();
  const runtime = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  // A garbage override is ignored (fall back to the runtime tz) rather than propagated into
  // the converter, where it would surface as an error on every item.
  const resolvedOverride = override && override.length > 0 ? resolveTimeZone(override) : undefined;
  if (resolvedOverride) return resolvedOverride;
  return runtime;
}
