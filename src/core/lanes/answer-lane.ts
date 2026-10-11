import { safeReason } from "../../domain/error-code.js";
import type { ModelString } from "../../omp/model-string.js";
import { sanitizeLaneText } from "./lane-card.js";
import { catchUpLine, renderLanePrompt } from "./lane-compose.js";
import { fall, type AnswerLaneDeps, type LaneFall, type LaneInput, type LaneResult } from "./lane-types.js";

/** Stage B §4: the compose bound on the user's path (whatever is left of the lane's budget, at most this). */
export const LANE_COMPOSE_MS = 45_000;
/** Every wording the one-shot path emits for a cut leg: `spawnOneShot` writes "timed out"; the chain's aggregate names the audited kind, `timeout`, or `deadline`. */
const TIMED_OUT = /\b(timed out|timeout|deadline)\b/i;

/** The answer lane (stage B §4): render, one compose, done. Never throws: an unexpected exception is `lane_threw`. */
export async function runAnswerLane(i: LaneInput, d: AnswerLaneDeps): Promise<LaneResult> {
  try {
    return await answerSteps(i, d);
  } catch (e) {
    console.error(`answer lane: threw on ${i.run_id}: ${safeReason(e)}`);
    return fall("lane_threw");
  }
}

async function answerSteps(i: LaneInput, d: AnswerLaneDeps): Promise<LaneResult> {
  const chain = d.fastChain(i.effort);
  if (chain.length === 0) return fall("no_fast_leg");
  const retrieval = await d.retrieve(i.chat_id, i.userText);
  if (i.signal.aborted) return fall("aborted");
  const prompt = renderLanePrompt({ system: d.systemPrompt(i.chat_id), retrieval, recentTurns: i.recentTurns, turnChars: i.turnChars,
    quoted: i.quoted, message: i.userText, note: i.note });
  const r = await composeReply(i, d, chain, prompt);
  if (r.kind === "fallthrough") return r;
  // the catch-up line carries the same sanitized text the card delivers (no attach marker, no masked link)
  return { kind: "reply", text: r.text, model: r.model, catch_up: catchUpLine({ lane: "answer", reply: sanitizeLaneText(r.text) }) };
}

/** One compose call on the Fast chain, role `lane`, min(45 s, remaining), the turn's signal; shared by both lanes. */
export async function composeReply(i: LaneInput, d: Pick<AnswerLaneDeps, "compose" | "now">, chain: readonly ModelString[], prompt: string):
  Promise<{ kind: "text"; text: string; model: string } | LaneFall> {
  const started = d.now();
  const remaining = i.deadlineAt - started;
  if (remaining <= 0) return fall("lane_timeout");
  const bound = Math.min(LANE_COMPOSE_MS, remaining);
  const r = await d.compose({ prompt, chain, deadlineMs: bound, signal: i.signal, routed_by: i.verdict_id });
  if (i.signal.aborted) return fall("aborted");
  // a timeout is the provider's "timed out" leg, or a chain that spent its whole bound (the deadline cut the last leg)
  if (!r.ok) return fall(TIMED_OUT.test(r.error) || d.now() - started >= bound ? "compose_timeout" : "compose_failed");
  const text = r.answer.trim();
  return text.length === 0 ? fall("empty_reply") : { kind: "text", text, model: `${r.provider}/${r.model}` }; // provider/model, as every planner verdict
}
