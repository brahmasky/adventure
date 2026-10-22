import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CALIBRATED_ROWS, calibratedLang, calibrationRows, type CalibrationRow } from "../../src/jev/calibration.js";
import { JEV_REQUEST_MODEL } from "../../src/jev/jev-client.js";
import { TREE_CATEGORY } from "../../src/jev/questions/tree.js";
import { criteriaHash } from "../../src/jev/questions/types.js";
import { TREE_ANSWER_ARM_ID, TREE_LOOKUP_ARM_ID, treeArmed } from "../../src/jev/tree-policy.js";

/** The versioned id Jev REPORTS (the request sends the moving alias `jev-latest`); calibration rows key on it. */
const REPORTED = "jev-1.13.0";
const H = criteriaHash(TREE_CATEGORY);
const row = (o: Partial<CalibrationRow> = {}): CalibrationRow =>
  ({ question_id: "category", criteria_hash: H, lang: "zh", approved: "test", evidence: "test", ...o });

// A row arms one (question, wording hash, language). Any other key must not arm: a wrong arm lets Jev
// act on evidence gathered for a different question or wording.
describe("calibratedLang", () => {
  it("a row for another hash or language does not calibrate; mixed inherits zh; the key carries no model", () => {
    const rows = [row()];
    expect(calibratedLang("category", "deadbeef", "zh", rows)).toBeUndefined();
    expect(calibratedLang("category", H, "mixed", rows)).toBe("zh");
    expect(calibratedLang("category", H, "en", rows)).toBeUndefined();
    expect(calibratedLang("category", H, "zh", rows)).toBe("zh");
  });
  // Jev version check Task 2: a row's `model` is not part of its key. The version gate moves to the per-model check (Task 3).
  it("a legacy `model` field on a row is not compared, whatever it names", () => {
    expect(calibratedLang("category", H, "zh", [row({ model: "anything" } as Partial<CalibrationRow>)])).toBe("zh");
    expect(calibratedLang("category", H, "zh", [row({ model: JEV_REQUEST_MODEL } as Partial<CalibrationRow>)])).toBe("zh");
  });
  // Stage B §1 ruling 1: the build ships armed. A lane row on the wrong hash or model would leave a lane silently dark.
  it("the committed rows arm every tree decision and both stage B lanes in zh and en (Paco 2026-10-10)", () => {
    for (const lang of ["zh", "en"] as const) {
      expect(treeArmed(lang, REPORTED, CALIBRATED_ROWS)).toEqual({ category: true, status: true, memory: true, gear: true, rule: true, answer: true, lookup: true });
    }
    const lanes = CALIBRATED_ROWS.filter((r) => r.question_id === TREE_ANSWER_ARM_ID || r.question_id === TREE_LOOKUP_ARM_ID);
    expect(lanes).toHaveLength(4);
    for (const r of lanes) expect(r).toMatchObject({ criteria_hash: criteriaHash(TREE_CATEGORY), approved: "Paco 2026-10-10" });
    for (const r of CALIBRATED_ROWS) expect(r).not.toHaveProperty("model");
  });
  // A reworded category question disarms the lanes with the rest; a stale lane row must not keep a lane live.
  it("a stale criteria hash arms neither lane; another reported model arms the same (Task 3 gates it through the check)", () => {
    const stale = CALIBRATED_ROWS.map((r) => (r.question_id.startsWith("category:") ? { ...r, criteria_hash: "deadbeef" } : r));
    expect(treeArmed("zh", REPORTED, stale)).toMatchObject({ answer: false, lookup: false });
    expect(treeArmed("zh", "jev-9.9.9", CALIBRATED_ROWS)).toMatchObject({ answer: true, lookup: true }); // interim: model ignored until Task 3
  });
});

describe("calibrationRows", () => {
  afterEach(() => vi.restoreAllMocks());
  it("returns the committed constant without an override, the file rows with one", () => {
    expect(calibrationRows({})).toBe(CALIBRATED_ROWS);
    const f = join(mkdtempSync(join(tmpdir(), "jev-cal-")), "rows.json");
    writeFileSync(f, JSON.stringify([row(), row({ lang: "en" })]));
    expect(calibrationRows({ HOUGE_JEV_CALIBRATION_FILE: f })).toHaveLength(2);
  });
  // Rows written before the version left the key still carry `model`: it is ignored, loudly once, never an error.
  it("a file row with a legacy `model` field is accepted, the field ignored, one stderr line", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = join(mkdtempSync(join(tmpdir(), "jev-cal-")), "legacy.json");
    writeFileSync(f, JSON.stringify([{ ...row(), model: "anything" }, { ...row({ lang: "en" }), model: "anything" }]));
    const rows = calibrationRows({ HOUGE_JEV_CALIBRATION_FILE: f });
    expect(rows).toHaveLength(2);
    expect(calibratedLang("category", H, "zh", rows)).toBe("zh");
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0]![0])).toContain("model");
  });
  // An arming file of the wrong shape must arm nothing and must not fail silently; the stderr line names the path only.
  it.each([
    ["not an array", { rows: [] }],
    ["a row with a non-string field", [{ question_id: "category", criteria_hash: 7, model: "m", lang: "zh", approved: "a", evidence: "e" }]],
    ["a row with a lang outside zh|en", [{ question_id: "category", criteria_hash: "h", model: "m", lang: "mixed", approved: "a", evidence: "e" }]],
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
  it("an unreadable file → [] and one stderr line naming the path", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = join(mkdtempSync(join(tmpdir(), "jev-cal-")), "missing.json");
    expect(calibrationRows({ HOUGE_JEV_CALIBRATION_FILE: f })).toEqual([]);
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0]![0])).toContain(f);
  });
});
