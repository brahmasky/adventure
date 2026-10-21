import type { FallbackReason } from "../decisions/types.js";
import type { ImproveJevState } from "../decisions/entries/improve-route.js";
import type { RunStore } from "../run/run-store.js";
import { decide, type SkipReason } from "./decide.js";
import { langOf } from "./intent-question.js";
import { choiceAnswer, type JevChoiceAnswer, type JevRequest, type JevResult } from "./jev-client.js";
import { IMPROVE_TARGET } from "./questions/improve.js";

/** improve.route's own Jev call (2b-ii §4.3): one choice question, decision point `improve`, run-less (the tick has no run), 1.5 s, no re-ask, no jev_decisions row (as memory_kind). */
export const IMPROVE_THRESHOLD_VERSION = "2026-10-21.1";
export type ImproveAsk = { answer: JevChoiceAnswer; model: string } | { failed: FallbackReason };

export async function askImprove(i: { state: ImproveJevState; client: (r: JevRequest) => Promise<JevResult>; store: RunStore; now?: () => Date }): Promise<ImproveAsk> {
  const d = await decide({ point: "improve", run_id: null, state: i.state as unknown as Record<string, unknown>, questions: [IMPROVE_TARGET], lang: langOf(i.state.paco_text),
    client: i.client, store: i.store, thresholdVersion: IMPROVE_THRESHOLD_VERSION, ...(i.now ? { now: i.now } : {}) });
  if (d.status === "skipped") return { failed: fallbackOf(d.reason) };
  const answer = choiceAnswer(d.answers[IMPROVE_TARGET.id]);
  return answer ? { answer, model: d.model } : { failed: "parse" };
}

function fallbackOf(r: SkipReason): FallbackReason {
  if (r === "timeout") return "timeout";
  if (r === "parse" || r === "malformed_question") return "parse";
  return "outage";
}
