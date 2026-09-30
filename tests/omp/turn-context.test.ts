import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RunStore } from "../../src/run/run-store.js";
import { OMP_LOOP_DISCIPLINE } from "../../src/prompt/composer.js";
import {
  assistantIntentFor,
  buildTurnPrompt,
  SCHEDULED_PREFIX,
  systemPromptFingerprint,
  writeSystemPromptFile,
  type TurnContextDeps
} from "../../src/omp/turn-context.js";
import { createQueuedTurnRun } from "../helpers/runs.js";

type Hits = { facts: Array<{ id: number; block: string }>; pages: Array<{ id: number; block: string }> };

function deps(store: RunStore, hits: Hits = { facts: [], pages: [] }): TurnContextDeps {
  const dataDir = mkdtempSync(join(tmpdir(), "htc-"));
  return {
    store,
    memoryRoot: new URL("../../memory", import.meta.url).pathname,
    dataDir,
    lessonsReader: () => undefined,
    skillsReader: () => undefined,
    coreBlock: () => undefined,
    retrieve: async () => hits,
    env: {}
  };
}

describe("turn context — what the planner knows and how ratings attribute (spec §6, plan deviation 1)", () => {
  it("writes the system prompt file with the omp loop discipline and a stable path per chat", () => {
    const d = deps(RunStore.openInMemory());
    const p1 = writeSystemPromptFile(d, "42");
    const p2 = writeSystemPromptFile(d, "42");
    expect(p1).toBe(p2);
    expect(readFileSync(p1, "utf8")).toContain(OMP_LOOP_DISCIPLINE);
  });

  it("changes the fingerprint when an active lesson changes — that is how a live session learns (probed resume)", () => {
    const d = deps(RunStore.openInMemory());
    const before = systemPromptFingerprint(d, "42");
    const d2 = { ...d, lessonsReader: () => "- always answer in two paragraphs" };
    expect(systemPromptFingerprint(d2, "42")).not.toBe(before);
  });

  it("records loop_started with today's exact applied_artifacts field names so rating attribution still works", async () => {
    const store = RunStore.openInMemory();
    const run_id = createQueuedTurnRun(store);
    const d = deps(store, { facts: [{ id: 7, block: "Paco lives in Sydney" }], pages: [{ id: 3, block: "ASML Q2" }] });
    await buildTurnPrompt(d, { run_id, chat_id: "42", message: "hi", source: "telegram" });
    const ev = store.getLedgerEvents(run_id).find((e) => e.event_type === "loop_started");
    expect(Object.keys((ev?.payload as { applied_artifacts: object }).applied_artifacts).sort()).toEqual([
      "episodic_fact_ids",
      "lesson_ids",
      "lesson_scopes",
      "skill_scopes",
      "wiki_page_ids"
    ]);
    expect(ev?.payload).toMatchObject({ applied_artifacts: { episodic_fact_ids: [7], wiki_page_ids: [3] } });
  });

  it("prepends a context block only when retrieval found something, and the schedule prefix only for fires", async () => {
    const store = RunStore.openInMemory();
    const empty = await buildTurnPrompt(deps(store), {
      run_id: createQueuedTurnRun(store),
      chat_id: "1",
      message: "hello",
      source: "telegram"
    });
    expect(empty).toBe("hello");
    const fired = await buildTurnPrompt(deps(store), {
      run_id: createQueuedTurnRun(store),
      chat_id: "1",
      message: "run it",
      source: "schedule",
      goal: "AI日报"
    });
    expect(fired.startsWith(SCHEDULED_PREFIX("AI日报"))).toBe(true);
    const withCtx = await buildTurnPrompt(deps(store, { facts: [{ id: 1, block: "fact-block" }], pages: [] }), {
      run_id: createQueuedTurnRun(store),
      chat_id: "1",
      message: "hello",
      source: "telegram"
    });
    expect(withCtx).toBe("[context]\nfact-block\n[/context]\n\nhello");
  });

  it("labels a tool-less question as clarify so the consecutive-clarify cap keeps its input", () => {
    expect(assistantIntentFor("你是指哪一场比赛？", false)).toBe("clarify");
    expect(assistantIntentFor("Which file do you mean?", false)).toBe("clarify");
    expect(assistantIntentFor("Which file do you mean?", true)).toBe("loop");
    expect(assistantIntentFor("Done — saved to report.md.", false)).toBe("loop");
  });
});
