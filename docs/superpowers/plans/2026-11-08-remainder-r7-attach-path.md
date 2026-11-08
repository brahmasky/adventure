# Remainder slice R7 — `attach.path` (locked) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register the last Stage 3 remainder entry, `attach.path` (locked, rule-only, record-never-steer), consulted at the two places today's code decides whether an `[[attach: <path>]]` file may go to Paco — the supervisor's parse (E2) and the outbox delivery's send-time re-check (E11) — and prove zero behaviour change with the stamped merge-base differential, a live gate and a rollback check.

**Architecture:** The send-time predicate moves verbatim into a new protected leaf `src/notifications/attachment-check.ts` (`checkAttachment`, `overCount`, one `inside`), with two reasons split out (`workspace_unverified`, `not_found`) that map to today's line text. `parseAttachments` also returns the paths it refused; `delivered()` carries them; `finishSuccess` consults `attach.path` per distinct marker path after `outcome.complete`, before `recordChatTurn`, inside `recordSafe`. The adapter returns the checks it already made (`attach_checks`, closed enums, no path) on its `NotificationSendResult`; the dispatcher consults `attach.path` per check **after `markDelivered`**, with the claimed row's `run_id`, in its own try. Three production dispatcher constructions pass `recorder: storeRecorder(store)`. `/status` gets a per-seam suffix on the `attach.path` line.

**Tech Stack:** Node 25, TypeScript strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), `node:sqlite`, vitest. Zero runtime deps.

**Spec:** `docs/superpowers/specs/2026-11-08-ladder-remainder-r7-attach-path-design.md` (Rev 1.2; **approved by Paco 2026-11-08: 1-A, 2-A, 3-A, 4-A, 5-A**). Read it before any task. Only the recommended options are built; the B/C alternatives are not. Pattern slice: R6 (`docs/superpowers/plans/2026-11-03-remainder-r6-lookup-model.md`, shipped).

## Global Constraints

- `dependencies: {}` stays empty. New functions under 50 lines. Tests in `tests/<area>/` mirroring `src/`; ADR pins in `tests/adr/`.
- **Raw answer drives (ADR 0034 3.3):** `parseAttachments`' containment conjunction and `checkAttachment`/`overCount` decide; a `decideSync` result is never read.
- **What does not change (spec §5):** which markers leave the text; which paths are attached; which files are uploaded, in what order, with which name; **every "⚠ Not attached" line, byte for byte**; the outbox row, its state, attempt count and `provider_message_id`; `ompComplete`, `finishRun`, the report; `turn.settle`'s `attachmentsAccepted` and `claim_attached`; the reply text; `NotificationDispatchRecord`. The digest is unchanged.
- **Out of scope (spec §2):** announcing a parse refusal; the `turn.settle` evidence parse (`settleStateFor`); lane replies (`sanitizeLaneText`; its stale comment at `lane-card.ts:10` stays); `send_failed` (execution, no row); `MAX_ATTACHMENTS`, `MAX_ATTACHMENT_BYTES`, `attachmentRefusedLine`, the order of checks, the `O_NONBLOCK` open, `verifiedWorkspace`, `realpathOrSelf`, the dedupe across passes, the follow-up line's `.catch(() => undefined)`, the dispatcher's retry and lease logic; the eval runner's adapter (`eval/eval-runner.ts:217`: no recorder, no rows).
- **Entry (spec §4.3):** `id: "attach.path"`, `version: 1`, `stage: "settle"`, `input: "tool"`, `locked: true`, one rule rung `attach_check`, `armed: { rule: "on" }`, `outcomes: []`. Input `{ seam: "parse"; check: "accepted" | "marker_outside" } | { seam: "send"; check: AttachCheck }`. Rule: `accepted` → `send`/`parsed`; `ok` → `send`/`checked`; else `refuse`/the check. Verdicts `send | refuse`; `defaultVerdict: "send"`; `fail: "refuse"`. **No `alwaysRecord` (1-A: refusals only).**
- **`reasonCodes` (exact):** `marker_outside` (parse); `over_count`, `workspace_unverified`, `outside_workspace`, `not_a_file`, `too_large`, `linked`, `changed`, `not_found`, `unreadable`, `unsupported` (send); `parsed`, `checked`. No path, name or size is a reason.
- **Effects:** `send` `{ kind: "none", reversible: true, announced: "none" }`; `refuse` `{ kind: "tighten", reversible: true, announced: "none", what: "the file is not sent: at send, one '⚠ Not attached: <name> (<why>)' line follows the reply as today; at parse, the marker is dropped silently as today" }`.
- **Parse rows (2-A, 5-A):** written in `finishSuccess` on the consulting `Turn` passed in (never `this.turn`), `run_id = t.req.run_id`, `tool_call_id` null, **after `outcome.complete` and before `recordChatTurn`**, inside `recordSafe` (logs `attach_path_record_failed`). Best-effort terminal records: kept when the run then fails to stage its report or loses its `finishRun` claim; a turn that took `finishFailure` writes none; if `outcome.complete` throws, none.
- **Send rows (2-A):** written by the **dispatcher after `markDelivered` committed**, never while the row is `sending`, with the claimed row's `run_id` (null for a run-less notification), `tool_call_id` null, in a `try` separate from `afterDelivered`'s. A delivery attempt that did not commit writes none. **At most six send consults per delivery:** one per path among the first five, and one `over_count` for the whole overflow.
- **No path, file name, size or text** is stored in a row or in `attach_checks`.
- **Paco's line bytes unchanged:** `REFUSAL_TEXT.workspace_unverified === "outside my workspace"`, `REFUSAL_TEXT.not_found === "could not be read"`.
- **`/status` (spec §4.3):** the `attach.path` count line gains the suffix `(parse N · send M · failed K)` over `refuse` rows only: `rung === "fail"` → failed; `marker_outside` → parse; the send refusal reasons → send. Accepted (`parsed`/`checked`) rows are never counted in the suffix.
- **Faults (spec §4.5):** an insert failure → `decision_record_failed` (a log kind: one `incident_log` `change_log` row, no chat message); a recorder that throws past itself → logged; a rule that throws → a `refuse` row at rung `fail`; a registry misconfiguration → caught by `recordSafe`/`recordAttach`, logged. None changes which file is sent, the follow-up line, the outbox state, the run or `recordChatTurn`.
- **Protected surface:** `src/omp/`, `src/decisions/`, `src/cli.ts`, `src/notifications/telegram-notification-adapter.ts` (already in `PROTECTED_FILES`, see Ruling P2), and — new, Decision 4-A — `src/notifications/attachment-check.ts`. Edits only as specified (Tier A under the approved spec).
- Never write or open `houge.sqlite` from a test, corpus or fixture; gates use a `VACUUM INTO` copy deleted on every exit path. Synthetic text and temp files only. `HOUGE_TOMBSTONE_PATH`/`HOUGE_DISARM_PATH` pinned to a temp dir, `HOUGE_TELEGRAM_CHAT_ID` cleared (tests) or a stub (gates) wherever a recorder fault is provoked.
- Commit trailer names the implementing model (`Co-Authored-By: Claude <Model> 5.5 <noreply@anthropic.com>`).

## Rulings (orchestrator)

- **P1 — merge base and the `r7` old build.** The branch `remainder-r7` is cut from `main` after this plan's commit. `git diff --stat d39e47e2 HEAD -- src scripts tests` is empty at plan time (the spec's line refs hold at HEAD `6ec1f712`). Because `src/` changed a lot after R6's base `b0da208a` (improve auto-apply), the `r7` old build is a **fresh** stamp at this branch's merge base: `MB=$(git merge-base HEAD main)`, `git worktree add .worktrees/base-${MB:0:12} $MB`, there `npm ci && npm run build && node scripts/stamp-dist.mjs <that worktree>`. Provenance file `notifications/telegram-notification-adapter.js`. Post-merge runs pass `--old-base-r7 <full sha>`, and from the main checkout also `--live-db /Users/xiaochuan/Projects/adventure/houge.sqlite`; check the node exit code directly, never through a pipe.
- **P2 — the adapter is already protected (spec defect D1).** `src/notifications/telegram-notification-adapter.ts` is in `PROTECTED_FILES` (`self-write-guard.ts:128`, pinned by `tests/capabilities/self-write-guard.test.ts:344`). Decision 4-A is still built as approved: the leaf moves and joins `PROTECTED_FILES`; the adapter line **stays**. The spec's "the loop, the upload and the follow-up line stay self-writable" is false — they stay protected; the adapter edits in Task 1 are protected-surface edits under the approved spec (Tier A).
- **P3 — `checkAttachment`'s `deps.workspace` is a thunk returning the configured path, `() => string | undefined`** (Rev 1.1, codex B1: today `readAttachment` returns `unsupported` at `telegram-notification-adapter.ts:88` **before** calling `workspaceFor` at `:89`; an eagerly evaluated `workspace: this.options.workspaceFor?.(chat_id)` would call it first, and a throwing resolver would then fail the delivery where today it does not). The leaf checks `canUpload`, then calls `deps.workspace()` (outside the try, as today: a throwing resolver with an upload-capable client still throws out of `send()` as today), then `verifiedWorkspace`. So the whole predicate — including the C2 swap check — is in the protected leaf, and the order of calls is verbatim. Return type is the narrower `CheckRefusal | { bytes: Uint8Array }` (`CheckRefusal = Exclude<AttachmentRefusal, "send_failed">`): `checkAttachment` never returns `send_failed`, so `AttachCheck` needs no cast.
- **P4 — `REFUSAL_TEXT` was not exported (spec said "re-exported").** The leaf exports it; the adapter re-exports it and keeps `attachmentRefusedLine`.
- **P5 — `attach_checks` shape.** The loop pushes a check for index `i` only when `i <= MAX_ATTACHMENTS`: the first five results, then exactly one `"over_count"` (index 5) however many paths are past the fifth. The loop still pushes one "⚠ Not attached" **line per** overflow path (unchanged). `send()` returns `{ ...sent, attach_checks }` only when the payload carried a non-empty `attachments` array; otherwise exactly `sent`.
- **P6 — parse consult position and order.** After the merged-runs `outcome.complete` loop (`:1631`), immediately before `recordChatTurn` (`:1632`). One consult per distinct accepted path (`check: "accepted"`, writes nothing under 1-A), then one per distinct refused path (`check: "marker_outside"`), each list in its deduped order. **Tally rule:** `attach.path` recorder calls at parse = |distinct accepted| + |distinct refused| on a success-arm, non-lane turn; at send, per committed delivery = min(n, 5) + (n > 5 ? 1 : 0) for n string paths. Rows: one per refusal (1-A); under a thrown rule, one `refuse`/`fail` row per consult (accepted ones included: `fail` ≠ default).
- **P7 — `recordSafe` logs, never incidents.** `console.error(\`planner supervisor: ${entry.id.replace(".", "_")}_record_failed (${errorCode(e)})\`)` → `planner supervisor: attach_path_record_failed (<code>)`. Not `this.incident`: an incident is a ledger difference and the planted item requires no turn-crash incident.
- **P8 — dispatcher order.** `markDelivered` → `afterDelivered(claimed)` (unchanged position) → `recordAttach(claimed, sent.attach_checks)`. Each in its own try; neither reaches the `markFailed` arm. `recordAttach` logs `[notification-dispatcher] attach_path_record_failed for <notification_id>: <errorCode>`.
- **P9 — import graph (acyclic; do not second-guess).** `notifications/attachment-check.ts` → `omp/workspace.ts` (leaf) + `node:*`; `omp/attachments.ts` → `notifications/attachment-check.ts` (for `inside`) + `omp/protected-paths.ts`; `decisions/entries/attach-path.ts` → type-only `notifications/attachment-check.ts`; `notifications/notification-types.ts` → type-only `attachment-check.ts`; `notifications/notification-dispatcher.ts` → `decisions/decide.ts` + `decisions/entries/attach-path.ts`.
- **P10 — the lease item is synchronous.** `DecisionRecorder.record` is synchronous, so "a recorder that holds 2 s while a second dispatcher polls" cannot run concurrently in one thread. The item runs the second sender **inside** the recorder call: `store.recoverStaleSendingNotifications(<now + TTL + 1 s>)` must return `[]` and a second `NotificationOutbox.claimNext("second", ttl)` must return `null`; afterwards the row is `delivered`, one text and one set of uploads in the log. Under the mutation "record before `markDelivered`" both fail. No wall-clock sleep.
- **P11 — the delivery fixture builds its adapter by hand** when it needs the swap hook: `workspaceTelegramAdapter` (`telegram-poll-runner.ts:126`) takes no `beforeRecheckForTest`. Same body: `new d.TelegramNotificationAdapter(client, { workspaceFor: (c) => d.chatWorkspace(data, c), beforeRecheckForTest })`. Every other item uses `d.workspaceTelegramAdapter(client, data)`.
- **P12 — fake omp gains one key.** Wiring (c) and live-gate line 3 use `rpcText: "ok\n[[attach: in.txt]]\n[[attach: ../outside.txt]]"` (`fake-omp.mjs:118` sends `rpcText` verbatim). The fake has no scenario whose turn carries text and is then lost (`rpcErrorText` blanks the text, `:118`; `rpcHangAfterPrompt` sends none; the spec's `rpcPromptError` does not exist). Task 4 adds a per-model `rpcAbortAfterText: true`: `finish()` emits the `message_end` with `rpcText` (stopReason `stop`), then `agent_end` with `aborted: true` — `settle()` maps an omp-reported abort to `planner_exit`/`agent_aborted` (`:889`), so the turn takes `finishFailure` with the marker in its pass. Used by `tests/adr` case 2 and gate line 4.
- **P13 — `createOutboxDispatcher`'s `NotificationAdapters` needs `local` too** (spec §7 line 1 named only `telegram`): gates pass `{ local: new LocalNotificationAdapter(() => undefined), telegram: … }`.
- **P14 — forcing `report_write_failed`** (W1, tests/adr and gate line 4): `stageRunReport` does `mkdirSync(join(projectRoot, "runs", run_id), { recursive: true })`; a **regular file** at `<project>/runs` makes it throw ENOTDIR, so `ompComplete` takes `ompFail(… report_write_failed …)` after the parse row was written. Only `src/report/report-writer.ts:47` creates `<project>/runs` on an omp turn (grep at plan time; `local-project-write-adapter.ts:39` is a write-capability path, not on the turn); `<project>` is `join(tmp.dir, "project")` (`tests/helpers/omp-worker.ts:33`); still, write the file after `ompWorker(...)` is constructed and before `submitTurn`, removing any directory there first (`rmSync(p, { recursive: true, force: true })`), so no EISDIR.
- **P15 — run-less send item:** `outbox.enqueue({ topic: "reply", target: { kind: "telegram", chat_id: "555" }, intent_type: "progress", idempotency_key: "p:1", correlation_id: "p:1", payload: { text: "x", attachments: [...] } })` (no `run_id`) → `claimed.run_id` null.
- **P16 — ADR wording** follows `e86a3eda`: rule 3.2, rule 4's row, rule 4.1 and rule 1.5 are amended in place in this branch (the decision lands in code and ADR together); the History row's last column and the `docs/decisions/README.md` index clause read **"awaiting Paco's signature"** until Paco signs after merge. Rule 1.5's `PROTECTED_FILES` list gains `src/notifications/attachment-check.ts` (the R2 3-A precedent named `telegram-auth.ts` there; the spec named only 4.1 — this is a consistency edit, flagged for the reviewer).
- **P17 — registry literals:** seven `toHaveLength(39)` in `tests/decisions/registry.test.ts` (`:151, :161, :172, :183, :195, :206, :218`) and `scripts/live-gate-ladder-stage4b.mjs:187` (`=== 39`) → 40. The `decision-map.md` row lands in the **same commit** as `ENTRY_IDS` (Task 3): `tests/docs/parity.test.ts:64` (check 4) fails otherwise.
- **P18 — existing assertions that break.** No test or corpus with a recorder delivers a `[[attach` marker (grep at plan time: only `tests/omp/planner-supervisor.test.ts:324,325,331`, `tests/omp/planner-supervisor-settle.test.ts:69`, `tests/omp/workspace.test.ts:31`, `tests/core/lanes/lane-card.test.ts:68–69`, `scripts/live-gate-ladder-2b-hooks.mjs` case 3b — none counts recorder calls). The three `toEqual({ text, attachments })` at `planner-supervisor.test.ts:324,325,331` gain `refused` (Task 2). Task 6 re-greps on the new dist; a mismatch with P6's tally rule is a finding, not a re-pin.
- **P19 — test-store access:** `store.db` is private; use `(store as unknown as { db: { prepare(s: string): { all(...a: unknown[]): Array<Record<string, unknown>> } } }).db`. Known flakes: "aborts on the turn deadline" and "a start slower than the deadline is cancelled" in `planner-supervisor.test.ts` — rerun alone before chasing.
- **P20 — a planted throwing rule runs through the production consult:** replace `ATTACH_PATH.ladder[0].decide` (cast) for the case, restore in `finally`. A planted registry mistake replaces `ATTACH_PATH.ladder` with `[{ kind: "system_one", name: "x", questions: [], bars: { kind: "provisional", question: "q", criteriaHash: "h", model: "m", p: 0.5, source: "t" }, timeoutMs: 1 }]` for the case, restored in `finally` (`decideSync` throws before recording, `decide.ts:25–26`).
- **P22 — `parse_ok_send_swapped` crosses fixtures.** The supervisor fixture's chat is `42` but its runs notify chat `555`; the item enqueues the parse's accepted attachments with `store.enqueueFinalReportNotification` (the fixture sink does not) and builds the adapter with `workspaceFor: () => d.chatWorkspace(supervisorData, "42")`, after replacing the accepted file with a symlink out.
- **P21 — mutation list** (each must fail a named test or corpus requirement once, then reverted; show the failing output in the task report): (M1) dispatcher records before `markDelivered` — Task 5 timing + lease cases, corpus `write_timing`/`lease`; (M2) a temporary recorder hook in the adapter called right after each check (inside the loop) — corpus `write_timing`; (M3) the overflow pushes one check per path (the `if (i <= MAX_ATTACHMENTS)` guard dropped) — Task 1 nine-files case, corpus `nine_files`; (M4) `not_found` mapped to its own new line text — Task 1 line-bytes case, corpus `missing`; (M5) parse consult moved after `recordChatTurn` — Task 4 `recordChatTurn` throws case; (M6) `recordSafe` replaced by `record` — Task 4 planted-rung case; (M7) `too_large`/`linked` swapped in the rule — Task 3 entry table, corpus required rows; (M8) `recorder` dropped from `runTelegramPollOnce`'s dispatcher — Task 5 wiring (a) and (d); (M10) the `/status` suffix counts a `fail` row as send — Task 3 suffix case.

## Spec defects found (claims the code contradicts)

- **D1** §3 "Protected: … Not protected: … `src/notifications/` …", §4.2 "the loop, the upload and the follow-up line stay self-writable", §9 "Not protected: `src/notifications/telegram-notification-adapter.ts`": false — the adapter is in `PROTECTED_FILES` since `6ac4b0d2` (`self-write-guard.ts:128`). Ruled P2.
- **D2** §4.2 "`REFUSAL_TEXT` … re-exported from the adapter so every import stays valid": it is a module-private `const` today. Ruled P4.
- **D3** §6 fixture "`workspaceTelegramAdapter` from the given dist … `beforeRecheckForTest` exposed": that factory takes no hook. Ruled P11.
- **D4** §6 lease item "recorder holds 2 s while a second dispatcher polls": impossible in one thread with a synchronous recorder. Ruled P10.
- **D5** §7 line 1 `createOutboxDispatcher(copy, { telegram: … })`: `NotificationAdapters` requires `local`. Ruled P13.
- **D6** §4.1 "Existing callers ignore `refused`": three test assertions use `toEqual` on the whole result and break. Ruled P18.
- **D7** §4.1 "The two sets are disjoint (one workspace, one predicate, one synchronous call)": each pass is parsed by its own synchronous call; a path accepted in pass 0's parse and refused in pass 1's (another process swapped it between the two calls) lands in both lists. Not a behaviour change (the accepted list is today's); the row then records the observed check. The disjointness test pins it on a static filesystem only.
- **D9** §7 line 4 "a failing turn (`rpcPromptError`)": `fake-omp.mjs` has no such key, and none of its failing scenarios carries reply text (`rpcErrorText` blanks it), so a failed production turn with a marker in its pass cannot be built today. Ruled P12 (`rpcAbortAfterText`).
- **D10** §4.0 "If `outcome.complete` itself throws, `finishSuccess` throws before the consult": true, and the throw then propagates out of `settle()` into the turn-crash path — a pre-existing exposure shared by `recordChatTurn`; not changed here (pinned by Task 4 case 9).
- **D11 (2026-11-08, plan Rev 1.1, Fable B2)** §6 faults "excludes **only those two rows**" (the incident and the `change_log` row): an insert fault writes **three** — `openIncident` also appends an `incident_opened` ledger event (`run-store.ts:6142–6178`). Task 7 excludes and asserts all three.
- **D12 (2026-11-08, plan Rev 1.1, Fable B1)** §7 line 4 / §4.0 W1 "nothing sent" after `report_write_failed`: a `${run}:final_report` outbox row **is** written — the failure notice (`ompFail` → `plannerFailureText` non-null, `omp-turn-wiring.ts:76–78` → `enqueueFailureNotification`, `run-store.ts:7470–7482`). The true meaning is "no attachment payload, no file sent".
- **D13 (2026-11-08, plan Rev 1.1, codex B1)** §4.2 `deps = { canUpload: boolean; workspace: string | undefined; … }`: an eagerly passed workspace calls `workspaceFor` before the `unsupported` check, against today's order (`adapter:88–89`). Ruled P3 (a thunk).
- **D8** §4.0/§6 tally "recorder calls `attach.path` +1 per distinct marker path in `finishSuccess`": exact under P6 — distinct accepted + distinct refused (a path cannot be in both on a static filesystem; D7).

---

## File map

| File | Task | Responsibility |
|---|---|---|
| `src/notifications/attachment-check.ts` (new, protected) | 1 | `checkAttachment`, `overCount`, `inside`, limits, `AttachmentRefusal`, `CheckRefusal`, `AttachCheck`, `REFUSAL_TEXT` |
| `src/notifications/telegram-notification-adapter.ts` (protected) | 1 | delegates to the leaf; re-exports; returns `attach_checks` |
| `src/notifications/notification-types.ts` | 1 | `NotificationSendResult.attach_checks?` |
| `src/capabilities/self-write-guard.ts`, `tests/capabilities/self-write-guard.test.ts` | 1 | the leaf in `PROTECTED_FILES` |
| `tests/notifications/attachment-check.test.ts` (new), `tests/notifications/telegram-notification-adapter.test.ts` | 1 | predicate and adapter pins |
| `src/omp/attachments.ts`, `src/omp/supervisor-settle.ts`, `src/omp/planner-supervisor.ts` (`delivered()`) | 2 | `refused` |
| `tests/omp/planner-supervisor.test.ts:324–331`, `tests/omp/attachments.test.ts` (new) | 2 | parse pins |
| `src/decisions/entries/attach-path.ts` (new), `entry-ids.ts`, `registry.ts`, `status-lines.ts` | 3 | entry, suffix |
| `tests/decisions/attach-path.test.ts` (new), `registry.test.ts`, `status-lines.test.ts`, `scripts/live-gate-ladder-stage4b.mjs:187`, `docs/reference/decision-map.md` | 3 | pins, 39 → 40, map row |
| `src/omp/planner-supervisor.ts` (`finishSuccess`, `recordAttach`, `recordSafe`) | 4 | parse consult |
| `tests/omp/attach-decisions.test.ts` (new), `tests/core/supervisor-decision-wiring.test.ts`, `tests/fixtures/fake-omp.mjs` (`rpcAbortAfterText`) | 4 | rows, wiring (c), (c') |
| `src/notifications/notification-dispatcher.ts`, `src/telegram/telegram-daemon.ts:176–178`, `src/telegram/telegram-poll-runner.ts:243–246`, `src/cli.ts:129–140` | 5 | send consult, wiring |
| `tests/notifications/notification-dispatcher.test.ts`, `tests/telegram/attach-decision-wiring.test.ts` (new) | 5 | rows, timing, lease, faults, wiring (a)(b)(d) |
| `scripts/stage4-diff-lib.mjs`, `scripts/check-ladder-stage4-differential.mjs`, `scripts/stage4-supervisor-fixture.mjs`, `scripts/stage4-delivery-fixture.mjs` (new) | 6 | `r7` pair, fixtures |
| `scripts/stage4-corpora/attach.mjs` (new) | 7 | corpus |
| `scripts/live-gate-ladder-remainder-r7.mjs` (new) | 8 | live gate |
| `scripts/check-ladder-remainder-r7-rollback.mjs` (new) | 9 | rollback |
| `docs/decisions/0034-…md`, `docs/decisions/README.md`, `tests/adr/0034-settle-delivery-rows.test.ts` (new), ROADMAP, ladder spec §6.1, `tasks/*`, `sessions.md` | 10 | ADR + docs |

---

### Task 1: The send predicate in a protected leaf; the adapter returns its checks

**Files:**
- Create: `src/notifications/attachment-check.ts`, `tests/notifications/attachment-check.test.ts`
- Modify: `src/notifications/telegram-notification-adapter.ts:1–42, 47–58, 65–110, 161–171`, `src/notifications/notification-types.ts:77–79`, `src/capabilities/self-write-guard.ts:128`, `tests/capabilities/self-write-guard.test.ts:115, 344`, `tests/notifications/telegram-notification-adapter.test.ts` (append)

**Interfaces:**
- Produces: `MAX_ATTACHMENTS = 5`, `MAX_ATTACHMENT_BYTES`; `type AttachmentRefusal` (11 kinds); `type CheckRefusal = Exclude<AttachmentRefusal, "send_failed">`; `type AttachCheck = "ok" | CheckRefusal`; `REFUSAL_TEXT: Readonly<Record<AttachmentRefusal, string>>`; `inside(root: string, p: string): boolean`; `overCount(i: number): boolean`; `interface CheckDeps { canUpload: boolean; workspace: () => string | undefined; beforeRecheck?: (path: string) => void }`; `checkAttachment(path: string, deps: CheckDeps): CheckRefusal | { bytes: Uint8Array }` — all from `src/notifications/attachment-check.ts`, all re-exported by the adapter. `NotificationSendResult { provider_message_id: string; attach_checks?: readonly AttachCheck[] }`.

- [ ] **Step 1: failing tests.** `tests/notifications/attachment-check.test.ts`:
  ```ts
  import { execFileSync } from "node:child_process";
  import { chmodSync, linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
  import { tmpdir } from "node:os";
  import { join } from "node:path";
  import { afterEach, describe, expect, it } from "vitest";
  import { checkAttachment, inside, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, overCount, REFUSAL_TEXT } from "../../src/notifications/attachment-check.js";
  import * as viaAdapter from "../../src/notifications/telegram-notification-adapter.js";
  import { chatWorkspace } from "../../src/omp/workspace.js";

  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) { try { chmodSync(join(d, "data", "omp", "workspace", "chat-1", "locked.txt"), 0o600); } catch { /* absent */ } rmSync(d, { recursive: true, force: true }); } });
  function layout() {
    const root = mkdtempSync(join(tmpdir(), "hac-")); dirs.push(root);
    const ws = chatWorkspace(join(root, "data"), "1"); mkdirSync(ws, { recursive: true });
    return { root, ws, deps: { canUpload: true, workspace: () => ws } };
  }

  describe("attach.path's send predicate (spec R7 §4.2): today's checks, verbatim, two reasons split", () => {
    it("a regular file inside the verified workspace yields its exact bytes", () => {
      const { ws, deps } = layout(); writeFileSync(join(ws, "a.csv"), "x,y\n");
      const r = checkAttachment(join(ws, "a.csv"), deps);
      expect(typeof r).toBe("object");
      expect(Buffer.from((r as { bytes: Uint8Array }).bytes).toString()).toBe("x,y\n");
    });
    it("checks in today's order: unsupported before the workspace, the workspace before the file", () => {
      const { ws } = layout();
      const boom = () => { throw new Error("must not resolve the workspace"); };
      expect(checkAttachment(join(ws, "missing"), { canUpload: false, workspace: boom })).toBe("unsupported"); // the resolver is never called (adapter :88 before :89)
      expect(checkAttachment(join(ws, "missing"), { canUpload: true, workspace: () => undefined })).toBe("workspace_unverified");
    });
    it("a workspace replaced by a symlink is workspace_unverified (C2), not outside_workspace", () => {
      const { root, ws, deps } = layout(); writeFileSync(join(ws, "a.txt"), "a");
      renameSync(ws, join(root, "real")); symlinkSync(join(root, "real"), ws);
      expect(checkAttachment(join(ws, "a.txt"), deps)).toBe("workspace_unverified");
    });
    it("each file refusal names its own reason", () => {
      const { root, ws, deps } = layout();
      writeFileSync(join(ws, "big.bin"), ""); truncateSync(join(ws, "big.bin"), 21 * 1024 * 1024);
      mkdirSync(join(ws, "folder")); execFileSync("mkfifo", [join(ws, "x.pdf")]);
      writeFileSync(join(root, "secret.txt"), "S"); linkSync(join(root, "secret.txt"), join(ws, "notes.txt"));
      writeFileSync(join(root, "other.txt"), "O"); symlinkSync(join(root, "other.txt"), join(ws, "leak.txt")); // its own target: secret.txt has nlink 2
      writeFileSync(join(ws, "locked.txt"), "L"); chmodSync(join(ws, "locked.txt"), 0o000);
      expect(checkAttachment(join(ws, "big.bin"), deps)).toBe("too_large");
      expect(checkAttachment(join(ws, "folder"), deps)).toBe("not_a_file");
      expect(checkAttachment(join(ws, "x.pdf"), deps)).toBe("not_a_file"); // O_NONBLOCK: never blocks
      expect(checkAttachment(join(ws, "notes.txt"), deps)).toBe("linked");
      expect(checkAttachment(join(ws, "leak.txt"), deps)).toBe("outside_workspace");
      expect(checkAttachment(join(ws, "nothing.txt"), deps)).toBe("not_found");
      expect(checkAttachment(join(ws, "locked.txt"), deps)).toBe("unreadable"); // EACCES (the suite never runs as root)
    }, 2_000);
    it("a swap between the open and the re-check is changed", () => {
      const { ws } = layout(); writeFileSync(join(ws, "r.txt"), "one");
      const swap = (p: string) => { renameSync(p, join(ws, "old.txt")); writeFileSync(p, "two"); };
      expect(checkAttachment(join(ws, "r.txt"), { canUpload: true, workspace: () => ws, beforeRecheck: swap })).toBe("changed");
    });
    it("overCount is today's i >= MAX_ATTACHMENTS; the split reasons keep Paco's words", () => {
      expect(MAX_ATTACHMENTS).toBe(5); expect(MAX_ATTACHMENT_BYTES).toBe(20 * 1024 * 1024);
      expect([0, 4, 5, 8].map(overCount)).toEqual([false, false, true, true]);
      expect(REFUSAL_TEXT.workspace_unverified).toBe("outside my workspace");
      expect(REFUSAL_TEXT.not_found).toBe("could not be read");
      expect(REFUSAL_TEXT.outside_workspace).toBe("outside my workspace");
      expect(REFUSAL_TEXT.unreadable).toBe("could not be read");
      expect(Object.keys(REFUSAL_TEXT).sort()).toEqual(["changed", "linked", "not_a_file", "not_found", "outside_workspace", "over_count", "send_failed", "too_large", "unreadable", "unsupported", "workspace_unverified"]);
    });
    it("inside: one helper, re-exported by the adapter", () => {
      expect([inside("/w", "/w/a"), inside("/w", "/w"), inside("/w", "/x"), inside("/w", "/w/../x")]).toEqual([true, false, false, false]);
      expect(viaAdapter.inside).toBe(inside); expect(viaAdapter.checkAttachment).toBe(checkAttachment); expect(viaAdapter.REFUSAL_TEXT).toBe(REFUSAL_TEXT);
    });
  });
  ```
  Append to `tests/notifications/telegram-notification-adapter.test.ts`, inside the existing `describe("… omp turn attachments …")` (reuse its `setup`):
  ```ts
  it("R7 §4.2: send() returns attach_checks — the first five checks, then ONE over_count for the whole overflow; a line per overflow path as today", async () => {
    const seen: string[] = [];
    const { ws, docs, texts, send } = setup((p) => { seen.push(p); });
    const files = Array.from({ length: 9 }, (_, i) => { const p = join(ws, `f${i}.txt`); writeFileSync(p, `c${i}`); return p; });
    const r = await send(files);
    expect(r).toEqual({ provider_message_id: "telegram:1", attach_checks: ["ok", "ok", "ok", "ok", "ok", "over_count"] });
    expect(docs.map((d) => d.filename)).toEqual(["f0.txt", "f1.txt", "f2.txt", "f3.txt", "f4.txt"]);
    expect(seen).toEqual(files.slice(0, 5)); // paths past the fifth are never opened
    expect(texts[1]!.text).toBe(["f5.txt", "f6.txt", "f7.txt", "f8.txt"].map((n) => `⚠ Not attached: ${n} (more than 5 files)`).join("\n"));
  });
  it("R7 §4.2: line bytes are today's for the split reasons; a refused file never reaches sendDocument", async () => {
    const { ws, docs, texts, send } = setup();
    writeFileSync(join(ws, "big.bin"), ""); truncateSync(join(ws, "big.bin"), MAX_ATTACHMENT_BYTES + 1);
    const r = await send([join(ws, "big.bin"), join(ws, "gone.txt")]);
    expect(r).toEqual({ provider_message_id: "telegram:1", attach_checks: ["too_large", "not_found"] });
    expect(docs).toEqual([]);
    expect(texts[1]!.text).toBe("⚠ Not attached: big.bin (over 20 MB)\n⚠ Not attached: gone.txt (could not be read)");
  });
  it("R7 §4.2: no workspace resolver → workspace_unverified, line text 'outside my workspace' byte for byte", async () => {
    const sent: string[] = [];
    const adapter = new TelegramNotificationAdapter({ sendMessage: async (i) => { sent.push(i.text); return { message_id: 3 }; }, sendDocument: async () => { throw new Error("must not send"); } });
    const r = await adapter.send({ ...dispatch("x"), payload: { text: "x", attachments: ["/tmp/whatever.txt"] } });
    expect(r).toEqual({ provider_message_id: "telegram:3", attach_checks: ["workspace_unverified"] });
    expect(sent[1]).toBe("⚠ Not attached: whatever.txt (outside my workspace)");
  });
  it("R7 §2: send_failed is execution — the check was ok; a client without sendDocument is unsupported", async () => {
    const root = mkdtempSync(join(tmpdir(), "hna-")); dirs.push(root);
    const ws = join(root, "workspace", "chat-222"); mkdirSync(ws, { recursive: true }); writeFileSync(join(ws, "a.txt"), "a");
    const texts: string[] = [];
    const failing = new TelegramNotificationAdapter({ sendMessage: async (i) => { texts.push(i.text); return { message_id: 4 }; }, sendDocument: async () => { throw new Error("400"); } }, { workspaceFor: () => ws });
    expect(await failing.send({ ...dispatch("x"), payload: { text: "x", attachments: [join(ws, "a.txt")] } })).toEqual({ provider_message_id: "telegram:4", attach_checks: ["ok"] });
    expect(texts[1]).toBe("⚠ Not attached: a.txt (Telegram refused the upload)");
    const noDocs = new TelegramNotificationAdapter({ sendMessage: async () => ({ message_id: 5 }) }, { workspaceFor: () => ws });
    expect(await noDocs.send({ ...dispatch("x"), payload: { text: "x", attachments: [join(ws, "a.txt")] } })).toEqual({ provider_message_id: "telegram:5", attach_checks: ["unsupported"] });
  });
  it("R7 Rev 1.1 (codex B1): without sendDocument the workspace resolver is never called — a throwing resolver still yields unsupported and the delivery resolves", async () => {
    let calls = 0;
    const adapter = new TelegramNotificationAdapter({ sendMessage: async () => ({ message_id: 6 }) }, { workspaceFor: () => { calls += 1; throw new Error("resolver down"); } });
    await expect(adapter.send({ ...dispatch("x"), payload: { text: "x", attachments: ["/tmp/a.txt", "/tmp/b.txt"] } }))
      .resolves.toEqual({ provider_message_id: "telegram:6", attach_checks: ["unsupported", "unsupported"] });
    expect(calls).toBe(0);
  });
  it("R7 §4.2: an all-accepted payload returns its checks although no follow-up line is sent", async () => {
    const { ws, texts, send } = setup(); writeFileSync(join(ws, "a.txt"), "a");
    expect(await send([join(ws, "a.txt")])).toEqual({ provider_message_id: "telegram:1", attach_checks: ["ok"] });
    expect(texts).toHaveLength(1);
  });
  ```
  (`setup()`'s `sendMessage` returns `message_id: texts.length` → the first text is id 1. Add `truncateSync`/`writeFileSync` imports if missing.) Guard test: in `protectedHits` add `["attachment-check (attach.path's send predicate, locked, R7 Decision 4-A)", entry({ status: "M", path: "src/notifications/attachment-check.ts" })]`; in the `:344` list add `"src/notifications/attachment-check.ts"` (M, A and D all denied).
- [ ] **Step 2: run** `npx vitest run tests/notifications tests/capabilities/self-write-guard.test.ts` → FAIL (module missing; guard allows the leaf).
- [ ] **Step 3: implement.** `src/notifications/attachment-check.ts` (the body of `readAttachment` and `readExactly` moved verbatim; only the two returns change):
  ```ts
  import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
  import { isAbsolute, relative, sep } from "node:path";
  import { verifiedWorkspace } from "../omp/workspace.js";

  /**
   * attach.path's send predicate (spec R7 §4.2, Decision 4-A; ADR 0034 4.1): the send-time re-check of one `[[attach:]]` file, moved verbatim
   * from the Telegram adapter into this protected leaf. omp turn attachments (spec §7): at most 5 files, each at most 20 MB.
   */
  export const MAX_ATTACHMENTS = 5;
  export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
  export type AttachmentRefusal =
    | "outside_workspace" | "not_a_file" | "too_large" | "over_count" | "unreadable" | "send_failed" | "unsupported" | "linked" | "changed"
    | "workspace_unverified" | "not_found";
  /** What a check can answer: every refusal but `send_failed` (an upload that failed after the check passed). */
  export type CheckRefusal = Exclude<AttachmentRefusal, "send_failed">;
  /** One observed send-time check (spec R7 §4.2): closed enums, never a path. */
  export type AttachCheck = "ok" | CheckRefusal;
  /** Paco's words per refusal. The R7 split reasons reuse today's text, so every line he reads is byte-identical. */
  export const REFUSAL_TEXT: Readonly<Record<AttachmentRefusal, string>> = {
    outside_workspace: "outside my workspace", not_a_file: "not a regular file", too_large: "over 20 MB",
    over_count: "more than 5 files", unreadable: "could not be read", send_failed: "Telegram refused the upload", unsupported: "this chat cannot take files",
    linked: "a hard-linked file", changed: "it changed while I was sending it",
    workspace_unverified: "outside my workspace", not_found: "could not be read"
  };

  /** The one containment helper (spec R7 §4.1): `p` strictly inside `root`. */
  export function inside(root: string, p: string): boolean {
    const rel = relative(root, p);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  }

  /** The count cap, today's `i >= MAX_ATTACHMENTS`: true for every path past the fifth. */
  export function overCount(i: number): boolean { return i >= MAX_ATTACHMENTS; }

  export interface CheckDeps {
    /** The client can upload a document (today's `client.sendDocument` truthiness). */
    canUpload: boolean;
    /** The chat's configured workspace (unverified), resolved lazily: called only after canUpload, as today; undefined → every file is refused. */
    workspace: () => string | undefined;
    /** @internal Tests only: runs between opening the file and re-checking its path (simulates a swap in that window). */
    beforeRecheck?: (path: string) => void;
  }

  /**
   * Open once, then prove the open file is the one the path names inside the workspace: fstat the fd (regular, ≤ 20 MB, a single link),
   * re-resolve the path and require the same dev+ino with the realpath inside the workspace, then read exactly the checked size from that fd.
   * A swap anywhere in the path between the open and the read can only make the check fail, never redirect the upload.
   */
  export function checkAttachment(path: string, deps: CheckDeps): CheckRefusal | { bytes: Uint8Array } {
    if (!deps.canUpload) return "unsupported";
    const configured = deps.workspace();
    const workspace = configured ? verifiedWorkspace(configured) : null; // a swapped workspace is no workspace (C2)
    if (!workspace) return "workspace_unverified";
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK); // a FIFO must never block the daemon's only thread
      const st = fstatSync(fd);
      if (!st.isFile()) return "not_a_file";
      if (st.size > MAX_ATTACHMENT_BYTES) return "too_large";
      if (st.nlink > 1) return "linked";
      deps.beforeRecheck?.(path);
      const real = realpathSync(path);
      if (!inside(workspace, real)) return "outside_workspace";
      const again = statSync(real);
      if (again.dev !== st.dev || again.ino !== st.ino) return "changed";
      return { bytes: readExactly(fd, st.size) };
    } catch (e) {
      return (e as NodeJS.ErrnoException | null)?.code === "ENOENT" ? "not_found" : "unreadable";
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  /** Read exactly `size` bytes from the start of `fd` (a short read means the file changed: refuse). */
  function readExactly(fd: number, size: number): Uint8Array {
    const buf = Buffer.alloc(size);
    let off = 0;
    while (off < size) {
      const n = readSync(fd, buf, off, size - off, off);
      if (n === 0) throw new Error("short read");
      off += n;
    }
    return buf;
  }
  ```
  Adapter: delete lines 17–26's constants/type/`REFUSAL_TEXT`, the local `inside` (`:39–42`), `readExactly` (`:161–171`) and the fs/`verifiedWorkspace` imports they used; keep `basename`. Add:
  ```ts
  import { checkAttachment, MAX_ATTACHMENTS, overCount, REFUSAL_TEXT, type AttachCheck, type AttachmentRefusal } from "./attachment-check.js";
  export { checkAttachment, inside, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, overCount, REFUSAL_TEXT, type AttachCheck, type AttachmentRefusal, type CheckRefusal } from "./attachment-check.js";
  ```
  (`attachmentRefusedLine` stays as is, reading the imported `REFUSAL_TEXT`.) `send()`:
  ```ts
  const sent = await this.sendText(chat_id, notification);
  const attachments = notification.payload.attachments;
  if (Array.isArray(attachments) && attachments.length > 0) {
    const attach_checks = await this.sendAttachments(chat_id, attachments.filter((a): a is string => typeof a === "string"));
    return { ...sent, attach_checks }; // spec R7 §4.2: the checks the loop already made, enums only; the dispatcher records them after markDelivered
  }
  return sent;
  ```
  `sendAttachments` (doc comment kept, plus one line "Returns each check (spec R7 §4.2): the first five, then one over_count for the overflow."):
  ```ts
  private async sendAttachments(chat_id: string, paths: string[]): Promise<AttachCheck[]> {
    const refused: string[] = [];
    const checks: AttachCheck[] = [];
    for (const [i, path] of paths.entries()) {
      const name = basename(path);
      const checked = overCount(i) ? "over_count" : this.readAttachment(chat_id, path);
      if (i <= MAX_ATTACHMENTS) checks.push(typeof checked === "string" ? checked : "ok");
      if (typeof checked === "string") { refused.push(attachmentRefusedLine(name, checked)); continue; }
      try {
        await this.client.sendDocument?.({ chat_id, filename: name, content: checked.bytes });
      } catch {
        refused.push(attachmentRefusedLine(name, "send_failed"));
      }
    }
    if (refused.length === 0) return checks;
    await this.sendText(chat_id, { payload: { text: refused.join("\n") } }).catch(() => undefined);
    return checks;
  }

  /** The protected predicate (attachment-check.ts) over this chat's configured workspace. */
  private readAttachment(chat_id: string, path: string): ReturnType<typeof checkAttachment> {
    return checkAttachment(path, { canUpload: Boolean(this.client.sendDocument), workspace: () => this.options.workspaceFor?.(chat_id),
      ...(this.options.beforeRecheckForTest ? { beforeRecheck: this.options.beforeRecheckForTest } : {}) });
  }
  ```
  `notification-types.ts`:
  ```ts
  import type { AttachCheck } from "./attachment-check.js";
  // …
  export interface NotificationSendResult {
    provider_message_id: string;
    /** The attachment checks this delivery made (spec R7 §4.2): enums only, never a path; absent when the payload carried none. */
    attach_checks?: readonly AttachCheck[];
  }
  ```
  `self-write-guard.ts`, after the adapter line `:128`: `"src/notifications/attachment-check.ts", // attach.path's send predicate (locked; R7 Decision 4-A): checkAttachment/overCount, one inside`.
- [ ] **Step 4: run** Step 2's command, `npx vitest run tests/omp/workspace.test.ts tests/eval`, `npm run typecheck` → PASS, 0 skipped. Show M3 and M4 each failing once, reverted.
- [ ] **Step 5: commit** `refactor(notifications): attach.path's send predicate in a protected leaf; the adapter returns its checks`.

---

### Task 2: `parseAttachments` returns what it refused; `delivered()` carries it

**Files:**
- Modify: `src/omp/attachments.ts`, `src/omp/supervisor-settle.ts:3, :90`, `src/omp/planner-supervisor.ts:1613–1618`, `tests/omp/planner-supervisor.test.ts:324–331`
- Create: `tests/omp/attachments.test.ts`

**Interfaces:**
- Consumes: `inside` (Task 1).
- Produces: `parseAttachments(text: string, workspace: string): { text: string; attachments: string[]; refused: string[] }`; `Delivered { text: string; attachments: readonly string[]; refused: readonly string[] }`.

- [ ] **Step 1: failing tests.** `tests/omp/attachments.test.ts`:
  ```ts
  import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
  import { tmpdir } from "node:os";
  import { join } from "node:path";
  import { afterEach, describe, expect, it } from "vitest";
  import { parseAttachments } from "../../src/omp/attachments.js";

  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  describe("parseAttachments (spec R7 §4.1): the refused list is the else of today's if", () => {
    it("text and attachments are today's; refused holds each refused marker's resolved path in line order; the lists are disjoint", () => {
      const d = mkdtempSync(join(tmpdir(), "hpa-")); dirs.push(d);
      const ws = join(d, "ws"); mkdirSync(ws); writeFileSync(join(d, "secret"), "k"); symlinkSync(join(d, "secret"), join(ws, "leak"));
      writeFileSync(join(ws, "ok.txt"), "o");
      const text = ["intro", "[[attach: ok.txt]]", "  [[attach:   ../up.txt ]]  ", "[[attach: /etc/hosts]]", "[[attach: leak]]", "[[attach: later.txt]]", "outro"].join("\n");
      const r = parseAttachments(text, ws);
      expect(r).toEqual({ text: "intro\noutro", attachments: [join(ws, "ok.txt"), join(ws, "later.txt")], refused: [join(d, "up.txt"), "/etc/hosts", join(ws, "leak")] });
      expect(r.attachments.filter((a) => r.refused.includes(a))).toEqual([]); // disjoint on a static filesystem (D7)
    });
    it("no marker → nothing refused; a text without markers is returned trimmed as today", () => {
      expect(parseAttachments("  hi\n", "/w")).toEqual({ text: "hi", attachments: [], refused: [] });
    });
  });
  ```
  Update `tests/omp/planner-supervisor.test.ts`:
  ```ts
  expect(parseAttachments("done\n[[attach: out/report.pdf]]", "/w")).toEqual({ text: "done", attachments: ["/w/out/report.pdf"], refused: [] });
  expect(parseAttachments("x\n[[attach: ../../etc/passwd]]", "/w")).toEqual({ text: "x", attachments: [], refused: ["/etc/passwd"] });
  // :331
  expect(parseAttachments("x\n[[attach: leak]]", ws)).toEqual({ text: "x", attachments: [], refused: [join(ws, "leak")] });
  ```
  And in `tests/omp/planner-supervisor-settle.test.ts` after the `:69` case, a new case (same `held()`/`harness` shape):
  ```ts
  it("R7 §4.1: delivered() keeps the accepted list and dedupes the refused one across passes (same used set)", async () => {
    const { session, h } = held(); const { store, sup, outcome, data } = harness(session);
    const ws = chatWorkspace(data, "42"); mkdirSync(ws, { recursive: true }); writeFileSync(join(ws, "r.txt"), "r");
    const run_id = createQueuedTurnRun(store); sup.submit(req(run_id)); await running(sup, h);
    h.say("Report.\n[[attach: r.txt]]\n[[attach: ../x]]"); sendBack(sup);
    h.emit({ type: "agent_start" }); h.say("Full report.\n[[attach: ../x]]"); h.emit({ type: "agent_end" }); await sup.whenIdle();
    expect(outcome.done[0]).toMatchObject({ text: "Full report.", attachments: [join(ws, "r.txt")] });
    expect(Object.keys(outcome.done[0] as object)).not.toContain("refused"); // 5-A: refused never reaches outcome.complete
  });
  ```
- [ ] **Step 2: run** `npx vitest run tests/omp/attachments.test.ts tests/omp/planner-supervisor.test.ts tests/omp/planner-supervisor-settle.test.ts` → FAIL.
- [ ] **Step 3: implement.** `src/omp/attachments.ts`:
  ```ts
  import { resolve as resolvePath } from "node:path";
  import { inside } from "../notifications/attachment-check.js";
  import { realpathOrSelf } from "./protected-paths.js";

  /**
   * `[[attach: <path>]]` lines leave the text; a path is kept only if it (and its real target) is inside the workspace. attach.path's parse
   * predicate (spec R7 §4.1; ADR 0034 4.1): `refused` is that if's else, each refused marker's resolved path in line order.
   */
  export function parseAttachments(text: string, workspace: string): { text: string; attachments: string[]; refused: string[] } {
    const attachments: string[] = [];
    const refused: string[] = [];
    const kept = text.split("\n").filter((line) => {
      const m = /^\s*\[\[attach:\s*(.+?)\s*\]\]\s*$/.exec(line);
      if (!m) return true;
      const abs = resolvePath(workspace, m[1] as string);
      if (inside(workspace, abs) && inside(realpathOrSelf(workspace), realpathOrSelf(abs))) attachments.push(abs);
      else refused.push(abs);
      return false;
    });
    return { text: kept.join("\n").trim(), attachments, refused };
  }
  ```
  `supervisor-settle.ts:3`: the import comment becomes `// a leaf module apart from the protected attachment leaf it imports (notifications/attachment-check.ts → omp/workspace.ts): no runtime cycle` (Task 2 made "a leaf module" false). `supervisor-settle.ts:90`: `export interface Delivered { text: string; attachments: readonly string[]; /** attach.path at parse (spec R7 §4.1): refused marker paths, deduped; never reaches outcome.complete. */ refused: readonly string[] }`. `planner-supervisor.ts` `delivered()`:
  ```ts
  private delivered(t: Turn): Delivered {
    // spec §3.5: a model error in pass 1 completes with pass 0 alone (an errored fragment is never delivered)
    const used = t.continuationFailed ? t.passes.slice(0, 1) : t.passes;
    const ws = this.workspace();
    const parsed = used.map((p) => parseAttachments(p.final, ws));
    const attachments = [...new Set(parsed.flatMap((p) => p.attachments))];
    const refused = [...new Set(parsed.flatMap((p) => p.refused))]; // spec R7 §4.1: the same used set and dedupe as the accepted list
    return { text: parseAttachments(replyOfPasses(used), ws).text, attachments, refused };
  }
  ```
  (`chatWorkspace` is a pure `join`, so one call instead of one per pass changes nothing observable; one `parseAttachments` call per pass, as today.)
- [ ] **Step 4: run** Step 2's command, `npx vitest run tests/omp tests/core/lanes`, `npm run typecheck` → PASS, 0 skipped.
- [ ] **Step 5: commit** `refactor(omp): parseAttachments returns the paths it refused; delivered() carries them`.

---

### Task 3: The `attach.path` entry, the registry, the `/status` suffix

**Files:**
- Create: `src/decisions/entries/attach-path.ts`, `tests/decisions/attach-path.test.ts`
- Modify: `src/decisions/entry-ids.ts:5`, `src/decisions/registry.ts` (import + list), `src/decisions/status-lines.ts:31–44`, `tests/decisions/registry.test.ts:151,161,172,183,195,206,218` (+ one new case), `tests/decisions/status-lines.test.ts`, `scripts/live-gate-ladder-stage4b.mjs:187`, `docs/reference/decision-map.md` (one row after `turn.model`, `:158`)

**Interfaces:**
- Consumes: `type AttachCheck` (Task 1).
- Produces: `ATTACH_PATH_ID = "attach.path"`; `type AttachVerdict = "send" | "refuse"`; `type AttachInput = { seam: "parse"; check: "accepted" | "marker_outside" } | { seam: "send"; check: AttachCheck }`; `SEND_REASONS` (10, readonly tuple); `ATTACH_PATH: Entry<AttachInput, AttachVerdict>`; `countLines` unchanged signature, suffix on the `attach.path` line.

- [ ] **Step 1: failing tests.** `tests/decisions/attach-path.test.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { decideSync } from "../../src/decisions/decide.js";
  import { ATTACH_PATH, SEND_REASONS, type AttachInput } from "../../src/decisions/entries/attach-path.js";
  import { LOCKED_ENTRY_IDS } from "../../src/decisions/entry-ids.js";
  import { storeRecorder } from "../../src/decisions/record.js";
  import { entryById, entryProblems } from "../../src/decisions/registry.js";
  import type { AnyEntry, DecisionRecorder } from "../../src/decisions/types.js";
  import { REFUSAL_TEXT } from "../../src/notifications/attachment-check.js";
  import { RunStore } from "../../src/run/run-store.js";

  const answer = (s: AttachInput) => { const calls: Array<[string, string | null, string]> = [];
    const recorder: DecisionRecorder = { record: (_e, r) => { calls.push([r.verdict, r.reason, r.rung]); return null; } };
    decideSync(ATTACH_PATH, s, { run_id: "run_1", tool_call_id: null, recorder }); return calls[0]; };

  describe("attach.path (spec R7 §4.3)", () => {
    it("maps each seam's answer: accepted/ok send, everything else refuse with the check as its reason", () => {
      expect(answer({ seam: "parse", check: "accepted" })).toEqual(["send", "parsed", "rule"]);
      expect(answer({ seam: "parse", check: "marker_outside" })).toEqual(["refuse", "marker_outside", "rule"]);
      expect(answer({ seam: "send", check: "ok" })).toEqual(["send", "checked", "rule"]);
      for (const c of SEND_REASONS) expect(answer({ seam: "send", check: c })).toEqual(["refuse", c, "rule"]);
    });
    it("the send reasons are exactly the check's refusals (every refusal but send_failed)", () => {
      expect([...SEND_REASONS].sort()).toEqual(Object.keys(REFUSAL_TEXT).filter((k) => k !== "send_failed").sort());
      expect(ATTACH_PATH.reasonCodes).toEqual(["marker_outside", ...SEND_REASONS, "parsed", "checked"]);
    });
    it("is locked, rule-only, settle-stage over tool input; fail refuse, default send; no alwaysRecord (1-A); registered and sound", () => {
      const e = entryById("attach.path") as AnyEntry;
      expect(e).toBe(ATTACH_PATH as unknown as AnyEntry);
      expect([e.stage, e.input, e.locked, e.fail, e.defaultVerdict, e.alwaysRecord]).toEqual(["settle", "tool", true, "refuse", "send", undefined]);
      expect(e.ladder.map((r) => [r.kind, r.name])).toEqual([["rule", "attach_check"]]);
      expect(LOCKED_ENTRY_IDS).toContain("attach.path");
      expect(entryProblems(e)).toEqual([]);
    });
    it("rows (1-A): accepted and ok write none; each refusal writes one with the run; a thrown rule writes refuse at rung fail", () => {
      const store = RunStore.openInMemory();
      try {
        const rec = storeRecorder(store); const ctx = { run_id: "run_1", tool_call_id: null, recorder: rec };
        decideSync(ATTACH_PATH, { seam: "parse", check: "accepted" }, ctx); decideSync(ATTACH_PATH, { seam: "send", check: "ok" }, ctx);
        decideSync(ATTACH_PATH, { seam: "send", check: "too_large" }, ctx);
        const rung = ATTACH_PATH.ladder[0] as { decide: (s: AttachInput) => unknown }; const orig = rung.decide;
        rung.decide = () => { throw new Error("planted"); };
        try { decideSync(ATTACH_PATH, { seam: "send", check: "ok" }, { ...ctx, log: () => undefined }); } finally { rung.decide = orig; }
        expect(store.listDecisionsForRun("run_1").map((r) => [r.entry_id, r.verdict, r.reason_code, r.rung, r.tool_call_id]))
          .toEqual([["attach.path", "refuse", "too_large", "rule", null], ["attach.path", "refuse", null, "fail", null]]);
      } finally { store.close(); }
    });
  });
  ```
  `registry.test.ts`: the seven `toHaveLength(39)` → `40`, and a new case:
  ```ts
  it("attach.path is registered, locked and rule-only (remainder R7); every locked id is now registered", () => {
    const e = entryById("attach.path") as AnyEntry;
    expect(e.locked).toBe(true); expect(e.ladder.map((r) => r.kind)).toEqual(["rule"]); expect(entryProblems(e)).toEqual([]);
    for (const id of LOCKED_ENTRY_IDS) expect(entryById(id), id).toBeDefined();
    expect(ENTRY_IDS).toHaveLength(40);
  });
  ```
  `status-lines.test.ts`, new case:
  ```ts
  it("R7 §4.3: attach.path's line splits its refusals by seam; a fail-rung row is failed; an accepted row changes no count", () => {
    const a = (o: Partial<DecisionInsert>) => row({ entry_id: "attach.path", stage: "settle", rung: "rule", verdict: "refuse", p: null, ...o });
    const rows = [a({ reason_code: "marker_outside" }), a({ reason_code: "too_large" }), a({ reason_code: "workspace_unverified" }), a({ reason_code: "over_count" }),
      a({ rung: "fail", reason_code: null }), a({ verdict: "send", reason_code: "checked" }), a({ verdict: "send", reason_code: "parsed" })];
    expect(countLines(rows)).toEqual(["· attach.path 7 — code 6 · fallback 1 (parse 1 · send 3 · failed 1)"]);
    expect(countLines([a({ reason_code: "marker_outside" })])).toEqual(["· attach.path 1 — code 1 (parse 1 · send 0 · failed 0)"]);
  });
  ```
- [ ] **Step 2: run** `npx vitest run tests/decisions tests/docs` → FAIL.
- [ ] **Step 3: implement.** `src/decisions/entries/attach-path.ts`:
  ```ts
  import type { AttachCheck } from "../../notifications/attachment-check.js";
  import type { Entry, RungAnswer } from "../types.js";

  /** Spec R7 §4.3: may this `[[attach:]]` file go to Paco? Asked at the supervisor's parse (E2) and at the outbox's send-time re-check (E11). */
  export const ATTACH_PATH_ID = "attach.path";
  export type AttachVerdict = "send" | "refuse";
  export type AttachInput = { seam: "parse"; check: "accepted" | "marker_outside" } | { seam: "send"; check: AttachCheck };
  /** The send-time refusals (spec R7 §4.2 split): every check answer but `ok`. */
  export const SEND_REASONS = ["over_count", "workspace_unverified", "outside_workspace", "not_a_file", "too_large", "linked", "changed", "not_found", "unreadable", "unsupported"] as const;

  /** Maps the answer today's code already computed (one read, one predicate); it re-reads nothing. */
  function rule(s: AttachInput): RungAnswer<AttachVerdict> {
    if (s.seam === "parse") return s.check === "accepted" ? { verdict: "send", reason: "parsed" } : { verdict: "refuse", reason: "marker_outside" };
    return s.check === "ok" ? { verdict: "send", reason: "checked" } : { verdict: "refuse", reason: s.check };
  }

  export const ATTACH_PATH: Entry<AttachInput, AttachVerdict> = {
    id: ATTACH_PATH_ID, version: 1, stage: "settle", input: "tool", locked: true,
    question: "May this [[attach:]] file go to Paco: its marker resolves inside the chat's workspace (parse), and at send it is still a single-link regular file of at most 20 MB, one of the first five, inside the verified workspace (send)?",
    verdicts: ["send", "refuse"],
    ladder: [{ kind: "rule", name: "attach_check", decide: rule }],
    fail: "refuse", defaultVerdict: "send", outcomes: [], armed: { rule: "on" },
    effects: {
      send: { kind: "none", reversible: true, announced: "none" },
      refuse: { kind: "tighten", reversible: true, announced: "none", what: "the file is not sent: at send, one '⚠ Not attached: <name> (<why>)' line follows the reply as today; at parse, the marker is dropped silently as today" }
    },
    reasonCodes: ["marker_outside", ...SEND_REASONS, "parsed", "checked"],
  };
  ```
  `entry-ids.ts:5`: append `"attach.path"` after `"turn.model"`. `registry.ts`: `import { ATTACH_PATH } from "./entries/attach-path.js";` after the `TURN_MODEL` import; append `, ATTACH_PATH as unknown as AnyEntry` after `TURN_MODEL as unknown as AnyEntry` in `REGISTRY`. `status-lines.ts`:
  ```ts
  import { ATTACH_PATH_ID } from "./entries/attach-path.js";
  // …
  /** Spec R7 §4.3: attach.path's refusals per seam — a fail-rung row names no seam (failed), marker_outside is parse, every other refusal is send; accepted rows are not counted. */
  // a fail-rung row's reason_code is null (decide.ts: { failed: "threw" } carries no reason), so `rung !== "fail"` below is belt and braces; kept so a future reason on fail rows cannot leak into parse
  function attachSuffix(rows: readonly DecisionRow[]): string {
    const refused = rows.filter((r) => r.entry_id === ATTACH_PATH_ID && r.verdict === "refuse");
    const failed = refused.filter((r) => r.rung === "fail").length;
    const parse = refused.filter((r) => r.rung !== "fail" && r.reason_code === "marker_outside").length;
    return ` (parse ${parse} · send ${refused.length - failed - parse} · failed ${failed})`;
  }
  ```
  and in `countLines`' map, append `${id === ATTACH_PATH_ID ? attachSuffix(rows) : ""}` after the `secret.redact` suffix expression. `stage4b` gate `:187`: `=== 40`. `decision-map.md` after the `turn.model` row:
  `| \`attach.path\` | code rule | tool | refuses an \`[[attach:]]\` file whose marker resolves outside the chat's workspace (parse), or that fails the send-time re-check (send) | live, locked |`
- [ ] **Step 4: run** Step 2's command, `npm run typecheck`, `npx vitest run tests/adr` → PASS, 0 skipped. Show M7 and M10 failing once, reverted.
- [ ] **Step 5: commit** `feat(decisions): attach.path entry (locked, rule-only); /status splits its refusals by seam`.

---

### Task 4: The supervisor consults `attach.path` at parse

**Files:**
- Modify: `src/omp/planner-supervisor.ts` (imports `:14–15`; after `record()` `:428–432`; `finishSuccess` `:1620–1634`), `tests/core/supervisor-decision-wiring.test.ts` (append R7 (c)), `tests/fixtures/fake-omp.mjs` (`finish()` `:116–124`, header comment `:6–8`: `rpcAbortAfterText`, P12)
- Create: `tests/omp/attach-decisions.test.ts`

**Interfaces:**
- Consumes: `ATTACH_PATH` (Task 3), `Delivered.refused` (Task 2).
- Produces: private `recordSafe<S, V extends string>(entry: Entry<S, V>, s: S, run_id: string): void`; private `recordAttach(t: Turn, d: Delivered): void`.

- [ ] **Step 0: confirm the `/kill` path.** Read `abortTurn` (`:1589–1607`): it reads `this.turn`; during `settle()`'s `todoSnapshot` await `this.turn` is still the settling turn (it is cleared only after `finishSuccess`/`finishFailure`; grep `this.turn = ` to confirm), so `t.failure ??=` (`:1592`) lands before `:906`. If it is not the settling turn, stop and report.
- [ ] **Step 1: failing tests.** `tests/omp/attach-decisions.test.ts`:
  ```ts
  import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
  import { join } from "node:path";
  import { afterEach, describe, expect, it, vi } from "vitest";
  import { ATTACH_PATH } from "../../src/decisions/entries/attach-path.js";
  import { storeRecorder } from "../../src/decisions/record.js";
  import type { AnyEntry, DecisionRecorder } from "../../src/decisions/types.js";
  import type { SupervisorDeps } from "../../src/omp/planner-supervisor.js";
  import type { OmpFrame } from "../../src/omp/omp-frames.js";
  import { chatWorkspace } from "../../src/omp/workspace.js";
  import type { PlannerState } from "../../src/omp/planner-session.js";
  import type { RunStore } from "../../src/run/run-store.js";
  import { createQueuedTurnRun } from "../helpers/runs.js";
  import { cleanups, fakeSession, harness, req, until, type Fake } from "../helpers/supervisor-harness.js";

  afterEach(async () => { for (const c of cleanups.splice(0)) await c(); vi.restoreAllMocks(); });
  type Q = { prepare(q: string): { all(...a: unknown[]): Array<Record<string, unknown>> } };
  const rows = (store: RunStore) => (store as unknown as { db: Q }).db.prepare("SELECT verdict, reason_code, rung, run_id, tool_call_id FROM decisions WHERE entry_id = 'attach.path' ORDER BY rowid").all()
    .map((r) => [r.verdict, r.reason_code, r.rung, r.run_id, r.tool_call_id]);
  function withRecorder(session: Fake, extra: Partial<SupervisorDeps> = {}) {
    const cell: { store?: RunStore; calls: string[] } = { calls: [] };
    const recorder: DecisionRecorder = { record: (e, r, c) => { cell.calls.push(e.id); return storeRecorder(cell.store as RunStore).record(e, r, c); } };
    const h = harness(session, {}, { recorder, ...extra }); cell.store = h.store;
    const ws = chatWorkspace(h.data, "42"); mkdirSync(ws, { recursive: true });
    return { ...h, ws, attachCalls: () => cell.calls.filter((id) => id === "attach.path").length };
  }
  /** A child that answers every prompt with `text` and ends the turn. */
  function answering(text: string): Fake {
    const session: Fake = fakeSession({ onPrompt: (_t, e) => { e({ type: "turn_start" }); session.assistant(text); e({ type: "agent_end" }); } });
    return session;
  }
  /** tests/omp/planner-supervisor-settle.test.ts:27: a child whose turn stays open until the test emits. */
  function held() {
    const h: { prompted: boolean; emit: (f: OmpFrame) => void; say: (t: string) => void } = { prompted: false, emit: () => undefined, say: () => undefined };
    const session = fakeSession({ onPrompt: (_t, e) => { h.emit = e; h.say = (t) => session.assistant(t); e({ type: "turn_start" }); e({ type: "agent_start" }); h.prompted = true; } });
    return { session, h };
  }
  ```
  Cases (each asserts `rows(store)` exactly and `attachCalls()` exactly, per P6):
  1. **inside + `../` (production shape):** `s = answering("Done.\n[[attach: in.txt]]\n[[attach: ../x.txt]]")`, `writeFileSync(join(ws, "in.txt"), "i")` before submit → rows `[["refuse", "marker_outside", "rule", run, null]]`; `attachCalls() === 2`; `outcome.done[0]` matches `{ text: "Done.", attachments: [join(ws, "in.txt")] }`; `store.listChatTurns`/the stored assistant turn text (read `chat_turns` via the db cast) is `"Done."`.
  2. **absolute outside, symlink out, not-yet-existing inside:** `symlinkSync("/etc/hosts", join(ws, "out.lnk"))`; text `"x\n[[attach: /etc/hosts]]\n[[attach: out.lnk]]\n[[attach: later.txt]]"` → two `marker_outside` rows (line order), `attachments: [join(ws, "later.txt")]`, `attachCalls() === 3`.
  3. **same refused path in pass 0 and pass 1 → one row:** `held()` flow as the settle test (`sendBack = sup.activeTurnForTest()!.onSendBack!("rule", "")`): pass 0 `"a\n[[attach: ../x]]"`, pass 1 `"b\n[[attach: ../x]]"` → one row; `attachCalls() === 1`.
  4. **a turn that takes the failure arm writes none:** `held()`, `h.say("x\n[[attach: ../x]]")`, then `await sup.abortAll("killed")` → `outcome.failed` has the run; `rows` `[]`; `attachCalls() === 0`.
  5. **`/kill` during the settle snapshot → none:** `held()` flow with a send-back; before pass 1's `agent_end`, `session.scriptGetState(() => gate)` where `gate` is a promise released by the test; `h.emit({ type: "agent_end" })`; `await until(() => getStateCalled)`; `const k = sup.abortAll("killed")`; release `gate`; `await k; await sup.whenIdle()` → `outcome.failed[0]` is `killed`, `outcome.done` empty, `rows` `[]`.
  6. **merged run → no row for the merged id; the parent's row only:** `held()`; parent submitted; while RUNNING submit a second run (steered, `merged_into` parent — as `tests/omp/planner-supervisor.test.ts`'s steer-merge case); finish with `"r\n[[attach: ../x]]"` → rows `[["refuse","marker_outside","rule",parent,null]]`. ("Never `this.turn`" is a review rule here, not a test: `this.turn === t` for the whole of `finishSuccess`; it is cleared at `:549`, after `settle` returns.)
  7. **a lane reply never consults:** `extra.triage = async () => ({ kind: "lane_reply", text: "lane\n[[attach: ../x]]", buttons: [] })` → `attachCalls() === 0`, `rows` `[]`.
  8. **the row precedes `recordChatTurn`:** `vi.spyOn(store, "recordChatTurn").mockImplementation((i) => { if (i.role === "assistant") throw new Error("planted"); return …original… })` (capture `const orig = store.recordChatTurn.bind(store)` first) → the `marker_outside` row exists (catches M5).
  9. **`outcome.complete` throws → no row** (stated best-effort meaning): `extra.outcome` = the harness sink with `complete: () => { throw new Error("planted"); }` → `await sup.whenIdle()` resolves (the throw leaves `settle()` and `drain()`'s per-turn catch, `:490–498`, logs it and opens `planner_turn_crashed` — D10, expected); `rows` `[]`.
  10. **a registry mistake is caught (P20):** plant the non-rule ladder; `const err = vi.spyOn(console, "error")` → `rows` `[]`; `err` called with a string containing `"attach_path_record_failed"`; the assistant chat turn is stored; `outcome.routeEnds` has one `planner_done` entry; `outcome.incidents` does not contain `expect.objectContaining({ k: "planner_turn_crashed" })` (the literal at `planner-supervisor.ts:497`, `:556`; Rev 1.1) — with the stored chat turn and the `planner_done` routeEnd these catch M6.
  11. **a thrown rule (P20):** plant `decide` to throw; text with one inside and one `../` marker → rows `[["refuse", null, "fail", run, null], ["refuse", null, "fail", run, null]]`; `outcome.done[0].attachments` unchanged.
  12. **no recorder → nothing, no throw:** `harness(answering("x\n[[attach: ../x]]"))` without `recorder` → done as usual.
  Wiring (c), append to `tests/core/supervisor-decision-wiring.test.ts`:
  ```ts
  it("R7 (c): a production turn whose reply names an inside and an outside file writes one attach.path marker_outside row; ompComplete gets the inside file", async () => {
    useFakeOmp({ "*": { rpcText: "ok\n[[attach: in.txt]]\n[[attach: ../outside.txt]]" } }, tmp.dir);
    worker = ompWorker(store, tmp.dir);
    const ws = join(tmp.dir, "omp", "workspace", "chat-555"); mkdirSync(ws, { recursive: true }); writeFileSync(join(ws, "in.txt"), "i");
    const run = createQueuedTurnRun(store, "send it"); worker.submitTurn(run);
    await until(() => store.getRunState(run) === "completed");
    expect(store.listDecisionsForRun(run).filter((r) => r.entry_id === "attach.path").map((r) => [r.verdict, r.reason_code, r.run_id])).toEqual([["refuse", "marker_outside", run]]);
    const payload = drainOutbox(store).get(`${run}:final_report`) as { text: string; attachments?: string[] };
    expect(payload.attachments).toEqual([join(ws, "in.txt")]);
    expect(payload.text).not.toContain("[[attach:");
  });
  ```
  (imports: `mkdirSync`, `writeFileSync` from `node:fs`; `drainOutbox` from `../helpers/omp-worker.js`. If the omp data dir's workspace path differs, read `chatWorkspace` call in `CoreWorker` and use `chatWorkspace(tmp.dir, "555")`.) A second wiring case for the fake's new key:
  ```ts
  it("R7 (c'): a production turn whose reply carries a refused marker and is then aborted by omp takes the failure arm and writes no attach.path row", async () => {
    useFakeOmp({ "*": { rpcText: "ok\n[[attach: ../outside.txt]]", rpcAbortAfterText: true } }, tmp.dir);
    worker = ompWorker(store, tmp.dir);
    const run = createQueuedTurnRun(store, "send it"); worker.submitTurn(run);
    await until(() => store.getRunState(run) === "failed");
    expect(store.listDecisionsForRun(run).filter((r) => r.entry_id === "attach.path")).toEqual([]);
  });
  ```
  In each new test file drop any import the cases above do not use (`noUnusedLocals`).
- [ ] **Step 2: run** `npx vitest run tests/omp/attach-decisions.test.ts tests/core/supervisor-decision-wiring.test.ts` → FAIL.
- [ ] **Step 3: implement** in `planner-supervisor.ts`. Import `import { ATTACH_PATH } from "../decisions/entries/attach-path.js";`. After `record()`:
  ```ts
  /** record() in its own catch (spec R7 §4.4): decideSync throws on a non-rule rung before its recorder's catch, and a settle-stage consult must never skip recordChatTurn or routeEnd. */
  private recordSafe<S, V extends string>(entry: Entry<S, V>, s: S, run_id: string): void {
    try { this.record(entry, s, run_id); } catch (e) { console.error(`planner supervisor: ${entry.id.replace(".", "_")}_record_failed (${errorCode(e)})`); }
  }

  /** attach.path at parse (spec R7 §4.0, 5-A): one consult per distinct marker path on the consulting turn — accepted first, then refused; best-effort terminal records. */
  private recordAttach(t: Turn, d: Delivered): void {
    d.attachments.forEach(() => this.recordSafe(ATTACH_PATH, { seam: "parse", check: "accepted" }, t.req.run_id));
    d.refused.forEach(() => this.recordSafe(ATTACH_PATH, { seam: "parse", check: "marker_outside" }, t.req.run_id));
  }
  ```
  `finishSuccess`, between the merged loop (`:1631`) and `store.recordChatTurn` (`:1632`):
  ```ts
  this.recordAttach(t, delivered); // spec R7 §4.0: after outcome.complete, before recordChatTurn; kept when the run later fails to stage or loses its claim
  ```
  `tests/fixtures/fake-omp.mjs` `finish()`, replacing the last line `out({ type: "turn_end", … }); out({ type: "agent_end", messages: [msg] });`:
  ```js
  out({ type: "turn_end", message: msg }); out({ type: "agent_end", messages: [msg], ...(b.rpcAbortAfterText ? { aborted: true } : {}) });
  ```
  and add to the header comment: `rpcAbortAfterText (the reply's text arrives, then omp ends the turn aborted: a lost turn that carried text; R7)`.
- [ ] **Step 4: run** Step 2's files, `npx vitest run tests/omp tests/core`, `npm run typecheck`, `npm test` → PASS, 0 skipped (P19 flakes rerun alone). Show M5 and M6 failing once, reverted.
- [ ] **Step 5: commit** `feat(omp): supervisor records attach.path refusals at parse, after outcome.complete, before recordChatTurn`.

---

### Task 5: The dispatcher consults `attach.path` after `markDelivered`; production wiring

**Files:**
- Modify: `src/notifications/notification-dispatcher.ts`, `src/telegram/telegram-daemon.ts:176–178`, `src/telegram/telegram-poll-runner.ts:243–246`, `src/cli.ts:129–140`, `tests/notifications/notification-dispatcher.test.ts` (append)
- Create: `tests/telegram/attach-decision-wiring.test.ts`

**Interfaces:**
- Consumes: `ATTACH_PATH` (Task 3), `NotificationSendResult.attach_checks` (Task 1), `storeRecorder` (`src/decisions/record.ts`).
- Produces: `NotificationDispatcherOptions.recorder?: DecisionRecorder`; private `recordAttach(record: NotificationRecord, checks: readonly AttachCheck[] | undefined): void`.

- [ ] **Step 1: failing tests.** Append to `tests/notifications/notification-dispatcher.test.ts` a `describe("R7: attach.path send rows")` with a helper:
  ```ts
  import { ATTACH_PATH } from "../../src/decisions/entries/attach-path.js";
  import { storeRecorder } from "../../src/decisions/record.js";
  import type { AttachCheck } from "../../src/notifications/attachment-check.js";
  import type { DecisionRecorder } from "../../src/decisions/types.js";

  type Db = { prepare(s: string): { all(...a: unknown[]): Array<Record<string, unknown>> } };
  const db = (s: RunStore) => (s as unknown as { db: Db }).db;
  const attachRows = (s: RunStore) => db(s).prepare("SELECT verdict, reason_code, rung, run_id, tool_call_id FROM decisions WHERE entry_id = 'attach.path' ORDER BY rowid").all()
    .map((r) => [r.verdict, r.reason_code, r.rung, r.run_id, r.tool_call_id]);
  /** One telegram notification, an adapter returning `checks`, a shared log of send / markDelivered / record events. */
  function rig(checks: AttachCheck[] | undefined, o: { run_id?: string; recorder?: (s: RunStore, log: string[]) => DecisionRecorder; onDelivered?: () => void } = {}) {
    const store = RunStore.openInMemory(); const log: string[] = []; const outbox = new NotificationOutbox(store);
    const mark = store.markNotificationDelivered.bind(store);
    store.markNotificationDelivered = (id, p) => { log.push("markDelivered"); mark(id, p); };
    const rec = outbox.enqueue({ topic: "reply", target: { kind: "telegram", chat_id: "222" }, intent_type: "final_report", idempotency_key: "k", correlation_id: "k",
      ...(o.run_id === undefined ? { run_id: "run_1" } : o.run_id === "none" ? {} : { run_id: o.run_id }), payload: { text: "r", attachments: ["/w/a"] } });
    const base = o.recorder ? o.recorder(store, log) : { record: (e, r, c) => { log.push(`record:${r.verdict}:${r.reason}`); return storeRecorder(store).record(e, r, c); } } as DecisionRecorder;
    const dispatcher = new NotificationDispatcher(outbox, { local: { send: async () => ({ provider_message_id: "l" }) },
      telegram: { send: async () => { log.push("send"); return checks ? { provider_message_id: "t:1", attach_checks: checks } : { provider_message_id: "t:1" }; } } },
      { recorder: base, ...(o.onDelivered ? { onDelivered: o.onDelivered } : {}) });
    return { store, log, outbox, rec, dispatcher };
  }
  ```
  Cases:
  1. **rows after `markDelivered`, the claimed run's id, refusals only:** `rig(["ok", "too_large", "over_count"])` → `dispatchOnce` delivered; `log` equals `["send", "markDelivered", "record:send:checked", "record:refuse:too_large", "record:refuse:over_count"]`; `attachRows` `[["refuse","too_large","rule","run_1",null],["refuse","over_count","rule","run_1",null]]` (M1 fails this). `record:send:checked` is in the log because the wrapper logs every recorder **call**; `shouldRecord` then declines the row — do not make the adapter skip accepted checks.
  2. **run-less row → `run_id` null:** `rig(["not_found"], { run_id: "none" })` → `[["refuse","not_found","rule",null,null]]`.
  3. **no checks / no recorder → nothing:** `rig(undefined)` → no `record:` in `log`; a dispatcher built without `recorder` and checks `["too_large"]` → `attachRows` `[]`, state `delivered`.
  4. **a failed send records nothing:** adapter throws → `markFailed` (`retry_wait`), `attachRows` `[]`.
  5. **lease (P10):** recorder whose `record` (first call only) runs `log.push(String(store.recoverStaleSendingNotifications(new Date(Date.now() + 31_000).toISOString()).length))` and `log.push(String(new NotificationOutbox(store).claimNext("second", 30) === null))`, then forwards → `log` contains `"0"` and `"true"` in that order; `outbox.get(rec.notification_id)!.state === "delivered"`; one `send` in `log` (M1 fails this).
  6. **a recorder that throws past itself:** `record: () => { throw new Error("planted"); }` → result `{ status: "delivered" }`; state `delivered`; `console.error` called with a string containing `"attach_path_record_failed"`.
  7. **`afterDelivered` and `recordAttach` cannot skip each other:** `onDelivered` throws → rows still written; recorder throws → `onDelivered` still called (spy).
  8. **a planted non-rule rung (P20)** → no row, logged, delivered.
  9. **insert fault → `decision_record_failed` as a log, never chat:** `vi.spyOn(store, "insertDecision").mockImplementation(() => { throw new Error("disk"); })`, `process.env.HOUGE_TELEGRAM_CHAT_ID = ""` for the case; `rig(["linked"])` → `db(store).prepare("SELECT kind, subject, detail_json FROM incidents").all()` maps (with `JSON.parse(detail_json)`) to `[["decision_record_failed", "attach.path", { entry: "attach.path" }]]`; exactly one `ledger_events` row with `event_type = 'incident_opened'`; `db(store).prepare("SELECT topic FROM change_log").all()` equals `[{ topic: "incident_log" }]`; `notification_outbox` row count still 1; state `delivered`.
  `tests/telegram/attach-decision-wiring.test.ts` (setup as `tests/telegram/sender-decision-wiring.test.ts:1–20`: `pinOmpEnv`, the `PINNED` env list, `useFakeOmp`):
  ```ts
  /** A verified workspace for chat 555 under `root` and a seeded final_report naming a 21 MiB sparse file there (spec R7 §4.4 wiring). */
  function seed(store: RunStore, root: string): { run: string; ws: string } {
    const ws = chatWorkspace(root, "555"); mkdirSync(ws, { recursive: true });
    const big = join(ws, "big.bin"); writeFileSync(big, ""); truncateSync(big, 21 * 1024 * 1024);
    const run = createQueuedTurnRun(store, "wired");
    store.enqueueFinalReportNotification(run, { text: "report", report_path: "r.md", attachments: [big] });
    return { run, ws };
  }
  const attach = (store: RunStore) => store.listDecisionsBetween("1970-01-01T00:00:00.000Z", "2999-01-01T00:00:00.000Z").filter((r) => r.entry_id === "attach.path").map((r) => [r.verdict, r.reason_code, r.run_id]);
  ```
  (a) `runTelegramPollOnce({ store, projectRoot: root, omp: { dataDir: root, distDir: tmpOmpDist(root) }, allowlist: ALLOW, telegramClient: { getUpdates: async () => [], sendMessage: async () => ({ message_id: 1 }), sendDocument: async () => { throw new Error("must not upload"); } } })` → `attach(store)` `[["refuse","too_large",run]]`; the outbox row `delivered`. (b) `createOutboxDispatcher(store, { local: new LocalNotificationAdapter(() => undefined), telegram: workspaceTelegramAdapter(client, root) }).dispatchOnce("t")` → the same row. (d) source pins:
  ```ts
  it("(d) each production dispatcher construction passes the store recorder; the eval runner's does not", () => {
    const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
    expect(src("telegram/telegram-daemon.ts")).toMatch(/new NotificationDispatcher\(new NotificationOutbox\(store\), adapters, \{[^}]*recorder: storeRecorder\(store\)/);
    expect(src("telegram/telegram-poll-runner.ts")).toMatch(/new NotificationDispatcher\(new NotificationOutbox\(options\.store\), \{[\s\S]*?\}, \{ recorder: storeRecorder\(options\.store\) \}\)/);
    expect(src("cli.ts")).toMatch(/new NotificationDispatcher\(new NotificationOutbox\(store\), \{[\s\S]*?\}, \{ recorder: storeRecorder\(store\) \}\)/);
    expect(src("eval/eval-runner.ts")).not.toMatch(/recorder/);
    // no production construction sets the protected leaf's test seam (spec R7 §4.2); the adapter itself forwards the option, so it is not checked here
    for (const p of ["telegram/telegram-poll-runner.ts", "telegram/telegram-daemon.ts", "cli.ts"]) expect(src(p), p).not.toMatch(/beforeRecheckForTest/);
  });
  ```
  The `cli.ts` construction nests braces (`new TelegramClient({ token: … })`), so a lazy `\{[\s\S]*?\}` stops too early: anchor on the closing text you write, e.g. `/process\.cwd\(\)\)\n\s*\}, \{ recorder: storeRecorder\(store\) \}\);/`. Check each regex against the exact Step 3 text; each must fail when its `recorder` is removed (M8). `runTelegramPollOnce` executes only runs it intakes this cycle (`telegram-poll-runner.ts:222–223`), so the `createQueuedTurnRun` seed in (a) is never executed.
- [ ] **Step 2: run** `npx vitest run tests/notifications/notification-dispatcher.test.ts tests/telegram/attach-decision-wiring.test.ts tests/telegram/telegram-daemon-standing.test.ts` → FAIL.
- [ ] **Step 3: implement.** `notification-dispatcher.ts`:
  ```ts
  import { decideSync } from "../decisions/decide.js";
  import { ATTACH_PATH } from "../decisions/entries/attach-path.js";
  import type { DecisionRecorder } from "../decisions/types.js";
  import type { AttachCheck } from "./attachment-check.js";
  // options:
    /** attach.path at send (spec R7 §4.0): consulted per attachment check after markDelivered committed; absent → no rows. */
    recorder?: DecisionRecorder;
  // field + constructor: private readonly recorder: DecisionRecorder | undefined;  this.recorder = options.recorder;
  // dispatchOnce, after this.afterDelivered(claimed):
      this.recordAttach(claimed, sent.attach_checks);
  // method:
  /** Spec R7 §4.0: after the delivery committed, outside the lease, with the outbox row's run_id; its own catch, so it can neither reach markFailed nor skip afterDelivered. */
  private recordAttach(record: NotificationRecord, checks: readonly AttachCheck[] | undefined): void {
    const recorder = this.recorder;
    if (!recorder || !checks || checks.length === 0) return;
    try {
      for (const check of checks) decideSync(ATTACH_PATH, { seam: "send", check }, { run_id: record.run_id, tool_call_id: null, recorder });
    } catch (error) {
      console.error(`[notification-dispatcher] attach_path_record_failed for ${record.notification_id}: ${errorCode(error)}`);
    }
  }
  ```
  `telegram-daemon.ts:177`: `return new NotificationDispatcher(new NotificationOutbox(store), adapters, { onDelivered: (record) => settleDeliveredReport(store, record), recorder: storeRecorder(store) }); // attach.path at send (R7 §4.4)` (`storeRecorder` already imported, `:39`). `telegram-poll-runner.ts:243`: close the adapters object, then `, { recorder: storeRecorder(options.store) });` (`storeRecorder` already imported, `:10`). `cli.ts`: add `const { storeRecorder } = await import("./decisions/record.js");` beside `:130–133`, and `}, { recorder: storeRecorder(store) });` at the dispatcher's close (`:140`).
- [ ] **Step 4: run** Step 2's files, `npx vitest run tests/notifications tests/telegram tests/eval tests/cli*`, `npm run typecheck`, `npm test` → PASS, 0 skipped. Show M1 and M8 failing once, reverted.
- [ ] **Step 5: commit** `feat(notifications): the dispatcher records attach.path send refusals after markDelivered; three production senders wired`.

---

### Task 6: Harness — the `r7` pair, the delivery fixture, supervisor fixture additions

**Files:** Modify `scripts/stage4-diff-lib.mjs` (`DISTS` `:7`, `EXPORTS` `:18–46`, `R7_IDS`, `NEW_ROW_IDS` `:168–178`), `scripts/check-ladder-stage4-differential.mjs` (header `:16–19`, args `:36`, parse `:53–54`, required files `:62`, provenance `:69–89`, `DISTS` `:192`, ctx `:195`), `scripts/stage4-supervisor-fixture.mjs` (`fakeSession` `:37–63`; new `seedWorkspace`). Create `scripts/stage4-delivery-fixture.mjs`.

**Interfaces:**
- Produces: `R7_IDS = ["attach.path"]`; `DISTS.r7`; `EXPORTS` gain `NotificationOutbox: "notifications/notification-outbox.js"`, `NotificationDispatcher: "notifications/notification-dispatcher.js"`, `TelegramNotificationAdapter: "notifications/telegram-notification-adapter.js"`, `attachmentRefusedLine: "notifications/telegram-notification-adapter.js"`, `workspaceTelegramAdapter: "telegram/telegram-poll-runner.js"`, `chatWorkspace: "omp/workspace.js"`, `ATTACH_PATH: "decisions/entries/attach-path.js"` (null on the old dist). Supervisor fixture: `fakeSession` honours `script.final` (the default answer text) and `script.getState` (an async replacement); `seedWorkspace(d, data, files): string` (the workspace). Delivery fixture: `mkData(d) → { data, ws }`, `makeFiles(data, ws, files) → string[]`, `deliver(d, store, spec) → { log, calls, results, outbox, run, paths }`, `removeDeliveryDirs()`.

- [ ] **Step 1: old build (P1).** `MB=$(git merge-base HEAD main)`; `git worktree add .worktrees/base-${MB:0:12} $MB`; there `npm ci && npm run build && node scripts/stamp-dist.mjs <that worktree>`.
- [ ] **Step 2: lib/CLI.** `DISTS` gains `r7: null`. After `R6_IDS`: `/** The Slice R7 row: attach.path (parse refusals in finishSuccess; send refusals by the dispatcher after markDelivered). */ export const R7_IDS = ["attach.path"];`. Every `NEW_ROW_IDS` set gains `...R7_IDS`; add `r7: new Set(R7_IDS)`; update the doc comment ("R2_IDS … R6_IDS and R7_IDS are in every set"). CLI: `oldR7: null, oldBaseR7: null` in `parseArgs`; `--old-dist-r7` / `--old-base-r7`; required file `["--old-dist-r7", a.oldR7, "notifications/telegram-notification-adapter.js"]`; `p12 = verifyStampedDist(a.oldR7, NEW_DIST, mergeBaseOf(NEW_DIST, a.oldBaseR7 ?? undefined), "notifications/telegram-notification-adapter.js")` and its `r7  old build pinned …` print; `DISTS` and ctx gain `r7`; header lines for the two flags and `--old-base-r7 <sha>` appended to the full post-merge command (filled in at merge).
- [ ] **Step 3: supervisor fixture.** In `fakeSession`: the default `onPrompt` answer becomes `assistant(script.final ?? "answer")`; `getState: async () => (script.getState ? script.getState() : { todoPhases: [], queuedMessageCount: 0, queuedMessages: { steering: [], followUp: [] } })`. Export:
  ```js
  /** R7: files in chat 42's workspace before the turn. files: Array<[rel, "file" | "dir" | "symlink", target?]>; a symlink's target is absolute. Returns the workspace path. */
  export function seedWorkspace(d, data, files) {
    const ws = d.chatWorkspace(data, "42"); mkdirSync(ws, { recursive: true });
    for (const [rel, kind, target] of files) {
      const p = join(ws, rel);
      if (kind === "dir") mkdirSync(p, { recursive: true }); else if (kind === "symlink") symlinkSync(target, p); else writeFileSync(p, `content of ${rel}`);
    }
    return ws;
  }
  ```
  (Every existing caller's behaviour is unchanged: `script.final`/`script.getState` absent → today's bytes.)
- [ ] **Step 4: delivery fixture** `scripts/stage4-delivery-fixture.mjs`:
  ```js
  // The Slice R7 delivery fixture (spec R7 §6). Not a corpus. Drives a dist's real NotificationOutbox + NotificationDispatcher + Telegram adapter over a fresh store,
  // a fake TelegramSendClient and a temp data dir in the verified layout (<data>/omp/workspace/chat-555). ONE shared event log records, in order, every client call
  // (sendMessage: text sha + parse_mode; sendDocument: name, byte length, sha), every recorder call (entry, verdict, reason) and markDelivered. Nothing reads the live DB.
  import { createHash } from "node:crypto";
  import { execFileSync } from "node:child_process";
  import { chmodSync, linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
  import { tmpdir } from "node:os";
  import { join } from "node:path";
  import { intakeRun } from "./stage4-supervisor-fixture.mjs";

  const sha = (b) => createHash("sha256").update(b).digest("hex").slice(0, 16);
  export const CHAT = "555";
  const dataDirs = new Set();
  export function removeDeliveryDirs() { for (const d of [...dataDirs]) { try { chmodSync(d, 0o700); rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } dataDirs.delete(d); } }

  /** A data dir whose chat-555 workspace is a real directory chain (verifiedWorkspace passes). */
  export function mkData(d) {
    const data = mkdtempSync(join(tmpdir(), "hdl-")); dataDirs.add(data);
    const ws = d.chatWorkspace(data, CHAT); mkdirSync(ws, { recursive: true });
    return { data, ws };
  }

  /** files: Array<[name, kind, arg?]> — kind file | sparse (bytes) | dir | fifo | hardlink (outside target) | symlink_out | missing | mode000. Returns absolute paths in order. */
  export function makeFiles(data, ws, files) {
    return files.map(([name, kind, arg]) => {
      const p = join(ws, name);
      if (kind === "file") writeFileSync(p, `bytes of ${name}`);
      else if (kind === "sparse") { writeFileSync(p, ""); truncateSync(p, arg); }
      else if (kind === "dir") mkdirSync(p);
      else if (kind === "fifo") execFileSync("mkfifo", [p]);
      else if (kind === "hardlink") { const out = join(data, `${name}.out`); writeFileSync(out, "outside"); linkSync(out, p); }
      else if (kind === "symlink_out") { const out = join(data, `${name}.out`); writeFileSync(out, "outside"); symlinkSync(out, p); }
      else if (kind === "mode000") { writeFileSync(p, "locked"); chmodSync(p, 0o000); }
      else if (kind !== "missing") throw new Error(`makeFiles: unknown kind ${kind}`);
      return p;
    });
  }

  /** The fake Telegram client: logs every call; `opts.noDocument` omits sendDocument; `opts.documentThrows`; `opts.textFails` (attempt numbers whose text fails both tries). */
  function client(log, opts, attempt) {
    const c = {
      sendMessage: async (m) => { if (opts.textFails?.includes(attempt.n)) { log.push(["sendMessage_failed", m.parse_mode ?? "plain"]); throw new Error("HTTP 502"); }
        log.push(["sendMessage", sha(m.text), m.parse_mode ?? "plain", m.text.startsWith("⚠") ? m.text : null]); return { message_id: log.length }; }
    };
    if (!opts.noDocument) c.sendDocument = async (doc) => { log.push(["sendDocument", doc.filename, doc.content.length, sha(Buffer.from(doc.content))]); if (opts.documentThrows) throw new Error("HTTP 400"); };
    return c;
  }

  /**
   * One delivery. spec: { files, intent ("final_report" | "progress_runless"), recorder (the new side's store recorder or null), swap (rel name → renamed and replaced
   * between open and re-check), wsSwap (the workspace replaced by a symlink before dispatch), opts (client options), attempts (dispatchOnce calls, default 1),
   * insideRecorder (fn(store) run inside the first recorder call, P10) }. Both sides run the same spec; the old dispatcher ignores `recorder`.
   */
  export async function deliver(d, store, spec) {
    const { data, ws } = mkData(d); const log = []; const attempt = { n: 0 }; const calls = [];
    const paths = makeFiles(data, ws, spec.files);
    const mark = store.markNotificationDelivered.bind(store);
    store.markNotificationDelivered = (id, p) => { log.push(["markDelivered"]); return mark(id, p); };
    const record = spec.recorder ? { record: (e, r, c) => { if (calls.length === 0 && spec.insideRecorder) log.push(["inside", ...spec.insideRecorder(store)]);
      calls.push([e.id, r.verdict, r.reason]); log.push(["record", e.id, r.verdict, r.reason]); return spec.recorder.record(e, r, c); } } : null;
    const run = spec.intent === "progress_runless" ? null : intakeRun(d, store, "deliver", `deliver:${paths.length}`);
    const outbox = new d.NotificationOutbox(store);
    if (run) store.enqueueFinalReportNotification(run, { text: "here you go", report_path: "r.md", attachments: paths });
    else outbox.enqueue({ topic: "reply", target: { kind: "telegram", chat_id: CHAT }, intent_type: "progress", idempotency_key: "p:1", correlation_id: "p:1", payload: { text: "here you go", attachments: paths } });
    if (spec.wsSwap) { renameSync(ws, `${ws}.real`); symlinkSync(`${ws}.real`, ws); }
    const tg = client(log, spec.opts ?? {}, attempt);
    const hook = spec.swap ? (p) => { if (p.endsWith(spec.swap)) { renameSync(p, `${p}.moved`); writeFileSync(p, "swapped in"); } } : undefined;
    const adapter = hook ? new d.TelegramNotificationAdapter(tg, { workspaceFor: (c) => d.chatWorkspace(data, c), beforeRecheckForTest: hook }) : d.workspaceTelegramAdapter(tg, data);
    const dispatcher = new d.NotificationDispatcher(outbox, { local: { send: async () => ({ provider_message_id: "local" }) }, telegram: adapter },
      record ? { recorder: record } : {});
    const results = [];
    for (let i = 0; i < (spec.attempts ?? 1); i += 1) { attempt.n = i + 1; results.push((await dispatcher.dispatchOnce("fixture")).status); if (spec.attempts) { db.prepare("UPDATE notification_outbox SET next_attempt_at = ? WHERE state = 'retry_wait'").run(new Date(Date.now() - 60_000).toISOString()); store.requeueRetryWaitNotifications(new Date().toISOString()); } } // Rev 1.2: a future requeue time leaves the row unclaimable (run-store.ts:7888, :7700)
    const rows = store.db.prepare("SELECT state, attempt_count, provider_message_id FROM notification_outbox ORDER BY rowid").all();
    return { log, calls, results, outbox: rows, run, paths };
  }
  ```
  (Read `requeueRetryWaitNotifications` in `run-store.ts` before relying on it for the retry item; if its signature differs, requeue with the store method the daemon's sweep uses at `:7834`. `mkData` adds dirs under `os.tmpdir()`: this is a script, not the daemon, so `HOUGE_DAEMON_TMP_DIR` does not apply.)
- [ ] **Step 5: verify** — `npm run build`; the full differential with every pair's flags plus `--old-dist-r7 /Users/xiaochuan/Projects/adventure/.worktrees/base-<sha>/dist` → every existing corpus PASS, 0 differences (`supervisor`/`supervision`/`context`/`model` items carry no marker: their `attach.path` tally is 0 by P6; a non-zero tally is a finding); `same_build` mutation (point `--old-dist-r7` at the new dist) → exit 2.
- [ ] **Step 6: commit** `test(gate): differential gains the r7 pair and a delivery fixture; the supervisor fixture takes a final text and workspace files`.

---

### Task 7: Corpus `attach`

**Files:** Create `scripts/stage4-corpora/attach.mjs`. Pattern: `scripts/stage4-corpora/model.mjs` (read whole: `project`, `required`, `load` determinism self-test, `planted`, coverage self-tests).

**Interfaces:**
- Consumes: `deliver`, `mkData`, `makeFiles`, `removeDeliveryDirs` (Task 6); `seedWorkspace`, `mkSupervisor`, `intakeRun`, `req`, `fakeSession`, `until`, `cleanup` (supervisor fixture); `countingRecorder`; `R7_IDS`, `DISTS`, `dumpDb`, `relabelClocks`, `requireNew`, `canon`, `mkStore`, `mkTemp`; `scrubIds`; `withPinnedEnv`, `withCountingClock`, `NOW`.

- [ ] **Step 1: corpus skeleton.** `const corpus = { name: "attach", pairs: [["r7", "new"]], min: { items: ITEMS.length, branches: BRANCHES }, load, project, required }`. Each item: `{ key, seam: "parse" | "send", drive|spec, rows, calls, facts }`. `project(d, item)`: fresh temp store (`mkStore(d, "bare", …)`) under `withPinnedEnv(join(dir, "pin"), () => withCountingClock(NOW, …))`; new side gets `countingRecorder(d.storeRecorder(store))`, old side `d.storeRecorder(store)` for parse items (the old supervisor records R1–R6 rows) and the same `d.storeRecorder(store)` for send items (the old dispatcher ignores the option, so it records nothing; both sides run the same code path). Define `const R = (verdict, reason, rung = "rule", run = "a") => ["attach.path", rung, verdict, reason, run, null];` (the tables below use it). Projection: parse items → the session `log`, the sink's `done`/`failed`/`incidents` (worker ids scrubbed, `run_id` labelled), `dumpDb(store, { dropDecisionIds: [...NEW_ROW_IDS.r7] })` → `relabelClocks` → `scrubIds`; send items → `log` minus `["record", …]` and `["inside", …]` entries, `outbox` rows, `results`, the dump minus `R7_IDS` rows. `__strip: ["newRows", "calls", "order", "facts"]`. `newRows` = `SELECT entry_id, rung, verdict, reason_code, run_id, tool_call_id FROM decisions WHERE entry_id = 'attach.path' ORDER BY rowid` (run labelled `a`/`b`/`null`); the old build must hold none (control). Fault items (P20) plant on `d.ATTACH_PATH` (new side only; on the old side `d.ATTACH_PATH` is null and the item runs unplanted). Remove delivery dirs in a `finally` (`removeDeliveryDirs`).
- [ ] **Step 2: items — parse (supervisor fixture; `mkSupervisor(d, store, { recorder, session: fakeSession({ final }) })`, `seedWorkspace` before `sup.submit`).** Spec §6 verbatim, with exact `rows` `[entry, rung, verdict, reason, run, tool_call]` and `calls` `{ "attach.path": n }` (P6):

  | key | final / drive | rows | attach.path calls |
  |---|---|---|---|
  | `inside_one` | `"ok\n[[attach: in.txt]]"`, `in.txt` file | `[]`; done attachments = [ws/in.txt] | 1 |
  | `dotdot` | `"ok\n[[attach: ../x]]"` | `[R("refuse","marker_outside")]`; text `"ok"` | 1 |
  | `absolute_out` | `"ok\n[[attach: /etc/hosts]]"` | one `marker_outside` | 1 |
  | `symlink_out` | `out.lnk → /etc/hosts`, `"ok\n[[attach: out.lnk]]"` | one `marker_outside` | 1 |
  | `not_yet` | `"ok\n[[attach: later.txt]]"` (no file) | `[]`; attachments = [ws/later.txt] | 1 |
  | `two_passes_same` | send-back flow (`sup.activeTurnForTest().onSendBack("rule", "")`), both passes `[[attach: ../x]]` | one `marker_outside` | 1 |
  | `one_each` | `"ok\n[[attach: in.txt]]\n[[attach: ../x]]"` | one `marker_outside`; attachments = [ws/in.txt] | 2 |
  | `failed_turn` | a session whose prompt emits the text then `sup.abortAll("killed")` | `[]`; failed `killed` | 0 |
  | `kill_in_snapshot` | send-back flow, `script.getState` held, `abortAll("killed")` while held | `[]`; failed `killed` | 0 |
  | `merged` | held turn, a second run steered in, final `"r\n[[attach: ../x]]"` | one row with run `a` (the parent), none for `b` | 1 |
  | `lane_reply` | `extra.triage` → `{ kind: "lane_reply", text: "lane\n[[attach: ../x]]", buttons: [] }` | `[]` | 0 |
  | `chat_turn_throws` | `store.recordChatTurn` wrapped to throw for the assistant role | one `marker_outside` | 1 |
  | `registry_mistake` | P20 non-rule ladder on the new dist's `ATTACH_PATH` | `[]`; no `planner_turn_crashed` incident; chat turn stored; one `planner_done` routeEnd | 0 recorded (calls throw before the recorder) |

- [ ] **Step 3: items — send (delivery fixture).** Spec §6 verbatim:

  | key | files / spec | rows (all with run `a` unless noted) | calls |
  |---|---|---|---|
  | `one_regular` | `[["a.txt","file"]]` | `[]`; one `sendDocument` | 1 |
  | `six_files` | six `file` | one `over_count`; five uploads | 6 |
  | `nine_files` | nine `file` | one `over_count`; five uploads; four over_count lines | 6 |
  | `too_large` | `[["big.bin","sparse",21*1024*1024]]` | `too_large` | 1 |
  | `directory` | `dir` | `not_a_file` | 1 |
  | `fifo` | `fifo` | `not_a_file` (item bounded 2 s) | 1 |
  | `hard_link` | `hardlink` | `linked` | 1 |
  | `symlink_out` | `symlink_out` | `outside_workspace` | 1 |
  | `ws_swapped` | two `file`, `wsSwap: true` | `workspace_unverified` ×2; line text `outside my workspace` ×2 | 2 |
  | `missing` | `missing` | `not_found`; line `could not be read` | 1 |
  | `mode000` | `mode000` | `unreadable`; line `could not be read` | 1 |
  | `swapped` | `file`, `swap: "a.txt"` | `changed` | 1 |
  | `no_send_document` | `file`, `opts.noDocument` | `unsupported` | 1 |
  | `document_throws` | `file`, `opts.documentThrows` | `[]`; line "Telegram refused the upload" | 1 |
  | `text_fails_then_ok` | `file` + `missing`, `opts.textFails: [1]`, `attempts: 2` | `not_found` only after attempt 2's `markDelivered` (assert the log order) | 2 (attempt 2 only) |
  | `runless_progress` | `missing`, `intent: "progress_runless"` | `not_found` with run `null` | 1 |
  | `parse_ok_send_swapped` | a parse item (supervisor) accepting `r.txt`, then `r.txt` replaced by a symlink out and the accepted list delivered (P22: enqueued by hand, adapter `workspaceFor` → the supervisor's chat-42 workspace) | no parse row; send `outside_workspace` | parse 1, send 1 |

- [ ] **Step 4: items — timing, lease, faults.**
  - `write_timing`: three files, the middle `missing` → required from the log: the index of the first `["record", …]` is greater than the index of the last `["sendDocument", …]`, of the follow-up `["sendMessage", …, "⚠ …"]`, and of `["markDelivered"]`. M1 and M2 each fail it once (show the output).
  - `lease` (P10): `insideRecorder: (store) => [store.recoverStaleSendingNotifications(new Date(Date.now() + 31_000).toISOString()).length, new d.NotificationOutbox(store).claimNext("second", 30) === null]` → required `["inside", 0, true]`; outbox `delivered`; one text, one upload. M1 fails it.
  - `rule_throws_parse` / `rule_throws_send`: planted `decide` throw → required one `refuse` row at rung `fail` per consult (parse: `one_each` drive → 2 rows; send: `too_large` + `file` → 2 rows); files, lines and outbox identical to the old side.
  - `insert_fault_send`: `store.insertDecision` throws on the new side for `attach.path` only → three rows differ, each required by exact shape and each excluded (and only these) from this item's dump comparison by an `exclude` list naming table and id: the `incidents` row (`kind decision_record_failed`, `subject attach.path`, `detail_json` parsing to `{"entry":"attach.path"}`), the `ledger_events` row (`event_type incident_opened`, payload `{ incident_id: <that row's id>, kind: "decision_record_failed", subject: "attach.path" }`, written by `openIncident`, `run-store.ts:6142–6178`) and the `change_log` row (`topic incident_log`); outbox `delivered` (Rev 1.1, Fable B2).
  - `recorder_throws`: the new side's recorder throws past itself → no row, everything else identical.
  - Planted rule mutation for the corpus (M7): `too_large`/`linked` swapped in the new dist's rule → `too_large` and `hard_link` fail `required` once.
- [ ] **Step 5: self-tests** — coverage (every reason in `SEND_REASONS` and `marker_outside` is produced by at least one item; `BRANCHES` lists them), determinism (`nine_files` twice on the new build projects identically), the old build holds no `attach.path` row.
- [ ] **Step 6: run** `node scripts/check-ladder-stage4-differential.mjs <all pair flags> --only attach`, then the full differential → every corpus PASS (18 corpora), 0 differences.
- [ ] **Step 7: commit** `test(gate): attach corpus over the dist supervisor and the dist outbox dispatcher`.

---

### Task 8: Live gate `scripts/live-gate-ladder-remainder-r7.mjs`

Pattern: `scripts/live-gate-ladder-remainder-r6.mjs` (read whole). From a worktree, after `npm run build` there: `HOUGE_ENV_FILE=<main checkout>/.env node scripts/live-gate-ladder-remainder-r7.mjs`. Refuses to run outside `.worktrees/`; two `VACUUM INTO` copies of the live DB (A for lines 1, 3 and 7; B, cut from the untouched live DB, for lines 2, 4, 5, 6), each with its temp data dir, deleted on every exit path (pass, FAIL, throw, SIGINT/SIGTERM/SIGHUP/SIGQUIT, uncaught); `HOUGE_TOMBSTONE_PATH`/`HOUGE_DISARM_PATH` under the temp root; `HOUGE_TELEGRAM_CHAT_ID` = a stub; no real omp child (`fake-omp.mjs`), no real Telegram (a fake client), no subscription call. Prints line names, counts, verdicts and closed-set codes only. Before seeding, park every non-final outbox row on each copy (`queued`/`retry_wait`/`sending` → `failed_terminal`, as the R6 rollback's "non-final outbox rows parked" prep) so `dispatchOnce` can only claim the seeded row, and assert after each line that the seeded row is the one delivered; pin the env list of `tests/telegram/sender-decision-wiring.test.ts:11` (scheduler, radar, media flags deleted) so nothing else runs on the copy. Every line compares uploads and line text against a **recorder-less** run of the same seed (a dispatcher built without `recorder` on a second throwaway copy), not just that a row appeared.

- [ ] **Step 1: lines** (exact PASS values):
  1. **Send, production dispatcher (copy A).** `createOutboxDispatcher(A, { local: new LocalNotificationAdapter(() => undefined), telegram: workspaceTelegramAdapter(fake, dataA) })`; a seeded completed run (`createQueuedTurnRun`-equivalent through `Gateway.intake` on chat 555) whose `final_report` carries six paths `[small.txt (1 KiB), big.bin (21 MiB sparse), notes.txt (hard link), leak.txt (symlink out), f5.txt, f6.txt]` → exactly two `sendDocument` (`small.txt` and `f5.txt`); one follow-up text byte-equal to the recorder-less run's (`"⚠ Not attached: big.bin (over 20 MB)\n⚠ Not attached: notes.txt (a hard-linked file)\n⚠ Not attached: leak.txt (outside my workspace)\n⚠ Not attached: f6.txt (more than 5 files)"`); rows `[refuse/too_large, refuse/linked, refuse/outside_workspace, refuse/over_count]` with the run's id; zero rows for the uploads. **Ordering (Rev 1.1, codex W):** the store recorder is wrapped so each `record` call first reads the seeded row's state (`store.getNotification(id).state`); required: every read is `delivered` (timestamps cannot prove order: both can share a millisecond). Mutation M1 (record before `markDelivered`) must fail this line once.
  2. **Wiring (copy B).** The same seed through `runTelegramPollOnce` (`getUpdates: [] `) → its rows' `run_id` equals the outbox row's `run_id`.
  3. **Parse, production path (copy A).** `CoreWorker` (as `tests/helpers/omp-worker.ts` builds it, `dataDir` = `dataA`) over `fake-omp.mjs` with `rpcText: "ok\n[[attach: in.txt]]\n[[attach: ../outside.txt]]"`, `in.txt` in the workspace → the outbox payload's `attachments` = [the inside file]; one `refuse/marker_outside` row with the run's id; the stored assistant chat turn has no `[[attach:`.
  4. **Lost turn and lost run (copy B).** The same text on a turn omp aborts after the text (`rpcAbortAfterText`, P12) → run `failed`, no `attach.path` row. The same text with `<project>/runs` a regular file (P14) → run `failed` `report_write_failed`, the `marker_outside` row present, the run's one `final_report` outbox row is the failure notice with **no `attachments`** in its payload, and no `sendDocument` when it is dispatched (W1, shown; Rev 1.1).
  5. **Faults (copy B).** `insertDecision` faulted at send → exactly one `decision_record_failed` incident (subject `attach.path`), exactly one `change_log` row with topic `incident_log`, **no** outbox row to the stub chat, uploads byte-equal to the recorder-less run, the outbox row `delivered` (plus the one `incident_opened` ledger event the incident writes); a recorder that throws past itself → no incident, delivered.
  6. **Registry.** `ENTRY_IDS.length === 40`; `attach.path` locked with `ladder.map(r => r.kind)` = `["rule"]`; `insertLadderMove` (as the R6 gate calls it) refuses it with `locked_entry`; `entryProblems` empty.
  7. **`/status` (copy A, after lines 1 and 3 only).** The `attach.path` count line from the real `/status` renderer equals `· attach.path 5 — code 5 (parse 1 · send 4 · failed 0)`.
- [ ] **Step 2: mutations** — show lines 1, 3 and 5 failing once each under a planted mutation (M1; parse consult removed; `recordAttach` without its try), reverted.
- [ ] **Step 3: reruns** — R6, R5, R4, R3, R2, R1, 4C and 4B gates (`scripts/live-gate-ladder-{remainder-r6,remainder-r5,…,stage4c,stage4b}.mjs`) exit 0; `live-gate-jev-tree` cases 3 and 7 compared against `main` (logged follow-up from R6). Re-pin a live-data count only in a `fix(gate):` commit, with the measured value.
- [ ] **Step 4: commit** `test(gate): remainder R7 live gate — attach.path at parse and send on copies of the live DB, faults, /status`.

---

### Task 9: Rollback check `scripts/check-ladder-remainder-r7-rollback.mjs`

Pattern: `scripts/check-ladder-remainder-r6-rollback.mjs` (read whole; same header shape, pins, exit codes, provenance via `verifyStampedDist` with file `notifications/telegram-notification-adapter.js`, `--old-dist <base-<sha>/dist>`, `--old-base-r7` post-merge only).

- [ ] **Step 1: script.** Two `VACUUM` copies: A (never seeded) and F (cut from A, then seeded by **this** build through the real paths, dated inside the `/status` 24 h window): parse `refuse/marker_outside` with a run id (the dist supervisor fixture, `script.final` with a `../` marker); send `refuse/too_large`, `workspace_unverified`, `not_found`, `over_count` with a run id (the delivery fixture over this dist); one send `refuse/not_found` with `run_id` null (`progress_runless`); one `refuse` at rung `fail` (planted throw). The old build opens A and F, no migration:
  - `/status`: every line byte-identical A vs F except the `attach.path` line — the old build prints it because `status-view.ts:29` renders `countLines(rows)` over the 24 h window with no registry filter (as R6's rollback relies on, `check-ladder-remainder-r6-rollback.mjs:102–123`) — which the old build renders **without** the seam suffix — assert it equals `· attach.path <n> — code <n-1> · fallback 1` exactly (n from SQL).
  - digest output identical A vs F.
  - every `attach.path` row read back unchanged (`rung`, `entry_version`, `verdict`, `reason_code`, `run_id`).
  - its `review_ok` writer refuses `attach.path` normally (as R6 asserts per id).
  - its own dispatcher (old dist `NotificationDispatcher` + `workspaceTelegramAdapter`, fake client) delivers a `final_report` with two attachments (one regular, one 21 MiB sparse) on F: one upload, the follow-up line byte-equal to this build's, zero new `attach.path` rows.
  - this build then reopens F; its `/status` line carries the suffix with the seeded counts.
- [ ] **Step 2: run** → every line PASS, exit 0; one planted mutation (the old `/status` expectation given the suffix) fails once.
- [ ] **Step 3: commit** `test(gate): remainder R7 rollback — the merge-base build reads attach.path rows and still sends`.

---

### Task 10: ADR 0034 amendment, its conformance test, docs sync

**Files:**
- Modify: `docs/decisions/0034-decision-ladder-consolidated.md` (Status `:3–5`, rule 1.5 `:51–56`, rule 3.2 `:106–113`, rule 4 row `:161`, rule 4.1 `:164–177`, History `:528–554`, Reference map `:580`), `docs/decisions/README.md:48`, `docs/ROADMAP.md` (a delta after `:233`), `docs/superpowers/specs/2026-10-12-decision-ladder-design.md` (§6.1 note after `:405`), `tasks/todo.md` (state block), `tasks/lessons.md`, `sessions.md`
- Create: `tests/adr/0034-settle-delivery-rows.test.ts`

- [ ] **Step 1: failing ADR test.** `tests/adr/0034-settle-delivery-rows.test.ts`:
  ```ts
  /**
   * Rule: ADR 0034 rule 3.2, the settle-stage and delivery sentence (spec R7 §9, Decision 2-A): parse rows are best-effort terminal records written on the
   * success arm and kept when the run then fails to stage its report; a turn that took the failure arm writes none; a send row is written only after
   * markDelivered, with the outbox row's run_id (null for a run-less row). Changing this rule changes this test in the same commit.
   */
  ```
  Cases (setup as `tests/core/supervisor-decision-wiring.test.ts:1–21`):
  1. rule 3.2's text (sliced from `- 3.2 ` to `- 3.3 `, whitespace collapsed to single spaces so the ADR's line wraps do not matter) contains the two R7 sentences verbatim **and** the two qualifications — `"Rows are written only while the turn is live (except the settle-stage and delivery rows below);"` and `"Supervisor rows follow the incoming run's successful claim (settle-stage rows: below)."` — and the qualified heading `"so a lost turn writes no row (settle-stage rows, which a later finish failure keeps, and delivery rows: below)."`, and no longer contains the unqualified `"only while the turn is live; the signal"`, `"successful claim. A lane"` or `"a lost turn writes no row.**"` (so 3.2 cannot say both; Rev 1.2, codex re-review).
  2. **failure arm → none:** `useFakeOmp({ "*": { rpcText: "ok\n[[attach: ../x]]", rpcAbortAfterText: true } }, tmp.dir)` (P12) → run `failed` (`planner_exit`/`agent_aborted`); `attach.path` rows `[]`. The same text without `rpcAbortAfterText` (control) → one `marker_outside` row, so the case cannot pass vacuously.
  3. **report stage fails → the parse row stays (W1):** `rpcText: "ok\n[[attach: ../x]]"`, `mkdirSync(join(tmp.dir, "project"), { recursive: true }); writeFileSync(join(tmp.dir, "project", "runs"), "")` (P14) → run `failed` with `error_ref` starting `report_write_failed`; rows `[["refuse", "marker_outside", run]]`; the one `${run}:final_report` outbox row is the **failure notice** (`ompFail` → `plannerFailureText("planner_exit", …)` is non-null, `src/core/omp-turn-wiring.ts:76–78` → `enqueueFailureNotification`, `src/run/run-store.ts:7470–7482`): its payload has **no `attachments`** key and its text is not the reply (Rev 1.1, Fable B1).
  4. **send row only after `markDelivered`, with the outbox row's `run_id`; null for run-less:** a dispatcher with `storeRecorder`, a fake adapter returning `attach_checks: ["not_found"]`, the store's `markNotificationDelivered` wrapped to throw once → `markFailed` (`retry_wait`), rows `[]`; move the row's backoff into the past — `db.prepare("UPDATE notification_outbox SET next_attempt_at = ? WHERE notification_id = ?").run(new Date(Date.now() - 60_000).toISOString(), id)` (P19 store access) — then `store.requeueRetryWaitNotifications(new Date().toISOString())` (a `retry_wait` row is not claimable, `run-store.ts:7700–7703`, and a requeue stamps `next_attempt_at` with the time it is given, `:7888`, so a future time leaves the row unclaimable — Rev 1.2, codex re-review); second `dispatchOnce` delivers → one row with the row's `run_id`; a run-less `progress` row → `run_id` null.
  5. **rule 4 row:** the table row for `attach.path` contains `refusals (1-A)` and does not contain `` `alwaysRecord` `` (the existing `tests/adr/0034-always-record.test.ts` reads the same table).
- [ ] **Step 2: run** `npx vitest run tests/adr` → FAIL (sentence absent).
- [ ] **Step 3: ADR text.**
  - Status: append `; amended 2026-11-08 (remainder R7: \`attach.path\`; rows after the end signal — awaiting Paco's signature)`.
  - Rule 1.5: after `src/triggers/telegram-auth.ts` (…), add `` `src/notifications/attachment-check.ts` (the send-time attachment predicate behind `attach.path`, R7 4-A; the loop, upload and follow-up line stay in the adapter, itself protected), `` .
  - Rule 3.2 (Rev 1.1, codex B2; Rev 1.2 the heading): qualify the heading — "**A turn's row is written with that turn's own records, so a lost turn writes no row.**" → "**A turn's row is written with that turn's own records, so a lost turn writes no row (settle-stage rows, which a later finish failure keeps, and delivery rows: below).**" — and the two existing sentences the R7 rows would otherwise contradict — "Rows are written only while the turn is live;" → "Rows are written only while the turn is live (except the settle-stage and delivery rows below);" and "Supervisor rows follow the incoming run's successful claim." → "Supervisor rows follow the incoming run's successful claim (settle-stage rows: below)." — then append the two sentences verbatim from spec §9: "Settle-stage rows (`attach.path` at parse) are best-effort terminal records: written when the supervisor reached its success arm, after the end signal, and kept when the run then fails to stage its report or loses its finish claim; a turn that took the failure arm writes none. Delivery rows (`attach.path` at send) are written by the outbox dispatcher after the delivery committed, with the outbox row's `run_id`; a delivery that did not commit writes none."
  - Rule 4: replace the `attach.path` row with spec §9's row verbatim: `` | `attach.path` | `settle` · `tool` | yes | refusals (1-A): parse `refuse`/`marker_outside`, once per distinct refused path on the success arm; send `refuse`/`over_count` (one for all paths past the fifth), `workspace_unverified`, `outside_workspace`, `not_a_file`, `too_large`, `linked`, `changed`, `not_found`, `unreadable`, `unsupported`, written by the dispatcher after `markDelivered` with the outbox row's `run_id`; rows describe each observed check; `send` default; `fail: "refuse"`; `send_failed` is execution, no row | R7 | ``.
  - Rule 4.1: after the `lookup-predicates.ts` clause add "`attach.path`'s send predicate is `checkAttachment`/`overCount` (`notifications/attachment-check.ts`); its parse predicate is `parseAttachments`' containment conjunction.". Leave 4.1's last sentence (it lists pre-tool entries outside the table; `attach.path` is now in the table).
  - History: `| 2026-11-08 | R7: \`attach.path\` (locked) at parse and send; 3.2 adds settle-stage and delivery rows; \`attachment-check.ts\` protected | [R7](../superpowers/specs/2026-11-08-ladder-remainder-r7-attach-path-design.md) | awaiting Paco's signature |`.
  - Reference map `:580`: `slices R1 … R6 (A21, A22) · R7 (E2, E11)`.
  - `docs/decisions/README.md:48`: in 0034's description `R1–R6` → `R1–R7`; append `; amended 2026-11-08 (remainder R7: \`attach.path\` at parse and send, rows after the end signal — awaiting Paco's signature)`.
- [ ] **Step 4: docs sync (a re-read, not an append).** `grep -rn "attach.path\|attachment adapter\|telegram-notification-adapter\|R6 is\|R7\|39 entries\|39 registered\|ENTRY_IDS" README.md CONTEXT.md docs/reference deploy/launchd/README.md docs/ROADMAP.md` and fix each claim this branch made false. Known edits:
  - `docs/ROADMAP.md`, a delta after `:233`: `**Delta 2026-11-08: Stage 3 remainder slice R7 shipped — \`attach.path\` (locked) on the ladder** (spec Rev 1.2, Decisions 1-A, 2-A, 3-A, 4-A, 5-A). The attachment check is recorded at both places it decides and never steers: a marker the supervisor drops at parse (\`marker_outside\`, on the success arm, before the chat turn) and a file the send-time re-check refuses (written by the outbox dispatcher after the delivery committed, at most six rows per delivery). The send predicate moved to a protected leaf; two reasons split (\`workspace_unverified\`, \`not_found\`) with Paco's lines byte-identical; \`/status\` splits the count by seam. Rule 3.2 amended (awaiting Paco's signature). Behaviour identical: differential 18 corpora (new \`attach\`, N items), 0 differences; live gate 7/7; rollback PASS. Every row of ADR 0034 rule 4 is now built; the remainder is done. **Next:** per the ROADMAP's sequenced builds.` (N filled in from Task 7's run.)
  - Ladder spec §6.1, after `:405`: `**Note (2026-11-08, remainder R7, Paco's Decisions 1-A, 2-A, 3-A, 4-A, 5-A; ADR 0034 amendment):** E2+E11 \`attach.path\` (locked) is registered (stage \`settle\`), rule-only: refusals at parse (\`marker_outside\`) and at send (ten reasons, written by the dispatcher after \`markDelivered\`); the send predicate in the protected \`notifications/attachment-check.ts\`. Every §6.1 row now has an entry. Spec \`2026-11-08-ladder-remainder-r7-attach-path-design.md\`.`
  - `CONTEXT.md:189` (Planner Workspace): still true; leave. `README.md:126`: still true (behaviour unchanged); leave.
  - `docs/reference/configuration.md`: **no edit** — R7 adds no env var (grep the diff for `process.env.HOUGE_` to confirm); say so in the report.
  - `tasks/todo.md` state block: R7 shipped, ADR 0034 R7 amendment awaiting Paco's signature, follow-ups: a "⚠ Not attached" line for parse refusals (needs its own decision, spec §2); `lane-card.ts:10` stale comment; the `jev-tree` cases 3/7 (carried).
  - `tasks/lessons.md`: one entry if the slice taught one (e.g. "a spec's 'not protected' claim is checked against `PROTECTED_FILES`, not assumed" — D1).
  - `sessions.md`: one arc entry for the build session.
- [ ] **Step 5: run** `npx vitest run tests/adr tests/docs`, `npm run typecheck`, `npm test`, `npm run build` → PASS, 0 skipped.
- [ ] **Step 6: commit** two commits, one concern each: `docs(adr): 0034 R7 — attach.path row, 3.2 settle-stage and delivery rows, 4.1 predicates (awaiting Paco's signature)` (ADR + README index + `tests/adr/0034-settle-delivery-rows.test.ts`), then `docs: R7 docs sync — ROADMAP, ladder §6.1, todo, lessons, sessions`.

---

## Rev 1.1 changes (plan review: codex + Fable senior; each verified first-hand against HEAD)

Blockers:
- **codex B1 — workspace resolution order.** `CheckDeps.workspace` is now a thunk `() => string | undefined`; the leaf calls it only after `canUpload` (adapter `:88` before `:89`), outside the try as today. P3, Task 1 Interfaces, leaf code, adapter `readAttachment`, and the `attachment-check` tests updated; new adapter test: no `sendDocument` + a throwing `workspaceFor` → `["unsupported", "unsupported"]`, resolver never called, `send()` resolves. Spec defect D13.
- **codex B2 — ADR 3.2 would contradict itself.** Task 10 now qualifies "only while the turn is live" (except settle-stage and delivery rows) and "Supervisor rows follow the incoming run's successful claim" (settle-stage rows: below) before appending the R7 sentences. `tests/adr` case 1 asserts both qualifications are present and both unqualified phrasings are gone.
- **Fable B1 — the failure notice is a `final_report` row.** Task 10 case 3 and Task 8 line 4 now assert that the `${run}:final_report` row is the failure notice and has no `attachments` (and, at the gate, no `sendDocument`). Spec defect D12.
- **Fable B2 — an insert fault writes three rows.** Task 7 `insert_fault_send` now excludes and asserts the `incidents`, `incident_opened` ledger and `change_log` rows by exact shape. Task 5 case 9 and Task 8 line 5 also assert the ledger event. Spec defect D11.

Warnings:
- **codex — gate line 1 ordering.** The `created_at ≥ updated_at` check is replaced by a recorder wrapper that reads the seeded row's state on every call (each must be `delivered`). M1 must fail the line.
- **Fable — incident literal.** `planner_turn_crash` → `planner_turn_crashed` (`planner-supervisor.ts:497`, `:556`), in Task 4 case 10 and the Task 7 `registry_mistake` row.
- **Fable — ADR case 4 requeue.** `requeueRetryWaitNotifications` runs between attempts (a `retry_wait` row is not claimable, `run-store.ts:7700–7703`).
- **Fable — `incidents.detail_json`.** Task 5 case 9 selects `detail_json` and parses it; Task 7 likewise.
- **Fable — path.** P14 names `src/report/report-writer.ts:47` and `<project>` = `join(tmp.dir, "project")`.

Suggestions taken:
- Task 4 case 9 says to `await sup.whenIdle()` and to expect `planner_turn_crashed` (D10).
- Task 5 case 1 explains why `record:send:checked` is logged.
- Task 3 `attachSuffix` notes that a fail-rung row's `reason_code` is null.
- Task 9 states why the old build prints the `attach.path` line (`status-view.ts:29`, no registry filter).

Suggestion skipped:
- **P1 worktree name `base-<sha7>`.** R6's plan and its rollback used `base-<12-char sha>`, and both flags take a path, so the post-merge command works either way. Kept 12 to match the most recent slice.

## After the tasks (orchestrator)

Full suite + typecheck + build on a quiet machine; the full differential (every pair incl. `--old-dist-r7`, 18 corpora); R7, R6, R5, R4, R3, R2, R1, 4C, 4B gates; R7 rollback; final whole-branch reviews (most capable non-orchestrator model with the P21 mutation list, codex whole-diff: "does any ADR rule now contradict the code, or another ADR?", "which doc claim did this branch make false?"); one fix wave; merge, push, rebuild `dist/`, kickstart (Tier A, after checking `houge.parked`/`houge.kill` and no run in flight); fill `--old-base-r7 <sha>` into the differential header; Paco signs the ADR amendment.

## Rev 1.2 changes (codex scoped re-review, 2026-11-08; applied by the orchestrator)
- Rule 3.2's heading ("a lost turn writes no row") is qualified too, and the tests/adr case 1 asserts the qualified heading and the absence of the bare one.
- Retry after `markFailed`: `requeueRetryWaitNotifications(now)` stamps `next_attempt_at = now` (`run-store.ts:7888`) and a claim needs `next_attempt_at <=` the real time (`:7700`), so a future requeue time left the row idle. ADR case 4 and the delivery fixture now move the backoff into the past, then requeue at the real time.
