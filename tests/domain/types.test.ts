import { describe, expect, it } from "vitest";
import { stableHash } from "../../src/domain/canonical.js";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import type { TypedTaskEventInput } from "../../src/domain/types.js";

const minimalTypedTaskEventInput: TypedTaskEventInput = {
  source: "cli",
  type: "run",
  requested_by: { kind: "user", id: "paco" },
  notify: { kind: "local" },
  idempotency_key: "cli:research-brief:1",
  source_reference: "argv"
};
void minimalTypedTaskEventInput;

// @ts-expect-error source_reference is required for trigger traceability.
const missingSourceReferenceInput: TypedTaskEventInput = {
  source: "cli",
  type: "run",
  program: "research-brief",
  goal: "compare gateway patterns",
  approval_id: "approval-1",
  lesson: "prefer gateway isolation",
  requested_by: { kind: "user", id: "paco" },
  notify: { kind: "local" },
  idempotency_key: "cli:research-brief:1"
};
void missingSourceReferenceInput;

describe("buildTypedTaskEvent", () => {
  it("includes a payload hash derived from normalized task fields", () => {
    const event = buildTypedTaskEvent({
      source: "cli",
      type: "run",
      program: "research-brief",
      goal: "compare gateway patterns",
      approval_id: "approval-1",
      lesson: "prefer gateway isolation",
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
      approval_id: "approval-1",
      lesson: "prefer gateway isolation",
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
      approval_id: "approval-1",
      lesson: "prefer gateway isolation",
      requested_by: { kind: "user", id: "paco" },
      notify: { kind: "local" },
      idempotency_key: "cli:research-brief:1",
      source_reference: "argv",
      created_at: "2026-05-25T00:01:00.000Z"
    });

    expect(retry.payload_hash).toBe(first.payload_hash);
  });

  it("hashes the explicit task payload fields including approval and lesson", () => {
    const event = buildTypedTaskEvent({
      source: "cli",
      type: "run",
      program: "research-brief",
      goal: "compare gateway patterns",
      approval_id: "approval-1",
      lesson: "prefer gateway isolation",
      requested_by: { kind: "user", id: "paco" },
      notify: { kind: "local" },
      idempotency_key: "cli:research-brief:1",
      source_reference: "argv",
      created_at: "2026-05-25T00:00:00.000Z"
    });

    expect(event.payload_hash).toBe(stableHash({
      source: "cli",
      type: "run",
      program: "research-brief",
      goal: "compare gateway patterns",
      approval_id: "approval-1",
      lesson: "prefer gateway isolation",
      requested_by: { kind: "user", id: "paco" },
      notify: { kind: "local" },
      idempotency_key: "cli:research-brief:1"
    }));
  });

  it("excludes source_reference from the payload hash", () => {
    const first = buildTypedTaskEvent({
      source: "cli",
      type: "run",
      program: "research-brief",
      goal: "compare gateway patterns",
      approval_id: "approval-1",
      lesson: "prefer gateway isolation",
      requested_by: { kind: "user", id: "paco" },
      notify: { kind: "local" },
      idempotency_key: "cli:research-brief:1",
      source_reference: "argv"
    });
    const retry = buildTypedTaskEvent({
      source: "cli",
      type: "run",
      program: "research-brief",
      goal: "compare gateway patterns",
      approval_id: "approval-1",
      lesson: "prefer gateway isolation",
      requested_by: { kind: "user", id: "paco" },
      notify: { kind: "local" },
      idempotency_key: "cli:research-brief:1",
      source_reference: "stdin"
    });

    expect(retry.payload_hash).toBe(first.payload_hash);
  });

  it("does not hash fields outside the explicit task payload contract", () => {
    const baseline = buildTypedTaskEvent({
      source: "cli",
      type: "run",
      program: "research-brief",
      goal: "compare gateway patterns",
      approval_id: "approval-1",
      lesson: "prefer gateway isolation",
      requested_by: { kind: "user", id: "paco" },
      notify: { kind: "local" },
      idempotency_key: "cli:research-brief:1",
      source_reference: "argv"
    });
    const withExtraField = buildTypedTaskEvent({
      source: "cli",
      type: "run",
      program: "research-brief",
      goal: "compare gateway patterns",
      approval_id: "approval-1",
      lesson: "prefer gateway isolation",
      requested_by: { kind: "user", id: "paco" },
      notify: { kind: "local" },
      idempotency_key: "cli:research-brief:1",
      source_reference: "argv",
      debug_note: "not part of the task payload contract"
    } as Parameters<typeof buildTypedTaskEvent>[0] & { debug_note: string });

    expect(withExtraField.payload_hash).toBe(baseline.payload_hash);
  });
});
