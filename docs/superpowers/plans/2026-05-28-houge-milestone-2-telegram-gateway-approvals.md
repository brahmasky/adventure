# Houge Milestone 2 Telegram Gateway and Approvals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Houge Milestone 2: deterministic Telegram command intake, allowlisted auth, `/ask` through the normal run path, durable approval resolution and consumption, notification outbox dispatch, runnable one-shot Telegram polling, reusable status, and executable milestone-2 evals.

**Architecture:** Deterministic core first, Telegram network last. Telegram raw updates become `TypedTaskEvent`s before Gateway, Gateway owns idempotent intake and approval decisions, RunStore owns durable run/approval/outbox state, CapabilityRunner revalidates and consumes approved actions before adapter execution, CoreWorker parks and resumes through the same claim path, and Telegram messages are sent only by NotificationOutbox delivery.

**Tech Stack:** Node.js 25, TypeScript, Vitest, built-in `node:sqlite`, built-in `fetch`, fake Telegram clients in tests, no live Telegram dependency in automated tests.

---

## Scope

This plan implements:

- Telegram parser for `/ask`, `/run`, `/status`, `/approve`, and `/deny`.
- Telegram-origin `TypedTaskEvent` intake through the existing Gateway path.
- Telegram user/chat allowlist auth that rejects forwarded messages, channel posts, and anonymous admins.
- Built-in `ask` contract proving `/ask` uses normal Run, TaskContract, CapabilityRunner, report, ledger, and outbox paths.
- Approval lifecycle: `pending -> approved -> consumed`, `pending -> denied`, `pending -> expired`.
- `RunStore.consumeApprovedApproval({ run_id, approval_id, requester, capability, adapter_input_hash, action_fingerprint, tool_call_id, operation_id })` with atomic binding to run, capability, adapter input hash, action fingerprint, tool call, and operation.
- Approval records persist canonical `adapter_input_json`; resume executes the stored approved adapter input instead of reconstructing input from live caller state.
- Approval security checks for requester match, non-expired approval, pending state, run `waiting_for_approval`, terminal-run exclusion, stored non-empty action fingerprint, capability match, adapter input hash match, and action fingerprint match.
- Atomic `/approve` and `/deny` processing through `RunStore.processApprovalTrigger(...)` so processed-trigger replay, approval transition, ledger event, outbox notification, and result storage are one transaction.
- Approval expiry through `RunStore.expirePendingApprovals(now)` for undelivered prompts, late approvals, and worker resume.
- CoreWorker `waiting_for_approval` result and resume behavior after approval.
- Notification Outbox with local and Telegram adapters, dispatcher, retry recovery, stale lease recovery, delivery/failure ledger events, and approval-prompt expiry handling.
- `houge send-outbox` and `houge telegram-poll --once`.
- Executable/golden milestone-2 evals for parser/auth, outbox delivery, approval resume, and `/ask`.
- SQLite schema migrations, compatibility validation, and indexes for hot queries and outbox claims.
- Processed-trigger idempotency for `/status`, `/approve`, and `/deny`, including deterministic replay for duplicates and conflict detection for mismatched payloads.
- Abuse controls for per-actor/chat command rate, queued runs, active runs, and pending approvals.
- Telegram long-poll offset handling that advances after deterministic parse/auth rejects and durable Gateway intake success. Worker execution and outbox dispatch happen after the offset boundary because both are durable/retryable from SQLite state.

## NOT in Scope

- Scheduler and recurring runs: Milestone 3.
- Memory, learning proposals, and `/teach`: Milestone 4.
- Environment guidebooks and guidebook retrieval evals: Milestone 5.
- Generic shell or coding-agent CLI delegation: deferred until deterministic process containment exists.
- Public webhook hosting: long polling is the Milestone 2 integration shape.
- Real LLM answer generation: `/ask` proves the run path using existing report behavior.
- Arbitrary agent-selected Telegram sending: Telegram messages are allowed only through NotificationOutbox delivery.

## ASCII Data Flow

```text
Telegram update
-> parseTelegramCommand(raw text)
-> authorizeTelegramUpdate(update, allowlist)
-> buildTypedTaskEvent({ source: "telegram", ... })
-> Gateway.intake(event)
   -> processed_triggers replay/conflict check for read-only/status commands
   -> processApprovalTrigger(...) transaction for /approve and /deny
   -> RunStore create/dedupe/status/approval resolution
   -> TaskContract compile for /ask or /run
   -> NotificationOutbox enqueue progress or approval prompt
-> CoreWorker claims queued run
-> CapabilityRunner executes allowed actions or requests approval
-> ReportWriter writes report
-> NotificationOutbox queues final report
-> NotificationDispatcher sends via Local or Telegram adapter
```

```text
Gated capability
-> CapabilityRunner computes adapter_input_hash and action_fingerprint
-> RunStore.createApprovalRequest(..., adapter_input_json)
-> run state: running -> waiting_for_approval, lease cleared
-> approval_prompt notification queued
-> /approve <approval-id> or /deny <approval-id>
-> Gateway calls processApprovalTrigger(...) with approval_id, requester, decision
   -> replay/conflict check
   -> approval row validates requester, expiry, stored fingerprint, and run state
   approve: pending -> approved, run waiting_for_approval -> queued
   deny: pending -> denied, run waiting_for_approval -> cancelled
   -> approval_resolved notification queued
   -> processed trigger result stored
-> CoreWorker claims queued run
-> CoreWorker loads stored approved capability and adapter_input_json
-> CapabilityRunner recomputes adapter_input_hash and action_fingerprint from stored input
-> policy revalidation
-> consumeApprovedApproval(..., capability, adapter_input_hash, action_fingerprint)
   approved -> consumed, tool_call_id and operation_id bound
-> adapter executes once
```

```text
Telegram long polling offset
-> getUpdates(offset)
-> for each update in update_id order:
   deterministic parse/auth/unsupported-command reject
     -> skipped_update audit row
     -> setOffset(update_id + 1)
   normalized event built
     -> Gateway durable intake succeeds
        -> setOffset(update_id + 1)
     -> Gateway durable intake throws before commit
        -> leave offset unchanged so Telegram can retry
```

## Engineering Review Coverage

```text
approval lifecycle/security -> Tasks 5, 6, 8
durable approved adapter input -> Tasks 5 and 6
atomic approval trigger replay -> Tasks 5 and 8
approval expiry -> Tasks 5, 7, 8
CoreWorker parking/resume -> Task 6
notification delivery/failure -> Task 7
long polling runnable gateway -> Task 9
poison-update offset handling -> Task 9
executable evals -> Task 10
schema migrations/compatibility -> Task 5
rate limits/abuse controls -> Task 8
indexes/perf -> Tasks 5, 7, and 8
circular dependency -> Task 7 notification-types split
approval prompt content -> Task 8
outbox correlation fields -> Task 7
status/approval idempotency -> Tasks 5 and 8
scope boundary -> Scope and Task 6 policy rule
```

## Dependency and Parallelization Table

| Lane | Tasks | Can run in parallel with | Must wait for |
|------|-------|--------------------------|---------------|
| Parser/auth | 1, 2 | Status, ask contract | None |
| Status/ask | 3, 4 | Parser/auth | None |
| Approval state | 5 | Parser/auth, status/ask | Current RunStore API understood |
| Capability/core approvals | 6 | Outbox type definitions | Task 5 |
| Outbox/dispatcher | 7 | Parser/auth, status/ask | RunStore migration coordination |
| Gateway replay/prompt | 8 | None | Tasks 5 and 7 |
| Telegram poll runner | 9 | Eval fixture drafting | Tasks 1, 2, 7, 8 |
| Executable evals | 10 | None | Tasks 1 through 9 |

## File Structure

- Create `src/triggers/telegram-command-parser.ts`: pure parser from Telegram text to normalized command fields.
- Create `src/triggers/telegram-auth.ts`: allowlist checks for user id, chat id, forwarded messages, channel posts, and anonymous admins.
- Create `src/triggers/telegram-trigger-adapter.ts`: update normalization and long polling over parser/auth.
- Create `src/status/status-query.ts`: read-only run/status projection shared by CLI and Telegram.
- Create `src/notifications/notification-types.ts`: shared notification types, correlation fields, and helper functions used by RunStore and outbox modules. This avoids a RunStore to NotificationOutbox circular import.
- Create `src/notifications/notification-outbox.ts`: thin wrapper over RunStore notification methods.
- Create `src/notifications/notification-dispatcher.ts`: claims queued notifications, chooses adapter, sends, marks delivered or failed.
- Create `src/notifications/local-notification-adapter.ts`: local sink adapter.
- Create `src/notifications/telegram-notification-adapter.ts`: Telegram send adapter over a small client boundary.
- Create `src/telegram/telegram-client.ts`: fetch-based Telegram client with `getUpdates` and `sendMessage`.
- Create `src/telegram/telegram-poll-runner.ts`: one-shot Telegram runner wiring polling, Gateway, CoreWorker, and outbox dispatch.
- Modify `src/domain/types.ts`: Telegram allowlist, notification intent type, and approval-related metadata types.
- Modify `src/contracts/task-contract.ts`: compile `/ask` as built-in `ask` program and keep `/run research-brief` unchanged.
- Modify `src/run/run-store.ts`: schema migrations, processed triggers, approvals, stored adapter input, notification outbox, offsets, skipped-update audit, rate-limit counters, indexes, status projections, approval expiry, and approval consumption.
- Modify `src/gateway/gateway.ts`: idempotent handling for `status`, `approve`, `deny`, `ask`, and `run`.
- Create `src/capabilities/local-project-write-adapter.ts`: scoped testable local write adapter used by the approval fixture.
- Modify `src/capabilities/capability-runner.ts`: request approvals, store exact adapter input, revalidate approved actions, consume approvals before execution.
- Modify `src/core/core-worker.ts`: support `ask`, `waiting_for_approval`, resume after approval, and final-report notifications.
- Modify `src/cli.ts`: add `houge status [run-id]`, `houge send-outbox`, `houge telegram-poll --once`, `houge telegram-parser-smoke`, and `houge outbox-smoke`.
- Modify `src/eval/eval-runner.ts`: add executable milestone-2 eval cases and golden comparison.
- Create/modify tests under `tests/triggers`, `tests/status`, `tests/notifications`, `tests/telegram`, `tests/gateway`, `tests/core`, `tests/capabilities`, `tests/run`, and `tests/eval`.
- Create `evals/suites/milestone-2.json`, `evals/fixtures/milestone-2-*.json`, and `evals/golden/milestone-2-*.json`.

## Task 1: Telegram Command Parser

**Files:**
- Create: `src/triggers/telegram-command-parser.ts`
- Test: `tests/triggers/telegram-command-parser.test.ts`

- [ ] **Step 1: Write the failing parser tests**

Create `tests/triggers/telegram-command-parser.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseTelegramCommand } from "../../src/triggers/telegram-command-parser.js";

describe("parseTelegramCommand", () => {
  it("parses ask, run, status, approve, and deny", () => {
    expect(parseTelegramCommand("/ask compare Pi and Hermes")).toEqual({
      ok: true,
      command: { type: "ask", goal: "compare Pi and Hermes" }
    });
    expect(parseTelegramCommand('/run research-brief "compare gateway designs"')).toEqual({
      ok: true,
      command: { type: "run", program: "research-brief", goal: "compare gateway designs" }
    });
    expect(parseTelegramCommand("/status run_123")).toEqual({
      ok: true,
      command: { type: "status", run_id: "run_123" }
    });
    expect(parseTelegramCommand("/approve appr_abc")).toEqual({
      ok: true,
      command: { type: "approve", approval_id: "appr_abc" }
    });
    expect(parseTelegramCommand("/deny appr_abc")).toEqual({
      ok: true,
      command: { type: "deny", approval_id: "appr_abc" }
    });
  });

  it("rejects non-command text, unsupported commands, and missing arguments", () => {
    expect(parseTelegramCommand("hello")).toEqual({
      ok: false,
      error: { code: "TELEGRAM_COMMAND_INVALID", message: "Telegram command must start with /" }
    });
    expect(parseTelegramCommand("/teach remember this")).toEqual({
      ok: false,
      error: { code: "TELEGRAM_COMMAND_UNSUPPORTED", message: "Unsupported command: /teach" }
    });
    expect(parseTelegramCommand("/run research-brief")).toEqual({
      ok: false,
      error: { code: "TELEGRAM_COMMAND_INVALID", message: "/run requires a goal" }
    });
  });
});
```

- [ ] **Step 2: Run the parser tests and verify the expected failure**

Run:

```bash
npm test -- tests/triggers/telegram-command-parser.test.ts
```

Expected: FAIL with a module resolution error for `src/triggers/telegram-command-parser.ts`.

- [ ] **Step 3: Add the parser implementation**

Create `src/triggers/telegram-command-parser.ts`:

```ts
import type { TaskEventType } from "../domain/types.js";

export type TelegramCommand =
  | { type: "ask"; goal: string }
  | { type: "run"; program: string; goal: string }
  | { type: "status"; run_id?: string }
  | { type: "approve"; approval_id: string }
  | { type: "deny"; approval_id: string };

export type TelegramCommandParseResult =
  | { ok: true; command: TelegramCommand }
  | { ok: false; error: { code: "TELEGRAM_COMMAND_INVALID" | "TELEGRAM_COMMAND_UNSUPPORTED"; message: string } };

export function parseTelegramCommand(text: string): TelegramCommandParseResult {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return invalid("Telegram command must start with /");
  const [rawCommand, ...rest] = splitShellWords(trimmed);
  const command = rawCommand?.split("@")[0] ?? "";
  const args = rest.join(" ").trim();

  if (command === "/ask") return args ? { ok: true, command: { type: "ask", goal: args } } : invalid("/ask requires a question");
  if (command === "/run") return parseRun(rest);
  if (command === "/status") return args ? { ok: true, command: { type: "status", run_id: args } } : { ok: true, command: { type: "status" } };
  if (command === "/approve") return requiredApproval("approve", args);
  if (command === "/deny") return requiredApproval("deny", args);
  return { ok: false, error: { code: "TELEGRAM_COMMAND_UNSUPPORTED", message: `Unsupported command: ${command}` } };
}

function parseRun(words: string[]): TelegramCommandParseResult {
  const [program, ...goalWords] = words;
  const goal = goalWords.join(" ").trim();
  if (!program) return invalid("/run requires a program");
  if (!goal) return invalid("/run requires a goal");
  return { ok: true, command: { type: "run", program, goal } };
}

function requiredApproval(type: Extract<TaskEventType, "approve" | "deny">, approval_id: string): TelegramCommandParseResult {
  return approval_id ? { ok: true, command: { type, approval_id } } : invalid(`/${type} requires an approval id`);
}

function invalid(message: string): TelegramCommandParseResult {
  return { ok: false, error: { code: "TELEGRAM_COMMAND_INVALID", message } };
}

function splitShellWords(input: string): string[] {
  const matches = input.match(/"([^"]*)"|'([^']*)'|\S+/g) ?? [];
  return matches.map((part) => part.replace(/^["']|["']$/g, ""));
}
```

- [ ] **Step 4: Verify parser tests pass**

Run:

```bash
npm test -- tests/triggers/telegram-command-parser.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/triggers/telegram-command-parser.ts tests/triggers/telegram-command-parser.test.ts
git commit -m "feat: parse telegram commands deterministically"
```

## Task 2: Telegram Auth and Event Normalization

**Files:**
- Create: `src/triggers/telegram-auth.ts`
- Create: `src/triggers/telegram-trigger-adapter.ts`
- Modify: `src/domain/types.ts`
- Test: `tests/triggers/telegram-auth.test.ts`
- Test: `tests/triggers/telegram-trigger-adapter.test.ts`

- [ ] **Step 1: Write failing auth and normalization tests**

Create `tests/triggers/telegram-auth.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { authorizeTelegramUpdate } from "../../src/triggers/telegram-auth.js";

const allowlist = {
  users: [{ telegram_user_id: 111, identity_id: "paco" }],
  chats: [{ telegram_chat_id: 222, label: "paco-private", allowed_identity_ids: ["paco"] }]
};

describe("authorizeTelegramUpdate", () => {
  it("authorizes only matching user and chat", () => {
    expect(authorizeTelegramUpdate({ from_id: 111, chat_id: 222 }, allowlist)).toEqual({
      ok: true,
      identity: { kind: "user", id: "paco" }
    });
  });

  it("rejects unknown users, unknown chats, forwards, channels, and anonymous admins", () => {
    expect(authorizeTelegramUpdate({ from_id: 999, chat_id: 222 }, allowlist).ok).toBe(false);
    expect(authorizeTelegramUpdate({ from_id: 111, chat_id: 999 }, allowlist).ok).toBe(false);
    expect(authorizeTelegramUpdate({ from_id: 111, chat_id: 222, is_forwarded: true }, allowlist).ok).toBe(false);
    expect(authorizeTelegramUpdate({ from_id: 111, chat_id: 222, is_channel_post: true }, allowlist).ok).toBe(false);
    expect(authorizeTelegramUpdate({ from_id: undefined, chat_id: 222 }, allowlist).ok).toBe(false);
  });

  it("rejects a known user in a known chat when the pair is not allowlisted", () => {
    const splitAllowlist = {
      users: [{ telegram_user_id: 111, identity_id: "paco" }],
      chats: [{ telegram_chat_id: 333, label: "other-team", allowed_identity_ids: ["ada"] }]
    };

    expect(authorizeTelegramUpdate({ from_id: 111, chat_id: 333 }, splitAllowlist)).toEqual({
      ok: false,
      error: { code: "TELEGRAM_AUTH_DENIED", message: "Telegram identity is not allowlisted for this chat" }
    });
  });
});
```

Create `tests/triggers/telegram-trigger-adapter.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalizeTelegramUpdate } from "../../src/triggers/telegram-trigger-adapter.js";

const allowlist = {
  users: [{ telegram_user_id: 111, identity_id: "paco" }],
  chats: [{ telegram_chat_id: 222, label: "paco-private", allowed_identity_ids: ["paco"] }]
};

describe("normalizeTelegramUpdate", () => {
  it("normalizes /ask into a telegram TypedTaskEvent", () => {
    const result = normalizeTelegramUpdate({
      update_id: 1000,
      message: { message_id: 55, text: "/ask what is Houge?", from: { id: 111 }, chat: { id: 222 } }
    }, allowlist);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event).toMatchObject({
        source: "telegram",
        type: "ask",
        program: "ask",
        goal: "what is Houge?",
        requested_by: { kind: "user", id: "paco" },
        notify: { kind: "telegram", chat_id: "222" },
        idempotency_key: "telegram:1000:55"
      });
    }
  });

  it("normalizes /approve without creating a program", () => {
    const result = normalizeTelegramUpdate({
      update_id: 1001,
      message: { message_id: 56, text: "/approve appr_1", from: { id: 111 }, chat: { id: 222 } }
    }, allowlist);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.type).toBe("approve");
      expect(result.event.approval_id).toBe("appr_1");
      expect(result.event.program).toBeUndefined();
    }
  });
});
```

- [ ] **Step 2: Run tests and verify expected failure**

Run:

```bash
npm test -- tests/triggers/telegram-auth.test.ts tests/triggers/telegram-trigger-adapter.test.ts
```

Expected: FAIL for missing auth and adapter modules.

- [ ] **Step 3: Add auth and normalization implementation**

Modify `src/domain/types.ts`:

```ts
export interface TelegramAllowlistedUser {
  telegram_user_id: number;
  identity_id: string;
}

export interface TelegramAllowlistedChat {
  telegram_chat_id: number;
  label: string;
  allowed_identity_ids: string[];
}

export interface TelegramAllowlist {
  users: TelegramAllowlistedUser[];
  chats: TelegramAllowlistedChat[];
}
```

Create `src/triggers/telegram-auth.ts`:

```ts
import type { Identity, TelegramAllowlist } from "../domain/types.js";

export interface TelegramAuthEvidence {
  from_id?: number;
  chat_id?: number;
  is_forwarded?: boolean;
  is_channel_post?: boolean;
}

export type TelegramAuthResult =
  | { ok: true; identity: Identity }
  | { ok: false; error: { code: "TELEGRAM_AUTH_DENIED"; message: string } };

export function authorizeTelegramUpdate(evidence: TelegramAuthEvidence, allowlist: TelegramAllowlist): TelegramAuthResult {
  if (evidence.is_channel_post) return denied("Channel posts are not accepted");
  if (evidence.is_forwarded) return denied("Forwarded commands are not accepted");
  if (typeof evidence.from_id !== "number") return denied("Anonymous Telegram senders are not accepted");
  if (typeof evidence.chat_id !== "number") return denied("Telegram chat id is required");
  const user = allowlist.users.find((entry) => entry.telegram_user_id === evidence.from_id);
  if (!user) return denied("Telegram user is not allowlisted");
  const chat = allowlist.chats.find((entry) => entry.telegram_chat_id === evidence.chat_id);
  if (!chat) return denied("Telegram chat is not allowlisted");
  if (!chat.allowed_identity_ids.includes(user.identity_id)) {
    return denied("Telegram identity is not allowlisted for this chat");
  }
  return { ok: true, identity: { kind: "user", id: user.identity_id } };
}

function denied(message: string): TelegramAuthResult {
  return { ok: false, error: { code: "TELEGRAM_AUTH_DENIED", message } };
}
```

Create `src/triggers/telegram-trigger-adapter.ts` with only pure normalization in this task:

```ts
import type { TelegramAllowlist, TypedTaskEvent } from "../domain/types.js";
import { buildTypedTaskEvent } from "../domain/types.js";
import { authorizeTelegramUpdate } from "./telegram-auth.js";
import { parseTelegramCommand } from "./telegram-command-parser.js";

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    forward_date?: number;
    from?: { id: number };
    chat: { id: number };
  };
  channel_post?: unknown;
}

export type TelegramNormalizeResult =
  | { ok: true; event: TypedTaskEvent }
  | { ok: false; error: { code: string; message: string } };

export function normalizeTelegramUpdate(update: TelegramUpdate, allowlist: TelegramAllowlist): TelegramNormalizeResult {
  if (update.channel_post) return { ok: false, error: { code: "TELEGRAM_AUTH_DENIED", message: "Channel posts are not accepted" } };
  const message = update.message;
  if (!message?.text) return { ok: false, error: { code: "TELEGRAM_COMMAND_INVALID", message: "Telegram text message is required" } };

  const auth = authorizeTelegramUpdate({
    from_id: message.from?.id,
    chat_id: message.chat.id,
    is_forwarded: typeof message.forward_date === "number",
    is_channel_post: false
  }, allowlist);
  if (!auth.ok) return auth;

  const parsed = parseTelegramCommand(message.text);
  if (!parsed.ok) return parsed;

  const base = {
    source: "telegram" as const,
    requested_by: auth.identity,
    notify: { kind: "telegram" as const, chat_id: String(message.chat.id) },
    idempotency_key: `telegram:${update.update_id}:${message.message_id}`,
    source_reference: `telegram:update:${update.update_id}:message:${message.message_id}`,
    metadata: { telegram_update_id: update.update_id, telegram_message_id: message.message_id }
  };

  switch (parsed.command.type) {
    case "ask":
      return { ok: true, event: buildTypedTaskEvent({ ...base, type: "ask", program: "ask", goal: parsed.command.goal }) };
    case "run":
      return { ok: true, event: buildTypedTaskEvent({ ...base, type: "run", program: parsed.command.program, goal: parsed.command.goal }) };
    case "status":
      return { ok: true, event: buildTypedTaskEvent({ ...base, type: "status", metadata: { ...base.metadata, run_id: parsed.command.run_id } }) };
    case "approve":
    case "deny":
      return { ok: true, event: buildTypedTaskEvent({ ...base, type: parsed.command.type, approval_id: parsed.command.approval_id }) };
  }
}
```

- [ ] **Step 4: Verify auth and normalization**

Run:

```bash
npm test -- tests/triggers/telegram-auth.test.ts tests/triggers/telegram-trigger-adapter.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/types.ts src/triggers/telegram-auth.ts src/triggers/telegram-trigger-adapter.ts tests/triggers/telegram-auth.test.ts tests/triggers/telegram-trigger-adapter.test.ts
git commit -m "feat: authorize telegram updates"
```

## Task 3: Shared Status Query and CLI Status

**Files:**
- Create: `src/status/status-query.ts`
- Modify: `src/run/run-store.ts`
- Modify: `src/cli.ts`
- Test: `tests/status/status-query.test.ts`

- [ ] **Step 1: Write failing status query tests**

Create `tests/status/status-query.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";
import { queryStatus } from "../../src/status/status-query.js";

describe("queryStatus", () => {
  it("returns a single run status with ledger event count", () => {
    const store = RunStore.openInMemory();
    try {
      const intake = new Gateway(store).intake(buildTypedTaskEvent({
        source: "cli",
        type: "run",
        program: "research-brief",
        goal: "compare gateway designs",
        requested_by: { kind: "user", id: "paco" },
        notify: { kind: "local" },
        idempotency_key: "cli:status-one",
        source_reference: "argv"
      }));
      if (!intake.ok) throw new Error("expected intake");

      expect(queryStatus(store, intake.run_id)).toMatchObject({
        ok: true,
        status: { run_id: intake.run_id, state: "queued", program: "research-brief", event_count: 2 }
      });
    } finally {
      store.close();
    }
  });

  it("returns recent runs when no run id is supplied", () => {
    const store = RunStore.openInMemory();
    try {
      expect(queryStatus(store)).toEqual({ ok: true, status: { runs: [] } });
    } finally {
      store.close();
    }
  });
});
```

- [ ] **Step 2: Run tests and verify expected failure**

Run:

```bash
npm test -- tests/status/status-query.test.ts
```

Expected: FAIL because `src/status/status-query.ts` does not exist.

- [ ] **Step 3: Add RunStore projection methods and status query**

Add `RunStatusRow`, `getRunStatus(run_id)`, and `listRecentRunStatuses(limit)` to `src/run/run-store.ts`:

```ts
export interface RunStatusRow {
  run_id: string;
  source: string;
  type: string;
  program: string | null;
  goal: string | null;
  state: RunState;
  created_at: string;
  updated_at: string;
  event_count: number;
}
```

Create `src/status/status-query.ts`:

```ts
import type { RunStore, RunStatusRow } from "../run/run-store.js";

export type StatusQueryResult =
  | { ok: true; status: { run_id: string; state: string; program: string | null; goal: string | null; event_count: number } }
  | { ok: true; status: { runs: RunStatusRow[] } }
  | { ok: false; error: { code: "RUN_NOT_FOUND"; message: string } };

export function queryStatus(store: RunStore, run_id?: string): StatusQueryResult {
  if (!run_id) return { ok: true, status: { runs: store.listRecentRunStatuses(10) } };
  const row = store.getRunStatus(run_id);
  if (!row) return { ok: false, error: { code: "RUN_NOT_FOUND", message: `Run not found: ${run_id}` } };
  return {
    ok: true,
    status: {
      run_id: row.run_id,
      state: row.state,
      program: row.program,
      goal: row.goal,
      event_count: row.event_count
    }
  };
}
```

- [ ] **Step 4: Add CLI status branch**

Add to `src/cli.ts`:

```ts
} else if (command === "status") {
  const { queryStatus } = await import("./status/status-query.js");
  const store = RunStore.open("houge.sqlite");
  try {
    const result = queryStatus(store, rest[0]);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  } finally {
    store.close();
  }
```

- [ ] **Step 5: Verify status**

Run:

```bash
npm test -- tests/status/status-query.test.ts
npm run houge -- status
```

Expected: test PASS. CLI prints JSON with `"ok": true`.

- [ ] **Step 6: Commit**

```bash
git add src/status/status-query.ts src/run/run-store.ts src/cli.ts tests/status/status-query.test.ts
git commit -m "feat: add reusable run status query"
```

## Task 4: Built-In Ask Program Contract

**Files:**
- Modify: `src/contracts/task-contract.ts`
- Modify: `src/core/core-worker.ts`
- Test: `tests/contracts/task-contract.test.ts`
- Test: `tests/core/core-worker.test.ts`

- [ ] **Step 1: Add failing ask contract and worker tests**

Append to `tests/contracts/task-contract.test.ts`:

```ts
it("compiles /ask into the built-in ask program contract", () => {
  const askEvent = buildTypedTaskEvent({
    source: "telegram",
    type: "ask",
    program: "ask",
    goal: "what should Houge do next?",
    requested_by: { kind: "user", id: "paco" },
    notify: { kind: "telegram", chat_id: "222" },
    idempotency_key: "telegram:ask-contract",
    source_reference: "telegram:update:1:message:1"
  });

  const result = compileTaskContract(askEvent);

  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.contract.objective).toBe("what should Houge do next?");
    expect(result.contract.allowed_actions).toEqual(["local_file_read", "write_report"]);
    expect(result.contract.eval_hooks).toContain("milestone-2-ask-path");
  }
});
```

Append to `tests/core/core-worker.test.ts`:

```ts
it("executes /ask through run, capability, report, and ledger path", async () => {
  const root = mkdtempSync(join(tmpdir(), "houge-ask-"));
  writeFileSync(join(root, "AGENTS.md"), "Houge project rules");
  const store = RunStore.openInMemory();
  try {
    const intake = new Gateway(store).intake(buildTypedTaskEvent({
      source: "telegram",
      type: "ask",
      program: "ask",
      goal: "summarize local project rules",
      requested_by: { kind: "user", id: "paco" },
      notify: { kind: "telegram", chat_id: "222" },
      idempotency_key: "telegram:ask-path",
      source_reference: "telegram:update:2:message:2"
    }));
    if (!intake.ok) throw new Error("Expected ask intake");

    const result = await new CoreWorker(store, root).executeRun(intake.run_id, "worker-ask");

    expect(result.status).toBe("completed");
    expect(store.getRunState(intake.run_id)).toBe("completed");
    expect(store.getLedgerEvents(intake.run_id).map((event) => event.event_type)).toContain("report_written");
  } finally {
    store.close();
  }
});
```

- [ ] **Step 2: Run tests and verify expected failure**

Run:

```bash
npm test -- tests/contracts/task-contract.test.ts tests/core/core-worker.test.ts
```

Expected: FAIL with `Unsupported event type: ask`.

- [ ] **Step 3: Modify contract compiler**

In `src/contracts/task-contract.ts`, route `event.type === "ask"` to:

```ts
function compileAskContract(event: TypedTaskEvent): TaskContractResult {
  if (event.program !== "ask") return invalid(`Unknown program: ${event.program ?? "(missing)"}`);
  if (!event.goal?.trim()) return invalid("Question is required");
  const base = {
    objective: event.goal,
    budget: { time_minutes: 5, max_tool_calls: 2, max_agent_delegations: 0 },
    allowed_actions: ["local_file_read", "write_report"],
    forbidden_actions: ["coding_agent_cli", "generic_shell", "external_write", "paid"],
    output: { path: "runs/<run-id>/report.md", format: "sourced_markdown_report" as const },
    approval_gates: ["external_write", "destructive", "paid"],
    stop_condition: "concise answer report produced or budget exhausted",
    eval_hooks: ["milestone-2-ask-path"]
  };
  return { ok: true, contract: { ...base, contract_hash: stableHash(base) } };
}
```

- [ ] **Step 4: Verify ask path**

Run:

```bash
npm test -- tests/contracts/task-contract.test.ts tests/core/core-worker.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/contracts/task-contract.ts tests/contracts/task-contract.test.ts tests/core/core-worker.test.ts
git commit -m "feat: route ask through normal run path"
```

## Task 5: Durable Approval State, Security, Dedupe, and Indexes

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/run/run-store.ts`
- Create: `src/notifications/notification-types.ts`
- Test: `tests/run/run-store-approvals.test.ts`

- [ ] **Step 1: Write failing approval security, lifecycle, and consumption tests**

Create `tests/run/run-store-approvals.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent, type Identity } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";

const paco: Identity = { kind: "user", id: "paco" };
const mallory: Identity = { kind: "user", id: "mallory" };

function createRunningRun(store: RunStore, idempotency_key: string): string {
  const result = new Gateway(store).intake(buildTypedTaskEvent({
    source: "cli",
    type: "run",
    program: "research-brief",
    goal: "needs approval",
    requested_by: paco,
    notify: { kind: "local" },
    idempotency_key,
    source_reference: "argv"
  }));
  if (!result.ok) throw new Error("expected run");
  store.claimRun(result.run_id, "worker-approval", 30);
  return result.run_id;
}

function requestApproval(store: RunStore, run_id: string, overrides = {}) {
  return store.createApprovalRequest({
    run_id,
    approval_type: "capability",
    capability: "local_project_write",
    action_fingerprint: "fp_write_report_artifact",
    adapter_input_hash: "input_hash_write_report_artifact",
    adapter_input_json: JSON.stringify({ path: "runs/run_1/artifact.txt", content: "hello" }),
    action_summary: "Write runs/run_1/artifact.txt",
    side_effect_level: "local_write",
    risk_level: "medium",
    affected_resources: ["path:runs/run_1/artifact.txt"],
    requester: paco,
    expires_at: "2026-12-31T01:00:00.000Z",
    ...overrides
  });
}

describe("RunStore approvals", () => {
  it("creates one pending approval per run and action fingerprint", () => {
    const store = RunStore.openInMemory();
    try {
      const run_id = createRunningRun(store, "cli:approval-create");
      const first = requestApproval(store, run_id);
      const second = requestApproval(store, run_id);

      expect(first.approval_id).toMatch(/^appr_/);
      expect(second.approval_id).toBe(first.approval_id);
      expect(store.getRunState(run_id)).toBe("waiting_for_approval");
      expect(store.getRunLease(run_id)).toEqual({ worker_id: null, lease_expires_at: null });
    } finally {
      store.close();
    }
  });

  it("rejects wrong requester, expired approval, missing stored fingerprint, and wrong run state", () => {
    const store = RunStore.openInMemory();
    try {
      const requesterRun = createRunningRun(store, "cli:approval-wrong-requester");
      const requesterApproval = requestApproval(store, requesterRun);
      expect(store.resolveApproval({
        approval_id: requesterApproval.approval_id,
        decision: "approved",
        requester: mallory,
        resolved_at: "2026-05-28T00:10:00.000Z"
      })).toEqual({ ok: false, error: { code: "APPROVAL_REQUESTER_MISMATCH", message: "Approval requester does not match" } });

      const expiredRun = createRunningRun(store, "cli:approval-expired");
      const expiredApproval = requestApproval(store, expiredRun, { expires_at: "2026-05-28T00:00:00.000Z" });
      expect(store.resolveApproval({
        approval_id: expiredApproval.approval_id,
        decision: "approved",
        requester: paco,
        resolved_at: "2026-05-28T00:10:00.000Z"
      })).toEqual({ ok: false, error: { code: "APPROVAL_EXPIRED", message: "Approval has expired" } });

      const missingFingerprintRun = createRunningRun(store, "cli:approval-missing-fingerprint");
      const missingFingerprintApproval = requestApproval(store, missingFingerprintRun, { action_fingerprint: "" });
      expect(store.resolveApproval({
        approval_id: missingFingerprintApproval.approval_id,
        decision: "approved",
        requester: paco,
        resolved_at: "2026-05-28T00:10:00.000Z"
      })).toEqual({ ok: false, error: { code: "APPROVAL_ACTION_MISSING", message: "Approval action fingerprint is missing" } });

      const wrongStateRun = createRunningRun(store, "cli:approval-wrong-state");
      const wrongStateApproval = requestApproval(store, wrongStateRun);
      store.transition(wrongStateRun, "waiting_for_approval", "cancelled", "test_terminal_state");
      expect(store.resolveApproval({
        approval_id: wrongStateApproval.approval_id,
        decision: "approved",
        requester: paco,
        resolved_at: "2026-05-28T00:10:00.000Z"
      })).toEqual({ ok: false, error: { code: "RUN_NOT_WAITING_FOR_APPROVAL", message: "Run is not waiting for approval" } });
    } finally {
      store.close();
    }
  });

  it("approves, denies, and rejects replay", () => {
    const store = RunStore.openInMemory();
    try {
      const approveRun = createRunningRun(store, "cli:approval-approve");
      const approval = requestApproval(store, approveRun);
      const approved = store.resolveApproval({
        approval_id: approval.approval_id,
        decision: "approved",
        requester: paco,
        resolved_at: "2026-05-28T00:10:00.000Z"
      });
      expect(approved).toEqual({ ok: true, run_id: approveRun, status: "approval_resolved" });
      expect(store.getRunState(approveRun)).toBe("queued");
      expect(store.resolveApproval({
        approval_id: approval.approval_id,
        decision: "approved",
        requester: paco,
        resolved_at: "2026-05-28T00:11:00.000Z"
      })).toEqual({ ok: false, error: { code: "APPROVAL_NOT_PENDING", message: "Approval is not pending" } });

      const denyRun = createRunningRun(store, "cli:approval-deny");
      const denied = requestApproval(store, denyRun);
      expect(store.resolveApproval({
        approval_id: denied.approval_id,
        decision: "denied",
        requester: paco,
        resolved_at: "2026-05-28T00:12:00.000Z"
      })).toEqual({ ok: true, run_id: denyRun, status: "approval_resolved" });
      expect(store.getRunState(denyRun)).toBe("cancelled");
    } finally {
      store.close();
    }
  });

  it("consumes an approved approval once and binds tool call evidence", () => {
    const store = RunStore.openInMemory();
    try {
      const run_id = createRunningRun(store, "cli:approval-consume");
      const approval = requestApproval(store, run_id);
      store.resolveApproval({
        approval_id: approval.approval_id,
        decision: "approved",
        requester: paco,
        resolved_at: "2026-05-28T00:10:00.000Z"
      });
      store.claimRun(run_id, "worker-consume", 30);

      expect(store.consumeApprovedApproval({
        run_id,
        approval_id: approval.approval_id,
        requester: paco,
        capability: "local_project_write",
        adapter_input_hash: "input_hash_write_report_artifact",
        action_fingerprint: "fp_write_report_artifact",
        tool_call_id: "tool_1",
        operation_id: "op_1"
      })).toEqual({ ok: true, approval_id: approval.approval_id, state: "consumed" });
      expect(store.consumeApprovedApproval({
        run_id,
        approval_id: approval.approval_id,
        requester: paco,
        capability: "local_project_write",
        adapter_input_hash: "input_hash_write_report_artifact",
        action_fingerprint: "fp_write_report_artifact",
        tool_call_id: "tool_2",
        operation_id: "op_2"
      })).toEqual({ ok: false, error: { code: "APPROVAL_NOT_APPROVED", message: "Approval is not approved" } });
    } finally {
      store.close();
    }
  });

  it("rejects approved approval consumption when run, requester, capability, hash, fingerprint, or run state drift", () => {
    const store = RunStore.openInMemory();
    try {
      const run_id = createRunningRun(store, "cli:approval-consume-drift");
      const approval = requestApproval(store, run_id);
      store.resolveApproval({
        approval_id: approval.approval_id,
        decision: "approved",
        requester: paco,
        resolved_at: "2026-05-28T00:10:00.000Z"
      });
      store.claimRun(run_id, "worker-consume-drift", 30);

      const base = {
        run_id,
        approval_id: approval.approval_id,
        requester: paco,
        capability: "local_project_write",
        adapter_input_hash: "input_hash_write_report_artifact",
        action_fingerprint: "fp_write_report_artifact",
        tool_call_id: "tool_1",
        operation_id: "op_1",
        consumed_at: "2026-05-28T00:20:00.000Z"
      };

      expect(store.consumeApprovedApproval({ ...base, capability: "other_capability" })).toEqual({
        ok: false,
        error: { code: "APPROVAL_CAPABILITY_MISMATCH", message: "Approval capability does not match" }
      });
      expect(store.consumeApprovedApproval({ ...base, run_id: "run_other" })).toEqual({
        ok: false,
        error: { code: "APPROVAL_RUN_MISMATCH", message: "Approval run does not match" }
      });
      expect(store.consumeApprovedApproval({ ...base, requester: mallory })).toEqual({
        ok: false,
        error: { code: "APPROVAL_REQUESTER_MISMATCH", message: "Approval requester does not match" }
      });
      expect(store.consumeApprovedApproval({ ...base, adapter_input_hash: "other_hash" })).toEqual({
        ok: false,
        error: { code: "APPROVAL_INPUT_MISMATCH", message: "Approval adapter input hash does not match" }
      });
      expect(store.consumeApprovedApproval({ ...base, action_fingerprint: "fp_other" })).toEqual({
        ok: false,
        error: { code: "APPROVAL_ACTION_MISMATCH", message: "Approval action fingerprint does not match" }
      });
      store.transition(run_id, "running", "cancelled", "test_terminal_state");
      expect(store.consumeApprovedApproval(base)).toEqual({
        ok: false,
        error: { code: "RUN_NOT_RUNNING", message: "Run is not running" }
      });
    } finally {
      store.close();
    }
  });

  it("expires pending approvals, transitions waiting runs, and rejects late approval", () => {
    const store = RunStore.openInMemory();
    try {
      const run_id = createRunningRun(store, "cli:approval-expire-pending");
      const approval = requestApproval(store, run_id, { expires_at: "2026-05-28T00:00:00.000Z" });

      expect(store.expirePendingApprovals("2026-05-28T00:10:00.000Z")).toEqual([approval.approval_id]);
      expect(store.getRunState(run_id)).toBe("cancelled");
      expect(store.resolveApproval({
        approval_id: approval.approval_id,
        decision: "approved",
        requester: paco,
        resolved_at: "2026-05-28T00:11:00.000Z"
      })).toEqual({ ok: false, error: { code: "APPROVAL_NOT_PENDING", message: "Approval is not pending" } });
    } finally {
      store.close();
    }
  });
});
```

- [ ] **Step 2: Run approval tests and verify expected failure**

Run:

```bash
npm test -- tests/run/run-store-approvals.test.ts
```

Expected: FAIL because approval security and consumption methods do not exist.

- [ ] **Step 3: Add approval and processed trigger types**

Add to `src/run/run-store.ts`:

```ts
export interface ApprovalRequestInput {
  run_id: string;
  approval_type: "capability" | "learning";
  capability: string;
  action_fingerprint: string;
  adapter_input_hash: string;
  adapter_input_json: string;
  action_summary: string;
  side_effect_level: SideEffectLevel;
  risk_level: RiskLevel;
  affected_resources: string[];
  requester: Identity;
  expires_at: string;
}

export interface ApprovalRequestRecord extends ApprovalRequestInput {
  approval_id: string;
  state: ApprovalState;
}

export type TriggerDedupeResult =
  | { status: "new" }
  | { status: "duplicate"; result_json: string }
  | { status: "conflict"; error: "TRIGGER_IDEMPOTENCY_CONFLICT" };

export interface ApprovalTriggerInput {
  event: TypedTaskEvent;
  decision: "approved" | "denied";
  resolved_at: string;
}
```

Create `src/notifications/notification-types.ts` in this task because approval resolution and expiry enqueue notifications atomically before the dispatcher exists:

```ts
export type NotificationIntentType = "progress" | "final_report" | "approval_prompt" | "approval_resolved";

export interface NotificationIntent {
  target: NotificationTarget;
  intent_type: NotificationIntentType;
  idempotency_key: string;
  run_id?: string;
  approval_id?: string;
  correlation_id: string;
  payload: { text: string; [key: string]: unknown };
}
```

- [ ] **Step 4: Add migration tables and indexes**

Add a versioned Milestone-2 migration to `RunStore.migrate()`. Apply the full DDL inside one transaction, insert `schema_migrations.version = '2026-05-28-milestone-2-telegram-approvals'` only after all DDL succeeds, and skip the migration if that version already exists. Validation after migration must assert required tables and indexes exist.

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS processed_triggers (
  source TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (source, idempotency_key)
);

CREATE TABLE IF NOT EXISTS approvals (
  approval_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  approval_type TEXT NOT NULL,
  state TEXT NOT NULL,
  capability TEXT NOT NULL,
  action_fingerprint TEXT NOT NULL,
  adapter_input_hash TEXT NOT NULL,
  adapter_input_json TEXT NOT NULL,
  action_summary TEXT NOT NULL,
  side_effect_level TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  affected_resources_json TEXT NOT NULL,
  requester_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_tool_call_id TEXT,
  consumed_operation_id TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS approvals_one_pending_action
ON approvals(run_id, action_fingerprint)
WHERE state = 'pending';

CREATE INDEX IF NOT EXISTS ledger_events_run_sequence_idx
ON ledger_events(run_id, sequence);

CREATE INDEX IF NOT EXISTS runs_created_at_idx
ON runs(created_at);

CREATE INDEX IF NOT EXISTS runs_updated_at_idx
ON runs(updated_at);

CREATE INDEX IF NOT EXISTS approvals_run_state_idx
ON approvals(run_id, state);

CREATE TABLE IF NOT EXISTS notification_outbox (
  notification_id TEXT PRIMARY KEY,
  target_json TEXT NOT NULL,
  target_key TEXT NOT NULL,
  intent_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  state TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  provider_message_id TEXT,
  run_id TEXT,
  approval_id TEXT,
  correlation_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(target_key, idempotency_key)
);

CREATE INDEX IF NOT EXISTS notification_outbox_claim_idx
ON notification_outbox(state, next_attempt_at, created_at);

CREATE TABLE IF NOT EXISTS trigger_offsets (
  source TEXT PRIMARY KEY,
  offset INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skipped_telegram_updates (
  update_id INTEGER PRIMARY KEY,
  reason_code TEXT NOT NULL,
  reason_message TEXT NOT NULL,
  skipped_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_command_audit (
  audit_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  command TEXT NOT NULL,
  source_reference TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason_code TEXT,
  occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS telegram_command_audit_actor_chat_time_idx
ON telegram_command_audit(actor_id, chat_id, occurred_at);

CREATE INDEX IF NOT EXISTS telegram_command_audit_decision_time_idx
ON telegram_command_audit(decision, occurred_at);
```

Add a compatibility test that creates a pre-Milestone-2 database with the actual Milestone-1 `runs` and `ledger_events` tables, opens it through `RunStore.open(path)`, runs migration, verifies existing `runs` and `ledger_events` rows are still readable, verifies the new tables/indexes exist, and verifies a second open does not reapply the migration. Before applying the migration to a real file path, document that the operator should snapshot `houge.sqlite`; in automated tests, use a temp DB copy.

- [ ] **Step 5: Add processed-trigger and skipped-update methods**

Add to `RunStore`:

```ts
beginTriggerProcessing(event: TypedTaskEvent): TriggerDedupeResult {
  const existing = this.db.prepare(`
    SELECT payload_hash, result_json FROM processed_triggers
    WHERE source = ? AND idempotency_key = ?
  `).get<{ payload_hash: string; result_json: string }>(event.source, event.idempotency_key);
  if (!existing) return { status: "new" };
  if (existing.payload_hash !== event.payload_hash) {
    return { status: "conflict", error: "TRIGGER_IDEMPOTENCY_CONFLICT" };
  }
  return { status: "duplicate", result_json: existing.result_json };
}

recordTriggerProcessed(event: TypedTaskEvent, result: unknown): void {
  this.db.prepare(`
    INSERT INTO processed_triggers (source, idempotency_key, payload_hash, result_json, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(source, idempotency_key) DO UPDATE SET result_json = excluded.result_json
    WHERE processed_triggers.payload_hash = excluded.payload_hash
  `).run(event.source, event.idempotency_key, event.payload_hash, JSON.stringify(result), new Date().toISOString());
}

recordSkippedTelegramUpdate(input: {
  update_id: number;
  reason_code: string;
  reason_message: string;
  skipped_at: string;
}): void {
  this.db.prepare(`
    INSERT OR IGNORE INTO skipped_telegram_updates
      (update_id, reason_code, reason_message, skipped_at)
    VALUES (?, ?, ?, ?)
  `).run(input.update_id, input.reason_code, input.reason_message, input.skipped_at);
}
```

- [ ] **Step 6: Add approval methods**

Add `createApprovalRequest`, `resolveApproval`, `processApprovalTrigger`, `expirePendingApprovals`, `enqueueNotification`, and `consumeApprovedApproval` to `RunStore`.

Split approval resolution into a public `resolveApproval(...)` wrapper and an internal `resolveApprovalWithinTransaction(...)` helper:

- `resolveApproval(...)` is for direct store tests and starts `BEGIN IMMEDIATE`, calls `resolveApprovalWithinTransaction(...)`, then commits.
- `resolveApprovalWithinTransaction(...)` assumes the caller already holds the transaction. It selects the approval row, validates requester, expiry while `state = 'pending'`, stored non-empty `action_fingerprint`, and run state before update. It never starts or commits a transaction.

`processApprovalTrigger({ event, decision, resolved_at })` must be the Gateway-facing method for `/approve` and `/deny`. In one `BEGIN IMMEDIATE` transaction it must:

- Check `processed_triggers` replay/conflict for `event.source`, `event.idempotency_key`, and `event.payload_hash`.
- Call `resolveApprovalWithinTransaction(...)` for `event.approval_id` and `event.requested_by`.
- Transition approval/run state.
- Append an `approval_resolved` ledger event.
- Queue an `approval_resolved` notification with `run_id`, `approval_id`, and `correlation_id`.
- Insert the processed trigger result JSON before commit.

`enqueueNotification` in Task 5 is intentionally minimal: insert/dedupe notification rows and return the record. Dispatcher claim/retry/delivery behavior remains Task 7. On enqueue conflict, compare `payload_hash`, `run_id`, `approval_id`, and `correlation_id`; return the existing row only on exact match, otherwise return `NOTIFICATION_IDEMPOTENCY_CONFLICT`.

`consumeApprovedApproval` must start with `BEGIN IMMEDIATE`, validate `approved` state, requester, `run_id`, current run state `running`, `capability`, `adapter_input_hash`, and `action_fingerprint`, then set `state='consumed'`, `consumed_tool_call_id`, and `consumed_operation_id`. Approval `expires_at` is a deadline for the requester to approve/deny while pending; once an approval is `approved`, consumption is governed by exact-action revalidation and run state, not wall-clock expiry.

`expirePendingApprovals(now)` must mark expired pending approvals as `expired`, transition their `waiting_for_approval` runs to `cancelled`, append ledger events, and queue user-visible notifications.

Use these return values exactly:

```ts
{ ok: false, error: { code: "APPROVAL_NOT_FOUND", message: "Approval not found" } }
{ ok: false, error: { code: "APPROVAL_NOT_PENDING", message: "Approval is not pending" } }
{ ok: false, error: { code: "APPROVAL_NOT_APPROVED", message: "Approval is not approved" } }
{ ok: false, error: { code: "APPROVAL_REQUESTER_MISMATCH", message: "Approval requester does not match" } }
{ ok: false, error: { code: "APPROVAL_EXPIRED", message: "Approval has expired" } }
{ ok: false, error: { code: "APPROVAL_ACTION_MISSING", message: "Approval action fingerprint is missing" } }
{ ok: false, error: { code: "APPROVAL_ACTION_MISMATCH", message: "Approval action fingerprint does not match" } }
{ ok: false, error: { code: "APPROVAL_CAPABILITY_MISMATCH", message: "Approval capability does not match" } }
{ ok: false, error: { code: "APPROVAL_INPUT_MISMATCH", message: "Approval adapter input hash does not match" } }
{ ok: false, error: { code: "APPROVAL_RUN_MISMATCH", message: "Approval run does not match" } }
{ ok: false, error: { code: "RUN_NOT_WAITING_FOR_APPROVAL", message: "Run is not waiting for approval" } }
{ ok: false, error: { code: "RUN_NOT_RUNNING", message: "Run is not running" } }
```

- [ ] **Step 7: Verify approval storage**

Run:

```bash
npm test -- tests/run/run-store-approvals.test.ts
```

Expected: PASS.

- [ ] **Step 8: Run live local validation, not smoke**

Run a real Houge local run after the Task 5 schema and approval-store changes are in place. This is intentionally not a parser/outbox smoke command; it verifies the existing local run path still works against the migrated store.

```bash
npm run houge -- run research-brief "task 5 live validation approval store"
npm run houge -- status
```

Expected: the `run research-brief` command creates and completes a real run, writes a report under `runs/`, and exits 0. `houge status` exits 0 and shows the latest run in the local store. If either command fails, fix the regression before review.

- [ ] **Step 9: Request code review before commit and push**

Use `superpowers:requesting-code-review` before committing Task 5. Because the review is intentionally before commit, give the reviewer the uncommitted diff instead of a `HEAD_SHA`.

Reviewer context:

```text
DESCRIPTION: Task 5 durable approval state, processed triggers, minimal notification schema, migration compatibility, skipped Telegram updates, and rate-limit/audit storage.
PLAN_OR_REQUIREMENTS: Task 5 from docs/superpowers/plans/2026-05-28-houge-milestone-2-telegram-gateway-approvals.md
BASE_SHA: $(git rev-parse HEAD)
HEAD_SHA: uncommitted working tree
DIFF: git diff -- src/domain/types.ts src/run/run-store.ts src/notifications/notification-types.ts tests/run/run-store-approvals.test.ts
VERIFICATION:
- npm test -- tests/run/run-store-approvals.test.ts
- npm run houge -- run research-brief "task 5 live validation approval store"
- npm run houge -- status
```

Fix all Critical and Important review findings before proceeding. Rerun the Task 5 tests and live validation after fixes.

- [ ] **Step 10: Commit and push after review passes**

```bash
git add src/domain/types.ts src/run/run-store.ts src/notifications/notification-types.ts tests/run/run-store-approvals.test.ts
git commit -m "feat: harden approval state"
git push -u origin HEAD
```

## Task 6: CapabilityRunner Revalidation and CoreWorker Approval Resume

**Files:**
- Modify: `src/capabilities/capability-runner.ts`
- Create: `src/capabilities/local-project-write-adapter.ts`
- Modify: `src/core/core-worker.ts`
- Modify: `src/run/run-store.ts`
- Test: `tests/capabilities/capability-runner-approvals.test.ts`
- Test: `tests/core/core-worker-approvals.test.ts`

- [ ] **Step 1: Write failing CapabilityRunner tests**

Create `tests/capabilities/capability-runner-approvals.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { BudgetLedger } from "../../src/budget/budget-ledger.js";
import { CapabilityRunner } from "../../src/capabilities/capability-runner.js";
import type { CompiledTaskContract } from "../../src/domain/types.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";

const contract: CompiledTaskContract = {
  objective: "execute gated local write",
  budget: { time_minutes: 5, max_tool_calls: 2, max_agent_delegations: 0 },
  allowed_actions: ["local_project_write"],
  forbidden_actions: ["coding_agent_cli"],
  output: { path: "runs/<run-id>/report.md", format: "sourced_markdown_report" },
  approval_gates: ["local_write"],
  stop_condition: "gated action handled",
  contract_hash: "contract_hash",
  eval_hooks: ["milestone-2-approval"]
};

function registry() {
  const registry = new ToolRegistry();
  registry.register({
    name: "local_project_write",
    category: "tool",
    side_effect_level: "local_write",
    risk_level: "medium",
    timeout_ms: 1000,
    output_limit_bytes: 1000,
    execute: async () => ({ ok: true, output: { wrote: true } })
  });
  return registry;
}

describe("CapabilityRunner approval lifecycle", () => {
  it("requests approval before gated adapter execution", async () => {
    const requested: unknown[] = [];
    const runner = new CapabilityRunner(registry(), {
      requestApproval: (input) => {
        requested.push(input);
        return { approval_id: "appr_capability" };
      },
      consumeApprovedApproval: () => {
        throw new Error("must not consume before approval");
      }
    });

    await expect(runner.execute({
      run_id: "run_approval",
      requester: { kind: "user", id: "paco" },
      contract,
      capability: "local_project_write",
      input: { path: "runs/run_approval/artifact.txt", content: "hello" },
      budget: new BudgetLedger(contract.budget)
    })).resolves.toEqual({ status: "requires_approval", approval_id: "appr_capability" });
    expect(requested).toEqual([expect.objectContaining({
      capability: "local_project_write",
      adapter_input_hash: expect.any(String),
      adapter_input_json: JSON.stringify({ path: "runs/run_approval/artifact.txt", content: "hello" }),
      action_fingerprint: expect.any(String)
    })]);
  });

  it("re-runs policy, consumes approval, and executes the exact approved action", async () => {
    const consumed: unknown[] = [];
    const runner = new CapabilityRunner(registry(), {
      requestApproval: () => ({ approval_id: "appr_new" }),
      consumeApprovedApproval: (input) => {
        consumed.push(input);
        return { ok: true, approval_id: "appr_existing", state: "consumed" };
      }
    });

    const result = await runner.execute({
      run_id: "run_approval",
      requester: { kind: "user", id: "paco" },
      approved_approval_id: "appr_existing",
      contract,
      capability: "local_project_write",
      input: { path: "runs/run_approval/artifact.txt", content: "hello" },
      budget: new BudgetLedger(contract.budget)
    });

    expect(result.status).toBe("succeeded");
    expect(consumed).toEqual([expect.objectContaining({
      capability: "local_project_write",
      adapter_input_hash: expect.any(String),
      action_fingerprint: expect.any(String)
    })]);
  });

  it("returns denied_on_revalidation when policy changes after approval", async () => {
    const deniedContract = { ...contract, forbidden_actions: ["local_project_write"] };
    const runner = new CapabilityRunner(registry(), {
      requestApproval: () => ({ approval_id: "appr_new" }),
      consumeApprovedApproval: () => {
        throw new Error("must not consume when revalidation fails");
      }
    });

    await expect(runner.execute({
      run_id: "run_approval",
      requester: { kind: "user", id: "paco" },
      approved_approval_id: "appr_existing",
      contract: deniedContract,
      capability: "local_project_write",
      input: { path: "runs/run_approval/artifact.txt", content: "hello" },
      budget: new BudgetLedger(contract.budget)
    })).resolves.toMatchObject({
      status: "denied_on_revalidation",
      reason: "Capability forbidden by task contract"
    });
  });
});
```

- [ ] **Step 2: Write failing CoreWorker approval tests**

Create `tests/core/core-worker-approvals.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CoreWorker } from "../../src/core/core-worker.js";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";

describe("CoreWorker approvals", () => {
  it("parks as waiting_for_approval instead of failing", async () => {
    const root = mkdtempSync(join(tmpdir(), "houge-approval-park-"));
    writeFileSync(join(root, "AGENTS.md"), "Rules");
    const store = RunStore.openInMemory();
    try {
      const intake = new Gateway(store).intake(buildTypedTaskEvent({
        source: "cli",
        type: "run",
        program: "research-brief",
        goal: "force approval fixture",
        requested_by: { kind: "user", id: "paco" },
        notify: { kind: "local" },
        idempotency_key: "cli:worker-park",
        source_reference: "argv",
        metadata: { force_gated_capability: true }
      }));
      if (!intake.ok) throw new Error("expected intake");

      const result = await new CoreWorker(store, root).executeRun(intake.run_id, "worker-approval");

      expect(result).toEqual({ status: "waiting_for_approval", run_id: intake.run_id, approval_id: expect.stringMatching(/^appr_/) });
      expect(store.getRunState(intake.run_id)).toBe("waiting_for_approval");
    } finally {
      store.close();
    }
  });

  it("resumes after approval and executes the gated action once", async () => {
    const root = mkdtempSync(join(tmpdir(), "houge-approval-resume-"));
    writeFileSync(join(root, "AGENTS.md"), "Rules");
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      const intake = gateway.intake(buildTypedTaskEvent({
        source: "cli",
        type: "run",
        program: "research-brief",
        goal: "force approval fixture",
        requested_by: { kind: "user", id: "paco" },
        notify: { kind: "local" },
        idempotency_key: "cli:worker-resume",
        source_reference: "argv",
        metadata: { force_gated_capability: true }
      }));
      if (!intake.ok) throw new Error("expected intake");

      const parked = await new CoreWorker(store, root).executeRun(intake.run_id, "worker-approval");
      if (parked.status !== "waiting_for_approval") throw new Error("expected approval wait");
      const pending = store.getApprovalForRun(intake.run_id, "pending");
      if (!pending) throw new Error("expected pending approval");

      store.processApprovalTrigger({
        event: buildTypedTaskEvent({
        source: "telegram",
        type: "approve",
        approval_id: pending.approval_id,
        requested_by: { kind: "user", id: "paco" },
        notify: { kind: "telegram", chat_id: "222" },
        idempotency_key: "telegram:worker-resume-approve",
        source_reference: "telegram:update:20:message:1"
        }),
        decision: "approved",
        resolved_at: "2026-05-28T00:10:00.000Z"
      });

      const completed = await new CoreWorker(store, root).executeRun(intake.run_id, "worker-approval");

      expect(completed.status).toBe("completed");
      expect(store.getLedgerEvents(intake.run_id).map((event) => event.event_type)).toContain("tool_finished");
    } finally {
      store.close();
    }
  });
});
```

- [ ] **Step 3: Run tests and verify expected failures**

Run:

```bash
npm test -- tests/capabilities/capability-runner-approvals.test.ts tests/core/core-worker-approvals.test.ts
```

Expected: FAIL because CapabilityRunner cannot consume approvals and CoreWorker still treats approval as failure.

- [ ] **Step 4: Add CapabilityRunner approval interfaces and behavior**

Modify `src/capabilities/capability-runner.ts` to add:

```ts
export interface ApprovalRequestSink {
  requestApproval(input: ApprovalRequestInput): { approval_id: string };
  consumeApprovedApproval(input: {
    run_id: string;
    approval_id: string;
    requester: Identity;
    capability: string;
    adapter_input_hash: string;
    action_fingerprint: string;
    tool_call_id: string;
    operation_id: string;
    consumed_at: string;
  }): { ok: true; approval_id: string; state: "consumed" } | { ok: false; error: { code: string; message: string } };
}

export interface CapabilityExecutionInput {
  run_id?: string;
  requester?: Identity;
  approved_approval_id?: string;
  contract: CompiledTaskContract;
  capability: string;
  input: Record<string, unknown>;
  budget: BudgetLedger;
}
```

Compute `adapter_input_hash = stableHash(input.input)` and:

- Update `CompiledTaskContract.approval_gates` to `SideEffectLevel[]` and update `CapabilityDecisionInput` to include `approval_gates`. `decideCapability()` must treat `approval_gates` as side-effect-level gates. A capability whose `side_effect_level` is included in `approval_gates` returns `requires_approval`, including `local_write`; the older hard-coded `external_write`/`destructive`/`paid` list is not sufficient.
- Compute `adapter_input_json = canonicalJson(input.input)` using the same deterministic serializer as `stableHash`, and use that JSON as the durable resume source. Add a test asserting `adapter_input_hash === stableHash(JSON.parse(adapter_input_json))`.
- Compute `action_fingerprint = stableHash({ capability, side_effect_level, risk_level, affected_resources: [...affected_resources].sort(), adapter_input_hash })`. Add tests proving changing any one of `capability`, `side_effect_level`, `risk_level`, `affected_resources`, or `adapter_input_hash` changes the fingerprint.
- If policy returns `requires_approval` and `approved_approval_id` is absent, call `requestApproval()` with `capability`, `adapter_input_hash`, `adapter_input_json`, and `action_fingerprint`, then return `{ status: "requires_approval", approval_id }`.
- If `approved_approval_id` is present, call `decideCapability()` again. If decision is `deny`, return `denied_on_revalidation`. If decision is `allow` or `requires_approval`, call `consumeApprovedApproval()` before adapter execution.
- Use `tool_${randomUUID()}` and `op_${randomUUID()}` as the binding ids passed into `consumeApprovedApproval()` together with `capability`, `adapter_input_hash`, `action_fingerprint`, and `consumed_at`.

- [ ] **Step 5: Update CoreWorker result and resume logic**

Extend `CoreWorkerResult`:

```ts
| { status: "waiting_for_approval"; run_id: string; approval_id: string; report_path?: never; error?: never }
```

When CapabilityRunner returns `requires_approval`, return:

```ts
return { status: "waiting_for_approval", run_id: claim.run_id, approval_id: result.approval_id };
```

Add read-only `RunStore.getApprovalForRun(run_id, state)`, `RunStore.getRunRequester(run_id)`, and `RunStore.getApprovedActionForRun(run_id)` projections. `getApprovedActionForRun(run_id)` returns `{ approval_id, capability, adapter_input_json, adapter_input_hash, action_fingerprint, requester }`. On resume, CoreWorker must parse only stored `adapter_input_json`, recompute hash/fingerprint, and fail the run with a reconciliation ledger event without consuming if JSON parsing or hash/fingerprint validation fails.

Create `src/capabilities/local-project-write-adapter.ts` and register it in CoreWorker for the forced approval fixture. It accepts `{ path, content }`, rejects paths outside the project root, writes only beneath `runs/<run-id>/`, and returns `{ wrote: true, path }`. Do not expose Telegram sending as a selectable capability.

Add a CoreWorker test where a live/generated input source changes after approval; resume still executes the stored approved `adapter_input_json`.

- [ ] **Step 6: Verify approval parking and resume**

Run:

```bash
npm test -- tests/capabilities/capability-runner-approvals.test.ts tests/core/core-worker-approvals.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/capabilities/capability-runner.ts src/core/core-worker.ts src/run/run-store.ts tests/capabilities/capability-runner-approvals.test.ts tests/core/core-worker-approvals.test.ts
git commit -m "feat: resume approved capability runs"
```

## Task 7: Notification Outbox, Dispatcher, Retry, and Failure Recovery

**Files:**
- Modify: `src/notifications/notification-types.ts`
- Create: `src/notifications/notification-outbox.ts`
- Create: `src/notifications/notification-dispatcher.ts`
- Create: `src/notifications/local-notification-adapter.ts`
- Create: `src/notifications/telegram-notification-adapter.ts`
- Create: `src/telegram/telegram-client.ts`
- Modify: `src/domain/types.ts`
- Modify: `src/run/run-store.ts`
- Modify: `src/cli.ts`
- Test: `tests/notifications/notification-outbox.test.ts`
- Test: `tests/notifications/telegram-notification-adapter.test.ts`
- Test: `tests/notifications/notification-dispatcher.test.ts`

- [ ] **Step 1: Write failing outbox and dispatcher tests**

Create `tests/notifications/notification-outbox.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { NotificationOutbox } from "../../src/notifications/notification-outbox.js";
import { RunStore } from "../../src/run/run-store.js";

describe("NotificationOutbox", () => {
  it("deduplicates by target and idempotency key and marks delivery", () => {
    const store = RunStore.openInMemory();
    try {
      const outbox = new NotificationOutbox(store);
      const first = outbox.enqueue({
        target: { kind: "telegram", chat_id: "222" },
        intent_type: "progress",
        idempotency_key: "run_1:progress:queued",
        run_id: "run_1",
        correlation_id: "telegram:update:1",
        payload: { text: "Queued run_1" }
      });
      const second = outbox.enqueue({
        target: { kind: "telegram", chat_id: "222" },
        intent_type: "progress",
        idempotency_key: "run_1:progress:queued",
        run_id: "run_1",
        correlation_id: "telegram:update:1",
        payload: { text: "Queued run_1" }
      });
      expect(second.notification_id).toBe(first.notification_id);
      expect(outbox.claimNext("sender-1", 30)?.notification_id).toBe(first.notification_id);
      outbox.markDelivered(first.notification_id, "telegram:1");
      expect(outbox.get(first.notification_id)?.state).toBe("delivered");
    } finally {
      store.close();
    }
  });

  it("handles retry_wait recovery, terminal failure, and stale sending lease recovery", () => {
    const store = RunStore.openInMemory();
    try {
      const outbox = new NotificationOutbox(store);
      const retry = outbox.enqueue({
        target: { kind: "telegram", chat_id: "222" },
        intent_type: "approval_prompt",
        idempotency_key: "appr_1:prompt",
        run_id: "run_1",
        approval_id: "appr_1",
        correlation_id: "appr_1",
        payload: { text: "Approval required", expires_at: "2026-12-31T01:00:00.000Z" }
      });
      outbox.claimNext("sender-1", 30);
      outbox.markFailed(retry.notification_id, "network down", true, "2026-05-28T00:00:10.000Z", 3);
      expect(outbox.get(retry.notification_id)?.state).toBe("retry_wait");
      expect(store.requeueRetryWaitNotifications("2026-05-28T00:00:11.000Z")).toEqual([retry.notification_id]);

      outbox.claimNext("sender-2", 30);
      outbox.markFailed(retry.notification_id, "bad request", false, "2026-05-28T00:00:12.000Z", 3);
      expect(outbox.get(retry.notification_id)?.state).toBe("failed_terminal");

      const stale = outbox.enqueue({
        target: { kind: "local" },
        intent_type: "progress",
        idempotency_key: "run_1:stale",
        run_id: "run_1",
        correlation_id: "run_1:stale",
        payload: { text: "stale lease" }
      });
      outbox.claimNext("sender-stale", -1);
      expect(store.recoverStaleSendingNotifications("2026-05-28T00:00:20.000Z")).toEqual([stale.notification_id]);
      expect(outbox.get(stale.notification_id)?.state).toBe("queued");
    } finally {
      store.close();
    }
  });

  it("only one sender can claim a queued notification", () => {
    const store = RunStore.openInMemory();
    try {
      const outbox = new NotificationOutbox(store);
      const queued = outbox.enqueue({
        target: { kind: "telegram", chat_id: "222" },
        intent_type: "progress",
        idempotency_key: "run_1:double-claim",
        run_id: "run_1",
        correlation_id: "run_1:double-claim",
        payload: { text: "Queued" }
      });

      expect(outbox.claimNext("sender-a", 30)?.notification_id).toBe(queued.notification_id);
      expect(outbox.claimNext("sender-b", 30)).toBeNull();
    } finally {
      store.close();
    }
  });
});
```

Create `tests/notifications/telegram-notification-adapter.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { TelegramNotificationAdapter } from "../../src/notifications/telegram-notification-adapter.js";

describe("TelegramNotificationAdapter", () => {
  it("sends telegram notification text through the client boundary", async () => {
    const sent: unknown[] = [];
    const adapter = new TelegramNotificationAdapter({
      sendMessage: async (input) => {
        sent.push(input);
        return { message_id: 88 };
      }
    });

    await expect(adapter.send({
      notification_id: "ntf_1",
      target: { kind: "telegram", chat_id: "222" },
      intent_type: "final_report",
      idempotency_key: "run_1:final",
      payload: { text: "Report ready" },
      state: "sending",
      attempt_count: 1,
      provider_message_id: null
    })).resolves.toEqual({ provider_message_id: "telegram:88" });
    expect(sent).toEqual([{ chat_id: "222", text: "Report ready" }]);
  });
});
```

Create `tests/notifications/notification-dispatcher.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { NotificationDispatcher } from "../../src/notifications/notification-dispatcher.js";
import { NotificationOutbox } from "../../src/notifications/notification-outbox.js";
import { RunStore } from "../../src/run/run-store.js";

describe("NotificationDispatcher", () => {
  it("sends queued Telegram notification and marks delivered", async () => {
    const store = RunStore.openInMemory();
    const sent: string[] = [];
    try {
      const outbox = new NotificationOutbox(store);
      const record = outbox.enqueue({
        target: { kind: "telegram", chat_id: "222" },
        intent_type: "final_report",
        idempotency_key: "run_1:final",
        run_id: "run_1",
        correlation_id: "run_1:final",
        payload: { text: "Report ready", run_id: "run_1" }
      });
      const dispatcher = new NotificationDispatcher(outbox, {
        local: { send: async () => ({ provider_message_id: "local:1" }) },
        telegram: { send: async (notification) => {
          sent.push(notification.payload.text);
          return { provider_message_id: "telegram:99" };
        } }
      });

      await expect(dispatcher.dispatchOnce("sender-1")).resolves.toEqual({ status: "delivered", notification_id: record.notification_id });
      expect(sent).toEqual(["Report ready"]);
      expect(outbox.get(record.notification_id)?.provider_message_id).toBe("telegram:99");
    } finally {
      store.close();
    }
  });

  it("marks retryable failure when adapter throws", async () => {
    const store = RunStore.openInMemory();
    try {
      const outbox = new NotificationOutbox(store);
      const record = outbox.enqueue({
        target: { kind: "telegram", chat_id: "222" },
        intent_type: "progress",
        idempotency_key: "run_1:progress",
        run_id: "run_1",
        correlation_id: "run_1:progress",
        payload: { text: "Queued" }
      });
      const dispatcher = new NotificationDispatcher(outbox, {
        local: { send: async () => ({ provider_message_id: "local:1" }) },
        telegram: { send: async () => { throw new Error("network down"); } }
      });

      await expect(dispatcher.dispatchOnce("sender-1")).resolves.toEqual({ status: "failed", notification_id: record.notification_id, retryable: true });
      expect(outbox.get(record.notification_id)?.state).toBe("retry_wait");
    } finally {
      store.close();
    }
  });
});
```

- [ ] **Step 2: Run notification tests and verify expected failure**

Run:

```bash
npm test -- tests/notifications/notification-outbox.test.ts tests/notifications/telegram-notification-adapter.test.ts tests/notifications/notification-dispatcher.test.ts
```

Expected: FAIL because notification modules do not exist.

- [ ] **Step 3: Extend notification wrapper around Task 5 outbox schema**

Task 5 already created `notification-types.ts`, `NotificationIntentType`, `notification_outbox`, and minimal `RunStore.enqueueNotification()` so approval transitions can enqueue atomically. In Task 7, add `NotificationRecord`, `notificationTargetKey(target)`, `makeNotificationRecord(intent)`, the outbox wrapper, dispatcher, adapters, and retry/claim methods.

- [ ] **Step 4: Add RunStore outbox methods**

Extend the Task 5 store methods with `claimNextNotification`, `markNotificationDelivered`, `markNotificationFailed`, `requeueRetryWaitNotifications`, `recoverStaleSendingNotifications`, `getNotification`, and `countNotificationsByIdempotencyKey`.

Implementation requirements:

- `claimNextNotification` must use one `UPDATE ... WHERE notification_id = (SELECT ... LIMIT 1)` statement or `BEGIN IMMEDIATE` plus update, so two dispatchers cannot claim the same row.
- `enqueueNotification` conflicts must compare `payload_hash`, `run_id`, `approval_id`, and `correlation_id`; exact matches dedupe, mismatches return `NOTIFICATION_IDEMPOTENCY_CONFLICT`.
- `markNotificationDelivered` appends `notification_delivered` ledger event.
- `markNotificationDelivered` and `markNotificationFailed` ledger events must include nullable `run_id`, `approval_id`, and `correlation_id`.
- `markNotificationFailed` appends `notification_failed` ledger event and sets `retry_wait` only when `retryable` is true and `attempt_count < max_attempts`; otherwise set `failed_terminal`.
- `expireUndeliveredApprovalPrompts(now)` must mark expired queued/retry_wait/sending approval prompts as `failed_terminal`, then call `expirePendingApprovals(now)` so the approval and waiting run also expire.
- Gateway-created `ask` and `run` events must enqueue a `progress` notification after the run is durably created, using idempotency key `${run_id}:progress:queued` and the original notify target.
- CoreWorker must enqueue `final_report` after `run_completed`, using idempotency key `${run_id}:final_report` and the original notify target. Add local and Telegram tests proving both notifications are queued.

- [ ] **Step 5: Add adapters, outbox wrapper, dispatcher, and CLI**

Create `NotificationOutbox` as a thin wrapper over RunStore. Create `LocalNotificationAdapter`, `TelegramNotificationAdapter`, and `NotificationDispatcher`.

Add `houge send-outbox` branch to `src/cli.ts`:

```ts
} else if (command === "send-outbox") {
  const { NotificationOutbox } = await import("./notifications/notification-outbox.js");
  const { NotificationDispatcher } = await import("./notifications/notification-dispatcher.js");
  const { LocalNotificationAdapter } = await import("./notifications/local-notification-adapter.js");
  const { TelegramNotificationAdapter } = await import("./notifications/telegram-notification-adapter.js");
  const { TelegramClient } = await import("./telegram/telegram-client.js");
  const store = RunStore.open("houge.sqlite");
  try {
    const dispatcher = new NotificationDispatcher(new NotificationOutbox(store), {
      local: new LocalNotificationAdapter(),
      telegram: new TelegramNotificationAdapter(new TelegramClient({ token: process.env.HOUGE_TELEGRAM_BOT_TOKEN ?? "" }))
    });
    console.log(JSON.stringify(await dispatcher.dispatchOnce("cli-send-outbox"), null, 2));
  } finally {
    store.close();
  }
```

- [ ] **Step 6: Verify notification delivery and failure**

Run:

```bash
npm test -- tests/notifications/notification-outbox.test.ts tests/notifications/telegram-notification-adapter.test.ts tests/notifications/notification-dispatcher.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/domain/types.ts src/run/run-store.ts src/notifications src/telegram/telegram-client.ts src/cli.ts tests/notifications
git commit -m "feat: dispatch notification outbox"
```

## Task 8: Gateway Status, Approval Replay, and Approval Prompt Content

**Files:**
- Modify: `src/gateway/gateway.ts`
- Modify: `src/run/run-store.ts`
- Test: `tests/gateway/gateway-telegram.test.ts`

- [ ] **Step 1: Write failing Gateway replay and prompt tests**

Create `tests/gateway/gateway-telegram.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";
import { normalizeTelegramUpdate } from "../../src/triggers/telegram-trigger-adapter.js";

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
```

- [ ] **Step 2: Run Gateway tests and verify expected failure**

Run:

```bash
npm test -- tests/gateway/gateway-telegram.test.ts
```

Expected: FAIL because processed-trigger replay and full approval prompt content are missing.

- [ ] **Step 3: Add Gateway processed-trigger handling**

Extend `GatewayIntakeResult` with these result variants before editing behavior:

```ts
| { ok: true; status: "status_returned"; run_id?: string }
| { ok: true; status: "approval_resolved"; run_id: string }
```

Restructure `Gateway.intake(event)` in this order:

1. Validate/rate-limit Telegram commands with a deterministic injected `now`.
2. Handle `status`, `approve`, and `deny` before `compileTaskContract`; these commands do not produce task contracts.
3. Compile contracts only for `ask` and `run`.
4. For created `ask`/`run`, enqueue the `progress` notification described in Task 7 after the run insert commits.

At the top of `Gateway.intake(event)`, only for non-approval commands after rate-limit acceptance:

```ts
const replay = this.runStore.beginTriggerProcessing(event);
if (replay.status === "duplicate") return JSON.parse(replay.result_json) as GatewayIntakeResult;
if (replay.status === "conflict") {
  return { ok: false, error: { code: replay.error, message: "Trigger idempotency key conflicts with a different payload" } };
}
```

For `/status`, queue one notification with idempotency key `${event.idempotency_key}:status`, record the trigger result, and return `status_returned`.

For `/approve` and `/deny`, do not read `event.metadata.action_fingerprint` and do not trust Telegram-provided action metadata. Call the atomic store method:

```ts
this.runStore.processApprovalTrigger({
  event,
  decision,
  resolved_at: event.created_at
});
```

`processApprovalTrigger(...)` records successful approve/deny results with the processed trigger in the same transaction. Duplicate `/approve <id>` updates replay the stored result. A conflicting payload under the same idempotency key returns `TRIGGER_IDEMPOTENCY_CONFLICT`.

Before accepting `ask`, `run`, `status`, `approve`, or `deny`, call `RunStore.checkTelegramRateLimit({ actor_id, chat_id, command, now })`.

```ts
export type TelegramRateLimitResult =
  | { ok: true }
  | { ok: false; error: { code: "TELEGRAM_RATE_LIMITED"; message: string; reason: "command_window" | "active_runs" | "pending_approvals" } };
```

The first Milestone-2 limit is conservative and durable: max 5 accepted commands per actor+chat per 60 seconds, max 3 active `queued`/`running`/`waiting_for_approval` runs per actor, and max 5 pending approvals per actor. `checkTelegramRateLimit` uses `telegram_command_audit` for command windows and `runs`/`approvals` for active counts. It receives `now` from Gateway for deterministic tests. Accepted and denied decisions insert `telegram_command_audit` rows in the same transaction as the Gateway command handling. Do not add `telegram_command_denied` to ledger types for pre-run denials; use the audit table.

- [ ] **Step 4: Add full approval prompt content**

In `RunStore.createApprovalRequest`, enqueue approval prompt in the same transaction as the approval insert and run transition. Text must include:

```ts
[
  `Approval required: ${approval_id}`,
  `Action: ${input.action_summary}`,
  `Side effect: ${input.side_effect_level}`,
  `Risk: ${input.risk_level}`,
  `Affected resources: ${input.affected_resources.join(", ")}`,
  `Action fingerprint: ${input.action_fingerprint}`,
  `Adapter input hash: ${input.adapter_input_hash}`,
  `Requester: ${input.requester.kind}:${input.requester.id}`,
  `Expires: ${input.expires_at}`,
  "Expected run state: waiting_for_approval",
  "Consequence if approved: the exact fingerprinted action may execute once after policy revalidation.",
  "Consequence if denied or expired: the run is cancelled and reports the blocked action.",
  `Reply /approve ${approval_id} to continue or /deny ${approval_id} to stop.`
].join("\n")
```

- [ ] **Step 5: Verify Gateway replay and prompt content**

Run:

```bash
npm test -- tests/gateway/gateway-telegram.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/gateway/gateway.ts src/run/run-store.ts tests/gateway/gateway-telegram.test.ts
git commit -m "feat: dedupe telegram gateway decisions"
```

## Task 9: Telegram Client, Long Polling, and Runnable Poll Gateway

**Files:**
- Modify: `src/telegram/telegram-client.ts`
- Modify: `src/triggers/telegram-trigger-adapter.ts`
- Create: `src/telegram/telegram-poll-runner.ts`
- Modify: `src/run/run-store.ts`
- Modify: `src/cli.ts`
- Test: `tests/telegram/telegram-client.test.ts`
- Test: `tests/triggers/telegram-long-polling.test.ts`
- Test: `tests/telegram/telegram-poll-runner.test.ts`

- [ ] **Step 1: Write failing client, offset, and runner tests**

Create `tests/telegram/telegram-client.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { TelegramClient } from "../../src/telegram/telegram-client.js";

describe("TelegramClient", () => {
  it("uses fetch for sendMessage and getUpdates", async () => {
    const calls: string[] = [];
    const client = new TelegramClient({
      token: "token",
      apiBase: "https://example.test/bottoken",
      fetchImpl: async (url, init) => {
        calls.push(`${url} ${init?.body ?? ""}`);
        if (String(url).includes("getUpdates")) return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
        return new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }), { status: 200 });
      }
    });

    await expect(client.sendMessage({ chat_id: "222", text: "hello" })).resolves.toEqual({ message_id: 77 });
    await expect(client.getUpdates({ offset: 12, timeout_seconds: 1 })).resolves.toEqual([]);
    expect(calls.some((call) => call.includes("/sendMessage"))).toBe(true);
    expect(calls.some((call) => call.includes("/getUpdates?offset=12"))).toBe(true);
  });
});
```

Create `tests/triggers/telegram-long-polling.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createTelegramLongPollingAdapter } from "../../src/triggers/telegram-trigger-adapter.js";
import type { TelegramAllowlist } from "../../src/domain/types.js";

const allowlist: TelegramAllowlist = {
  users: [{ telegram_user_id: 111, identity_id: "paco" }],
  chats: [{ telegram_chat_id: 222, label: "private", allowed_identity_ids: ["paco"] }]
};

function update(update_id: number) {
  return {
    update_id,
    message: {
      message_id: 10,
      text: "/ask summarize rules",
      from: { id: 111 },
      chat: { id: 222 }
    }
  };
}

describe("createTelegramLongPollingAdapter", () => {
  it("persists offset only after emit succeeds", async () => {
    const offsets: number[] = [];
    const adapter = createTelegramLongPollingAdapter({
      allowlist,
      client: { getUpdates: async () => [update(41)] },
      offsetStore: {
        getOffset: () => 0,
        setOffset: (_source, offset) => offsets.push(offset)
      }
    });

    await expect(adapter.pollOnce(async () => undefined)).resolves.toEqual({ processed_updates: 1, skipped_updates: 0 });

    expect(offsets).toEqual([42]);
  });

  it("does not persist offset when emit throws so Telegram can retry the update", async () => {
    const offsets: number[] = [];
    const adapter = createTelegramLongPollingAdapter({
      allowlist,
      client: { getUpdates: async () => [update(41)] },
      offsetStore: {
        getOffset: () => 0,
        setOffset: (_source, offset) => offsets.push(offset)
      }
    });

    await expect(adapter.pollOnce(async () => {
      throw new Error("gateway intake failed");
    })).rejects.toThrow("gateway intake failed");

    expect(offsets).toEqual([]);
  });

  it("advances offset for deterministic auth denial and unsupported commands", async () => {
    const offsets: number[] = [];
    const skipped: unknown[] = [];
    const adapter = createTelegramLongPollingAdapter({
      allowlist,
      client: { getUpdates: async () => [
        { update_id: 50, message: { message_id: 1, text: "/ask blocked", from: { id: 999 }, chat: { id: 222 } } },
        { update_id: 51, message: { message_id: 2, text: "/teach remember", from: { id: 111 }, chat: { id: 222 } } }
      ] },
      offsetStore: {
        getOffset: () => 0,
        setOffset: (_source, offset) => offsets.push(offset)
      },
      skippedUpdateStore: {
        recordSkippedTelegramUpdate: (input) => skipped.push(input)
      }
    });

    await expect(adapter.pollOnce(async () => {
      throw new Error("emit must not run for skipped updates");
    })).resolves.toEqual({ processed_updates: 0, skipped_updates: 2 });

    expect(offsets).toEqual([51, 52]);
    expect(skipped).toHaveLength(2);
  });

  it("stops a multi-update batch without advancing past a transient intake failure", async () => {
    const offsets: number[] = [];
    const adapter = createTelegramLongPollingAdapter({
      allowlist,
      client: { getUpdates: async () => [update(60), update(61)] },
      offsetStore: {
        getOffset: () => 0,
        setOffset: (_source, offset) => offsets.push(offset)
      }
    });

    await expect(adapter.pollOnce(async (event) => {
      if (event.source_reference.includes("update:61")) throw new Error("gateway intake failed");
    })).rejects.toThrow("gateway intake failed");

    expect(offsets).toEqual([61]);
  });
});
```

Create `tests/telegram/telegram-poll-runner.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RunStore } from "../../src/run/run-store.js";
import { runTelegramPollOnce } from "../../src/telegram/telegram-poll-runner.js";

describe("runTelegramPollOnce", () => {
  it("polls one update, creates a run, executes worker, dispatches outbox, and sends Telegram messages", async () => {
    const root = mkdtempSync(join(tmpdir(), "houge-poll-"));
    writeFileSync(join(root, "AGENTS.md"), "Rules");
    const store = RunStore.openInMemory();
    const sent: string[] = [];
    try {
      const result = await runTelegramPollOnce({
        store,
        projectRoot: root,
        allowlist: {
          users: [{ telegram_user_id: 111, identity_id: "paco" }],
          chats: [{ telegram_chat_id: 222, label: "private", allowed_identity_ids: ["paco"] }]
        },
        telegramClient: {
          getUpdates: async () => [{
            update_id: 30,
            message: { message_id: 1, text: "/ask summarize rules", from: { id: 111 }, chat: { id: 222 } }
          }],
          sendMessage: async ({ text }) => {
            sent.push(text);
            return { message_id: sent.length };
          }
        }
      });

      expect(result).toMatchObject({ processed_updates: 1, worker_status: "completed" });
      expect(sent.some((text) => text.includes("Queued"))).toBe(true);
      expect(sent.some((text) => text.includes("completed"))).toBe(true);
    } finally {
      store.close();
    }
  });
});
```

- [ ] **Step 2: Run tests and verify expected failure**

Run:

```bash
npm test -- tests/telegram/telegram-client.test.ts tests/triggers/telegram-long-polling.test.ts tests/telegram/telegram-poll-runner.test.ts
```

Expected: FAIL because `getUpdates`, offset storage, and poll runner are missing.

- [ ] **Step 3: Add client getUpdates, offset store, and long polling**

Add `getUpdates()` to `TelegramClient`. Add `trigger_offsets` table and `RunStore.getOffset(source)` / `RunStore.setOffset(source, offset)`.

In `createTelegramLongPollingAdapter`, handle updates in ascending `update_id` order:

- If parser/auth normalization fails deterministically, call `skippedUpdateStore.recordSkippedTelegramUpdate(...)`, then call `offsetStore.setOffset("telegram", update.update_id + 1)`.
- If normalization succeeds, call `await emit(normalized.event)`, then call `offsetStore.setOffset("telegram", update.update_id + 1)`.
- If `emit` throws, let the error propagate and leave the offset at the last successfully handled update. Do not process later updates in that batch.

`pollOnce` must return `{ processed_updates, skipped_updates }` for adapter-level tests. `runTelegramPollOnce` may add worker and dispatch fields around that result.

- [ ] **Step 4: Add telegram poll runner and CLI**

Create `src/telegram/telegram-poll-runner.ts` with `runTelegramPollOnce({ store, projectRoot, allowlist, telegramClient })`. It must:

- Create Gateway and long polling adapter.
- For each emitted event, call `Gateway.intake(event)`. The emit contract is: deterministic Gateway denials return a handled result and are audited; transient storage/process failures throw. Treat `TELEGRAM_RATE_LIMITED`, `APPROVAL_NOT_FOUND`, and `TRIGGER_IDEMPOTENCY_CONFLICT` as handled `ok:false` results for offset advancement; thrown store errors leave the offset unchanged.
- If intake returns a created run, call `CoreWorker.executeRun(run_id, "telegram-poll-worker")`.
- Before dispatching, call `store.expirePendingApprovals(new Date().toISOString())` and `store.expireUndeliveredApprovalPrompts(new Date().toISOString())`.
- Dispatch outbox notifications until dispatcher returns idle.
- Return `{ processed_updates, worker_status, dispatch_results }`.

Add `houge telegram-poll --once` CLI branch. If `--once` is absent, print `Only --once is supported in Milestone 2` and exit 1.

- [ ] **Step 5: Verify Telegram runner**

Run:

```bash
npm test -- tests/telegram/telegram-client.test.ts tests/triggers/telegram-long-polling.test.ts tests/telegram/telegram-poll-runner.test.ts
```

Expected: tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/telegram/telegram-client.ts src/telegram/telegram-poll-runner.ts src/triggers/telegram-trigger-adapter.ts src/run/run-store.ts src/cli.ts tests/telegram tests/triggers/telegram-long-polling.test.ts
git commit -m "feat: run telegram poll loop once"
```

## Task 10: Executable Milestone-2 Evals and Smoke Commands

**Files:**
- Modify: `src/eval/eval-runner.ts`
- Modify: `src/cli.ts`
- Create: `evals/suites/milestone-2.json`
- Create: `evals/fixtures/milestone-2-parser-auth.json`
- Create: `evals/fixtures/milestone-2-outbox-delivery.json`
- Create: `evals/fixtures/milestone-2-approval-resume.json`
- Create: `evals/fixtures/milestone-2-ask-path.json`
- Create: `evals/golden/milestone-2-parser-auth.json`
- Create: `evals/golden/milestone-2-outbox-delivery.json`
- Create: `evals/golden/milestone-2-approval-resume.json`
- Create: `evals/golden/milestone-2-ask-path.json`
- Test: `tests/eval/eval-runner.test.ts`

- [ ] **Step 1: Write failing executable eval tests**

Append to `tests/eval/eval-runner.test.ts`:

```ts
it("passes milestone-2 executable golden cases", () => {
  const result = runEvalSuite(process.cwd(), "milestone-2");

  expect(result).toEqual({ suite: "milestone-2", passed: true, failed: [] });
});

it("fails milestone-2 when executable output differs from golden output", () => {
  const result = runEvalSuite(process.cwd(), "milestone-2", {
    fixtureOverride: {
      name: "milestone-2-parser-auth",
      type: "parser-auth",
      input: { text: "/unsupported", from_id: 111, chat_id: 222 }
    }
  });

  expect(result.passed).toBe(false);
  expect(result.failed).toContain("milestone-2-parser-auth");
});
```

Add the options shape to `src/eval/eval-runner.ts` before implementing the cases:

```ts
export type EvalFixtureExecutableFile =
  | { name: string; type: "parser-auth"; input: { text: string; from_id: number; chat_id: number } }
  | { name: string; type: "outbox-delivery"; input: { target: { kind: "telegram"; chat_id: string }; text: string } }
  | { name: string; type: "approval-resume"; input: { goal: string; requester: string } }
  | { name: string; type: "ask-path"; input: { text: string } };

export interface EvalRunOptions {
  fixtureOverride?: EvalFixtureExecutableFile;
}

export function runEvalSuite(projectRoot: string, suiteName: string, options: EvalRunOptions = {}) {
  // Existing non-executable suite behavior stays unchanged; executable cases use options.fixtureOverride when names match.
}
```

- [ ] **Step 2: Add suite, fixtures, and golden outputs**

Create `evals/suites/milestone-2.json`:

```json
{
  "name": "milestone-2",
  "executable_cases": [
    "milestone-2-parser-auth",
    "milestone-2-outbox-delivery",
    "milestone-2-approval-resume",
    "milestone-2-ask-path"
  ]
}
```

Create four fixture/golden pairs:

```json
{ "name": "milestone-2-parser-auth", "type": "parser-auth", "input": { "text": "/ask summarize rules", "from_id": 111, "chat_id": 222 } }
```

```json
{ "event_type": "ask", "program": "ask", "authorized_identity": "paco", "notify": "telegram:222" }
```

```json
{ "name": "milestone-2-outbox-delivery", "type": "outbox-delivery", "input": { "target": { "kind": "telegram", "chat_id": "222" }, "text": "Report ready" } }
```

```json
{ "notification_states": ["sending", "delivered"], "provider_message_id": "telegram:1", "ledger_events": ["notification_delivered"] }
```

```json
{ "name": "milestone-2-approval-resume", "type": "approval-resume", "input": { "goal": "force approval fixture", "requester": "paco" } }
```

```json
{ "run_states": ["queued", "running", "waiting_for_approval", "queued", "running", "completed"], "approval_states": ["pending", "approved", "consumed"], "ledger_events": ["approval_requested", "approval_resolved", "tool_finished", "run_completed"] }
```

```json
{ "name": "milestone-2-ask-path", "type": "ask-path", "input": { "text": "/ask summarize project rules" } }
```

```json
{ "program": "ask", "run_state": "completed", "ledger_events": ["run_created", "contract_attached", "worker_lease_acquired", "report_written", "run_completed"], "outbox_intents": ["progress", "final_report"] }
```

- [ ] **Step 3: Extend eval runner**

Modify `src/eval/eval-runner.ts` so suite files may use `executable_cases`. For each executable case, read `evals/fixtures/<case>.json`, run a deterministic in-memory flow using parser/auth/gateway/core/outbox modules, reduce output to stable fields, and compare JSON string equality with `evals/golden/<case>.json`. Keep existing `required_fixtures` behavior for milestone-0 and milestone-1.

Add `runExecutableEvalCase(projectRoot, fixture)` branches:

- `parser-auth`: parse and authorize a fake Telegram update, return event type, program, identity, and notify target.
- `outbox-delivery`: enqueue one fake Telegram notification, dispatch with fake client, return states, provider message id, and delivery ledger event names.
- `approval-resume`: run forced approval fixture through CoreWorker, approve, resume, return run states, approval states, and ledger event names.
- `ask-path`: normalize `/ask`, intake, execute worker, return program, final run state, ledger event names, and outbox intent names.

- [ ] **Step 4: Add smoke commands**

Add `houge outbox-smoke` and keep `houge telegram-parser-smoke`:

```ts
} else if (command === "outbox-smoke") {
  const { NotificationOutbox } = await import("./notifications/notification-outbox.js");
  const store = RunStore.openInMemory();
  try {
    const outbox = new NotificationOutbox(store);
    const record = outbox.enqueue({
      target: { kind: "local" },
      intent_type: "progress",
      idempotency_key: "smoke:progress",
      correlation_id: "smoke:progress",
      payload: { text: "outbox smoke" }
    });
    console.log(JSON.stringify({ ok: true, notification_id: record.notification_id }, null, 2));
  } finally {
    store.close();
  }
```

- [ ] **Step 5: Verify evals and smokes**

Run:

```bash
npm test -- tests/eval/eval-runner.test.ts
npm run eval -- milestone-2
npm run houge -- outbox-smoke
npm run houge -- telegram-parser-smoke "/approve appr_smoke"
```

Expected: tests PASS, eval prints `"passed": true`, outbox smoke prints an `ntf_` id, parser smoke prints `"approval_id": "appr_smoke"`.

- [ ] **Step 6: Commit**

```bash
git add src/eval/eval-runner.ts src/cli.ts evals/suites/milestone-2.json evals/fixtures/milestone-2-parser-auth.json evals/fixtures/milestone-2-outbox-delivery.json evals/fixtures/milestone-2-approval-resume.json evals/fixtures/milestone-2-ask-path.json evals/golden/milestone-2-parser-auth.json evals/golden/milestone-2-outbox-delivery.json evals/golden/milestone-2-approval-resume.json evals/golden/milestone-2-ask-path.json tests/eval/eval-runner.test.ts
git commit -m "test: add executable milestone 2 evals"
```

## Final Verification

Run these commands after all tasks are implemented:

```bash
npm run typecheck
npm test
npm run build
npm run eval -- milestone-0
npm run eval -- milestone-1
npm run eval -- milestone-2
npm run houge -- status
npm run houge -- telegram-parser-smoke "/run research-brief smoke"
npm run houge -- telegram-parser-smoke "/approve appr_smoke"
npm run houge -- outbox-smoke
npm run houge -- send-outbox
```

Expected:

- `npm run typecheck`: exits 0 with no TypeScript errors.
- `npm test`: exits 0 with all Vitest suites passing.
- `npm run build`: exits 0 and writes `dist/`.
- milestone evals print `"passed": true`.
- `houge status` prints valid JSON and exits 0.
- parser smoke commands print valid parsed command JSON and exit 0.
- outbox smoke prints valid notification JSON and exits 0.
- `houge send-outbox` prints either `{"status":"idle"}` or a delivery/failure JSON object and exits 0 without a live token when no Telegram notification is queued.

## Self-Review Checklist

- Telegram parser: Task 1.
- Telegram auth and event normalization: Task 2.
- Shared status query: Task 3.
- Built-in `/ask` normal path: Task 4.
- Approval lifecycle, security, consumption, replay, indexes: Task 5.
- CapabilityRunner policy revalidation and CoreWorker parking/resume: Task 6.
- Notification outbox dispatch, retry, failure, stale lease recovery, delivery ledger events, prompt expiry: Task 7.
- Gateway idempotency, duplicate status, duplicate approval, full prompt content: Task 8.
- Long polling runner with offset persisted after deterministic reject audit or durable Gateway intake: Task 9.
- Executable/golden milestone-2 evals: Task 10.
- Scope boundary preserved: Telegram sending only through NotificationOutbox delivery.

## Review Handoff

Likely parallel implementation lanes:

- Parser/auth lane: Tasks 1 and 2.
- Status/ask lane: Tasks 3 and 4.
- Approval state lane: Task 5. Owns RunStore migration ordering.
- Capability/core lane: Task 6 after Task 5.
- Outbox lane: Task 7 after migration coordination with Task 5.
- Gateway lane: Task 8 after Tasks 5 and 7.
- Telegram runner lane: Task 9 after Tasks 1, 2, 7, and 8.
- Eval lane: Task 10 after all prior tasks.

Prior Milestone 0/1 next steps that fit Milestone 2:

- Replace simulated approval handling with durable approval records, approval resolution, and approval consumption.
- Reuse existing eval command while upgrading milestone-2 from fixture presence to executable golden cases.
- Keep local CLI trigger and CoreWorker path intact; Telegram adds a source, not a parallel runtime.

Prior next steps that belong later:

- Scheduler and scheduled Telegram notifications are Milestone 3.
- Memory Catalog, `/teach`, and learning approval activation are Milestone 4.
- Environment guidebooks and guidebook retrieval evals are Milestone 5.
- Coding-agent CLI delegation remains out of scope until deterministic process containment exists.
