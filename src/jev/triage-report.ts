import type { CalibrationRow } from "./calibration.js";
import { CATEGORIES, TREE_CATEGORY, TREE_QUESTIONS, type Category } from "./questions/tree.js";
import { JEV_REQUEST_MODEL } from "./jev-client.js";
import { criteriaHash } from "./questions/types.js";
import { TREE_ANSWER_ARM_ID, TREE_LOOKUP_ARM_ID, TREE_STATUS_ARM_ID } from "../decisions/jev-version-check.js";
import { ACK_ROUTE, applyCascade, routeTree, type Armed, type Route, type TreeBars } from "./tree-policy.js";
import { tapLines, type TapLabels } from "./tap-labels.js";
import { treeQuestions, type TreeLabel, type TreeReplayRow } from "./triage-replay.js";
import { wilsonLower } from "./wilson.js";

/**
 * The decision-tree replay report (spec 2026-10-06 §7): evidence for Paco's arm decision, never a verdict. Truth per
 * turn is Paco's label when he gave one, else the tool proxy; unlabelled acks and unmatched-tool turns have no truth and
 * are counted apart. Routes are recomputed from the stored answers through the live policy (`routeTree`) as if every
 * decision were armed, so the bars printed are the bars used. Partial evidence is INCOMPLETE and prints no rows.
 */
export interface TreeReportOutcome {
  spentUsd: number; estimatedUsd: number; stopped?: string;
  universe?: number; wouldDispatch?: number; alreadyDone?: number; skipped?: number; limited?: boolean;
}

/** Stage A's arming (every decision, neither stage B lane): the baseline the stage B lanes are compared against (§10). */
const STAGE_A_ARMED: Armed = { category: true, status: true, memory: true, gear: true, rule: true, answer: false, lookup: false };
const ALL_ARMED: Armed = { ...STAGE_A_ARMED, answer: true, lookup: true };
const SCORE_IDS = ["breadth", "reasoning", "actions"] as const;
/** Categories with a lane in the spec's end state (§3): sending them to the planner costs money, not a turn. */
const LANE_SHAPED: ReadonlySet<Category> = new Set(["answer", "lookup", "memory", "schedule", "wiki", "status"]);
const TRUTHS: ReadonlyArray<Category | null> = [...CATEGORIES, null];

const pct = (a: number, n: number): string => (n === 0 ? "n/a" : `${((100 * a) / n).toFixed(1)}%`);
const lb = (a: number, n: number): string => { const w = wilsonLower(a, n); return w === null ? "LB n/a" : `LB ${(100 * w).toFixed(1)}%`; };
const truthOf = (r: TreeReplayRow, labels: Map<string, TreeLabel>): Category | null => labels.get(r.turn_id)?.category ?? r.proxy;
const truthName = (t: Category | null): string => (t ?? "unlabelled").padEnd(13);
const choiceOf = (r: TreeReplayRow): string | null => { const a = r.answers?.category; return a?.type === "choice" ? a.choice : null; };
const scoreOf = (r: TreeReplayRow, id: string): number | null => { const a = r.answers?.[id]; return a?.type === "score" ? a.score : null; };
/** A correction by its proxy; a human label says `memory`, not which kind, so a `memory` label keeps it (F2) and any
 *  other label overrides it. */
const isCorrection = (r: TreeReplayRow, labels: Map<string, TreeLabel>): boolean => {
  const label = labels.get(r.turn_id);
  return r.proxy_rule === "memory_correct_write" && (label === undefined || label.category === "memory");
};
const tally = (m: Map<string, number>, k: string): void => { m.set(k, (m.get(k) ?? 0) + 1); };
const fmt = (m: Map<string, number>): string => [...m].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ") || "none";

/** Gear from the highest of the three scores at the given bars (spec §2.4); null when a score is missing. */
function gearOf(r: TreeReplayRow, bars: TreeBars): "light" | "standard" | "heavy" | null {
  const s = SCORE_IDS.map((id) => scoreOf(r, id));
  if (s.some((x) => x === null)) return null;
  const m = Math.max(...(s as number[]));
  return m <= bars.gearLight ? "light" : m < bars.gearHeavy ? "standard" : "heavy";
}

/**
 * The route the live policy would take on these answers once armed. The replay makes no model call, so a below-bar plan
 * settles as a FAILED live cascade (Decision 14): `applyCascade(plan, null)`, Default, nothing saved, flagged `cascade`
 * so the report counts the turns a live Tiny call would decide.
 */
export function replayRoute(r: TreeReplayRow, bars: TreeBars, armed: Armed = ALL_ARMED): { route: Route; cascade: boolean } | null {
  if (!r.answers) return null;
  if (r.pre_judge === "ack_answer") return { route: ACK_ROUTE, cascade: false };
  const plan = routeTree(r.answers, { bars, armed, thinkHarder: r.think_harder, bareAck: r.bare_ack });
  return plan.kind === "final" ? { route: plan.route, cascade: false } : { route: applyCascade(plan, null), cascade: true };
}

/** Truth → Jev's `category` choice, one line per truth, and the diagonal over turns that have a truth. */
function confusionLines(ok: TreeReplayRow[], labels: Map<string, TreeLabel>): string[] {
  const out = ["confusion (truth → Jev category; truth = Paco's label, else the tool proxy):"];
  let agree = 0; let n = 0;
  for (const truth of TRUTHS) {
    const L = ok.filter((r) => truthOf(r, labels) === truth);
    if (L.length === 0) continue;
    const cells = new Map<string, number>();
    for (const r of L) tally(cells, choiceOf(r) ?? "?");
    if (truth !== null) { n += L.length; agree += cells.get(truth) ?? 0; }
    out.push(`  ${truthName(truth)} (n=${L.length}): ${fmt(cells)}`);
  }
  out.push(`  agreement on labelled turns: ${agree}/${n} = ${pct(agree, n)} (${lb(agree, n)})`);
  return out;
}

function scoreSummary(id: string, xs: number[]): string {
  if (xs.length === 0) return `${id} n/a`;
  const h = [0, 0, 0, 0];
  for (const x of xs) h[Math.min(3, Math.max(0, Math.round(x)))]! += 1;
  return `${id} ${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2)} [${h.join("/")}]`;
}

/** Per truth: each score's mean and its level histogram, then the gear split it produces. */
function scoreLines(ok: TreeReplayRow[], labels: Map<string, TreeLabel>, bars: TreeBars): string[] {
  const out = ["scores per truth (mean [levels 0/1/2/3]; gear light/standard/heavy):"];
  for (const truth of TRUTHS) {
    const L = ok.filter((r) => truthOf(r, labels) === truth);
    if (L.length === 0) continue;
    const parts = SCORE_IDS.map((id) => scoreSummary(id, L.map((r) => scoreOf(r, id)).filter((x): x is number => x !== null)));
    const g = { light: 0, standard: 0, heavy: 0 };
    for (const r of L) { const k = gearOf(r, bars); if (k) g[k] += 1; }
    out.push(`  ${truthName(truth)} (n=${L.length}): ${parts.join("; ")}; gear ${g.light}/${g.standard}/${g.heavy}`);
  }
  return out;
}

function routeLines(ok: TreeReplayRow[], bars: TreeBars): string[] {
  const lanes = new Map<string, number>(); const reasons = new Map<string, number>(); let cascades = 0;
  for (const r of ok) {
    const x = replayRoute(r, bars);
    if (!x) continue;
    tally(lanes, `${x.route.lane}/${x.route.role}`); tally(reasons, x.route.reason);
    if (x.cascade) cascades += 1;
  }
  return [`routes as if armed (lane/role): ${fmt(lanes)}`,
    `route reasons: ${fmt(reasons)}; below-bar turns a live cascade would ask the Tiny role about (replayed as cascade_failed, no model call): ${cascades}`];
}

/**
 * Arming is coupled (Decision: arming couplings): `memory` needs `category` + `rule`, and `category` alone already moves
 * turns off Default. Paco commits rows per question, so the report shows what each partial commit would change.
 */
const NONE_ARMED: Armed = { category: false, status: false, memory: false, gear: false, rule: false, answer: false, lookup: false };
export const ARMING_COMBOS: ReadonlyArray<{ name: string; armed: Armed }> = [
  { name: "category", armed: { ...NONE_ARMED, category: true } },
  { name: "category+gear", armed: { ...NONE_ARMED, category: true, gear: true } },
  { name: "category+rule", armed: { ...NONE_ARMED, category: true, rule: true, memory: true } },
  { name: "category+rule+status", armed: { ...NONE_ARMED, category: true, rule: true, memory: true, status: true } },
  { name: "all", armed: STAGE_A_ARMED },
  // stage B §10: each lane on top of every stage A decision, then both
  { name: "+answer", armed: { ...STAGE_A_ARMED, answer: true } },
  { name: "+lookup", armed: { ...STAGE_A_ARMED, lookup: true } },
  { name: "+both", armed: ALL_ARMED }
];
const ARMING_IDS_SHOWN = 10;

/**
 * Per combination: turns whose lane/role differs from that turn's own route with nothing armed (the path stage A runs
 * until Paco commits rows: Default, except the ack rule and `think harder`), keyed `from→to`, with their turn ids.
 */
function armingLines(ok: TreeReplayRow[], bars: TreeBars): string[] {
  const out = ["arming combinations (turns whose route changes from the nothing-armed path; from→to [first ids]):"];
  const at = (x: { route: Route } | null): string => (x ? `${x.route.lane}/${x.route.role}` : "none");
  for (const c of ARMING_COMBOS) {
    const moved = new Map<string, string[]>();
    for (const r of ok) {
      const before = at(replayRoute(r, bars, NONE_ARMED)); const after = at(replayRoute(r, bars, c.armed));
      if (before === after) continue;
      const k = `${before}→${after}`;
      moved.set(k, [...(moved.get(k) ?? []), r.turn_id]);
    }
    const parts = [...moved].sort((a, b) => b[1].length - a[1].length)
      .map(([k, ids]) => `${k} ${ids.length} [${ids.slice(0, ARMING_IDS_SHOWN).join(", ")}]`);
    out.push(`  ${c.name}: ${parts.join("; ") || "none"}`);
  }
  return out;
}

type LaneName = "answer" | "lookup";
interface Costly { swallowed: string[]; underPowered: string[]; laneToPlanner: Map<string, number>; unjudged: number;
  laneWrong: Record<LaneName, string[]>; defaultToFast: number }
/** Spec §7's three costly cells, plus stage B §10's: a lane taking another category's turn, and the Default→Fast count. */
function costlyCells(ok: TreeReplayRow[], labels: Map<string, TreeLabel>, bars: TreeBars): Costly {
  const c: Costly = { swallowed: [], underPowered: [], laneToPlanner: new Map(), unjudged: 0, laneWrong: { answer: [], lookup: [] }, defaultToFast: 0 };
  for (const r of ok) {
    const routed = replayRoute(r, bars); const truth = truthOf(r, labels);
    if (!routed) continue;
    const lane = routed.route.lane;
    if (lane === "answer" || lane === "lookup") laneCells(c, r, lane, truth, bars);
    if (truth === null) { if (lane === "memory" || lane === "status") c.unjudged += 1; continue; }
    const wrongMemory = lane === "memory" && (truth !== "memory" || isCorrection(r, labels));
    if (wrongMemory || (lane === "status" && truth !== "status")) c.swallowed.push(r.turn_id);
    if ((truth === "self_change" || truth === "machine_task") && gearOf(r, bars) === "light") c.underPowered.push(r.turn_id);
    if (lane === "planner" && LANE_SHAPED.has(truth) && !isCorrection(r, labels)) tally(c.laneToPlanner, truth);
  }
  return c;
}

/** Stage B §10: a lane that took a turn whose truth is another category, and the lane turns stage A ran on the Default role. */
function laneCells(c: Costly, r: TreeReplayRow, lane: LaneName, truth: Category | null, bars: TreeBars): void {
  if (truth !== null && truth !== lane) c.laneWrong[lane].push(r.turn_id);
  if (replayRoute(r, bars, STAGE_A_ARMED)?.route.role === "default") c.defaultToFast += 1;
}

function costlyLines(c: Costly): string[] {
  const ids = (xs: string[]) => (xs.length === 0 ? "" : ` [${xs.slice(0, 20).join(", ")}${xs.length > 20 ? ", …" : ""}]`);
  const toPlanner = [...c.laneToPlanner.values()].reduce((a, b) => a + b, 0);
  return [
    `COSTLY 1 — wrongly into memory/status (a swallowed turn): ${c.swallowed.length}${ids(c.swallowed)}`,
    `COSTLY 2 — self_change / machine_task rated light (under-powered): ${c.underPowered.length}${ids(c.underPowered)}`,
    `COSTLY 3 — lane-shaped turns sent to the planner (cost only): ${toPlanner} (${fmt(c.laneToPlanner)})`,
    `  memory/status routes on unlabelled turns (cannot judge; label them): ${c.unjudged}`,
    `COSTLY 4 — a lane took a turn whose truth is another category (a weaker reply; Dig deeper recovers): answer ${c.laneWrong.answer.length}${ids(c.laneWrong.answer)}; ` +
      `lookup ${c.laneWrong.lookup.length}${ids(c.laneWrong.lookup)}`,
    `  lane turns that ran the planner on Default under stage A (now Fast): ${c.defaultToFast}`
  ];
}

/** Order bias: the same turns with `category` reversed; agreement of the category choice. */
function permutationLine(ok: TreeReplayRow[], permuted: TreeReplayRow[] | undefined): string {
  if (!permuted) return "permutation: NOT RUN (houge jev replay triage --permute)";
  const perm = new Map(permuted.filter((r) => r.status === "ok").map((r) => [r.turn_id, r]));
  const pairs = ok.filter((r) => perm.has(r.turn_id)).map((r) => [r, perm.get(r.turn_id)!] as const);
  const same = pairs.filter(([a, b]) => choiceOf(a) === choiceOf(b)).length;
  return `permutation: category agreement ${same}/${pairs.length} = ${pct(same, pairs.length)} (${lb(same, pairs.length)})`;
}

const hashesOf = (permute: boolean): Record<string, string> => Object.fromEntries(treeQuestions(permute).map((q) => [q.id, criteriaHash(q)]));
const stale = (r: TreeReplayRow, want: Record<string, string>): boolean => Object.entries(want).some(([id, h]) => r.criteria_hashes?.[id] !== h);

/** Everything that makes the evidence partial: any one → INCOMPLETE, no rows. */
function blockersOf(rows: TreeReplayRow[], ok: TreeReplayRow[], o: TreeReportOutcome, permuted?: TreeReplayRow[]): string[] {
  const b: string[] = [];
  if (o.stopped) b.push(`stopped: ${o.stopped}`);
  if (o.limited) b.push("--limit set: not the full universe");
  const finished = rows.filter((r) => r.status === "ok" || r.status === "skipped_state_too_large").length;
  if (o.universe === undefined) b.push("universe size unknown");
  else if (finished < o.universe) b.push(`${finished} of ${o.universe} turns finished`);
  const failed = rows.filter((r) => r.status === "jev_failed").length;
  if (failed > 0) b.push(`${failed} jev_failed row(s): re-run to retry them`);
  const permOk = (permuted ?? []).filter((r) => r.status === "ok");
  const models = reportedModels([...ok, ...permOk]);
  if (models.length > 1) b.push(`more than one reported model (${models.join(", ")}): re-run into a fresh file`);
  if (models.includes(JEV_REQUEST_MODEL)) b.push(`rows reported the request alias ${JEV_REQUEST_MODEL}, not a versioned model: the evidence would not name the model it measured`);
  if (ok.some((r) => stale(r, hashesOf(false))) || permOk.some((r) => stale(r, hashesOf(true)))) b.push("rows asked with stale criteria wording: re-run into a fresh file");
  const covered = new Set(permOk.map((r) => r.turn_id));
  if (!permuted) b.push("permuted run missing");
  else if (ok.some((r) => !covered.has(r.turn_id))) b.push("permuted run does not cover every replayed turn");
  return b;
}

/** Every model the ok rows REPORTED, sorted. The request names the alias `jev-latest`, so the rows, not a constant, say
 *  which model the evidence is for; more than one means the alias moved mid-replay (a blocker). */
const reportedModels = (rows: TreeReplayRow[]): string[] =>
  [...new Set(rows.filter((r) => r.status === "ok" && r.model !== undefined).map((r) => r.model!))].sort();

/** Candidate rows for the six questions and the three lane pseudo-rows (status, answer, lookup), per language present,
 *  (a row's key is question, hash and language: no model); Paco fills `approved`. */
function candidateRows(ok: TreeReplayRow[]): string[] {
  const pseudo = [TREE_STATUS_ARM_ID, TREE_ANSWER_ARM_ID, TREE_LOOKUP_ARM_ID].map((id) => [id, criteriaHash(TREE_CATEGORY)] as const);
  const ids = [...TREE_QUESTIONS.map((q) => [q.id, criteriaHash(q)] as const), ...pseudo];
  const out = ["CANDIDATE ROWS — evidence for Paco's decision, not a verdict; he fills `approved` and commits them into CALIBRATED_ROWS (src/jev/calibration.ts):"];
  for (const lang of ["zh", "en"] as const) {
    const n = ok.filter((r) => (r.lang === "en" ? "en" : "zh") === lang).length; // `mixed` inherits zh (calibratedLang)
    if (n === 0) continue;
    for (const [question_id, criteria_hash] of ids) {
      const row: CalibrationRow = { question_id, criteria_hash, lang, approved: "", evidence: `tree replay ${n} ${lang} turns` };
      out.push(JSON.stringify(row));
    }
  }
  return out;
}

function headLine(ok: TreeReplayRow[], labels: Map<string, TreeLabel>): string {
  const en = ok.filter((r) => r.lang === "en").length;
  const human = ok.filter((r) => labels.has(r.turn_id)).length;
  const tapped = ok.filter((r) => labels.get(r.turn_id)?.by === "tap").length;
  const none = ok.filter((r) => truthOf(r, labels) === null).length;
  return `turns: ${ok.length} replayed (zh incl. mixed ${ok.length - en}, en ${en}); ${human} carry Paco's label${tapped > 0 ? ` (${tapped} from a ✅ tap)` : ""}; ${none} without a truth (ack after a proposal, unmatched tools)`;
}

export function formatTreeReport(rows: TreeReplayRow[], labels: Map<string, TreeLabel>, outcome: TreeReportOutcome, bars: TreeBars,
  permuted?: TreeReplayRow[], taps?: TapLabels): string {
  if (rows.some((r) => r.status === "dry_run")) {
    return `DRY RUN — universe ${outcome.universe ?? "?"}, would dispatch ${outcome.wouldDispatch ?? "?"}, already done ${outcome.alreadyDone ?? "?"}, ` +
      `skipped ${outcome.skipped ?? "?"}; est. $${outcome.estimatedUsd.toFixed(3)}; nothing dispatched, no evidence.`;
  }
  const ok = rows.filter((r) => r.status === "ok");
  const blockers = blockersOf(rows, ok, outcome, permuted);
  const out = blockers.length > 0 ? [`INCOMPLETE — ${blockers.join("; ")}. The numbers below are NOT evidence for arming.`] : [];
  out.push(headLine(ok, labels), ...confusionLines(ok, labels), ...scoreLines(ok, labels, bars), ...routeLines(ok, bars), ...armingLines(ok, bars),
    ...costlyLines(costlyCells(ok, labels, bars)), permutationLine(ok, permuted), ...(taps && taps.evidence.length > 0 ? tapLines(taps) : []));
  out.push(`bars: choice ≥ ${bars.choice}, memory ≥ ${bars.memory}, status ≥ ${bars.status}, conf ≥ ${bars.minConf}, gap ≥ ${bars.minGap}, ` +
    `rule yes ≥ ${bars.nounYes} / no ≤ ${bars.nounNo}, rule_scope ≥ ${bars.ruleScope}, gear light ≤ ${bars.gearLight} / heavy ≥ ${bars.gearHeavy}`);
  out.push(`spent $${outcome.spentUsd.toFixed(3)} of est. $${outcome.estimatedUsd.toFixed(3)}`);
  out.push(...(blockers.length === 0 ? candidateRows(ok) : [`NO ROWS — ${blockers.join("; ")}`]));
  return out.join("\n");
}
