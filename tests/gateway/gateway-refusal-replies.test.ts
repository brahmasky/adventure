// tests/gateway/gateway-refusal-replies.test.ts
import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent, type TypedTaskEvent } from "../../src/domain/types.js";
import { DEFAULT_GLOBAL_BUDGET_CAPS } from "../../src/budget/global-budget-ledger.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";
import { createQueuedTurnRun } from "../helpers/runs.js";

// Live gate 2026-10-01: a refused /approve or /deny was handled (intake no longer wedged) but silent. The operator
// saw nothing and could not tell a stale id from a lost message. Each user-side refusal gets one short code-owned
// reply naming the id; the loop-prone and self-alerting codes stay silent.
const CHAT = "222";
let seq = 0;
function setup(expiresInMs = 60_000) {
  const store = RunStore.openInMemory();
  const run_id = createQueuedTurnRun(store);
  store.claimRun(run_id, "planner:c1:a", 120);
  const row = store.createToolApproval({ run_id, worker_id: "planner:c1:a", tool_call_id: "tc1", capability: "shell_external",
    input_hash: "h", action_fingerprint: "f", requester: { kind: "user", id: "paco" }, summary: "git push",
    side_effect_level: "external_write", expires_at: new Date(Date.now() + expiresInMs).toISOString() });
  drain(store); // the card and the turn's own rows are not under test
  return { store, gateway: new Gateway(store), id: row.approval_id };
}
function event(type: "approve" | "deny", approval_id: string, who = "paco", key?: string): TypedTaskEvent {
  seq += 1;
  return buildTypedTaskEvent({ source: "telegram", type, approval_id, requested_by: { kind: "user", id: who },
    notify: { kind: "telegram", chat_id: CHAT }, idempotency_key: key ?? `telegram:${seq}:${seq}`,
    source_reference: `telegram:update:${seq}:message:${seq}` });
}
function drain(store: RunStore): Array<{ text: string; key: string }> {
  const out: Array<{ text: string; key: string }> = [];
  for (let n = store.claimNextNotification("t", 30); n; n = store.claimNextNotification("t", 30)) {
    out.push({ text: String(n.payload.text), key: n.idempotency_key });
  }
  return out;
}
const codeOf = (r: ReturnType<Gateway["intake"]>) => (r.ok ? "ok" : r.error.code);

describe("a refused /approve or /deny gets one code-owned reply", () => {
  it("APPROVAL_NOT_FOUND: names the id and points at /approvals", () => {
    const { store, gateway } = setup();
    expect(codeOf(gateway.intake(event("approve", "appr_nope")))).toBe("APPROVAL_NOT_FOUND");
    const replies = drain(store);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.text).toContain("`appr_nope`");
    expect(replies[0]!.text).toContain("/approvals");
  });

  it("APPROVAL_NOT_PENDING: an already-answered id says so", () => {
    const { store, gateway, id } = setup();
    expect(codeOf(gateway.intake(event("deny", id)))).toBe("ok");
    drain(store);
    expect(codeOf(gateway.intake(event("approve", id)))).toBe("APPROVAL_NOT_PENDING");
    const replies = drain(store);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.text).toContain(id);
    expect(replies[0]!.text).toMatch(/already/i);
  });

  it("APPROVAL_REQUESTER_MISMATCH: someone else's approval is refused with a reply", () => {
    const { store, gateway, id } = setup();
    expect(codeOf(gateway.intake(event("approve", id, "stranger")))).toBe("APPROVAL_REQUESTER_MISMATCH");
    const replies = drain(store);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.text).toContain(id);
  });

  it("APPROVAL_EXPIRED: an expired approval says it expired", () => {
    const { store, gateway, id } = setup(-1_000);
    expect(codeOf(gateway.intake(event("approve", id)))).toBe("APPROVAL_EXPIRED");
    const replies = drain(store);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.text).toMatch(/expired/i);
  });

  it("a redelivered refused update replies once, not twice", () => {
    const { store, gateway } = setup();
    const e = event("approve", "appr_nope");
    gateway.intake(e);
    gateway.intake(e);
    expect(drain(store)).toHaveLength(1);
  });

  it("echoes no more than a capped id: a pasted paragraph is not mirrored back", () => {
    const { store, gateway } = setup();
    const junk = `appr_${"x".repeat(500)}\`<b>`;
    gateway.intake(event("approve", junk));
    const [reply] = drain(store);
    expect(reply!.text.length).toBeLessThan(300);
    expect(reply!.text).not.toContain("x".repeat(100));
    expect(reply!.text).not.toContain("<b>");
  });
});

describe("refusals that must stay silent", () => {
  it("TRIGGER_IDEMPOTENCY_CONFLICT gets no reply", () => {
    const { store, gateway, id } = setup();
    gateway.intake(event("approve", "appr_nope", "paco", "telegram:dup:1"));
    drain(store);
    expect(codeOf(gateway.intake(event("approve", id, "paco", "telegram:dup:1")))).toBe("TRIGGER_IDEMPOTENCY_CONFLICT");
    expect(drain(store)).toEqual([]);
  });

  it("TELEGRAM_RATE_LIMITED gets no reply (a reply per refused command would loop)", () => {
    const { store, gateway } = setup();
    const now = new Date().toISOString();
    for (let i = 0; i < 6; i += 1) {
      store.recordTelegramCommandAudit({ actor_id: "paco", chat_id: CHAT, command: "turn", source_reference: `s${i}`, decision: "accepted", occurred_at: now });
    }
    expect(codeOf(gateway.intake(event("approve", "appr_nope"), now))).toBe("TELEGRAM_RATE_LIMITED");
    expect(drain(store)).toEqual([]);
  });

  it("GLOBAL_BUDGET_FUSE gets no refusal reply: its own fuse alert is the only message", () => {
    const { store } = setup();
    const gateway = new Gateway(store, { ...DEFAULT_GLOBAL_BUDGET_CAPS, runs: 1 });
    seq += 1;
    const turn = buildTypedTaskEvent({ source: "telegram", type: "turn", program: "turn", goal: "hi", requested_by: { kind: "user", id: "paco" },
      notify: { kind: "telegram", chat_id: CHAT }, idempotency_key: `telegram:${seq}:t`, source_reference: `telegram:update:${seq}:message:${seq}` });
    expect(codeOf(gateway.intake(turn))).toBe("GLOBAL_BUDGET_FUSE");
    const replies = drain(store);
    expect(replies.map((r) => r.key)).toEqual([expect.stringMatching(/^global-budget-fuse:/)]);
  });
});
