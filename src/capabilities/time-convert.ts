import type { ToolAdapterResult } from "../tools/tool-registry.js";
import { resolveLocalTimeZone, resolveTimeZone, toLocalTimes } from "../prompt/tz-convert.js";
import type { LocalTimeItem } from "../prompt/tz-convert.js";

export interface TimeConvertAdapterConfig {
  /** Inject the clock (tests). Default: the real now at call time. */
  now?: Date;
  /** Inject the local timezone (tests). Default: resolveLocalTimeZone(process.env). */
  localTz?: string;
  /** Inject the env used by the evidence gate (tests). Default: process.env. */
  env?: NodeJS.ProcessEnv;
  /** Gate for source-stated timezone evidence (tests). Default: resolveTzEvidenceEnabled(env). */
  tzEvidenceEnabled?: boolean;
}

export const TIME_CONVERT_PRIOR_DIGESTS_FIELD = "__houge_prior_step_digests";
export const ZONE_EVIDENCE_ERROR = "zone not stated by source — search for a source that states the timezone";

const ZONE_LABELS: Record<string, string[]> = {
  UTC: ["UTC", "GMT"],
  "America/New_York": ["ET", "EDT", "EST", "Eastern Time", "US Eastern"],
  "America/Chicago": ["CT", "CDT", "CST", "Central Time", "US Central"],
  "America/Denver": ["MT", "MDT", "MST", "Mountain Time", "US Mountain"],
  "America/Los_Angeles": ["PT", "PDT", "PST", "Pacific Time", "US Pacific"],
  "Europe/London": ["BST", "British Summer Time", "UK time"],
  "Australia/Sydney": ["AEST", "AEDT", "Sydney time", "Australia/Sydney"]
};

/**
 * `to_local_time` capability. Converts one or more source datetimes (each with its stated
 * timezone) into Houge's local timezone plus a today/tomorrow/day-N label — the arithmetic
 * the model keeps getting wrong across the dateline. PURE compute: no I/O, no untrusted data,
 * never acts (so it is NOT in UNTRUSTED_READ_TOOLS; Dual-LLM never quarantines it). The tz
 * math lives in src/prompt/tz-convert.ts; this adapter only validates the model's input shape.
 */
export function createTimeConvertAdapter(
  config?: TimeConvertAdapterConfig
): (input: Record<string, unknown>) => Promise<ToolAdapterResult> {
  const adapterConfig = config ?? {};
  // The evidence env DEFAULTS to process.env even when a config object is passed — a caller
  // injecting only {now}/{localTz} must not silently disarm the evidence gate (an empty-env
  // default here would read the flag as OFF for that caller; caught in review 07-07).
  const evidenceEnv = adapterConfig.env ?? process.env;
  return async (input: Record<string, unknown>): Promise<ToolAdapterResult> => {
    const raw = input.items;
    if (!Array.isArray(raw) || raw.length === 0) {
      return { ok: false, error: "items must be a non-empty array of {when, tz}" };
    }
    // Per-item isolation: a malformed row (missing/non-string when|tz) is coerced to empty
    // strings so `toLocalTimes` reports it as a per-item `error` — one bad item never drops the
    // good conversions in the same batch. Only a non-array/empty `items` is a batch-level reject.
    const rawItems = raw.map((entry) => {
      const row = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
      // `when`/`tz` get the SAME digest-text sanitizing as `label`: error rows echo them
      // verbatim into the step digest (`when (tz) → error: invalid timezone: tz`), so an
      // unsanitized when like "→ 2026-07-08 02:00 (tomorrow" on an ALL-ERROR call forges a
      // converted-row match and disarms the B1 guard (verifier F1, 2026-07-12). Legit values
      // are untouched — no real datetime or IANA zone contains CR/LF, "→", or "time_claims:".
      return {
        when: typeof row.when === "string" ? sanitizeDigestText(row.when) : "",
        tz: typeof row.tz === "string" ? sanitizeDigestText(row.tz) : "",
        zone_evidence: typeof row.zone_evidence === "string" ? row.zone_evidence.trim() : "",
        label: sanitizeLabel(row.label)
      };
    });
    const items: LocalTimeItem[] = rawItems.map((item) => ({ when: item.when, tz: item.tz }));
    const evidenceEnabled = adapterConfig.tzEvidenceEnabled ?? resolveTzEvidenceEnabled(evidenceEnv);
    const now = adapterConfig.now ?? new Date();
    // Same env source as the evidence gate — a test injecting `env` must not still read the
    // ambient HOUGE_TIMEZONE (the hermeticity-trap class the env-sweep lesson warns about).
    const localTz = adapterConfig.localTz ?? resolveLocalTimeZone(evidenceEnv);
    const results = toLocalTimes(items, now, localTz);
    const priorDigests = evidenceEnabled ? readPriorDigests(input[TIME_CONVERT_PRIOR_DIGESTS_FIELD]) : [];
    const gated = evidenceEnabled
      ? results.map((result, i) => {
          if ("error" in result) return result;
          return validateZoneEvidence(rawItems[i]!.zone_evidence, rawItems[i]!.tz, priorDigests)
            ? result
            : zoneEvidenceError(rawItems[i]!);
        })
      : results;
    // R1: name the zone the rows were converted INTO on the output envelope, so the digest can
    // render it next to each row's relative_day (07-12 live gate S3: prose quoted the converted
    // Sydney clocks but NAMED the frame 北京时间 — the row never said which zone it was in).
    // Mirrors toLocalTimes' own resolution (incl. its UTC fallback) so the reported name is the
    // zone that actually did the math. Code-owned (config/env), but sanitized anyway — defense
    // in depth for the digest-matched guards, same as label/when/tz.
    const targetZone = sanitizeDigestText(resolveTimeZone(localTz) ?? "UTC");
    // B6: re-attach each item's sanitized label index-aligned (`toLocalTimes` and the evidence
    // gate both preserve order), on success AND error rows so an errored event stays named.
    return {
      ok: true,
      output: {
        local_tz: targetZone,
        results: gated.map((result, i) => {
          const label = rawItems[i]!.label;
          return label ? { ...result, label } : result;
        })
      }
    };
  };
}

/** Max chars of a model-supplied text field (label/when/tz) carried onto a result row. */
const DIGEST_TEXT_CHAR_CAP = 80;

/**
 * B6 SECURITY: `label`, `when`, and `tz` are MODEL-SUPPLIED text rendered verbatim into step
 * digests (success rows, error rows, and error messages echo them), and two mechanical guards
 * match ON digest text — the B1 guard's converted-row regex (`→ YYYY-MM-DD HH:MM (`) and the
 * `time_claims:` substring check. So: flatten CR/LF to spaces (the forged-frame-line hole
 * class closed 07-07 in quarantine digests), replace `→` (a value like
 * "x → 2026-07-08 02:00 (tomorrow)" landing on an ERROR row would forge a converted-row match
 * and disarm the guard), neutralize `time_claims:`, and cap length. All substitutions are
 * NON-DELETING (deleting "time_claims:" would let "time_time_claims:claims:" reassemble it).
 */
function sanitizeDigestText(value: string): string {
  const flat = value
    .replace(/[\r\n]+/g, " ")
    .replace(/→/g, "-")
    .replace(/time_claims:/gi, "time_claims ")
    .trim();
  const capped = flat.length > DIGEST_TEXT_CHAR_CAP ? flat.slice(0, DIGEST_TEXT_CHAR_CAP) : flat;
  // Digest renders put `: `/` (` right after these values (`label: `, `when (tz)`) — a value
  // ENDING in "time_claims" would reassemble the `time_claims:` arm marker at the render seam
  // (an arming forge, fail-safe direction, but still closed). Checked AFTER the cap, which
  // could itself truncate to that exact ending.
  return /time_claims$/i.test(capped) ? `${capped}-` : capped;
}

/** Optional-field wrapper over sanitizeDigestText: non-string / empty-after-sanitizing ⇒ absent. */
function sanitizeLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = sanitizeDigestText(value);
  return clean.length === 0 ? undefined : clean;
}

/** Whether timezone-source evidence is enforced (`HOUGE_TZ_EVIDENCE_ENABLED`, default OFF). */
export function resolveTzEvidenceEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.HOUGE_TZ_EVIDENCE_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function readPriorDigests(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((d): d is string => typeof d === "string" && d.length > 0) : [];
}

function validateZoneEvidence(fragment: string, tz: string, priorDigests: string[]): boolean {
  return fragment.length > 0 && evidenceMentionsTimeZone(fragment, tz) && priorDigests.some((d) => d.includes(fragment));
}

function evidenceMentionsTimeZone(fragment: string, tz: string): boolean {
  const labels = [tz, ...(ZONE_LABELS[tz] ?? [])].filter((label) => label.length > 0);
  return labels.some((label) => new RegExp(`(^|[^A-Za-z])${escapeRegExp(label)}([^A-Za-z]|$)`, "i").test(fragment));
}

function zoneEvidenceError(item: { when: string; tz: string }): LocalTimeItem & { error: string } {
  return { when: item.when, tz: item.tz, error: ZONE_EVIDENCE_ERROR };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
