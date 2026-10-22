import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Jev version check: no Jev version literal decides behaviour. The reported id is data, never a key. A `jev-<n>.<n>`
// match is allowed only on a .ts comment line, so a note about calibration history stays and any code use fails. A .json
// under src/ (e.g. src/omp/tools/*.json) has no comments: any match there fails.
const LITERAL = /jev-[0-9]+\.[0-9]+/;
const SRC = join(import.meta.dirname, "..", "..", "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? sourceFiles(p) : /\.(ts|json)$/.test(e.name) ? [p] : [];
  });
}
/** A line that starts a comment and carries no code after a closing `*\/` (`/* x *\/ model: "jev-1.13"` is code). */
const isComment = (line: string): boolean => {
  const t = line.trim();
  if (!/^(\/\/|\*|\/\*)/.test(t)) return false;
  const close = t.lastIndexOf("*/");
  return t.startsWith("//") || close === -1 || t.slice(close + 2).trim() === "";
};

describe("no Jev version literal in src code", () => {
  it("a jev-<n>.<n> literal appears on comment lines only", () => {
    const hits = sourceFiles(SRC).flatMap((f) => readFileSync(f, "utf8").split("\n")
      .flatMap((l, i) => (LITERAL.test(l) && !(f.endsWith(".ts") && isComment(l)) ? [`${f.slice(SRC.length + 1)}:${i + 1}: ${l.trim().slice(0, 100)}`] : [])));
    expect(hits).toEqual([]);
  });
  it("the scan covers .json files under src", () => {
    expect(sourceFiles(SRC).some((f) => f.endsWith(".json"))).toBe(true);
  });
  it("the guard sees a code line and spares a comment line", () => {
    expect(isComment('  model: "jev-1.13.0",')).toBe(false);
    expect(isComment("/** reads jev-1.13 literally */")).toBe(true);
    expect(isComment(" * jev-1.13 leans to the first option")).toBe(true);
    expect(isComment("// jev-1.13.0")).toBe(true);
    expect(isComment('/* note */ model: "jev-1.13.0",')).toBe(false);
    expect(isComment(" * jev-1.13 leans */")).toBe(true);
  });
});
