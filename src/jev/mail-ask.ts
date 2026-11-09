import type { FallbackReason } from "../decisions/types.js";
import type { MailJevState } from "../mail/envelope.js";
import type { RunStore } from "../run/run-store.js";
import { decide, type SkipReason } from "./decide.js";
import { langOf } from "./intent-question.js";
import { choiceAnswer, type JevChoiceAnswer, type JevRequest, type JevResult } from "./jev-client.js";
import { MAIL_KIND, MAIL_URGENCY } from "./questions/mail.js";

/** mail.triage's own Jev call (spec 2026-11-09 §3.5): two choice questions, decision point `mail`, run-less, no jev_decisions row (as improve). */
export const MAIL_THRESHOLD_VERSION = "2026-11-09.1";
export type MailAsk = { urgency: JevChoiceAnswer; kind: JevChoiceAnswer | undefined; model: string } | { failed: FallbackReason; reason?: SkipReason };

export async function askMail(i: { state: MailJevState; client: (r: JevRequest) => Promise<JevResult>; store: RunStore; now?: () => Date }): Promise<MailAsk> {
  const d = await decide({ point: "mail", run_id: null, state: i.state as unknown as Record<string, unknown>, questions: [MAIL_URGENCY, MAIL_KIND],
    lang: langOf(`${i.state.subject ?? ""} ${i.state.snippet ?? ""}`), client: i.client, store: i.store, thresholdVersion: MAIL_THRESHOLD_VERSION, ...(i.now ? { now: i.now } : {}) });
  if (d.status === "skipped") return { failed: fallbackOf(d.reason), reason: d.reason };
  const urgency = choiceAnswer(d.answers[MAIL_URGENCY.id]);
  if (!urgency) return { failed: "parse" };
  return { urgency, kind: choiceAnswer(d.answers[MAIL_KIND.id]), model: d.model };
}

function fallbackOf(r: SkipReason): FallbackReason {
  if (r === "timeout") return "timeout";
  if (r === "parse" || r === "malformed_question") return "parse";
  return "outage";
}
