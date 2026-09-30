import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * NOTE: this guard is LEXICAL, not scope-aware. It regex-matches the text following a
 * seat call site for an `audit`/`llmAuditSink(` substring —
 * it does not resolve identifiers or trace where a value came from. Two shapes would fool it in
 * opposite directions:
 *   - a wrapper like `audit: buildSink()` would FALSE-NEGATIVE (pass) even if `buildSink` does
 *     not build its sink from `store.llmAuditSink(...)` at all;
 *   - a hoisted `const audit = store.llmAuditSink(...)` reused via shorthand `{ audit }` at the
 *     call site would FALSE-POSITIVE (fail) even though the sink IS store-built, because the
 *     literal text `llmAuditSink(` does not appear near the call site.
 * Neither shape exists in src today. The convention this guard enforces is deliberately narrow:
 * call `llmAuditSink(` inline, at the construction site, every time.
 */

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (entry.endsWith(".ts")) acc.push(full);
  }
  return acc;
}
const files = sourceFiles(join(process.cwd(), "src"));
const read = (f: string) => readFileSync(f, "utf8");

describe("audit chokepoint coverage (structural, not by convention)", () => {
  it("no onUsage hook survives anywhere in src/", () => {
    expect(files.filter((f) => read(f).includes("onUsage"))).toEqual([]);
  });

  it("no production file imports the tests-only sinks", () => {
    expect(files.filter((f) => read(f).includes("helpers/llm-audit"))).toEqual([]);
  });

  it("the omp one-shot seat audits EVERY leg through a REQUIRED sink (ok and error both recorded)", () => {
    const omp = read(join(process.cwd(), "src", "llm", "providers", "omp.ts"));
    expect(omp).toMatch(/audit: LlmAuditSink;/); // required, never `audit?:`
    expect(omp.match(/deps\.audit\.record\(/g) ?? []).toHaveLength(2);
  });

  it("every spawnOneShot( call site builds its sink inline from the store, or forwards the caller's REQUIRED sink explicitly", () => {
    const offenders: string[] = [];
    let sites = 0;
    for (const f of files) {
      if (f.endsWith(join("src", "llm", "providers", "omp.ts"))) continue;
      const text = read(f);
      for (let i = text.indexOf("spawnOneShot("); i !== -1; i = text.indexOf("spawnOneShot(", i + 1)) {
        if (text.slice(Math.max(0, i - 40), i).includes("import")) continue;
        sites += 1;
        if (!/audit:\s*(?:[A-Za-z_.]*llmAuditSink\(|input\.audit\b)/.test(text.slice(i, i + 600))) offenders.push(`${f}@${i}`);
      }
    }
    expect(offenders).toEqual([]);
    expect(sites).toBeGreaterThan(0);
  });

  it("reviewDiff's sink is required, and every reviewDiff({…}) call in src passes a store-built one", () => {
    const reviewer = read(join(process.cwd(), "src", "capabilities", "diff-reviewer.ts"));
    const iface = reviewer.slice(reviewer.indexOf("export interface ReviewDiffInput"), reviewer.indexOf("interface NodeError"));
    expect(iface).toMatch(/\n  audit: LlmAuditSink;/); // required, never `audit?:`
    const offenders: string[] = [];
    let sites = 0;
    for (const f of files) {
      const text = read(f);
      for (let i = text.indexOf("reviewDiff({"); i !== -1; i = text.indexOf("reviewDiff({", i + 1)) {
        sites += 1;
        if (!/audit:\s*[A-Za-z_.]*llmAuditSink\(/.test(text.slice(i, i + 400))) offenders.push(`${f}@${i}`);
      }
    }
    expect(offenders).toEqual([]);
    expect(sites).toBeGreaterThan(0);
  });

  it("oneShotAdapter builds its sink from the store for the call's scope (no caller can pass a discarding one)", () => {
    const registry = read(join(process.cwd(), "src", "llm", "registry.ts"));
    const body = registry.slice(registry.indexOf("export function oneShotAdapter("), registry.indexOf("function reportVersionMismatch("));
    expect(body).toContain("store.llmAuditSink(scope)");
  });

  it("the planner supervisor writes its llm_attempt rows only through the store's sink", () => {
    const sup = read(join(process.cwd(), "src", "omp", "planner-supervisor.ts"));
    expect(sup).toContain("llmAuditSink(");
    expect(sup).not.toMatch(/appendLedgerEvent\([^)]*llm_attempt/);
  });

  it("nothing writes llm_call any more (llm_attempt supersedes it; history stays readable)", () => {
    expect(files.filter((f) => /["']llm_call["']\s*,\s*["']capability_runner["']/.test(read(f)))).toEqual([]);
    expect(files.filter((f) => read(f).includes("recordLlmCall("))).toEqual([]);
  });

  it("answerWithChain is never called with a discarding inline sink", () => {
    expect(files.filter((f) => /answerWithChain\([^)]*\{\s*record:\s*\(\)\s*=>\s*\{\s*\}\s*\}/.test(read(f)))).toEqual([]);
  });

  it("every createJevClient( call site in src passes a store-built sink and meteredBreached (Jev spec 2026-09-25)", () => {
    const offenders: string[] = [];
    let sites = 0;
    for (const f of files) {
      if (f.endsWith(join("src", "jev", "jev-client.ts"))) continue;
      const text = read(f);
      let i = text.indexOf("createJevClient(");
      while (i !== -1) {
        sites += 1;
        const window = text.slice(i, i + 900);
        if (!/audit:\s*[A-Za-z_.]*llmAuditSink\(/.test(window) || !/meteredBreached:/.test(window)) offenders.push(`${f}@${i}`);
        i = text.indexOf("createJevClient(", i + 1);
      }
    }
    expect(offenders).toEqual([]);
    expect(sites).toBeGreaterThan(0); // the CLI site exists — a guard over zero sites guards nothing
  });
});
