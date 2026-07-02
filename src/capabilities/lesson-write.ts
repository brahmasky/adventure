import type { ToolAdapterResult } from "../tools/tool-registry.js";
import { buildDistillQuestion, DISTILL_DISCIPLINE, parseDistillResult, shouldRejectLesson } from "./distill.js";

/**
 * The `lesson_write` capability adapter (ADR 0013, step ⓪·1): the legacy feedback
 * branch's distill flow as a loop tool — distill on the cheap chain → the deterministic
 * `shouldRejectLesson` backstop → append to the scope's lesson block.
 *
 * TRUST ANCHORING: the distilled `feedback` and the `prior_answer` reference are fixed
 * at CONSTRUCTION time to trusted values (the turn's real user message and the real
 * prior assistant turn) — the model's per-step input is NEVER the source of either.
 * That keeps the provenance backstop meaningful: an injection-steered model cannot
 * launder poison text through the feedback channel, because the backstop always judges
 * the lesson against what the user actually said. The model's input may carry only a
 * `scope`, whitelisted against `allowedScopes` and CLAMPED (never errored) to
 * `defaultScope` otherwise — the clamp is noted in the result digest. Not durable /
 * rejected by the backstop ⇒ a successful no-op (`saved: false`), never an error: the
 * loop should keep composing either way.
 */
export interface LessonWriteAdapterConfig {
  /** TRUST ANCHOR: the turn's real user message — the only text distilled as feedback. */
  feedback: string;
  /** TRUST ANCHOR: the real prior assistant answer from the thread ("" if none). */
  priorAnswer: string;
  /** Scopes the model may choose; anything else clamps to `defaultScope`. */
  allowedScopes: readonly string[];
  /** The turn's scope (e.g. the advisory hint via intentToScope) — the clamp target. */
  defaultScope: string;
  /** One cheap-chain call (the distill judgment) — the llm_answer-style adapter shape. */
  llm: (input: { question: string; system: string }) => Promise<ToolAdapterResult> | ToolAdapterResult;
  /** Persist the lesson (the worker binds RunStore.appendLessonToBlock + the consolidation rewrite). */
  appendLesson: (scope: string, lesson: string, now: string) => Promise<void>;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

export function createLessonWriteAdapter(
  config: LessonWriteAdapterConfig
): (input: Record<string, unknown>) => Promise<ToolAdapterResult> {
  return async (input: Record<string, unknown>): Promise<ToolAdapterResult> => {
    // Anchored, never model-supplied (any feedback/prior_answer in `input` is ignored).
    const feedback = config.feedback;
    if (typeof feedback !== "string" || feedback.trim().length === 0) {
      return { ok: false, error: "anchored feedback must be a non-empty string" };
    }
    const priorAnswer = config.priorAnswer;

    // Scope is the ONLY model-controlled field: whitelist + clamp, never error.
    const requested = typeof input.scope === "string" ? input.scope.trim() : "";
    const clamped = requested.length > 0 && !config.allowedScopes.includes(requested);
    const scope = requested.length > 0 && !clamped ? requested : config.defaultScope;
    const note = clamped ? `scope "${requested}" is not available; clamped to "${scope}"` : undefined;

    const distilled = await config.llm({
      question: buildDistillQuestion(feedback, priorAnswer.slice(0, 1500), scope),
      system: DISTILL_DISCIPLINE
    });
    if (!distilled.ok) {
      return { ok: false, error: distilled.error };
    }
    const raw = typeof distilled.output.answer === "string" ? distilled.output.answer : "";
    const verdict = parseDistillResult(raw);
    if (!verdict.durable || !verdict.lesson) {
      return {
        ok: true,
        output: { saved: false, scope, reason: "not a durable preference", ...(note ? { note } : {}) }
      };
    }
    // Deterministic lesson-poisoning backstop (ADR 0010 §5): a lesson lifted from the
    // untrusted prior answer (or over-long) is refused — reported, never saved.
    if (shouldRejectLesson(verdict.lesson, feedback, priorAnswer)) {
      return {
        ok: true,
        output: { saved: false, scope, reason: "rejected by the lesson backstop", ...(note ? { note } : {}) }
      };
    }

    const now = (config.now?.() ?? new Date()).toISOString();
    await config.appendLesson(scope, verdict.lesson, now);
    return { ok: true, output: { saved: true, scope, lesson: verdict.lesson, ...(note ? { note } : {}) } };
  };
}
