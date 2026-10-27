import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = new URL("../../src", import.meta.url).pathname;
const files = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : []; });

describe("child TMPDIR sites — no Houge child gets the cache root (the rooms' parent) as its temp space", () => {
  it("no src file passes TMPDIR: daemonTmpRoot(); the five CLI spawn sites pass childTmpRoot()", () => {
    const src = files(SRC).map((f) => [relative(SRC, f), readFileSync(f, "utf8")] as const);
    expect(src.filter(([, t]) => /TMPDIR:\s*daemonTmpRoot\(\)/.test(t)).map(([f]) => f)).toEqual([]);
    const sites = src.filter(([, t]) => /TMPDIR:\s*childTmpRoot\(\)/.test(t)).map(([f]) => f).sort();
    expect(sites).toEqual(["capabilities/coding-agent.ts", "llm/providers/agy-cli.ts", "llm/providers/agy-models.ts", "llm/providers/omp.ts", "omp/model-catalog.ts"]);
  });
});
