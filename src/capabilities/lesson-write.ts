import { spawnSync } from "node:child_process";
import type { ToolAdapterResult } from "../tools/tool-registry.js";
import type { EpisodicFactSaveResult, LessonSaveResult } from "../run/run-store.js";
import { buildMemoryDistillQuestion, LESSON_AVOID_MAX_CHARS, LESSON_MAX_CHARS, MEMORY_DISTILL_DISCIPLINE, parseMemoryDistillResult, type MemoryDistill,
  type MemoryKindChoice } from "./distill.js";
import { safeReason } from "../domain/error-code.js";
import { RATING_ACK_COMMENT_TEXT, RATING_ACK_TEXT, RATING_ASK_TEXT } from "./session-rating.js";
import { decide, decideSync } from "../decisions/decide.js";
import { MEMORY_LESSON_ADMIT, type MemoryAdmitReason } from "../decisions/entries/memory-lesson-admit.js";
import { MEMORY_KIND, memoryKindJevRung, type MemoryKindDetail, type MemoryKindVerdict } from "../decisions/entries/memory-kind.js";
import type { DecisionRecorder, RungResult } from "../decisions/types.js";
import type { MemoryKindAsk } from "../jev/memory-kind-ask.js";
import { checkFactSide, checkLessonSide, type FactSide, type LessonSide } from "./memory-backstops.js";
import { evidenceLines, pacoTextOf, type MemorySources } from "./memory-sources.js";

/**
 * The `lesson_write` capability: `createMemoryWriteAdapter` (below) is the memory save as a loop tool and a lane service
 * (spec 2026-10-15) — Paco's instruction, his cut thread and the prior reply are fixed by the worker (TRUST ANCHOR, never
 * model input; the model may pick only a whitelisted, clamped `scope`), then memory.kind, the code backstops and the
 * worker's one-transaction save. LAYER ROUTING (⓪·3 S1c): a phrase that exists VERBATIM in Houge's own `src/*.ts` targets
 * a code-owned surface a memory can never change, so it is refused before any LLM call with a digest that steers the
 * model to `self_write_propose`. The phrase helpers and the default checker live here too.
 */

/** The digest reason when this turn already saved a lesson (ADR 0029 §5.5). */
export const ALREADY_SAVED_REASON = "already_saved_this_turn";

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
  /** memory.lesson_admit's recorder (spec 2026-10-30 §4.1): a held list the worker flushes under the lost-turn rule; absent = no rows. */
  admitRecorder?: DecisionRecorder;
  run_id: string;
  runSource: (run_id: string) => string | undefined;
  save: (plan: MemoryPlan, now: string) => Promise<MemorySaveResult>;
  srcContains?: (phrase: string) => boolean;
  threadUserTexts?: readonly string[];
  scheduledRun?: boolean;
  alreadySaved?: { lesson_id?: number; fact_id?: number };
  /** The turn was killed (Opus M1): checked before every model or Jev call, so nothing is sent after a kill. */
  aborted?: () => boolean;
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
    if (early) { recordAdmit(c, "pre", preReasonOf(early)); return early; }
    const { scope, note } = clampScope(c, input);
    const owned = codeOwnedRefusal(c.sources.instruction.text, c, note);
    if (owned) { recordAdmit(c, "pre", preReasonOf(owned)); return owned; }
    if (c.aborted?.()) return memoryResult({ items: [], reason: "turn_ended" }, scope, note);
    const kind = await decideMemoryKind(c, scope);
    if (c.aborted?.()) return memoryResult({ items: [], reason: "turn_ended" }, scope, note);
    if ("refused" in kind) return memoryResult({ items: [], reason: kind.refused }, scope, note);
    const { plan, items } = planOf(c, kind.distill, scope);
    for (const i of items) recordAdmit(c, "backstop", i.reason !== undefined ? (SIDE_ADMIT as Readonly<Record<string, MemoryAdmitReason>>)[`${i.kind}:${i.reason}`] : undefined);
    if (!plan.lesson && !plan.fact) return memoryResult({ items }, scope, note);
    const now = (c.now?.() ?? new Date()).toISOString();
    try {
      return memoryResult(mergeSave(items, await c.save(plan, now)), scope, note);
    } catch (e) {
      // A store error or a rolled-back inTx never crashes the turn and never claims a save; logged, never silent (spec §12).
      console.error(`memory write: save failed: ${safeReason(e)}`);
      return memoryResult({ items, reason: "save_failed" }, scope, note);
    }
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

/** Today's early-return strings → memory.lesson_admit codes; the tool result keeps the strings. */
/** Exported for the drift test (plan P5): its key set must equal the three early-return reason strings. */
export const PRE_ADMIT: Readonly<Record<string, MemoryAdmitReason>> = { "scheduled-run": "scheduled_run", [ALREADY_SAVED_REASON]: "already_saved", "code-owned": "code_owned" };
type SideKey = `rule:${Extract<LessonSide, { ok: false }>["reason"]}` | `fact:${Extract<FactSide, { ok: false }>["reason"]}`;
/** Exhaustive by type: a new LessonSide/FactSide refusal reason fails typecheck here until it is mapped (plan P5). */
export const SIDE_ADMIT: Readonly<Record<SideKey, MemoryAdmitReason>> = { "rule:rejected_by_backstop": "lesson_backstop", "fact:rejected_by_backstop": "fact_backstop", "fact:no_evidence": "fact_no_evidence" };

/** Records one admit refusal (raw answer drives; the result is discarded, Stage 4B R1). */
function recordAdmit(c: Pick<MemoryWriteAdapterConfig, "admitRecorder" | "run_id">, seam: "pre" | "backstop", refused: MemoryAdmitReason | undefined): void {
  if (!c.admitRecorder || refused === undefined) return;
  decideSync(MEMORY_LESSON_ADMIT, { seam, refused }, { run_id: c.run_id, tool_call_id: null, recorder: c.admitRecorder });
}
const preReasonOf = (r: ToolAdapterResult): MemoryAdmitReason | undefined =>
  r.ok && typeof r.output.reason === "string" ? PRE_ADMIT[r.output.reason] : undefined;

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
    const d = await ask(r.verdict as MemoryKindChoice).catch(() => null);
    return d === null ? { refused: "distill_failed" } : usable(onlyKind(d, r.verdict as MemoryKindChoice));
  }
  return r.rung === "model" && r.detail?.distill ? usable(r.detail.distill) : { refused: "distill_failed" };
}

async function askDistill(c: MemoryWriteAdapterConfig, scope: string, kind?: MemoryKindChoice): Promise<MemoryDistill | null> {
  if (c.aborted?.()) return null; // killed during the Jev call: the distill is never sent (the adapter reports turn_ended)
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
  const hint = r.hint ?? (reason === "nothing_to_save" ? NOTHING_TO_SAVE_HINT : reason === "distill_failed" || reason === "save_failed" ? DISTILL_FAILED_HINT : undefined);
  return { ok: true, output: { saved: saved.length > 0, kinds: saved.map((i) => i.kind), items: r.items, scope, ...(reason ? { reason } : {}),
    ...(hint ? { hint } : {}), ...(r.escalate ? { escalate: true } : {}), ...idsOf(r.ids ?? {}), ...(note ? { note } : {}) } };
}
