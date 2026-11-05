/**
 * Rule: ADR 0032 D7 (docs/decisions/0032-omp-runtime-consolidated.md): Claude runs only as a subscription model inside
 * omp. Never a metered API, never the Claude Code CLI (`claude -p`).
 * Changing this rule changes this test in the same commit.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeAccessProblems } from "./conformance.js";

const root = join(import.meta.dirname, "..", "..");
const walk = (dir: string): string[] =>
  readdirSync(join(root, dir), { withFileTypes: true }).flatMap((d) => {
    const rel = join(dir, d.name);
    return d.isDirectory() ? walk(rel) : d.name.endsWith(".ts") ? [rel] : [];
  });

describe("ADR 0032 D7: Claude only as a subscription model inside omp", () => {
  it("has no Anthropic API host, SDK import or claude binary spawn under src/, because those bill per token or bypass omp's wall", () => {
    const files = walk("src").map((path) => ({ path, text: readFileSync(join(root, path), "utf8") }));
    expect(files.length).toBeGreaterThan(200);
    expect(claudeAccessProblems(files)).toEqual([]);
  });
  it("fails on each way of reaching Claude outside omp", () => {
    const f = (text: string) => claudeAccessProblems([{ path: "src/x.ts", text }]);
    expect(f('fetch("https://api.anthropic.com/v1/messages")')).toEqual(["src/x.ts: Anthropic API host"]);
    expect(f('import Anthropic from "@anthropic-ai/sdk";')).toEqual(["src/x.ts: Anthropic SDK import"]);
    expect(f('execFileSync("/usr/local/bin/claude", args);')).toEqual(["src/x.ts: spawns the claude binary", "src/x.ts: string literal naming a claude binary"]);
    expect(f('spawn("claude", ["-p", goal]);')).toEqual(["src/x.ts: string literal naming a claude binary"]);
    expect(f('const bin = env.X ?? "claude";')).toEqual(["src/x.ts: string literal naming a claude binary"]);
  });
  it("fails when the binary name goes through a variable or carries a suffix", () => {
    const f = (text: string) => claudeAccessProblems([{ path: "src/x.ts", text }]);
    expect(f('const bin = "claude"; spawn(bin, ["-p"]);')).toEqual(["src/x.ts: string literal naming a claude binary"]);
    expect(f('spawn("claude-code", ["-p"]);')).toEqual(["src/x.ts: string literal naming a claude binary"]);
    expect(f('const bin = "/usr/local/bin/claude"; spawn(bin, ["-p"]);')).toEqual(["src/x.ts: string literal naming a claude binary"]);
  });
  it("does not flag the model names omp is configured with", () => {
    expect(claudeAccessProblems([{ path: "src/x.ts", text: 'leg("sonnet@anthropic", "low");\n// a stale "claude" in an old .env\n * `claude`' }])).toEqual([]);
    expect(claudeAccessProblems([{ path: "src/omp/model-tiers.ts", text: 'm = "claude-opus-5-5"; f = "claude";' }])).toEqual([]);
  });
});
