import { describe, expect, it } from "vitest";
import { parseJevCliFlags, parseLabelAnswer, selectForLabelling } from "../../src/jev/triage-label.js";
import type { TriageReplayRow } from "../../src/jev/triage-replay.js";

const row = (turn_id: string, o: Partial<TriageReplayRow> = {}): TriageReplayRow => ({ key: turn_id, turn_id, run_id: `r${turn_id}`, lang: "zh", status: "ok", est_usd: 0,
  observed_lesson_write: false, observed_other_tools: false, state_hash: "", jev_lane: "none", verdict: "fallthrough", ...o });

// Spec §5.9 step 2: every Jev memory/status verdict, all action-proxy runs regardless of verdict, plus a random none sample; deduplicated.
describe("selectForLabelling", () => {
  it("takes every memory/status verdict and every lesson_write run once, plus the sample, skipping already-labelled", () => {
    const rows = [row("a", { jev_lane: "memory" }), row("b", { observed_lesson_write: true }), row("c", { jev_lane: "memory", observed_lesson_write: true }),
      row("d", { jev_lane: "status" }), ...Array.from({ length: 50 }, (_, i) => row(`n${i}`))];
    const picked = selectForLabelling(rows, new Map([["a", { memory: true, status: false, pure: true, scope: "ask", by: "paco", at: "" }]]), 5, () => 0.5);
    const ids = picked.map((r) => r.turn_id);
    expect(ids).toEqual(expect.arrayContaining(["b", "c", "d"])); expect(ids).not.toContain("a");
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((x) => x.startsWith("n"))).toHaveLength(5);
  });
});
describe("parseLabelAnswer", () => {
  it("reads the compact grammar and rejects noise", () => {
    expect(parseLabelAnswer("mpa")).toEqual({ memory: true, status: false, pure: true, scope: "ask" });
    expect(parseLabelAnswer("mxr")).toEqual({ memory: true, status: false, pure: false, scope: "research" });
    expect(parseLabelAnswer("n")).toEqual({ memory: false, status: false, pure: null, scope: null });
    expect(parseLabelAnswer("s")).toEqual({ memory: false, status: true, pure: null, scope: null });
    expect(parseLabelAnswer("maybe")).toBeNull();
  });
});
// parseReplayArgs rejects unknown tokens, so --sample / --permute must be stripped before it sees them.
describe("parseJevCliFlags", () => {
  it("strips --sample=N and --permute, leaving the rest for parseReplayArgs", () => {
    expect(parseJevCliFlags(["--sample=40", "--dry-run"])).toEqual({ sample: 40, permute: false, rest: ["--dry-run"] });
    expect(parseJevCliFlags(["--permute", "--limit", "5"])).toEqual({ permute: true, rest: ["--limit", "5"] });
  });
  it("rejects the space form and a non-numeric count", () => {
    expect(() => parseJevCliFlags(["--sample", "40"])).toThrow(/--sample=N/);
    expect(() => parseJevCliFlags(["--sample=abc"])).toThrow(/--sample=N/);
  });
  // Final review (T12 deferred minor): the triage universe is fixed at TRIAGE_LABEL_SINCE; parseReplayArgs accepted --since
  // and the triage branch ignored it — a silent no-op the operator would read as a narrowed replay.
  it("rejects --since in both forms (the triage universe has a fixed epoch)", () => {
    expect(() => parseJevCliFlags(["--since", "2026-10-01T00:00:00Z"])).toThrow(/--since is not supported/);
    expect(() => parseJevCliFlags(["--since=2026-10-01T00:00:00Z"])).toThrow(/--since is not supported/);
  });
});
