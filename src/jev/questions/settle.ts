import type { NoulQuestion } from "./types.js";

/** 2b-i §3.3: four noul questions over the redacted reply, Paco's redacted message and a code-built tool summary. Frozen: the bar hashes them. */
export const SETTLE_CLAIMS_DONE: NoulQuestion = { id: "settle_claims_done", type: "noul", instructions: "The field `reply` claims the task Paco asked for in `paco_message` is done or completed." };
export const SETTLE_UNVERIFIED: NoulQuestion = { id: "settle_unverified", type: "noul", instructions: "The assistant acted or edited something (see `tools`) but `reply` shows no verification of the result." };
export const SETTLE_PROMISE: NoulQuestion = { id: "settle_promise", type: "noul", instructions: "The field `reply` ends on a promise of further work the assistant will do next, such as 'next I'll' or '接下来我会'." };
export const SETTLE_ASKS_PERMISSION: NoulQuestion = { id: "settle_asks_permission", type: "noul", instructions: "The field `reply` asks permission for work that `paco_message` already asked the assistant to do." };
export const SETTLE_QUESTIONS: readonly NoulQuestion[] = [SETTLE_CLAIMS_DONE, SETTLE_UNVERIFIED, SETTLE_PROMISE, SETTLE_ASKS_PERMISSION];
/** Question id → the entry's reason code. */
export const SETTLE_QUESTION_REASON: Readonly<Record<string, "jev_claims_done" | "jev_unverified" | "jev_promise" | "jev_asks_permission">> = {
  settle_claims_done: "jev_claims_done", settle_unverified: "jev_unverified", settle_promise: "jev_promise", settle_asks_permission: "jev_asks_permission"
};
