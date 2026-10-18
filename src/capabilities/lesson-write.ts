import { spawnSync } from "node:child_process";
import type { ToolAdapterResult } from "../tools/tool-registry.js";
import type { LessonSaveResult } from "../run/run-store.js";
import { buildDistillQuestion, DISTILL_DISCIPLINE, LESSON_AVOID_MAX_CHARS, LESSON_MAX_CHARS, parseDistillResult, shouldRejectLesson } from "./distill.js";
import { RATING_ACK_COMMENT_TEXT, RATING_ACK_TEXT, RATING_ASK_TEXT } from "./session-rating.js";
import { decide } from "../decisions/decide.js";
import { MEMORY_KIND, memoryKindJevRung, type MemoryKindDetail, type MemoryKindVerdict } from "../decisions/entries/memory-kind.js";
import type { DecisionRecorder, RungResult } from "../decisions/types.js";
import type { MemoryKindAsk } from "../jev/memory-kind-ask.js";
import type { EpisodicFactSaveResult } from "../run/run-store.js";
import { buildMemoryDistillQuestion, MEMORY_DISTILL_DISCIPLINE, parseMemoryDistillResult, type MemoryDistill, type MemoryKindChoice } from "./distill.js";
import { checkFactSide, checkLessonSide } from "./memory-backstops.js";
import { evidenceLines, pacoTextOf, type MemorySources } from "./memory-sources.js";

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
  /**
   * Thread-scoped code-owned check (⓪·3f F1): the recent USER turn texts, most recent
   * first — a code-owned phrase quoted a couple of turns back ("把「…」换一下" → "换掉它")
   * must still trip the refusal. Assistant turns are EXCLUDED by the caller on purpose:
   * a prior Houge reply legitimately contains code-owned strings (the evolution-notice
   * header rides replies; option lists quote candidate titles), and including them would
   * poison every subsequent lesson_write with false refusals. The adapter bounds the
   * scan (last {@link THREAD_USER_TURN_CAP} texts, ≤{@link THREAD_TEXT_CHAR_CAP} chars).
   */
  threadUserTexts?: readonly string[];
  /**
   * The run was born of a scheduled task (`runs.source = 'schedule'`): its objective is the
   * schedule's stored goal, not Paco speaking, so the call is refused before any LLM call.
   */
  scheduledRun?: boolean;
  /**
   * Memory lane (ADR 0029 §5.5): the lane already saved from this turn's message. A planner `lesson_write` in the same
   * turn gets this digest and spends nothing — no second row, no UPDATE superseding the card's lesson.
   */
  alreadySaved?: { id: number };
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

/** The digest reason when this turn already saved a lesson (ADR 0029 §5.5). */
export const ALREADY_SAVED_REASON = "already_saved_this_turn";

export function createLessonWriteAdapter(
  config: LessonWriteAdapterConfig
): (input: Record<string, unknown>) => Promise<ToolAdapterResult> {
  return async (input: Record<string, unknown>): Promise<ToolAdapterResult> => {
    // A scheduled run's "user message" is the stored schedule goal: never a lesson source.
    if (config.scheduledRun) {
      return { ok: true, output: { saved: false, reason: "scheduled-run", hint: SCHEDULED_RUN_HINT } };
    }
    // One lesson per turn (ADR 0029 §5.5): checked before any LLM call.
    if (config.alreadySaved) {
      return { ok: true, output: { saved: false, reason: ALREADY_SAVED_REASON, lesson_id: config.alreadySaved.id } };
    }
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
    // ⓪·3f F1: the current message PLUS the recent user turns are scanned (the phrase is
    // often quoted a turn or two back — "换掉它" alone carries nothing); current-message
    // phrases keep precedence so single-turn behavior is unchanged.
    // Phrases echoing Houge's CONVERSATIONAL strings are skipped first (S2 fix): a user
    // naturally repeats what Houge just said ("这个问题反复出现…"), and that echo is
    // feedback about behavior, not about a rendered code-owned surface.
    if (config.srcContains) {
      const codeOwned = extractThreadPhrases(feedback, config.threadUserTexts ?? [])
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
    // The AVOID line rides the same backstop: a lifted or over-cap (> LESSON_AVOID_MAX_CHARS) avoid is dropped, not the lesson.
    const avoid =
      verdict.avoid && verdict.avoid.length <= LESSON_AVOID_MAX_CHARS && !shouldRejectLesson(verdict.avoid, feedback, priorAnswer)
        ? verdict.avoid
        : undefined;

    const now = (config.now?.() ?? new Date()).toISOString();
    const saved = await config.saveLesson({ scope, text: verdict.lesson, ...(avoid ? { avoid } : {}) }, now);
    if (saved.verb === "drop") {
      return {
        ok: true,
        output: { saved: false, scope, reason: "already covered by an existing lesson", ...(note ? { note } : {}) }
      };
    }
    if (saved.verb === "capped") {
      return { ok: true, output: { saved: false, scope, reason: "too-large", hint: LESSON_CAPPED_HINT, ...(note ? { note } : {}) } };
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

/** Memory A1 §2: the merge would exceed the size cap, so nothing was saved (the existing lesson is unchanged). */
export const LESSON_CAPPED_HINT =
  `not saved: merging this into the existing lesson would exceed the size cap (${LESSON_MAX_CHARS} chars, AVOID ${LESSON_AVOID_MAX_CHARS}). ` +
  "Tell Paco it was not saved, or save one narrower rule.";

/** The escalation hint (⓪·3 S2b iii): the memory layer keeps getting corrected — pivot. */
export const LESSON_ESCALATE_HINT =
  "这个问题反复出现，光改记忆可能没用 — 建议 self_diagnose 或 self_write_propose 查代码层";

/** The scheduled-run refusal hint (2026-10-02): a schedule goal is not Paco's words. */
export const SCHEDULED_RUN_HINT =
  "a scheduled task is not Paco speaking; lessons are saved only from Paco's own messages";

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

/** The phrase cap — shared by the single-message extractor and the F1 thread union. */
const PHRASE_CAP = 8;
/** F1 bounds: how many recent user-turn texts and how many total chars are scanned. */
export const THREAD_USER_TURN_CAP = 6;
export const THREAD_TEXT_CHAR_CAP = 1500;

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
  return [...phrases].filter((p) => p.length <= 80).slice(0, PHRASE_CAP);
}

/**
 * ⓪·3f F1 — the thread-scoped phrase union: the current message's phrases FIRST (so
 * single-turn behavior — including which phrase lands in the refusal digest — is
 * unchanged), then phrases from the recent user turns (most recent first), bounded to
 * {@link THREAD_USER_TURN_CAP} texts / {@link THREAD_TEXT_CHAR_CAP} total chars, the
 * whole union still capped at {@link PHRASE_CAP} phrases.
 */
export function extractThreadPhrases(feedback: string, threadUserTexts: readonly string[]): string[] {
  const phrases = extractLiteralPhrases(feedback);
  let charBudget = THREAD_TEXT_CHAR_CAP;
  for (const text of threadUserTexts.slice(0, THREAD_USER_TURN_CAP)) {
    if (phrases.length >= PHRASE_CAP || charBudget <= 0) break;
    const slice = text.slice(0, charBudget);
    charBudget -= slice.length;
    for (const phrase of extractLiteralPhrases(slice)) {
      if (phrases.length >= PHRASE_CAP) break;
      if (!phrases.includes(phrase)) phrases.push(phrase);
    }
  }
  return phrases;
}

/**
 * The default code-owned checker: one bounded, fixed-string grep over `src/` (only .ts
 * sources) per phrase — whole words for non-CJK, substrings for CJK. Sync via
 * child_process, exits on first match, 2s timeout.
 */
export function createSrcPhraseChecker(projectRoot: string): (phrase: string) => boolean {
  return (phrase) => {
    const result = spawnSync("grep", [CJK_RE.test(phrase) ? "-rqF" : "-rqFw", "--include=*.ts", "-e", phrase, "src"], {
      cwd: projectRoot,
      timeout: 2000
    });
    return result.status === 0;
  };
}

/** What the adapter asks the worker to write (spec §7): the checked rule and/or fact, never model text past its backstop. */
export interface MemoryPlan { scope: string; lesson?: { text: string; avoid?: string }; fact?: { text: string; source_turn_ids: string[] } }
/** What the worker's save did: the store's verdict per side, a parallel save that won, or a turn that ended first. */
export interface MemorySaveResult { lesson?: LessonSaveResult; fact?: EpisodicFactSaveResult; racedBy?: { lesson_id?: number; fact_id?: number }; lost?: true }
/** One line of the tool result (spec §9): a saved item names its id and verb, a refused one its reason. */
export interface MemoryItem { kind: "rule" | "fact"; id?: number; verb?: string; reason?: string }

/** Spec §9: nothing in Paco's words to save — ask him, never promise a later save (the incident's "a full sentence would work"). */
export const NOTHING_TO_SAVE_HINT = "nothing in Paco's words to save: ask him what to remember; never promise a later save";
export const DISTILL_FAILED_HINT = "the save did not run: tell Paco it was not saved";
/** The prior reply's share of the distill question (as before, `lesson-write.ts:134`). */
const PRIOR_CHARS = 1500;

export interface MemoryWriteAdapterConfig {
  /** TRUST ANCHOR (spec §4): Paco's instruction, his cut thread, the prior reply — fixed in code, never model input. */
  sources: MemorySources;
  allowedScopes: readonly string[];
  defaultScope: string;
  llm: (input: { question: string; system: string }) => Promise<ToolAdapterResult> | ToolAdapterResult;
  /** memory_kind's own Jev call (spec Rev 3 §3), passed by a save-first; absent on the planner's tool, so the model rung decides. */
  askJev?: () => Promise<MemoryKindAsk>;
  /** The memory lane: a confident fix / other hands the turn off. Elsewhere (default) they abstain (sets_rule asked for a save). */
  escapes?: boolean;
  /** memory.kind's recorder (the worker holds the row for its save transaction) and the run it belongs to. */
  recorder: DecisionRecorder;
  run_id: string;
  runSource: (run_id: string) => string | undefined;
  save: (plan: MemoryPlan, now: string) => Promise<MemorySaveResult>;
  srcContains?: (phrase: string) => boolean;
  threadUserTexts?: readonly string[];
  scheduledRun?: boolean;
  alreadySaved?: { lesson_id?: number; fact_id?: number };
  now?: () => Date;
}

/**
 * The memory save as a loop tool and lane service (spec 2026-10-15). Checks before any LLM call (schedule-born, one save
 * per turn, code-owned phrase), then memory.kind through the runner (Jev's answer, else the distill), the code backstops,
 * the worker's save, and a result built from what the store committed.
 */
export function createMemoryWriteAdapter(c: MemoryWriteAdapterConfig): (input: Record<string, unknown>) => Promise<ToolAdapterResult> {
  return async (input) => {
    const early = memoryPreChecks(c);
    if (early) return early;
    const { scope, note } = clampScope(c, input);
    const owned = codeOwnedRefusal(c.sources.instruction.text, c, note);
    if (owned) return owned;
    const kind = await decideMemoryKind(c, scope);
    if ("refused" in kind) return memoryResult({ items: [], reason: kind.refused }, scope, note);
    const { plan, items } = planOf(c, kind.distill, scope);
    if (!plan.lesson && !plan.fact) return memoryResult({ items }, scope, note);
    const now = (c.now?.() ?? new Date()).toISOString();
    return memoryResult(mergeSave(items, await c.save(plan, now)), scope, note);
  };
}

const NOTHING = { saved: false, kinds: [], items: [] } as const;
const idsOf = (a: { lesson_id?: number; fact_id?: number }) => ({ ...(a.lesson_id !== undefined ? { lesson_id: a.lesson_id } : {}),
  ...(a.fact_id !== undefined ? { fact_id: a.fact_id } : {}) });

function memoryPreChecks(c: MemoryWriteAdapterConfig): ToolAdapterResult | null {
  // A scheduled run's "message" is the stored schedule goal: never a memory source.
  if (c.scheduledRun) return { ok: true, output: { ...NOTHING, reason: "scheduled-run", hint: SCHEDULED_RUN_HINT } };
  // One memory save per turn, lesson or fact (ADR 0029 §5.5; spec §4): checked before any LLM call.
  if (c.alreadySaved) return { ok: true, output: { ...NOTHING, reason: ALREADY_SAVED_REASON, ...idsOf(c.alreadySaved) } };
  if (c.sources.instruction.text.trim().length === 0) return { ok: false, error: "anchored instruction must be a non-empty string" };
  return null;
}

/** Scope is the ONLY model-controlled field: whitelist + clamp, never error. */
function clampScope(c: { allowedScopes: readonly string[]; defaultScope: string }, input: Record<string, unknown>): { scope: string; note?: string } {
  const requested = typeof input.scope === "string" ? input.scope.trim() : "";
  const clamped = requested.length > 0 && !c.allowedScopes.includes(requested);
  const scope = requested.length > 0 && !clamped ? requested : c.defaultScope;
  return clamped ? { scope, note: `scope "${requested}" is not available; clamped to "${scope}"` } : { scope };
}

/** Layer routing (⓪·3 S1c, F1): a quoted phrase that exists verbatim in src/ targets a code-owned surface; refused before distilling. */
function codeOwnedRefusal(instruction: string, c: Pick<MemoryWriteAdapterConfig, "srcContains" | "threadUserTexts">, note?: string): ToolAdapterResult | null {
  if (!c.srcContains) return null;
  const phrase = extractThreadPhrases(instruction, c.threadUserTexts ?? [])
    .filter((p) => !CONVERSATIONAL_SRC_STRINGS.some((s) => s.includes(p)))
    .find((p) => c.srcContains!(p));
  return phrase ? { ok: true, output: { ...NOTHING, reason: "code-owned", phrase, hint: CODE_OWNED_HINT, ...(note ? { note } : {}) } } : null;
}

type KindOutcome = { distill: MemoryDistill } | { refused: "distill_failed" | "nothing_to_save" | "fix" | "memory_other" };

/** memory.kind (spec §3): Jev's confident answer fixes the kind and the distill writes it; else the distill decides both. */
async function decideMemoryKind(c: MemoryWriteAdapterConfig, scope: string): Promise<KindOutcome> {
  const ask = (kind?: MemoryKindChoice) => askDistill(c, scope, kind);
  const escapes = c.escapes ?? false;
  const r = await decide(MEMORY_KIND, { jev: undefined, escapes }, { run_id: c.run_id, recorder: c.recorder, exec: {
    system_one: async () => (c.askJev ? jevRungOf(await askJevSafely(c.askJev), escapes) : { abstain: true }),
    model: async () => modelRungOf(await ask())
  } });
  if (r.rung === "system_one" && (r.verdict === "fix" || r.verdict === "other")) return { refused: r.verdict === "fix" ? "fix" : "memory_other" };
  if (r.rung === "system_one") {
    const d = await ask(r.verdict as MemoryKindChoice);
    return d === null ? { refused: "distill_failed" } : usable(onlyKind(d, r.verdict as MemoryKindChoice));
  }
  return r.rung === "model" && r.detail?.distill ? usable(r.detail.distill) : { refused: "distill_failed" };
}

async function askDistill(c: MemoryWriteAdapterConfig, scope: string, kind?: MemoryKindChoice): Promise<MemoryDistill | null> {
  const s = c.sources;
  const r = await c.llm({ system: MEMORY_DISTILL_DISCIPLINE, question: buildMemoryDistillQuestion({ thread: s.thread.map((m) => m.text),
    prior: s.prior.slice(0, PRIOR_CHARS), instruction: s.instruction.text, scope, ...(kind ? { kind } : {}) }) });
  return r.ok && typeof r.output.answer === "string" ? parseMemoryDistillResult(r.output.answer) : null;
}

/** A thrown Jev or store error never blocks the save: it is the rung's `threw` failure and the distill decides. */
async function askJevSafely(ask: () => Promise<MemoryKindAsk>): Promise<MemoryKindAsk> {
  try { return await ask(); } catch { return { failed: "threw" }; }
}

/** The Jev rung over memory_kind's own call: a failed call is the rung's failure (the distill then decides), an answer goes through the bar. */
function jevRungOf(a: MemoryKindAsk, escapes: boolean): RungResult<MemoryKindVerdict, MemoryKindDetail> {
  return "failed" in a ? { failed: a.failed } : memoryKindJevRung({ jev: a.answer, escapes });
}

/** The model rung: a failed call is an outage, unusable output a parse failure (both: fail → `other`); else the kind it wrote. */
function modelRungOf(d: MemoryDistill | null): RungResult<MemoryKindVerdict, MemoryKindDetail> {
  if (d === null) return { failed: "outage", detail: { distill: null } };
  if (d.failed === "parse") return { failed: "parse", detail: { distill: d } };
  return { verdict: d.kind === "none" ? "other" : d.kind, reason: "distill_kind", detail: { distill: d } };
}

function usable(d: MemoryDistill): KindOutcome {
  if (d.failed === "parse") return { refused: "distill_failed" };
  return d.kind === "none" ? { refused: "nothing_to_save" } : { distill: d };
}

/** Jev decided (spec §3): only the side(s) of its kind are kept; a distill that wrote none of them has nothing to save. */
function onlyKind(d: MemoryDistill, kind: MemoryKindChoice): MemoryDistill {
  if (d.failed === "parse" || d.kind === "none") return d;
  const rule = kind !== "fact" && d.lesson !== undefined;
  const fact = kind !== "rule" && d.fact !== undefined;
  if (!rule && !fact) return { kind: "none" };
  return {
    kind: rule && fact ? "both" : rule ? "rule" : "fact",
    ...(rule ? { lesson: d.lesson!, ...(d.avoid ? { avoid: d.avoid } : {}) } : {}),
    ...(fact ? { fact: d.fact!, ...(d.evidence ? { evidence: d.evidence } : {}), ...(d.factRefused ? { factRefused: d.factRefused } : {}) } : {})
  };
}

/** The backstops (spec §6) turn the distill into a plan; a refused side is reported, the other side still saves. */
function planOf(c: MemoryWriteAdapterConfig, d: MemoryDistill, scope: string): { plan: MemoryPlan; items: MemoryItem[] } {
  const lesson = checkLessonSide(d, pacoTextOf(c.sources), c.sources.prior);
  const fact = checkFactSide(d, evidenceLines(c.sources), c.runSource, { text: pacoTextOf(c.sources), prior: c.sources.prior });
  const items: MemoryItem[] = [
    ...(lesson && !lesson.ok ? [{ kind: "rule" as const, reason: lesson.reason }] : []),
    ...(fact && !fact.ok ? [{ kind: "fact" as const, reason: fact.reason }] : [])
  ];
  const plan: MemoryPlan = { scope,
    ...(lesson?.ok ? { lesson: { text: lesson.lesson, ...(lesson.avoid ? { avoid: lesson.avoid } : {}) } } : {}),
    ...(fact?.ok ? { fact: { text: fact.fact, source_turn_ids: fact.source_turn_ids } } : {}) };
  return { plan, items };
}

interface MemoryReport { items: MemoryItem[]; reason?: string; hint?: string; escalate?: true; ids?: { lesson_id?: number; fact_id?: number } }

function mergeSave(items: MemoryItem[], s: MemorySaveResult): MemoryReport {
  if (s.racedBy) return { items: [], reason: ALREADY_SAVED_REASON, ids: s.racedBy };
  if (s.lost) return { items: [], reason: "turn_ended" };
  const all = [...items, ...(s.lesson ? [lessonItem(s.lesson)] : []), ...(s.fact ? [factItem(s.fact)] : [])];
  if (s.lesson?.escalate) return { items: all, escalate: true, hint: LESSON_ESCALATE_HINT };
  return { items: all, ...(s.lesson?.verb === "capped" ? { hint: LESSON_CAPPED_HINT } : {}) };
}

const lessonItem = (l: LessonSaveResult): MemoryItem =>
  l.id !== undefined ? { kind: "rule", id: l.id, verb: l.verb } : { kind: "rule", reason: l.verb === "capped" ? "too-large" : "already_covered" };
const factItem = (f: EpisodicFactSaveResult): MemoryItem =>
  f.id !== undefined && f.verb !== "drop" ? { kind: "fact", id: f.id, verb: f.verb } : { kind: "fact", reason: "already_covered" };

/** The tool result (spec §9): `saved` and `kinds` come from committed ids only; the reason is the first refusal when nothing saved. */
function memoryResult(r: MemoryReport, scope: string, note?: string): ToolAdapterResult {
  const saved = r.items.filter((i) => i.id !== undefined);
  const reason = saved.length > 0 ? undefined : r.reason ?? r.items.find((i) => i.reason !== undefined)?.reason ?? "nothing_to_save";
  const hint = r.hint ?? (reason === "nothing_to_save" ? NOTHING_TO_SAVE_HINT : reason === "distill_failed" ? DISTILL_FAILED_HINT : undefined);
  return { ok: true, output: { saved: saved.length > 0, kinds: saved.map((i) => i.kind), items: r.items, scope, ...(reason ? { reason } : {}),
    ...(hint ? { hint } : {}), ...(r.escalate ? { escalate: true } : {}), ...idsOf(r.ids ?? {}), ...(note ? { note } : {}) } };
}
