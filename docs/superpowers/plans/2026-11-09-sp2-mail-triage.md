# SP2 slice 1 — Paco's Gmail read + inbound triage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Houge polls Paco's Gmail (read-only), triages each new mail through a new ladder entry `mail.triage` (code floors and sender rules, then one Jev question), pings Paco with a card or files the mail in `/inbox`, and lets the planner read Paco's mail on demand.

**Architecture:** A daemon tick (`src/mail/poller.ts`) reads Gmail history since a stored cursor, builds a code-owned redacted envelope per mail, decides `mail.triage` with a queuing recorder (Jev is async), then writes item + decision row + outbox card in one synchronous transaction using a strict flush. ADR 0034 gains rule 2.6 (a `perItemRouting` arm in `entryProblems`). Commands, taps, incidents, retention and the CLI hang off small focused modules under `src/mail/`.

**Tech Stack:** Node + TypeScript, `node:sqlite` (`RunStore`), vitest; zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-11-09-sp2-mail-triage-design.md` (Rev 1.3, approved by Paco 2026-11-09, including the ADR 0034 rule 2.6 change of meaning). Executors read the spec section each task names.

**Interface facts:** `/private/tmp/claude-501/-Users-xiaochuan-Projects-adventure/63a581ab-8d09-4840-a85b-58b78129f365/scratchpad/sp2/facts.md` — a verified fact sheet of the exact current signatures this plan builds on (sections 1–15). Read the sections a task names before editing.

## Global Constraints

- `dependencies: {}` stays empty. Node stdlib + devDeps only.
- Functions under 50 lines. Match surrounding style. Every changed line traces to the spec.
- Never open the live `houge.sqlite` in tests or the implementation; tests use `RunStore.openInMemory()` or a temp file.
- Synthetic mail only in tests, fixtures and docs (the repo is PUBLIC): senders under `example.com`, subjects invented.
- Never log, ledger or print sender address, sender name, subject or snippet; logs carry ids, counts and codes only.
- Telegram output goes through the outbox and the rich renderer; never call `sendMessage` from mail code.
- Every Gmail request from `src/mail/` is a GET under `/gmail/v1/users/me/`; never `format=full` or `format=raw`; never an attachments path.
- `HOUGE_MAIL_ENABLED` default off; it is in `DISARM_FLAGS`.
- Bars: Jev `now` at p ≥ 0.6 → ping; Jev `later` at p ≥ 0.85 → inbox; anything else → ping. Fold: ≥ 6 `lane='ping'` items stored in the last 60 min → the next is `inbox`/`folded`.
- Text caps: `HEADER_FIELD_CAP` (200) for `from_name` and `subject`, `SNIPPET_CAP` (300), exported from `src/capabilities/gmail-read.ts` (never restated).
- Redaction call, exactly: `redactForJudge(text, { brokerRedact: (s) => store.redactSecretValues(s), codeShapes: true, linkTokens: true })`.
- Address allowlist, exactly: `/^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/`, lower-cased; failures are stored as `invalid`.
- `MailJevState` key set, exactly: `from_name, from_address, known_sender, subject, snippet, labels, important`.
- Callback data ≤ 64 bytes, carries ids only, never an address.
- Commit messages: Conventional Commits, end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; stage files by name.
- Run `npm run typecheck` and the task's tests before each commit; the full suite runs at Tasks 6, 9 and 12.

## File structure

| File | Responsibility |
|---|---|
| `src/decisions/types.ts` (modify) | `inbound` stage, `inbox` announce, `perItemRouting` on `Entry` |
| `src/decisions/registry.ts` (modify) | rule 2.6 arm in `shapeProblems` and `effectProblems`; register `MAIL_TRIAGE` |
| `src/decisions/record.ts` (modify) | `recordStrict`, `afterStrictRecord`; `MAIL_TRIAGE_ID` in `JEV_PAGED_ELSEWHERE` |
| `src/decisions/entry-ids.ts` (modify) | `"mail.triage"` |
| `src/decisions/entries/mail-triage.ts` (new) | the entry, its rule rung, `perItemRouting`, bars |
| `src/jev/questions/mail.ts` (new) | `MAIL_URGENCY`, `MAIL_KIND` |
| `src/jev/mail-ask.ts` (new) | run-less Jev call for one item |
| `src/jev/decide.ts` (modify) | `DecisionPoint` gains `"mail"` |
| `src/mail/envelope.ts` (new) | `MailItemState`, `MailJevState`, address parse, text redaction |
| `src/mail/gmail-client.ts` (new) | Gmail GETs the poller needs (history, metadata get, profile, sent probe, resync list) |
| `src/mail/triage.ts` (new) | per-item decide + fold/thread + one-transaction write |
| `src/mail/poller.ts` (new) | the tick: gates, cursor, range, deadline, first run, resync, auth failure |
| `src/mail/card.ts` (new) | card text and buttons; quiet hours |
| `src/mail/flag.ts` (new) | `resolveMailEnabled`, poll minutes, quiet window, text days |
| `src/mail/inbox.ts` (new) | `/inbox` and `/mail status` text, rule apply/undo, label writes |
| `src/mail/retention.ts` (new) | daily text sweep and `purge` |
| `src/run/run-store.ts` (modify) | DDL + migration + mail store methods |
| `src/run/incident-route.ts`, `src/run/incident-alert.ts`, `src/run/invariant-sweep.ts` (modify) | `mail_auth_lost`, `mail_poll_failing` |
| `src/notifications/notification-types.ts`, `telegram-notification-adapter.ts`, `src/telegram/telegram-client.ts` (modify) | `silent`, URL buttons |
| `src/notifications/topics.ts` (modify) | `mail_card`, `mail_log` |
| `src/config/secret-broker.ts`, `src/config/disarm-posture.ts` (modify) | Paco's token getter; disarm flag |
| `src/capabilities/google-api.ts`, `gmail-read.ts`, `src/core/core-worker.ts`, `src/omp/tools/{gmail_read,google_api}.json` (modify) | `account: "paco"` |
| `src/triggers/telegram-command-parser.ts`, `telegram-trigger-adapter.ts`, `src/domain/types.ts`, `src/gateway/gateway.ts`, `src/gateway/mail-commands.ts` (new) | commands and taps |
| `src/telegram/telegram-daemon.ts` (modify) | tick wiring |
| `src/cli.ts`, `scripts/gmail-auth.mjs` (modify) | `houge mail auth`, `houge mail purge --yes` |
| `scripts/live-gate-mail-triage.mjs`, `scripts/check-mail-triage-rollback.mjs` (new) | gates |

---

### Task 1: Ladder plumbing — rule 2.6 arm, `inbound` stage, `inbox` announce, strict flush

**Spec:** §3.4 (effects, `perItemRouting`, write path, `JEV_PAGED_ELSEWHERE`), §8.1. **Facts:** §3.

**Files:**
- Modify: `src/decisions/types.ts`, `src/decisions/registry.ts`, `src/decisions/record.ts`
- Test: `tests/decisions/registry-routed.test.ts` (new), `tests/decisions/record-strict.test.ts` (new)

**Interfaces:**
- Produces: `DECISION_STAGES` includes `"inbound"`; `Announce = "card" | "changes" | "inbox" | "none"`; `Entry.perItemRouting?: (...args: never[]) => boolean`;
  `export function routedPerItem(e: AnyEntry): boolean` (registry.ts);
  `export function recordStrict(store: RunStore, entry: AnyEntry, r: AnyDecideResult, ctx: { run_id: string | null; tool_call_id: string | null }, now: string): string | null` — returns the decision id, `null` only when `shouldRecord` says no row, **throws** on insert failure;
  `export function afterStrictRecord(store: RunStore, entry: AnyEntry, r: AnyDecideResult, now: string, env?: NodeJS.ProcessEnv): void` — the `clearFallback` + `afterRecord` bookkeeping, run after commit.

- [ ] **Step 1: Write the failing registry test**

```ts
// tests/decisions/registry-routed.test.ts
import { describe, expect, it } from "vitest";
import { entryProblems } from "../../src/decisions/registry.js";
import type { AnyEntry, VerdictEffect } from "../../src/decisions/types.js";

const card: VerdictEffect = { kind: "effect", reversible: false, announced: "card", what: "a card now" };
const inbox: VerdictEffect = { kind: "effect", reversible: true, announced: "inbox", what: "listed in /inbox" };
const bar = { kind: "provisional", question: "q", criteriaHash: "h", p: 0.6, source: "test" } as const;
function routed(over: Partial<Record<string, unknown>> = {}): AnyEntry {
  return {
    id: "test.routed", version: 1, stage: "inbound", input: "tool", question: "q?",
    verdicts: ["ping", "inbox"], fail: "ping", defaultVerdict: "ping", alwaysRecord: true,
    ladder: [{ kind: "rule", name: "r", decide: () => ({ abstain: true }) },
      { kind: "system_one", name: "j", questions: [], bars: bar, timeoutMs: 1000 }],
    outcomes: [], armed: { rule: "on", system_one: "on" },
    effects: { ping: card, inbox }, perItemRouting: () => true, reasonCodes: [], ...over
  } as unknown as AnyEntry;
}

describe("ADR 0034 2.6 — the perItemRouting arm", () => {
  it("passes a two-lane tool entry whose default and fail are the card lane", () => {
    expect(entryProblems(routed())).toEqual([]);
  });
  it("fails the same entry without the predicate", () => {
    expect(entryProblems(routed({ perItemRouting: undefined })).length).toBeGreaterThan(0);
  });
  it("fails a third verdict", () => {
    const e = routed({ verdicts: ["ping", "inbox", "drop"], effects: { ping: card, inbox, drop: { kind: "effect", reversible: true, announced: "inbox" } } });
    expect(entryProblems(e).length).toBeGreaterThan(0);
  });
  it("fails when the default is the inbox lane", () => {
    expect(entryProblems(routed({ defaultVerdict: "inbox", fail: "inbox" })).length).toBeGreaterThan(0);
  });
  it("fails mixed or paco input with the predicate", () => {
    expect(entryProblems(routed({ input: "mixed" })).length).toBeGreaterThan(0);
  });
  it("fails an inbox lane that is not reversible", () => {
    expect(entryProblems(routed({ effects: { ping: card, inbox: { ...inbox, reversible: false } } })).length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it — expect failures** (type errors on `"inbound"` / `"inbox"`, then the first case failing).

Run: `npx vitest run tests/decisions/registry-routed.test.ts`

- [ ] **Step 3: Implement types**

In `src/decisions/types.ts`:
```ts
export const DECISION_STAGES = ["intake", "pre_model", "pre_tool", "post_tool", "supervision", "settle", "after_turn", "inbound"] as const;
/** How Paco learns of it: a code-built card (with its Undo / Dig deeper), a `/changes` row naming the undo command (spec 2026-11-07 §4), a listing in `/inbox` with a should-have-pinged tap (a pull surface, accepted only under ADR 0034 rule 2.6), or not at all. The turn's reply is not an announcement (Paco 2026-10-12). */
export type Announce = "card" | "changes" | "inbox" | "none";
```
On `Entry`, beside `pacoWordsOnly`:
```ts
  /** ADR 0034 2.6: a runtime gate the caller runs before writing; true only for one item's state and a verdict in the two lanes. */
  perItemRouting?: (...args: never[]) => boolean;
```

- [ ] **Step 4: Implement the registry arm**

In `src/decisions/registry.ts`, add after `GATED_ANNOUNCED`:
```ts
const ROUTED_ANNOUNCED: ReadonlySet<Announce> = new Set(["card", "inbox"]);

/** ADR 0034 2.6: a tool-input entry that only routes one item between a card now (default and fail) and a reversible /inbox listing. */
export function routedPerItem(e: AnyEntry): boolean {
  if (e.input !== "tool" || typeof e.perItemRouting !== "function" || e.verdicts.length !== 2) return false;
  if (e.defaultVerdict !== e.fail) return false;
  const up = e.effects[e.defaultVerdict];
  const down = e.verdicts.find((v) => v !== e.defaultVerdict);
  const dn = down === undefined ? undefined : e.effects[down];
  if (!up || !dn || up.kind !== "effect" || dn.kind !== "effect") return false;
  return up.announced === "card" && dn.announced === "inbox" && dn.reversible && ROUTED_ANNOUNCED.has(up.announced);
}
```
In `shapeProblems`, extend the provisional clause condition with `&& !routedPerItem(e)` and the message text with `, and not a perItemRouting entry (ADR 0034 2.6)`.
In `effectProblems`, add as the line before the final `p.push(...)`:
```ts
    // ADR 0034 2.6: one item routed between a card now and a reversible /inbox listing
    if (routedPerItem(e)) continue;
```
`ANNOUNCED` and `GATED_ANNOUNCED` do not change.

- [ ] **Step 5: Run the registry test — expect PASS.** Also run `npx vitest run tests/decisions/registry.test.ts` (every existing entry still sound).

- [ ] **Step 6: Write the failing strict-flush test**

```ts
// tests/decisions/record-strict.test.ts
import { describe, expect, it } from "vitest";
import { RunStore } from "../../src/run/run-store.js";
import { recordStrict } from "../../src/decisions/record.js";
import type { AnyEntry, AnyDecideResult } from "../../src/decisions/types.js";

const entry = { id: "attach.path", version: 1, stage: "settle", alwaysRecord: true, defaultVerdict: "send", reasonCodes: ["checked"] } as unknown as AnyEntry;
const result = { verdict: "send", rung: "rule", reason: "checked", p: null, armedMode: "on", walk: [{ kind: "rule" }], latencyMs: 1 } as unknown as AnyDecideResult;

describe("recordStrict", () => {
  it("returns the decision id inside a caller's transaction", () => {
    const s = RunStore.openInMemory();
    const id = s.inTransaction(() => recordStrict(s, entry, result, { run_id: null, tool_call_id: "mi_x" }, "2026-11-09T00:00:00.000Z"));
    expect(id).toMatch(/^dec_/);
  });
  it("throws on an insert failure, so the caller's transaction rolls back", () => {
    const s = RunStore.openInMemory();
    const bad = { ...entry, stage: "not_a_stage" } as unknown as AnyEntry;
    expect(() => s.inTransaction(() => recordStrict(s, bad, result, { run_id: null, tool_call_id: null }, "2026-11-09T00:00:00.000Z"))).toThrow();
  });
});
```
Adjust the `AnyDecideResult` literal to the real field names in `src/decisions/types.ts` (read it) — the test must construct a result `rowOf` accepts.

- [ ] **Step 7: Implement `recordStrict` and `afterStrictRecord`** in `src/decisions/record.ts`, reusing the private `rowOf`, `shouldRecord`, `clears`, `clearFallback`, `afterRecord`:

```ts
/** Spec 2026-11-09 §3.4: the mail write path's flush. Same row as storeRecorder, but it throws on a failed insert so the caller's transaction rolls back. Bookkeeping runs after commit via afterStrictRecord. */
export function recordStrict(store: RunStore, entry: AnyEntry, r: AnyDecideResult, ctx: { run_id: string | null; tool_call_id: string | null }, now: string): string | null {
  if (!shouldRecord(entry, r)) return null;
  return store.insertDecision(rowOf(entry, r, ctx, now));
}

/** The bookkeeping storeRecorder does around its insert, for a row recordStrict wrote; call it after the commit. */
export function afterStrictRecord(store: RunStore, entry: AnyEntry, r: AnyDecideResult, now: string, env?: NodeJS.ProcessEnv): void {
  if (clears(entry.id, r)) clearFallback(store, entry.id, now);
  afterRecord(store, entry, r, now, env);
}
```

- [ ] **Step 8: Run both tests and `npm run typecheck` — expect PASS.**

- [ ] **Step 9: Commit**

```bash
git add src/decisions/types.ts src/decisions/registry.ts src/decisions/record.ts tests/decisions/registry-routed.test.ts tests/decisions/record-strict.test.ts
git commit -m "feat(decisions): ADR 0034 2.6 perItemRouting arm, inbound stage, inbox announce, recordStrict"
```

---

### Task 2: Mail store — tables, migration, store methods

**Spec:** §4 (DDL verbatim), §3.2 (cursor), §3.4 (fold/thread), §3.6 (`/inbox` paging, `seen_at`). **Facts:** §1, §2.

**Files:**
- Modify: `src/run/run-store.ts`
- Test: `tests/run/mail-store.test.ts` (new)

**Interfaces (all on `RunStore`):**
```ts
export type MailLane = "ping" | "inbox";
export type MailKind = "fyi" | "action" | "risk" | "noise";
export type MailReason = "jev_now" | "jev_later" | "jev_unsure" | "jev_unavailable" | "rule_always" | "rule_never" | "own_output" | "backfill" | "folded" | "routing_refused";
export interface MailItemInsert { item_id: string; gmail_message_id: string; gmail_thread_id: string; from_address: string; from_name: string | null;
  known_sender: boolean; labels: readonly string[]; important: boolean; received_at: string; subject: string | null; snippet: string | null;
  lane: MailLane; kind: MailKind | null; reason_code: MailReason; thread_followup: boolean; decision_id: string | null; notification_id: string | null; created_at: string }
export interface MailItemRow extends MailItemInsert { seen_at: string | null; text_cleared_at: string | null }
export interface MailStateRow { enabled: boolean; history_id: string | null; last_ok_at: string | null; last_error_code: string | null; failing_since: string | null;
  last_attempt_at: string | null; backoff_n: number; retention_on: string | null }
insertMailItem(i: MailItemInsert): void                      // throws on duplicate gmail_message_id
hasMailItem(gmail_message_id: string): boolean
getMailItem(item_id: string): MailItemRow | undefined
setMailItemNotification(item_id: string, notification_id: string): void
mailState(): MailStateRow                                     // creates the single row (enabled 0) on first read
setMailState(patch: Partial<MailStateRow>): void
countMailPingsSince(sinceIso: string): number                 // lane='ping' AND created_at >= since
threadPingedSince(thread_id: string, sinceIso: string): boolean
listUnseenInbox(limit: number, offset: number): MailItemRow[] // lane='inbox' AND seen_at IS NULL ORDER BY received_at ASC
countUnseenInbox(): number
listInboxSince(sinceIso: string, limit: number): MailItemRow[]// lane='inbox', any seen state, received_at >= since, newest first
markMailSeen(item_ids: readonly string[], now: string): void
upsertSenderRule(r: { rule_id: string; address: string; action: "always" | "never"; source_item_id: string | null; created_at: string }): void  // replaces an existing rule for the address
senderRule(address: string): { rule_id: string; action: "always" | "never" } | undefined
deleteSenderRule(rule_id: string): { address: string; action: "always" | "never" } | undefined
insertMailLabel(l: { label_id: string; item_id: string; label: "wrong_urgency" | "should_have_pinged"; created_at: string }): void
senderInSent(address: string, sinceIso: string): boolean | undefined   // cached row checked_at >= since, else undefined
cacheSenderInSent(address: string, in_sent: boolean, now: string): void
mailItemsTextBefore(cutoffIso: string): string[]              // item_ids with text not yet cleared and received_at < cutoff
clearMailItemText(item_ids: readonly string[], now: string): void
mailCardNotificationIds(item_ids: readonly string[]): string[]
replaceNotificationPayload(notification_id: string, payload: NotificationPayload): void   // recomputes payload_hash with stableHash
clearMailSenders(): void
```

- [ ] **Step 1: Write failing tests** covering, each as its own `it`:
  1. migration creates the five tables and is idempotent (`RunStore.open(path)` twice; `schema_migrations` has `2026-11-09-mail-triage` once);
  2. `insertMailItem` then `hasMailItem` true; a second insert with the same `gmail_message_id` throws;
  3. CHECKs: `lane: "drop"`, `kind: "spam"`, `reason_code: "x"` each throw;
  4. `countMailPingsSince` counts only `lane='ping'` at or after the cutoff;
  5. `threadPingedSince` true only for a `ping` row of that thread after the cutoff;
  6. `listUnseenInbox` returns oldest first, pages with limit/offset, excludes `ping` and seen rows; `markMailSeen` removes them from the next page;
  7. `upsertSenderRule` replaces (`always` then `never` for the same address leaves one row, action `never`); `deleteSenderRule` returns the deleted rule;
  8. `mailState()` on a fresh store is `{ enabled: false, history_id: null, ... }`; `setMailState({ history_id: "123" })` persists;
  9. `senderInSent` returns undefined when stale, the cached value when fresh;
  10. `replaceNotificationPayload` changes `payload_json` and `payload_hash` (hash equals `stableHash(payload)` from the module the dispatcher uses — find it by grepping `stableHash` in `src/`).
  Use `RunStore.openInMemory()` except test 1 (temp file via `mkdtempSync`).

- [ ] **Step 2: Run — expect FAIL.** `npx vitest run tests/run/mail-store.test.ts`

- [ ] **Step 3: Implement.** Add `MAIL_TRIAGE_DDL` (the spec §4 SQL verbatim, every `CREATE TABLE` / `CREATE INDEX` as `IF NOT EXISTS`, with `thread_followup INTEGER NOT NULL DEFAULT 0` on `mail_items`, and three plan-added columns on `mail_state` the spec's DDL left implicit: `last_attempt_at TEXT`, `backoff_n INTEGER NOT NULL DEFAULT 0` (poll backoff, §7) and `retention_on TEXT` (the local date of the last retention sweep, §4)) next to `STANDING_APPROVAL_DDL`; `private applyMailTriageMigration()` copying `applyStandingApprovalMigration` with version `"2026-11-09-mail-triage"`; append its call after `this.applyHostileScheduleEventMigration();` in `migrate()`. Implement the methods with parameterised statements only; booleans stored as 0/1; `labels` as JSON text. Keep each method under 50 lines.

- [ ] **Step 4: Run the test file and `npm run typecheck` — expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/run/run-store.ts tests/run/mail-store.test.ts
git commit -m "feat(run): mail triage tables and store methods (additive migration 2026-11-09-mail-triage)"
```

---

### Task 3: Envelope, Jev questions, run-less ask

**Spec:** §3.3, §3.5. **Facts:** §4, §5, §6 (gmail-read caps).

**Files:**
- Create: `src/mail/envelope.ts`, `src/jev/questions/mail.ts`, `src/jev/mail-ask.ts`
- Modify: `src/capabilities/gmail-read.ts` (export `HEADER_FIELD_CAP`, `SNIPPET_CAP`, `headerValue`), `src/jev/decide.ts` (`DecisionPoint` gains `"mail"`)
- Test: `tests/mail/envelope.test.ts`, `tests/jev/mail-ask.test.ts`

**Interfaces:**
```ts
// src/mail/envelope.ts
export const HOUGE_GMAIL_ADDRESS = "wukong.houge@gmail.com";
export const ADDRESS_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/;
export interface GmailMetadata { id: string; threadId: string; snippet?: string; labelIds?: string[]; internalDate?: string; payload?: { headers?: { name: string; value: string }[] } }
export interface MailItemState { item_id: string; gmail_message_id: string; thread_id: string; from_address: string; from_name: string | null; known_sender: boolean;
  subject: string | null; snippet: string | null; labels: string[]; important: boolean; received_at: string; thread_pinged_6h: boolean; backfill: boolean }
export interface MailJevState { from_name: string | null; from_address: string; known_sender: boolean; subject: string | null; snippet: string | null; labels: string[]; important: boolean }
export function parseFrom(header: string | undefined): { address: string; name: string | null }   // address "invalid" when the allowlist fails
export function redactMailText(text: string | undefined, cap: number, brokerRedact: (s: string) => string): string | null
export function buildItemState(m: GmailMetadata, x: { item_id: string; known_sender: boolean; thread_pinged_6h: boolean; backfill: boolean; brokerRedact: (s: string) => string }): MailItemState
export function jevStateOf(s: MailItemState): MailJevState      // exactly the seven keys
// src/jev/questions/mail.ts
export const MAIL_URGENCY: ChoiceQuestion;   // id "mail_urgency", options in order ["later", "now"]
export const MAIL_KIND: ChoiceQuestion;      // id "mail_kind", options ["fyi", "action", "risk", "noise"]
// src/jev/mail-ask.ts
export const MAIL_THRESHOLD_VERSION = "2026-11-09.1";
export type MailAsk = { urgency: JevChoiceAnswer; kind: JevChoiceAnswer | undefined; model: string } | { failed: FallbackReason; reason?: SkipReason };
export async function askMail(i: { state: MailJevState; client: (r: JevRequest) => Promise<JevResult>; store: RunStore; now?: () => Date }): Promise<MailAsk>
```

- [ ] **Step 1: Failing envelope tests** (`tests/mail/envelope.test.ts`):
  - `parseFrom('"Ann Lee" <Ann.Lee@Example.com>')` → `{ address: "ann.lee@example.com", name: "Ann Lee" }`; `parseFrom("bob@example.com")` → name null; `parseFrom('x <a b@example.com>')` and `parseFrom('x <a@b@example.com>')` → address `"invalid"`;
  - a subject `"Your code is 482913"` and a snippet with `https://example.com/verify?token=abcdef123456` come back without `482913` and without `abcdef123456`;
  - a sender name containing `482913` is masked too;
  - a 500-char subject is capped (length ≤ 200 + mask slack: assert `<= 210`) and uses the exported `HEADER_FIELD_CAP`;
  - `jevStateOf(state)` has exactly the keys `["from_name","from_address","known_sender","subject","snippet","labels","important"]` (sorted compare) and no `received_at`, `thread_*`, `item_id`;
  - `important` is true iff `labelIds` contains `"IMPORTANT"`; `received_at` is ISO from `internalDate` (ms epoch string).
  `brokerRedact` in tests: `(s) => s`.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement `src/mail/envelope.ts`.** `redactMailText`: `undefined`/empty → `null`; otherwise `redactForJudge(sanitize(text).slice(0, cap), { brokerRedact, codeShapes: true, linkTokens: true })`, where `sanitize` is the text hygiene gmail-read applies (reuse its exported helper; if the hygiene function is `sanitizeVenueText(value, cap)` use that and skip the manual slice). Headers read with the exported `headerValue`. `jevStateOf` builds a fresh object literal of the seven keys (never a spread of the item state).

- [ ] **Step 4: Questions.** `src/jev/questions/mail.ts`:
```ts
import type { ChoiceQuestion } from "./types.js";
/** Spec 2026-11-09 §3.5: escape first (jev-1.13 leans to the first option). */
export const MAIL_URGENCY: ChoiceQuestion = {
  id: "mail_urgency", type: "choice",
  instructions: "Houge is Paco's assistant. The state describes one email that just arrived in Paco's inbox: the sender's name and address, whether Paco has written to this sender before (`known_sender`), the subject, Gmail's short snippet, Gmail labels and whether Gmail marked it important. Codes and links are masked. Should Houge interrupt Paco about this email now, or can it wait until he looks?",
  criteria: [
    ["later", "It can wait until Paco looks: newsletters, receipts, notifications, marketing, automated updates."],
    ["now", "Paco must see or act on this within hours: a person writing to him, a deadline today, a security or money alert about his own accounts, a reply he is waiting for."]
  ]
};
export const MAIL_KIND: ChoiceQuestion = {
  id: "mail_kind", type: "choice",
  instructions: "Houge is Paco's assistant. The state describes one email in Paco's inbox (sender, subject, snippet, labels; codes and links masked). What kind of email is it?",
  criteria: [
    ["fyi", "Information for Paco; nothing to do."],
    ["action", "Paco needs to do or answer something."],
    ["risk", "A security, money or account warning about Paco's own accounts."],
    ["noise", "Marketing, newsletters or automated mail of no consequence."]
  ]
};
```

- [ ] **Step 5: Failing ask test** (`tests/jev/mail-ask.test.ts`), with a fake `client`:
  - answered: `askMail` returns `urgency.choice === "now"` and `kind.choice === "risk"` from a client returning both answers;
  - the request's `state` keys equal the `MailJevState` key set (capture `req.state`);
  - the request carries both questions (`Object.keys(req.questions)` = `["mail_urgency","mail_kind"]`);
  - a client returning `{ ok: false, reason: "error", ... }` → `{ failed: "outage" }`;
  - no `jev_decisions` row is written (`SELECT COUNT(*) FROM jev_decisions` is 0 — use a store method if one exists, else read through `(store as any).db`).

- [ ] **Step 6: Implement `src/jev/mail-ask.ts`** mirroring `src/jev/improve-ask.ts` (facts §4): `decide({ point: "mail", run_id: null, state, questions: [MAIL_URGENCY, MAIL_KIND], lang: langOf(\`${state.subject ?? ""} ${state.snippet ?? ""}\`), client, store, thresholdVersion: MAIL_THRESHOLD_VERSION, now })`; skipped → `{ failed: fallbackOf(reason), reason }`; `urgency` missing → `{ failed: "parse" }`; `kind` may be undefined. Never call `persistDecisionRows`. Add `"mail"` to `DecisionPoint` in `src/jev/decide.ts`.

- [ ] **Step 7: Run both test files + typecheck — PASS.**

- [ ] **Step 8: Commit**

```bash
git add src/mail/envelope.ts src/jev/questions/mail.ts src/jev/mail-ask.ts src/jev/decide.ts src/capabilities/gmail-read.ts tests/mail/envelope.test.ts tests/jev/mail-ask.test.ts
git commit -m "feat(mail): code-built redacted envelope, MailJevState, mail_urgency/mail_kind questions, run-less ask"
```

---

### Task 4: The `mail.triage` entry

**Spec:** §3.4 (ladder, bars, effects, reasons, `perItemRouting`, `JEV_PAGED_ELSEWHERE`), §5. **Facts:** §3 (memory-kind entry shape, registry, entry-ids, the eight `toHaveLength(40)` lines).

**Files:**
- Create: `src/decisions/entries/mail-triage.ts`
- Modify: `src/decisions/entry-ids.ts`, `src/decisions/registry.ts`, `src/decisions/record.ts`, `tests/decisions/registry.test.ts` (40 → 41 at the eight lines), `docs/reference/decision-map.md` (a row in `## Registry entries`)
- Test: `tests/decisions/mail-triage.test.ts`

**Interfaces:**
```ts
export const MAIL_TRIAGE_ID = "mail.triage";
export type MailVerdict = "ping" | "inbox";
export const MAIL_UP_BAR_P = 0.6;
export const MAIL_DOWN_BAR = 0.85;
export interface MailTriageState { item: MailItemState; rule: "always" | "never" | null; jev?: MailAsk }   // jev filled by the executor
export type MailTriageDetail = { kind: MailKind | null };
export const MAIL_TRIAGE: Entry<MailTriageState, MailVerdict, MailTriageDetail>;
export function mailFloors(s: MailTriageState): RungAnswer<MailVerdict, MailTriageDetail> | RungAbstain<MailVerdict, MailTriageDetail>;
export function jevMailAnswer(a: MailAsk): RungResult<MailVerdict, MailTriageDetail>;   // the system_one executor's mapping
export function perItemRouting(s: MailTriageState, verdict: string): boolean;
export const MAIL_REASONS: readonly string[];  // ["own_output","rule_never","rule_always","backfill","jev_now","jev_later","jev_unsure"]
```

- [ ] **Step 1: Failing tests** (`tests/decisions/mail-triage.test.ts`):
  - `entryProblems(MAIL_TRIAGE)` is `[]`;
  - floors in order: own address → `inbox`/`own_output` even with an `always` rule; `never` → `inbox`/`rule_never`; `always` → `ping`/`rule_always`; backfill without a rule → `inbox`/`backfill`; otherwise abstain;
  - `jevMailAnswer`: `now` p 0.60 → `ping`/`jev_now`; `now` p 0.59 → `ping`/`jev_unsure`; `later` p 0.85 → `inbox`/`jev_later`; `later` p 0.84 → `ping`/`jev_unsure`; every answer carries `p` = the top option's probability and `detail.kind` from the kind answer (null when missing); `{ failed: "timeout" }` → `{ failed: "timeout" }`;
  - `decide(MAIL_TRIAGE, s, { run_id: null, recorder, exec: { system_one: async () => jevMailAnswer(ask) } })` with a capturing recorder: an `always`-rule item produces one recorded result (`alwaysRecord`), rung `rule`; a Jev failure produces verdict `ping`, rung `fail`, `fallbackRung` `system_one`;
  - `perItemRouting(s, "ping")` and `(s, "inbox")` true; `(s, "drop")` false; a state whose `item.item_id` is empty → false;
  - `ENTRY_IDS` contains `"mail.triage"` and `entryById("mail.triage")` is the entry.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement the entry** following `memory-kind.ts`:

```ts
const CARD: VerdictEffect = { kind: "effect", reversible: false, announced: "card", what: "a mail card is sent to Paco now (silent in quiet hours or as a thread follow-up)" };
const INBOX: VerdictEffect = { kind: "effect", reversible: true, announced: "inbox", what: "the mail is listed in /inbox with a 'should have pinged' tap" };
export const MAIL_TRIAGE_BAR: ProvisionalBar = { kind: "provisional", question: MAIL_URGENCY.id, criteriaHash: criteriaHash(MAIL_URGENCY), p: MAIL_UP_BAR_P, source: "Paco D4 2026-11-09, armed at ship" };
export const MAIL_TRIAGE: Entry<MailTriageState, MailVerdict, MailTriageDetail> = {
  id: MAIL_TRIAGE_ID, version: 1, stage: "inbound", input: "tool",
  question: "Should Paco be pinged about this mail now, or can it wait in /inbox?",
  verdicts: ["ping", "inbox"],
  ladder: [
    { kind: "rule", name: "mail_floors", decide: mailFloors },
    { kind: "system_one", name: "mail_urgency", questions: [MAIL_URGENCY, MAIL_KIND], bars: MAIL_TRIAGE_BAR, timeoutMs: 6_000, recordedP: MAIL_URGENCY.id }
  ],
  fail: "ping", defaultVerdict: "ping", alwaysRecord: true,
  outcomes: [], armed: { rule: "on", system_one: "on" },
  effects: { ping: CARD, inbox: INBOX },
  perItemRouting,
  reasonCodes: MAIL_REASONS
};
```
`mailFloors` compares `item.from_address` to `HOUGE_GMAIL_ADDRESS`. `jevMailAnswer` reads `urgency.probabilities` for p (`topProbOf` or the max of the map). `perItemRouting` checks `(verdict === "ping" || verdict === "inbox") && typeof s.item.item_id === "string" && s.item.item_id.length > 0`.
Add `"mail.triage"` to the end of `ENTRY_IDS`; append `MAIL_TRIAGE as unknown as AnyEntry` to `REGISTRY`; add `MAIL_TRIAGE_ID` to `JEV_PAGED_ELSEWHERE` in `record.ts` with the comment line `mail.triage (spec 2026-11-09 §3.4): its Jev failures page through the Jev client's incidents; one call, one page.` Update the eight `toHaveLength(40)` to 41. Add the decision-map row: ``| `mail.triage` | inbound | tool | rule `mail_floors` → Jev `mail_urgency` (ping ≥ 0.6, inbox ≥ 0.85) | ping / inbox | ADR 0034 2.6 |`` — match the table's real column count (read the header row).

- [ ] **Step 4: Run** `npx vitest run tests/decisions tests/docs` + typecheck — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/decisions/entries/mail-triage.ts src/decisions/entry-ids.ts src/decisions/registry.ts src/decisions/record.ts tests/decisions/mail-triage.test.ts tests/decisions/registry.test.ts docs/reference/decision-map.md
git commit -m "feat(decisions): mail.triage entry (rule floors, Jev mail_urgency, 2.6 routing)"
```

---

### Task 5: Telegram send path — silent sends and URL buttons; mail topics

**Spec:** §3.6 (silent, URL buttons, topics). **Facts:** §2 (types), §9 (adapter), §12.

**Files:**
- Modify: `src/notifications/notification-types.ts`, `src/notifications/telegram-notification-adapter.ts`, `src/telegram/telegram-client.ts`, `src/notifications/topics.ts`
- Test: `tests/notifications/silent-url-buttons.test.ts` (new); existing adapter tests must stay green unchanged

**Interfaces:**
- `NotificationButton { text: string; data?: string; url?: string }` — exactly one of `data` / `url` (a type-level union is preferred: `{ text; data: string } | { text; url: string }`).
- `NotificationPayload.silent?: boolean`.
- `TelegramSendMessageInput.disable_notification?: boolean`; the inline button type gains `url?: string`.
- `TOPIC_ROUTE` gains `mail_card: "chat"` and `mail_log: "log"`.

- [ ] **Step 1: Failing tests:** (a) a payload `{ text: "x", silent: true, buttons: [{ text: "Open", url: "https://mail.google.com/mail/u/?authuser=a%40example.com#inbox/abc" }, { text: "Wrong urgency", data: "mail:wu:mi_1" }] }` sent through the adapter with a fake client reaches `sendMessage` with `disable_notification: true` and `inline_keyboard[0]` = `[{ text: "Open", url: "…" }, { text: "Wrong urgency", callback_data: "mail:wu:mi_1" }]`, also on the plain-text retry path; (b) a payload without `silent` and with callback-only buttons produces a `sendMessage` input **deep-equal to today's** (no `disable_notification` key at all); (c) the client's HTTP body includes `disable_notification` only when set (fake `fetch`); (d) `TOPIC_ROUTE.mail_card === "chat"`, `TOPIC_ROUTE.mail_log === "log"`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement**, keeping every existing payload byte-identical (only add keys when set). If a test pins `TOPIC_ROUTE` size, update it.
- [ ] **Step 4: Run** `npx vitest run tests/notifications tests/telegram` + typecheck — PASS.
- [ ] **Step 5: Commit** `feat(notifications): silent sends, URL buttons, mail_card/mail_log topics`.

---

### Task 6: Paco's account — broker secret, auth clients, on-demand reads gated

**Spec:** §3.1, §3.6 (on-demand reading), §8.3–8.4. **Facts:** §6, §7, §8.

**Files:**
- Modify: `src/config/secret-broker.ts`, `src/config/disarm-posture.ts`, `src/capabilities/google-api.ts` (no path change), `src/capabilities/gmail-read.ts`, `src/core/core-worker.ts`, `src/omp/tools/gmail_read.json`, `src/omp/tools/google_api.json`
- Create: `src/mail/flag.ts`
- Test: `tests/config/secret-broker-paco.test.ts`, `tests/mail/flag.test.ts`, `tests/core/gmail-account.test.ts`

**Interfaces:**
```ts
// secret-broker.ts: SECRET_ENV_NAMES gains "HOUGE_PACO_GMAIL_REFRESH_TOKEN"; SecretBroker gains pacoGmailRefreshToken(): string | undefined; its value joins the redaction set.
// src/mail/flag.ts
export function resolveMailEnabled(env: NodeJS.ProcessEnv): boolean            // HOUGE_MAIL_ENABLED in 1/true/yes/on; default off
export function mailPollMinutes(env: NodeJS.ProcessEnv): number               // HOUGE_MAIL_POLL_MIN, default 5, clamp [2, 60], NaN → 5
export function mailQuietWindow(env: NodeJS.ProcessEnv): { start: number; end: number }   // HOUGE_MAIL_QUIET "23-7" default; malformed → default
export function mailTextDays(env: NodeJS.ProcessEnv): number                  // HOUGE_MAIL_TEXT_DAYS default 30, min 1
export function pacoMailReadable(env: NodeJS.ProcessEnv, store: Pick<RunStore, "mailState">): boolean   // resolveMailEnabled && mailState().enabled
export function pacoAddress(env: NodeJS.ProcessEnv): string | undefined       // HOUGE_PACO_GMAIL_ADDRESS, lower-cased, ADDRESS_RE-checked
```
- `DISARM_FLAGS` gains `"HOUGE_MAIL_ENABLED"`.
- `CoreWorker`: `googleAuthClient(account: "houge" | "paco" = "houge")`, two cached clients; the paco client reads `HOUGE_GMAIL_CLIENT_ID`, `broker.gmailClientSecret()`, `broker.pacoGmailRefreshToken()` (env fallbacks as today's code does). `invalidatePacoGmail(): void`.
- Tool schemas: `account` enum `["houge", "paco"]`; descriptions mention Paco's inbox, read-only, only when mail is on.
- At the tool call site (core-worker ~3664–3674): `account === "paco"` and `!pacoMailReadable(process.env, store)` → tool error text `"Paco's mail is off (/mail on to allow)"`; otherwise pass the paco auth client. `account` absent or `"houge"` → today's code path unchanged.

- [ ] **Step 1: Failing tests:** broker getter returns the env value and `redact()` masks it; `stripSecretsFromEnv` removes it; `resolveMailEnabled` truth table; `mailPollMinutes` clamps (1 → 2, 99 → 60, "x" → 5); `mailQuietWindow("22-6")`; `DISARM_FLAGS` includes `HOUGE_MAIL_ENABLED` and `applyDisarmPosture` sets it `"false"`; core-worker: a `gmail_read` call with `account: "paco"` while mail is off returns the refusal and makes **no** fetch; with mail on it uses a token minted from the paco refresh token (fake fetch asserts the `refresh_token` form field); a call without `account` behaves exactly as today (existing gmail tests unchanged and green).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Export `HEADER_FIELD_CAP`/`SNIPPET_CAP` if Task 3 did not already.
- [ ] **Step 4: Full suite** `npm run typecheck && npm test` — PASS, none skipped. (Docs parity will fail on the new env vars until Task 11 — if so, add the rows to `docs/reference/configuration.md` now, in this task, for every `HOUGE_*` name this task introduces: `HOUGE_MAIL_ENABLED`, `HOUGE_MAIL_POLL_MIN`, `HOUGE_MAIL_QUIET`, `HOUGE_MAIL_TEXT_DAYS`, `HOUGE_PACO_GMAIL_ADDRESS`, `HOUGE_PACO_GMAIL_REFRESH_TOKEN`, with the defaults above.)
- [ ] **Step 5: Commit** `feat(mail): Paco's Gmail grant — broker getter, per-account auth clients, account:"paco" gated by the mail switch`.

---

### Task 7: Gmail client for the poller, and the card

**Spec:** §3.2 (requests), §3.3 (known sender), §3.6 (card text, taps, Open URL, quiet hours, thread follow-up). **Facts:** §6, §9.

**Files:**
- Create: `src/mail/gmail-client.ts`, `src/mail/card.ts`
- Test: `tests/mail/gmail-client.test.ts`, `tests/mail/card.test.ts`

**Interfaces:**
```ts
// gmail-client.ts — every call uses googleApiGetJson(path, query, deps, auth)
export type GmailErr = { ok: false; kind: "auth" | "not_found" | "unavailable"; status?: number };
export async function historyRange(start: string, deps: GoogleApiDeps, auth: GoogleAuthClient): Promise<{ ok: true; ids: { id: string; threadId: string }[]; historyId: string } | GmailErr>
   // pages with maxResults=500, historyTypes=messageAdded, labelId=INBOX; reads history[].messagesAdded[].message; de-duplicates ids, keeps order
export async function getMetadata(id: string, deps, auth): Promise<{ ok: true; m: GmailMetadata } | GmailErr>   // format=metadata + From/Subject/Date headers
export async function profileHistoryId(deps, auth): Promise<{ ok: true; historyId: string } | GmailErr>          // GET /gmail/v1/users/me/profile
export async function listInbox(q: string, cap: number, deps, auth): Promise<{ ok: true; ids: { id: string; threadId: string }[]; more: boolean } | GmailErr>  // messages list, paged to cap
export async function sentTo(address: string, deps, auth): Promise<{ ok: true; found: boolean } | GmailErr>       // q = in:sent to:"<address>", maxResults=1; refuses (found:false, no call) unless ADDRESS_RE matches
// card.ts
export function mailCardPayload(i: { item: MailItemRow; pacoAddress: string; quiet: boolean; jevUnavailable: boolean }): NotificationPayload
export function foldCardPayload(): NotificationPayload
export function inQuietHours(now: Date, w: { start: number; end: number }, tz: "Australia/Sydney"): boolean
export function openUrl(pacoAddress: string, threadId: string): string   // https://mail.google.com/mail/u/?authuser=<encodeURIComponent(address)>#inbox/<threadId>
```
How `googleApiGetJson` reports HTTP status: read `src/capabilities/google-api.ts` and map its error string (401 after re-mint → `auth`; `google auth auth_failed` → `auth`; 404 → `not_found`; anything else → `unavailable`). If the error string does not carry the status, add a minimal structured `status` to its error result in this task (keeping existing callers' text unchanged) and test it.

- [ ] **Step 1: Failing client tests** with a fake `fetchImpl` recording every URL: `historyRange` follows `nextPageToken` across 2 pages, de-duplicates a repeated id, returns the last page's `historyId`; every recorded URL path starts with `/gmail/v1/users/me/` and no query has `format=full` or `format=raw`; `getMetadata` sends `format=metadata` and three `metadataHeaders`; a 404 maps to `not_found`; an auth failure maps to `auth`; `sentTo("a b@example.com")` makes no request; `sentTo("ann@example.com")` sends `q=in:sent to:"ann@example.com"`.
- [ ] **Step 2: Failing card tests:** card text starts with `📧 ` + redacted name + ` · ` + kind (or `mail` when kind null), second line the redacted subject (or `(no subject)`), a third line `(Jev unavailable)` only when set; a thread follow-up item renders the first line as `↪ +1 in this thread · ` + name; buttons row 1: `Open` URL button; row 2: `Wrong urgency` with data `mail:wu:<item_id>`; `silent` true when `quiet` or `item.thread_followup`; no snippet anywhere in the text; every callback ≤ 64 bytes for a 36-char item id; `inQuietHours` true at 23:30 and 06:59 Sydney, false at 07:00 and 22:59 (use fixed UTC instants for a date in November, AEDT = UTC+11).
- [ ] **Step 3: Run — FAIL.** **Step 4: Implement.** Item ids are `mi_<uuid>`; callback families: `mail:wu:<item_id>`, `mail:never:<item_id>`, `mail:always:<item_id>`, `mail:shp:<item_id>`, `mail:page:<n>` (n ≤ 9999). Escape name and subject through the same escaping the rich renderer expects for untrusted text (find how `digestLine` / `inertLine` in gmail-read do it and reuse).
- [ ] **Step 5: Run + typecheck — PASS. Step 6: Commit** `feat(mail): poller Gmail client and mail card`.

---

### Task 8: Triage write path and the poller tick

**Spec:** §3.2, §3.4 (write path, fold, thread), §7. **Facts:** §2 (inTransaction, enqueueNotification, openAlertedIncident), §3 (decide, ctx.exec), §10 (detachedJob).

**Files:**
- Create: `src/mail/triage.ts`, `src/mail/poller.ts`
- Test: `tests/mail/triage.test.ts`, `tests/mail/poller.test.ts`

**Interfaces:**
```ts
// triage.ts
export interface TriageDeps { store: RunStore; chatId: string; pacoAddress: string; env: NodeJS.ProcessEnv; now: () => Date;
  ask: (state: MailJevState) => Promise<MailAsk> }
export type TriageOutcome = { stored: true; lane: MailLane; reason: MailReason; notified: boolean } | { stored: false; error: "decision" | "write" };
export async function triageOne(d: TriageDeps, m: GmailMetadata, x: { known_sender: boolean; backfill: boolean }): Promise<TriageOutcome>
// poller.ts
export interface PollDeps extends Omit<TriageDeps, "ask"> { gmail: { deps: GoogleApiDeps; auth: GoogleAuthClient }; ask: TriageDeps["ask"]; signal: AbortSignal; deadlineMs?: number }
export type PollResult = { ran: false; why: "off" | "no_token" | "paused" | "busy" | "not_due" } | { ran: true; stored: number; pinged: number; cursorAdvanced: boolean; error?: "auth" | "unavailable" };
export async function runMailTick(d: PollDeps): Promise<PollResult>
```

**`triageOne` steps (exactly this order; each helper under 50 lines):**
1. `item_id = "mi_" + randomUUID()`; `thread_pinged_6h = store.threadPingedSince(threadId, now - 6h)`; `rule = store.senderRule(address)`; `state = buildItemState(...)`.
2. Queuing recorder: `{ record: (entry, r, ctx) => { queued = { entry, r, ctx }; return null; } }`.
3. `r = await decide(MAIL_TRIAGE, { item: state, rule }, { run_id: null, tool_call_id: item_id, recorder, exec: { system_one: async () => jevMailAnswer(await d.ask(jevStateOf(state))) } })`.
4. `if (!perItemRouting(...))` → lane `inbox`, reason `routing_refused`, and `store.enqueueNotification({ topic: "decision_internal", idempotency_key: \`mail:refused:${item_id}\`, correlation_id: item_id, text: "mail.triage: routing refused for one item" })`.
5. Lane/reason: from `r.verdict` and `r.reason`; a `rung === "fail"` result → reason `jev_unavailable`. Fold: if lane `ping` and `store.countMailPingsSince(now - 60m) >= 6` → lane `inbox`, reason `folded`, `foldDue = true`. Thread follow-up: lane `ping` and `thread_pinged_6h` → `thread_followup = true`.
6. One `store.inTransaction(() => { insertMailItem(...); decision_id = recordStrict(store, MAIL_TRIAGE, queued.r, queued.ctx, nowIso); if lane ping → enqueue mail_card (key `mail:${gmail_message_id}`, `intent_type: "progress"`, payload from `mailCardPayload`), setMailItemNotification; if foldDue → enqueue fold card (key `mail:fold:${YYYY-MM-DDTHH}` in UTC) — a `duplicate` result is fine })`.
7. After commit: `afterStrictRecord(store, MAIL_TRIAGE, queued.r, nowIso, env)`. On a throw from the transaction: if the error came from `insertDecision` (wrap `recordStrict` to tag it), `openAlertedIncident(store, { kind: "decision_record_failed", subject: "mail.triage", detail: { item: item_id } })`; return `{ stored: false, error }`.
The card's `kind` comes from the Jev detail (`r.detail?.kind`), null otherwise.

**`runMailTick` steps:**
1. Gates in order: `!resolveMailEnabled(env)` or `!store.mailState().enabled` → `off`; no paco refresh token → `no_token`; `mailState().last_error_code === "auth"` → `paused`; not due (`last_ok_at` newer than `mailPollMinutes`) → `not_due`. (Single-flight is the daemon's `detachedJob`, Task 9.)
2. No cursor → first run: `profileHistoryId`; `listInbox("in:inbox newer_than:1d", 200)`; each id → `getMetadata` → `triageOne(..., { backfill: true })`; set cursor to the profile id after all stored.
3. Cursor present → `historyRange(cursor)`. `not_found` → resync: `listInbox(\`in:inbox after:${epochSeconds(last received)}\`, 500)`, store as backfill, write one `mail_log` line (`Mail caught up: N in /inbox` + `; M older not listed, see Gmail` when `more`), cursor := `profileHistoryId`.
4. For ids not `hasMailItem`, at most 3 in flight, stop starting new work when `deadlineMs` (default 90 000) has elapsed or `signal.aborted`: `getMetadata` (404 → skip and count as done), known sender via cache or `sentTo` (cache result), `triageOne`.
5. Cursor advances to the range's `historyId` only when every collected id is stored or skipped-404. Otherwise unchanged.
6. Success → `setMailState({ last_ok_at, last_error_code: null, failing_since: null })` and `resolveOpenIncidents(store, new Set(["mail_poll_failing"]))`. `auth` error → `setMailState({ last_error_code: "auth" })`, `openAlertedIncident(store, { kind: "mail_auth_lost", subject: "paco", detail: {} })`. `unavailable` → `failing_since ??= now`; if `now - failing_since > 2h` → `openAlertedIncident(... "mail_poll_failing" ...)`. Backoff: every attempt stamps `last_attempt_at`; while `failing_since` is set the tick is due only when `now - last_attempt_at ≥ min(30, 2^backoff_n)` minutes; an `unavailable` result increments `backoff_n`; success resets it to 0.

- [ ] **Step 1: Failing triage tests** (fake `ask`, in-memory store, a chat id `"555"`):
  - a Jev `now` 0.9 → one `mail_items` row lane `ping`, one `decisions` row (entry `mail.triage`, `tool_call_id` = item id, `run_id` null), one outbox row with key `mail:<gmail id>` and topic `mail_card`;
  - a Jev `later` 0.9 → lane `inbox`, no outbox row, decision row present;
  - Jev failure → lane `ping`, reason `jev_unavailable`, decision rung `fail`;
  - 6 pings in the last hour → the 7th is `inbox`/`folded` and exactly one fold card exists after the 8th too;
  - a pinged thread → the next `ping` is stored `thread_followup = 1`, its card payload `silent: true` and starts with `↪`;
  - **atomicity:** make `insertDecision` throw (spy) → no `mail_items` row, no outbox row, one `decision_record_failed` incident; then a normal retry pings once;
  - **crash before commit:** `ask` resolves, then `inTransaction` throws on the enqueue (spy) → nothing stored; retry stores once;
  - the sender address and subject appear in no `decisions` column and no `change_log` text.
- [ ] **Step 2: Failing poller tests** (fake Gmail via `fetchImpl`, fake auth):
  - off / no token / paused / not due return without any fetch;
  - first run: profile + list; 3 items stored `backfill`, zero cards, cursor set;
  - history across 2 pages with 3 new ids → 3 rows, cursor = last page `historyId`;
  - a deadline of 0 ms after the first item → 1 row, cursor unchanged; the next tick stores the rest without a duplicate and then advances;
  - `getMetadata` 404 for one id → others stored, cursor advances;
  - history 404 → resync stores backfill, one `mail_log` change-log row; with `more` the text includes "older not listed";
  - auth error → `last_error_code = "auth"`, one `mail_auth_lost` incident, later ticks return `paused` with no fetch;
  - unavailable for > 2 h of fake time → one `mail_poll_failing` incident; success resolves it;
  - a second tick over the same history ids sends no second card.
- [ ] **Step 3: Run — FAIL. Step 4: Implement. Step 5: Run + typecheck — PASS.**
- [ ] **Step 6: Commit** `feat(mail): triage write path (one transaction, strict flush) and the poller tick`.

---

### Task 9: Incidents, sweep, retention, daemon wiring

**Spec:** §4 (retention), §6 (incidents), §7. **Facts:** §2 (INCIDENT_ROUTE, REMIND_KINDS, SWEEP_INCIDENT_KINDS, sweep check pattern), §10.

**Files:**
- Modify: `src/run/incident-route.ts`, `src/run/incident-alert.ts`, `src/run/invariant-sweep.ts`, `tests/run/incident-route.test.ts` (sizes), `src/telegram/telegram-daemon.ts`
- Create: `src/mail/retention.ts`
- Test: `tests/mail/retention.test.ts`, `tests/run/mail-sweep.test.ts`, `tests/telegram/mail-tick-wiring.test.ts`

**Interfaces:**
```ts
// incident-route.ts
mail_auth_lost: page("I lost access to your Gmail.", "run `npm run houge -- mail auth`, then restart the daemon"),
mail_poll_failing: page("I haven't been able to check your Gmail for over 2 hours."),
// incident-alert.ts REMIND_KINDS: ["mail_auth_lost", { action: "run `npm run houge -- mail auth`, then restart the daemon", after_ms: 24 * 60 * 60_000 }]
// invariant-sweep.ts: "mail_poll_failing" in SWEEP_INCIDENT_KINDS; mailViolations(store, now, env): enabled && resolveMailEnabled(env) && last_ok_at older than 2h (or null with enabled set > 2h ago — use last_ok_at null → no violation) → [{ kind: "mail_poll_failing", subject: "paco", detail: { minutes } }]
// retention.ts
export function runMailRetention(store: RunStore, now: Date, env: NodeJS.ProcessEnv): { cleared: number; stripped: number }
export function purgeMail(store: RunStore, now: Date): { cleared: number; stripped: number }
```
Retention: ids = `mailItemsTextBefore(now - mailTextDays)`; `clearMailItemText`; for each `mailCardNotificationIds(ids)` → `replaceNotificationPayload(id, { text: "📧 · " + (kind ?? "mail"), buttons: [] })` (whatever state the row is in). Once a day: skip when `mail_state.retention_on` equals today's Sydney date; set it after the sweep.

Daemon wiring (`runSignalPathTick`): a `const mailTick = detachedJob();` created beside `rolesTick`; each cycle `mailTick.start(() => runMailTickSafe(options, now, chatId))`, and `runMailRetentionSafe` once per local date. `runMailTickSafe` builds the paco auth client (as Task 6), the Jev client (`createJevClient({ apiKey: broker?.typesafeKey() ?? env, audit: store.llmAuditSink({ correlation_id: "mail-tick", role: "mail" }), meteredBreached: () => store.meteredFuseLatched(), retries: 0, timeoutMs: 6_000 })`) and calls `runMailTick` with `ask: (s) => askMail({ state: s, client, store })`, catching everything with `console.error(\`[telegram-daemon] mail tick failed: ${errorCode(error)}\`)`. If `"mail"` is not a valid `LlmCallRole`, add it to that union. No tick when the tombstone or park marker is present (the daemon does not run then) or `options.stopSignal.aborted`.

- [ ] **Step 1: Failing tests:** route sizes updated (56→58 rows, pages 33→35) and both kinds route `page`; `mail_auth_lost` reminded after 24 h; sweep: enabled + stale `last_ok_at` → one violation, fresh → none, disabled → none; retention: items older than 30 days lose subject/snippet/from_name, `text_cleared_at` set, their outbox payload text becomes `📧 · <kind>` with a recomputed hash, newer items untouched, a second run the same day does nothing; purge clears all and empties `mail_senders`; daemon wiring: with `HOUGE_MAIL_ENABLED=1`, mail on, and a fake Gmail, one poll-loop cycle stores a mail and enqueues one `mail_card`; with the flag off no Gmail call is made.
- [ ] **Step 2: Run — FAIL. Step 3: Implement. Step 4: Full suite** `npm run typecheck && npm test` — PASS, none skipped.
- [ ] **Step 5: Commit** `feat(mail): incidents, sweep backstop, retention and daemon wiring`.

---

### Task 10: Commands, taps and the CLI

**Spec:** §3.6 (`/inbox`, `/mail`, `/mail_undo`, taps, `/changes` line), §3.1 (`houge mail auth`), §4 (`purge`). **Facts:** §9 (parser, callbacks, gateway), §11 (CLI), §15 (gmail-auth.mjs).

**Files:**
- Modify: `src/triggers/telegram-command-parser.ts`, `src/triggers/telegram-trigger-adapter.ts`, `src/domain/types.ts`, `src/gateway/gateway.ts`, `src/cli.ts`, `scripts/gmail-auth.mjs`, `README.md`
- Create: `src/gateway/mail-commands.ts`, `src/mail/inbox.ts`
- Test: `tests/triggers/mail-commands-parse.test.ts`, `tests/gateway/mail-commands.test.ts`, `tests/scripts/gmail-auth-paco.test.ts`

**Interfaces:**
```ts
// parser
TelegramCommand += { type: "inbox"; all: boolean } | { type: "mail"; action: "on" | "off" | "status" } | { type: "mail_undo"; rule_id: string };
export function parseMailCallback(data: unknown): { action: "wu" | "never" | "always" | "shp"; item_id: string } | { action: "page"; page: number } | null;
// regexes: ^mail:(wu|never|always|shp):(mi_<LC_UUID>)$  and  ^mail:page:([1-9]\d{0,3})$ ; rule ids are mr_<uuid>
// inbox.ts
export function inboxView(store: RunStore, page: number, now: Date): NotificationPayload        // 30 per page, grouped by kind, oldest first, marks shown items seen, "next" button mail:page:<n+1> when more
export function inboxAllView(store: RunStore, now: Date): NotificationPayload                   // last 7 days
export function mailStatusText(store: RunStore, env: NodeJS.ProcessEnv, now: Date): string
export function applySenderRule(store: RunStore, item_id: string, action: "always" | "never", now: Date): { ok: true; rule_id: string; masked: string } | { ok: false; why: "invalid_address" | "no_item" }
export function undoSenderRule(store: RunStore, rule_id: string, now: Date): boolean
```
- Every rule write and undo writes a `/changes` line via `enqueueNotification({ topic: "mail_log", idempotency_key: \`mail:rule:${rule_id}:${action|undo}\`, correlation_id: rule_id, text })`, text e.g. `Mail rule mr_… — never ping from a***@example.com. Undo: /mail_undo mr_…` with the address masked by `maskSubject` or an equivalent masker (first char + `***` + `@domain`).
- `/mail off` also calls the worker's `invalidatePacoGmail()` if the gateway can reach it; otherwise the poller checks the switch before every request (already true by Task 8's gate) and the token simply expires — state which in the code comment.
- `wu` tap replies with a card offering `never` / `always` buttons and writes a `wrong_urgency` label; `shp` writes `should_have_pinged` and offers `always`. Each tap handler uses `oncePerTrigger` and `replyTo` (facts §9).
- CLI: `houge mail auth` runs `node scripts/gmail-auth.mjs --account paco` as a child process with inherited stdio; `houge mail purge --yes` opens the store and calls `purgeMail`, printing counts; without `--yes` it prints usage and exits 1. Both check the tombstone like the `jev` commands.
- `scripts/gmail-auth.mjs --account paco`: client id/secret from `.env` (`HOUGE_GMAIL_CLIENT_ID` / `HOUGE_GMAIL_CLIENT_SECRET`, parsed by a minimal reader) with the json path optional; `login_hint` and identity check from `HOUGE_PACO_GMAIL_ADDRESS`; writes one `HOUGE_PACO_GMAIL_REFRESH_TOKEN=` line, **replacing** an existing one; prints "Restart the daemon (launchctl kickstart) to load it." Without `--account` the script behaves byte-identically (extract the `.env` line writer into a pure function `upsertEnvLine(text, name, value)` and unit-test it: replace, append when absent, keep other lines).

- [ ] **Step 1: Failing tests:** parse `/inbox`, `/inbox all`, `/mail on|off|status`, `/mail` (→ status), `/mail_undo mr_<uuid>`, invalid forms; callback regex round-trips and every shape ≤ 64 bytes; gateway: `/mail on` sets `mail_state.enabled`; `/inbox` lists only unseen inbox items, 30 per page, and a second `/inbox` shows the next unseen; `wu` → label + follow-up offer; `never` → rule + `mail_log` line with a masked address; a later triage of that sender gives `inbox`/`rule_never`; `/mail_undo` removes it and logs; a tap on an item with `invalid` address → reply "can't make a rule for this sender"; `upsertEnvLine` cases.
- [ ] **Step 2: Run — FAIL. Step 3: Implement** (README: add `/inbox`, `/mail`, `/mail_undo` and `houge mail auth|purge` in the commands section, backticked). **Step 4:** `npm run typecheck && npx vitest run tests/triggers tests/gateway tests/scripts tests/docs` — PASS.
- [ ] **Step 5: Commit** `feat(mail): /inbox, /mail, /mail_undo, mail taps, houge mail auth|purge`.

---

### Task 11: ADR amendments, ADR conformance tests, docs sync

**Spec:** §8 (all), §6 (docs surface). AGENTS.md "Docs sync on ship is a re-read".

**Files:**
- Modify: `docs/decisions/0034-decision-ladder-consolidated.md` (rule 2.6, 2.5 arm, 6.1, rule 3 note, rule 4 row, stage list, History row "awaiting Paco's signature"), `0033-*.md`, `0025-*.md`, `0015-*.md`, `0031-*.md`, `docs/decisions/README.md` (index rows: "amended 2026-11-09 (SP2 mail triage) — awaiting Paco's signature"), `docs/reference/configuration.md` (rows if not already), `docs/reference/jev-decision-layer.md` (questions `mail_urgency`, `mail_kind`, point `mail`), `docs/superpowers/specs/2026-10-12-decision-ladder-design.md` §6.1 (row), `CONTEXT.md` ("mail item", "sender rule"), `README.md` (tool descriptions mention `account: "paco"`), `docs/ROADMAP.md` (SP2 slice 1 built, on branch), `src/capabilities/self-write-guard.ts` only if a new file must be protected (it does not: none of the new files is gate machinery — say so in the commit body)
- Create: `tests/adr/0034-2.6-mail-routing.test.ts`, `tests/adr/0033-mail-egress.test.ts`

- [ ] **Step 1: Failing ADR tests:**
  - `0034-2.6`: (a) an `inbox`-verdict item is listed by `inboxView`; (b) an `always` rule beats a Jev `later` (stored `ping`, reason `rule_always`); (c) a Jev `ping` writes an outbox row deep-equal (minus ids and timestamps) to the one a Jev failure writes, apart from the `(Jev unavailable)` line; (d) `perItemRouting` refuses a state whose `item_id` is empty; (e) the three registry mutants of Task 1 fail.
  - `0033-mail-egress`: the request a mail tick sends to the Jev client has `state` keys = the seven `MailJevState` keys, and a planted `482913` and `https://example.com/v?t=abcdef123456` in subject, snippet and name are absent from the serialised request.
- [ ] **Step 2: Run — expect them to pass already if Tasks 1–10 are right; if any fails, it is a real defect: fix the code, not the test.** (These tests encode the ADR text; they are written now because the rule text is written now.)
- [ ] **Step 3: Write the ADR amendments** using spec §8 wording; every amended ADR says "amended 2026-11-09 (spec 2026-11-09-sp2-mail-triage) — awaiting Paco's signature"; ADR 0015's count says ten (`SECRET_ENV_NAMES`), with "no change of meaning" for the count correction. ADR 0034's "Revisit when" gains: "a second inbound source (calendar, files) wants the 2.6 allowance — it needs its own amendment".
- [ ] **Step 4: Docs re-read.** Grep README, CONTEXT, `docs/reference/*`, `deploy/launchd/README.md`, ROADMAP for `gmail`, `Gmail`, `wukong`, `google_api`, `HOUGE_GOOGLE`, `inbox`, `lane 4`, `notify.routing` and fix every claim this branch made false (e.g. "Houge's own inbox" as the only Gmail; lane 4 as "digest"; `notify.routing` parked for lane 4 → now `mail.triage`).
- [ ] **Step 5:** `npm run typecheck && npm test` — PASS, none skipped.
- [ ] **Step 6: Commit** in two commits: `docs(adr): 0034 2.6, 0033, 0025, 0015, 0031 amendments for SP2 mail (awaiting Paco's signature)` (ADRs + index + ADR tests) and `docs: SP2 mail triage docs sync`.

---

### Task 12: Unchanged-behaviour proof, rollback check, live gate script

**Spec:** §9 (differential, rollback), §10 (live gate, PASS lines 1–8). **Facts:** the R7 gate and rollback scripts in `scripts/` are the templates (`scripts/live-gate-ladder-remainder-r7.mjs`, `scripts/check-ladder-remainder-r7-rollback.mjs`, `scripts/old-dist-provenance.mjs`, `scripts/stage4-diff-lib.mjs`).

**Files:**
- Create: `scripts/check-mail-triage-rollback.mjs`, `scripts/live-gate-mail-triage.mjs`
- Modify: `scripts/check-ladder-stage4-differential.mjs` only if the new stage/announce values break a corpus (they should not; if a corpus differs, root-cause it before any exclusion and record the ruling)

- [ ] **Step 1: Differential.** Build (`npm run build`), build and stamp a merge-base worktree (`.worktrees/base-<sha12>`, `node scripts/stamp-dist.mjs`), run `node scripts/check-ladder-stage4-differential.mjs` with every pinned base (the full post-merge command line is in the script header) plus the new merge base as the stage-4b pair if the harness needs one. Expected: 18 corpora PASS, 0 differences.
- [ ] **Step 2: Rollback script** (template: the R7 rollback): VACUUM-copy the live DB (read-only open, `VACUUM INTO`), migrate it with this build, seed three `mail_items` (one ping, one inbox, one folded), two decisions rows, one rule, one label, one `mail_card` outbox row; open the copy with the **pre-slice** stamped build: it runs, renders `/status` and `/status decisions`, lists decisions, and leaves every row intact (counts and full-row hashes before/after); this build reopens it and reads the mail rows. Prints counts and codes only. Exit 0 PASS / 1 FAIL / 2 setup.
- [ ] **Step 3: Live gate script** (template: the R7 gate) implementing spec §10 exactly: refuses unless the live DB's `mail_state.enabled` is 0 or `HOUGE_MAIL_ENABLED` is not set for the daemon (read `.env` via `HOUGE_ENV_FILE` for the flag; read `mail_state` read-only); takes `--token <gate token>`; runs the real poller (`runMailTick`) against the real Gmail (paco auth client from the broker) with a cursor set to "1 day ago" via a first-run on a VACUUM copy; real Jev client; real Telegram via the outbox pump against Paco's chat; matches the three planted mails by token in their redacted subjects; lines 1–8 as in the spec, line 3 INCONCLUSIVE when Jev routes the newsletter `ping`; line 6 wraps `fetchImpl` to return 401 on the next token mint; line 7 runs a second tick; line 8 prints "tap Open on the urgent card and reply y" and reads stdin (skippable with `--no-open-check` → INCONCLUSIVE). Prints ids, counts, verdict codes only; never subject/sender of any mail; `482913` is searched for, never printed.
- [ ] **Step 4:** `node --check` both scripts; run the rollback check against the stamped base. Expected PASS.
- [ ] **Step 5: Commit** `test(gate): mail triage rollback check and live gate`.

---

## Self-review (done at authoring)

- Spec coverage: §3.1 → T6, T10; §3.2 → T7, T8; §3.3 → T3; §3.4 → T1, T4, T8; §3.5 → T3; §3.6 → T5, T7, T10; §4 → T2, T9; §5 → T4, T8 (floors), T6 (disarm); §6 → T6, T9, T10, T11; §7 → T8, T9; §8 → T1, T11; §9 → every task + T12; §10 → T12; §11 → post-merge (not a task: flag + `/mail on` after kickstart, Paco's `houge mail auth`).
- Type names consistent: `MailItemState`, `MailJevState`, `MailAsk`, `MailTriageState`, `MailLane`, `MailReason`, `MailKind`, `MailItemRow`, `recordStrict`, `afterStrictRecord`, `routedPerItem`, `perItemRouting`, `triageOne`, `runMailTick`.
- Known soft spots for the implementer to resolve against the real code, each named in its task: the `AnyDecideResult` literal (T1), `stableHash` location (T2), the hygiene helper name (T3), googleApiGetJson's status reporting (T7), the gateway's reach to the worker for `invalidatePacoGmail` (T10).
