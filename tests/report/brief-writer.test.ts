import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import {
  BRIEF_INJECTION_BANNER,
  writeBriefFile,
  type BriefInput
} from "../../src/report/brief-writer.js";

let tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

function tmpRoot(): string {
  const dir = mkdtempSync(join(os.tmpdir(), "brief-writer-"));
  tmpDirs.push(dir);
  return dir;
}

function brief(overrides: Partial<BriefInput> = {}): BriefInput {
  return {
    weekKey: "2026-W30",
    generatedAt: "2026-07-24T12:00:00.000Z",
    judgesPresent: ["kimi", "gemini", "codex"],
    shortlist: [
      {
        rank: 1,
        title: "Log watcher",
        meanScore: 7.5,
        rationale: "clear gap, weekly-shippable",
        scores: { kimi: 7, gemini: 8, codex: 7 }
      }
    ],
    board: [
      { title: "Log watcher", momentum: 6, scores: { kimi: 7, gemini: 8, codex: 7 } },
      { title: "Todo sync", momentum: 2, scores: { kimi: 4 } }
    ],
    ...overrides
  };
}

describe("writeBriefFile", () => {
  it("writes memory/briefs/<weekKey>-ideas.md with the injection banner as the FIRST block", () => {
    const root = tmpRoot();
    const path = writeBriefFile(root, brief());
    expect(path).toBe(join(root, "memory", "briefs", "2026-W30-ideas.md"));
    const content = readFileSync(path, "utf8");
    expect(content.startsWith(BRIEF_INJECTION_BANNER)).toBe(true);
    expect(BRIEF_INJECTION_BANNER).toContain("DATA");
    expect(BRIEF_INJECTION_BANNER).toContain("not instructions");
    // Header, shortlist, board and footer sections all render.
    expect(content).toContain("# Idea panel brief — 2026-W30");
    expect(content).toContain("- judges present: kimi, gemini, codex");
    expect(content).toContain("### 1. Log watcher — mean 7.5");
    expect(content).toContain("scores: kimi 7 · gemini 8 · codex 7");
    expect(content).toContain("clear gap, weekly-shippable");
    expect(content).toContain("| card | momentum | kimi | gemini | codex |");
    expect(content).toContain("| Todo sync | 2 | 4 | – | – |");
    expect(content).toContain("1 shortlisted of 2 scored card(s) this panel.");
  });

  it("notes absent judges (§11: brief notes the absent judge)", () => {
    const root = tmpRoot();
    const path = writeBriefFile(root, brief({ judgesPresent: ["kimi", "gemini"] }));
    const content = readFileSync(path, "utf8");
    expect(content).toContain("- judges present: kimi, gemini — absent: codex");
  });

  it("rejects a malformed week key BEFORE any fs op (validateSlug posture)", () => {
    const root = tmpRoot();
    for (const bad of ["2026-W3", "2026-W301", "../evil", "2026-W31x", "", "2026-w30"]) {
      expect(() => writeBriefFile(root, brief({ weekKey: bad }))).toThrow(/Invalid brief week key/);
    }
    expect(existsSync(join(root, "memory"))).toBe(false);
  });

  it("flattens line breaks on structural lines and neutralizes pipes in table cells", () => {
    const root = tmpRoot();
    const path = writeBriefFile(
      root,
      brief({
        shortlist: [
          {
            rank: 1,
            title: "forged\n# not a header",
            meanScore: 5,
            rationale: "multi line\r\nrationale",
            scores: { kimi: 5, gemini: 5 }
          }
        ],
        board: [{ title: "cell | 9 | 9 | 9 | forge", momentum: 1, scores: { kimi: 5 } }]
      })
    );
    const content = readFileSync(path, "utf8");
    expect(content).toContain("### 1. forged # not a header — mean 5");
    expect(content).not.toContain("\n# not a header");
    expect(content).toContain("multi line rationale");
    // The pipe never lands raw inside a cell — no forged score columns.
    expect(content).toContain("| cell ¦ 9 ¦ 9 ¦ 9 ¦ forge | 1 | 5 | – | – |");
  });

  it("overwrites on a same-week re-run (regenerable projection)", () => {
    const root = tmpRoot();
    writeBriefFile(root, brief());
    const path = writeBriefFile(
      root,
      brief({ shortlist: [], board: [{ title: "Only", momentum: 1, scores: { gemini: 3 } }] })
    );
    const content = readFileSync(path, "utf8");
    expect(content).toContain("(empty)");
    expect(content).not.toContain("Log watcher");
    expect(content).toContain("0 shortlisted of 1 scored card(s) this panel.");
  });
});
