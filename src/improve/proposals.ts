import { buildMemoryDistillQuestion, MEMORY_DISTILL_DISCIPLINE, parseMemoryDistillResult, type MemoryDistill } from "../capabilities/distill.js";
import type { TranscriptLine } from "../capabilities/episodic-evidence.js";
import { checkFactSide, checkLessonSide } from "../capabilities/memory-backstops.js";
import { PENDING_TURN_PREFIX } from "../capabilities/memory-sources.js";
import { LOCKED_ENTRY_IDS } from "../decisions/entry-ids.js";
import { turnTrustFinal } from "../decisions/trust.js";
import type { ImproveState, ImproveTarget } from "../decisions/entries/improve-route.js";
import type { ProposalTarget, RunStore } from "../run/run-store.js";
import { formatInstantInZone } from "../run/schedule-spec.js";
import type { TickLlm } from "./decide-improve.js";
import { PACO_TEXT_CAP, type SignalGroup } from "./groups.js";
import { scheduleDraft, type ScheduleHint } from "./schedule-shift.js";

/** 2b-ii §5.1: proposals are drafted at proposal time, code-built or distilled from Paco's words; the digest shows the draft beside its evidence. */
export const PROPOSAL_TTL_DAYS = 14;
export interface Draft { target: ProposalTarget; draft_json: string; evidence: string }
export interface DraftDeps { store: RunStore; env: NodeJS.ProcessEnv; now: string; tz: string; distill: TickLlm; redact: (t: string) => string; scheduleHints?: ReadonlyMap<string, ScheduleHint> }
const LOCKED: ReadonlySet<string> = new Set(LOCKED_ENTRY_IDS);
const RESEARCH: ReadonlySet<string> = new Set(["lookup", "research"]);

export const lessonScopeFor = (category: string | null): "ask" | "research" => (category !== null && RESEARCH.has(category) ? "research" : "ask");

export function evidenceOf(g: SignalGroup, s: ImproveState, tz: string): string {
  const date = formatInstantInZone(g.newest.created_at, tz).slice(0, 10);
  // spec §7: a correction on a scope that got a lesson within 30 days is "lesson did not hold" evidence (the proposal is then a rewrite)
  if (s.signal === "correction" && s.lastImprovement?.target === "lesson" && s.lastImprovement.ageDays <= 30) return `lesson did not hold: ${s.count14d} corrections since (${s.lastImprovement.ageDays} d)`;
  if (s.signal === "correction") return `correction on ${date}, scope ${s.category ?? "other"}`;
  if (s.signal === "recurrence" && s.recurrence) return `${s.recurrence.turnIds.length} requests over ${s.recurrence.spanDays} days`;
  if (s.signal === "review_bad") return `${s.count14d} ❌ on ${s.scope} in 14 days`;
  return `${s.count14d} ${s.signal} on ${s.scope} in 14 days`;
}

export async function draftFor(target: ImproveTarget, g: SignalGroup, s: ImproveState, d: DraftDeps): Promise<Draft | null> {
  const evidence = evidenceOf(g, s, d.tz);
  switch (target) {
    case "lesson": case "fact": return distillDraft(target, g, s, d, evidence);
    case "skill": return s.recurrence ? { target, draft_json: JSON.stringify({ origin: { turn_ids: s.recurrence.turnIds, category: s.category ?? "other" } }), evidence } : null;
    case "schedule": { const h = s.scheduleHint && d.scheduleHints?.get(s.value); const sd = h ? scheduleDraft(d.store, h, d.now, d.tz) : null; return sd ? { target, ...sd } : null; }
    case "tool_gap": return { target, draft_json: JSON.stringify({ focus: `${s.category ?? "other"} turns fail on ${s.capability ?? s.value} ${s.count14d} times` }), evidence };
    case "ladder": return ladderDraft(s, evidence);
    default: return null; // nothing, knowledge (R5: recorded only)
  }
}

/** R6 / ruling 9: review_bad on an unlocked entry; three or more in 14 days retire the judge, fewer lower the bar. */
function ladderDraft(s: ImproveState, evidence: string): Draft | null {
  if (s.signal !== "review_bad" || LOCKED.has(s.scope)) return null;
  return { target: "ladder", draft_json: JSON.stringify({ entry_id: s.scope, move: s.count14d >= 3 ? "retire_judge" : "lower_bar" }), evidence };
}

/** The prior reply reaches the distill only from a turn whose final trust was clean (codex D11), through the redactor. */
function priorOf(store: RunStore, run_id: string | null, redact: (t: string) => string): string {
  if (!run_id) return "";
  const clean = turnTrustFinal(store, run_id) === "clean"; // final fix B5: the canonical first final event, never any clean one
  return clean ? Array.from(redact(store.assistantTurnTextForRun(run_id) ?? "")).slice(0, PACO_TEXT_CAP).join("") : ""; // capped like Paco's text
}

async function distillDraft(target: "lesson" | "fact", g: SignalGroup, s: ImproveState, d: DraftDeps, evidence: string): Promise<Draft | null> {
  const instruction = s.redacted.pacoText;
  if (instruction.trim().length === 0) return null;
  const prior = priorOf(d.store, g.newest.about_run_id, d.redact);
  const question = buildMemoryDistillQuestion({ thread: [instruction], prior, instruction, scope: lessonScopeFor(s.category), kind: target === "lesson" ? "rule" : "fact" });
  const r = await d.distill({ question, system: MEMORY_DISTILL_DISCIPLINE });
  if (!r.ok) return null;
  const m = parseMemoryDistillResult(r.answer);
  if (m.failed || m.kind === "none") return null;
  return target === "lesson" ? lessonDraft(m, instruction, prior, s, d, evidence) : factDraft(m, instruction, prior, g, d, evidence);
}

/** Final fix A1: the memory lane's own lesson backstop (a rule lifted from the prior is refused, a lifted AVOID dropped). */
function lessonDraft(m: MemoryDistill, instruction: string, prior: string, s: ImproveState, d: DraftDeps, evidence: string): Draft | null {
  const side = checkLessonSide(m, instruction, prior);
  if (!side?.ok) return null;
  // the model's output is durable data too: every stored field goes through the redactor (codex B10)
  return { target: "lesson", draft_json: JSON.stringify({ scope: lessonScopeFor(s.category), text: d.redact(side.lesson), ...(side.avoid ? { avoid: d.redact(side.avoid) } : {}) }), evidence };
}

/**
 * Final fix A1: the memory lane's own fact backstop over the two numbered lines the distill saw (thread [1] and the
 * instruction [2], both Paco's correcting message): quote length, line check, sanitise, reject, support.
 */
function factDraft(m: MemoryDistill, instruction: string, prior: string, g: SignalGroup, d: DraftDeps, evidence: string): Draft | null {
  const runId = g.newest.run_id ?? undefined;
  const turnId = (runId && d.store.userTurnIdForRun(runId)) || `${PENDING_TURN_PREFIX}${runId ?? "none"}`;
  const lines: TranscriptLine[] = [1, 2].map((n) => ({ n, turn: { role: "user" as const, text: instruction, turn_id: turnId, ...(runId ? { run_id: runId } : {}) }, text: instruction }));
  const side = checkFactSide(m, lines, (id) => d.store.runSource(id), { text: instruction, prior });
  if (!side?.ok || !m.evidence) return null;
  // source_turn_ids are chat turn ids (the correcting user turns), never run ids (codex B9)
  const source = g.rows.map((r) => (r.run_id ? d.store.userTurnIdForRun(r.run_id) : undefined)).filter((x): x is string => x !== undefined);
  return { target: "fact", draft_json: JSON.stringify({ text: d.redact(side.fact), evidence: { line: m.evidence.line, quote: d.redact(m.evidence.quote) }, source_turn_ids: source }), evidence };
}
