import { describe, expect, it } from "vitest";
import { TREE_QUESTIONS } from "../../src/jev/questions/tree.js";
import { criteriaHash } from "../../src/jev/questions/types.js";
import { TREE_BAR_DEFAULTS } from "../../src/jev/tree-policy.js";
import { ARMING_COMBOS, formatTreeReport, replayRoute } from "../../src/jev/triage-report.js";
import { TREE_CATEGORY_PERMUTED, type TreeLabel, type TreeReplayRow } from "../../src/jev/triage-replay.js";
import { treeAnswers } from "../helpers/jev-tree-answers.js";

/** The versioned id Jev reports (the request names the alias `jev-latest`; rows and calibration key on the reported id). */
const REPORTED = "jev-1.13.0";
const HASHES = Object.fromEntries(TREE_QUESTIONS.map((q) => [q.id, criteriaHash(q)]));
const row = (turn_id: string, o: Partial<TreeReplayRow> = {}): TreeReplayRow => ({ key: turn_id, turn_id, run_id: `r${turn_id}`, lang: "zh", status: "ok",
  est_usd: 0, state_hash: "h", tools: {}, proxy: "answer", proxy_rule: "no_tool", pre_judge: "judge", think_harder: false, bare_ack: false, quoted: false,
  model: REPORTED, criteria_hashes: HASHES, answers: treeAnswers({ category: "answer" }), ...o });
const perm = (rows: TreeReplayRow[]) => rows.map((r) => ({ ...r, key: `${r.key}:perm`, criteria_hashes: { ...HASHES, category: criteriaHash(TREE_CATEGORY_PERMUTED) } }));
/** A row Jev never answered (exactOptionalPropertyTypes forbids `answers: undefined`, so the key is dropped). */
const bare = (r: TreeReplayRow): TreeReplayRow => { const { answers: _a, ...rest } = r; return rest; };
const label = (category: TreeLabel["category"]): TreeLabel => ({ category, by: "paco", at: "2026-10-08T00:00:00.000Z" });

/** One turn per costly cell plus two clean ones (spec §7's three costly cells). */
function fixture(): TreeReplayRow[] {
  return [
    row("a", { tools: { lesson_write: 1 }, proxy: "memory", proxy_rule: "lesson_write", answers: treeAnswers({ category: "memory", setsRule: 0.95 }) }), // clean: memory lane
    row("b", { tools: { web_search: 1 }, proxy: "lookup", proxy_rule: "lookup", answers: treeAnswers({ category: "memory", setsRule: 0.95 }) }), // swallowed
    row("c", { tools: { shell: 2 }, proxy: "machine_task", proxy_rule: "machine_task",
      answers: treeAnswers({ category: "machine_task", breadth: 0, reasoning: 0, actions: 0 }) }), // under-powered (rated light)
    row("d"), // lane-shaped `answer` sent to the planner (stage A has no answer lane): cost only
    row("e", { proxy: null, proxy_rule: "ack_after_proposal", answers: treeAnswers({ category: "status" }) }), // status on an unlabelled turn
    row("f", { tools: { web_search: 4 }, proxy: "research", proxy_rule: "research",
      answers: treeAnswers({ category: "research", breadth: 3, reasoning: 3, actions: 2 }) }) // clean: planner, heavy
  ];
}
const complete = (rows: TreeReplayRow[]) => ({ spentUsd: 0.01, estimatedUsd: 0.01, universe: rows.length });

describe("replayRoute", () => {
  // The report's costly cells are only as true as the route: it must be the live policy's (routeTree), as if armed.
  it("routes through the live policy as if armed; an ack-rule turn is answer/Fast without the judge", () => {
    expect(replayRoute(row("a", { answers: treeAnswers({ category: "memory", setsRule: 0.95 }) }), TREE_BAR_DEFAULTS)?.route.lane).toBe("memory");
    expect(replayRoute(row("x", { pre_judge: "ack_answer" }), TREE_BAR_DEFAULTS)?.route).toMatchObject({ category: "answer", role: "fast", reason: "ack_rule" });
    expect(replayRoute(bare(row("y")), TREE_BAR_DEFAULTS)).toBeNull();
  });
  // Decision 14: live, a below-bar turn asks the Tiny role; the replay makes no model call, so it shows the live failure
  // semantics (Default, nothing saved) and flags the turn, never a guessed pick that would flatter the report.
  it("a below-bar plan replays as a failed live cascade: cascade_failed on Default, nothing saved, flagged", () => {
    expect(replayRoute(row("c", { answers: treeAnswers({ category: "lookup", p: 0.5, setsRule: 0.95 }) }), TREE_BAR_DEFAULTS))
      .toMatchObject({ cascade: true, route: { reason: "cascade_failed", lane: "planner", role: "default", save: null } });
  });
});

describe("formatTreeReport", () => {
  it("prints the category confusion matrix against the tool proxy, with agreement over labelled turns", () => {
    const rows = fixture();
    const text = formatTreeReport(rows, new Map(), complete(rows), TREE_BAR_DEFAULTS, perm(rows));
    expect(text).toMatch(/lookup\s+\(n=1\): memory 1/);
    expect(text).toMatch(/unlabelled\s+\(n=1\): status 1/);
    expect(text).toMatch(/agreement on labelled turns: 4\/5/); // a, c, d, f agree; b does not; e has no truth
  });

  it("prints score distributions per proxy category", () => {
    const rows = fixture();
    const text = formatTreeReport(rows, new Map(), complete(rows), TREE_BAR_DEFAULTS, perm(rows));
    expect(text).toMatch(/research\s+\(n=1\): breadth 3\.00 \[0\/0\/0\/1\]; reasoning 3\.00 \[0\/0\/0\/1\]; actions 2\.00 \[0\/0\/1\/0\]; gear 0\/0\/1/);
    expect(text).toMatch(/machine_task\s+\(n=1\): breadth 0\.00 \[1\/0\/0\/0\]/);
  });

  // Spec §7: the three costly cells decide whether a wrong route costs Paco a turn, power, or only money.
  it("counts the three costly cells and names the turns of the first two", () => {
    const rows = fixture();
    const text = formatTreeReport(rows, new Map(), complete(rows), TREE_BAR_DEFAULTS, perm(rows));
    expect(text).toMatch(/COSTLY 1 — wrongly into memory\/status \(a swallowed turn\): 1 \[b\]/);
    expect(text).toMatch(/COSTLY 2 — self_change \/ machine_task rated light \(under-powered\): 1 \[c\]/);
    expect(text).toMatch(/COSTLY 3 — lane-shaped turns sent to the planner \(cost only\): 1 \(answer 1\)/);
    expect(text).toMatch(/memory\/status routes on unlabelled turns \(cannot judge; label them\): 1/);
  });

  // Paco commits calibration rows per question; arming `category` alone already moves turns off Default. The report must
  // show each partial commit's effect before he chooses (Codex round 2, blocker 2).
  it("prints one line per arming combination, naming the turns that leave planner/default", () => {
    const rows = fixture();
    const text = formatTreeReport(rows, new Map(), complete(rows), TREE_BAR_DEFAULTS, perm(rows));
    expect(text).toMatch(/arming combinations \(turns whose route changes from the nothing-armed path; from→to \[first ids\]\):/);
    for (const c of ARMING_COMBOS) expect(text).toMatch(new RegExp(`^  ${c.name.replace(/\+/g, "\\+")}: `, "m"));
    // memory needs category + rule: the category-only line can never route a turn into the memory lane
    expect(text).not.toMatch(/^  category: .*→memory\//m);
    // turn b is the fixture's swallowed turn (COSTLY 1): fully armed, it leaves Default for a no-planner lane, named by id
    expect(text).toMatch(/^  all: .*planner\/default→(memory|status)\/\w+ \d+ \[[^\]]*\bb\b/m);
  });

  // The labelling CLI exists to correct the proxy: Paco's label wins over the tool proxy.
  it("a human label overrides the proxy as the truth", () => {
    const rows = fixture();
    const text = formatTreeReport(rows, new Map([["b", label("memory")]]), complete(rows), TREE_BAR_DEFAULTS, perm(rows));
    expect(text).toMatch(/COSTLY 1 — wrongly into memory\/status \(a swallowed turn\): 0/);
    expect(text).toMatch(/1 carry Paco's label/);
  });

  it("prints permutation agreement over the category choice, with n and the Wilson bound", () => {
    const rows = fixture();
    const p = perm(rows); p[0] = { ...p[0]!, answers: treeAnswers({ category: "answer" }) };
    expect(formatTreeReport(rows, new Map(), complete(rows), TREE_BAR_DEFAULTS, p)).toMatch(/permutation: category agreement 5\/6 = 83\.3% \(LB \d/);
    expect(formatTreeReport(rows, new Map(), complete(rows), TREE_BAR_DEFAULTS)).toMatch(/permutation: NOT RUN/);
  });

  // Lessons: a partial run is never evidence. Each blocker alone suppresses the candidate rows.
  it("is INCOMPLETE without the permuted run, on a stop, a failed row, a short universe, stale wording or another model", () => {
    const rows = fixture();
    const blocked = (text: string) => { expect(text).toMatch(/^INCOMPLETE/); expect(text).not.toMatch(/CANDIDATE ROWS/); };
    blocked(formatTreeReport(rows, new Map(), complete(rows), TREE_BAR_DEFAULTS));
    blocked(formatTreeReport(rows, new Map(), { ...complete(rows), stopped: "budget" }, TREE_BAR_DEFAULTS, perm(rows)));
    blocked(formatTreeReport([...rows, bare(row("z", { status: "jev_failed" }))], new Map(), { ...complete(rows), universe: 7 }, TREE_BAR_DEFAULTS, perm(rows)));
    blocked(formatTreeReport(rows, new Map(), { ...complete(rows), universe: 9 }, TREE_BAR_DEFAULTS, perm(rows)));
    const stale = rows.map((r, i) => (i === 0 ? { ...r, criteria_hashes: { ...HASHES, breadth: "old" } } : r));
    blocked(formatTreeReport(stale, new Map(), complete(rows), TREE_BAR_DEFAULTS, perm(rows)));
    const other = rows.map((r, i) => (i === 0 ? { ...r, model: "jev-0.9" } : r));
    blocked(formatTreeReport(other, new Map(), complete(rows), TREE_BAR_DEFAULTS, perm(rows)));
    // the alias moved between the canonical and the permuted run: two models' evidence never combine
    blocked(formatTreeReport(rows, new Map(), complete(rows), TREE_BAR_DEFAULTS, perm(rows).map((r) => ({ ...r, model: "jev-1.14.0" }))));
  });

  it("a complete run prints candidate calibration rows for the six questions and the status pseudo-row, approved left empty", () => {
    const rows = fixture();
    const text = formatTreeReport(rows, new Map(), complete(rows), TREE_BAR_DEFAULTS, perm(rows));
    expect(text).not.toMatch(/INCOMPLETE/);
    expect(text).toMatch(/CANDIDATE ROWS — evidence for Paco's decision, not a verdict/);
    for (const q of TREE_QUESTIONS) expect(text).toContain(`"question_id":"${q.id}","criteria_hash":"${criteriaHash(q)}"`);
    expect(text).toContain(`"question_id":"category:status","criteria_hash":"${HASHES.category}"`);
    expect(text).toContain(`"approved":""`);
    // keyed by the model the rows REPORTED, never the request alias (which calibratedLang refuses to arm)
    expect(text).toContain(`"model":"${REPORTED}"`); expect(text).not.toContain(`"model":"jev-latest"`);
    expect(text).not.toContain(`"lang":"en"`); // no en turn in the fixture → no en rows
  });

  it("a dry run has its own headline and no evidence", () => {
    expect(formatTreeReport([row("a", { status: "dry_run" })], new Map(), { spentUsd: 0, estimatedUsd: 0.02, universe: 3, wouldDispatch: 1, alreadyDone: 2, skipped: 0 },
      TREE_BAR_DEFAULTS)).toMatch(/^DRY RUN — universe 3, would dispatch 1, already done 2, skipped 0/);
  });
});
