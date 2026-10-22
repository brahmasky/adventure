import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Jev version check: no Jev version literal decides behaviour. The reported id is data, never a key. A version-shaped
// match (`jev` + an optional separator and `v` + a digit, any case) or a bare prefix literal (`"jev-"`, `` `jev-${…}` ``:
// a version built by concatenation) is allowed only on a .ts comment line, so a note about calibration history stays and
// any code use fails. Every other text file under src/ and deploy/ (.json, .sh, .md, templates) has no comment exemption.
// Final fix G6 widened it; the one allowed line is named by its content, never by a pattern.
const LITERAL = /jev[-_]?v?\d/i;
const PREFIX = /["'`]jev[-_.](["'`]|\$\{)/i;
const ROOT = join(import.meta.dirname, "..", "..");
const SRC = join(ROOT, "src");
const SCANNED = [SRC, join(ROOT, "deploy")];
/** Metered pricing keys TypeSafe's price on the id prefix: a price, never behaviour by version. The only allowed hit. */
const ALLOWED: ReadonlyArray<{ file: string; line: string }> = [{ file: join("src", "llm", "metered-pricing.ts"), line: '"jev-": { input_usd_per_mtok: 0.042, output_usd_per_mtok: 0 }' }];

/** Every text file (no NUL byte) under `dir`. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? sourceFiles(p) : readFileSync(p).includes(0) ? [] : [p];
  });
}
/** A line that starts a comment and carries no code after a closing `*\/` (`/* x *\/ model: "jev-1.13"` is code). */
const isComment = (line: string): boolean => {
  const t = line.trim();
  if (!/^(\/\/|\*|\/\*)/.test(t)) return false;
  const close = t.lastIndexOf("*/");
  return t.startsWith("//") || close === -1 || t.slice(close + 2).trim() === "";
};

const offends = (line: string): boolean => LITERAL.test(line) || PREFIX.test(line);
const allowed = (file: string, line: string): boolean => ALLOWED.some((a) => file === a.file && line.trim() === a.line);

describe("no Jev version literal in src code", () => {
  it("a version literal appears on .ts comment lines only, under src/ and deploy/", () => {
    const hits = SCANNED.flatMap(sourceFiles).flatMap((f) => {
      const rel = f.slice(ROOT.length + 1);
      return readFileSync(f, "utf8").split("\n").flatMap((l, i) => (offends(l) && !(f.endsWith(".ts") && isComment(l)) && !allowed(rel, l) ? [`${rel}:${i + 1}: ${l.trim().slice(0, 100)}`] : []));
    });
    expect(hits).toEqual([]);
  });
  it("the scan covers every text file type under src and deploy (.json, .sh, .md, templates), and the allowed line still exists", () => {
    const files = SCANNED.flatMap(sourceFiles);
    for (const ext of [".json", ".sh", ".md", ".template"]) expect(files.some((f) => f.endsWith(ext)), ext).toBe(true);
    expect(files.some((f) => f.startsWith(join(ROOT, "deploy")))).toBe(true);
    for (const a of ALLOWED) expect(readFileSync(join(ROOT, a.file), "utf8").split("\n").some((l) => l.trim() === a.line), a.file).toBe(true);
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

// Final fix G6 (testing Imp): the guard catches the ways a version slips back in, not only `jev-<n>.<n>`.
describe("the guard's reach (final fix G6)", () => {
  it("catches a prefix, a concatenation, a template, another case or separator", () => {
    for (const bad of ['if (model.startsWith("jev-1.")) arm();', 'const m = "jev-" + "1.13";', "const m = `jev-${major}.${minor}`;", 'model === "JEV_V1"',
      'model === "jev1"', 'const id = "jev-2";']) expect(offends(bad), bad).toBe(true);
  });
  it("spares the request alias, ids that are not versions, and a comment line", () => {
    for (const ok of ['export const JEV_REQUEST_MODEL = "jev-latest";', 'type: "jev_accept_tap",', 'command === "jev-shadow"', "jev_anchor_missing"]) expect(offends(ok), ok).toBe(false);
  });
});
