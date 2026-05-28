import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import type { CompiledTaskContract } from "../../src/domain/types.js";
import { RunStore } from "../../src/run/run-store.js";

let store: RunStore;

const contract: CompiledTaskContract = {
  objective: "compare Pi and Hermes",
  budget: { time_minutes: 15, max_tool_calls: 5, max_agent_delegations: 0 },
  allowed_actions: ["local_file_read", "write_report"],
  forbidden_actions: ["coding_agent_cli"],
  output: { path: "runs/<run-id>/report.md", format: "sourced_markdown_report" },
  approval_gates: ["external_write"],
  stop_condition: "report written",
  contract_hash: "contract_hash",
  eval_hooks: ["milestone-1-local-run"]
};

function event(goal: string) {
  return buildTypedTaskEvent({
    source: "cli",
    type: "run",
    program: "research-brief",
    goal,
    requested_by: { kind: "user", id: "paco" },
    notify: { kind: "local" },
    idempotency_key: "cli:fixed",
    source_reference: "argv",
    created_at: "2026-05-25T00:00:00.000Z"
  });
}

function createRun(goal = "compare Pi and Hermes"): string {
  const created = store.createOrGet(event(goal));
  if (created.status !== "created") {
    throw new Error(`Expected created run, got ${created.status}`);
  }

  return created.run_id;
}

type TestSqliteStatement = {
  get: <Row>(...values: unknown[]) => Row | undefined;
  all: <Row>(...values: unknown[]) => Row[];
  run: (...values: unknown[]) => { changes: number };
};

type TestSqliteDatabase = {
  prepare: (sql: string) => TestSqliteStatement;
};

describe("RunStore", () => {
  beforeEach(() => {
    store = RunStore.openInMemory();
  });

  afterEach(() => {
    store.close();
  });

  it("createOrGet returns created then duplicate with same run_id for same idempotency key/payload hash", () => {
    const taskEvent = event("compare Pi and Hermes");

    const created = store.createOrGet(taskEvent);
    const duplicate = store.createOrGet(taskEvent);

    expect(created.status).toBe("created");
    expect(duplicate.status).toBe("duplicate");
    if (created.status !== "created" || duplicate.status !== "duplicate") {
      throw new Error("Expected created run followed by duplicate run");
    }

    expect(duplicate.run_id).toBe(created.run_id);
  });

  it("createOrGet returns conflict with error IDEMPOTENCY_CONFLICT for same idempotency key/different payload hash", () => {
    const created = store.createOrGet(event("compare Pi and Hermes"));
    const conflict = store.createOrGet(event("compare Pi and Apollo"));

    expect(created.status).toBe("created");
    if (created.status !== "created") {
      throw new Error(`Expected created run, got ${created.status}`);
    }

    expect(conflict).toEqual({
      status: "conflict",
      error: "IDEMPOTENCY_CONFLICT",
      existing_run_id: created.run_id
    });
  });

  it("createOrGet re-reads after a SQLite unique race and returns duplicate", () => {
    const taskEvent = event("compare Pi and Hermes");
    const db = (store as unknown as { db: TestSqliteDatabase }).db;
    const originalPrepare = db.prepare.bind(db);

    db.prepare = (sql: string): TestSqliteStatement => {
      const statement = originalPrepare(sql);
      if (!sql.includes("INSERT INTO runs")) {
        return statement;
      }

      return {
        get: statement.get.bind(statement),
        all: statement.all.bind(statement),
        run: (...values: unknown[]) => {
          originalPrepare(sql).run("run_competing", ...values.slice(1));
          return statement.run(...values);
        }
      };
    };

    try {
      const duplicate = store.createOrGet(taskEvent);

      expect(duplicate).toEqual({ status: "duplicate", run_id: "run_competing" });
    } finally {
      db.prepare = originalPrepare;
    }
  });

  it("getRunState throws when the run is missing", () => {
    expect(() => store.getRunState("run_missing")).toThrow("Run not found: run_missing");
  });

  it("worker claims queued run and prevents another worker from claiming it; returned contract_hash is contract_hash", () => {
    const run_id = createRun();
    store.attachContract(run_id, contract);
    expect(store.getRunState(run_id)).toBe("created");
    store.transition(run_id, "created", "contracted", "contract attached");
    store.transition(run_id, "contracted", "queued", "ready");

    const claim = store.claimNext("worker-1", 30);
    const blocked = store.claimNext("worker-2", 30);

    expect(claim?.run_id).toBe(run_id);
    expect(claim?.contract.contract_hash).toBe("contract_hash");
    expect(blocked).toBeNull();
  });

  it("claimNext fails loudly when the next queued run has no contract", () => {
    const run_id = createRun();
    store.transition(run_id, "created", "contracted", "contract missing");
    store.transition(run_id, "contracted", "queued", "ready");

    expect(() => store.claimNext("worker-1", 30)).toThrow(
      `Queued run missing contract: ${run_id}`
    );
  });

  it("heartbeat extends only owning worker", () => {
    const run_id = createRun();
    store.attachContract(run_id, contract);
    store.transition(run_id, "created", "contracted", "contract attached");
    store.transition(run_id, "contracted", "queued", "ready");
    store.claimNext("worker-1", 30);

    expect(store.heartbeat(run_id, "worker-2", 30)).toBe(false);
    expect(store.heartbeat(run_id, "worker-1", 30)).toBe(true);
  });

  it("recoverExpiredLeases does not recover an active wall-clock lease", () => {
    const run_id = createRun();
    store.attachContract(run_id, contract);
    store.transition(run_id, "created", "contracted", "contract attached");
    store.transition(run_id, "contracted", "queued", "ready");
    store.claimNext("worker-1", 60);

    const recovered = store.recoverExpiredLeases(new Date().toISOString(), 3);

    expect(recovered).toEqual([]);
    expect(store.getRunState(run_id)).toBe("running");
  });

  it("recoverExpiredLeases(now, 3) requeues expired running lease when attempts remain and state is queued", () => {
    const run_id = createRun();
    store.attachContract(run_id, contract);
    store.transition(run_id, "created", "contracted", "contract attached");
    store.transition(run_id, "contracted", "queued", "ready");
    store.claimNext("worker-1", -1);

    const recovered = store.recoverExpiredLeases(new Date().toISOString(), 3);

    expect(recovered).toEqual([{ run_id, action: "requeued" }]);
    expect(store.getRunState(run_id)).toBe("queued");
  });

  it("recoverExpiredLeases fails expired running lease when max attempts are exhausted", () => {
    const run_id = createRun();
    store.attachContract(run_id, contract);
    store.transition(run_id, "created", "contracted", "contract attached");
    store.transition(run_id, "contracted", "queued", "ready");
    store.claimNext("worker-1", -1);

    const recovered = store.recoverExpiredLeases(new Date().toISOString(), 1);

    expect(recovered).toEqual([{ run_id, action: "failed" }]);
    expect(store.getRunState(run_id)).toBe("failed");
  });

  it("clears worker lease fields when a run reaches a terminal state", () => {
    const run_id = createRun();
    store.attachContract(run_id, contract);
    store.transition(run_id, "created", "contracted", "contract attached");
    store.transition(run_id, "contracted", "queued", "ready");
    const claim = store.claimNext("worker-1", 60);
    if (!claim) throw new Error("expected claim");

    store.transition(run_id, "running", "reporting", "report ready");
    store.transition(run_id, "reporting", "completed", "report written");

    expect(store.getRunLease(run_id)).toEqual({
      worker_id: null,
      lease_expires_at: null
    });
  });
});
