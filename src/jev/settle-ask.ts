import type { FallbackReason } from "../decisions/types.js";
import type { SettleJevState } from "../decisions/settle-state.js";
import type { RunStore } from "../run/run-store.js";
import { decide, type SkipReason } from "./decide.js";
import { langOf } from "./intent-question.js";
import type { JevRequest, JevResult } from "./jev-client.js";
import { SETTLE_QUESTIONS } from "./questions/settle.js";
export { SETTLE_QUESTIONS, SETTLE_QUESTION_REASON } from "./questions/settle.js";

/** turn.settle's own Jev call (2b-i §3.3): one request, four noul questions, decision point `settle`, 1.5 s, no re-ask. */
export const SETTLE_THRESHOLD_VERSION = "2026-10-20.1";
export type SettleAsk = { answers: Record<string, number>; model: string } | { failed: FallbackReason };
export { settleJevState } from "../decisions/settle-state.js";

/**
 * Senior plan W: this file is self-writable (src/jev is not protected, as memory-kind-ask.ts); it never sees the raw
 * `SettleState`. The caller hands it the Jev copy built by the protected `settleJevState` (src/decisions/settle-state.ts).
 */
export async function askSettle(i: { run_id: string; state: SettleJevState; client: (r: JevRequest) => Promise<JevResult>; store: RunStore; boundMs?: number; now?: () => Date }): Promise<SettleAsk> {
  const d = await decide({ point: "settle", run_id: i.run_id, state: i.state, questions: SETTLE_QUESTIONS, lang: langOf(i.state.reply.slice(0, 2_000)),
    client: i.client, store: i.store, thresholdVersion: SETTLE_THRESHOLD_VERSION, ...(i.boundMs !== undefined ? { boundMs: i.boundMs } : {}), ...(i.now ? { now: i.now } : {}) });
  if (d.status === "skipped") return { failed: fallbackOf(d.reason) };
  const answers: Record<string, number> = {};
  for (const q of SETTLE_QUESTIONS) { const a = d.answers[q.id]; if (a?.type !== "noul") return { failed: "parse" }; answers[q.id] = a.noul; }
  return { answers, model: d.model };
}

function fallbackOf(r: SkipReason): FallbackReason {
  if (r === "timeout") return "timeout";
  if (r === "parse" || r === "malformed_question") return "parse";
  return "outage";
}
