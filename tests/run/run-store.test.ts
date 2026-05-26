import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import type { CompiledTaskContract } from "../../src/domain/types.js";
import RunStore from "../../src/run/run-store.js";

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
    expect(duplicate.run_id).toBe(created.run_id);
  });

  it("createOrGet returns conflict with error IDEMPOTENCY_CONFLICT for same idempotency key/different payload hash", () => {
    const created = store.createOrGet(event("compare Pi and Hermes"));
    const conflict = store.createOrGet(event("compare Pi and Apollo"));

    expect(created.status).toBe("created");
    expect(conflict).toEqual({
      status: "conflict",
      error: "IDEMPOTENCY_CONFLICT",
      run_id: created.run_id
    });
  });

  it("worker claims queued run and prevents another worker from claiming it; returned contract_hash is contract_hash", () => {
    const created = store.createOrGet(event("compare Pi and Hermes"));
    store.attachContract(created.run_id, contract);
    store.transition(created.run_id, "contracted", "queued", "ready");

    const claim = store.claimNext("worker-1", 30);
    const blocked = store.claimNext("worker-2", 30);

    expect(claim?.run_id).toBe(created.run_id);
    expect(claim?.contract.contract_hash).toBe("contract_hash");
    expect(blocked).toBeNull();
  });

  it("heartbeat extends only owning worker", () => {
    const created = store.createOrGet(event("compare Pi and Hermes"));
    store.attachContract(created.run_id, contract);
    store.transition(created.run_id, "contracted", "queued", "ready");
    store.claimNext("worker-1", 30);

    expect(store.heartbeat(created.run_id, "worker-2", 30)).toBe(false);
    expect(store.heartbeat(created.run_id, "worker-1", 30)).toBe(true);
  });

  it("recoverExpiredLeases(now, 3) requeues expired running lease when attempts remain and state is queued", () => {
    const created = store.createOrGet(event("compare Pi and Hermes"));
    store.attachContract(created.run_id, contract);
    store.transition(created.run_id, "contracted", "queued", "ready");
    store.claimNext("worker-1", -30);

    const recovered = store.recoverExpiredLeases("2026-05-25T00:01:00.000Z", 3);

    expect(recovered).toEqual([{ run_id: created.run_id, action: "requeued" }]);
    expect(store.getRunState(created.run_id)).toBe("queued");
  });
});
