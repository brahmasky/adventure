import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CALIBRATED_ROWS, calibratedLang, calibrationRows, type CalibrationRow } from "../../src/jev/calibration.js";
import { type JevChoiceAnswer } from "../../src/jev/jev-client.js";
import { TRIAGE_COMPLETE, TRIAGE_LANE, TRIAGE_QUESTIONS, TRIAGE_SCOPE } from "../../src/jev/questions/triage.js";
import { criteriaHash } from "../../src/jev/questions/types.js";
import { TRIAGE_BAR_DEFAULTS, TRIAGE_STATUS_ARM_ID, resolveTriageBars, triageVerdict } from "../../src/jev/thresholds.js";

/** The versioned id Jev REPORTS (the request sends the moving alias `jev-latest`); calibration rows key on it. */
const REPORTED = "jev-1.13.0";

const ans = (choice: string, probabilities: Record<string, number>): JevChoiceAnswer => {
  const n = Object.keys(probabilities).length;
  const pMax = Math.max(...Object.values(probabilities));
  return { choice, probabilities, confidence: (pMax - 1 / n) / (1 - 1 / n) }; // Jev's documented confidence formula
};
const top = (o: Record<string, number>): string => Object.entries(o).sort((a, b) => b[1] - a[1])[0]![0];
const answers = (lane: Record<string, number>, complete: Record<string, number>, scope: Record<string, number>) => ({
  lane: ans(top(lane), lane),
  complete: ans(top(complete), complete),
  scope: ans(top(scope), scope)
});
const bars = TRIAGE_BAR_DEFAULTS;
const rowFor = (q: { id: string }, hash: string, lang: "zh" | "en"): CalibrationRow => ({ question_id: q.id, criteria_hash: hash, model: REPORTED, lang, approved: "test", evidence: "test" });
const statusRow = (lang: "zh" | "en"): CalibrationRow => rowFor({ id: TRIAGE_STATUS_ARM_ID }, criteriaHash(TRIAGE_LANE), lang);
const rows: CalibrationRow[] = [...TRIAGE_QUESTIONS.flatMap((q) => (["zh", "en"] as const).map((lang) => rowFor(q, criteriaHash(q), lang))), statusRow("zh"), statusRow("en")];
const memoryAnswers = () => answers({ none: 0.05, status: 0.05, memory: 0.9 }, { mixed: 0.1, pure: 0.9 }, { ask: 0.8, research: 0.2 });
const statusAnswers = () => answers({ none: 0.15, status: 0.8, memory: 0.05 }, { mixed: 0.5, pure: 0.5 }, { ask: 0.5, research: 0.5 });

// Spec §5.4. A wrong `pure` swallows a question, so every bar is tested at its edge.
describe("triageVerdict", () => {
  it("route-and-skip only when conf, p(memory), gap and p(pure) all clear", () => {
    expect(triageVerdict(memoryAnswers(), bars, "zh", REPORTED, rows)).toEqual({ kind: "memory", complete: "pure", scope: "ask" });
  });
  it("downgrades to mixed when p(pure) is one hundredth under the bar", () => {
    const d = triageVerdict(answers({ none: 0.05, status: 0.05, memory: 0.9 }, { mixed: 0.21, pure: 0.79 }, { ask: 0.3, research: 0.7 }), bars, "zh", REPORTED, rows);
    expect(d).toEqual({ kind: "memory", complete: "mixed", scope: "research" });
  });
  it("falls through when p(memory) >= .85 but the gap to none is under .5", () => {
    const d = triageVerdict(answers({ none: 0.4, status: 0.0, memory: 0.6 }, { mixed: 0.1, pure: 0.9 }, { ask: 0.9, research: 0.1 }), bars, "zh", REPORTED, rows);
    expect(d.kind).toBe("fallthrough");
  });
  it("status needs only p(status) >= .8; a bare ack after a proposal is none", () => {
    expect(triageVerdict(statusAnswers(), bars, "en", REPORTED, rows)).toEqual({ kind: "status" });
    expect(triageVerdict(answers({ none: 0.97, status: 0.01, memory: 0.02 }, { mixed: 0.5, pure: 0.5 }, { ask: 0.5, research: 0.5 }), bars, "zh", REPORTED, rows)).toEqual({ kind: "fallthrough", reason: "none" });
  });
  it("falls through as uncalibrated for a model other than the pinned one", () => {
    expect(triageVerdict(memoryAnswers(), bars, "zh", "jev-1.14.0", rows)).toEqual({ kind: "fallthrough", reason: "uncalibrated" });
  });
  // Armed on Paco's instruction (ADR 0029 amendment 2026-10-06): both lanes, both languages, on today's hashes and the
  // pinned model. A criteria edit or a model bump must disarm, so the rows can never silently cover changed questions.
  it("the committed rows arm memory and status in zh and en on the current hashes, and only for the pinned model", () => {
    for (const lang of ["zh", "en", "mixed"] as const) {
      expect(triageVerdict(memoryAnswers(), bars, lang, REPORTED)).toMatchObject({ kind: "memory" });
      expect(triageVerdict(statusAnswers(), bars, lang, REPORTED)).toEqual({ kind: "status" });
    }
    expect(triageVerdict(memoryAnswers(), bars, "zh", "jev-1.14.0")).toEqual({ kind: "fallthrough", reason: "uncalibrated" });
    const edited = { ...TRIAGE_LANE, criteria: TRIAGE_LANE.criteria.map(([o, t]) => [o, `${t} (edited)`] as const) };
    expect(CALIBRATED_ROWS.some((r) => r.criteria_hash === criteriaHash(edited))).toBe(false);
  });
  // Spec §5.9: memory may arm while status stays shadow (status needs precision 1.0 on n ≥ 5, which history may never give).
  it("lane-specific arming: the `lane:status` row alone arms status; memory still falls through uncalibrated", () => {
    expect(triageVerdict(statusAnswers(), bars, "zh", REPORTED, [statusRow("zh")])).toEqual({ kind: "status" });
    expect(triageVerdict(memoryAnswers(), bars, "zh", REPORTED, [statusRow("zh")])).toEqual({ kind: "fallthrough", reason: "uncalibrated" });
    const noScope = [TRIAGE_LANE, TRIAGE_COMPLETE].map((q) => rowFor(q, criteriaHash(q), "zh"));
    expect(triageVerdict(memoryAnswers(), bars, "zh", REPORTED, noScope)).toEqual({ kind: "fallthrough", reason: "uncalibrated" });
    expect(triageVerdict(statusAnswers(), bars, "zh", REPORTED, [TRIAGE_COMPLETE, TRIAGE_SCOPE].map((q) => rowFor(q, criteriaHash(q), "zh")))).toEqual({ kind: "fallthrough", reason: "uncalibrated" });
  });
  it("memory armed without the status row: a status question is NOT answered by code (status stays shadow)", () => {
    const memoryOnly = TRIAGE_QUESTIONS.map((q) => rowFor(q, criteriaHash(q), "zh"));
    expect(triageVerdict(memoryAnswers(), bars, "zh", REPORTED, memoryOnly)).toEqual({ kind: "memory", complete: "pure", scope: "ask" });
    expect(triageVerdict(statusAnswers(), bars, "zh", REPORTED, memoryOnly).kind).toBe("fallthrough"); // the planner answers it
    const staleStatus = [rowFor({ id: TRIAGE_STATUS_ARM_ID }, "deadbeef", "zh")]; // the status row is bound to the lane wording too
    expect(triageVerdict(statusAnswers(), bars, "zh", REPORTED, staleStatus)).toEqual({ kind: "fallthrough", reason: "uncalibrated" });
  });
  it("a calibrated lane for zh does not arm en", () => {
    const zhOnly = [statusRow("zh")];
    expect(triageVerdict(statusAnswers(), bars, "en", REPORTED, zhOnly)).toEqual({ kind: "fallthrough", reason: "uncalibrated" });
  });
});

describe("calibratedLang", () => {
  it("a row for another model or another hash does not calibrate", () => {
    expect(calibratedLang("lane", criteriaHash(TRIAGE_LANE), "jev-1.14.0", "zh", rows)).toBeUndefined();
    expect(calibratedLang("lane", "deadbeef", REPORTED, "zh", rows)).toBeUndefined();
    expect(calibratedLang("lane", criteriaHash(TRIAGE_LANE), REPORTED, "mixed", rows)).toBe("zh");
  });
});

describe("calibrationRows", () => {
  it("returns the committed constant without an override, the file rows with one, and [] for an unreadable file", () => {
    expect(calibrationRows({})).toBe(CALIBRATED_ROWS);
    const dir = mkdtempSync(join(tmpdir(), "jev-cal-"));
    const f = join(dir, "rows.json");
    writeFileSync(f, JSON.stringify(rows));
    expect(calibrationRows({ HOUGE_JEV_CALIBRATION_FILE: f })).toHaveLength(rows.length);
    expect(calibrationRows({ HOUGE_JEV_CALIBRATION_FILE: join(dir, "missing.json") })).toEqual([]);
  });
  afterEach(() => vi.restoreAllMocks());
  // Final review (T3 minor): an arming file of the wrong shape must not arm anything, and must not fail silently. The
  // stderr line names the path only: the file's contents never reach a log.
  it.each([
    ["not an array", { rows: [] }],
    ["a row with a non-string field", [{ question_id: "lane", criteria_hash: 7, model: "m", lang: "zh", approved: "a", evidence: "e" }]],
    ["a row with a lang outside zh|en", [{ question_id: "lane", criteria_hash: "h", model: "m", lang: "mixed", approved: "a", evidence: "e" }]],
    ["a null row", [null]]
  ])("a file that is %s → [] and one stderr line naming the path, never the contents", (_label, body) => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = join(mkdtempSync(join(tmpdir(), "jev-cal-")), "bad-SECRETMARK.json");
    writeFileSync(f, JSON.stringify(body));
    expect(calibrationRows({ HOUGE_JEV_CALIBRATION_FILE: f })).toEqual([]);
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0]![0])).toContain(f);
    expect(String(err.mock.calls[0]![0])).not.toContain("question_id");
  });
  it("an unreadable file is surfaced too (one stderr line naming the path)", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = join(mkdtempSync(join(tmpdir(), "jev-cal-")), "missing.json");
    expect(calibrationRows({ HOUGE_JEV_CALIBRATION_FILE: f })).toEqual([]);
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0]![0])).toContain(f);
  });
});

describe("resolveTriageBars", () => {
  it("reads env overrides and ignores garbage", () => {
    expect(resolveTriageBars({ HOUGE_JEV_TRIAGE_MIN_CONF: "0.9", HOUGE_JEV_TRIAGE_MIN_PURE: "x", HOUGE_JEV_TRIAGE_MIN_STATUS: "1.5" }))
      .toEqual({ ...TRIAGE_BAR_DEFAULTS, minConf: 0.9 });
  });
});

// Rows are keyed by the REPORTED versioned id; a row naming the moving alias would keep arming the lanes after TypeSafe
// moves it, which is exactly the silent change the alias design relies on rows to catch (2026-10-07).
describe("a calibration row naming the request alias never arms", () => {
  it("calibratedLang ignores a row whose model is jev-latest, even when Jev reports jev-latest", async () => {
    const { calibratedLang } = await import("../../src/jev/calibration.js");
    const { JEV_REQUEST_MODEL } = await import("../../src/jev/jev-client.js");
    const row: CalibrationRow = { question_id: "lane", criteria_hash: "h", model: JEV_REQUEST_MODEL, lang: "zh", approved: "x", evidence: "x" };
    expect(calibratedLang("lane", "h", JEV_REQUEST_MODEL, "zh", [row])).toBeUndefined();
  });
});

// The alias-move page must mean "the armed lanes were lost": a row for an unrelated question or a stale wording hash arms
// nothing, so it must neither clear the page nor count as a calibrated model (Codex confirmation, 2026-10-07).
describe("armingRows keeps only rows that can arm a current lane", () => {
  it("drops stale-hash and unrelated-question rows; keeps lane, complete, scope and lane:status at today's hashes", async () => {
    const { armingRows } = await import("../../src/jev/thresholds.js");
    const live = [TRIAGE_LANE, TRIAGE_COMPLETE, TRIAGE_SCOPE].map((q) => rowFor(q, criteriaHash(q), "zh"));
    const status: CalibrationRow = { ...rowFor(TRIAGE_LANE, criteriaHash(TRIAGE_LANE), "zh"), question_id: "lane:status" };
    const stale: CalibrationRow = { ...rowFor(TRIAGE_LANE, "deadbeef", "zh"), model: "jev-1.14.0" };
    const unrelated: CalibrationRow = { ...rowFor(TRIAGE_LANE, criteriaHash(TRIAGE_LANE), "zh"), question_id: "intent", model: "jev-1.14.0" };
    expect(armingRows([...live, status, stale, unrelated])).toEqual([...live, status]);
  });
});
