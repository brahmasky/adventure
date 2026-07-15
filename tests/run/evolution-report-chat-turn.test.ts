import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import type { NotifyTarget } from "../../src/domain/types.js";
import { RunStore } from "../../src/run/run-store.js";

/**
 * B10a: a background evolution report delivered via the outbox must ALSO become an
 * assistant chat turn — the live gap (07-13 03:27): the skill/evolution final_report
 * reached Telegram but never the chat thread, so the model could not resolve follow-ups
 * about "the report above". The `queued` outbox status is the exactly-once latch.
 */

let store: RunStore;
beforeEach(() => {
  store = RunStore.openInMemory();
});
afterEach(() => {
  store.close();
});

function createRun(notify: NotifyTarget, key = "k1"): string {
  const created = store.createOrGet(
    buildTypedTaskEvent({
      source: "telegram",
      type: "turn",
      program: "turn",
      goal: "改一下技能",
      requested_by: { kind: "user", id: "paco" },
      notify,
      idempotency_key: key,
      source_reference: "telegram:update:1:message:1",
      created_at: "2026-07-15T00:00:00.000Z"
    })
  );
  if (created.status !== "created") throw new Error(`expected created, got ${created.status}`);
  return created.run_id;
}

describe("enqueueEvolutionReportNotification → assistant chat turn (B10a)", () => {
  it("queued: records exactly one assistant turn with the run/chat/intent and the SAME truncated text", () => {
    const run_id = createRun({ kind: "telegram", chat_id: "555" });
    const result = store.enqueueEvolutionReportNotification(run_id, "skill_author", {
      text: "🐒 新技能已写好：AI 周报流程"
    });
    expect(result.status).toBe("queued");

    const turns = store.getRecentChatTurns("555", 10);
    expect(turns.length).toBe(1);
    expect(turns[0]).toMatchObject({
      chat_id: "555",
      run_id,
      role: "assistant",
      intent: "evolution_report",
      text: "🐒 新技能已写好：AI 周报流程"
    });
    // The turn text IS the notification payload text (post-truncation) — the thread
    // shows exactly what the user was sent.
    if (result.status === "queued") {
      expect(turns[0]!.text).toBe(result.record.payload.text);
    }
  });

  it("duplicate re-enqueue records NO second turn (the queued status is the latch)", () => {
    const run_id = createRun({ kind: "telegram", chat_id: "555" });
    store.enqueueEvolutionReportNotification(run_id, "skill_author", { text: "report" });
    const again = store.enqueueEvolutionReportNotification(run_id, "skill_author", { text: "report" });
    expect(again.status).toBe("duplicate");
    expect(store.getRecentChatTurns("555", 10).length).toBe(1);
  });

  it("conflict (same key, different payload) records NO turn for the conflicting enqueue", () => {
    const run_id = createRun({ kind: "telegram", chat_id: "555" });
    store.enqueueEvolutionReportNotification(run_id, "skill_author", { text: "report" });
    const conflict = store.enqueueEvolutionReportNotification(run_id, "skill_author", { text: "DIFFERENT" });
    expect(conflict.status).toBe("conflict");
    expect(store.getRecentChatTurns("555", 10).length).toBe(1);
  });

  it("a local-target run records nothing — there is no chat thread to extend", () => {
    const run_id = createRun({ kind: "local" });
    const result = store.enqueueEvolutionReportNotification(run_id, "self_diagnose", { text: "report" });
    expect(result.status).toBe("queued");
    // No chat_id exists for a local run; assert the chat_turns table stayed empty.
    expect(store.getRecentChatTurns("", 10)).toEqual([]);
    expect(store.getRecentChatTurns("555", 10)).toEqual([]);
  });

  it("the final_report paths (completion + failure) record NOTHING new — normal turns self-record in the loop", () => {
    const run_id = createRun({ kind: "telegram", chat_id: "555" });
    const completion = store.enqueueFinalReportNotification(run_id, {
      text: "the answer",
      report_path: "runs/x/report.md"
    });
    expect(completion.status).toBe("queued");
    const failure = store.enqueueFailureNotification(run_id, "boom");
    // Same idempotency key as the completion — duplicate/conflict, and still no turn.
    expect(failure.status).not.toBe("queued");
    expect(store.getRecentChatTurns("555", 10)).toEqual([]);
  });
});
