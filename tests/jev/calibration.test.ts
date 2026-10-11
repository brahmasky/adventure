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
  ({ question_id: "category", criteria_hash: H, model: REPORTED, lang: "zh", approved: "test", evidence: "test", ...o });

// A row arms one (question, wording hash, reported model, language). Any other key must not arm: a wrong arm lets Jev
// act on evidence gathered for a different question, wording or model.
describe("calibratedLang", () => {
  it("a row for another model or another hash does not calibrate; mixed inherits zh", () => {
    const rows = [row()];
    expect(calibratedLang("category", H, "jev-1.14.0", "zh", rows)).toBeUndefined();
    expect(calibratedLang("category", "deadbeef", REPORTED, "zh", rows)).toBeUndefined();
    expect(calibratedLang("category", H, REPORTED, "mixed", rows)).toBe("zh");
    expect(calibratedLang("category", H, REPORTED, "en", rows)).toBeUndefined();
  });
  // A row naming the moving alias would keep arming after TypeSafe moves it: exactly the silent change rows must catch.
  it("never arms on the request alias, even when a row names it and Jev reports it", () => {
    expect(calibratedLang("category", H, JEV_REQUEST_MODEL, "zh", [row({ model: JEV_REQUEST_MODEL })])).toBeUndefined();
  });
  // Stage B §1 ruling 1: the build ships armed. A lane row on the wrong hash or model would leave a lane silently dark.
  it("the committed rows arm every tree decision and both stage B lanes in zh and en (Paco 2026-10-10)", () => {
    for (const lang of ["zh", "en"] as const) {
      expect(treeArmed(lang, REPORTED, CALIBRATED_ROWS)).toEqual({ category: true, status: true, memory: true, gear: true, rule: true, answer: true, lookup: true });
    }
    const lanes = CALIBRATED_ROWS.filter((r) => r.question_id === TREE_ANSWER_ARM_ID || r.question_id === TREE_LOOKUP_ARM_ID);
    expect(lanes).toHaveLength(4);
    for (const r of lanes) expect(r).toMatchObject({ criteria_hash: criteriaHash(TREE_CATEGORY), model: REPORTED, approved: "Paco 2026-10-10" });
  });
  // A reworded category question disarms the lanes with the rest; a stale lane row must not keep a lane live.
  it("a stale criteria hash or another model arms neither lane", () => {
    const stale = CALIBRATED_ROWS.map((r) => (r.question_id.startsWith("category:") ? { ...r, criteria_hash: "deadbeef" } : r));
    expect(treeArmed("zh", REPORTED, stale)).toMatchObject({ answer: false, lookup: false });
    expect(treeArmed("zh", "jev-9.9.9", CALIBRATED_ROWS)).toMatchObject({ answer: false, lookup: false });
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
