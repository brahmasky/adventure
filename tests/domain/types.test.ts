import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";

describe("buildTypedTaskEvent", () => {
  it("includes a payload hash derived from normalized task fields", () => {
    const event = buildTypedTaskEvent({
      source: "cli",
      type: "run",
      program: "research-brief",
      goal: "compare gateway patterns",
      requested_by: { kind: "user", id: "paco" },
      notify: { kind: "local" },
      idempotency_key: "cli:research-brief:1",
      source_reference: "argv"
    });

    expect(event.payload_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("excludes created_at from payload hash so retries dedupe correctly", () => {
    const first = buildTypedTaskEvent({
      source: "cli",
      type: "run",
      program: "research-brief",
      goal: "compare gateway patterns",
      requested_by: { kind: "user", id: "paco" },
      notify: { kind: "local" },
      idempotency_key: "cli:research-brief:1",
      source_reference: "argv",
      created_at: "2026-05-25T00:00:00.000Z"
    });
    const retry = buildTypedTaskEvent({
      source: "cli",
      type: "run",
      program: "research-brief",
      goal: "compare gateway patterns",
      requested_by: { kind: "user", id: "paco" },
      notify: { kind: "local" },
      idempotency_key: "cli:research-brief:1",
      source_reference: "argv",
      created_at: "2026-05-25T00:01:00.000Z"
    });

    expect(retry.payload_hash).toBe(first.payload_hash);
  });
});
