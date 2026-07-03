import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";
import { SkillStore } from "../../src/skills/skill-store.js";
import { isSelfWriteActionEvent, normalizeTelegramUpdate } from "../../src/triggers/telegram-trigger-adapter.js";

function seedWaitingApprovalRun(store: RunStore): string {
  const gateway = new Gateway(store);
  const intake = gateway.intake(buildTypedTaskEvent({
    source: "cli",
    type: "run",
    program: "research-brief",
    goal: "needs approval",
    requested_by: { kind: "user", id: "paco" },
    notify: { kind: "telegram", chat_id: "222" },
    idempotency_key: "cli:seed-waiting-approval",
    source_reference: "argv"
  }));
  if (!intake.ok) throw new Error("expected run");
  store.claimRun(intake.run_id, "worker-seed", 30);
  store.createApprovalRequest({
    run_id: intake.run_id,
    approval_type: "capability",
    capability: "local_project_write",
    action_fingerprint: "fp_write_report_artifact",
    adapter_input_hash: "input_hash_write_report_artifact",
    adapter_input_json: JSON.stringify({ path: "runs/run_1/artifact.txt", content: "hello" }),
    action_summary: "Write runs/run_1/artifact.txt",
    side_effect_level: "local_write",
    risk_level: "medium",
    affected_resources: ["path:runs/run_1/artifact.txt"],
    requester: { kind: "user", id: "paco" },
    expires_at: "2026-12-31T01:00:00.000Z"
  });
  return intake.run_id;
}

describe("Gateway telegram events", () => {
  it("deduplicates duplicate /status events without duplicate notifications", () => {
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      const event = buildTypedTaskEvent({
        source: "telegram",
        type: "status",
        requested_by: { kind: "user", id: "paco" },
        notify: { kind: "telegram", chat_id: "222" },
        idempotency_key: "telegram:status-duplicate",
        source_reference: "telegram:update:8:message:1"
      });

      const first = gateway.intake(event);
      const second = gateway.intake(event);

      expect(first).toEqual(second);
      expect(store.countNotificationsByIdempotencyKey("telegram:status-duplicate:status")).toBe(1);
    } finally {
      store.close();
    }
  });

  it("resolves approval once and replays duplicate approve deterministically", () => {
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      const run_id = seedWaitingApprovalRun(store);
      const pending = store.getApprovalForRun(run_id, "pending");
      if (!pending) throw new Error("expected pending approval");
      const normalized = normalizeTelegramUpdate({
        update_id: 9,
        message: {
          message_id: 1,
          text: `/approve ${pending.approval_id}`,
          from: { id: 111 },
          chat: { id: 222 }
        }
      }, {
        users: [{ telegram_user_id: 111, identity_id: "paco" }],
        chats: [{ telegram_chat_id: 222, label: "private", allowed_identity_ids: ["paco"] }]
      });
      if (!normalized.ok) throw new Error("expected normalized approve");
      if (isSelfWriteActionEvent(normalized.event)) throw new Error("expected a task event, not a callback");
      const event = normalized.event;

      const first = gateway.intake(event);
      const second = gateway.intake(event);

      expect(first).toEqual({ ok: true, status: "approval_resolved", run_id });
      expect(second).toEqual(first);
      expect(store.getRunState(run_id)).toBe("queued");
    } finally {
      store.close();
    }
  });

  it("queues approval prompt with full action evidence", () => {
    const store = RunStore.openInMemory();
    try {
      const run_id = seedWaitingApprovalRun(store);
      const prompt = store.claimNextNotification("sender-prompt", 30);

      expect(prompt?.intent_type).toBe("approval_prompt");
      expect(prompt?.payload.text).toContain("Action: Write runs/run_1/artifact.txt");
      expect(prompt?.payload.text).toContain("Side effect: local_write");
      expect(prompt?.payload.text).toContain("Risk: medium");
      expect(prompt?.payload.text).toContain("Affected resources: path:runs/run_1/artifact.txt");
      expect(prompt?.payload.text).toContain("Action fingerprint: fp_write_report_artifact");
      expect(prompt?.payload.text).toContain("Adapter input hash: input_hash_write_report_artifact");
      expect(prompt?.payload.text).toContain("Requester: user:paco");
      expect(prompt?.payload.text).toContain("Expected run state: waiting_for_approval");
      expect(prompt?.payload.text).toContain("Consequence if approved:");
      expect(run_id).toMatch(/^run_/);
    } finally {
      store.close();
    }
  });

  it("/lessons renders the scope's rows with id/reuse/lineage (⓪·3 S1), idempotent on redelivery", async () => {
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      const v1 = store.addLesson({
        scope: "research",
        text: "prefer forums",
        source: "migration",
        created_at: "2026-06-19T00:00:00.000Z"
      });
      const saved = store.saveReconciledLesson(
        { scope: "research", text: "prefer primary sources", avoid: "quoting forums as fact" },
        { verdict: "SUPERSEDE", id: v1 },
        "user_feedback",
        "2026-07-03T00:00:00.000Z"
      );

      const event = buildTypedTaskEvent({
        source: "telegram",
        type: "lessons",
        program: "research", // scope (optional) rides program
        requested_by: { kind: "user", id: "paco" },
        notify: { kind: "telegram", chat_id: "222" },
        idempotency_key: "telegram:lessons-1",
        source_reference: "telegram:update:5:message:1"
      });

      const first = gateway.intake(event);
      const second = gateway.intake(event); // redelivered update

      expect(first).toEqual({ ok: true, status: "lessons_returned", run_id: "" });
      expect(second).toEqual(first); // replayed, not re-applied

      // Exactly one notification despite two intakes (idempotent).
      expect(store.countNotificationsByIdempotencyKey("telegram:lessons-1:lessons")).toBe(1);
      const note = store.claimNextNotification("test", 30);
      expect(note?.payload.text).toContain("## research (1 active)");
      expect(note?.payload.text).toContain(`#${saved.id} prefer primary sources — reuse 1.0, applied 0`);
      expect(note?.payload.text).toContain("AVOID: quoting forums as fact");
      expect(note?.payload.text).toContain(`supersedes #${v1}`); // lineage visible
      // The superseded predecessor is no longer listed as its own row.
      expect(note?.payload.text).not.toContain(`#${v1} prefer forums`);
    } finally {
      store.close();
    }
  });

  it("/lessons with no scope reports emptiness when nothing has been learned", () => {
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      const event = buildTypedTaskEvent({
        source: "telegram",
        type: "lessons",
        requested_by: { kind: "user", id: "paco" },
        notify: { kind: "telegram", chat_id: "222" },
        idempotency_key: "telegram:lessons-empty",
        source_reference: "telegram:update:6:message:1"
      });
      expect(gateway.intake(event)).toEqual({ ok: true, status: "lessons_returned", run_id: "" });
      const note = store.claimNextNotification("test", 30);
      expect(note?.payload.text).toContain("No lessons yet");
    } finally {
      store.close();
    }
  });

  it("/forget <scope> prunes the scope's rows (reversibly), acks, and is idempotent on redelivery", () => {
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      const id = store.addLesson({
        scope: "research",
        text: "prefer primary sources",
        source: "user_feedback",
        created_at: "2026-06-19T00:00:00.000Z"
      });
      expect(store.readLessonBlock("research")).toBeDefined();

      const event = buildTypedTaskEvent({
        source: "telegram",
        type: "forget",
        program: "research", // scope rides program
        requested_by: { kind: "user", id: "paco" },
        notify: { kind: "telegram", chat_id: "222" },
        idempotency_key: "telegram:forget-1",
        source_reference: "telegram:update:7:message:1"
      });

      const first = gateway.intake(event);
      const second = gateway.intake(event); // redelivered update

      expect(first).toEqual({ ok: true, status: "forgotten", run_id: "" });
      expect(second).toEqual(first); // replayed, not re-applied
      expect(store.readLessonBlock("research")).toBeUndefined(); // cleared from the prompt
      expect(store.getLesson(id)!.status).toBe("pruned"); // but the row survives (reversible)

      expect(store.countNotificationsByIdempotencyKey("telegram:forget-1:forget")).toBe(1);
      const note = store.claimNextNotification("test", 30);
      expect(note?.payload.text).toContain("Forgotten ✓");
    } finally {
      store.close();
    }
  });

  it("/forget <id> prunes one lesson by numeric id", () => {
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      const keep = store.addLesson({ scope: "ask", text: "keep me", source: "loop", created_at: "2026-07-03T00:00:00.000Z" });
      const drop = store.addLesson({ scope: "ask", text: "drop me", source: "loop", created_at: "2026-07-03T00:00:00.000Z" });

      const event = buildTypedTaskEvent({
        source: "telegram",
        type: "forget",
        program: String(drop), // a numeric arg selects one lesson
        requested_by: { kind: "user", id: "paco" },
        notify: { kind: "telegram", chat_id: "222" },
        idempotency_key: "telegram:forget-id-1",
        source_reference: "telegram:update:8:message:1"
      });

      expect(gateway.intake(event)).toEqual({ ok: true, status: "forgotten", run_id: "" });
      expect(store.getLesson(drop)!.status).toBe("pruned");
      expect(store.getLesson(keep)!.status).toBe("active");
      const note = store.claimNextNotification("test", 30);
      expect(note?.payload.text).toContain(`pruned lesson #${drop}`);
    } finally {
      store.close();
    }
  });

  it("/skills lists a seeded skill and is idempotent on redelivery", () => {
    const store = RunStore.openInMemory();
    const root = mkdtempSync(join(tmpdir(), "houge-gw-skills-"));
    try {
      mkdirSync(join(root, "research"), { recursive: true });
      writeFileSync(
        join(root, "research", "cross-check.md"),
        "---\nname: cross-check-figures\nscope: research\nwhen: comparing numbers\nversion: 2\n---\nmethod body",
        "utf8"
      );
      const gateway = new Gateway(store, undefined, undefined, new SkillStore({ root }));

      const event = buildTypedTaskEvent({
        source: "telegram",
        type: "skills",
        program: "research", // scope (optional) rides program
        requested_by: { kind: "user", id: "paco" },
        notify: { kind: "telegram", chat_id: "222" },
        idempotency_key: "telegram:skills-1",
        source_reference: "telegram:update:20:message:1"
      });

      const first = gateway.intake(event);
      const second = gateway.intake(event); // redelivered update

      expect(first).toEqual({ ok: true, status: "skills_returned", run_id: "" });
      expect(second).toEqual(first); // replayed, not re-applied
      expect(store.countNotificationsByIdempotencyKey("telegram:skills-1:skills")).toBe(1);
      const note = store.claimNextNotification("test", 30);
      expect(note?.payload.text).toContain("cross-check-figures");
      expect(note?.payload.text).toContain("when: comparing numbers");
      expect(note?.payload.text).toContain("v2");
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("/skills reports emptiness when no skills exist for the scope", () => {
    const store = RunStore.openInMemory();
    const root = mkdtempSync(join(tmpdir(), "houge-gw-skills-empty-"));
    try {
      const gateway = new Gateway(store, undefined, undefined, new SkillStore({ root }));
      const event = buildTypedTaskEvent({
        source: "telegram",
        type: "skills",
        program: "research",
        requested_by: { kind: "user", id: "paco" },
        notify: { kind: "telegram", chat_id: "222" },
        idempotency_key: "telegram:skills-empty",
        source_reference: "telegram:update:21:message:1"
      });
      expect(gateway.intake(event)).toEqual({ ok: true, status: "skills_returned", run_id: "" });
      const note = store.claimNextNotification("test", 30);
      expect(note?.payload.text).toContain('No skills for "research" yet.');
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("/skills pending lists parked drafts and never the active library", () => {
    const store = RunStore.openInMemory();
    const root = mkdtempSync(join(tmpdir(), "houge-gw-skills-pending-"));
    try {
      const skillStore = new SkillStore({ root });
      // One active skill + one parked draft.
      skillStore.writeSkill("research", "good-skill", "---\nname: good-skill\nscope: research\nwhen: w\n---\nbody");
      skillStore.writePending("ask", "blocked-skill", "---\nname: blocked-skill\nscope: ask\nwhen: trigger\n---\nbody");
      const gateway = new Gateway(store, undefined, undefined, skillStore);
      const event = buildTypedTaskEvent({
        source: "telegram",
        type: "skills",
        program: "pending",
        requested_by: { kind: "user", id: "paco" },
        notify: { kind: "telegram", chat_id: "222" },
        idempotency_key: "telegram:skills-pending",
        source_reference: "telegram:update:22:message:1"
      });
      expect(gateway.intake(event)).toEqual({ ok: true, status: "skills_returned", run_id: "" });
      const note = store.claimNextNotification("test", 30);
      expect(note?.payload.text).toContain("blocked-skill");
      expect(note?.payload.text).toContain("Pending (blocked) skills");
      expect(note?.payload.text).not.toContain("good-skill"); // active skill not listed under pending
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throttles abusive telegram command volume per actor and chat", () => {
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      for (let i = 0; i < 5; i += 1) {
        const result = gateway.intake(buildTypedTaskEvent({
          source: "telegram",
          type: "ask",
          goal: `question ${i}`,
          requested_by: { kind: "user", id: "paco" },
          notify: { kind: "telegram", chat_id: "222" },
          idempotency_key: `telegram:rate:${i}`,
          source_reference: `telegram:update:${i}:message:1`
        }));
        expect(result.ok).toBe(true);
      }
      expect(gateway.intake(buildTypedTaskEvent({
        source: "telegram",
        type: "ask",
        goal: "one too many",
        requested_by: { kind: "user", id: "paco" },
        notify: { kind: "telegram", chat_id: "222" },
        idempotency_key: "telegram:rate:blocked",
        source_reference: "telegram:update:99:message:1"
      }))).toEqual({
        ok: false,
        error: { code: "TELEGRAM_RATE_LIMITED", message: "Telegram command rate limit exceeded" }
      });
    } finally {
      store.close();
    }
  });
});
