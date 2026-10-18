import type { FallbackReason } from "../decisions/types.js";
import type { RunStore } from "../run/run-store.js";
import { decide, type SkipReason } from "./decide.js";
import type { Lang } from "./intent-question.js";
import type { JevAnswer, JevRequest, JevResult } from "./jev-client.js";
import { buildTreeState, TREE_MEMORY_KIND, type TreeStateInput } from "./questions/tree.js";

/**
 * memory.kind's own Jev call (spec 2026-10-15 Rev 3 §3): the tree's state shape, one question, decision point
 * `memory_kind`. Never part of the front-door request. No jev_decisions row is written: the memory.kind ladder row carries
 * the verdict, its p and any failure (Spec deviation D14). An outage opens the existing Jev incident inside `decide`.
 */
export const MEMORY_KIND_THRESHOLD_VERSION = "2026-10-17.1";
export type MemoryKindAsk = { answer: JevAnswer } | { failed: FallbackReason };

export async function askMemoryKind(i: {
  run_id: string; state: TreeStateInput; lang: Lang; client: (r: JevRequest) => Promise<JevResult>; store: RunStore; redact?: (s: string) => string; now?: () => Date;
}): Promise<MemoryKindAsk> {
  const built = buildTreeState(i.state, i.redact, [TREE_MEMORY_KIND]);
  if (!built.ok) return { failed: "budget" }; // too large to send: the distill decides
  const d = await decide({ point: "memory_kind", run_id: i.run_id, state: built.state, questions: [TREE_MEMORY_KIND], lang: i.lang, client: i.client,
    store: i.store, thresholdVersion: MEMORY_KIND_THRESHOLD_VERSION, ...(i.now ? { now: i.now } : {}) });
  if (d.status === "skipped") return { failed: fallbackOf(d.reason) };
  const answer = d.answers[TREE_MEMORY_KIND.id];
  return answer ? { answer } : { failed: "parse" };
}

/** The ladder's closed failure names: a timeout and a parse are told apart (the live gate fails on either); the rest are outages. */
function fallbackOf(r: SkipReason): FallbackReason {
  if (r === "timeout") return "timeout";
  if (r === "parse" || r === "malformed_question") return "parse";
  return "outage";
}
