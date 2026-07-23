import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildEvolutionKickoffDigest, buildEvolutionTimeoutText, CoreWorker, EVOLUTION_NOTICE_HEADER } from "../../src/core/core-worker.js";
import type { SelfWriteDeps } from "../../src/core/core-worker.js";
import {
  EVOLUTION_LANE_BUSY_DIGEST,
  evolutionLaneSettled,
  evolutionLaneSnapshot,
  resetEvolutionLaneForTests,
  tryStartEvolutionPipeline
} from "../../src/core/evolution-lane.js";
import { INTENT_DISCIPLINE } from "../../src/capabilities/intent.js";
import { LOOP_DISCIPLINE } from "../../src/prompt/composer.js";
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

// Step ⓪·2 (ADR 0013): the self-write pipeline is invoked ONLY as the `self_write_propose`
// loop tool — this suite drives the loop path (flag ON) with a scripted compose.
// ⓪·3g "THE LANE FIX": the tool now KICKS OFF the pipeline on the background evolution
// lane and returns immediately (the step digest is the kickoff text); the pipeline's
// outcome — publish text + merge buttons, or the code-owned failure text — arrives as its
// own completion notification when the lane settles. The pipeline INSIDE the lane
// (writer → guard → test gate → reviewer → publish) is unchanged; every orchestration
// assertion from the legacy suite still holds, awaited via `evolutionLaneSettled()`.
// HERMETICITY: pin the env this suite asserts on (delete = code default), restore after.
const PINNED_ENV = [
  "HOUGE_SELFWRITE_ENABLED",
  "HOUGE_CODEX_ENABLED",
  "HOUGE_MAX_CONSECUTIVE_CLARIFY",
  "HOUGE_ASK_SYSTEM_PROMPT",
  "HOUGE_SELFWRITE_REVIEWER",
  "HOUGE_HTTPFETCH_ENABLED",
  "HOUGE_TIME_TOOL_ENABLED",
  "HOUGE_TIMEZONE",
  "HOUGE_HTTPFETCH_TIMEOUT_MS",
  "HOUGE_HTTPFETCH_MAX_BYTES",
  "HOUGE_HTTPFETCH_DENY",
  // Secrets firewall (ADR 0015): pin the flag + the five secret names for hermeticity.
  "HOUGE_SECRETS_FIREWALL_ENABLED",
  "KIMI_API_KEY",
  "GEMINI_API_KEY",
  "TAVILY_API_KEY",
  "FIRECRAWL_API_KEY",
  "HOUGE_TELEGRAM_BOT_TOKEN",
  // Dual-LLM (ADR 0014): pin the flag + reader-chain env so the OFF default is hermetic.
  "HOUGE_DUAL_LLM_ENABLED",
  "HOUGE_LLM_READER_PROVIDERS",
  // Scheduler (B10b): the flag shapes the manifest; the cap shapes the adapter refusal.
  "HOUGE_SCHEDULER_ENABLED",
  "HOUGE_SCHEDULER_MAX_PER_CHAT"
] as const;
let savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  savedEnv = {};
  for (const key of PINNED_ENV) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  resetEvolutionLaneForTests();
});
afterEach(async () => {
  await evolutionLaneSettled();
  resetEvolutionLaneForTests();
  for (const key of PINNED_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** Enqueue a selfcode-shaped `turn`. */
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

/** The model proposes the self-write tool, then wraps up (the hinted terminal shape). */
const PROPOSE = '{"action":"self_write_propose","input":{"focus":"intent router"},"why":"user asked for a code fix"}';
const FINAL = '{"action":"final","answer":"已提交修复分支。"}';
/** The kickoff digest the ⓪·3g adapter returns immediately after launching the lane. */
const KICKOFF = buildEvolutionKickoffDigest("self_write_propose");

/**
 * An LLM stub for the loop path: the classifier (INTENT_DISCIPLINE) returns `verdict`;
 * each compose call (LOOP_DISCIPLINE) shifts the next scripted action; anything else
 * echoes the question.
 */
function loopLlm(
  verdict = '{"intent":"selfcode","query":"intent router"}',
  composeScript: string[] = [PROPOSE, FINAL],
  calls: Array<Record<string, unknown>> = []
): (input: Record<string, unknown>) => Promise<ToolAdapterResult> {
  let i = 0;
  return async (input) => {
    calls.push(input);
    const system = typeof input.system === "string" ? input.system : "";
    let answer = `ANSWER: ${input.question}`;
    if (system.includes(INTENT_DISCIPLINE)) answer = verdict;
    else if (system.includes(LOOP_DISCIPLINE)) {
      answer = composeScript[Math.min(i, composeScript.length - 1)] ?? "";
      i += 1;
    }
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

function makeWorker(
  store: RunStore,
  d: SelfWriteDeps,
  llm = loopLlm(),
  codex?: (input: Record<string, unknown>) => ToolAdapterResult
): CoreWorker {
  return new CoreWorker(store, projectRoot(), llm, undefined, codex, d);
}

/** The recorded `loop_step` digests (what the model — and the ledger — saw per step). */
function stepDigests(store: RunStore, run_id: string): Array<{ action: string; ok: boolean; digest: string }> {
  return store
    .getLedgerEvents(run_id)
    .filter((e) => e.event_type === "loop_step")
    .map((e) => ({
      action: String(e.payload.action),
      ok: e.payload.ok === true,
      digest: String(e.payload.result_digest)
    }));
}

interface ClaimedNotification {
  intent_type: string;
  payload: Record<string, unknown>;
}

/**
 * Drain every queued notification. ⓪·3g note: the turn's final report and the lane's
 * completion notification are enqueued concurrently (the pipeline is a background
 * promise), so tests select by SHAPE — the completion notification is the one whose
 * text is the pipeline's code-owned outcome — instead of assuming a queue order.
 */
function drainNotifications(store: RunStore): ClaimedNotification[] {
  const out: ClaimedNotification[] = [];
  for (;;) {
    // A UNIQUE lease owner per claim: claimNextNotification selects the claimed row
    // back by (lease_owner, state) — two same-owner claims in the same ms would
    // otherwise read back the same record twice.
    const n = store.claimNextNotification(`test-claim-${out.length}`, 60);
    if (!n) break;
    out.push({ intent_type: n.intent_type, payload: n.payload as Record<string, unknown> });
  }
  return out;
}

/** Run the turn to completion AND settle the background lane, then drain notifications. */
async function executeAndSettle(
  worker: CoreWorker,
  store: RunStore,
  run_id: string
): Promise<{ status: string; notifications: ClaimedNotification[] }> {
  const result = await worker.executeRun(run_id, "w");
  await evolutionLaneSettled();
  return { status: result.status, notifications: drainNotifications(store) };
}

describe("self_write_propose (Phase 3 orchestration on the ⓪·3g background lane)", () => {
  it("happy path: all three checkers green → publishes the branch, records self_write_published, tears down the worktree", async () => {
    process.env.HOUGE_SELFWRITE_ENABLED = "1";
    const store = RunStore.openInMemory();
    const log = { teardowns: [] as string[], writeTasks: [] as string[], published: [] as string[] };
    try {
      const run_id = turnRun(store, "fix the intent router so it sees your identity");
      const { status, notifications } = await executeAndSettle(makeWorker(store, deps({}, log)), store, run_id);
      expect(status).toBe("completed");

      // The branch was published exactly once with the run-id name.
      expect(log.published).toEqual([`houge/selfwrite/${run_id}`]);
      // The write task framed it as EDITING Houge's own source (DATA channel), anchored
      // to the REAL user message — the model's focus was advisory only.
      expect(log.writeTasks[0]).toContain("EDITING");
      expect(log.writeTasks[0]).toContain("fix the intent router");
      // The worktree was torn down in the finally.
      expect(log.teardowns).toEqual(["/fake/wt"]);

      // The published event carries branch + verdict + gate results.
      const events = store.getLedgerEvents(run_id).filter((e) => e.event_type === "self_write_published");
      expect(events.length).toBe(1);
      expect(events[0]!.payload.branch).toBe(`houge/selfwrite/${run_id}`);
      expect((events[0]!.payload.gate_results as Record<string, unknown>).reviewer).toBe("pass");

      // ⓪·3g: the tool's step digest is the KICKOFF text (immediate return) — the model
      // can tell the user work started; the outcome rides the completion notification.
      const steps = stepDigests(store, run_id);
      expect(steps[0]!).toMatchObject({ action: "self_write_propose", ok: true });
      expect(steps[0]!.digest).toBe(KICKOFF);

      // BUDGET ISOLATION: the TURN ledger was charged exactly ONE reservation for the
      // evolution step (classifier 1 + propose 1 = 2) — the pipeline's internal writer/
      // reviewer calls ran on their own sub-contract ledger, never the turn's.
      const completed = store.getLedgerEvents(run_id).filter((e) => e.event_type === "run_completed");
      expect(completed[0]!.payload.budget_used).toEqual({ tool_calls: 2 });

      // The turn recorded the loop's reply under the selfcode hint intent. ⓪·3g
      // kickoff-terminal: the kickoff ENDS the turn, so the reply IS the kickoff digest
      // (the scripted "final" is never reached). B10a: the lane's completion report is
      // recorded as a SECOND assistant turn at its true time — without it the thread
      // context ends at the kickoff and a follow-up about the report cannot resolve.
      const turns = store.getRecentChatTurns("777", 6);
      const kickoffTurn = turns[turns.length - 2]!;
      expect(kickoffTurn.intent).toBe("selfcode");
      expect(kickoffTurn.text).toBe(KICKOFF);
      const reportTurn = turns[turns.length - 1]!;
      expect(reportTurn.intent).toBe("evolution_report");
      expect(reportTurn.text).toContain("🐒 Fixed");

      // TWO notifications: the turn's reply (the kickoff digest, NO buttons) and the lane's
      // completion (publish text + the three merge-control buttons targeting THIS run).
      expect(notifications.length).toBe(2);
      const turnNote = notifications.find((n) => n.payload.text === KICKOFF);
      expect(turnNote).toBeDefined();
      expect(turnNote!.payload.buttons).toBeUndefined();
      const completion = notifications.find((n) => String(n.payload.text).includes("🐒 Fixed"));
      expect(completion).toBeDefined();
      expect(completion!.intent_type).toBe("final_report");
      expect(String(completion!.payload.text)).toContain(`houge/selfwrite/${run_id}`);
      expect(completion!.payload.buttons).toEqual([
        { text: "🔀 Merge & reload", data: `selfwrite:merge:${run_id}` },
        { text: "👀 View diff", data: `selfwrite:view:${run_id}` },
        { text: "🗑 Discard", data: `selfwrite:discard:${run_id}` }
      ]);
      // The lane is idle again.
      expect(evolutionLaneSnapshot().busy).toBe(false);
    } finally {
      store.close();
    }
  });

  it("⓪·3g kickoff immediate-return: executeRun completes WHILE the pipeline is still writing (event-loop interleaving)", async () => {
    process.env.HOUGE_SELFWRITE_ENABLED = "1";
    const store = RunStore.openInMemory();
    const log = { teardowns: [] as string[], writeTasks: [] as string[], published: [] as string[] };
    // A writer that BLOCKS until the test releases it — stands in for the real 10–19 min spawn.
    let releaseWriter!: () => void;
    const writerGate = new Promise<void>((resolve) => { releaseWriter = resolve; });
    try {
      const run_id = turnRun(store, "fix the router");
      const d = deps({
        makeWriteAdapter: () => async (input: { task: string }): Promise<ToolAdapterResult> => {
          log.writeTasks.push(input.task);
          await writerGate; // in flight until released
          return { ok: true, output: { worktree: "/fake/wt", provider: "codex", model: "gpt-fake", usageRaw: "" } };
        }
      }, log);
      const result = await makeWorker(store, d).executeRun(run_id, "w");

      // The TURN completed and its reply was enqueued while the writer is STILL in flight
      // — the old sync path would have blocked here for the writer's whole duration.
      expect(result.status).toBe("completed");
      expect(log.published).toEqual([]);
      expect(evolutionLaneSnapshot().busy).toBe(true);
      expect(evolutionLaneSnapshot().current?.tool).toBe("self_write_propose");
      const turnNote = store.claimNextNotification("test-claim-turn", 60);
      expect(turnNote).not.toBeNull();
      expect(turnNote!.payload.text).toBe(KICKOFF);

      // Release the writer → the lane settles → the completion notification lands.
      releaseWriter();
      await evolutionLaneSettled();
      expect(evolutionLaneSnapshot().busy).toBe(false);
      expect(log.published).toEqual([`houge/selfwrite/${run_id}`]);
      const completion = store.claimNextNotification("test-claim-completion", 60);
      expect(completion).not.toBeNull();
      expect(String(completion!.payload.text)).toContain("🐒 Fixed");
      expect(completion!.payload.buttons).toBeDefined();
    } finally {
      releaseWriter();
      await evolutionLaneSettled();
      store.close();
    }
  });

  it("⓪·3g lane busy: a second evolution ask while a pipeline runs is refused with the busy digest, nothing launched", async () => {
    process.env.HOUGE_SELFWRITE_ENABLED = "1";
    const store = RunStore.openInMemory();
    const log = { teardowns: [] as string[], writeTasks: [] as string[], published: [] as string[] };
    // Occupy the lane with a fake in-flight pipeline (as if another turn kicked one off).
    let releaseLane!: () => void;
    const started = tryStartEvolutionPipeline({
      current: { run_id: "run_other", tool: "self_write_propose", started_at: new Date().toISOString() },
      capMs: 60_000,
      run: () => new Promise((resolve) => { releaseLane = () => resolve({ text: "done" }); }),
      onTimeout: () => ({ text: "timeout" }),
      onError: (d) => ({ text: d }),
      deliver: () => {}
    });
    expect(started).toBe(true);
    try {
      const run_id = turnRun(store, "fix the router");
      const result = await makeWorker(store, deps({}, log)).executeRun(run_id, "w");
      expect(result.status).toBe("completed");

      // Refused WITHOUT executing: no writer call, no worktree, no self_write_* events.
      expect(log.writeTasks).toEqual([]);
      expect(log.teardowns).toEqual([]);
      expect(store.getLedgerEvents(run_id).some((e) => String(e.event_type).startsWith("self_write_"))).toBe(false);
      const steps = stepDigests(store, run_id);
      expect(steps[0]!).toMatchObject({ action: "self_write_propose", ok: false });
      expect(steps[0]!.digest).toContain(EVOLUTION_LANE_BUSY_DIGEST);
      // The busy refusal rides the TURN code-owned (a kickoff-refusal notice).
      const turnNote = store.claimNextNotification("test-claim", 60);
      expect(String(turnNote!.payload.text)).toContain(EVOLUTION_NOTICE_HEADER);
      expect(String(turnNote!.payload.text)).toContain(EVOLUTION_LANE_BUSY_DIGEST);
    } finally {
      releaseLane();
      await evolutionLaneSettled();
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
      const { status, notifications } = await executeAndSettle(makeWorker(store, d), store, run_id);
      expect(status).toBe("completed");
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
      // The step digest is the kickoff; the hard-deny text rides the COMPLETION
      // notification code-owned (⓪·3g: the guarantee moved off the turn reply).
      const steps = stepDigests(store, run_id);
      expect(steps[0]!.digest).toBe(KICKOFF);
      const completion = notifications.find((n) => String(n.payload.text).includes("package.json"));
      expect(completion).toBeDefined();
      expect(String(completion!.payload.text).toLowerCase()).toContain("locked surface");
      // A BLOCKED completion carries NO merge-control buttons (only a publish does).
      expect(completion!.payload.buttons).toBeUndefined();
      // The turn reply (the kickoff digest) says nothing about the deny — the code-owned
      // completion notification surfaces it regardless.
      expect(notifications.some((n) => n.payload.text === KICKOFF)).toBe(true);
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
      const { status, notifications } = await executeAndSettle(makeWorker(store, d), store, run_id);
      expect(status).toBe("completed");

      // Refine capped at 3 TOTAL write attempts.
      expect(log.writeTasks.length).toBe(3);
      expect(log.published).toEqual([]);
      const failed = store.getLedgerEvents(run_id).filter((e) => e.event_type === "self_write_failed");
      expect(failed.length).toBe(1);
      expect(String(failed[0]!.payload.reason)).toContain("tests red");
      expect(log.teardowns).toEqual(["/fake/wt"]);
      // The CODE-OWNED failure text reaches the user on the completion notification.
      const completion = notifications.find((n) => String(n.payload.text).toLowerCase().includes("tests red"));
      expect(completion).toBeDefined();
      expect(completion!.payload.buttons).toBeUndefined();
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
      const { status, notifications } = await executeAndSettle(makeWorker(store, d), store, run_id);
      expect(status).toBe("completed");

      expect(log.writeTasks.length).toBe(3);
      expect(log.published).toEqual([]);
      const failed = store.getLedgerEvents(run_id).filter((e) => e.event_type === "self_write_failed");
      expect(failed.length).toBe(1);
      expect(String(failed[0]!.payload.reason)).toContain("reviewer rejected");
      const completion = notifications.find((n) => String(n.payload.text).includes("does not actually fix it"));
      expect(completion).toBeDefined();
    } finally {
      store.close();
    }
  });

  it("H1 attribution: gate_results carries the backend that actually verdicted (fallback chain)", async () => {
    process.env.HOUGE_SELFWRITE_ENABLED = "1";
    const store = RunStore.openInMemory();
    const log = { teardowns: [] as string[], writeTasks: [] as string[], published: [] as string[] };
    try {
      const run_id = turnRun(store, "fix the router");
      // The (kimi-configured) reviewer timed out and the chain fell to codex — the result says so.
      const d = deps({
        reviewDiff: (): ReviewResult => ({ ok: true, verdict: { verdict: "pass", fixes_task: true }, reviewer: "codex" })
      }, log);
      const { status } = await executeAndSettle(makeWorker(store, d), store, run_id);
      expect(status).toBe("completed");
      const pub = store.getLedgerEvents(run_id).filter((e) => e.event_type === "self_write_published");
      expect(pub.length).toBe(1);
      const gates = pub[0]!.payload.gate_results as Record<string, unknown>;
      expect(gates.reviewer).toBe("pass");
      expect(gates.reviewer_backend).toBe("codex");
    } finally {
      store.close();
    }
  });

  it("H1 attribution: no backend on the result → the configured reviewer is stamped (default kimi)", async () => {
    process.env.HOUGE_SELFWRITE_ENABLED = "1"; // HOUGE_SELFWRITE_REVIEWER pinned-deleted → default kimi
    const store = RunStore.openInMemory();
    const log = { teardowns: [] as string[], writeTasks: [] as string[], published: [] as string[] };
    try {
      const run_id = turnRun(store, "fix the router");
      const { status } = await executeAndSettle(makeWorker(store, deps({}, log)), store, run_id);
      expect(status).toBe("completed");
      const pub = store.getLedgerEvents(run_id).filter((e) => e.event_type === "self_write_published");
      expect((pub[0]!.payload.gate_results as Record<string, unknown>).reviewer_backend).toBe("kimi");
    } finally {
      store.close();
    }
  });

  it("H1 attribution: a terminal reviewer REJECT names the verdicting backend in self_write_failed", async () => {
    process.env.HOUGE_SELFWRITE_ENABLED = "1";
    const store = RunStore.openInMemory();
    const log = { teardowns: [] as string[], writeTasks: [] as string[], published: [] as string[] };
    try {
      const run_id = turnRun(store, "fix the router");
      const d = deps({
        reviewDiff: (): ReviewResult => ({ ok: true, verdict: { verdict: "reject", reasons: ["no-op"] }, reviewer: "codex" })
      }, log);
      const { status } = await executeAndSettle(makeWorker(store, d), store, run_id);
      expect(status).toBe("completed");
      expect(log.published).toEqual([]); // reject stays terminal — fallback never applies to a delivered verdict
      const failed = store.getLedgerEvents(run_id).filter((e) => e.event_type === "self_write_failed");
      expect(String(failed[0]!.payload.reason)).toContain("reviewer rejected (codex)");
    } finally {
      store.close();
    }
  });

  it("worktree teardown ALWAYS runs even when a mid-stage throws (finally invariant; the lane wrapper absorbs the throw)", async () => {
    process.env.HOUGE_SELFWRITE_ENABLED = "1";
    const store = RunStore.openInMemory();
    const log = { teardowns: [] as string[], writeTasks: [] as string[], published: [] as string[] };
    try {
      const run_id = turnRun(store, "fix the router");
      // The test gate throws unexpectedly (not a clean red result) AFTER the worktree exists.
      const d = deps({ runTestGate: () => { throw new Error("gate exploded"); } }, log);
      // ⓪·3g: the throw happens on the background lane — the lane wrapper maps it to the
      // code-owned failure completion; the worktree is STILL torn down by runSelfWrite's finally.
      const { status, notifications } = await executeAndSettle(makeWorker(store, d), store, run_id);
      expect(status).toBe("completed");
      expect(log.teardowns).toEqual(["/fake/wt"]); // no worktree leak on throw
      expect(log.published).toEqual([]); // nothing published on a throw
      // The kickoff itself succeeded (the throw came later, in the background).
      const steps = stepDigests(store, run_id);
      expect(steps[0]!).toMatchObject({ action: "self_write_propose", ok: true });
      // CODE-OWNED surfacing: the absorbed throw still reaches the user verbatim.
      const completion = notifications.find((n) => String(n.payload.text).includes("gate exploded"));
      expect(completion).toBeDefined();
      expect(String(completion!.payload.text)).toContain("self_write_propose step failed");
      // The lane came free despite the throw.
      expect(evolutionLaneSnapshot().busy).toBe(false);
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
      const { status } = await executeAndSettle(makeWorker(store, d), store, run_id);
      expect(status).toBe("completed");
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
      const { status, notifications } = await executeAndSettle(makeWorker(store, d), store, run_id);
      expect(status).toBe("completed");
      expect(log.writeTasks).toEqual([]); // never reached the writer
      expect(log.published).toEqual([]);
      const failed = store.getLedgerEvents(run_id).filter((e) => e.event_type === "self_write_failed");
      expect(failed.length).toBe(1);
      expect(String(failed[0]!.payload.reason)).toContain("worktree setup failed");
      // ⓪·3g lane-release-on-failure: the lane is free again after the failure.
      expect(evolutionLaneSnapshot().busy).toBe(false);
      expect(notifications.some((n) => String(n.payload.text).includes("isolated workspace"))).toBe(true);
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
      const { status } = await executeAndSettle(makeWorker(store, d), store, run_id);
      expect(status).toBe("completed");
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
      const { status } = await executeAndSettle(makeWorker(store, d), store, run_id);
      expect(status).toBe("completed");
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
      const { status } = await executeAndSettle(makeWorker(store, d), store, run_id);
      expect(status).toBe("completed");
      expect(log.writeTasks.length).toBe(1); // terminal — no refine
      expect(log.published).toEqual([]);
      expect(store.getLedgerEvents(run_id).some((e) => e.event_type === "self_write_blocked")).toBe(true);
    } finally {
      store.close();
    }
  });

  it("Phase 3.1 (W3): a successful run records a `writer` llm_call AND a `reviewer` llm_call", async () => {
    process.env.HOUGE_SELFWRITE_ENABLED = "1";
    const store = RunStore.openInMemory();
    const log = { teardowns: [] as string[], writeTasks: [] as string[], published: [] as string[] };
    try {
      const run_id = turnRun(store, "fix the router");
      const { status } = await executeAndSettle(makeWorker(store, deps({}, log)), store, run_id);
      expect(status).toBe("completed");

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
      // Reviewer telemetry came from review.usage: 200 in + 40 out.
      expect(reviewer!.payload.input_tokens).toBe(200);
      // The default reviewer (kimi/codex) is a subscription CLI leg, NOT metered — its self-reported
      // cost_usd (0.08) is a phantom list price and must NOT reach the ledger as a real-$ figure.
      expect(reviewer!.payload.cost_usd).toBeUndefined();
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
      await executeAndSettle(makeWorker(store, deps({}, log)), store, run_id);
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
      const { status } = await executeAndSettle(makeWorker(store, deps({}, log)), store, run_id);
      expect(status).toBe("completed");
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
      const { status } = await executeAndSettle(makeWorker(store, d), store, run_id);
      expect(status).toBe("completed");
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

  it("MANDATE 1 — guard is WRITER-AGNOSTIC: a protected-path diff is hard-denied regardless of the reported provider", async () => {
    // The guard checks the DIFF, not who produced it. The adapter reports an arbitrary provider
    // string, and the diff touches a protected file (src/policy/...) — the deterministic guard must
    // hard-deny (self_write_blocked, nothing published), exactly as it does for the codex writer.
    process.env.HOUGE_SELFWRITE_ENABLED = "1";
    const store = RunStore.openInMemory();
    const log = { teardowns: [] as string[], writeTasks: [] as string[], published: [] as string[] };
    try {
      const run_id = turnRun(store, "rewrite the capability policy to allow everything");
      const d = deps({
        makeWriteAdapter: () => (input: { task: string }): ToolAdapterResult => {
          log.writeTasks.push(input.task);
          // An arbitrary/unknown provider string — the guard must not care who wrote the diff.
          return { ok: true, output: { worktree: "/fake/wt", provider: "someone-else", model: "whatever", usageRaw: JSON.stringify({ usage: { input_tokens: 9, output_tokens: 3 } }) } };
        },
        // The writer "edited" a PROTECTED path → the real guard must deny it.
        rawDiff: () => ":100644 100644 a b M\tsrc/policy/capability-policy.ts\n"
      }, log);
      const { status } = await executeAndSettle(makeWorker(store, d), store, run_id);
      expect(status).toBe("completed");

      // Hard-deny held: nothing published, self_write_blocked recorded.
      expect(log.published).toEqual([]);
      const blocked = store.getLedgerEvents(run_id).filter((e) => e.event_type === "self_write_blocked");
      expect(blocked.length).toBe(1);
      const paths = blocked[0]!.payload.attempted_paths as Array<Record<string, unknown>>;
      expect(paths.some((p) => String(p.path).includes("src/policy/capability-policy.ts"))).toBe(true);
      expect(store.getLedgerEvents(run_id).some((e) => e.event_type === "self_write_published")).toBe(false);
      // Worktree torn down even on the deny path.
      expect(log.teardowns).toEqual(["/fake/wt"]);
    } finally {
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
      const { status } = await executeAndSettle(makeWorker(store, d), store, run_id);
      expect(status).toBe("completed");

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

  it("② kickoff-terminal subsumes once-per-turn: a second self_write_propose is never reached (turn already ended)", async () => {
    process.env.HOUGE_SELFWRITE_ENABLED = "1";
    const store = RunStore.openInMemory();
    const log = { teardowns: [] as string[], writeTasks: [] as string[], published: [] as string[] };
    try {
      const run_id = turnRun(store, "fix the router");
      // The model scripts TWO proposes (with different inputs), but the FIRST successful
      // kickoff finalizes the turn — the second action is never dispatched, so the pipeline
      // runs exactly once. (The adapter's per-tool once-guard remains as defense in depth.)
      const worker = makeWorker(
        store,
        deps({}, log),
        loopLlm(undefined, [
          PROPOSE,
          '{"action":"self_write_propose","input":{"focus":"another angle"}}',
          FINAL
        ])
      );
      const { status } = await executeAndSettle(worker, store, run_id);
      expect(status).toBe("completed");

      // The pipeline ran ONCE; one branch, one worktree, one publish.
      expect(log.writeTasks.length).toBe(1);
      expect(log.published).toEqual([`houge/selfwrite/${run_id}`]);
      const steps = stepDigests(store, run_id);
      expect(steps.length).toBe(1);
      expect(steps[0]!).toMatchObject({ action: "self_write_propose", ok: true });
    } finally {
      store.close();
    }
  });

  it("BUDGET ISOLATION (live-gate regression): a drained turn ledger cannot starve the writer/reviewer internals", async () => {
    // run_8c1091be shape: earlier loop steps consume most of the turn budget (6), then
    // self_write_propose fires. Its internals (2 writer passes here: red → green, plus
    // the reviewer) MUST run on their own code-self-write sub-ledger — on the shared
    // turn ledger the first writer call would die with "Tool-call budget exhausted".
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
      const worker = makeWorker(
        store,
        d,
        loopLlm(undefined, [
          // Four filler steps: classifier(1) + these(4) = 5 of 6 turn reservations spent.
          '{"action":"llm_answer","input":{"question":"q1"}}',
          '{"action":"llm_answer","input":{"question":"q2"}}',
          '{"action":"llm_answer","input":{"question":"q3"}}',
          '{"action":"llm_answer","input":{"question":"q4"}}',
          PROPOSE, // the 6th and LAST turn reservation
          FINAL
        ])
      );
      const { status } = await executeAndSettle(worker, store, run_id);
      expect(status).toBe("completed");

      // The internals ran to publish on the sub-ledger: two writer passes + reviewer.
      expect(log.writeTasks.length).toBe(2);
      expect(log.published).toEqual([`houge/selfwrite/${run_id}`]);
      expect(store.getLedgerEvents(run_id).some((e) => e.event_type === "self_write_published")).toBe(true);
      const steps = stepDigests(store, run_id);
      expect(steps[4]!).toMatchObject({ action: "self_write_propose", ok: true });
      expect(steps[4]!.digest).toBe(KICKOFF);
      // budget_used reports the TURN ledger's count (6 = 1 classify + 4 fillers + 1
      // evolution step) — the sub-ledger's internal calls never touched it.
      const completed = store.getLedgerEvents(run_id).filter((e) => e.event_type === "run_completed");
      expect(completed[0]!.payload.budget_used).toEqual({ tool_calls: 6 });
    } finally {
      store.close();
    }
  });

  it("② kickoff-terminal: the FIRST evolution kickoff ENDS the turn — a second evolution action never runs", async () => {
    // ② the lane fix's terminal seam: a successful evolution kickoff finalizes the turn
    // (the work is now async on the lane; a further synchronous step would only bounce off
    // the busy guard or waste budget). So even though the model scripts self_diagnose THEN
    // self_write_propose, only the diagnose kicks off; the propose is never dispatched.
    process.env.HOUGE_SELFWRITE_ENABLED = "1";
    process.env.HOUGE_CODEX_ENABLED = "1";
    const store = RunStore.openInMemory();
    const log = { teardowns: [] as string[], writeTasks: [] as string[], published: [] as string[] };
    const script = [
      '{"action":"self_diagnose","input":{"focus":"router"}}',
      PROPOSE,
      FINAL
    ];
    let i = 0;
    const llm = async (input: Record<string, unknown>): Promise<ToolAdapterResult> => {
      const system = typeof input.system === "string" ? input.system : "";
      let answer = `ANSWER: ${input.question}`;
      if (system.includes(INTENT_DISCIPLINE)) answer = '{"intent":"selfcode"}';
      else if (system.includes(LOOP_DISCIPLINE)) {
        answer = script[Math.min(i, script.length - 1)] ?? "";
        i += 1;
      }
      return { ok: true, output: { question: input.question, answer, model: "fake", provider: "fake" } };
    };
    const codex = (input: Record<string, unknown>): ToolAdapterResult => ({
      ok: true,
      output: { diagnosis: "ROOT CAUSE: the router", model: "fake", bin: "codex", question: input.question }
    });
    try {
      const run_id = turnRun(store, "看看你的 router 然后修掉它");
      const { status, notifications } = await executeAndSettle(makeWorker(store, deps({}, log), llm, codex), store, run_id);
      expect(status).toBe("completed");

      // ONLY the diagnose ran: it delivered its outcome; the propose kickoff never fired,
      // so nothing was published and no writer was ever called.
      expect(log.published).toEqual([]);
      expect(log.writeTasks).toEqual([]);
      const diagnoseNote = notifications.find((n) => String(n.payload.text).includes("ROOT CAUSE"));
      const publishNote = notifications.find((n) => String(n.payload.text).includes("🐒 Fixed"));
      const turnNote = notifications.find((n) => n.payload.text === buildEvolutionKickoffDigest("self_diagnose"));
      expect(diagnoseNote).toBeDefined();
      expect(publishNote).toBeUndefined();
      expect(turnNote).toBeDefined();
      // Two notifications: the turn's kickoff reply and the diagnose completion.
      expect(notifications.length).toBe(2);
      // Exactly ONE loop step — the terminal diagnose kickoff.
      const steps = stepDigests(store, run_id);
      expect(steps.length).toBe(1);
      expect(steps[0]!).toMatchObject({ action: "self_diagnose", ok: true });
    } finally {
      store.close();
    }
  });

  it("F3: the lane-timeout text is honest — no 'nothing was published' promise; names the possible late branch", () => {
    const text = buildEvolutionTimeoutText("self_write_propose", 60);
    expect(text).toContain("self_write_propose");
    expect(text).toContain("timed out after 60 minutes");
    expect(text).toContain("目前没有发布任何分支");
    expect(text).toContain("迟到的分支");
    expect(text).not.toContain("nothing was published");
  });

  it("ARMING (M3): HOUGE_SELFWRITE_ENABLED off → unlisted in the manifest prompt AND denied when invoked anyway", async () => {
    delete process.env.HOUGE_SELFWRITE_ENABLED; // default OFF
    const store = RunStore.openInMemory();
    const log = { teardowns: [] as string[], writeTasks: [] as string[], published: [] as string[] };
    const calls: Array<Record<string, unknown>> = [];
    try {
      const run_id = turnRun(store, "fix the intent router so it sees your identity");
      const worker = makeWorker(store, deps({}, log), loopLlm(undefined, [PROPOSE, FINAL], calls));
      const result = await worker.executeRun(run_id, "w");
      expect(result.status).toBe("completed");

      // Unlisted: the rendered manifest prompt never described the tool.
      const compose = calls.find((c) => String(c.system).includes(LOOP_DISCIPLINE));
      expect(compose).toBeDefined();
      expect(String(compose!.question)).not.toContain("- self_write_propose:");
      // Unreachable: the scripted invocation was denied (unknown capability), and the
      // write stack was never entered.
      const steps = stepDigests(store, run_id);
      expect(steps[0]!).toMatchObject({ action: "self_write_propose", ok: false });
      expect(log.writeTasks).toEqual([]);
      expect(log.published).toEqual([]);
      expect(log.teardowns).toEqual([]);
      expect(store.getLedgerEvents(run_id).some((e) => String(e.event_type).startsWith("self_write_"))).toBe(false);
      // CODE-OWNED surfacing: the denial reaches the user even though the model's final
      // answer never mentions the tool.
      const notif = store.claimNextNotification("test-claim", 60);
      expect(notif).not.toBeNull();
      expect(String(notif!.payload.text)).toContain(EVOLUTION_NOTICE_HEADER);
      expect(String(notif!.payload.text)).toContain("self_write_propose step failed");
    } finally {
      store.close();
    }
  });

});
