import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CALIBRATED_ROWS, calibratedLang, calibrationRows, type CalibrationRow } from "../../src/jev/calibration.js";
import { JEV_REQUEST_MODEL } from "../../src/jev/jev-client.js";
import { TREE_CATEGORY } from "../../src/jev/questions/tree.js";
import { criteriaHash } from "../../src/jev/questions/types.js";

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
