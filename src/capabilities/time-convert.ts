import type { ToolAdapterResult } from "../tools/tool-registry.js";
import { resolveLocalTimeZone, toLocalTimes } from "../prompt/tz-convert.js";
import type { LocalTimeItem } from "../prompt/tz-convert.js";

export interface TimeConvertAdapterConfig {
  /** Inject the clock (tests). Default: the real now at call time. */
  now?: Date;
  /** Inject the local timezone (tests). Default: resolveLocalTimeZone(process.env). */
  localTz?: string;
}

/**
 * `to_local_time` capability. Converts one or more source datetimes (each with its stated
 * timezone) into Houge's local timezone plus a today/tomorrow/day-N label — the arithmetic
 * the model keeps getting wrong across the dateline. PURE compute: no I/O, no untrusted data,
 * never acts (so it is NOT in UNTRUSTED_READ_TOOLS; Dual-LLM never quarantines it). The tz
 * math lives in src/prompt/tz-convert.ts; this adapter only validates the model's input shape.
 */
export function createTimeConvertAdapter(
  config: TimeConvertAdapterConfig = {}
): (input: Record<string, unknown>) => Promise<ToolAdapterResult> {
  return async (input: Record<string, unknown>): Promise<ToolAdapterResult> => {
    const raw = input.items;
    if (!Array.isArray(raw) || raw.length === 0) {
      return { ok: false, error: "items must be a non-empty array of {when, tz}" };
    }
    // Per-item isolation: a malformed row (missing/non-string when|tz) is coerced to empty
    // strings so `toLocalTimes` reports it as a per-item `error` — one bad item never drops the
    // good conversions in the same batch. Only a non-array/empty `items` is a batch-level reject.
    const items: LocalTimeItem[] = raw.map((entry) => {
      const row = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
      return {
        when: typeof row.when === "string" ? row.when.trim() : "",
        tz: typeof row.tz === "string" ? row.tz.trim() : ""
      };
    });
    const now = config.now ?? new Date();
    const localTz = config.localTz ?? resolveLocalTimeZone(process.env);
    const results = toLocalTimes(items, now, localTz);
    return { ok: true, output: { results } };
  };
}
