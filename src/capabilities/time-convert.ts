import type { ToolAdapterResult } from "../tools/tool-registry.js";
import { resolveLocalTimeZone, toLocalTimes } from "../prompt/tz-convert.js";
import type { LocalTimeItem } from "../prompt/tz-convert.js";

export interface TimeConvertAdapterConfig {
  /** Inject the clock (tests). Default: the real now at call time. */
  now?: Date;
  /** Inject the local timezone (tests). Default: resolveLocalTimeZone(process.env). */
  localTz?: string;
  /** Inject the env used by the evidence gate (tests). Default: process.env for the production no-arg adapter. */
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
  const evidenceEnv = config === undefined ? process.env : adapterConfig.env ?? {};
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
      return {
        when: typeof row.when === "string" ? row.when.trim() : "",
        tz: typeof row.tz === "string" ? row.tz.trim() : "",
        zone_evidence: typeof row.zone_evidence === "string" ? row.zone_evidence.trim() : ""
      };
    });
    const items: LocalTimeItem[] = rawItems.map((item) => ({ when: item.when, tz: item.tz }));
    const evidenceEnabled = adapterConfig.tzEvidenceEnabled ?? resolveTzEvidenceEnabled(evidenceEnv);
    const now = adapterConfig.now ?? new Date();
    const localTz = adapterConfig.localTz ?? resolveLocalTimeZone(process.env);
    const results = toLocalTimes(items, now, localTz);
    if (evidenceEnabled) {
      const priorDigests = readPriorDigests(input[TIME_CONVERT_PRIOR_DIGESTS_FIELD]);
      return {
        ok: true,
        output: {
          results: results.map((result, i) => {
            if ("error" in result) return result;
            return validateZoneEvidence(rawItems[i]!.zone_evidence, rawItems[i]!.tz, priorDigests)
              ? result
              : zoneEvidenceError(rawItems[i]!);
          })
        }
      };
    }
    return { ok: true, output: { results } };
  };
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
