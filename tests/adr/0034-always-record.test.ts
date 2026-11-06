/**
 * Rule: ADR 0034 rule 4 (the entry table) marks every entry that always records with `alwaysRecord`
 * (docs/decisions/0034-decision-ladder-consolidated.md). The entries whose row says `alwaysRecord` equal the registry
 * entries with `alwaysRecord: true`: an entry that starts or stops always recording without its row changing fails.
 * Changing this rule changes this test in the same commit.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REGISTRY } from "../../src/decisions/registry.js";

const adr = readFileSync(join(import.meta.dirname, "..", "..", "docs", "decisions", "0034-decision-ladder-consolidated.md"), "utf8");

/** Rows of the rule 4 table: `| \`<id>\` | stage · input | locked | rows written … |`; the id cell is the first. */
function adrAlwaysRecord(text: string): string[] {
  const section = text.slice(text.indexOf("### 4. The entries"));
  const table = section.slice(0, section.indexOf("\n### ", 1));
  // The parser reads the 4th cell as "rows written"; a reshaped table must change this test, not pass it silently.
  if (!table.includes("\n| Id | Stage · input | Locked | Rows written, and when | From |\n")) throw new Error("ADR 0034 rule 4 table header changed");
  return table.split("\n")
    .map((line) => /^\| `([a-z_.]+)` \|(?:[^|]*\|){2}([^|]*)\|/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null && m[2]!.includes("`alwaysRecord`"))
    .map((m) => m[1]!)
    .sort();
}

describe("ADR 0034 rule 4: alwaysRecord", () => {
  it("the entries the ADR marks `alwaysRecord` are exactly the registry's", () => {
    const code = REGISTRY.filter((e) => e.alwaysRecord === true).map((e) => e.id).sort();
    expect(code.length).toBeGreaterThan(0);
    expect(adrAlwaysRecord(adr)).toEqual(code);
  });
});
