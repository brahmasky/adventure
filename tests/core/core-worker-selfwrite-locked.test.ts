import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoreWorker, NEEDS_LOCKED_FILE } from "../../src/core/core-worker.js";
import type { SelfWriteDeps } from "../../src/core/core-worker.js";
import { evolutionLaneSettled, resetEvolutionLaneForTests } from "../../src/core/evolution-lane.js";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";
import type { ToolAdapterResult } from "../../src/tools/tool-registry.js";
import type { ReviewResult } from "../../src/capabilities/diff-reviewer.js";
import { pinOmpEnv, tmpOmpDist } from "../helpers/omp-env.js";
import { bridgeTurn } from "../helpers/omp-worker.js";

pinOmpEnv();

const OK = ":100644 100644 a b M\t";
const TOOL_DECLS = "src/omp/tool-decls.ts";
const SCHEDULE_SPEC = "src/run/schedule-spec.ts";

let dirs: string[] = [];
let savedEnabled: string | undefined;
beforeEach(() => {
  savedEnabled = process.env.HOUGE_SELFWRITE_ENABLED;
  process.env.HOUGE_SELFWRITE_ENABLED = "1";
  resetEvolutionLaneForTests();
});
afterEach(async () => {
  await evolutionLaneSettled();
  resetEvolutionLaneForTests();
  if (savedEnabled === undefined) delete process.env.HOUGE_SELFWRITE_ENABLED;
  else process.env.HOUGE_SELFWRITE_ENABLED = savedEnabled;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

interface Log { writeTasks: string[]; published: string[]; guardSaw: string[]; }

/** A stack where attempt N's raw diff is `diffs[N-1]` (paths, M status) and `sentinels[N-1]` is what the writer left in NEEDS_LOCKED_FILE. */
function stack(diffs: string[][], log: Log, sentinels: Array<string | undefined> = []): SelfWriteDeps {
  let writes = 0;
  return {
    createWorktree: () => ({ path: "/fake/wt" }),
    removeWorktree: () => {},
    mkNodeModulesLink: () => {},
    makeWriteAdapter: () => (input: { task: string }): ToolAdapterResult => {
      log.writeTasks.push(input.task);
      writes += 1;
      return { ok: true, output: { worktree: "/fake/wt", provider: "codex", model: "gpt-fake", usageRaw: "" } };
    },
    rawDiff: () => {
      const raw = (diffs[writes - 1] ?? []).map((p) => `${OK}${p}\n`).join("");
      log.guardSaw.push(raw);
      return raw;
    },
    unifiedDiff: () => "diff --git a/x b/x\n+fixed",
    runTestGate: () => ({ green: true }),
    reviewDiff: (input): ReviewResult => {
      input.audit.record({ provider: "kimi-cli", role: "", outcome: "ok", latency_ms: 1, model: "m" });
      return { ok: true, verdict: { verdict: "pass", fixes_task: true, introduces_bugs: false, scope_creep: false, reasons: [] } };
    },
    publishBranch: (_wt, branch) => { log.published.push(branch); return branch; },
    takeNeedsLocked: () => sentinels[writes - 1]
  };
}

function runWith(d: SelfWriteDeps, store: RunStore): { run_id: string; go: () => Promise<string[]> } {
  const intake = new Gateway(store).intake(
    buildTypedTaskEvent({
      source: "telegram", type: "turn", program: "turn", goal: "fix the schedule length",
      requested_by: { kind: "user", id: "paco" }, notify: { kind: "telegram", chat_id: "777" },
      idempotency_key: "sw-locked", source_reference: "telegram:update:1:message:1"
    })
  );
  if (!intake.ok) throw new Error("intake failed");
  const root = mkdtempSync(join(tmpdir(), "houge-sw-locked-"));
  dirs.push(root);
  const llm = async (input: Record<string, unknown>): Promise<ToolAdapterResult> => ({ ok: true, output: { question: input.question, answer: "a", model: "f", provider: "f" } });
  const worker = new CoreWorker(store, root, llm, undefined, undefined, d, undefined, undefined, undefined, async () => null,
    undefined, undefined, { dataDir: root, distDir: tmpOmpDist(root) });
  const go = async (): Promise<string[]> => {
    const t = bridgeTurn(store, worker, intake.run_id, root);
    await t.call("self_write_propose", { focus: "schedule length" });
    await evolutionLaneSettled();
    const texts: string[] = [];
    for (let i = 0; ; i += 1) {
      const n = store.claimNextNotification(`c${i}`, 60);
      if (!n) break;
      texts.push(String((n.payload as Record<string, unknown>).text));
    }
    return texts;
  };
  return { run_id: intake.run_id, go };
}

const blocked = (store: RunStore, id: string) => store.getLedgerEvents(id).filter((e) => e.event_type === "self_write_blocked");

describe("self-write locked-path guidance", () => {
  it("the writer's first task lists the locked paths (why: it cannot avoid what it was never told)", async () => {
    const store = RunStore.openInMemory();
    const log: Log = { writeTasks: [], published: [], guardSaw: [] };
    try {
      const r = runWith(stack([[SCHEDULE_SPEC]], log), store);
      await r.go();
      const t = log.writeTasks[0]!;
      for (const p of ["src/omp/", "docs/decisions/", "agents.md", "src/capabilities/self-write-guard.ts"]) expect(t).toContain(p);
      expect(t).not.toContain("gate/identity/dependency/config files");
    } finally { store.close(); }
  });

  it("a locked touch gets ONE guided retry and a clean second pass publishes (why: the 2026-10-13 fix never needed tool-decls)", async () => {
    const store = RunStore.openInMemory();
    const log: Log = { writeTasks: [], published: [], guardSaw: [] };
    try {
      const r = runWith(stack([[TOOL_DECLS, SCHEDULE_SPEC], [SCHEDULE_SPEC]], log), store);
      await r.go();
      expect(log.published).toEqual([`houge/selfwrite/${r.run_id}`]);
      expect(blocked(store, r.run_id)).toEqual([]);
      expect(log.writeTasks[1]).toContain(TOOL_DECLS);
      expect(log.writeTasks[1]).toContain(NEEDS_LOCKED_FILE);
    } finally { store.close(); }
  });

  it("touching a locked path again after being told is terminal after exactly 2 writes (why: no retry until maxAttempts)", async () => {
    const store = RunStore.openInMemory();
    const log: Log = { writeTasks: [], published: [], guardSaw: [] };
    try {
      const r = runWith(stack([[TOOL_DECLS], [TOOL_DECLS], [SCHEDULE_SPEC]], log), store);
      const texts = await r.go();
      expect(log.writeTasks.length).toBe(2);
      expect(log.published).toEqual([]);
      expect(blocked(store, r.run_id).length).toBe(1);
      const text = texts.join("\n");
      expect(text).toContain(TOOL_DECLS);
      expect(text).toMatch(/after being told/);
    } finally { store.close(); }
  });

  it("a NEEDS_LOCKED sentinel is terminal, quoted, and never reaches the guard or a branch (why: honest 'yours to make')", async () => {
    const store = RunStore.openInMemory();
    const log: Log = { writeTasks: [], published: [], guardSaw: [] };
    try {
      const reason = "needs a new field in src/omp/tool-decls.ts";
      const r = runWith(stack([["src/omp/x.ts"], []], log, [undefined, reason]), store);
      const text = (await r.go()).join("\n");
      expect(log.writeTasks.length).toBe(2);
      expect(log.published).toEqual([]);
      expect(blocked(store, r.run_id).length).toBe(1);
      expect(text).toContain(reason);
      expect(log.guardSaw.join("")).not.toContain(NEEDS_LOCKED_FILE);
    } finally { store.close(); }
  });

  it("a secret-shaped string in the sentinel is masked in the notification (why: the reason is writer-authored, untrusted text)", async () => {
    const store = RunStore.openInMemory();
    const log: Log = { writeTasks: [], published: [], guardSaw: [] };
    try {
      const secret = `sk-${"a1B2c3D4e5".repeat(4)}`;
      const r = runWith(stack([["src/omp/x.ts"], []], log, [undefined, `needs the key ${secret} wired in src/omp/x.ts`]), store);
      const text = (await r.go()).join("\n");
      expect(text).not.toContain(secret);
      expect(text).toContain("src/omp/x.ts");
      expect(text).toContain("<token>"); // masked, not silently dropped
    } finally { store.close(); }
  });

  it("test-only denials still refine with the existing text (why: the locked retry must not displace the test-edit path)", async () => {
    const store = RunStore.openInMemory();
    const log: Log = { writeTasks: [], published: [], guardSaw: [] };
    try {
      const r = runWith(stack([["tests/prompt/composer.test.ts"], [SCHEDULE_SPEC]], log), store);
      await r.go();
      expect(log.writeTasks[1]).toMatch(/EXISTING test file/);
      expect(log.published).toEqual([`houge/selfwrite/${r.run_id}`]);
    } finally { store.close(); }
  });
});
