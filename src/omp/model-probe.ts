import { randomUUID } from "node:crypto";
import type { LlmErrorKind } from "../llm/audit.js";
import { oneShotAdapter, type OneShotAdapterOptions } from "../llm/registry.js";
import type { LlmResult } from "../llm/types.js";
import type { ModelProbeResult, RunStore } from "../run/run-store.js";
import { parseModelString } from "./model-string.js";
import type { OmpConfig } from "./omp-config.js";
import { classifyOmpError } from "./omp-frames.js";

/**
 * The check before a tier adopts a model (spec 2026-11-02 §4.2): one short prompt through the existing one-shot seat
 * (src/llm/providers/omp.ts, unchanged): one leg, --no-session --no-tools, the tick seats' child env and TMPDIR, 60 s.
 * Pass = ok and a non-empty reply (no exact match, as the contract probe). The reply is never stored or logged.
 */
export const PROBE_PROMPT = "Reply with exactly OK.";
export const PROBE_DEADLINE_MS = 60_000;
export interface ProbeOutcome { result: ModelProbeResult; kind: string }
export type ProbeFn = (selector: string, signal?: AbortSignal) => Promise<ProbeOutcome | "aborted">;

const KINDS: ReadonlySet<string> = new Set<LlmErrorKind>(["auth", "model_missing", "timeout", "spawn", "transport", "parse", "other", "quota",
  "model_refusal", "aborted", "wall_collapse", "shutdown", "rate_limited", "overloaded", "malformed_question"]);

/** Plan P6: spawnOneShot ends its failure text with `<provider/id>: <kind>` (omp.ts:164,167); else classify the text. */
export function probeKindOf(error: string): string {
  const m = /: ([a-z_]+)$/.exec(error);
  return m && KINDS.has(m[1]!) ? m[1]! : classifyOmpError(error);
}

export function probeOutcomeOf(r: LlmResult): ProbeOutcome | "aborted" {
  if (r.ok) return r.answer.trim().length > 0 ? { result: "pass", kind: "ok" } : { result: "inconclusive", kind: "empty" };
  if (r.aborted) return "aborted";
  if (r.unavailable) return { result: "inconclusive", kind: "unavailable" };
  const kind = probeKindOf(r.error);
  return { result: kind === "model_missing" ? "model_missing" : "inconclusive", kind };
}

/** The daemon's probe (plan P7): audited per leg under `probe:<uuid>`, role `probe`. `opts.versionCheck`: tests only. */
export function ompProbe(store: RunStore, cfg: OmpConfig, opts: { versionCheck?: OneShotAdapterOptions["versionCheck"] } = {}): ProbeFn {
  return async (selector, signal) => {
    const seat = oneShotAdapter(store, cfg, { correlation_id: `probe:${randomUUID()}`, role: "probe" }, undefined,
      { chain: [parseModelString(selector)], deadlineMs: PROBE_DEADLINE_MS, ...(opts.versionCheck ? { versionCheck: opts.versionCheck } : {}) });
    try {
      return probeOutcomeOf(await seat.answer({ question: PROBE_PROMPT, ...(signal ? { signal } : {}) }));
    } catch (e) {
      console.error(`[model-probe] probe threw: ${e instanceof Error ? e.name : "non-Error"}`);
      return { result: "inconclusive", kind: "threw" };
    }
  };
}
