import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";

describe("Gateway", () => {
  it("creates a contracted queued run from a typed task event", () => {
    const store = RunStore.openInMemory();
    const gateway = new Gateway(store);
    const result = gateway.intake(
      buildTypedTaskEvent({
        source: "cli",
        type: "run",
        program: "research-brief",
        goal: "compare gateway designs",
        requested_by: { kind: "user", id: "paco" },
        notify: { kind: "local" },
        idempotency_key: "cli:gateway-test",
        source_reference: "argv"
      })
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status).toBe("created");
    store.close();
  });
});
