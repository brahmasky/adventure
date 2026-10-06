import type { CalibrationRow } from "./calibration.js";
import { JEV_MODEL } from "./jev-client.js";
import { TRIAGE_LANE, TRIAGE_QUESTIONS } from "./questions/triage.js";
import { criteriaHash } from "./questions/types.js";
import { TRIAGE_STATUS_ARM_ID, type TriageBars } from "./thresholds.js";
import { replayVerdict, TRIAGE_LANE_PERMUTED, type TriageLabel, type TriageReplayRow, type TriageReplayVerdict } from "./triage-replay.js";
import { wilsonLower } from "./wilson.js";

/**
 * The lane 1 calibration report (spec §5.9). Paco's arm decision is made from this text, so the verdict logic is strict:
 * evidence that is partial, unlabelled, stale or missing is INCOMPLETE, never a quiet pass; "ROWS TO ADD" appears only
 * when every bar holds. Agreement over all turns is never a headline: ~250 `none` turns would hide the positive class.
 * Verdicts are recomputed from the row's numbers at `bars` through the live gate, so the bars printed are the bars used.
 */
export interface TriageShadowStats {
  days: number; matched_lesson_write: number; pure_on_tool_turns: number; pure_on_no_tool_turns: number;
  /** `jev_decisions.state_hash` of the live shadow `lane` rows: the state-parity check against the replay. */
  live_state_hashes?: string[];
}
export interface TriageReportOutcome {
  spentUsd: number; estimatedUsd: number; stopped?: string;
  universe?: number; wouldDispatch?: number; alreadyDone?: number; skipped?: number; limited?: boolean;
}

/** §5.9 step 3 / step 4 bars. Recall and precision gate on the point estimate; the Wilson bound is printed beside it. */
export const TRIAGE_GO = { recall: 0.8, precision: 0.85, coverage: 0.5, statusPrecision: 1, statusMinN: 5, shadowDays: 14, shadowMatched: 5 } as const;
const SWEEP = [0.5, 0.6, 0.7, 0.8, 0.9] as const;
const CAL_LANGS = ["zh", "en"] as const;
type CalLang = (typeof CAL_LANGS)[number];

const pct = (a: number, n: number): string => (n === 0 ? "n/a" : `${((100 * a) / n).toFixed(1)}%`);
const lb = (a: number, n: number): string => { const w = wilsonLower(a, n); return w === null ? "LB n/a" : `LB ${(100 * w).toFixed(1)}%`; };
const line = (label: string, a: number, n: number): string => `  ${label}: ${a}/${n} = ${pct(a, n)} (${lb(a, n)})`;
const calLang = (r: TriageReplayRow): CalLang => (r.lang === "en" ? "en" : "zh"); // `mixed` inherits zh (spec §3.4)

/** The live gate's verdict on the row's stored numbers at `bars`. */
function verdictAt(r: TriageReplayRow, bars: TriageBars): TriageReplayVerdict {
  const pPure = r.p_pure ?? 0; const scope = r.scope ?? "ask";
  return replayVerdict({
    lane: { choice: r.jev_lane ?? "none", probabilities: { none: r.p_none ?? 0, status: r.p_status ?? 0, memory: r.p_memory ?? 0 }, confidence: r.conf_lane ?? 0 },
    complete: { choice: pPure >= 0.5 ? "pure" : "mixed", probabilities: { mixed: 1 - pPure, pure: pPure }, confidence: Math.abs(2 * pPure - 1) },
    scope: { choice: scope, probabilities: { [scope]: 1 }, confidence: 1 }
  }, bars, r.lang, r.model ?? JEV_MODEL);
}
const isMemory = (v: TriageReplayVerdict): boolean => v === "memory_pure" || v === "memory_mixed";
/** Must carry Paco's label: every observed lesson_write, every memory/status choice at any confidence, and every memory/status
 *  verdict at `bars` (a low HOUGE_JEV_TRIAGE_MIN_STATUS must not let an unlabelled status verdict act). */
const required = (r: TriageReplayRow, bars: TriageBars): boolean =>
  r.observed_lesson_write || r.jev_lane === "memory" || r.jev_lane === "status" || verdictAt(r, bars) !== "fallthrough";

interface Costly { tool: number; noTool: number; noToolConfirmed: number; human: number }
function costlyCells(rows: TriageReplayRow[], labels: Map<string, TriageLabel>, bars: TriageBars): Costly {
  const pure = rows.filter((r) => verdictAt(r, bars) === "memory_pure");
  const confirmed = (r: TriageReplayRow) => { const l = labels.get(r.turn_id); return l?.memory === true && l.pure === true; };
  const noTool = pure.filter((r) => !r.observed_lesson_write && !r.observed_other_tools);
  return { tool: pure.filter((r) => r.observed_other_tools).length, noTool: noTool.length, noToolConfirmed: noTool.filter(confirmed).length,
    human: pure.filter((r) => labels.has(r.turn_id) && !confirmed(r)).length };
}
const costlyOk = (c: Costly): boolean => c.tool === 0 && c.human === 0 && c.noTool === c.noToolConfirmed;

/** Memory and status arm on separate rows (thresholds.ts TRIAGE_STATUS_ARM_ID), so their bars are judged separately. */
interface LangEvidence { lines: string[]; failures: string[]; statusFailures: string[]; summary: string }

/** One calibration language: the per-class lines with n and Wilson bounds, and every §5.9 step 3 bar it fails. */
function langEvidence(lang: CalLang, L: TriageReplayRow[], labels: Map<string, TriageLabel>, bars: TriageBars): LangEvidence {
  const v = new Map(L.map((r) => [r.turn_id, verdictAt(r, bars)]));
  const chose = (r: TriageReplayRow) => r.jev_lane === "memory";
  const confident = (r: TriageReplayRow) => isMemory(v.get(r.turn_id)!);
  const proxy = L.filter((r) => r.observed_lesson_write); const human = L.filter((r) => labels.get(r.turn_id)?.memory === true);
  const memV = L.filter((r) => confident(r) && labels.has(r.turn_id)); const memOk = memV.filter((r) => labels.get(r.turn_id)!.memory);
  const stV = L.filter((r) => v.get(r.turn_id) === "status" && labels.has(r.turn_id)); const stOk = stV.filter((r) => labels.get(r.turn_id)!.status);
  const noneSample = L.filter((r) => !required(r, bars) && labels.has(r.turn_id)).length;
  const c = costlyCells(L, labels, bars);
  const counts = { rp: proxy.filter(chose).length, rh: human.filter(chose).length, cov: human.filter(confident).length };
  const failures: string[] = [];
  const bar = (name: string, a: number, n: number, min: number) => { if (n === 0) failures.push(`${name} n = 0`); else if (a / n < min) failures.push(`${name} ${pct(a, n)} < ${min}`); };
  bar("recall (action proxy)", counts.rp, proxy.length, TRIAGE_GO.recall); bar("recall (human)", counts.rh, human.length, TRIAGE_GO.recall);
  bar("precision (human)", memOk.length, memV.length, TRIAGE_GO.precision); bar("coverage", counts.cov, human.length, TRIAGE_GO.coverage);
  const statusFailures = stV.length < TRIAGE_GO.statusMinN || stOk.length < stV.length ? [`status precision ${stOk.length}/${stV.length} (needs 1.0 on n ≥ ${TRIAGE_GO.statusMinN})`] : [];
  if (noneSample === 0) failures.push("labelled `none` sample n = 0");
  if (!costlyOk(c)) failures.push("costly cells non-zero");
  const lines = [`${lang}${lang === "zh" ? " (incl. mixed)" : ""}: ${L.length} turns`,
    line("recall (action proxy, Jev chose memory at any confidence)", counts.rp, proxy.length),
    line("recall (human, Jev chose memory at any confidence)", counts.rh, human.length),
    line("precision (human, confident memory verdicts)", memOk.length, memV.length),
    line("coverage of human positives (confident verdicts)", counts.cov, human.length),
    line("status precision (human, status verdicts)", stOk.length, stV.length),
    `  labelled none sample: n = ${noneSample}`,
    `  COSTLY: pure on tool-using turns: ${c.tool}; pure on NO-tool turns: ${c.noTool} (${c.noToolConfirmed} human-confirmed memory+pure); pure on human-labelled not-pure: ${c.human}`];
  const summary = `n=${L.length} recall proxy ${counts.rp}/${proxy.length} human ${counts.rh}/${human.length} precision ${memOk.length}/${memV.length} status ${stOk.length}/${stV.length}`;
  return { lines, failures, statusFailures, summary };
}

/** Coverage and the two costly cells as one bar moves 0.5…0.9 with the others held (spec §3.6). */
function sweepLines(L: TriageReplayRow[], labels: Map<string, TriageLabel>, bars: TriageBars): string[] {
  const human = L.filter((r) => labels.get(r.turn_id)?.memory === true);
  const out: string[] = [];
  for (const [name, key] of [["p(memory)", "minMemory"], ["p(pure)", "minPure"]] as const) {
    for (const t of SWEEP) {
      const b: TriageBars = { ...bars, [key]: t };
      const cov = human.filter((r) => isMemory(verdictAt(r, b))).length; const c = costlyCells(L, labels, b);
      out.push(`  sweep ${name} ≥ ${t.toFixed(1)}: coverage ${cov}/${human.length} = ${pct(cov, human.length)}; pure on tool-using ${c.tool}; pure on human-labelled not-pure ${c.human}`);
    }
  }
  return out;
}

/** Verdict × observed planner action (spec §3.6 confusion matrix). */
function confusionLines(L: TriageReplayRow[], bars: TriageBars): string[] {
  const col = (r: TriageReplayRow) => (r.observed_other_tools ? 1 : r.observed_lesson_write ? 0 : 2);
  const out = ["  verdict        | lesson_write-only | other tools | no tools"];
  for (const verdict of ["status", "memory_pure", "memory_mixed", "fallthrough"] as const) {
    const n = [0, 0, 0];
    for (const r of L) if (verdictAt(r, bars) === verdict) n[col(r)]! += 1;
    out.push(`  ${verdict.padEnd(14)} | ${String(n[0]).padStart(17)} | ${String(n[1]).padStart(11)} | ${String(n[2]).padStart(8)}`);
  }
  return out;
}

/** Order bias (spec §3.6): the same turns asked with `lane` reversed; verdict equality at `bars`, and raw lane-choice equality. */
function permutationLine(ok: TriageReplayRow[], permuted: TriageReplayRow[] | undefined, bars: TriageBars): string {
  if (!permuted) return "permutation: NOT RUN (houge jev replay triage --permute)";
  const perm = new Map(permuted.filter((r) => r.status === "ok").map((r) => [r.turn_id, r]));
  const pairs = ok.filter((r) => perm.has(r.turn_id)).map((r) => [r, perm.get(r.turn_id)!] as const);
  const same = pairs.filter(([a, b]) => verdictAt(a, bars) === verdictAt(b, bars)).length;
  const lane = pairs.filter(([a, b]) => a.jev_lane === b.jev_lane).length;
  return `permutation: verdict agreement ${same}/${pairs.length} = ${pct(same, pairs.length)} (${lb(same, pairs.length)}); lane-choice agreement ${lane}/${pairs.length}`;
}

/** Everything that makes the evidence partial: any one → INCOMPLETE, no rows. */
function blockersOf(rows: TriageReplayRow[], ok: TriageReplayRow[], labels: Map<string, TriageLabel>, o: TriageReportOutcome, bars: TriageBars, permuted?: TriageReplayRow[]): string[] {
  const b: string[] = [];
  if (o.stopped) b.push(`stopped: ${o.stopped}`);
  if (o.limited) b.push("--limit set: not the full universe");
  const finished = rows.filter((r) => r.status === "ok" || r.status === "skipped_state_too_large").length;
  if (o.universe === undefined) b.push("universe size unknown");
  else if (finished < o.universe) b.push(`${finished} of ${o.universe} turns finished`);
  const failed = rows.filter((r) => r.status === "jev_failed").length;
  if (failed > 0) b.push(`${failed} jev_failed row(s): re-run to retry them`);
  const unlabelled = ok.filter((r) => required(r, bars) && !labels.has(r.turn_id)).length;
  if (unlabelled > 0) b.push(`${unlabelled} required turn(s) unlabelled (every observed lesson_write, every memory/status verdict)`);
  if (ok.some((r) => r.model !== JEV_MODEL)) b.push(`rows from a model other than ${JEV_MODEL}`);
  const stale = ok.some((r) => r.criteria_hash_lane !== criteriaHash(TRIAGE_LANE))
    || (permuted ?? []).some((r) => r.status === "ok" && r.criteria_hash_lane !== criteriaHash(TRIAGE_LANE_PERMUTED));
  if (stale) b.push("rows asked with stale criteria wording: re-run into a fresh file");
  const permOk = new Set((permuted ?? []).filter((r) => r.status === "ok").map((r) => r.turn_id));
  if (!permuted) b.push("permuted run missing");
  else if (ok.some((r) => !permOk.has(r.turn_id))) b.push("permuted run does not cover every replayed turn");
  return b;
}

/** §5.9 step 4: the live shadow is a false-positive watch; without its numbers there is no arm. */
function shadowLines(shadow: TriageShadowStats | undefined, rows: TriageReplayRow[]): { lines: string[]; failures: string[] } {
  if (!shadow) return { lines: ["live shadow: NOT SUPPLIED"], failures: ["live shadow stats not supplied"] };
  const failures: string[] = [];
  if (shadow.days < TRIAGE_GO.shadowDays) failures.push(`shadow ${shadow.days} days < ${TRIAGE_GO.shadowDays}`);
  if (shadow.matched_lesson_write < TRIAGE_GO.shadowMatched) failures.push(`matched lesson_write ${shadow.matched_lesson_write} < ${TRIAGE_GO.shadowMatched}`);
  if (shadow.pure_on_tool_turns > 0 || shadow.pure_on_no_tool_turns > 0) failures.push("shadow pure verdicts on tool / no-tool turns");
  const lines = [`live shadow: ${shadow.days} days (≥ ${TRIAGE_GO.shadowDays}); matched lesson_write ${shadow.matched_lesson_write} (≥ ${TRIAGE_GO.shadowMatched}); ` +
    `pure on other-tool turns ${shadow.pure_on_tool_turns} (= 0); pure on no-tool turns ${shadow.pure_on_no_tool_turns} (= 0)`];
  if (shadow.live_state_hashes) {
    const replayed = new Set(rows.map((r) => r.state_hash));
    const miss = shadow.live_state_hashes.filter((h) => !replayed.has(h)).length;
    lines.push(`live rows with no replay state match: ${miss} of ${shadow.live_state_hashes.length} (a broker-redacted turn hashes differently; spec state-parity note)`);
  }
  return { lines, failures };
}

/** Memory rows (lane, complete, scope) when the memory bars hold; the `lane:status` row only when the status bar holds. */
function rowsToAdd(evidence: Map<CalLang, LangEvidence>): string[] {
  const out: string[] = [];
  for (const [lang, e] of evidence) {
    const ids: Array<readonly [string, string]> = e.failures.length === 0 ? TRIAGE_QUESTIONS.map((q) => [q.id, criteriaHash(q)] as const) : [];
    if (e.statusFailures.length === 0) ids.push([TRIAGE_STATUS_ARM_ID, criteriaHash(TRIAGE_LANE)]);
    for (const [question_id, criteria_hash] of ids) {
      const r: CalibrationRow = { question_id, criteria_hash, model: JEV_MODEL, lang, approved: "", evidence: `lane 1 replay ${e.summary}` };
      out.push(JSON.stringify(r));
    }
  }
  return out.length === 0 ? [] : ["ROWS TO ADD — Paco's commit into CALIBRATED_ROWS (src/jev/calibration.ts); `approved` is his date:", ...out];
}

export function formatTriageReport(rows: TriageReplayRow[], labels: Map<string, TriageLabel>, outcome: TriageReportOutcome, bars: TriageBars,
  permuted?: TriageReplayRow[], shadow?: TriageShadowStats): string {
  if (rows.some((r) => r.status === "dry_run")) {
    return `DRY RUN — universe ${outcome.universe ?? "?"}, would dispatch ${outcome.wouldDispatch ?? "?"}, already done ${outcome.alreadyDone ?? "?"}, ` +
      `skipped ${outcome.skipped ?? "?"}; est. $${outcome.estimatedUsd.toFixed(3)}; nothing dispatched, no verdict.`;
  }
  const ok = rows.filter((r) => r.status === "ok");
  const blockers = blockersOf(rows, ok, labels, outcome, bars, permuted);
  const sh = shadowLines(shadow, rows);
  const out: string[] = blockers.length > 0 ? [`INCOMPLETE — ${blockers.join("; ")}. The numbers below are NOT a verdict.`] : [];
  const evidence = new Map<CalLang, LangEvidence>();
  for (const lang of CAL_LANGS) {
    const L = ok.filter((r) => calLang(r) === lang); if (L.length === 0) continue;
    const e = langEvidence(lang, L, labels, bars); evidence.set(lang, e);
    out.push(...e.lines, ...sweepLines(L, labels, bars), ...confusionLines(L, bars));
    out.push(e.failures.length === 0 ? `  ${lang} memory: every §5.9 replay bar holds` : `  ${lang} memory: NO-GO — ${e.failures.join("; ")}`);
    out.push(e.statusFailures.length === 0 ? `  ${lang} status: bar holds` : `  ${lang} status: NO-GO (stays shadow) — ${e.statusFailures.join("; ")}`);
  }
  out.push(permutationLine(ok, permuted, bars), ...sh.lines);
  out.push(`bars: conf ≥ ${bars.minConf}, p(memory) ≥ ${bars.minMemory}, gap ≥ ${bars.minGap}, p(pure) ≥ ${bars.minPure}, p(status) ≥ ${bars.minStatus}`);
  out.push(`spent $${outcome.spentUsd.toFixed(3)} of est. $${outcome.estimatedUsd.toFixed(3)}`);
  const add = blockers.length === 0 && sh.failures.length === 0 ? rowsToAdd(evidence) : [];
  if (add.length > 0) out.push(...add);
  else out.push(`STOP / NO-GO — no rows: ${[...blockers, ...sh.failures, ...(blockers.length + sh.failures.length === 0 ? ["no language clears the memory or the status bars"] : [])].join("; ")}`);
  return out.join("\n");
}
