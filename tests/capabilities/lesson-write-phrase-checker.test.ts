import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryWriteAdapter, createSrcPhraseChecker } from "../../src/capabilities/lesson-write.js";
import { memorySources } from "../../src/capabilities/memory-sources.js";

const roots: string[] = [];

function sourceRoot(source: string): string {
  const root = mkdtempSync(join(tmpdir(), "houge-lesson-phrase-"));
  roots.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "labels.ts"), source);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("createSrcPhraseChecker", () => {
  it("saves a preference when an earlier user's regate quote only occurs inside aggregate", async () => {
    const srcContains = createSrcPhraseChecker(sourceRoot('const label = "aggregate";\n'));
    const saved: string[] = [];
    const feedback = "From now on, end every reply with 西瓜. Save that as a lesson.";
    const adapter = createMemoryWriteAdapter({
      sources: memorySources({ own: { run_id: "r", turn_id: null, text: feedback }, steered: [], quoted: null, recent: [], prior: "" }),
      threadUserTexts: ['Make an empty commit with message "regate".'],
      allowedScopes: ["ask"],
      defaultScope: "ask",
      srcContains,
      llm: async () => ({ ok: true, output: { answer: '{"kind":"rule","lesson":"End every reply with 西瓜"}' } }),
      recorder: { record: () => null },
      run_id: "r",
      runSource: () => "telegram",
      save: async (plan) => {
        saved.push(plan.lesson!.text);
        return { lesson: { verb: "add", id: 1, lesson: plan.lesson!.text, prunedIds: [] } };
      }
    });

    expect(await adapter({ scope: "ask" })).toMatchObject({ ok: true, output: { saved: true, kinds: ["rule"], items: [{ kind: "rule", id: 1, verb: "add" }] } });
    expect(saved).toEqual(["End every reply with 西瓜"]);
  });

  it("still finds a code-owned Latin phrase as whole words", () => {
    const contains = createSrcPhraseChecker(sourceRoot('const label = "fixed response label";\n'));
    expect(contains("fixed response label")).toBe(true);
  });

  it("still finds a CJK phrase inside a longer source string", () => {
    const contains = createSrcPhraseChecker(sourceRoot('const label = "前缀自我修改状态后缀";\n'));
    expect(contains("自我修改状态")).toBe(true);
  });
});
