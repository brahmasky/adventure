import { describe, expect, it } from "vitest";
import { compileTaskContract } from "../../src/contracts/task-contract.js";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";

function event(
  goal: string,
  idempotency_key = "cli:gateway-test",
  program = "research-brief"
) {
  return buildTypedTaskEvent({
    source: "cli",
    type: "run",
    program,
    goal,
    requested_by: { kind: "user", id: "paco" },
    notify: { kind: "local" },
    idempotency_key,
    source_reference: "argv"
  });
}

describe("Gateway", () => {
  it("creates a contracted queued run from a typed task event", () => {
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      const result = gateway.intake(event("compare gateway designs"));

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.status).toBe("created");
    } finally {
      store.close();
    }
  });

  it("returns duplicate with the same run_id for repeated typed task events", () => {
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      const taskEvent = event("compare gateway designs");

      const created = gateway.intake(taskEvent);
      const duplicate = gateway.intake(taskEvent);

      expect(created.ok).toBe(true);
      expect(duplicate.ok).toBe(true);
      if (created.ok && duplicate.ok) {
        expect(duplicate.status).toBe("duplicate");
        expect(duplicate.run_id).toBe(created.run_id);
      }
    } finally {
      store.close();
    }
  });

  it("rejects the same idempotency key with a different payload hash", () => {
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);

      gateway.intake(event("compare gateway designs"));
      const conflict = gateway.intake(event("compare other designs"));

      expect(conflict.ok).toBe(false);
      if (!conflict.ok) {
        expect(conflict.error.code).toBe("IDEMPOTENCY_CONFLICT");
      }
    } finally {
      store.close();
    }
  });

  it("does not persist invalid task contracts as duplicate successes", () => {
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      const invalid = event("compare gateway designs", "cli:invalid", "unknown-program");

      const first = gateway.intake(invalid);
      const second = gateway.intake(invalid);

      expect(first.ok).toBe(false);
      expect(second.ok).toBe(false);
      if (!first.ok && !second.ok) {
        expect(first.error.code).toBe("TASK_CONTRACT_INVALID");
        expect(first.error.message).toBe("Unknown program: unknown-program");
        expect(second.error).toEqual(first.error);
      }
    } finally {
      store.close();
    }
  });

  it("resumes duplicate intake interrupted after created state", () => {
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      const taskEvent = event("resume created intake", "cli:resume-created");
      const seeded = store.createOrGet(taskEvent);
      if (seeded.status !== "created") throw new Error("Expected created run");

      const result = gateway.intake(taskEvent);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.status).toBe("created");
        expect(result.run_id).toBe(seeded.run_id);
      }
      expect(store.getRunState(seeded.run_id)).toBe("queued");
    } finally {
      store.close();
    }
  });

  it("resumes duplicate intake interrupted after contracted state", () => {
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      const taskEvent = event("resume contracted intake", "cli:resume-contracted");
      const seeded = store.createOrGet(taskEvent);
      const contract = compileTaskContract(taskEvent);
      if (seeded.status !== "created" || !contract.ok) {
        throw new Error("Expected created run and valid contract");
      }
      store.attachContract(seeded.run_id, contract.contract);
      store.transition(seeded.run_id, "created", "contracted", "contract attached");

      const result = gateway.intake(taskEvent);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.status).toBe("created");
        expect(result.run_id).toBe(seeded.run_id);
      }
      expect(store.getRunState(seeded.run_id)).toBe("queued");
    } finally {
      store.close();
    }
  });
});
