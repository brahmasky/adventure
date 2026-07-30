import { describe, expect, it } from "vitest";
import { buildGateAQuestion, GATE_A_DISCIPLINE, parseGateAVerdict } from "../../src/capabilities/skill-router.js";

describe("GATE_A_DISCIPLINE", () => {
  it("encodes the four criteria and the JSON schema", () => {
    expect(GATE_A_DISCIPLINE).toContain('"skill"');
    expect(GATE_A_DISCIPLINE).toContain('"lesson"');
    expect(GATE_A_DISCIPLINE).toContain('"code"');
    expect(GATE_A_DISCIPLINE.toLowerCase()).toContain("recurring");
    expect(GATE_A_DISCIPLINE.toLowerCase()).toContain("promptable");
    expect(GATE_A_DISCIPLINE.toLowerCase()).toContain("world-fact");
  });
});

describe("buildGateAQuestion", () => {
  it("puts the request on the data channel with optional recent thread", () => {
    const q = buildGateAQuestion("write a skill for cross-checking figures");
    expect(q).toContain("write a skill for cross-checking figures");
    expect(q).toContain("Respond with the JSON verdict only");
  });
});

describe("parseGateAVerdict", () => {
  it("routes a skill verdict", () => {
    expect(parseGateAVerdict('{"verdict":"skill","reason":"recurring method"}')).toEqual({
      verdict: "skill",
      reason: "recurring method"
    });
  });

  it("routes a lesson verdict carrying scope + lesson", () => {
    expect(
      parseGateAVerdict('{"verdict":"lesson","scope":"ask","lesson":"be more concise","reason":"a tweak"}')
    ).toEqual({ verdict: "lesson", scope: "ask", lesson: "be more concise", reason: "a tweak" });
  });

  it("routes a code verdict", () => {
    expect(parseGateAVerdict('{"verdict":"code","reason":"needs an API"}').verdict).toBe("code");
  });

  it("extracts JSON embedded in surrounding prose", () => {
    expect(parseGateAVerdict('Here you go: {"verdict":"skill","reason":"ok"} done').verdict).toBe("skill");
  });

  it("defaults to unsure on junk, missing JSON, or unknown verdict (tolerant + safe)", () => {
    expect(parseGateAVerdict("no json").verdict).toBe("unsure");
    expect(parseGateAVerdict("{bad json}").verdict).toBe("unsure");
    expect(parseGateAVerdict('{"verdict":"nonsense","reason":"x"}').verdict).toBe("unsure");
    expect(parseGateAVerdict("").verdict).toBe("unsure");
  });

  it("routes a retire verdict carrying the target", () => {
    expect(parseGateAVerdict('{"verdict":"retire","target":"siem-soar-ueba-weekly-report","reason":"r"}')).toEqual({
      verdict: "retire",
      target: "siem-soar-ueba-weekly-report",
      reason: "r"
    });
  });

  it("routes a restore verdict carrying the target", () => {
    expect(parseGateAVerdict('{"verdict":"restore","target":"newsletter","reason":"re-enable"}')).toEqual({
      verdict: "restore",
      target: "newsletter",
      reason: "re-enable"
    });
  });

  it("degrades a retire/restore verdict WITHOUT a usable target to unsure (never acts blind)", () => {
    expect(parseGateAVerdict('{"verdict":"retire","reason":"r"}')).toEqual({
      verdict: "unsure",
      reason: "retire/restore verdict without a target"
    });
    expect(parseGateAVerdict('{"verdict":"restore","target":"   ","reason":"r"}')).toEqual({
      verdict: "unsure",
      reason: "retire/restore verdict without a target"
    });
  });

  it("still defaults an unknown verdict to unsure after the retire/restore extension", () => {
    expect(parseGateAVerdict('{"verdict":"deactivate","reason":"x"}').verdict).toBe("unsure");
  });
});
