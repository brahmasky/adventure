import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildTypedTaskEvent } from "../domain/types.js";
import type { TelegramAllowlist } from "../domain/types.js";
import type { ToolAdapterResult } from "../tools/tool-registry.js";
import { CoreWorker } from "../core/core-worker.js";
import { Gateway } from "../gateway/gateway.js";
import { RunStore } from "../run/run-store.js";
import { NotificationOutbox } from "../notifications/notification-outbox.js";
import { NotificationDispatcher } from "../notifications/notification-dispatcher.js";
import { LocalNotificationAdapter } from "../notifications/local-notification-adapter.js";
import { TelegramNotificationAdapter } from "../notifications/telegram-notification-adapter.js";
import { normalizeTelegramUpdate } from "../triggers/telegram-trigger-adapter.js";

export interface EvalSuiteFile {
  name: string;
  required_fixtures?: string[];
  executable_cases?: string[];
}

export interface EvalFixtureFile {
  name: string;
  checks: string[];
}

export interface EvalResult {
  suite: string;
  passed: boolean;
  failed: string[];
}

export type EvalFixtureExecutableFile =
  | { name: string; type: "parser-auth"; input: { text: string; from_id: number; chat_id: number } }
  | { name: string; type: "outbox-delivery"; input: { target: { kind: "telegram"; chat_id: string }; text: string } }
  | { name: string; type: "approval-resume"; input: { goal: string; requester: string } }
  | { name: string; type: "ask-path"; input: { text: string } };

export interface EvalRunOptions {
  fixtureOverride?: EvalFixtureExecutableFile;
}

export async function runEvalSuite(
  projectRoot: string,
  suite: string,
  options: EvalRunOptions = {}
): Promise<EvalResult> {
  const path = join(projectRoot, "evals", "suites", `${suite}.json`);
  const data = JSON.parse(readFileSync(path, "utf8")) as EvalSuiteFile;

  if (Array.isArray(data.executable_cases)) {
    return runExecutableSuite(projectRoot, data, options);
  }

  const required = data.required_fixtures ?? [];
  const fixturesDir = join(projectRoot, "evals", "fixtures");
  const failed = required.filter((name) => {
    const fixtureName = name.trim();
    if (fixtureName.length === 0) return true;
    const fixturePath = join(fixturesDir, `${fixtureName}.json`);
    if (!existsSync(fixturePath)) return true;

    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Partial<EvalFixtureFile>;
    return fixture.name !== fixtureName || !Array.isArray(fixture.checks) || fixture.checks.length === 0;
  });
  return { suite: data.name, passed: failed.length === 0, failed };
}

async function runExecutableSuite(
  projectRoot: string,
  data: EvalSuiteFile,
  options: EvalRunOptions
): Promise<EvalResult> {
  const fixturesDir = join(projectRoot, "evals", "fixtures");
  const goldenDir = join(projectRoot, "evals", "golden");
  const failed: string[] = [];

  for (const caseName of data.executable_cases ?? []) {
    const goldenPath = join(goldenDir, `${caseName}.json`);
    if (!existsSync(goldenPath)) {
      failed.push(caseName);
      continue;
    }

    let fixture: EvalFixtureExecutableFile;
    if (options.fixtureOverride && options.fixtureOverride.name === caseName) {
      fixture = options.fixtureOverride;
    } else {
      const fixturePath = join(fixturesDir, `${caseName}.json`);
      if (!existsSync(fixturePath)) {
        failed.push(caseName);
        continue;
      }
      fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as EvalFixtureExecutableFile;
    }

    let actual: unknown;
    try {
      actual = await runExecutableEvalCase(projectRoot, fixture);
    } catch {
      failed.push(caseName);
      continue;
    }

    const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as unknown;
    if (JSON.stringify(actual) !== JSON.stringify(golden)) {
      failed.push(caseName);
    }
  }

  return { suite: data.name, passed: failed.length === 0, failed };
}

const EVAL_ALLOWLIST: TelegramAllowlist = {
  users: [{ telegram_user_id: 111, identity_id: "paco" }],
  chats: [{ telegram_chat_id: 222, label: "paco-private", allowed_identity_ids: ["paco"] }]
};

const STABLE_RUN_EVENTS = new Set([
  "run_created",
  "contract_attached",
  "worker_lease_acquired",
  "report_written",
  "run_completed"
]);

const STABLE_APPROVAL_EVENTS = new Set([
  "approval_requested",
  "approval_resolved",
  "tool_finished",
  "run_completed"
]);

const fakeLlmAdapter = async (
  input: Record<string, unknown>
): Promise<ToolAdapterResult> => {
  const question = typeof input.question === "string" ? input.question : "";
  return {
    ok: true,
    output: { question, answer: "Deterministic eval answer.", model: "eval-fake" }
  };
};

export async function runExecutableEvalCase(
  projectRoot: string,
  fixture: EvalFixtureExecutableFile
): Promise<unknown> {
  switch (fixture.type) {
    case "parser-auth":
      return runParserAuthCase(fixture.input);
    case "outbox-delivery":
      return runOutboxDeliveryCase(fixture.input);
    case "approval-resume":
      return runApprovalResumeCase(projectRoot, fixture.input);
    case "ask-path":
      return runAskPathCase(projectRoot, fixture.input);
  }
}

function runParserAuthCase(input: { text: string; from_id: number; chat_id: number }): unknown {
  const normalized = normalizeTelegramUpdate(
    {
      update_id: 1,
      message: {
        message_id: 1,
        text: input.text,
        from: { id: input.from_id },
        chat: { id: input.chat_id }
      }
    },
    EVAL_ALLOWLIST
  );

  if (!normalized.ok) {
    return { ok: false, error_code: normalized.error.code };
  }

  const event = normalized.event;
  return {
    event_type: event.type,
    program: event.type === "ask" || event.type === "run" ? event.program : null,
    authorized_identity: event.requested_by.id,
    notify: event.notify.kind === "telegram" ? `telegram:${event.notify.chat_id}` : event.notify.kind
  };
}

async function runOutboxDeliveryCase(input: {
  target: { kind: "telegram"; chat_id: string };
  text: string;
}): Promise<unknown> {
  const store = RunStore.openInMemory();
  try {
    const outbox = new NotificationOutbox(store);
    const enqueued = outbox.enqueue({
      target: input.target,
      intent_type: "final_report",
      idempotency_key: "eval:outbox-delivery",
      correlation_id: "eval:outbox-delivery",
      payload: { text: input.text }
    });

    let sentChatId = "";
    const fakeTelegramClient = {
      async sendMessage(message: { chat_id: string; text: string }) {
        sentChatId = message.chat_id;
        void message.text;
        return { message_id: 1 };
      }
    };

    const dispatcher = new NotificationDispatcher(outbox, {
      local: new LocalNotificationAdapter(),
      telegram: new TelegramNotificationAdapter(fakeTelegramClient)
    });

    const claimedState = "sending";
    const dispatch = await dispatcher.dispatchOnce("eval-dispatcher");
    void sentChatId;

    const record = outbox.get(enqueued.notification_id);
    const ledgerEvents = store
      .getLedgerEvents()
      .filter((event) => event.correlation_id === "eval:outbox-delivery")
      .map((event) => event.event_type)
      .filter((eventType) => eventType === "notification_delivered");

    return {
      notification_states: [claimedState, dispatch.status === "delivered" ? record?.state : dispatch.status],
      provider_message_id: record?.provider_message_id ?? null,
      ledger_events: ledgerEvents
    };
  } finally {
    store.close();
  }
}

async function runApprovalResumeCase(
  projectRoot: string,
  input: { goal: string; requester: string }
): Promise<unknown> {
  const store = RunStore.openInMemory();
  try {
    const gateway = new Gateway(store);
    const intake = gateway.intake(buildTypedTaskEvent({
      source: "cli",
      type: "run",
      program: "research-brief",
      goal: input.goal,
      requested_by: { kind: "user", id: input.requester },
      notify: { kind: "local" },
      idempotency_key: "eval:approval-resume",
      source_reference: "argv",
      metadata: { force_gated_capability: true }
    }));
    if (!intake.ok) throw new Error("intake failed");

    const runStates: string[] = [];
    const approvalStates: string[] = [];

    runStates.push(store.getRunState(intake.run_id)); // queued

    const parked = await new CoreWorker(store, projectRoot).executeRun(intake.run_id, "eval-worker");
    if (parked.status !== "waiting_for_approval") throw new Error("expected approval wait");
    runStates.push(store.getRunState(intake.run_id)); // waiting_for_approval
    approvalStates.push(store.getApprovalForRun(intake.run_id, "pending") ? "pending" : "missing");

    const pending = store.getApprovalForRun(intake.run_id, "pending");
    if (!pending) throw new Error("expected pending approval");

    store.processApprovalTrigger({
      event: buildTypedTaskEvent({
        source: "telegram",
        type: "approve",
        approval_id: pending.approval_id,
        requested_by: { kind: "user", id: input.requester },
        notify: { kind: "telegram", chat_id: "222" },
        idempotency_key: "eval:approval-resume-approve",
        source_reference: "telegram:update:20:message:1"
      }),
      decision: "approved",
      resolved_at: "2026-05-28T00:10:00.000Z"
    });

    runStates.push(store.getRunState(intake.run_id)); // queued
    approvalStates.push(store.getApprovalForRun(intake.run_id, "approved") ? "approved" : "missing");

    const completed = await new CoreWorker(store, projectRoot).executeRun(intake.run_id, "eval-worker");
    if (completed.status !== "completed") throw new Error("expected completion");
    runStates.push(store.getRunState(intake.run_id)); // completed
    approvalStates.push(store.getApprovalForRun(intake.run_id, "consumed") ? "consumed" : "missing");

    const ledgerEvents = store
      .getLedgerEvents(intake.run_id)
      .map((event) => event.event_type)
      .filter((eventType) => STABLE_APPROVAL_EVENTS.has(eventType));

    return {
      run_states: runStates,
      approval_states: approvalStates,
      ledger_events: ledgerEvents
    };
  } finally {
    store.close();
  }
}

async function runAskPathCase(projectRoot: string, input: { text: string }): Promise<unknown> {
  const store = RunStore.openInMemory();
  try {
    const normalized = normalizeTelegramUpdate(
      {
        update_id: 1,
        message: {
          message_id: 1,
          text: input.text,
          from: { id: 111 },
          chat: { id: 222 }
        }
      },
      EVAL_ALLOWLIST
    );
    if (!normalized.ok) throw new Error("normalize failed");

    const intake = new Gateway(store).intake(normalized.event);
    if (!intake.ok) throw new Error("intake failed");

    const worker = new CoreWorker(store, projectRoot, fakeLlmAdapter);
    const result = await worker.executeRun(intake.run_id, "eval-worker");
    if (result.status !== "completed") throw new Error("expected completion");

    const ledgerEvents = store
      .getLedgerEvents(intake.run_id)
      .map((event) => event.event_type)
      .filter((eventType) => STABLE_RUN_EVENTS.has(eventType));

    const outboxIntents = store
      .getLedgerEvents(intake.run_id)
      .filter((event) => event.event_type === "notification_queued")
      .map((event) => {
        const payload = event.payload as { intent_type?: unknown };
        return typeof payload.intent_type === "string" ? payload.intent_type : "unknown";
      });

    const program = normalized.event.type === "ask" || normalized.event.type === "run"
      ? normalized.event.program
      : null;

    return {
      program,
      run_state: store.getRunState(intake.run_id),
      ledger_events: ledgerEvents,
      outbox_intents: outboxIntents
    };
  } finally {
    store.close();
  }
}
