import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import {
  formatScheduleCancelledText,
  formatScheduleNumberNotFoundText,
  Gateway,
  HELP_TEXT,
  SCHEDULE_CANCEL_NOT_FOUND_TEXT,
  SCHEDULE_GOAL_PREVIEW_CHARS,
  SCHEDULE_LIST_EMPTY_TEXT
} from "../../src/gateway/gateway.js";
import { formatScheduleListText, visibleSchedules } from "../../src/run/schedule-spec.js";
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

  it("/lessons renders the scope's rows as id + text + AVOID (⓪·3 S1), idempotent on redelivery", async () => {
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
      // Bold, not `##` — markdownToTelegramHtml has no heading support, so `##` would
      // reach the phone as literal characters.
      expect(note?.payload.text).toContain("**research — 1 active**");
      expect(note?.payload.text).toContain(`#${saved.id} prefer primary sources`);
      expect(note?.payload.text).toContain("AVOID: quoting forums as fact");
      // Internal telemetry (reuse/applied counts, supersede lineage) is not surfaced.
      expect(note?.payload.text).not.toContain("reuse");
      expect(note?.payload.text).not.toContain("applied");
      expect(note?.payload.text).not.toContain(`supersedes #${v1}`);
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

  it("/schedule lists THIS chat's schedules in the documented row shape, idempotent on redelivery (B10b)", () => {
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      const longGoal = `AI周报：${"搜".repeat(SCHEDULE_GOAL_PREVIEW_CHARS)}`; // > preview cap
      const mine = store.addScheduledTask({
        chat_id: "222",
        goal: longGoal,
        spec_json: '{"kind":"weekly","day":"mon","at":"08:00"}',
        tz: "Australia/Sydney",
        next_run_at: "2026-07-19T22:00:00.000Z", // = Mon 2026-07-20 08:00 Sydney
        now: "2026-07-15T00:00:00.000Z"
      });
      // Another chat's schedule must never leak into this chat's list.
      store.addScheduledTask({
        chat_id: "999",
        goal: "other chat secret",
        spec_json: '{"kind":"daily","at":"07:00"}',
        tz: "Australia/Sydney",
        next_run_at: "2026-07-15T21:00:00.000Z",
        now: "2026-07-15T00:00:00.000Z"
      });
      const event = buildTypedTaskEvent({
        source: "telegram",
        type: "schedule_admin",
        program: "list",
        requested_by: { kind: "user", id: "paco" },
        notify: { kind: "telegram", chat_id: "222" },
        idempotency_key: "telegram:schedule-list",
        source_reference: "telegram:update:30:message:1"
      });
      const first = gateway.intake(event);
      const second = gateway.intake(event); // redelivered update
      expect(first).toEqual({ ok: true, status: "schedule_admin_returned", run_id: "" });
      expect(second).toEqual(first);
      expect(store.countNotificationsByIdempotencyKey("telegram:schedule-list:schedule")).toBe(1);

      const note = store.claimNextNotification("test", 30);
      const text = String(note?.payload.text);
      // Row shape: #1 <name> · weekly mon 08:00 (Sydney) · 下次 2026-07-20 08:00
      expect(text).toContain("#1 "); // 1-based list number leads the row
      expect(text).toContain("weekly mon 08:00 (Sydney)");
      expect(text).toContain("下次 2026-07-20 08:00"); // local wall-clock, not a bare ...Z
      expect(text).not.toContain(mine.schedule_id); // opaque id is gone — user cancels by number
      expect(text).not.toContain("sch_"); // no id of any kind leaks
      expect(text).toContain("用 /schedule cancel"); // cancel-hint footer
      expect(text).not.toContain("Australia/Sydney"); // the full IANA tz is not doubled on the line
      expect(text).not.toContain(longGoal); // the long goal name is capped on the row
      expect(text).not.toContain("other chat secret"); // list is chat-scoped
    } finally {
      store.close();
    }
  });

  it("/schedule with no schedules reports the code-owned empty text", () => {
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      const event = buildTypedTaskEvent({
        source: "telegram",
        type: "schedule_admin",
        program: "list",
        requested_by: { kind: "user", id: "paco" },
        notify: { kind: "telegram", chat_id: "222" },
        idempotency_key: "telegram:schedule-empty",
        source_reference: "telegram:update:31:message:1"
      });
      expect(gateway.intake(event)).toEqual({ ok: true, status: "schedule_admin_returned", run_id: "" });
      const note = store.claimNextNotification("test", 30);
      expect(note?.payload.text).toBe(SCHEDULE_LIST_EMPTY_TEXT);
    } finally {
      store.close();
    }
  });

  it("/schedule cancel disables THIS chat's schedule; a cross-chat cancel reads exactly like not-found", () => {
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      const mine = store.addScheduledTask({
        chat_id: "222",
        goal: "mine",
        spec_json: '{"kind":"daily","at":"08:00"}',
        tz: "Australia/Sydney",
        next_run_at: "2026-07-15T22:00:00.000Z",
        now: "2026-07-15T00:00:00.000Z"
      });
      const theirs = store.addScheduledTask({
        chat_id: "999",
        goal: "theirs",
        spec_json: '{"kind":"daily","at":"08:00"}',
        tz: "Australia/Sydney",
        next_run_at: "2026-07-15T22:00:00.000Z",
        now: "2026-07-15T00:00:00.000Z"
      });
      const cancelEvent = (key: string, schedule_id: string) =>
        buildTypedTaskEvent({
          source: "telegram",
          type: "schedule_admin",
          program: "cancel",
          metadata: { schedule_id },
          requested_by: { kind: "user", id: "paco" },
          notify: { kind: "telegram", chat_id: "222" },
          idempotency_key: key,
          source_reference: `telegram:update:${key}:message:1`
        });

      // CROSS-CHAT REFUSED: chat 222 cannot cancel chat 999's schedule, and the reply
      // is byte-identical to a nonexistent id (no probe signal).
      expect(gateway.intake(cancelEvent("telegram:schedule-cancel-theirs", theirs.schedule_id)).ok).toBe(true);
      expect(store.claimNextNotification("a", 30)?.payload.text).toBe(SCHEDULE_CANCEL_NOT_FOUND_TEXT);
      expect(store.getScheduledTask(theirs.schedule_id)!.state).toBe("enabled");

      expect(gateway.intake(cancelEvent("telegram:schedule-cancel-missing", "sch_missing")).ok).toBe(true);
      expect(store.claimNextNotification("b", 30)?.payload.text).toBe(SCHEDULE_CANCEL_NOT_FOUND_TEXT);

      // Own-chat cancel works and acks with the schedule id.
      expect(gateway.intake(cancelEvent("telegram:schedule-cancel-mine", mine.schedule_id)).ok).toBe(true);
      expect(store.claimNextNotification("c", 30)?.payload.text).toBe(formatScheduleCancelledText(mine.schedule_id));
      expect(store.getScheduledTask(mine.schedule_id)!.state).toBe("disabled");
    } finally {
      store.close();
    }
  });

  it("/schedule cancel <N> cancels the Nth listed schedule; #2 is untouched (numbering parity)", () => {
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      // Two schedules in chat 222. listScheduledTasks orders by created_at DESC, so the
      // MORE RECENT one is #1. Seed with distinct created_at to pin the order.
      const older = store.addScheduledTask({
        chat_id: "222",
        goal: "older",
        spec_json: '{"kind":"daily","at":"08:00"}',
        tz: "Australia/Sydney",
        next_run_at: "2026-07-15T22:00:00.000Z",
        now: "2026-07-15T00:00:00.000Z"
      });
      const newer = store.addScheduledTask({
        chat_id: "222",
        goal: "newer",
        spec_json: '{"kind":"daily","at":"09:00"}',
        tz: "Australia/Sydney",
        next_run_at: "2026-07-15T23:00:00.000Z",
        now: "2026-07-16T00:00:00.000Z"
      });

      // Ordering parity: the schedule the renderer shows as #1 is exactly what `cancel 1`
      // resolves — assert against the SAME query/filter the cancel path reuses.
      const listed = visibleSchedules(store.listScheduledTasks("222"));
      expect(listed[0]!.schedule_id).toBe(newer.schedule_id); // #1
      expect(listed[1]!.schedule_id).toBe(older.schedule_id); // #2
      const renderedFirstLine = formatScheduleListText(store.listScheduledTasks("222")).split("\n")[0];
      expect(renderedFirstLine!.startsWith("#1 ")).toBe(true);
      expect(renderedFirstLine).toContain("newer");

      const cancelEvent = (key: string, arg: string) =>
        buildTypedTaskEvent({
          source: "telegram",
          type: "schedule_admin",
          program: "cancel",
          metadata: { schedule_id: arg },
          requested_by: { kind: "user", id: "paco" },
          notify: { kind: "telegram", chat_id: "222" },
          idempotency_key: key,
          source_reference: `telegram:update:${key}:message:1`
        });

      // cancel 1 → the #1 (newer) schedule flips; #2 (older) is untouched.
      expect(gateway.intake(cancelEvent("telegram:cancel-num-1", "1")).ok).toBe(true);
      expect(store.claimNextNotification("a", 30)?.payload.text).toBe(
        formatScheduleCancelledText(newer.schedule_id)
      );
      expect(store.getScheduledTask(newer.schedule_id)!.state).toBe("disabled");
      expect(store.getScheduledTask(older.schedule_id)!.state).toBe("enabled");
    } finally {
      store.close();
    }
  });

  it("/schedule cancel <N> out of range → a distinct error, nothing cancelled", () => {
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      const only = store.addScheduledTask({
        chat_id: "222",
        goal: "only one",
        spec_json: '{"kind":"daily","at":"08:00"}',
        tz: "Australia/Sydney",
        next_run_at: "2026-07-15T22:00:00.000Z",
        now: "2026-07-15T00:00:00.000Z"
      });
      const cancelEvent = (key: string, arg: string) =>
        buildTypedTaskEvent({
          source: "telegram",
          type: "schedule_admin",
          program: "cancel",
          metadata: { schedule_id: arg },
          requested_by: { kind: "user", id: "paco" },
          notify: { kind: "telegram", chat_id: "222" },
          idempotency_key: key,
          source_reference: `telegram:update:${key}:message:1`
        });

      // #9 does not exist — distinct from the id not-found text, and nothing is touched.
      expect(gateway.intake(cancelEvent("telegram:cancel-num-9", "9")).ok).toBe(true);
      expect(store.claimNextNotification("a", 30)?.payload.text).toBe(
        formatScheduleNumberNotFoundText(9)
      );
      expect(store.getScheduledTask(only.schedule_id)!.state).toBe("enabled");
    } finally {
      store.close();
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

  it("/usage renders the per-model table (code-fenced), enqueues once, creates NO run", () => {
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      store.recordLlmCall("run_a", {
        provider: "kimi-api",
        model: "moonshot-v1-auto",
        role: "answer",
        usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 0, cost_usd: 0.5 }
      });
      store.recordLlmCall("run_b", {
        provider: "openai",
        model: "gpt-4o",
        role: "answer",
        usage: { input_tokens: 200, output_tokens: 30, cached_input_tokens: 0, cost_usd: 1.25 }
      });

      const event = buildTypedTaskEvent({
        source: "telegram",
        type: "usage",
        requested_by: { kind: "user", id: "paco" },
        notify: { kind: "telegram", chat_id: "222" },
        idempotency_key: "telegram:usage-1",
        source_reference: "telegram:update:40:message:1"
      });

      const first = gateway.intake(event);
      const second = gateway.intake(event); // redelivered update

      expect(first).toEqual({ ok: true, status: "usage_returned", run_id: "" });
      expect(second).toEqual(first); // replayed, not recomputed
      expect(store.countNotificationsByIdempotencyKey("telegram:usage-1:usage")).toBe(1);
      // A control command: no run row is ever created.
      expect(store.listRecentRunStatuses(10)).toHaveLength(0);

      const note = store.claimNextNotification("test", 30);
      const text = String(note?.payload.text);
      expect(text).toContain("```"); // fixed-width table kept monospaced in Telegram
      expect(text).toContain("all-time"); // one-line window header
      expect(text).toContain("PROVIDER");
      // Grouped, honest split: kimi-api is a metered API leg; openai is a subscription CLI leg.
      expect(text).toContain("API — metered (pay-per-token)");
      expect(text).toContain("CLI — subscription (tokens only, no marginal $)");
      expect(text).toContain("moonshot-v1-auto");
      expect(text).toContain("gpt-4o");
    } finally {
      store.close();
    }
  });

  it("/usage on an empty ledger reports the empty-window text, no run", () => {
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      const event = buildTypedTaskEvent({
        source: "telegram",
        type: "usage",
        requested_by: { kind: "user", id: "paco" },
        notify: { kind: "telegram", chat_id: "222" },
        idempotency_key: "telegram:usage-empty",
        source_reference: "telegram:update:41:message:1"
      });
      expect(gateway.intake(event)).toEqual({ ok: true, status: "usage_returned", run_id: "" });
      expect(store.listRecentRunStatuses(10)).toHaveLength(0);
      const note = store.claimNextNotification("test", 30);
      expect(String(note?.payload.text)).toContain("No usage recorded in this window.");
    } finally {
      store.close();
    }
  });

  it("/help lists the real commands (incl. /status and /usage), enqueues once, no run", () => {
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      const event = buildTypedTaskEvent({
        source: "telegram",
        type: "help",
        requested_by: { kind: "user", id: "paco" },
        notify: { kind: "telegram", chat_id: "222" },
        idempotency_key: "telegram:help-1",
        source_reference: "telegram:update:42:message:1"
      });

      const first = gateway.intake(event);
      const second = gateway.intake(event);

      expect(first).toEqual({ ok: true, status: "help_returned", run_id: "" });
      expect(second).toEqual(first);
      expect(store.countNotificationsByIdempotencyKey("telegram:help-1:help")).toBe(1);
      expect(store.listRecentRunStatuses(10)).toHaveLength(0);

      const note = store.claimNextNotification("test", 30);
      const text = String(note?.payload.text);
      expect(text).toBe(HELP_TEXT);
      expect(text).toContain("/status");
      expect(text).toContain("/usage");
      expect(text).toContain("或者直接用自然语言提问");
    } finally {
      store.close();
    }
  });

  it("an unknown /command replies with the command list prefixed by the attempted word, no run", () => {
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      const event = buildTypedTaskEvent({
        source: "telegram",
        type: "unknown_command",
        program: "/nonsense", // the attempted command word rides program
        requested_by: { kind: "user", id: "paco" },
        notify: { kind: "telegram", chat_id: "222" },
        idempotency_key: "telegram:unknown-1",
        source_reference: "telegram:update:43:message:1"
      });

      expect(gateway.intake(event)).toEqual({ ok: true, status: "help_returned", run_id: "" });
      expect(store.listRecentRunStatuses(10)).toHaveLength(0);

      const note = store.claimNextNotification("test", 30);
      const text = String(note?.payload.text);
      expect(text).toContain("/nonsense 不是命令");
      expect(text).toContain("/status"); // still lists the real commands
      expect(text).toContain("/usage");
    } finally {
      store.close();
    }
  });
});

describe("/schedule 系统任务 footer (read-only built-in ticks)", () => {
  let savedRadar: string | undefined;
  let savedPanel: string | undefined;
  let savedAt: string | undefined;
  beforeEach(() => {
    savedRadar = process.env.HOUGE_RADAR_ENABLED;
    savedPanel = process.env.HOUGE_RADAR_PANEL_ENABLED;
    savedAt = process.env.HOUGE_RADAR_AT;
  });
  afterEach(() => {
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore("HOUGE_RADAR_ENABLED", savedRadar);
    restore("HOUGE_RADAR_PANEL_ENABLED", savedPanel);
    restore("HOUGE_RADAR_AT", savedAt);
  });

  function scheduleEvent(key: string) {
    return buildTypedTaskEvent({
      source: "telegram",
      type: "schedule_admin",
      requested_by: { kind: "user", id: "paco" },
      notify: { kind: "telegram", chat_id: "222" },
      idempotency_key: `telegram:${key}`,
      source_reference: `telegram:update:${key}`
    });
  }

  it("appends radar + panel lines with a computed next fire when both flags are armed", () => {
    process.env.HOUGE_RADAR_ENABLED = "1";
    process.env.HOUGE_RADAR_PANEL_ENABLED = "1";
    delete process.env.HOUGE_RADAR_AT; // default 07:30
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      gateway.intake(scheduleEvent("sys-sched-1"), "2026-07-27T00:00:00.000Z");
      const text = String(store.claimNextNotification("test", 30)?.payload.text);
      expect(text).toContain("系统任务");
      expect(text).toContain("· idea radar ·");
      expect(text).toContain("· idea panel ·");
      expect(text).toContain("下次");
      // Unnumbered: system rows must never look addressable by /schedule cancel <n>.
      expect(text).not.toMatch(/#\d+ .*idea radar/);
    } finally {
      store.close();
    }
  });

  it("omits the footer entirely when neither built-in tick is armed", () => {
    delete process.env.HOUGE_RADAR_ENABLED;
    delete process.env.HOUGE_RADAR_PANEL_ENABLED;
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      gateway.intake(scheduleEvent("sys-sched-2"), "2026-07-27T00:00:00.000Z");
      const text = String(store.claimNextNotification("test", 30)?.payload.text);
      expect(text).not.toContain("系统任务");
    } finally {
      store.close();
    }
  });
});
