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
import { runSelfWriter, resolveSelfWriteWriter } from "../../src/capabilities/self-write-writer.js";

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
    // The mocked write adapter mirrors the REAL writer's output shape (provider/model/usageRaw) so
    // the W3 writer-telemetry path runs: a codex `--json` token_count line normalizes to usage.
    makeWriteAdapter: () => (input: { task: string }): ToolAdapterResult => {
      log.writeTasks.push(input.task);
      return {
        ok: true,
        output: {
          worktree: "/fake/wt",
          provider: "codex",
          model: "gpt-fake",
          usageRaw: JSON.stringify({ type: "token_count", info: { total_token_usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 5 } } })
        }
      };
    },
    rawDiff: () => ":100644 100644 a b M\tsrc/capabilities/intent.ts\n",
    unifiedDiff: () => "diff --git a/src/capabilities/intent.ts b/src/capabilities/intent.ts\n+fixed",
    runTestGate: (): TestGateResult => ({ green: true }),
    // The reviewer reports normalized usage on the same call (W2) → W3 records a `reviewer` llm_call.
    reviewDiff: (): ReviewResult => ({ ok: true, verdict: { verdict: "pass", fixes_task: true, introduces_bugs: false, scope_creep: false, reasons: [] }, usage: { input_tokens: 200, output_tokens: 40, cached_input_tokens: 10, cost_usd: 0.08 } }),
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

      // Phase 3.3: the PUBLISHED final-report notification carries the three merge-control buttons,
      // each targeting THIS run id, so a Telegram tap routes back to the right branch.
      const notif = store.claimNextNotification("test-claim", 60);
      expect(notif).not.toBeNull();
      expect(notif!.intent_type).toBe("final_report");
      const buttons = notif!.payload.buttons;
      expect(buttons).toEqual([
        { text: "🔀 Merge & reload", data: `selfwrite:merge:${run_id}` },
        { text: "👀 View diff", data: `selfwrite:view:${run_id}` },
        { text: "🗑 Discard", data: `selfwrite:discard:${run_id}` }
      ]);
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

      // Phase 3.3: a BLOCKED notification carries NO merge-control buttons (only a publish does).
      const notif = store.claimNextNotification("test-claim", 60);
      expect(notif).not.toBeNull();
      expect(notif!.payload.buttons).toBeUndefined();
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

  it("an existing-test edit is REFINABLE (not terminal): edit-a-test then clean → publishes", async () => {
    process.env.HOUGE_SELFWRITE_ENABLED = "1";
    const store = RunStore.openInMemory();
    const log = { teardowns: [] as string[], writeTasks: [] as string[], published: [] as string[] };
    try {
      const run_id = turnRun(store, "fix the router");
      let diffCalls = 0;
      const d = deps({
        // Attempt 1: the writer edited an EXISTING test (M on tests/…) → guard denies. Attempt 2: clean.
        rawDiff: () => {
          diffCalls += 1;
          return diffCalls === 1
            ? ":100644 100644 a b M\ttests/prompt/composer.test.ts\n"
            : ":100644 100644 a b M\tsrc/capabilities/intent.ts\n";
        }
      }, log);
      const result = await makeWorker(store, d).executeRun(run_id, "w");
      expect(result.status).toBe("completed");
      // It refined (did NOT terminally block) and published; the refine task names the test-edit mistake.
      expect(log.writeTasks.length).toBe(2);
      expect(log.writeTasks[1]).toMatch(/existing test|backward-compatible/i);
      expect(log.published).toEqual([`houge/selfwrite/${run_id}`]);
      // No blocked event was recorded (the test edit never landed, but it wasn't an escalation either).
      expect(store.getLedgerEvents(run_id).some((e) => e.event_type === "self_write_blocked")).toBe(false);
    } finally {
      store.close();
    }
  });

  it("a NON-test protected edit stays TERMINAL even with refines available (escalation, not refinable)", async () => {
    process.env.HOUGE_SELFWRITE_ENABLED = "1";
    const store = RunStore.openInMemory();
    const log = { teardowns: [] as string[], writeTasks: [] as string[], published: [] as string[] };
    try {
      const run_id = turnRun(store, "fix the router");
      // package.json edit on attempt 1 → terminal hard-deny (no refine), even though attempts remain.
      const d = deps({ rawDiff: () => ":100644 100644 a b M\tpackage.json\n" }, log);
      const result = await makeWorker(store, d).executeRun(run_id, "w");
      expect(result.status).toBe("completed");
      expect(log.writeTasks.length).toBe(1); // terminal — no refine
      expect(log.published).toEqual([]);
      expect(store.getLedgerEvents(run_id).some((e) => e.event_type === "self_write_blocked")).toBe(true);
    } finally {
      store.close();
    }
  });

  it("Phase 3.1 (W3): writer dispatch honors HOUGE_SELFWRITE_WRITER — claude with no bin fails the write (proves dispatch)", async () => {
    process.env.HOUGE_SELFWRITE_ENABLED = "1";
    const prevWriter = process.env.HOUGE_SELFWRITE_WRITER;
    const prevBin = process.env.HOUGE_CLAUDE_BIN;
    process.env.HOUGE_SELFWRITE_WRITER = "claude";
    delete process.env.HOUGE_CLAUDE_BIN; // claude writer disabled → runSelfWriter returns ok:false without spawning
    const store = RunStore.openInMemory();
    const log = { teardowns: [] as string[], writeTasks: [] as string[], published: [] as string[] };
    try {
      const run_id = turnRun(store, "fix the router");
      // The write adapter dispatches via the REAL runSelfWriter (mirrors the default dep), so the
      // configured writer flag decides the engine. With WRITER=claude and no bin, the writer is
      // disabled and the write fails — proving dispatch honored the flag (codex would not error here).
      const d = deps({
        makeWriteAdapter: () => (input: { task: string }): ToolAdapterResult => {
          log.writeTasks.push(input.task);
          const r = runSelfWriter({ writer: resolveSelfWriteWriter(process.env), worktree: "/fake/wt", task: input.task, env: process.env });
          if (!r.ok) return { ok: false, error: r.error };
          return { ok: true, output: { worktree: "/fake/wt", provider: r.provider, model: r.model, usageRaw: r.usageRaw } };
        }
      }, log);
      const result = await makeWorker(store, d).executeRun(run_id, "w");
      expect(result.status).toBe("completed");
      const failed = store.getLedgerEvents(run_id).filter((e) => e.event_type === "self_write_failed");
      expect(failed.length).toBe(1);
      // The error proves the CLAUDE writer was dispatched (codex would not mention claude).
      expect(String(failed[0]!.payload.reason).toLowerCase()).toContain("claude writer disabled");
      expect(store.getLedgerEvents(run_id).some((e) => e.event_type === "self_write_published")).toBe(false);
    } finally {
      if (prevWriter === undefined) delete process.env.HOUGE_SELFWRITE_WRITER;
      else process.env.HOUGE_SELFWRITE_WRITER = prevWriter;
      if (prevBin === undefined) delete process.env.HOUGE_CLAUDE_BIN;
      else process.env.HOUGE_CLAUDE_BIN = prevBin;
      store.close();
    }
  });

  it("Phase 3.1 (W3): a successful run records a `writer` llm_call AND a `reviewer` llm_call", async () => {
    process.env.HOUGE_SELFWRITE_ENABLED = "1";
    const store = RunStore.openInMemory();
    const log = { teardowns: [] as string[], writeTasks: [] as string[], published: [] as string[] };
    try {
      const run_id = turnRun(store, "fix the router");
      const result = await makeWorker(store, deps({}, log)).executeRun(run_id, "w");
      expect(result.status).toBe("completed");

      const llmCalls = store.getLedgerEvents(run_id).filter((e) => e.event_type === "llm_call");
      const writer = llmCalls.find((e) => e.payload.role === "writer");
      const reviewer = llmCalls.find((e) => e.payload.role === "reviewer");
      expect(writer).toBeDefined();
      expect(reviewer).toBeDefined();
      // Writer telemetry came from the (codex) usageRaw normalize: 100 in + 20 out.
      expect(writer!.payload.provider).toBe("codex");
      expect(writer!.payload.input_tokens).toBe(100);
      expect(writer!.payload.output_tokens).toBe(20);
      expect(typeof writer!.payload.latency_ms).toBe("number");
      // Reviewer telemetry came from review.usage: 200 in + 40 out + cost.
      expect(reviewer!.payload.input_tokens).toBe(200);
      expect(reviewer!.payload.cost_usd).toBe(0.08);
    } finally {
      store.close();
    }
  });

  it("Phase 3.1 (W3): the published event carries usage_summary {writer, reviewer}", async () => {
    process.env.HOUGE_SELFWRITE_ENABLED = "1";
    const store = RunStore.openInMemory();
    const log = { teardowns: [] as string[], writeTasks: [] as string[], published: [] as string[] };
    try {
      const run_id = turnRun(store, "fix the router");
      await makeWorker(store, deps({}, log)).executeRun(run_id, "w");
      const pub = store.getLedgerEvents(run_id).filter((e) => e.event_type === "self_write_published");
      expect(pub.length).toBe(1);
      const summary = pub[0]!.payload.usage_summary as { writer?: Record<string, unknown>; reviewer?: Record<string, unknown> };
      expect(summary).toBeDefined();
      expect(summary.writer).toEqual({ provider: "codex", model: "gpt-fake", total_tokens: 120 });
      expect(summary.reviewer!.total_tokens).toBe(240);
      expect(summary.reviewer!.cost_usd).toBe(0.08);
      // No bodies/diffs/prompts leaked.
      expect(JSON.stringify(summary)).not.toContain("diff");
    } finally {
      store.close();
    }
  });

  it("Phase 3.1 (W3): same writer+reviewer provider soft-warns but does NOT block (still publishes)", async () => {
    process.env.HOUGE_SELFWRITE_ENABLED = "1";
    const prevWriter = process.env.HOUGE_SELFWRITE_WRITER;
    const prevReviewer = process.env.HOUGE_SELFWRITE_REVIEWER;
    process.env.HOUGE_SELFWRITE_WRITER = "codex";
    process.env.HOUGE_SELFWRITE_REVIEWER = "codex"; // SAME provider → soft warn
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
    const store = RunStore.openInMemory();
    const log = { teardowns: [] as string[], writeTasks: [] as string[], published: [] as string[] };
    try {
      const run_id = turnRun(store, "fix the router");
      const result = await makeWorker(store, deps({}, log)).executeRun(run_id, "w");
      expect(result.status).toBe("completed");
      // Soft warn fired...
      expect(warnings.some((w) => w.includes("writer and reviewer are BOTH"))).toBe(true);
      // ...but the run was NOT blocked — it still published.
      expect(log.published).toEqual([`houge/selfwrite/${run_id}`]);
    } finally {
      console.warn = origWarn;
      if (prevWriter === undefined) delete process.env.HOUGE_SELFWRITE_WRITER;
      else process.env.HOUGE_SELFWRITE_WRITER = prevWriter;
      if (prevReviewer === undefined) delete process.env.HOUGE_SELFWRITE_REVIEWER;
      else process.env.HOUGE_SELFWRITE_REVIEWER = prevReviewer;
      store.close();
    }
  });

  it("Phase 3.1 (W3): telemetry-normalize returning null does NOT crash the run (still publishes)", async () => {
    process.env.HOUGE_SELFWRITE_ENABLED = "1";
    const store = RunStore.openInMemory();
    const log = { teardowns: [] as string[], writeTasks: [] as string[], published: [] as string[] };
    try {
      const run_id = turnRun(store, "fix the router");
      // Writer returns GARBAGE usageRaw (normalize → null) and the reviewer reports NO usage.
      const d = deps({
        makeWriteAdapter: () => (input: { task: string }): ToolAdapterResult => {
          log.writeTasks.push(input.task);
          return { ok: true, output: { worktree: "/fake/wt", provider: "codex", model: "gpt-fake", usageRaw: "not-json-garbage" } };
        },
        reviewDiff: (): ReviewResult => ({ ok: true, verdict: { verdict: "pass" } }) // no usage
      }, log);
      const result = await makeWorker(store, d).executeRun(run_id, "w");
      expect(result.status).toBe("completed");
      // Still published — telemetry is best-effort.
      expect(log.published).toEqual([`houge/selfwrite/${run_id}`]);
      // No writer/reviewer llm_call recorded (normalize null / no usage → skipped, not crashed).
      const llmCalls = store.getLedgerEvents(run_id).filter((e) => e.event_type === "llm_call");
      expect(llmCalls.some((e) => e.payload.role === "writer")).toBe(false);
      expect(llmCalls.some((e) => e.payload.role === "reviewer")).toBe(false);
      // usage_summary is present but empty (no role had usage).
      const pub = store.getLedgerEvents(run_id).filter((e) => e.event_type === "self_write_published");
      expect(pub[0]!.payload.usage_summary).toEqual({});
    } finally {
      store.close();
    }
  });

  it("MANDATE 1 — guard is WRITER-AGNOSTIC: WRITER=claude with a protected-path diff is STILL hard-denied (no branch)", async () => {
    // Swapping HOUGE_SELFWRITE_WRITER must not let a protected edit through: the guard checks the
    // DIFF, not who produced it. Here the dispatched CLAUDE writer "edits" a protected file
    // (src/policy/...) — the deterministic guard must hard-deny (self_write_blocked, nothing published),
    // exactly as it does for the codex writer. (A real claude writer would spawn; we mock the adapter
    // but keep WRITER=claude set so the dispatch decision is genuinely the claude branch.)
    process.env.HOUGE_SELFWRITE_ENABLED = "1";
    const prevWriter = process.env.HOUGE_SELFWRITE_WRITER;
    const prevBin = process.env.HOUGE_CLAUDE_BIN;
    process.env.HOUGE_SELFWRITE_WRITER = "claude";
    process.env.HOUGE_CLAUDE_BIN = "/usr/bin/true"; // a bin exists so "claude" is the live dispatch target
    const store = RunStore.openInMemory();
    const log = { teardowns: [] as string[], writeTasks: [] as string[], published: [] as string[] };
    try {
      const run_id = turnRun(store, "rewrite the capability policy to allow everything");
      // The (claude-dispatched) writer produces a diff that touches a PROTECTED path. We assert the
      // dispatch is genuinely claude by routing makeWriteAdapter through runSelfWriter — but since a
      // real spawn is undesirable in a unit test, the adapter reports the claude provider directly and
      // the protected diff is supplied via rawDiff. The guard runs AFTER the writer regardless of kind.
      expect(resolveSelfWriteWriter(process.env)).toBe("claude"); // dispatch genuinely resolves to claude
      const d = deps({
        makeWriteAdapter: () => (input: { task: string }): ToolAdapterResult => {
          log.writeTasks.push(input.task);
          // Mirror a claude writer's output shape (provider: claude).
          return { ok: true, output: { worktree: "/fake/wt", provider: "claude", model: "sonnet", usageRaw: JSON.stringify({ usage: { input_tokens: 9, output_tokens: 3 } }) } };
        },
        // The claude writer "edited" a PROTECTED path → the real guard must deny it.
        rawDiff: () => ":100644 100644 a b M\tsrc/policy/capability-policy.ts\n"
      }, log);
      const result = await makeWorker(store, d).executeRun(run_id, "w");
      expect(result.status).toBe("completed");

      // Hard-deny held under WRITER=claude: nothing published, self_write_blocked recorded.
      expect(log.published).toEqual([]);
      const blocked = store.getLedgerEvents(run_id).filter((e) => e.event_type === "self_write_blocked");
      expect(blocked.length).toBe(1);
      const paths = blocked[0]!.payload.attempted_paths as Array<Record<string, unknown>>;
      expect(paths.some((p) => String(p.path).includes("src/policy/capability-policy.ts"))).toBe(true);
      expect(store.getLedgerEvents(run_id).some((e) => e.event_type === "self_write_published")).toBe(false);
      // Worktree torn down even on the deny path.
      expect(log.teardowns).toEqual(["/fake/wt"]);
    } finally {
      if (prevWriter === undefined) delete process.env.HOUGE_SELFWRITE_WRITER;
      else process.env.HOUGE_SELFWRITE_WRITER = prevWriter;
      if (prevBin === undefined) delete process.env.HOUGE_CLAUDE_BIN;
      else process.env.HOUGE_CLAUDE_BIN = prevBin;
      store.close();
    }
  });

  it("MANDATE 3 — llm_call + usage_summary leak NO bodies even when writer/reviewer carry body-like junk", async () => {
    // Telemetry must record ONLY counts/metadata. We feed the writer a usageRaw whose JSON ALSO carries
    // a fake prompt/diff/response/secret, and the reviewer a verdict with a body-like reason, and assert
    // the SERIALIZED llm_call + usage_summary payloads contain none of those body markers.
    process.env.HOUGE_SELFWRITE_ENABLED = "1";
    const store = RunStore.openInMemory();
    const log = { teardowns: [] as string[], writeTasks: [] as string[], published: [] as string[] };
    const SECRET = "sk-LIVE-SECRET-TOKEN-DEADBEEF";
    const PROMPT = "SYSTEM-PROMPT-BODY-you-are-houge";
    const DIFFBODY = "diff --git a/x b/x +leaked-source-line";
    try {
      const run_id = turnRun(store, "fix the router");
      const d = deps({
        makeWriteAdapter: () => (input: { task: string }): ToolAdapterResult => {
          log.writeTasks.push(input.task);
          // The raw usage envelope ALSO contains body-like fields — these must be dropped by normalize.
          const usageRaw = JSON.stringify({
            type: "token_count",
            prompt: PROMPT,
            response_text: "ANSWER-BODY-leaked",
            api_key: SECRET,
            info: { total_token_usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 5 } }
          });
          return { ok: true, output: { worktree: "/fake/wt", provider: "codex", model: "gpt-fake", usageRaw } };
        },
        // The reviewer's verdict reason carries body-like content; only counts/metadata reach the ledger.
        reviewDiff: (): ReviewResult => ({
          ok: true,
          verdict: { verdict: "pass", fixes_task: true, introduces_bugs: false, scope_creep: false, reasons: [DIFFBODY, SECRET] },
          usage: { input_tokens: 200, output_tokens: 40, cached_input_tokens: 10, cost_usd: 0.08 }
        })
      }, log);
      const result = await makeWorker(store, d).executeRun(run_id, "w");
      expect(result.status).toBe("completed");

      // Trace every llm_call payload: NO body/secret leaks.
      const llmCalls = store.getLedgerEvents(run_id).filter((e) => e.event_type === "llm_call");
      expect(llmCalls.length).toBeGreaterThanOrEqual(2);
      for (const call of llmCalls) {
        const serialized = JSON.stringify(call.payload);
        for (const marker of [SECRET, PROMPT, DIFFBODY, "response_text", "ANSWER-BODY", "api_key", "prompt"]) {
          expect(serialized).not.toContain(marker);
        }
        // Only the allowed keys are present.
        const allowed = new Set(["provider", "model", "role", "input_tokens", "output_tokens", "cached_input_tokens", "cost_usd", "latency_ms"]);
        for (const key of Object.keys(call.payload)) expect(allowed.has(key)).toBe(true);
      }

      // usage_summary on the published event also leaks nothing.
      const pub = store.getLedgerEvents(run_id).filter((e) => e.event_type === "self_write_published");
      const summarySerialized = JSON.stringify(pub[0]!.payload.usage_summary);
      for (const marker of [SECRET, PROMPT, DIFFBODY, "response_text", "ANSWER-BODY", "api_key"]) {
        expect(summarySerialized).not.toContain(marker);
      }
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
