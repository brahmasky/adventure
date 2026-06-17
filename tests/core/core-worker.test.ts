import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { CoreWorker } from "../../src/core/core-worker.js";
import { RunStore } from "../../src/run/run-store.js";

function event(goal: string, idempotency_key: string) {
  return buildTypedTaskEvent({
    source: "cli",
    type: "run",
    program: "research-brief",
    goal,
    requested_by: { kind: "user", id: "paco" },
    notify: { kind: "local" },
    idempotency_key,
    source_reference: "argv"
  });
}

describe("CoreWorker", () => {
  it("claims a queued run and writes a report", async () => {
    const root = mkdtempSync(join(tmpdir(), "houge-core-"));
    writeFileSync(join(root, "AGENTS.md"), "Project rules");
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      gateway.intake(event("summarize local project rules", "cli:core-test"));

      const worker = new CoreWorker(store, root);
      const result = await worker.executeOnce("worker-1");

      expect(result.status).toBe("completed");
      expect(result.report_path).toContain("report.md");
      if (result.status === "completed") {
        expect(store.getLedgerEvents(result.run_id).map((event) => event.event_type)).toEqual([
          "run_created",
          "contract_attached",
          "worker_lease_acquired",
          "report_written",
          "worker_lease_released",
          "run_completed",
          "notification_queued"
        ]);
      }
    } finally {
      store.close();
    }
  });

  it("returns idle when no queued run exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "houge-core-"));
    const store = RunStore.openInMemory();
    try {
      const worker = new CoreWorker(store, root);

      const result = await worker.executeOnce("worker-1");

      expect(result).toEqual({ status: "idle" });
    } finally {
      store.close();
    }
  });

  it("executes a targeted queued run without claiming older queued work", async () => {
    const root = mkdtempSync(join(tmpdir(), "houge-core-"));
    writeFileSync(join(root, "AGENTS.md"), "Project rules");
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      const older = gateway.intake(event("older queued work", "cli:older"));
      const target = gateway.intake(event("target queued work", "cli:target"));
      if (!older.ok || !target.ok) throw new Error("Expected queued runs");

      const worker = new CoreWorker(store, root);
      const result = await worker.executeRun(target.run_id, "worker-1");

      expect(result.status).toBe("completed");
      expect(result.run_id).toBe(target.run_id);
      expect(store.getRunState(older.run_id)).toBe("queued");
      expect(store.getRunState(target.run_id)).toBe("completed");
    } finally {
      store.close();
    }
  });

  it("marks the run failed when report writing fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "houge-core-"));
    writeFileSync(join(root, "AGENTS.md"), "Project rules");
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      const intake = gateway.intake(event("summarize local project rules", "cli:report-failure"));
      if (!intake.ok) throw new Error("Expected queued run");
      mkdirSync(join(root, "runs"));
      writeFileSync(join(root, "runs", intake.run_id), "blocks report directory");

      const worker = new CoreWorker(store, root);
      const result = await worker.executeRun(intake.run_id, "worker-1");

      expect(result.status).toBe("failed");
      expect(result.error).toContain("EEXIST");
      expect(store.getRunState(intake.run_id)).toBe("failed");
    } finally {
      store.close();
    }
  });

  it("writes a partial report and marks the run failed when reading project rules fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "houge-core-"));
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      const intake = gateway.intake(event("summarize local project rules", "cli:partial-report"));
      if (!intake.ok) throw new Error("Expected queued run");

      const worker = new CoreWorker(store, root);
      const result = await worker.executeRun(intake.run_id, "worker-1");

      expect(result).toEqual({
        status: "failed",
        run_id: intake.run_id,
        error: "File not found: AGENTS.md"
      });
      expect(store.getRunState(intake.run_id)).toBe("failed");

      const report = readFileSync(join(root, "runs", intake.run_id, "report.md"), "utf8");
      expect(report).toContain("Partial report");
      expect(report).toContain("Capability status: failed");
      expect(report).toContain("Error: File not found: AGENTS.md");
    } finally {
      store.close();
    }
  });

  it("executes /ask through run, llm capability, report, and ledger path", async () => {
    const root = mkdtempSync(join(tmpdir(), "houge-ask-"));
    const store = RunStore.openInMemory();
    try {
      const intake = new Gateway(store).intake(buildTypedTaskEvent({
        source: "telegram",
        type: "ask",
        program: "ask",
        goal: "what should Houge do next?",
        requested_by: { kind: "user", id: "paco" },
        notify: { kind: "telegram", chat_id: "222" },
        idempotency_key: "telegram:ask-path",
        source_reference: "telegram:update:2:message:2"
      }));
      if (!intake.ok) throw new Error("Expected ask intake");

      const fakeLlm = async (input: Record<string, unknown>) => ({
        ok: true as const,
        output: { question: input.question, answer: "Ship the local run engine.", model: "test-model", provider: "test-llm" }
      });

      const result = await new CoreWorker(store, root, fakeLlm).executeRun(intake.run_id, "worker-ask");

      expect(result.status).toBe("completed");
      expect(store.getRunState(intake.run_id)).toBe("completed");
      expect(store.getLedgerEvents(intake.run_id).map((event) => event.event_type)).toContain("report_written");

      const report = readFileSync(join(root, "runs", intake.run_id, "report.md"), "utf8");
      expect(report).toContain("Ship the local run engine.");
      expect(report).toContain("llm:test-llm:test-model");
    } finally {
      store.close();
    }
  });
});
