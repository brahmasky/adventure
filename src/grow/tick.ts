import { redactForImprove } from "../decisions/egress.js";
import { errorCode } from "../domain/error-code.js";
import type { OneShotInput } from "../llm/providers/omp.js";
import type { LlmResult } from "../llm/types.js";
import type { ModelString } from "../omp/model-string.js";
import type { GrowStagedRow, RunStore } from "../run/run-store.js";
import { type GrowFields, parseSkillFile } from "./checks.js";
import { resolveGrowEnabled } from "./flags.js";
import { type ReviewOutcome, runReview } from "./review.js";
import type { GrowService } from "./service.js";

export const GROW_CLAIM_STALE_MS = 10 * 60_000;
/** Wait after outage 1, 2, 3; the fourth ends `review_unavailable`. */
export const GROW_RETRY_AFTER_MS = [3_600_000, 21_600_000, 86_400_000] as const;
export interface GrowTickDeps { store: RunStore; svc: GrowService; env: NodeJS.ProcessEnv; now: string; signal: AbortSignal;
  chain: () => ModelString[]; spawn: (input: OneShotInput) => Promise<LlmResult>; exemplar: () => Promise<string>; settled: (run_id: string) => boolean }
const plus = (iso: string, ms: number): string => new Date(Date.parse(iso) + ms).toISOString();

/** One poll cycle's grow work (spec §5.4, §5.8): finish publishes, run Paco's queued requests, free stale claims, then at most one review. */
export async function runGrowTick(d: GrowTickDeps): Promise<{ requests: number; reviewed: number | null }> {
  if (!(await d.svc.ensureZone())) return { requests: 0, reviewed: null };
  await d.svc.reconcile(resolveGrowEnabled(d.env));
  const requests = await d.svc.runRequests();
  d.store.releaseStaleGrowClaims(plus(d.now, -GROW_CLAIM_STALE_MS));
  if (!resolveGrowEnabled(d.env) || d.signal.aborted) return { requests, reviewed: null };
  const row = d.store.dueGrowReviews(d.now).find((r) => r.run_id === null || d.settled(r.run_id));
  if (!row || !d.store.claimGrowReview(row.id, d.now)) return { requests, reviewed: null };
  await reviewOne(d, row);
  return { requests, reviewed: row.id };
}

async function reviewOne(d: GrowTickDeps, row: GrowStagedRow): Promise<void> {
  const attempt = row.attempts + 1;   // the row was read before the claim, which bumped the stored count
  const families = row.run_id ? d.store.runAuthorFamilies(row.run_id) : { families: [], unknown: true };
  const reasons = d.store.listGrowUndoReasons(row.name).map((r) => r.reason);
  const base = { author_families: families.families, undo_reasons_n: reasons.length };
  let outcome: ReviewOutcome;
  try {
    outcome = await runReview({
      fields: JSON.parse(row.fields_json) as GrowFields, previous: parseSkillFile((await d.svc.zone.readHead(row.name)) ?? ""),
      exemplar: await d.exemplar(), index: d.svc.indexBlock() ?? "", undoReasons: reasons, authorFamilies: families, chain: d.chain(),
      correlationId: `grow_review:${row.id}:${attempt}`, signal: d.signal, scrub: (s) => redactForImprove(d.store, s)
    }, { spawn: d.spawn });
  } catch (error) {
    console.error(`[grow] review: dependency_threw ${errorCode(error)}`);   // a code, never the error's text
    outcome = { kind: "unavailable", reason: "seat_failed" };
  }
  if (outcome.kind === "verdict") {
    d.svc.recordReview(row.id, { ...base, pass: outcome.verdict.pass, findings: outcome.verdict.findings, reviewer_model: outcome.model, input_hash: outcome.inputHash, code: outcome.verdict.pass ? "review_passed" : "review_failed" });
    if (outcome.verdict.pass) await d.svc.publishStaged(row.id);   // any answer but 'published' leaves the row 'approved'; the next poll's reconcile publishes it
    return;
  }
  if (d.signal.aborted) { d.store.unclaimGrowReview(row.id); return; }
  const wait = GROW_RETRY_AFTER_MS[attempt - 1];
  if (wait !== undefined) { d.store.patchGrowStaged(row.id, { claimed_at: null, next_attempt_at: plus(d.now, wait) }, d.now); return; }
  d.svc.recordReview(row.id, { ...base, pass: false, findings: [], reviewer_model: null, input_hash: null, code: "review_unavailable" });
}
