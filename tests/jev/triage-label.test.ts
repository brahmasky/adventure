import { describe, expect, it } from "vitest";
import { parseJevCliFlags, parseLabelAnswer, selectForLabelling } from "../../src/jev/triage-label.js";
import type { TreeReplayRow } from "../../src/jev/triage-replay.js";
import { treeAnswers } from "../helpers/jev-tree-answers.js";

const row = (turn_id: string, o: Partial<TreeReplayRow> = {}): TreeReplayRow => ({ key: turn_id, turn_id, run_id: `r${turn_id}`, lang: "zh", status: "ok",
  est_usd: 0, state_hash: "", tools: {}, proxy: "answer", proxy_rule: "no_tool", pre_judge: "judge", think_harder: false, bare_ack: false, quoted: false,
  answers: treeAnswers({ category: "answer" }), ...o });

// The proxy cannot judge unlabelled turns, and a wrong memory/status route swallows a turn: Paco labels all of those,
// then a random sample of the rest; never a turn he already labelled.
describe("selectForLabelling", () => {
  it("takes every unlabelled-proxy and memory/status turn once, plus the sample, skipping already-labelled", () => {
    const rows = [row("a", { proxy: null, proxy_rule: "ack_after_proposal" }), row("b", { answers: treeAnswers({ category: "memory" }) }),
      row("c", { proxy: "status", proxy_rule: "houge_status" }), row("d", { proxy: "memory", proxy_rule: "lesson_write", answers: treeAnswers({ category: "status" }) }),
      ...Array.from({ length: 50 }, (_, i) => row(`n${i}`))];
    const picked = selectForLabelling(rows, new Map([["a", { category: "answer", by: "paco", at: "" }]]), 5, () => 0.5);
    const ids = picked.map((r) => r.turn_id);
    expect(ids).toEqual(expect.arrayContaining(["b", "c", "d"])); expect(ids).not.toContain("a");
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((x) => x.startsWith("n"))).toHaveLength(5);
  });
});

describe("parseLabelAnswer", () => {
  // A mistyped label must be no label, never the nearest category: a wrong truth corrupts the costly cells.
  it("accepts a category or an unambiguous prefix, and rejects ambiguity and noise", () => {
    expect(parseLabelAnswer("lookup")).toBe("lookup");
    expect(parseLabelAnswer(" Res ")).toBe("research");
    expect(parseLabelAnswer("mach")).toBe("machine_task");
    expect(parseLabelAnswer("m")).toBeNull(); // memory, machine_task, mail_calendar
    expect(parseLabelAnswer("weather")).toBeNull();
    expect(parseLabelAnswer("")).toBeNull();
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
  it("rejects --since in both forms (the replay universe has a fixed epoch)", () => {
    expect(() => parseJevCliFlags(["--since", "2026-10-01T00:00:00Z"])).toThrow(/--since is not supported/);
    expect(() => parseJevCliFlags(["--since=2026-10-01T00:00:00Z"])).toThrow(/--since is not supported/);
  });
});
