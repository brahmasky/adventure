# Chat is for Paco — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Proactive Telegram messages carry only what needs Paco; background notices become `change_log` rows readable
through `/changes` and one `/status` line.

**Architecture:** A closed `topic` on every notification intent; `TOPIC_ROUTE` maps it to `chat` (today's outbox path) or
`log` (`RunStore.logChange` → `change_log`). Incidents route by kind through one table (`page` / `card` / `log`) with
plain-words, id-masked text. The model-roles tick collapses tier moves into one log line, the gemini-pro tier reads renamed
Gemini ids, and a card-tap override the tier now covers is retired.

**Tech Stack:** Node + TypeScript (ESM, `.js` import suffixes), `node:sqlite` via RunStore, vitest. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-11-03-chat-is-for-paco-design.md` (Rev 1.2, approved by Paco 2026-11-03). The spec is
the authority; this plan argues from it. Section references (§) are the spec's.

## Global Constraints

- `dependencies: {}` stays empty. Node stdlib + devDeps only.
- Functions under 50 lines. `enqueueNotification` is already 75 lines: new logic goes in new methods, never inline.
- Match surrounding style: ESM `.js` suffixes, `readonly`, code-owned text constants, comments citing the spec section.
- No message text, chat id, run id or approval id in `change_log.text`, in `/changes`, in ledger payloads, or in gate prints.
- Never write the live DB `houge.sqlite`. Gates use a `VACUUM INTO` copy, deleted on every exit path.
- Never send real Telegram from tests or gates (stub `HOUGE_TELEGRAM_CHAT_ID`, stubbed adapter).
- Protected surface (`src/omp`, `src/decisions`, `docs/decisions`, `src/policy`, `AGENTS.md`) is edited under this approved
  spec only (AGENTS.md Tier A). A self-write-guard hit on these paths is expected.
- Tests live in `tests/<area>/` mirroring `src/`. Each test fails if the business rule it names is broken.
- Every earlier live gate stays green after the amendments Task 6 makes on purpose (§10 list).
- Commit per concern, stage files by name, Conventional Commits, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Worktree: `.worktrees/chat-is-for-paco`, branch `chat-is-for-paco`, base = `main` at the spec commit. Gates in the
  worktree run with `HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env` after `npm run build`.

## Plan rulings (where the spec leaves a choice)

- **P1 — `/changes` rides the status event.** `/changes` parses to `{ type: "status", view: "changes" }` (as
  `/status decisions` does) and `/status changes` is the same view. This replaces §7's "new TelegramCommand variant,
  TaskEventType member, buildTypedTaskEvent case": the same user surface with no new event type. Cost if wrong: none for
  Paco; a later split is mechanical.
- **P2 — Task 1 tags every site and converts the non-incident log sites; incident sites keep `incident_page` until Task 3.**
  Each task ships green: after Task 1 nothing incident-related changes behaviour.
- **P3 — `says` lines for log kinds** are fixed in Task 2's table below (the spec deferred them to the plan).
- **P4 — `card` kinds keep the env-chat fallback** by a helper `operatorChat(chatId, env)` = `chatId ?? env.HOUGE_TELEGRAM_CHAT_ID?.trim() ?? null`.
- **P5 — The test fixture helper** `tests/support/intents.ts` exports `chatIntent(partial)` and `logIntent(partial)`; tests
  that build intent literals move to it in the task whose type change breaks them.
- **P6 — Gate amendments are one task (Task 6)**, after all code tasks, run by the orchestrator (gates call real
  subscription seats in places; implementers do not run them — R6 ruling 8).
- **P7 — Task 1 stays one task with two commits** (plan review W5 asked for a split): commit A = types, store, tagging
  with zero behaviour change; commit B = the four log conversions and their test updates. The reviewer gets both commits
  and reviews B as its own unit. Cost if wrong: a larger review package for Task 1.
- **Plan Rev 1.1** applies the plan review (Fable 5.1: 2 B / 8 W / 7 S, Task 1 trial-compiled to 81 typecheck errors).
  Same model as the spec reviewer; codex was out of quota.

---

### Task 1: The router and `change_log`

**Files:**
- Create: `src/notifications/topics.ts`, `tests/notifications/topics.test.ts`, `tests/run/change-log.test.ts`, `tests/support/intents.ts`
- Modify: `src/notifications/notification-types.ts`, `src/notifications/notification-outbox.ts`, `src/run/run-store.ts`
  (DDL, `migrate()`, `enqueueNotification`, new `logChange`, `NotificationQueueResult`, the 11 `NotificationIntent[...]`
  index types → `ChatIntent[...]`), `src/decisions/urgent.ts`, `src/decisions/record.ts`, every enqueue site in the §4.1
  table (add `topic`), `src/telegram/telegram-daemon.ts` (`runRolesTick` notify), `src/decisions/jev-version-job.ts`
  (`notify`), `src/capabilities/skill-reverify.ts`, test files that build intent literals (P5).

**Interfaces:**
- Produces:
  ```ts
  // src/notifications/topics.ts
  export const TOPIC_ROUTE: { readonly [K in NotificationTopic]: "chat" | "log" };   // exact table in Step 3
  export type NotificationTopic; export type ChatTopic; export type LogTopic;
  export const isLogTopic: (t: NotificationTopic) => t is LogTopic;
  // src/notifications/notification-types.ts
  export interface ChatIntent { topic: ChatTopic; target: NotifyTarget; intent_type: NotificationIntentType; idempotency_key: string;
    run_id?: string; approval_id?: string; correlation_id: string; payload: NotificationPayload }
  export interface LogIntent { topic: LogTopic; idempotency_key: string; correlation_id: string; text: string; now?: string }
  export type NotificationIntent = ChatIntent | LogIntent;
  // src/run/run-store.ts
  export type NotificationQueueResult =
    | { status: "queued" | "duplicate"; record: NotificationRecord }
    | { status: "logged"; change_id: string }
    | { status: "duplicate_log"; change_id: string }
    | { status: "conflict"; error: string };
  RunStore.logChange(intent: LogIntent): NotificationQueueResult;            // logged | duplicate_log | conflict
  RunStore.listChangeLog(sinceIso: string, limit: number): ChangeLogRow[];   // newest first
  RunStore.countChangeLogSince(sinceIso: string): number;
  export interface ChangeLogRow { change_id: string; topic: string; text: string; created_at: string }
  // src/decisions/urgent.ts
  export function enqueueUrgentCard(store: RunStore, c: UrgentCard, topic: "urgent" | "decision_internal"): string | null;
  // NotificationOutbox.enqueue(intent: ChatIntent): NotificationRecord
  ```
  A log duplicate is `duplicate_log` (not `duplicate`), so every existing `r.status === "duplicate"` read keeps a `record`.

- [ ] **Step 1: Write the failing tests.**

  `tests/notifications/topics.test.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { TOPIC_ROUTE, isLogTopic } from "../../src/notifications/topics.js";

  describe("TOPIC_ROUTE (spec 2026-11-03 §4.1)", () => {
    it("routes exactly the five background topics to the log", () => {
      const log = Object.entries(TOPIC_ROUTE).filter(([, r]) => r === "log").map(([t]) => t).sort();
      expect(log).toEqual(["decision_internal", "incident_log", "jev_notice", "model_change", "skill_reverify"]);
    });
    it("keeps every reply, report, approval, card and the storm summary in chat", () => {
      for (const t of ["reply", "run_report", "approval", "memory_card", "rating_ask", "digest", "urgent", "idea_panel", "self_write",
        "budget_fuse", "improve_job", "jev_card", "model_card", "incident_page", "incident_reminder", "incident_summary"] as const) {
        expect(TOPIC_ROUTE[t]).toBe("chat");
        expect(isLogTopic(t)).toBe(false);
      }
    });
  });
  ```

  `tests/run/change-log.test.ts` (use the repo's existing temp-store helper — grep `tests/` for how `RunStore` is opened on a
  temp file, e.g. `openTestStore`/`createTempStore`, and use the same):
  ```ts
  it("a log intent writes one change_log row and no outbox row", () => {
    const r = store.enqueueNotification({ topic: "model_change", idempotency_key: "k1", correlation_id: "model-roles", text: "🔁 Kimi K: k3 → k3.1-pro", now: "2026-11-03T05:00:00.000Z" });
    expect(r.status).toBe("logged");
    expect(store.listChangeLog("2026-11-01T00:00:00.000Z", 20).map((x) => x.text)).toEqual(["🔁 Kimi K: k3 → k3.1-pro"]);
    expect(countOutbox(store)).toBe(0);   // SELECT COUNT(*) FROM notification_outbox
  });
  it("the same key and text is duplicate_log; a different text is a conflict", () => { /* enqueue k1 twice → duplicate_log; k1 with other text → conflict */ });
  it("a log write needs no chat (no target field exists)", () => { /* expect-type: // @ts-expect-error target on LogIntent */ });
  it("created_at is the intent's now", () => { /* row.created_at === now */ });
  it("listChangeLog is newest first and bounded; countChangeLogSince counts the window", () => { /* 3 rows at t1<t2<t3 */ });
  it("a chat intent is unchanged: queued, one outbox row, zero change_log rows", () => { /* topic reply */ });
  ```
  Write every body in full (the comments above name the assertions; no empty test may be committed).

- [ ] **Step 2: Run them.** `npx vitest run tests/notifications/topics.test.ts tests/run/change-log.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `topics.ts`.**
  ```ts
  /** Spec 2026-11-03 §4.1 (ADR 0031): every notification names a topic; the topic alone decides chat or the change log. */
  export const TOPIC_ROUTE = {
    reply: "chat", run_report: "chat", approval: "chat", memory_card: "chat", rating_ask: "chat", digest: "chat",
    urgent: "chat", idea_panel: "chat", self_write: "chat", budget_fuse: "chat", improve_job: "chat", jev_card: "chat",
    model_card: "chat", incident_page: "chat", incident_reminder: "chat", incident_summary: "chat",
    model_change: "log", incident_log: "log", jev_notice: "log", skill_reverify: "log", decision_internal: "log"
  } as const satisfies Record<string, "chat" | "log">;
  export type NotificationTopic = keyof typeof TOPIC_ROUTE;
  export type ChatTopic = { [K in NotificationTopic]: (typeof TOPIC_ROUTE)[K] extends "chat" ? K : never }[NotificationTopic];
  export type LogTopic = Exclude<NotificationTopic, ChatTopic>;
  export const isLogTopic = (t: NotificationTopic): t is LogTopic => TOPIC_ROUTE[t] === "log";
  ```

- [ ] **Step 4: Types, DDL, store.** In `notification-types.ts` replace `NotificationIntent` by the union (Interfaces). In
  `run-store.ts`:
  ```ts
  /** Spec 2026-11-03 §4.3: the change log — background notices that left chat. Code-owned, id-masked text only. */
  const CHANGE_LOG_DDL = `CREATE TABLE IF NOT EXISTS change_log (
    change_id TEXT PRIMARY KEY, topic TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
    correlation_id TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS change_log_created ON change_log(created_at);`;
  ```
  `CHANGE_LOG_DDL` goes in `migrate()`'s **base, unconditional** `this.db.exec(…)` block (`run-store.ts:~8436`, with the
  other `CREATE TABLE IF NOT EXISTS`), before every `apply*Migration` — NOT next to `MODEL_TIERS_DDL`, which sits inside
  `applyLoudDegradationMigration` above its `if (applied) return;`: one line lower and the live DB (migration already
  applied) never gets the table, so every log write throws inside the roles tick's transaction. Test: open a store whose
  `schema_migrations` already holds `2026-11-02-loud-degradation` and assert `change_log` exists. Rename today's
  `enqueueNotification` body to `private enqueueChat(intent: ChatIntent)` unchanged, and make the public method:
  ```ts
  const isLogIntent = (i: NotificationIntent): i is LogIntent => i.topic in TOPIC_ROUTE && isLogTopic(i.topic);
  enqueueNotification(intent: NotificationIntent): NotificationQueueResult {
    if (!(intent.topic in TOPIC_ROUTE)) console.error(`[notifications] untyped topic ${String(intent.topic)}: sent to chat`);
    return isLogIntent(intent) ? this.logChange(intent) : this.enqueueChat(intent as ChatIntent);
  }
  logChange(intent: LogIntent): NotificationQueueResult {
    const existing = this.db.prepare(`SELECT change_id, text FROM change_log WHERE idempotency_key = ?`).get<{ change_id: string; text: string }>(intent.idempotency_key);
    if (existing) return existing.text === intent.text ? { status: "duplicate_log", change_id: existing.change_id }
      : (console.error(`[change-log] ${intent.topic}: key reused with a different text`), { status: "conflict", error: "CHANGE_LOG_IDEMPOTENCY_CONFLICT" });
    const change_id = `chg_${randomUUID()}`;
    this.db.prepare(`INSERT INTO change_log (change_id, topic, idempotency_key, correlation_id, text, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(change_id, intent.topic, intent.idempotency_key, intent.correlation_id, intent.text, intent.now ?? new Date().toISOString());
    return { status: "logged", change_id };
  }
  ```
  plus `listChangeLog` (`WHERE created_at >= ? ORDER BY created_at DESC, change_id DESC LIMIT ?`) and `countChangeLogSince`.
  `NotificationOutbox.enqueue(intent: ChatIntent)`; its `return result.record` narrows on `status !== "conflict"` — the
  typechecker will demand `"record" in result`; throw on any other status.

- [ ] **Step 5: Tag every site.** Run `npm run typecheck` (the plan review measured 81 errors: 75 missing-`topic`
  sites — 50 in `src`, 25 across 14 test files — plus 6 that are not sites: `memory-correct.ts:174` indexes
  `Parameters<RunStore["enqueueNotification"]>[0]["target"]` → use `ChatIntent["target"]`; `digest.ts:397-402` returns
  `r.status` typed `"queued"|"duplicate"|"conflict"` → keep the type and throw on `logged`/`duplicate_log` (the digest is
  chat by table); `tests/capabilities/skill-reverify.test.ts:212-215` reads `.intent_type/.target/.payload` off its stub
  array → fixed in Step 6). Use the §4.1 table:
  `reply` (gateway replies, `replyTo`, acks, `cli.ts:302`, `eval-runner.ts:197`), `run_report`, `approval`,
  `memory_card`, `rating_ask`, `digest`, `idea_panel`, `self_write`, `budget_fuse`, `improve_job`, `jev_card` (the Accept
  card `jev-version-job.ts:547`), `model_card` (`enqueueTierCard`), and **`incident_page`** for `incident-alert.ts:43`,
  the sweep's `incident_opened`/`incident_resolved` (P2), `incident_summary`, `incident_reminder`.
  `UrgentCard.chat_id` becomes optional (`chat_id?: string`); `enqueueUrgentCard` throws if `topic === "urgent"` and
  `chat_id` is absent. `enqueueUrgentCard` gains the `topic` parameter: `"urgent"` at `standing-approval.ts` (×3), `trust.ts`, `settle-judge.ts`,
  `supervisor-settle.ts`; `"decision_internal"` at `record.ts:119`. For a log topic it builds
  `{ topic, idempotency_key: \`urgent:${c.key}\`, correlation_id: c.key, text: c.text }` (no buttons: a `decision_internal`
  card never has any) and returns `change_id`; for `urgent` it returns the outbox id exactly as today.

- [ ] **Commit A** here (`refactor(notifications): topic on every intent, change_log store — no behaviour change`) after
  `npm run typecheck && npx vitest run` is green, with the four sites below still on today's chat path under a temporary
  chat topic (`model_card` for the roles notice, `jev_card` for every Jev notice, `reply` for skill-reverify, `urgent`
  for the fallback card), replaced in Step 6.

- [ ] **Step 6: Convert the four log sites** (route decided above the chat check, §4.2):
  - `telegram-daemon.ts` `runRolesTick`: `notify` no longer returns on `!chatId`; it enqueues
    `{ topic: "model_change", idempotency_key: \`model_roles:notice:${now}:${stableHash(text)}\`, correlation_id: "model-roles", text, now }`.
  - `jev-version-job.ts` `notify(d, key, text, topic: "jev_notice" | "jev_card")`: `jev_notice` → a log intent (no chat
    needed); `jev_card` → today's chat path (env fallback kept). The stalled notice (`:175`) passes `"jev_card"`; deferred
    (`:359`) and `sendNotice` pass `"jev_notice"`.
  - `skill-reverify.ts`: drop the `input.chatId !== null` condition for the enqueue; log intent `skill_reverify:<date>`.
    The module has its own store interface (`skill-reverify.ts:71`): its test asserts the recorded intent
    (`.topic === "skill_reverify"`, `.text`), not a `change_log` row.
  - `jev-version-job.ts` `notify`'s `Pick` gains `"now"` so the log row carries `d.now()`; `defer()` calls it inside
    `inTransaction` — fine for `logChange` (two plain statements). Keep today's inline `d.chatId ?? env` for `jev_card`
    (Task 3 swaps in `operatorChat`).
  - `record.ts` `pageFallback` (plan review B2): route first. The fallback card is `decision_internal` (log): enqueue
    `enqueueUrgentCard(store, { key: \`decision_fallback:${incident.incident_id}\`, text }, "decision_internal")` with no
    chat lookup and no flap check whenever the incident opened (`opened && incident`); delete the
    `HOUGE_TELEGRAM_CHAT_ID` read. Test with `env: {}` and `HOUGE_TELEGRAM_CHAT_ID` unset: one `change_log` row for the card.

- [ ] **Step 7: Tests that build literals** move to `tests/support/intents.ts` (P5):
  ```ts
  import type { ChatIntent, LogIntent } from "../../src/notifications/notification-types.js";
  export const chatIntent = (p: Partial<ChatIntent> = {}): ChatIntent => ({ topic: "reply", target: { kind: "telegram", chat_id: "1" },
    intent_type: "progress", idempotency_key: "k", correlation_id: "c", payload: { text: "t" }, ...p });
  export const logIntent = (p: Partial<LogIntent> = {}): LogIntent => ({ topic: "model_change", idempotency_key: "k", correlation_id: "c", text: "t", ...p });
  ```
  Update the existing tests whose assertions change: model-roles daemon wiring (notice is now a `change_log` row, and is
  written with no chat), Jev notice tests (deferred/passed notices are `change_log` rows; the stalled notice and Accept card
  stay outbox rows), skill-reverify (intent recorded with `chatId: null`), `decision_fallback` card (now a `change_log`
  row, with no chat configured).

- [ ] **Step 8: Run.** `npm run typecheck && npx vitest run` → all green, none skipped.

- [ ] **Step 9: Commit B.** `feat(notifications): background notices go to the change log (chat is for Paco §4)`.

---

### Task 2: The incident route table (pure module)

**Files:**
- Create: `src/run/incident-route.ts`, `tests/run/incident-route.test.ts`
- Modify (types only): `src/run/invariant-sweep.ts` (`SWEEP_INCIDENT_KINDS satisfies`), `src/run/incident-alert.ts`
  (`SUPERVISOR_ALERT_KINDS`, `AlertedIncidentInput.kind: RoutedIncidentKind`), `src/jev/jev-incidents.ts`,
  `src/omp/read-format.ts`, `src/omp/omp-probe-runner.ts`, `src/decisions/jev-anchor-import.ts`,
  `src/decisions/jev-version-job.ts` (`page()` kind param), `src/decisions/trust.ts`, every `openAlertedIncident` caller
  whose kind is a plain `string` today.

**Interfaces:**
- Produces:
  ```ts
  export type IncidentRoute = "page" | "card" | "log";
  export interface IncidentRule { route: IncidentRoute; says: string; act?: string }
  export const INCIDENT_ROUTE: { readonly [K in RoutedIncidentKind]: IncidentRule };
  export type RoutedIncidentKind;                       // keys of the table
  export function routeOf(kind: string): IncidentRoute; // unknown kind → "page" (+ one stderr line per kind per process)
  export function maskSubject(subject: string): string;
  export function incidentNotice(kind: string, subject: string): { topic: "incident_page" | "incident_log"; text: string } | null; // null for card
  export function incidentResolvedNotice(kind: string, subject: string, open_minutes: number): { topic: "incident_page" | "incident_log"; text: string } | null;
  export function operatorChat(chatId: string | null | undefined, env: NodeJS.ProcessEnv): string | null; // P4
  ```

- [ ] **Step 1: Failing tests** (`tests/run/incident-route.test.ts`), each body written in full:
  - every kind in `SWEEP_INCIDENT_KINDS`, `SUPERVISOR_ALERT_KINDS`, the five Jev outage kinds, `jev_model_drifted`,
    `jev_model_insufficient`, `jev_model_check_stalled`, the three anchor kinds, `omp_read_format_drift`,
    `omp_contract_drift`, `hostile_schedule_turn`, `trust_card_failed` has a rule (import the exported sets — not a text scan);
  - the five Jev outage kinds and `jev_skip_rate` route `page` (locked: ADR 0029); `wall_collapsed`,
    `lane_fallthrough_rate` route `page` (§5.4);
  - the four card kinds route `card` and `incidentNotice` returns `null` for them;
  - the 19 log kinds (§5.3 list) route `log`;
  - `routeOf("no_such_kind") === "page"`;
  - masking: `maskSubject("chat:-1001234567890") === "a chat"`, `maskSubject("8123456789") === "a chat"`,
    `maskSubject("run:run_0f6c…uuid") === "a run"`, `maskSubject("run_<uuid>") === "a run"`, `maskSubject("appr_x") === "an approval"`,
    `maskSubject("judges:2") === "judges:2"`, `maskSubject("standing:std_1") === "standing:std_1"`;
  - page text: `incidentNotice("wrapper_mismatch", "chat:-100123456789")` is exactly
    ``"⚠️ My planner wrapper changed; every answer fails until a restart.\nWhat to do: restart the daemon\n`wrapper_mismatch` · a chat"``;
  - log text: `incidentNotice("core_overflow", "chat:-100123456789").text` is
    ``"A chat holds more core facts than the cap; the oldest are left out. (`core_overflow` · a chat)"``;
  - no notice text contains `{` (no JSON detail) for any table kind;
  - resolved: page → ``"✅ Fixed: {says} — open 75 min"``; log → same words, topic `incident_log`.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.** Page rows exactly as spec §5.3 (copy `says`/`act` verbatim; `act` absent where the spec shows
  "—"). Card rows: `says` = the kind's plain line, used only by `/status` counts and the log of its resolve:
  `jev_model_drifted` "Jev's new model answers differently; you got an Accept card.", `jev_model_insufficient` "Jev's new
  model couldn't be checked; you got an Accept card.", `jev_model_check_stalled` "The Jev version check stalled; lanes stay on
  the planner.", `decision_health` "Replies are going out unsettled; you got a card.". Log rows (P3):

  | kind | says |
  |---|---|
  | heartbeat_gap | I was offline for a while and came back. |
  | core_overflow | A chat holds more core facts than the cap; the oldest are left out. |
  | trust_tap_budget | Today's limit on trust questions was reached; the rest were decided without asking. |
  | decision_record_failed | A decision record failed to save; the decision itself ran. |
  | decision_fallback | A decider kept falling back to its backup this hour. |
  | decision_golden_drift | A decider's answers drifted from its test set; it keeps running. |
  | omp_read_format_drift | omp's read output changed shape; reads use the last known format. |
  | omp_contract_drift | omp's behaviour drifted from what I expect; I keep running. |
  | jev_anchor_missing | The Jev anchor import found no anchor model. |
  | jev_anchor_mixed_models | The Jev anchor import found answers from more than one model. |
  | jev_anchor_insufficient | The Jev anchor import had too few turns. |
  | standing_sweep_failed | The standing-approval sweep failed this round. |
  | standing_settle_failed | Settling a standing approval failed. |
  | standing_evidence_failed | A standing-approval evidence check failed. |
  | todo_reminder_seen | My planner got stuck in a todo-reminder loop. |
  | static_list_stale | A model in my fallback list left the catalog. |
  | model_catalog_unavailable | I couldn't read omp's model list; using the last good one. |
  | triage_overrides | You asked to dig deeper three times on one lane this week. |
  | hostile_schedule_turn | A scheduled task read hostile content; you got a card. |

  ```ts
  const CHAT_ID = /^-?\d{6,}$/;
  export function maskSubject(s: string): string {
    if (s.startsWith("chat:") || CHAT_ID.test(s)) return "a chat";
    if (s.startsWith("run:") || s.startsWith("run_")) return "a run";
    if (s.startsWith("appr_")) return "an approval";
    return s;
  }
  ```
  `incidentNotice` for an unknown kind returns the page form with `says` = `Something needs a look.` and no `act`.

- [ ] **Step 4: Type the kind sets** (`satisfies readonly RoutedIncidentKind[]` / `ReadonlySet<RoutedIncidentKind>`), and
  `AlertedIncidentInput.kind: RoutedIncidentKind`. `npm run typecheck` must pass with no `as` casts on kinds. Named seams
  (plan review W2): `isSupervisorAlertKind(k: string): k is SupervisorAlertKind` beside `SUPERVISOR_ALERT_KINDS`, used at
  `core-worker.ts:~2610` (its `kind: string` also carries row-only planner kinds not in the table);
  `jev-anchor-import.ts:104` `incident(store, kind: "jev_anchor_missing" | "jev_anchor_mixed_models" | "jev_anchor_insufficient", …)`;
  `page(…, kind: "jev_model_drifted" | "jev_model_insufficient", …)`. `OMP_CHECK_INCIDENT_KINDS` stays
  `ReadonlySet<string>` (it carries legacy `omp_version_mismatch`). Also export
  `isRoutedKind(k: string): k is RoutedIncidentKind` (silent membership, no stderr) for Task 3's `resolveIncident`.

- [ ] **Step 5: Run** `npm run typecheck && npx vitest run tests/run/incident-route.test.ts` → PASS.

- [ ] **Step 6: Commit.** `feat(incidents): one route table with plain words and masked subjects (§5.1–5.3)`.

---

### Task 3: Incident wiring

**Files:**
- Modify: `src/run/incident-alert.ts` (`openAlertedIncident`, `alertOpened`, `REMIND_KINDS`, `reminderText`),
  `src/run/invariant-sweep.ts` (alert loop, summary, resolved loop, `buildIncident*Text` → delegate to Task 2),
  `src/run/run-store.ts` (`resolveIncident(id, now, opts?)`), `src/decisions/jev-version-job.ts` (`page()`, stalled),
  `src/decisions/record.ts` (`pageFallback`), `src/omp/settle-judge.ts` (`settleHealthAfter`), `src/decisions/trust.ts`
  (unchanged calls; verify).
- Test: `tests/run/incident-alert.test.ts`, `tests/run/invariant-sweep.test.ts`, `tests/run/incident-resolve-log.test.ts`
  (new), the existing Jev/record/settle tests whose alert assertions change.

**Interfaces:**
- Consumes: Task 1 `LogIntent`, `enqueueNotification`; Task 2 `routeOf`, `incidentNotice`, `incidentResolvedNotice`, `operatorChat`.
- Produces: `RunStore.resolveIncident(incident_id: string, now: string, opts?: { silent?: boolean }): boolean`.

- [ ] **Step 1: Failing tests** (full bodies):
  1. `openAlertedIncident` of `decision_record_failed` with `env: {}` and no `chat_id` → one `change_log` row (topic
     `incident_log`, masked text), zero outbox rows.
  2. A log kind reopened inside `ALERT_REOPEN_QUIET_MS` → a second `change_log` row (log rows ignore flap damping), zero outbox.
  3. `omp_unavailable` with an env chat → one outbox row (topic page text, no `{`), zero `change_log` rows.
  4. `jev_model_drifted` via `page()` with `d.chatId = null` and `HOUGE_TELEGRAM_CHAT_ID=42` → exactly one outbox row, the
     Accept card, to chat `42`; no generic text (P4).
  5. `decision_health` → exactly one outbox row (the urgent card); `decision_fallback` with `env: {}` and
     `HOUGE_TELEGRAM_CHAT_ID` unset → zero outbox rows, two `change_log` rows (incident + card text).
  6. `hostile_schedule_turn` (event) → one `change_log` row for the open, none for its same-call resolve; the
     `trust_hostile` card is the only outbox row.
  7. `RunStore.resolveIncident` of an open `static_list_stale` → one `incident_log` row ``"✅ Fixed: …"``; of an open
     `omp_unavailable` → no row (page kinds keep their own notices); `{ silent: true }` → no row.
  8. Sweep with 5 page violations and 2 log violations, chat set → 3 outbox alerts (cap), 1 summary in chat (topic
     `incident_summary`), 2 `change_log` rows, `alerts_suppressed === 2`.
  9. Sweep with no chat → log violations still write rows; page violations write nothing (as today).
  10. Sweep resolve of a log sweep kind (`heartbeat_gap`) → exactly one `change_log` row (from `resolveIncident`), no
      second row from the sweep loop.
  11. Reminder: `role_unresolved` open 25 h → listed; `static_list_stale` open 25 h → not listed;
      `omp_contract_drift` open 6 d → not listed, 8 d → listed with ``"still open after a week: Houge's omp contract check fails; ask Claude to look"``.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: `openAlertedIncident`.**
  ```ts
  export function openAlertedIncident(store: RunStore, input: AlertedIncidentInput): boolean {
    const fingerprint = store.incidentFingerprint(input.kind, input.subject);
    if (store.findOpenIncident(fingerprint)) return false;
    const now = input.now ?? new Date().toISOString();
    const flapping = !input.event && store.findRecentlyResolvedIncident(fingerprint, new Date(Date.parse(now) - ALERT_REOPEN_QUIET_MS).toISOString()) !== undefined;
    const opened = store.openIncident({ kind: input.kind, subject: input.subject, detail: input.detail, now });
    announceOpened(store, opened.incident_id, input, now, flapping);
    if (input.event) store.resolveIncident(opened.incident_id, now, { silent: true });
    return true;
  }
  /** §4.2/§5.1: the route is decided before the chat: a log row needs no chat and ignores flapping; a card kind sends nothing here. */
  function announceOpened(store: RunStore, incident_id: string, input: AlertedIncidentInput, now: string, flapping: boolean): void {
    const n = incidentNotice(input.kind, input.subject);
    if (n === null) return;
    const key = `incident_opened:${incident_id}`;
    if (n.topic === "incident_log") { store.enqueueNotification({ topic: n.topic, idempotency_key: key, correlation_id: incident_id, text: n.text, now }); return; }
    const chat = input.chat_id ?? operatorChat(null, input.env ?? process.env);
    if (chat && !flapping) store.enqueueNotification({ topic: "incident_page", target: { kind: "telegram", chat_id: chat }, intent_type: "progress",
      idempotency_key: key, correlation_id: incident_id, payload: { text: n.text } });
  }
  ```
  `input.env` keeps its meaning for page kinds (a caller may still pass `env` for tests); the card callers stop passing `env: {}`.

- [ ] **Step 4: `resolveIncident(id, now, opts)`** — after the `incident_resolved` ledger event:
  ```ts
  if (!opts?.silent && isRoutedKind(row.kind) && INCIDENT_ROUTE[row.kind].route === "log") {   // silent check: row-only and legacy kinds resolve here too
    const n = incidentResolvedNotice(row.kind, row.subject, open_minutes)!;
    this.enqueueNotification({ topic: "incident_log", idempotency_key: `incident_resolved:${incident_id}`, correlation_id: incident_id, text: n.text, now });
  }
  ```
  (Extract the ledger append + this into a private helper to keep the method under 50 lines.) A log kind's resolve is
  logged at any age (the sweep's 60-minute floor is for its chat notice only — on purpose). Side effect, expected:
  `applyHostileScheduleEventMigration` resolves legacy open `hostile_schedule_turn` rows at boot through
  `resolveIncident`, so on a DB that still has such rows `migrate()` writes `incident_log` rows (live DB has none).
  Test: resolving an open `omp_version_mismatch` row writes no `change_log` row and nothing to stderr.

- [ ] **Step 5: Card callers.** `page()` in `jev-version-job.ts`: drop `...(d.chatId ? { env: {} } : {})`; send the card to
  `operatorChat(d.chatId, process.env)` when non-null. Stalled: drop the `env: {}`; send the stalled notice through
  `notify(..., "jev_card")` (Task 1) to the same chat. `pageFallback` (`record.ts`, already routed in Task 1) and
  `settleHealthAfter` (`settle-judge.ts`): drop `env: {}` (their kinds are `log` / `card`; the table now writes the log
  row or suppresses the generic text).

- [ ] **Step 6: Sweep.** `runInvariantSweep` is ~105 lines: extract `alertViolation(input, violation, opened, alertsSent): "sent" | "logged" | "suppressed" | "silent"`
  for the per-violation block and `resolveStale(input, seen): number` for the resolved loop; the edits go in them. The
  tests importing `buildIncidentOpenedText`/`buildIncidentResolvedText` (`tests/run/incident-alert.test.ts:7,46`,
  `tests/run/invariant-sweep.test.ts:6,113`) change here. In the per-violation block, after `openIncident`:
  ```ts
  const n = incidentNotice(violation.kind, violation.subject);
  if (n?.topic === "incident_log") { input.store.enqueueNotification({ topic: "incident_log", idempotency_key: `incident_opened:${opened.incident_id}`, correlation_id: opened.incident_id, text: n.text, now: input.now }); continue; }
  if (n === null) { alertsSent += 1; continue; }   // a card kind counts toward the cap; its caller sends the card (no sweep kind is a card today)
  ```
  then today's chat/flap/cap logic with `topic: "incident_page"` and `n.text`. Summary: `topic: "incident_summary"`, text
  `⚠️ {suppressed} more alerts were held back this round (storm cap). /status shows what is open.` Resolved loop: enqueue
  only when `routeOf(open.kind) === "page"` (log kinds were written by `resolveIncident`), `incidentResolvedNotice` text.
  Delete `buildIncidentOpenedText`/`buildIncidentResolvedText` once no caller remains (orphans of this change); keep
  `buildSweepSummaryText` with the new text.

- [ ] **Step 7: Reminder.** `REMIND_KINDS` = `role_unresolved`, `planner_session_reset_failed` (24 h) plus
  `omp_contract_drift` at `7 * 24 h` with action ``"still open after a week: Houge's omp contract check fails; ask Claude to look"``.
  Change the map value to `{ action: string; after_ms: number }`; `reminderText` reads `after_ms` per kind. Update the
  header comment listing what is left out.

- [ ] **Step 8: Run** `npm run typecheck && npx vitest run` → green, none skipped.

- [ ] **Step 9: Commit.** `feat(incidents): route by kind at every opener, resolve logging, reminder set (§5)`.

---

### Task 4: Models — renamed Gemini, one line per move, card-tap override retirement

**Files:**
- Modify: `src/omp/model-tiers.ts` (gemini-pro pattern, `PROVIDER_LABEL`, `TIER_FAMILY`, `proposalsFor`),
  `src/gateway/model-tier-commands.ts` (import `PROVIDER_LABEL`; no-proposal sentence; tap writes `via: "tap"`),
  `src/omp/model-roles-tick.ts` (`Written.moved.from`, `moveLines`, `retireCardOverrides`, `settle` order),
  `src/run/run-store.ts` (`recordModelRoleOverride` optional `via`, `latestOverrideRows`), `src/run/run-ledger.ts:348`
  (allow-list adds `via`).
- Test: `tests/omp/model-tiers.test.ts`, `tests/omp/model-roles-tick.test.ts`, `tests/gateway/model-tier-commands.test.ts`,
  new `tests/omp/card-override-retire.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  export const PROVIDER_LABEL: Readonly<Record<string, string>>;           // moved, same values
  export const GEMINI_NOT_PRO: string;                                     // "flash|flashlite|lite|preview|image|audio|tts|live|embedding|nano|vision"
  RunStore.recordModelRoleOverride(i: { key: OverrideKey; pattern: string; actor: string; via?: "tap" }): void;
  RunStore.latestOverrideRows(): Map<OverrideKey, { pattern: string; via: string | null; sequence: number;
    prev: { event_type: string; payload: Record<string, unknown> } | null }>;
  export function moveLines(moved: Written["moved"], changed: Array<{ key: string; from: string | null; to: string | null }>):
    { lines: string[]; explained: Set<string> };
  export function retireCardOverrides(store: RunStore, notify: (text: string) => void): string[]; // keys retired; writes the reset rows and notifies each log line
  ```

- [ ] **Step 1: Failing tests** (full bodies):
  1. Pattern on today's catalog ids (`gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-3.1-flash-lite`,
     `gemini-3.5-flash-lite`, `gemini-3.8-flash`, `gemini-4-argon`, `gpt-oss-120b`, `tab_flash_lite_preview`,
     `tab_jump_flash_lite_preview`): `tierMembers(gemini-pro)` = `["gemini-4-argon"]`; `tierVersion` = `[4, 0]`;
     `gemini-3.5-pro` matches `[3, 5]`; one negative per `GEMINI_NOT_PRO` word (`gemini-4-image`, … `gemini-4-flashlite`).
     `gemini-flash` members unchanged.
  2. `proposalsFor(gemini-pro)` on that catalog with `gemini-4-argon` removed → `[]` (`gpt-oss-120b` is not `gemini-`);
     kimi family keeps `k`+digit ids only; `tierCardText` no-proposal sentence says "no other gemini model".
  3. (Tick tests assert the collected `notify` texts — the tick never touches the outbox; the daemon wiring test
     `tests/telegram/telegram-daemon.test.ts` asserts that a notice becomes one `change_log` row with no chat. Same for
     tests 5–6.) A tick whose kimi tier moves k3 → k3.1-pro with roles tiny, judges:0, reviewer heads moving → exactly one
     notice ``"🔁 Kimi K: k3 → k3.1-pro (used by Tiny, Judges 0, Reviewer)"`` and no per-role line; a key changed
     by an override (no move) keeps its `changeLine`.
  4. Tap → override row has `via: "tap"`; `/models set` row has no `via`.
  5. Retirement (one test each): tap-marked override on `judges:2 = gemini-4-argon` + tier adopts argon → reset row
     (`pattern ""`, actor `houge:tier`), one `model_change` row ``"Judges 2 now follows Google's pro tier (gemini-4-argon); your card choice is no longer needed."``,
     resolution row `source: "list"` for `judges:2`, zero shadow lines; legacy adjacency (a run-less `model_probe` tap-pass
     row immediately before a `via`-less override) → retired; tap → `/models reset` → `/models set judges 2 gemini-4-argon`
     → kept; head older than P → kept; override pattern not a tier member → kept.
  6. `settle` order: one tick produces at most one `model_roles_resolved` row and the retirement precedes it (assert the
     row's `judges:2.source === "list"`).

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Tiers.**
  ```ts
  export const GEMINI_NOT_PRO = "flash|flashlite|lite|preview|image|audio|tts|live|embedding|nano|vision";
  // in TIERS:
  { id: "gemini-pro", provider: "google-antigravity",
    pattern: new RegExp(`^gemini-(\\d{1,2})(?:\\.(\\d{1,2}))?-(?!(?:${GEMINI_NOT_PRO})$)[a-z]+$`), label: "pro" },
  export const PROVIDER_LABEL: Readonly<Record<string, string>> = { anthropic: "Anthropic", "google-antigravity": "Google", "openai-codex": "OpenAI", "kimi-code": "Kimi" };
  const TIER_FAMILY: Readonly<Record<TierId, RegExp>> = { "opus@anthropic": /^claude-/, "opus@antigravity": /^claude-/, "sonnet@anthropic": /^claude-/,
    "sonnet@antigravity": /^claude-/, "gemini-flash": /^gemini-/, "gemini-pro": /^gemini-/, "codex-sol": /^gpt-/, kimi: /^k\d/ };
  ```
  `isProposal` adds `TIER_FAMILY[def.id].test(m.id)`. Header comment: cite spec 2026-11-03 §6.1 and that it replaces
  2026-11-02 §4.4's "never a codename without a tap" for Gemini.

- [ ] **Step 4: One line per move.** `Written.moved` entries become `{ tier, from: string | null, head: string }` (`from` =
  `selectorOf(tier, p.before.adopted)`). `moveLines`:
  ```ts
  export function moveLines(moved: Written["moved"], changed: ReadonlyArray<{ key: string; from: string | null; to: string | null }>) {
    const explained = new Set<string>(); const lines: string[] = [];
    for (const m of moved) {
      const keys = changed.filter((c) => c.to !== null && bare(c.to) === m.head).map((c) => c.key);
      keys.forEach((k) => explained.add(k));
      const label = `${PROVIDER_LABEL[tierDef(m.tier).provider] ?? tierDef(m.tier).provider} ${tierDef(m.tier).label}`;
      lines.push(`🔁 ${label}: ${idOf(m.from)} → ${idOf(m.head)}${keys.length ? ` (used by ${keys.map(roleWords).join(", ")})` : ""}`);
    }
    return { lines, explained };
  }
  // bare(sel) strips ":effort"; idOf("kimi-code/k3") === "k3", idOf(null) === "nothing"; roleWords("judges:0") === "Judges 0", "tiny" → "Tiny"
  ```
  In `settle`: notify each `moveLines(...).lines`, then `changeLine` only for changed keys not in `explained`.

- [ ] **Step 5: Override marker and reader.** `recordModelRoleOverride` writes `via` only when given; ledger allow-list
  `model_role_override: ["key", "pattern", "actor", "via"]`. The tap (`model-tier-commands.ts:101`) passes `via: "tap"`.
  `latestOverrideRows()`:
  ```sql
  SELECT sequence, payload_json FROM ledger_events WHERE event_type = 'model_role_override' AND run_id IS NULL
    ORDER BY sequence ASC, occurred_at ASC, event_id ASC   -- the same order latestModelRoleOverrides uses
  -- and for each key's latest row:
  SELECT event_type, payload_json FROM ledger_events WHERE run_id IS NULL AND sequence < ? ORDER BY sequence DESC LIMIT 1
  ```

- [ ] **Step 6: `retireCardOverrides`** (spec §6.4), called in `settle` after `writeTiers` and before `i.roles.resolveAll()`:
  for each `[key, row]` with `row.pattern !== ""`: find the tier T whose `soleKeysOf(T)` includes key; skip if none;
  card-written = `row.via === "tap"` or (`row.prev?.event_type === "model_probe"` and its payload has `purpose: "tap"`,
  `result: "pass"`, `tier: T`, `selector: \`${provider}/${row.pattern}\``); retire when card-written, `tierVersion(T, row.pattern) !== null`,
  and T's adopted head (after `writeTiers`, read `store.listModelTiers()`) has `compareVersions(head, pattern) >= 0`. Retire =
  `recordModelRoleOverride({ key, pattern: "", actor: "houge:tier" })` + log line (`model_change`). The resolver reads
  overrides per call (`latestModelRoleOverrides`), so `resolveAll()` after it sees the reset.

- [ ] **Step 7: Run** `npm run typecheck && npx vitest run` → green.

- [ ] **Step 8: Commit.** `feat(models): renamed Gemini joins the pro tier; one line per move; retire card-tap overrides (§6)`.

---

### Task 5: `/changes` and the `/status` line

**Files:**
- Create: `src/notifications/change-log-view.ts`, `tests/notifications/change-log-view.test.ts`
- Modify: `src/triggers/telegram-command-parser.ts` (`/changes`; `parseStatus` accepts `changes`), the `status` command type
  (`view?: "decisions" | "changes"`), `src/gateway/gateway.ts` (`statusPayload` branch, the self-check line via
  `changesLine`, help text), `src/status/status-query.ts` (open incidents counted by route).
- Test: `tests/triggers/telegram-command-parser.test.ts`, `tests/gateway/status*.test.ts` (whichever asserts the self-check line).

**Interfaces:**
- Consumes: Task 1 `listChangeLog`, `countChangeLogSince`; Task 2 `routeOf`.
- Produces: `changesText(store: RunStore, now: string, env?: NodeJS.ProcessEnv): string`; `CHANGES_MAX_CHARS = 3900`.

- [ ] **Step 1: Failing tests** (full bodies):
  1. Parser: `/changes` and `/status changes` → `{ type: "status", view: "changes" }`; `/changes x` → invalid.
  2. `changesText`: 3 rows render newest first as `DD Mon HH:MM · {text}` in the display zone (set `HOUGE_DISPLAY_TZ` the
     way existing status tests do); empty → `No background changes in the last 30 days.`; 25 rows of 300 chars → at most 20
     rows, `length <= 3900`, ends with `… {N} older`; a 400-char text is cut on a word boundary to ≤ 300 with `…` and a
     trailing unmatched backtick removed; rows older than 30 days are excluded.
  3. `/status`: with 1 open page kind, 2 open log kinds, 4 change rows this week →
     the self-check line ends `· 1 paged · 2 internal open · 4 changes this week · /changes`; a `/status` reply writes one
     outbox row and zero `change_log` rows.
  4. `/help` lists `/changes`.
  5. §8 end to end: open `todo_reminder_seen` (subject a bare chat id), `core_overflow` (`chat:<id>`),
     `hostile_schedule_turn` (`run_<uuid>`, `event: true`) and `standing_settle_failed` (`run:<id>`) through their real
     openers' subject shapes via `openAlertedIncident`, then `changesText` — assert none of `run_[0-9a-f-]{36}`,
     `-?\d{6,}`, `appr_`, `notif_`, `chg_` appears.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** `change-log-view.ts`:
  ```ts
  export const CHANGES_MAX_CHARS = CHAT_TEXT_MAX;   // export CHAT_TEXT_MAX (3900) from run-store.ts; one bound for chat text
  const ROW_MAX = 300, DAYS = 30, MAX_ROWS = 20;
  export function changesText(store: RunStore, now: string, env: NodeJS.ProcessEnv = process.env): string {
    const since = new Date(Date.parse(now) - DAYS * 86_400_000).toISOString();
    const rows = store.listChangeLog(since, MAX_ROWS + 1000);
    if (rows.length === 0) return "No background changes in the last 30 days.";
    const zone = resolveDisplayZone(env);
    const out: string[] = ["🗂 **Background changes** (last 30 days)"];
    let used = out[0]!.length, shown = 0;
    for (const r of rows) {
      const line = `${stamp(r.created_at, zone)} · ${cut(r.text)}`;
      if (shown === MAX_ROWS || used + line.length + 1 + 20 > CHANGES_MAX_CHARS) break;
      out.push(line); used += line.length + 1; shown += 1;
    }
    if (shown < rows.length) out.push(`… ${rows.length - shown} older`);
    return out.join("\n");
  }
  ```
  `stamp` formats `DD Mon HH:MM` from `formatInstantInZone`; `cut` = trim to `ROW_MAX - 1` at the last space, append `…`,
  drop a trailing unmatched backtick (odd count). Use `countChangeLogSince` for the `… N older` total if `rows` was capped.

- [ ] **Step 4: Gateway.** `statusPayload`: `status_view === "changes"` → `{ text: changesText(this.runStore, now) }`.
  The self-check line (`gateway.ts:~1342`) is built by a new `changesLine(now)` helper beside `carryLine`:
  `Self-check: swept {t} ago · {P} paged · {M} internal open · {C} changes this week · /changes` where P/M count
  `listOpenIncidents()` by `routeOf(kind)` (`card` counts as paged) and C = `countChangeLogSince(now − 7 × 24 h)`.
  Help: add `"/changes — 后台变更记录（模型切换、内部自检）"` next to `/status`.

- [ ] **Step 5: Run** `npm run typecheck && npx vitest run` → green.

- [ ] **Step 6: Commit.** `feat(status): /changes and the self-check line by route (§7)`.

---

### Task 6: Gates — amended on purpose, the slice gate, rollback (orchestrator)

**Files:**
- Modify: `scripts/live-gate-ladder-remainder-r1.mjs`, `-r2.mjs`, `-r3.mjs`, `-r4.mjs`, `-r5.mjs`, `-r6.mjs`,
  `scripts/live-gate-loud-degradation.mjs`, `scripts/live-gate-model-tiers.mjs`, `scripts/live-gate-omp-probe.mjs` — every assertion that reads an
  `incident_opened:` / `incident_remind` / `model_roles:notice` / `model_tier_card` outbox row for a kind or notice that
  now routes to the log reads the `change_log` row instead; model-tiers plants an empty synthetic family tier for the card
  path (argon is no longer a proposal).
- Create: `scripts/live-gate-chat-is-for-paco.mjs`, `scripts/check-chat-is-for-paco-rollback.mjs`.

- [ ] **Step 1:** `grep -n "incident_opened\|incident_remind\|incident_resolved\|outboxRows\|outboxN\|notification_outbox\|model_roles\|model_tier_card\|gemini-4-argon" scripts/*.mjs`;
  per hit, name the kind the gate opens and its §5.3 route; amend each hit whose kind/topic is now `log`. Known (plan
  review B1): `live-gate-omp-probe.mjs:157` (`omp_contract_drift` → one `change_log` row, zero outbox);
  `live-gate-loud-degradation.mjs:219-221` line 5 (`hostile_schedule_turn` → one `incident_log` row, zero outbox) and its
  reminder kinds (:34); r2–r6 `outboxN()` deltas around `decision_record_failed` (alerts +0, `change_log` +1);
  `live-gate-model-tiers.mjs` (:38 PROPOSAL, :201 card key, :207 enqueue gains `topic: "model_card"`). Checked
  unaffected: `live-gate-ladder-2b-hooks`, `stage4b/4c`, `memory-write`, `improve-route`, `decisions-2a`, `jev-version`,
  `jev-tree`. A page-kind hit stays as is.
- [ ] **Step 2: Slice gate** on a `VACUUM INTO` copy (temp dir, `finally` deletes it), Telegram stubbed, imports `../dist/`.
  Preflight: one real `omp --profile houge models --json` (the read Houge makes daily) captures catalog ids; the tick then
  runs on a `roles` stub fed those ids, a stub probe (`pass` unless a line says otherwise), `HOUGE_MODEL_ROLES=resolved`,
  `now = latest model_roles_resolved + 25 h`. Lines 1–8 exactly as spec §10 (each prints `PASS n` / `FAIL n: <code>`; exit 1
  on any FAIL; no ids or message text printed).
- [ ] **Step 3: Rollback check** (pattern: `scripts/check-loud-degradation-rollback.mjs`): a worktree of the merge base,
  built; boot its store on a post-slice copy that holds `change_log` rows and a retired `judges:2` override; assert it opens,
  reads, and that its tick reopens `role_unresolved` for `judges:2` (the §10 residual), no crash.
- [ ] **Step 4:** Run all amended gates, the slice gate and the rollback check; record outputs in the ledger.
- [ ] **Step 5: Commit** per concern: `test(gates): earlier gates read change_log for log-routed notices`,
  `test(gate): chat-is-for-paco live gate`, `test(gate): chat-is-for-paco rollback check`.

---

### Task 7: Docs (orchestrator)

- [ ] ADR 0031 `docs/decisions/0031-chat-carries-what-needs-paco.md` (status: awaiting Paco's signature) and its README
  row; amendments to ADR 0024, 0028, 0029, 0030 per spec §9, each with the README index line updated.
- [ ] `CONTEXT.md`: **Change log** — "a background notice that left chat: a `change_log` row, read through `/changes`".
- [ ] `docs/reference/configuration.md`: no new env var (state none); README command list gains `/changes`.
- [ ] ROADMAP delta; `tasks/todo.md` state block; `tasks/lessons.md`; `sessions.md` entry.
- [ ] Commit: `docs: chat is for Paco — ADR 0031, amendments, state`.

---

## Self-review

- **Spec coverage:** §4.1–4.3 → T1; §5.1–5.3 → T2 (table, text, masking, typed kinds) + T3 (openers, cards, sweep, resolve,
  reminder); §5.4/§9 → T7; §6.1–6.4 → T4; §7 → T5; §8 → T2 masking + T5 view tests + T6 gate line 6; §10 → T6;
  §11 residuals → T7 docs. Rulings P1–P6 cover the plan-level choices.
- **Types:** `NotificationIntent`/`ChatIntent`/`LogIntent`, `NotificationQueueResult` (`logged`, `duplicate_log`),
  `routeOf`, `incidentNotice`, `operatorChat`, `resolveIncident(…, opts)`, `latestOverrideRows`, `moveLines`,
  `retireCardOverrides`, `changesText` — each defined once and consumed by the names above.
