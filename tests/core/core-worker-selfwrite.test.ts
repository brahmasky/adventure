import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoreWorker } from "../../src/core/core-worker.js";
import type { SelfWriteDeps } from "../../src/core/core-worker.js";
import { INTENT_DISCIPLINE } from "../../src/capabilities/intent.js";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";
import type { ToolAdapterResult } from "../../src/tools/tool-registry.js";
import type { TestGateResult } from "../../src/run/test-gate.js";
import type { ReviewResult } from "../../src/capabilities/diff-reviewer.js";
import type { GuardResult } from "../../src/capabilities/self-write-guard.js";

let dirs: string[] = [];
function projectRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-selfwrite-"));
  dirs.push(dir);
  return dir;
}

let prevFlag: string | undefined;
beforeEach(() => {
  prevFlag = process.env.HOUGE_SELFWRITE_ENABLED;
});
afterEach(() => {
  if (prevFlag === undefined) delete process.env.HOUGE_SELFWRITE_ENABLED;
  else process.env.HOUGE_SELFWRITE_ENABLED = prevFlag;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** Enqueue a write-intent selfcode `turn`. */
function turnRun(store: RunStore, message: string, key = `sw:${message}`): string {
  const intake = new Gateway(store).intake(
    buildTypedTaskEvent({
      source: "telegram",
      type: "turn",
      program: "turn",
      goal: message,
      requested_by: { kind: "user", id: "paco" },
      notify: { kind: "telegram", chat_id: "777" },
      idempotency_key: key,
      source_reference: "telegram:update:1:message:1"
    })
  );
  if (!intake.ok) throw new Error(`intake failed: ${JSON.stringify(intake)}`);
  return intake.run_id;
}

/** Classifier returns selfcode; everything else echoes the question. */
function llm(verdict = '{"intent":"selfcode","query":"intent router"}'): (input: Record<string, unknown>) => Promise<ToolAdapterResult> {
  return async (input) => {
    const system = typeof input.system === "string" ? input.system : "";
    const answer = system.includes(INTENT_DISCIPLINE) ? verdict : `ANSWER: ${input.question}`;
    return { ok: true, output: { question: input.question, answer, model: "fake", provider: "fake" } };
  };
}

/**
 * A fully-mocked self-write stack. The base wiring is the happy path (guard allows, tests green,
 * reviewer pass); each test overrides the fields it exercises. `teardowns` records worktree
 * teardown calls so we can assert the finally always runs.
 */
function deps(overrides: Partial<SelfWriteDeps>, log: { teardowns: string[]; writeTasks: string[]; published: string[] }): SelfWriteDeps {
  const base: SelfWriteDeps = {
    createWorktree: () => ({ path: "/fake/wt" }),
    removeWorktree: (p) => { log.teardowns.push(p); },
    mkNodeModulesLink: () => {},
    makeWriteAdapter: () => (input: { task: string }): ToolAdapterResult => {
      log.writeTasks.push(input.task);
      return { ok: true, output: { worktree: "/fake/wt", model: "fake", bin: "codex" } };
    },
    rawDiff: () => ":100644 100644 a b M\tsrc/capabilities/intent.ts\n",
    unifiedDiff: () => "diff --git a/src/capabilities/intent.ts b/src/capabilities/intent.ts\n+fixed",
    runTestGate: (): TestGateResult => ({ green: true }),
    reviewDiff: (): ReviewResult => ({ ok: true, verdict: { verdict: "pass", fixes_task: true, introduces_bugs: false, scope_creep: false, reasons: [] } }),
    publishBranch: (_wt, branch) => { log.published.push(branch); return branch; }
  };
  return { ...base, ...overrides };
}

function makeWorker(store: RunStore, d: SelfWriteDeps, verdict?: string): CoreWorker {
  return new CoreWorker(store, projectRoot(), llm(verdict), undefined, undefined, d);
}

describe("runSelfWrite (Phase 3 orchestration)", () => {
  it("happy path: all three checkers green → publishes the branch, records self_write_published, tears down the worktree", async () => {
    process.env.HOUGE_SELFWRITE_ENABLED = "1";
    const store = RunStore.openInMemory();
    const log = { teardowns: [] as string[], writeTasks: [] as string[], published: [] as string[] };
    try {
      const run_id = turnRun(store, "fix the intent router so it sees your identity");
      const result = await makeWorker(store, deps({}, log)).executeRun(run_id, "w");
      expect(result.status).toBe("completed");

      // The branch was published exactly once with the run-id name.
      expect(log.published).toEqual([`houge/selfwrite/${run_id}`]);
      // The write task framed it as EDITING Houge's own source (DATA channel).
      expect(log.writeTasks[0]).toContain("EDITING");
      expect(log.writeTasks[0]).toContain("fix the intent router");
      // The worktree was torn down in the finally.
      expect(log.teardowns).toEqual(["/fake/wt"]);

      // The published event carries branch + verdict + gate results.
      const events = store.getLedgerEvents(run_id).filter((e) => e.event_type === "self_write_published");
      expect(events.length).toBe(1);
      expect(events[0]!.payload.branch).toBe(`houge/selfwrite/${run_id}`);
      expect((events[0]!.payload.gate_results as Record<string, unknown>).reviewer).toBe("pass");

      // The success notification is in Houge's voice and names the branch.
      const turns = store.getRecentChatTurns("777", 6);
      const last = turns[turns.length - 1]!;
      expect(last.intent).toBe("selfcode");
      expect(last.text).toContain("🐒 Fixed");
      expect(last.text).toContain(`houge/selfwrite/${run_id}`);
    } finally {
      store.close();
    }
  });

  it("HARD-DENY: guard denies a protected path → self_write_blocked, NOTHING published, worktree torn down", async () => {
    process.env.HOUGE_SELFWRITE_ENABLED = "1";
    const store = RunStore.openInMemory();
    const log = { teardowns: [] as string[], writeTasks: [] as string[], published: [] as string[] };
    try {
      const run_id = turnRun(store, "fix it by editing package.json");
      const denied: GuardResult = { allowed: false, denied: [{ path: "package.json", status: "M", reason: "protected path: package.json" }] };
      // rawDiff returns a protected modification → the real guard denies it.
      const d = deps({ rawDiff: () => ":100644 100644 a b M\tpackage.json\n" }, log);
      const result = await makeWorker(store, d).executeRun(run_id, "w");
      expect(result.status).toBe("completed");
      void denied;

      // Nothing published, ever.
      expect(log.published).toEqual([]);
      // Blocked event recorded with the attempted protected path.
      const blocked = store.getLedgerEvents(run_id).filter((e) => e.event_type === "self_write_blocked");
      expect(blocked.length).toBe(1);
      const paths = blocked[0]!.payload.attempted_paths as Array<Record<string, unknown>>;
      expect(paths.some((p) => p.path === "package.json")).toBe(true);
      // No published event.
      expect(store.getLedgerEvents(run_id).some((e) => e.event_type === "self_write_published")).toBe(false);
      // Worktree torn down.
      expect(log.teardowns).toEqual(["/fake/wt"]);
      // Hard-deny notification names the locked surface and that it's Paco's to make.
      const turns = store.getRecentChatTurns("777", 6);
      const last = turns[turns.length - 1]!;
      expect(last.text).toContain("package.json");
      expect(last.text.toLowerCase()).toContain("locked surface");
    } finally {
      store.close();
    }
  });

  it("tests red after refine cap (3 writes) → self_write_failed, nothing published, worktree torn down", async () => {
    process.env.HOUGE_SELFWRITE_ENABLED = "1";
    const store = RunStore.openInMemory();
    const log = { teardowns: [] as string[], writeTasks: [] as string[], published: [] as string[] };
    try {
      const run_id = turnRun(store, "fix the router");
      const d = deps({ runTestGate: (): TestGateResult => ({ green: false, stage: "test", output: "1 failing" }) }, log);
      const result = await makeWorker(store, d).executeRun(run_id, "w");
      expect(result.status).toBe("completed");

      // Refine capped at 3 TOTAL write attempts.
      expect(log.writeTasks.length).toBe(3);
      expect(log.published).toEqual([]);
      const failed = store.getLedgerEvents(run_id).filter((e) => e.event_type === "self_write_failed");
      expect(failed.length).toBe(1);
      expect(String(failed[0]!.payload.reason)).toContain("tests red");
      expect(log.teardowns).toEqual(["/fake/wt"]);
      const turns = store.getRecentChatTurns("777", 6);
      expect(turns[turns.length - 1]!.text.toLowerCase()).toContain("tests red");
    } finally {
      store.close();
    }
  });

  it("reviewer reject after refine cap (3 writes) → self_write_failed, nothing published", async () => {
    process.env.HOUGE_SELFWRITE_ENABLED = "1";
    const store = RunStore.openInMemory();
    const log = { teardowns: [] as string[], writeTasks: [] as string[], published: [] as string[] };
    try {
      const run_id = turnRun(store, "fix the router");
      const d = deps({
        reviewDiff: (): ReviewResult => ({ ok: true, verdict: { verdict: "reject", fixes_task: false, introduces_bugs: true, scope_creep: false, reasons: ["does not actually fix it"] } })
      }, log);
      const result = await makeWorker(store, d).executeRun(run_id, "w");
      expect(result.status).toBe("completed");

      expect(log.writeTasks.length).toBe(3);
      expect(log.published).toEqual([]);
      const failed = store.getLedgerEvents(run_id).filter((e) => e.event_type === "self_write_failed");
      expect(failed.length).toBe(1);
      expect(String(failed[0]!.payload.reason)).toContain("reviewer rejected");
      const turns = store.getRecentChatTurns("777", 6);
      expect(turns[turns.length - 1]!.text).toContain("does not actually fix it");
    } finally {
      store.close();
    }
  });

  it("worktree teardown ALWAYS runs even when a mid-stage throws (finally invariant)", async () => {
    process.env.HOUGE_SELFWRITE_ENABLED = "1";
    const store = RunStore.openInMemory();
    const log = { teardowns: [] as string[], writeTasks: [] as string[], published: [] as string[] };
    try {
      const run_id = turnRun(store, "fix the router");
      // The test gate throws unexpectedly (not a clean red result) AFTER the worktree exists.
      const d = deps({ runTestGate: () => { throw new Error("gate exploded"); } }, log);
      // The throw propagates (no swallow), but the worktree must STILL be torn down by the finally.
      await expect(makeWorker(store, d).executeRun(run_id, "w")).rejects.toThrow(/gate exploded/);
      expect(log.teardowns).toEqual(["/fake/wt"]); // no worktree leak on throw
      expect(log.published).toEqual([]); // nothing published on a throw
    } finally {
      store.close();
    }
  });

  it("diff READ failure fails CLOSED (hard-deny), never publishes", async () => {
    process.env.HOUGE_SELFWRITE_ENABLED = "1";
    const store = RunStore.openInMemory();
    const log = { teardowns: [] as string[], writeTasks: [] as string[], published: [] as string[] };
    try {
      const run_id = turnRun(store, "fix the router");
      // Reading the worktree diff fails: the guard cannot prove safety → must DENY (fail-closed),
      // recording self_write_blocked and publishing nothing.
      const d = deps({ rawDiff: () => { throw new Error("git diff failed"); } }, log);
      const result = await makeWorker(store, d).executeRun(run_id, "w");
      expect(result.status).toBe("completed");
      expect(log.published).toEqual([]);
      const blocked = store.getLedgerEvents(run_id).filter((e) => e.event_type === "self_write_blocked");
      expect(blocked.length).toBe(1);
      expect(store.getLedgerEvents(run_id).some((e) => e.event_type === "self_write_published")).toBe(false);
      expect(log.teardowns).toEqual(["/fake/wt"]);
    } finally {
      store.close();
    }
  });

  it("worktree SETUP failure records self_write_failed, nothing published, no leak", async () => {
    process.env.HOUGE_SELFWRITE_ENABLED = "1";
    const store = RunStore.openInMemory();
    const log = { teardowns: [] as string[], writeTasks: [] as string[], published: [] as string[] };
    try {
      const run_id = turnRun(store, "fix the router");
      // createWorktree throws (e.g. git unavailable) → no worktree to operate on or leak.
      const d = deps({ createWorktree: () => { throw new Error("git worktree add failed"); } }, log);
      const result = await makeWorker(store, d).executeRun(run_id, "w");
      expect(result.status).toBe("completed");
      expect(log.writeTasks).toEqual([]); // never reached the writer
      expect(log.published).toEqual([]);
      const failed = store.getLedgerEvents(run_id).filter((e) => e.event_type === "self_write_failed");
      expect(failed.length).toBe(1);
      expect(String(failed[0]!.payload.reason)).toContain("worktree setup failed");
    } finally {
      store.close();
    }
  });

  it("a tests-RED then GREEN sequence publishes after ONE refine (refine loop actually re-writes)", async () => {
    process.env.HOUGE_SELFWRITE_ENABLED = "1";
    const store = RunStore.openInMemory();
    const log = { teardowns: [] as string[], writeTasks: [] as string[], published: [] as string[] };
    try {
      const run_id = turnRun(store, "fix the router");
      let gateCalls = 0;
      const d = deps({
        runTestGate: (): TestGateResult => {
          gateCalls += 1;
          return gateCalls === 1 ? { green: false, stage: "test", output: "1 failing" } : { green: true };
        }
      }, log);
      const result = await makeWorker(store, d).executeRun(run_id, "w");
      expect(result.status).toBe("completed");
      // Two write attempts (initial + one refine), then publish — proves refine feeds back, capped behavior.
      expect(log.writeTasks.length).toBe(2);
      expect(log.writeTasks[1]).toContain("test gate failed"); // the refine task carries the failure
      expect(log.published).toEqual([`houge/selfwrite/${run_id}`]);
    } finally {
      store.close();
    }
  });

  it("HOUGE_SELFWRITE_ENABLED=false: a write-intent selfcode does NOT write — falls back to diagnose", async () => {
    delete process.env.HOUGE_SELFWRITE_ENABLED;
    const store = RunStore.openInMemory();
    const log = { teardowns: [] as string[], writeTasks: [] as string[], published: [] as string[] };
    // Codex (read-only diagnose) is also off → graceful degrade to a normal answer; assert no write path runs.
    const prevCodex = process.env.HOUGE_CODEX_ENABLED;
    delete process.env.HOUGE_CODEX_ENABLED;
    try {
      const run_id = turnRun(store, "fix the intent router so it sees your identity");
      const d = deps({}, log);
      const result = await makeWorker(store, d).executeRun(run_id, "w");
      expect(result.status).toBe("completed");

      // The write stack was never entered: no worktree, no write task, no publish, no events.
      expect(log.writeTasks).toEqual([]);
      expect(log.published).toEqual([]);
      expect(log.teardowns).toEqual([]);
      expect(store.getLedgerEvents(run_id).some((e) => String(e.event_type).startsWith("self_write_"))).toBe(false);
    } finally {
      if (prevCodex === undefined) delete process.env.HOUGE_CODEX_ENABLED;
      else process.env.HOUGE_CODEX_ENABLED = prevCodex;
      store.close();
    }
  });
});
