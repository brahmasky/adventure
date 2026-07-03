import { spawnSync } from "node:child_process";
import type { ToolAdapterResult } from "../tools/tool-registry.js";
import type { LessonSaveResult } from "../run/run-store.js";
import { buildDistillQuestion, DISTILL_DISCIPLINE, parseDistillResult, shouldRejectLesson } from "./distill.js";
import { RATING_ACK_COMMENT_TEXT, RATING_ACK_TEXT, RATING_ASK_TEXT } from "./session-rating.js";

/**
 * The `lesson_write` capability adapter (ADR 0013, step ⓪·1): the legacy feedback
 * branch's distill flow as a loop tool — distill on the cheap chain → the deterministic
 * `shouldRejectLesson` backstop → reconcile-and-save (⓪·3 S1b: the injected `saveLesson`
 * reconciles the candidate against the scope's active lessons and applies the
 * ADD/SUPERSEDE/UPDATE/DROP verdict).
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
 *
 * LAYER ROUTING (⓪·3 S1c): feedback that quotes a phrase existing VERBATIM in Houge's
 * own `src/*.ts` targets a CODE-OWNED surface (the evolution-notice header, report
 * scaffolding, buttons, notification wrappers) — a lesson can never change those. The
 * adapter refuses mechanically BEFORE distilling, with a digest (not an error) that
 * steers the model to `self_write_propose` in-turn.
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
  /**
   * Reconcile-and-save (⓪·3 S1b): the worker binds getActiveLessons → reconcile →
   * RunStore.saveReconciledLesson, so the verdict (add/supersede/update/drop) comes back
   * for the result digest.
   */
  saveLesson: (candidate: { scope: string; text: string; avoid?: string }, now: string) => Promise<LessonSaveResult>;
  /**
   * Code-owned check (⓪·3 S1c): does this phrase exist verbatim in Houge's src/*.ts?
   * Absent ⇒ the layer-routing refusal is skipped. Injectable for tests; the worker
   * binds {@link createSrcPhraseChecker}.
   */
  srcContains?: (phrase: string) => boolean;
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

    // LAYER ROUTING (⓪·3 S1c): a quoted/verbatim phrase from the feedback that exists in
    // src/ means the target text is code-owned — refuse (a digest, not an error) so the
    // model pivots to self_write_propose in the same turn. Checked BEFORE distilling.
    // Phrases echoing Houge's CONVERSATIONAL strings are skipped first (S2 fix): a user
    // naturally repeats what Houge just said ("这个问题反复出现…"), and that echo is
    // feedback about behavior, not about a rendered code-owned surface.
    if (config.srcContains) {
      const codeOwned = extractLiteralPhrases(feedback)
        .filter((p) => !CONVERSATIONAL_SRC_STRINGS.some((s) => s.includes(p)))
        .find((p) => config.srcContains!(p));
      if (codeOwned) {
        return {
          ok: true,
          output: {
            saved: false,
            reason: "code-owned",
            phrase: codeOwned,
            hint: CODE_OWNED_HINT,
            ...(note ? { note } : {})
          }
        };
      }
    }

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
    // The AVOID line rides the same backstop: a lifted avoid is dropped, not the lesson.
    const avoid =
      verdict.avoid && !shouldRejectLesson(verdict.avoid, feedback, priorAnswer) ? verdict.avoid : undefined;

    const now = (config.now?.() ?? new Date()).toISOString();
    const saved = await config.saveLesson({ scope, text: verdict.lesson, ...(avoid ? { avoid } : {}) }, now);
    if (saved.verb === "drop") {
      return {
        ok: true,
        output: { saved: false, scope, reason: "already covered by an existing lesson", ...(note ? { note } : {}) }
      };
    }
    return {
      ok: true,
      output: {
        saved: true,
        verb: saved.verb,
        scope,
        lesson: saved.lesson,
        ...(saved.supersededId !== undefined ? { supersededId: saved.supersededId } : {}),
        ...(avoid ? { avoid } : {}),
        // Layer routing (⓪·3 S2b iii): a repeat supersede of an ineffective lesson —
        // the digest steers the model toward the code layer, in-turn.
        ...(saved.escalate ? { escalate: true, hint: LESSON_ESCALATE_HINT } : {}),
        ...(note ? { note } : {})
      }
    };
  };
}

/** The escalation hint (⓪·3 S2b iii): the memory layer keeps getting corrected — pivot. */
export const LESSON_ESCALATE_HINT =
  "这个问题反复出现，光改记忆可能没用 — 建议 self_diagnose 或 self_write_propose 查代码层";

/** The code-owned refusal hint (⓪·3 S1c digest). */
export const CODE_OWNED_HINT = "这段文字写死在代码里 — 需要 self_write_propose";

/**
 * Strings Houge SPEAKS in conversation that also live verbatim in src/ (⓪·3 S2 fix,
 * verifier finding 4): a user echoing one of these ("这个问题反复出现，你又…") must not
 * trip the code-owned refusal — the echo is about behavior, not a rendered surface.
 * RENDERED OUTPUT constants (the evolution-notice header, report scaffolding, buttons)
 * stay OUT of this list on purpose: quoting those IS feedback about a code-owned surface.
 */
export const CONVERSATIONAL_SRC_STRINGS: readonly string[] = [
  RATING_ASK_TEXT,
  RATING_ACK_TEXT,
  RATING_ACK_COMMENT_TEXT,
  LESSON_ESCALATE_HINT,
  CODE_OWNED_HINT
];

/**
 * Extract the distinctive literal phrases a piece of feedback quotes (⓪·3 S1c): quoted /
 * bracketed segments, plus unquoted CJK runs of ≥6 chars. Conservative by construction —
 * a phrase only ever REFUSES a lesson when it also matches src/*.ts verbatim, so ordinary
 * conversational feedback (which never appears byte-identically in source) passes.
 */
const QUOTED_RES = [
  /"([^"\n]+)"/g,
  /“([^”\n]+)”/g,
  /'([^'\n]+)'/g,
  /‘([^’\n]+)’/g,
  /「([^」\n]+)」/g,
  /『([^』\n]+)』/g,
  /`([^`\n]+)`/g,
  /【([^】\n]+)】/g,
  /\[([^\]\n]+)\]/g
];
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const CJK_RUN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]{6,}/g;

export function extractLiteralPhrases(feedback: string): string[] {
  const phrases = new Set<string>();
  for (const re of QUOTED_RES) {
    for (const match of feedback.matchAll(re)) {
      const phrase = match[1]!.trim();
      // Quoting already marks the phrase as a literal; CJK carries more per char (≥4), latin needs ≥6.
      if (phrase.length >= (CJK_RE.test(phrase) ? 4 : 6)) phrases.add(phrase);
    }
  }
  for (const match of feedback.matchAll(CJK_RUN_RE)) {
    phrases.add(match[0]!);
  }
  return [...phrases].filter((p) => p.length <= 80).slice(0, 8);
}

/**
 * The default code-owned checker: one bounded, fixed-string grep over `src/` (only .ts
 * sources) per phrase — sync via child_process, exits on first match, 2s timeout.
 */
export function createSrcPhraseChecker(projectRoot: string): (phrase: string) => boolean {
  return (phrase) => {
    const result = spawnSync("grep", ["-rqF", "--include=*.ts", "-e", phrase, "src"], {
      cwd: projectRoot,
      timeout: 2000
    });
    return result.status === 0;
  };
}
