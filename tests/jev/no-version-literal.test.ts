import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Jev version check: no Jev version literal decides behaviour. The reported id is data, never a key. A `jev-<n>.<n>`
// match is allowed only on a comment line, so a note about calibration history stays and any code use fails.
const LITERAL = /jev-[0-9]+\.[0-9]+/;
const SRC = join(import.meta.dirname, "..", "..", "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? sourceFiles(p) : e.name.endsWith(".ts") ? [p] : [];
  });
}
const isComment = (line: string): boolean => /^(\/\/|\*|\/\*)/.test(line.trim());

describe("no Jev version literal in src code", () => {
  it("a jev-<n>.<n> literal appears on comment lines only", () => {
    const hits = sourceFiles(SRC).flatMap((f) => readFileSync(f, "utf8").split("\n")
      .flatMap((l, i) => (LITERAL.test(l) && !isComment(l) ? [`${f.slice(SRC.length + 1)}:${i + 1}: ${l.trim().slice(0, 100)}`] : [])));
    expect(hits).toEqual([]);
  });
  it("the guard sees a code line and spares a comment line", () => {
    expect(isComment('  model: "jev-1.13.0",')).toBe(false);
    expect(isComment("/** reads jev-1.13 literally */")).toBe(true);
    expect(isComment(" * jev-1.13 leans to the first option")).toBe(true);
    expect(isComment("// jev-1.13.0")).toBe(true);
  });
});
