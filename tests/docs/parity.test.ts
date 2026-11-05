/**
 * Docs-parity checks (AGENTS.md "Build flow": docs sync is a re-read; this is the mechanical half).
 * Each check is a pure function in ./parity.ts. Per check: one live-tree test (the real files give no violation) and
 * one planted-violation test (a minimal fixture proves the check can fail).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ENTRY_IDS } from "../../src/decisions/entry-ids.js";
import {
  ADR_TEMPLATE, COMMAND_ALIASES_NOT_DOCUMENTED, ENV_NOT_CONFIGURATION,
  adrIndexProblems, decisionMapProblems, envDocProblems, envNamesRead, parserCommands, toolNameProblems, commandProblems
} from "./parity.js";

const root = join(import.meta.dirname, "..", "..");
const read = (p: string): string => readFileSync(join(root, p), "utf8");
const walk = (dir: string, ext: string): string[] =>
  readdirSync(join(root, dir), { withFileTypes: true }).flatMap((d) => {
    const rel = join(dir, d.name);
    return d.isDirectory() ? walk(rel, ext) : d.name.endsWith(ext) ? [rel] : [];
  });

describe("README slash commands (check 1)", () => {
  it("documents every command the parser accepts, so Paco is never told about a command that does not exist or misses one that does", () => {
    const cmds = parserCommands(read("src/triggers/telegram-command-parser.ts"));
    expect(cmds.length).toBeGreaterThan(15);
    expect(commandProblems(cmds, read("README.md"), COMMAND_ALIASES_NOT_DOCUMENTED)).toEqual([]);
  });
  it("fails when the parser gains a command the README does not mention", () => {
    const parser = 'if (command === "/run") return a;\nif (command === "/newcmd") return b;\nif (command === "/old" || command === "/old-alias") return c;';
    expect(parserCommands(parser)).toEqual(["/newcmd", "/old", "/old-alias", "/run"]);
    expect(commandProblems(["/newcmd", "/run"], "use `/run <x>` here", new Map())).toEqual(["README.md does not mention parser command /newcmd"]);
  });
});

describe("README tools (check 2)", () => {
  it("names every omp tool stub in the README, so the tool table is the tool list", () => {
    const files = walk("src/omp/tools", ".json").map((p) => read(p));
    expect(files.length).toBeGreaterThan(10);
    expect(toolNameProblems(files, read("README.md"))).toEqual([]);
  });
  it("fails when a declared tool is missing from the README", () => {
    expect(toolNameProblems(['{"name":"bash"}', '{"name":"new_tool"}'], "the `bash` tool")).toEqual(["README.md does not mention tool `new_tool`"]);
  });
});

describe("configuration.md env vars (check 3)", () => {
  const srcTexts = (): string[] => walk("src", ".ts").map((p) => read(p));
  it("documents every HOUGE_* variable src reads, so a deployer can find every knob", () => {
    const doc = read("docs/reference/configuration.md");
    expect(envDocProblems(srcTexts(), doc, ENV_NOT_CONFIGURATION)).toEqual([]);
  });
  it("only allowlists names that src still contains, so the allowlist cannot rot", () => {
    const names = envNamesRead(srcTexts());
    expect(Object.keys(ENV_NOT_CONFIGURATION).filter((n) => !names.has(n))).toEqual([]);
  });
  it("fails on an undocumented variable and ignores an allowlisted one", () => {
    const doc = "| `HOUGE_A` | x |";
    expect(envDocProblems(["process.env.HOUGE_A; process.env.HOUGE_B; HOUGE_C"], doc, { HOUGE_C: "constant" }))
      .toEqual(["configuration.md does not document HOUGE_B (read in src)"]);
  });
});

describe("decision-map registry entries (check 4)", () => {
  it("lists every registry entry and invents none, so the map is the live ladder", () => {
    expect(decisionMapProblems(ENTRY_IDS, read("docs/reference/decision-map.md"))).toEqual([]);
  });
  it("fails on a missing entry and on a documented entry the registry lacks", () => {
    const doc = "## Registry entries\n\n| Entry | Rungs |\n|---|---|\n| `turn.handler` | x |\n| `ghost.entry` | y |\n\n## Paths\n| `tool.other` | z |";
    expect(decisionMapProblems(["turn.handler", "turn.gear"], doc)).toEqual([
      "decision-map.md does not list registry entry turn.gear",
      "decision-map.md lists ghost.entry, which is not in the registry"
    ]);
  });
});

describe("ADR index (check 5)", () => {
  it("indexes every ADR file and every index link resolves, so no decision is orphaned or dangling", () => {
    const files = readdirSync(join(root, "docs/decisions")).filter((f) => /^\d{4}-.*\.md$/.test(f));
    expect(files.length).toBeGreaterThan(30);
    expect(adrIndexProblems(files, read("docs/decisions/README.md"), ADR_TEMPLATE)).toEqual([]);
  });
  it("fails on an unindexed ADR and on a link to a missing file", () => {
    const index = "| [0001](0001-a.md) | A |\n| [0009](0009-gone.md) | G |";
    expect(adrIndexProblems(["0000-template.md", "0001-a.md", "0002-b.md"], index, ADR_TEMPLATE)).toEqual([
      "docs/decisions/README.md has no row linking 0002-b.md",
      "docs/decisions/README.md links 0009-gone.md, which does not exist"
    ]);
  });
});
