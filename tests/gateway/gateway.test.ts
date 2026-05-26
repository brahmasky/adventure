import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";

function event(goal: string, idempotency_key = "cli:gateway-test") {
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

describe("Gateway", () => {
  it("creates a contracted queued run from a typed task event", () => {
    const store = RunStore.openInMemory();
    const gateway = new Gateway(store);
    const result = gateway.intake(event("compare gateway designs"));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status).toBe("created");
    store.close();
  });

  it("returns duplicate with the same run_id for repeated typed task events", () => {
    const store = RunStore.openInMemory();
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
    store.close();
  });

  it("rejects the same idempotency key with a different payload hash", () => {
    const store = RunStore.openInMemory();
    const gateway = new Gateway(store);

    gateway.intake(event("compare gateway designs"));
    const conflict = gateway.intake(event("compare other designs"));

    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.error.code).toBe("IDEMPOTENCY_CONFLICT");
    }
    store.close();
  });
});
