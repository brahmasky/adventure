import { describe, expect, it } from "vitest";
import { JEV_MODEL } from "../../src/jev/jev-client.js";
import { TRIAGE_LANE, TRIAGE_QUESTIONS } from "../../src/jev/questions/triage.js";
import { criteriaHash } from "../../src/jev/questions/types.js";
import { TRIAGE_BAR_DEFAULTS, TRIAGE_STATUS_ARM_ID } from "../../src/jev/thresholds.js";
import { TRIAGE_LANE_PERMUTED, type TriageLabel, type TriageReplayRow } from "../../src/jev/triage-replay.js";
import { formatTriageReport, type TriageShadowStats } from "../../src/jev/triage-report.js";

const HASH = criteriaHash(TRIAGE_LANE);
/** A `none` turn by default; the numbers drive the verdict (the report recomputes it at the given bars). */
const row = (o: Partial<TriageReplayRow>): TriageReplayRow => ({ key: o.turn_id ?? "t", turn_id: "t", run_id: "r", lang: "zh", status: "ok", est_usd: 0,
  observed_lesson_write: false, observed_other_tools: false, state_hash: "h", jev_lane: "none", p_memory: 0.02, p_status: 0.01, p_none: 0.97,
  conf_lane: 0.95, p_pure: 0.5, scope: "ask", model: JEV_MODEL, criteria_hash_lane: HASH, ...o });
const memPure = { jev_lane: "memory", p_memory: 0.9, p_status: 0.05, p_none: 0.05, conf_lane: 0.85, p_pure: 0.9 };
const memMixed = { ...memPure, p_pure: 0.2 };
const status = { jev_lane: "status", p_memory: 0.05, p_status: 0.9, p_none: 0.05, conf_lane: 0.85 };
const L = (o: Partial<TriageLabel>): TriageLabel => ({ memory: false, status: false, pure: null, scope: null, by: "paco", at: "", ...o });
const SHADOW_OK: TriageShadowStats = { days: 15, matched_lesson_write: 6, pure_on_tool_turns: 0, pure_on_no_tool_turns: 0 };

// Spec §5.9: per-class bars, both positive sets, the costly cells, Wilson bounds and n; INCOMPLETE on a stop; dry run headline.
describe("formatTriageReport", () => {
  const small = () => {
    const rows = [
      row({ turn_id: "a", observed_lesson_write: true, ...memPure }),
      row({ turn_id: "b", observed_lesson_write: true }),
      row({ turn_id: "c", observed_other_tools: true, ...memPure }), // costly: pure on a tool-using turn
      row({ turn_id: "e", ...memPure }), // pure on a NO-tool turn, Paco says not memory
      row({ turn_id: "d", lang: "en" })
    ];
    const labels = new Map([["a", L({ memory: true, pure: true, scope: "ask" })], ["c", L({})], ["e", L({})]]);
    return { rows, labels };
  };

  it("reports recall on the action proxy and on human labels, precision, all three costly cells, per language", () => {
    const { rows, labels } = small();
    const text = formatTriageReport(rows, labels, { spentUsd: 0.01, estimatedUsd: 0.01 }, TRIAGE_BAR_DEFAULTS);
    expect(text).toMatch(/recall \(action proxy.*1\/2.*50\.0%.*LB/);
    expect(text).toMatch(/recall \(human.*1\/1/);
    expect(text).toMatch(/precision \(human.*1\/3/);
    expect(text).toMatch(/COSTLY: pure on tool-using turns: 1/);
    expect(text).toMatch(/pure on NO-tool turns: 1 \(0 human-confirmed memory\+pure\)/); // counted separately
    expect(text).toMatch(/pure on human-labelled not-pure: 2/);
    expect(text).toMatch(/\bzh\b/); expect(text).toMatch(/\ben\b/);
    expect(text).toMatch(/STOP|NO-GO/);
    expect(text).not.toMatch(/ROWS TO ADD/);
  });

  it("prints the threshold sweep 0.5…0.9 for p(memory) and p(pure), and the verdict × observed-action confusion matrix", () => {
    const { rows, labels } = small();
    const text = formatTriageReport(rows, labels, { spentUsd: 0, estimatedUsd: 0 }, TRIAGE_BAR_DEFAULTS);
    for (const t of ["0.5", "0.6", "0.7", "0.8", "0.9"]) {
      expect(text).toMatch(new RegExp(`p\\(memory\\) ≥ ${t}: coverage`));
      expect(text).toMatch(new RegExp(`p\\(pure\\) ≥ ${t}: coverage`));
    }
    expect(text).toMatch(/memory_pure\s+\|\s+1\s+\|\s+1\s+\|\s+1/); // a: lesson_write-only, c: other tools, e: no tools
  });

  it("prints INCOMPLETE on an early stop, on a missing label for an observed lesson_write, and without the permuted run; a distinct dry-run headline", () => {
    expect(formatTriageReport([row({ status: "dry_run" })], new Map(), { spentUsd: 0, estimatedUsd: 0.02, universe: 3, wouldDispatch: 1, alreadyDone: 2, skipped: 0 }, TRIAGE_BAR_DEFAULTS))
      .toMatch(/^DRY RUN — universe 3, would dispatch 1, already done 2, skipped 0/m);
    expect(formatTriageReport([row({})], new Map(), { spentUsd: 0, estimatedUsd: 0, stopped: "auth" }, TRIAGE_BAR_DEFAULTS)).toMatch(/^INCOMPLETE.*stopped: auth/m);
    const unlabelled = formatTriageReport([row({ turn_id: "x", observed_lesson_write: true })], new Map(), { spentUsd: 0, estimatedUsd: 0, universe: 1 }, TRIAGE_BAR_DEFAULTS, [row({ turn_id: "x", key: "x:perm" })], SHADOW_OK);
    expect(unlabelled).toMatch(/^INCOMPLETE.*1 required turn\(s\) unlabelled/m);
    expect(formatTriageReport([row({})], new Map(), { spentUsd: 0, estimatedUsd: 0, universe: 1 }, TRIAGE_BAR_DEFAULTS)).toMatch(/^INCOMPLETE.*permuted run missing/m);
  });

  it("reports permutation agreement with n", () => {
    const rows = [row({ turn_id: "a", ...memPure }), row({ turn_id: "b" })];
    const perm = [row({ turn_id: "a", key: "a:perm", ...memPure }), row({ turn_id: "b", key: "b:perm", ...memPure })];
    expect(formatTriageReport(rows, new Map(), { spentUsd: 0, estimatedUsd: 0 }, TRIAGE_BAR_DEFAULTS, perm)).toMatch(/permutation: verdict agreement 1\/2 = 50\.0%/);
  });

  describe("ROWS TO ADD", () => {
    /** 40 zh turns, every one right: 10 pure memory instructions (lesson_write-only), 5 mixed memory (with tools), 5 status, 20 none. */
    const passing = () => {
      const rows: TriageReplayRow[] = []; const labels = new Map<string, TriageLabel>();
      for (let i = 0; i < 40; i++) {
        const id = `t${i}`;
        if (i < 10) { rows.push(row({ turn_id: id, observed_lesson_write: true, ...memPure })); labels.set(id, L({ memory: true, pure: true, scope: "ask" })); }
        else if (i < 15) { rows.push(row({ turn_id: id, observed_lesson_write: true, observed_other_tools: true, ...memMixed })); labels.set(id, L({ memory: true, pure: false, scope: "ask" })); }
        else if (i < 20) { rows.push(row({ turn_id: id, ...status })); labels.set(id, L({ status: true })); }
        else { rows.push(row({ turn_id: id, observed_other_tools: i % 2 === 0 })); if (i < 30) labels.set(id, L({})); }
      }
      const perm = rows.map((r) => ({ ...r, key: `${r.turn_id}:perm`, criteria_hash_lane: criteriaHash(TRIAGE_LANE_PERMUTED) }));
      return { rows, labels, perm };
    };
    const outcome = { spentUsd: 0.04, estimatedUsd: 0.05, universe: 40 };

    it("appears only when every bar holds: full universe, labels, permuted run, shadow stats", () => {
      const { rows, labels, perm } = passing();
      const text = formatTriageReport(rows, labels, outcome, TRIAGE_BAR_DEFAULTS, perm, SHADOW_OK);
      expect(text).toMatch(/ROWS TO ADD/);
      expect(text).not.toMatch(/INCOMPLETE/);
      for (const q of TRIAGE_QUESTIONS) {
        expect(text).toContain(JSON.stringify({ question_id: q.id, criteria_hash: criteriaHash(q), model: JEV_MODEL, lang: "zh" }).slice(0, -1));
      }
      expect(text).toContain(`{"question_id":"${TRIAGE_STATUS_ARM_ID}","criteria_hash":"${criteriaHash(TRIAGE_LANE)}","model":"${JEV_MODEL}","lang":"zh"`);
      expect(text).not.toMatch(/"lang":"en"/); // no en evidence → no en rows
    });

    it("is impossible without shadow stats, with a failing shadow, without the permuted run, or over a partial universe", () => {
      const { rows, labels, perm } = passing();
      expect(formatTriageReport(rows, labels, outcome, TRIAGE_BAR_DEFAULTS, perm)).not.toMatch(/ROWS TO ADD/);
      expect(formatTriageReport(rows, labels, outcome, TRIAGE_BAR_DEFAULTS, perm, { ...SHADOW_OK, days: 13 })).not.toMatch(/ROWS TO ADD/);
      expect(formatTriageReport(rows, labels, outcome, TRIAGE_BAR_DEFAULTS, perm, { ...SHADOW_OK, pure_on_no_tool_turns: 1 })).not.toMatch(/ROWS TO ADD/);
      expect(formatTriageReport(rows, labels, outcome, TRIAGE_BAR_DEFAULTS, undefined, SHADOW_OK)).not.toMatch(/ROWS TO ADD/);
      expect(formatTriageReport(rows, labels, { ...outcome, universe: 41 }, TRIAGE_BAR_DEFAULTS, perm, SHADOW_OK)).not.toMatch(/ROWS TO ADD/);
      expect(formatTriageReport(rows, labels, { ...outcome, limited: true }, TRIAGE_BAR_DEFAULTS, perm, SHADOW_OK)).not.toMatch(/ROWS TO ADD/);
    });

    it("is withheld on one jev_failed row, one costly cell, a status bar short of n = 5, or rows from stale wording", () => {
      const { rows, labels, perm } = passing();
      const failed = [...rows.slice(0, 39), row({ turn_id: "t39", status: "jev_failed" })];
      expect(formatTriageReport(failed, labels, outcome, TRIAGE_BAR_DEFAULTS, perm, SHADOW_OK)).not.toMatch(/ROWS TO ADD/);
      const costly = rows.map((r) => (r.turn_id === "t10" ? { ...r, p_pure: 0.9 } : r)); // pure on a turn with other tools
      expect(formatTriageReport(costly, labels, outcome, TRIAGE_BAR_DEFAULTS, perm, SHADOW_OK)).toMatch(/NO-GO.*costly/);
      const stale = rows.map((r) => ({ ...r, criteria_hash_lane: "old" }));
      expect(formatTriageReport(stale, labels, outcome, TRIAGE_BAR_DEFAULTS, perm, SHADOW_OK)).toMatch(/^INCOMPLETE.*criteria/m);
      expect(formatTriageReport(rows, labels, outcome, TRIAGE_BAR_DEFAULTS, rows.map((r) => ({ ...r, key: `${r.turn_id}:perm` })), SHADOW_OK)).toMatch(/^INCOMPLETE.*criteria/m); // a "permuted" file asked in canonical order
    });

    // Spec §5.9: "else status stays shadow while memory arms" — the two lanes arm on separate rows (review ruling R1).
    it("arms memory and status independently: a status bar short of n = 5 withholds only the `lane:status` row", () => {
      const { rows, labels, perm } = passing();
      const fourStatus = rows.map((r) => (r.turn_id === "t15" ? row({ turn_id: "t15" }) : r));
      const text = formatTriageReport(fourStatus, labels, outcome, TRIAGE_BAR_DEFAULTS, perm, SHADOW_OK);
      expect(text).toMatch(/zh status: NO-GO \(stays shadow\)/);
      expect(text).toMatch(/"question_id":"lane","criteria_hash"/);
      expect(text).toMatch(/"question_id":"scope"/);
      expect(text).not.toContain(TRIAGE_STATUS_ARM_ID + '"');
      const costly = rows.map((r) => (r.turn_id === "t10" ? { ...r, p_pure: 0.9 } : r)); // memory fails, status still holds
      const statusOnly = formatTriageReport(costly, labels, outcome, TRIAGE_BAR_DEFAULTS, perm, SHADOW_OK);
      expect(statusOnly).toContain(`"question_id":"${TRIAGE_STATUS_ARM_ID}"`);
      expect(statusOnly).not.toMatch(/"question_id":"(lane|complete|scope)"/);
    });

    it("an unlabelled status verdict at a lowered status bar is a required label (review fix 3)", () => {
      const { rows, labels, perm } = passing();
      const lowish = [...rows.slice(0, 39), row({ turn_id: "t39", p_status: 0.5, p_none: 0.48 })]; // Jev chose none; p(status) 0.5
      expect(formatTriageReport(lowish, labels, outcome, TRIAGE_BAR_DEFAULTS, perm, SHADOW_OK)).not.toMatch(/INCOMPLETE/);
      expect(formatTriageReport(lowish, labels, outcome, { ...TRIAGE_BAR_DEFAULTS, minStatus: 0.4 }, perm, SHADOW_OK)).toMatch(/^INCOMPLETE.*1 required turn\(s\) unlabelled/m);
    });

    // Codex whole-diff RISK: the replay is only evidence for the live gate if it asked Jev about the same state. A comparable
    // live row (its run was replayed) whose state_hash differs blocks the rows; the data cannot tell a broker-redacted
    // turn from a real parity bug, so every mismatch blocks and the text says so. A live row whose run was not replayed is
    // listed, not compared.
    it("blocks ROWS TO ADD on any state-parity mismatch for a comparable live row, and lists non-comparable rows visibly", () => {
      const { rows, labels, perm } = passing();
      const parity = (live: Array<{ run_id: string; state_hash: string }>) =>
        formatTriageReport(rows, labels, outcome, TRIAGE_BAR_DEFAULTS, perm, { ...SHADOW_OK, live_state_rows: live });
      const match = parity([{ run_id: "r", state_hash: "h" }, { run_id: "not-replayed", state_hash: "zz" }]);
      expect(match).toMatch(/ROWS TO ADD/);
      expect(match).toMatch(/state parity: 0 of 1 comparable live row\(s\) mismatch; 1 live row\(s\) not comparable/);
      const mismatch = parity([{ run_id: "r", state_hash: "h" }, { run_id: "r", state_hash: "zz" }]);
      expect(mismatch).not.toMatch(/ROWS TO ADD/);
      expect(mismatch).toMatch(/STOP \/ NO-GO.*state parity: 1 of 2 comparable live row\(s\) mismatch/);
      expect(mismatch).toMatch(/broker redaction cannot be told apart/);
    });
  });
});
