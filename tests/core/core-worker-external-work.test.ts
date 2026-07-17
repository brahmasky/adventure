import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildEvolutionKickoffDigest, CoreWorker } from "../../src/core/core-worker.js";
import {
  EXTWORK_RUNTIME_UNAVAILABLE_NOTICE,
  type ExternalWorkDeps
} from "../../src/capabilities/external-workspace.js";
import { evolutionLaneSettled, resetEvolutionLaneForTests } from "../../src/core/evolution-lane.js";
import { INTENT_DISCIPLINE } from "../../src/capabilities/intent.js";
import { LOOP_DISCIPLINE } from "../../src/prompt/composer.js";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";
import type { ToolAdapterResult } from "../../src/tools/tool-registry.js";

// Money-Work Phase P1 (ADR 0023): external_work is an armed loop tool that KICKS OFF on the
// background evolution lane (like self_write_propose) and returns the kickoff digest; the
// pipeline's outcome arrives as the lane's own completion notification. Every dep is faked —
// NO real docker/git/codex. HERMETICITY: pin the env this suite asserts on.
const PINNED_ENV = [
  "HOUGE_EXTWORK_ENABLED",
  "HOUGE_EXTWORK_IMAGE",
  "HOUGE_SELFWRITE_ENABLED",
  "HOUGE_CODEX_ENABLED",
  "HOUGE_MAX_CONSECUTIVE_CLARIFY",
  "HOUGE_HTTPFETCH_ENABLED",
  "HOUGE_TIME_TOOL_ENABLED",
  "HOUGE_TIMEZONE",
  "HOUGE_SCHEDULER_ENABLED",
  "HOUGE_WIKI_ENABLED",
  "HOUGE_DUAL_LLM_ENABLED"
] as const;
let savedEnv: Record<string, string | undefined> = {};
let dirs: string[] = [];
beforeEach(() => {
  savedEnv = {};
  for (const k of PINNED_ENV) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  resetEvolutionLaneForTests();
});
afterEach(async () => {
  await evolutionLaneSettled();
  resetEvolutionLaneForTests();
  for (const k of PINNED_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function projectRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-extwork-"));
  dirs.push(dir);
  return dir;
}

function turnRun(store: RunStore, message: string, key = `ext:${message}`): string {
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

const REPO = "https://github.com/owner/repo";
const EXT = `{"action":"external_work","input":{"repo_url":"${REPO}","task":"fix the flaky test"},"why":"user gave a repo + task"}`;
const EXT_BAD_URL = `{"action":"external_work","input":{"repo_url":"http://github.com/owner/repo","task":"fix it"},"why":"x"}`;
const FINAL = '{"action":"final","answer":"done."}';
const KICKOFF = buildEvolutionKickoffDigest("external_work");

function loopLlm(composeScript: string[] = [EXT, FINAL]): (input: Record<string, unknown>) => Promise<ToolAdapterResult> {
  let i = 0;
  return async (input) => {
    const system = typeof input.system === "string" ? input.system : "";
    let answer = `ANSWER: ${input.question}`;
    if (system.includes(INTENT_DISCIPLINE)) answer = '{"intent":"ask","query":"external repo work"}';
    else if (system.includes(LOOP_DISCIPLINE)) {
      answer = composeScript[Math.min(i, composeScript.length - 1)] ?? "";
      i += 1;
    }
    return { ok: true, output: { question: input.question, answer, model: "fake", provider: "fake" } };
  };
}

interface Log {
  cloned: string[];
  teardowns: string[];
  writeTasks: string[];
  gates: number;
  artifacts: Array<{ run_id: string; patch: string }>;
}

function extDeps(overrides: Partial<ExternalWorkDeps>, log: Log): ExternalWorkDeps {
  const base: ExternalWorkDeps = {
    detectRuntime: async () => ({ bin: "docker" }),
    resolveImage: () => "img:test",
    cloneRepo: async (url) => {
      log.cloned.push(url);
      return { ok: true, path: "/fake/clone" };
    },
    removeWorkspace: (p) => {
      log.teardowns.push(p);
    },
    makeWriteAdapter: () => (input: { task: string }): ToolAdapterResult => {
      log.writeTasks.push(input.task);
      return { ok: true, output: { worktree: "/fake/clone", provider: "codex", model: "fake", usageRaw: "" } };
    },
    runToolchainGate: async () => {
      log.gates += 1;
      return { ok: true, output: "all green" };
    },
    unifiedDiff: async () => "diff --git a/x b/x\n+fixed",
    writeArtifact: (root, run_id, input) => {
      log.artifacts.push({ run_id, patch: input.patch });
      return { patchPath: `${root}/runs/${run_id}/patch.diff`, reportPath: `${root}/runs/${run_id}/report.md`, reportHash: "h" };
    }
  };
  return { ...base, ...overrides };
}

function makeWorker(store: RunStore, d: ExternalWorkDeps, llm = loopLlm()): CoreWorker {
  return new CoreWorker(store, projectRoot(), llm, undefined, undefined, undefined, undefined, undefined, undefined, undefined, d);
}

interface ClaimedNotification {
  intent_type: string;
  payload: Record<string, unknown>;
}
function drainNotifications(store: RunStore): ClaimedNotification[] {
  const out: ClaimedNotification[] = [];
  for (;;) {
    const n = store.claimNextNotification(`test-claim-${out.length}`, 60);
    if (!n) break;
    out.push({ intent_type: n.intent_type, payload: n.payload as Record<string, unknown> });
  }
  return out;
}

async function executeAndSettle(worker: CoreWorker, store: RunStore, run_id: string) {
  const result = await worker.executeRun(run_id, "w");
  await evolutionLaneSettled();
  return { status: result.status, notifications: drainNotifications(store) };
}

function freshLog(): Log {
  return { cloned: [], teardowns: [], writeTasks: [], gates: 0, artifacts: [] };
}

describe("external_work pipeline (ADR 0023, background lane, all deps faked)", () => {
  it("happy path: clone → codex → container gate green → local patch + [View diff]/[Discard] (NO Merge)", async () => {
    process.env.HOUGE_EXTWORK_ENABLED = "1";
    const store = RunStore.openInMemory();
    const log = freshLog();
    const run_id = turnRun(store, "please fix the flaky test in this repo");
    const { status, notifications } = await executeAndSettle(makeWorker(store, extDeps({}, log)), store, run_id);
    expect(status).toBe("completed");

    // The repo was cloned once; the clone was torn down in the finally.
    expect(log.cloned).toEqual([REPO]);
    expect(log.teardowns).toEqual(["/fake/clone"]);
    // The write task framed the repo as UNTRUSTED EXTERNAL code and carried the task.
    expect(log.writeTasks[0]).toContain("EXTERNAL");
    expect(log.writeTasks[0]).toContain("fix the flaky test");
    // The container gate ran; a local artifact (patch) was written.
    expect(log.gates).toBe(1);
    expect(log.artifacts).toHaveLength(1);
    expect(log.artifacts[0]!.patch).toContain("+fixed");

    // The published ledger event names the LOCAL patch ref (no branch, no push).
    const published = store.getLedgerEvents(run_id).filter((e) => e.event_type === "external_work_published");
    expect(published).toHaveLength(1);
    expect(published[0]!.payload.patch_ref).toBe(`runs/${run_id}/patch.diff`);
    expect(published[0]!.payload.repo_url).toBe(REPO);

    // The turn's own reply is the immediate kickoff digest (no buttons).
    const turnNote = notifications.find((n) => n.payload.text === KICKOFF);
    expect(turnNote).toBeDefined();
    expect(turnNote!.payload.buttons).toBeUndefined();

    // The completion notification carries EXACTLY [View diff] + [Discard] — never Merge.
    const completion = notifications.find((n) => Array.isArray(n.payload.buttons));
    expect(completion).toBeDefined();
    const buttons = completion!.payload.buttons as Array<{ text: string; data: string }>;
    expect(buttons).toHaveLength(2);
    expect(buttons.some((b) => /merge/i.test(b.text))).toBe(false);
    expect(buttons.map((b) => b.data)).toEqual([`extwork:view:${run_id}`, `extwork:discard:${run_id}`]);
  });

  it("graceful degrade: no container runtime → 'install docker/podman' notice, nothing cloned, no throw", async () => {
    process.env.HOUGE_EXTWORK_ENABLED = "1";
    const store = RunStore.openInMemory();
    const log = freshLog();
    const run_id = turnRun(store, "fix this external repo");
    const { status, notifications } = await executeAndSettle(
      makeWorker(store, extDeps({ detectRuntime: async () => null }, log)),
      store,
      run_id
    );
    expect(status).toBe("completed");
    // Stopped BEFORE cloning — no clone, no teardown, no gate.
    expect(log.cloned).toEqual([]);
    expect(log.teardowns).toEqual([]);
    expect(log.gates).toBe(0);
    // The graceful notice reached the user, and a failed event was recorded.
    expect(notifications.some((n) => n.payload.text === EXTWORK_RUNTIME_UNAVAILABLE_NOTICE)).toBe(true);
    const failed = store.getLedgerEvents(run_id).filter((e) => e.event_type === "external_work_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.payload.reason).toContain("container runtime unavailable");
  });

  it("gate red on every attempt → refine ≤3 then a failure notification; clone still torn down", async () => {
    process.env.HOUGE_EXTWORK_ENABLED = "1";
    const store = RunStore.openInMemory();
    const log = freshLog();
    const run_id = turnRun(store, "fix the external repo but it keeps failing");
    const redGate: Partial<ExternalWorkDeps> = {
      runToolchainGate: async () => {
        log.gates += 1;
        return { ok: false, failedStage: "npm test", output: "1 failing" };
      }
    };
    const { status, notifications } = await executeAndSettle(makeWorker(store, extDeps(redGate, log)), store, run_id);
    expect(status).toBe("completed");
    // Three write passes, three gate runs (the ≤3 refine cap), then give up.
    expect(log.writeTasks).toHaveLength(3);
    expect(log.gates).toBe(3);
    expect(log.teardowns).toEqual(["/fake/clone"]);
    const failed = store.getLedgerEvents(run_id).filter((e) => e.event_type === "external_work_failed");
    expect(failed).toHaveLength(1);
    // The failure reached the user, with no merge/publish controls.
    const note = notifications.find((n) => typeof n.payload.text === "string" && (n.payload.text as string).includes("couldn't land"));
    expect(note).toBeDefined();
    expect(note!.payload.buttons).toBeUndefined();
  });

  it("SSRF: a non-https repo_url is refused before any clone", async () => {
    process.env.HOUGE_EXTWORK_ENABLED = "1";
    const store = RunStore.openInMemory();
    const log = freshLog();
    const run_id = turnRun(store, "work on this http repo");
    // Drive the refusal via a scripted external_work carrying an http (non-https) URL.
    const { notifications } = await executeAndSettle(
      makeWorker(store, extDeps({}, log), loopLlm([EXT_BAD_URL, FINAL])),
      store,
      run_id
    );
    // Nothing was cloned (the refusal short-circuits before detect/clone).
    expect(log.cloned).toEqual([]);
    expect(log.teardowns).toEqual([]);
    const failed = store.getLedgerEvents(run_id).filter((e) => e.event_type === "external_work_failed");
    expect(failed).toHaveLength(1);
    expect(notifications.some((n) => typeof n.payload.text === "string" && (n.payload.text as string).includes("refused"))).toBe(true);
  });
});
