import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * NOTE: this guard is LEXICAL, not scope-aware. It regex-matches the text following a
 * `createLlmAnswerAdapter(` / spawn-seat call site for an `audit: ...llmAuditSink(` substring —
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

  it("every createLlmAnswerAdapter( construction in src passes a store-built sink", () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (f.endsWith(join("src", "capabilities", "llm-answer.ts"))) continue;
      const text = read(f);
      let i = text.indexOf("createLlmAnswerAdapter(");
      while (i !== -1) {
        if (!/audit:\s*[A-Za-z_.]*llmAuditSink\(/.test(text.slice(i, i + 900))) offenders.push(`${f}@${i}`);
        i = text.indexOf("createLlmAnswerAdapter(", i + 1);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every createLlmAnswerAdapter( construction in src passes meteredBreached", () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (f.endsWith(join("src", "capabilities", "llm-answer.ts"))) continue;
      const text = read(f);
      let i = text.indexOf("createLlmAnswerAdapter(");
      while (i !== -1) {
        if (!/meteredBreached:/.test(text.slice(i, i + 900))) offenders.push(`${f}@${i}`);
        i = text.indexOf("createLlmAnswerAdapter(", i + 1);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every spawn seat call in src passes a store-built sink", () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (f.endsWith(join("src", "capabilities", "idea-panel-seats.ts"))) continue;
      const text = read(f);
      for (const fn of ["spawnCodexJudge(", "spawnPanelChair("]) {
        let i = text.indexOf(fn);
        while (i !== -1) {
          if (!/audit:\s*[A-Za-z_.]*llmAuditSink\(/.test(text.slice(i, i + 600))) offenders.push(`${f}@${i}:${fn}`);
          i = text.indexOf(fn, i + 1);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("nothing writes llm_call any more (llm_attempt supersedes it; history stays readable)", () => {
    expect(files.filter((f) => /["']llm_call["']\s*,\s*["']capability_runner["']/.test(read(f)))).toEqual([]);
    expect(files.filter((f) => read(f).includes("recordLlmCall("))).toEqual([]);
  });

  it("answerWithChain is never called with a discarding inline sink", () => {
    expect(files.filter((f) => /answerWithChain\([^)]*\{\s*record:\s*\(\)\s*=>\s*\{\s*\}\s*\}/.test(read(f)))).toEqual([]);
  });
});
