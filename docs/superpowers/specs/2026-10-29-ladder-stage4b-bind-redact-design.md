# Decision ladder, stage 4 slice B — `approval.bind` and `secret.redact` as locked entries, and Stage 4's differential gate (Rev 1, draft)

**Status:** **Draft for review** (senior on a model other than the orchestrator and codex, against the live DB; then codex). Not approved. Decisions 1–3 below are Paco's.
**Date:** 2026-10-29
**Amends:** ADR 0030 Amendment 2026-10-28 (Stage 4A), its line "**B14 / `approval.bind`:** … `approval.bind` stays a locked id with no module" — under Decision 1-A it becomes "`approval.bind` records the consume; the standing case stays in `tool.policy` + the sink CAS". `docs/ROADMAP.md` Stage 4 (closes the stage's gate column).
**Depends on:** ADR 0030 §4.1 (entry), §6.1 (inventory rows B14, E8), §6.2 (move, don't improve), §13 rollout row 4 (`docs/superpowers/specs/2026-10-12-decision-ladder-design.md:1150`); Stage 3 wiring (`2026-10-26-ladder-stage-3-wiring-design.md` §2–§5, merged through `fb03d00`); Stage 4A (`2026-10-28-ladder-stage4a-standing-approval-design.md`, shipped `6be9529`, kickstart owed).

## 1. Goal

Register the last two Stage 4 protected families as **locked, rule-only** entries, each with **one** call site that wraps today's code unchanged, so every approval consume and every masked outbound report leaves a `decisions` row — and prove, with one differential gate for the whole of Stage 4, that the command corpus, the path corpus, the policy matrix, the approval-binding matrix and the redaction corpus behave byte-for-byte as before. No gate opens or closes differently; no model touches either entry, ever.

## 2. Live facts (2026-10-28, `main@1451a66`, read-only on code and on `houge.sqlite`; how each was measured is in brackets)

**Registry.** `ENTRY_IDS` has 18 ids (`src/decisions/entry-ids.ts:5`); `approval.bind` and `secret.redact` are in `LOCKED_ENTRY_IDS` (`:14–15`) with no module, so `insertLadderMove` already refuses them (`run-store.ts:1089`) and `entryProblems` would fail an unlocked or judged entry under those ids (`registry.ts:51–53`). `tests/decisions/registry.test.ts:17` pins `REGISTRY` ≡ `ENTRY_IDS`; `scripts/live-gate-ladder-stage3-wired.mjs:35` hard-codes the 18 ids. Live `decisions` rows by entry: tool.injection 125, turn.trust 40, turn.handler 27, turn.gear 23, turn.settle 16, tool.shell_netread 15, tool.policy 13 (all `entry_version 2`), tool.manifest 12, tool.wall 12, improve.route 1; **zero** rows for tool.path, fetch.ssrf, posture.kill, selfwrite.guard (their deny branches have not fired live) [`select entry_id, count(*) from decisions group by 1`].

**Stage 3's wired pattern, as built (not as its spec words it).** Every wired seam runs the raw predicate, calls `decideSync(ENTRY, folded, ctx)`, **discards the result**, and branches on the raw value: `capability-runner.ts:145` (tool.policy, result unused; the raw `decision` drives `:147`), `bridge-handler.ts:308–309` and `:650–651` (posture.kill; `posture` drives), `:631–637` (tool.path; `t.reason`/`denial` drive), `http-fetch.ts:35–38` (fetch.ssrf, record only), `core-worker.ts:1458`, `:1795` (selfwrite.guard). The Stage 3 spec's invariant 1 says "the seam acts on `r.verdict`"; the code does not. Both are behaviour-identical while the rule is total; this slice follows the code (ruling R1).

### 2.1 `approval.bind` — B14, "approval consume (binding)" (inventory `11-houge-inloop-inventory.md:68`)

Decision points today:

| # | Where | What it decides, exactly |
|---|---|---|
| P1 | `capability-runner.ts:143–144` | the authority rule: on an approved resume (`approved_approval_id` set) the standing selector is ignored — "the approved resume's authority is the approval row, never the selector" |
| P2 | `capability-runner.ts:145–160` | re-validation: `decideCapability` runs again on the resume; `deny` returns `denied_on_revalidation` **before** any consume (the approval row stays `approved`, unconsumed). Recorded today by `tool.policy`, not B14 |
| P3 | `capability-runner.ts:192–198` | no sink on a resume → `{status:"failed", error_ref:"Approval sink is not available for resume"}` |
| **P4** | **`capability-runner.ts:200–218`** | **the consume: one call to `approvals.consumeApprovedApproval({run_id, approval_id, requester, capability, adapter_input_hash, action_fingerprint, tool_call_id: "tool_"+uuid, operation_id: "op_"+uuid, consumed_at, standing_trial?})`; `!ok` → `{status:"failed", error_ref: "${code}: ${message}"}`; `ok` → the adapter runs (`:221`). The single convergence point of both sinks** |
| P5 | `tool-approval-sink.ts:55`, `:68–72` | omp sink: `who()` swaps the runner's requester for `deps.approver` (the operator on a schedule-born turn); maps the store result to `{ok:false, error:{code, message: code}}` — so `error_ref` is e.g. `"expired: expired"` |
| P6 | `run-store.ts:6946–6962` `consumeToolApproval` | seven refusals, checked in this order, no transaction: `unknown_approval` (no row or other run) → `not_approved` → `expired` (`expires_at <= now`) → `action_mismatch` (capability or fingerprint) → `owner_mismatch` (worker) → `requester_mismatch` → the CAS `UPDATE … WHERE state='approved' AND EXISTS(run running, same worker, lease_expires_at > now)`; `changes !== 1` → `lease_lost`. Then `creditAfterConsume` (`:6968–6971`) in its own transaction (Stage 4A's standing credit / `candidate → sealing`) |
| P7 | `core-worker.ts:636–656` → `run-store.ts:7738–7824` `consumeApprovedApproval` | run-level sink, own `BEGIN IMMEDIATE`: `APPROVAL_NOT_FOUND` → `APPROVAL_NOT_APPROVED` → `APPROVAL_REQUESTER_MISMATCH` → `APPROVAL_RUN_MISMATCH` → `RUN_NOT_RUNNING` → `APPROVAL_CAPABILITY_MISMATCH` → `APPROVAL_INPUT_MISMATCH` → `APPROVAL_ACTION_MISMATCH`, then an `UPDATE` whose `changes` is **not** checked and **no expiry check**. Reached only through the gated fixture (`force_gated_capability`, set only by `eval-runner.ts:256`) [grep]; the live `approvals` table has **0 rows** [`select state, count(*) from approvals`]. `runGatedCapability` passes **no recorder** to the runner (`core-worker.ts:801–809`), so tool.policy/tool.budget rows are not written on that path today |

Resolve-time bindings (the tap, not the consume — named so the review sees what this slice leaves out, Decision 2): sender allowlist upstream (A1 `intake.sender`); `processApprovalTrigger` (`run-store.ts:6811–6875`, raw `BEGIN IMMEDIATE`) → chat binding `approvalChatBound` (`:7121–7125`, applied at `:6844`, `APPROVAL_CHAT_MISMATCH`) → `resolveToolApprovalWithinTransaction` (`:8117–8139`: `APPROVAL_NOT_FOUND`, `APPROVAL_REQUESTER_MISMATCH`, `APPROVAL_EXPIRED`, `APPROVAL_NOT_PENDING`, CAS, then the deny hook `standingDeny` `:7103–7119`) or `resolveApprovalWithinTransaction` (`:8076–8115`); the gateway wakes the bridge waiter only on `ok` (`gateway.ts:1012–1031`). The standing use (Stage 4A): `authoriseStanding` (`capability-runner.ts:229–233`) → `standingUse` CAS (`run-store.ts:7025–7042`, nine refusals) → recorded under `tool.policy` v3 as `standing` / `standing_mismatch`; the specific refusal code is **dropped** by the runner (`:232`) — only `fingerprint_mismatch` leaves a trace (the row ends `mismatch`, `:7031`).

Live: `tool_approvals` 43 consumed / 2 denied / 6 expired, 2026-10-01 → 10-26, every `requester.kind = user` (scheduled runs are approved by the operator identity); 5 runs hold more than one approval [`select json_extract(requester_json,'$.kind'), capability, state, count(*) …`; `… group by run_id having count(*)>1`]. `processed_triggers` holds 1 `APPROVAL_NOT_FOUND` and 5 `APPROVAL_NOT_PENDING` refusals. `standing_approvals` does **not** exist on the live DB yet (Stage 4A's migration runs at the owed kickstart) [`no such table`].

### 2.2 `secret.redact` — E8, "redact and truncate" (inventory `:122`)

The redactor: `createSecretBroker` (`src/config/secret-broker.ts:85–130`) captures nine values (`KIMI_API_KEY`, `GEMINI_API_KEY`, `TAVILY_API_KEY`, `FIRECRAWL_API_KEY`, `HOUGE_TELEGRAM_BOT_TOKEN`, `HOUGE_GMAIL_CLIENT_SECRET`, `HOUGE_GMAIL_REFRESH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `TYPESAFE_API_KEY`), drops values shorter than `MIN_REDACTABLE_SECRET_LENGTH = 6` (`:52`), sorts longest first, and replaces each by `split/join` with `«redacted»` (`:44`, `:120–128`); empty or non-string input is returned as is. Armed only when `HOUGE_SECRETS_FIREWALL_ENABLED` is truthy (`:154–157`); boot passes `broker.redact` into every `RunStore.open` (`cli.ts:29–35`, `:58`, `:263`) and the same `broker` into `CoreWorker` (`cli.ts:69–78`, `:274` → `telegram-daemon.ts:193–206`; `telegram-poll-runner.ts:135–146`). **Live `.env` has the firewall armed** (`HOUGE_SECRETS_FIREWALL_ENABLED=true`) [grep of the flag line only, values not read]. The store holds it as `this.redact`, identity when absent, with `redactionEnabled` (`run-store.ts:1405–1410`).

Decision points today (every place a secret-shaped value is scrubbed before it leaves or is stored):

| # | Where | Seam | In E8? |
|---|---|---|---|
| **R1** | **`run-store.ts:10410–10415` `truncateForChat`** | **redact first, `trim()`, then cut at `CHAT_TEXT_MAX = 3900` (`:10408`) with `"\n\n… (truncated)"` — so a masked value is never split** | **yes** |
| R1a | `:7275` `enqueueFinalReportNotification` | success report, key `${run_id}:final_report` | yes |
| R1b | `:7306` `enqueueFailureNotification` | failure notice, **same** key and intent | yes |
| R1c | `:7327` `enqueueEvolutionReportNotification` | self-write report; the redacted text is also stored as the assistant chat turn (`:7345–7351`) | yes |
| R2 | `:1519–1540` `appendLedgerEvent` → `redactLedgerEvent` / `redactValue` | every ledger writer; deep over string **values** only (object **keys** are not masked), skipped when the firewall is off | no (sibling) |
| R3 | `:6760` (`buildApprovalPromptText` `:10425–10445`), `:6918` (`buildToolApprovalPromptText` `:10448–10464`), `:6921` (`card_detail`) | approval cards; the payload's `action_summary` (`:6761`, `:6919`) is stored **unredacted** (it is the matcher label or `Execute <capability>`) | no (sibling) |
| R4 | `:5125–5128` `redactSecretValues` | the broker step of the judge redactor (`egress.ts:373–376` `redactForJudge`, via `injection-judge.ts:63`, `supervisor-settle.ts:65`, `golden.ts:58/130/184`) and of `redactForImprove` (`egress.ts:383–385`) | no — ADR 0030 decision 12's judge redactor, its own invariants I1–I4 |
| R5 | `core-worker.ts:3394–3397` `maskSecrets` (callers `:3373`, `:3401`, `:3451`, the memory-lane cards); direct `broker.redact` at `:1780` (via `self-write-locked.ts:113–114`), `:2938`, `:3143` (`jev/questions/tree.ts:166–175`) | outbound cards and Jev egress, outside the store | no |
| R6 | `jev/egress-redact.ts:23–27` `sanitizeJevText` | ADR 0029 §4.5's TypeSafe envelope (broker values, then shapes) | no |

`enqueueNotification` itself (`:7386`) does **not** redact: its `payload_hash` is `stableHash(payload)` (`:7388`) over whatever the wrapper built, so a byte change in the redacted text would change the idempotency hash and turn a retry into a `conflict`. `recordChatTurn` (`:1574–1597`) writes text as given (the user's own turns are stored unredacted). Incident alerts (`incident-alert.ts:40–48`) go through the unredacted `enqueueNotification`; `openIncident` appends a ledger event (`run-store.ts:~6039`), i.e. through R2.

Live: 633 `final_report` and 51 `approval_prompt` outbox rows; 6,191 ledger events since 2026-09-28 (15,297 total); **zero** rows in either table contain `«redacted»` [`… where payload_json like '%«redacted»%'`]. The live corpus therefore cannot tell a working redactor from a no-op: the redaction corpus must be seeded (§6.5).

## 3. Scope

In: two entry modules; one call site each; `ENTRY_IDS` 18 → 20; the five corpora and the dual-build differential; the live gate; the rollback check; the ADR 0030 amendment draft and the docs sync.
Out (non-goals): any change to what a consume, a resolve or a redaction does; the resolve-time bindings (Decision 2); the redaction seams R2–R6 (Decision 3); recording the standing CAS's refusal code (Decision 1); the run-level sink's missing expiry and `changes` checks (P7) — recorded as a follow-up, not fixed here; any Jev or model rung on any locked entry (forbidden, ADR 0030 decision 6, AGENTS.md); `memory.lesson_admit`, `schedule.admit`, `attach.path`, `notify.page` (their own slices).

## 4. The entries (pattern: `entries/tool-path.ts` v2, `entries/fetch-ssrf.ts`)

```ts
// src/decisions/entries/approval-bind.ts
export type ApprovalBindVerdict = "bound" | "unbound";
export const APPROVAL_BIND: Entry<{ ok: boolean; code?: string }, ApprovalBindVerdict> = {
  id: "approval.bind", version: 1, stage: "pre_tool", input: "tool", locked: true,
  question: "Does this consume bind the approved row to this exact action, owner and requester?",
  verdicts: ["bound", "unbound"],
  ladder: [{ kind: "rule", name: "consumeBinding", decide: rule }],   // ok → bound; else unbound + mapped code
  fail: "unbound", defaultVerdict: "bound", alwaysRecord: true, outcomes: [], armed: { rule: "on" },
  effects: { bound: { kind: "none", reversible: true, announced: "none" }, unbound: { kind: "tighten", reversible: true, announced: "none" } },
  reasonCodes: ["no_sink", "unknown_approval", "not_approved", "expired", "action_mismatch", "owner_mismatch", "requester_mismatch", "lease_lost",
    "not_found", "run_mismatch", "run_not_running", "capability_mismatch", "input_mismatch"],
};
```
Code map (a fixed table like `tool-policy.ts` `REASON_MAP`): the omp sink's seven codes map to themselves; run-level `APPROVAL_NOT_FOUND→not_found`, `APPROVAL_NOT_APPROVED→not_approved`, `APPROVAL_REQUESTER_MISMATCH→requester_mismatch`, `APPROVAL_RUN_MISMATCH→run_mismatch`, `RUN_NOT_RUNNING→run_not_running`, `APPROVAL_CAPABILITY_MISMATCH→capability_mismatch`, `APPROVAL_INPUT_MISMATCH→input_mismatch`, `APPROVAL_ACTION_MISMATCH→action_mismatch`; P3 → `no_sink`; any other code → no `reason` (the row carries `null`, `record.ts:64`). `alwaysRecord`: every consume is a Paco tap being spent (43 in 26 days), and the row is the decision id §4.3 wants as ladder-move evidence.

```ts
// src/decisions/entries/secret-redact.ts
export type SecretRedactVerdict = "clean" | "masked";
export const SECRET_REDACT: Entry<{ masked: boolean; seam: RedactSeam }, SecretRedactVerdict> = {
  id: "secret.redact", version: 1, stage: "settle", input: "tool", locked: true,
  question: "Did this outbound report carry a known secret value (ADR 0015) that was masked before it was cut?",
  verdicts: ["clean", "masked"],
  ladder: [{ kind: "rule", name: "brokerValues", decide: rule }],    // masked → { verdict: "masked", reason: seam }; else clean
  fail: "masked", defaultVerdict: "clean", outcomes: [], armed: { rule: "on" },
  effects: { clean: { kind: "none", reversible: true, announced: "none" }, masked: { kind: "tighten", reversible: true, announced: "none" } },
  reasonCodes: ["final_report", "failure_report", "evolution_report"],
};
```
`masked` is `redact(text) !== text`, computed on the input before `trim()`/cut. `fail: masked` labels a thrown rule as the cautious answer; nothing branches on it (R1). No row for a clean report (default verdict, rule rung), one row per masked report; a row never holds text (ids, enums, the seam code).

Both entries: `entryProblems` empty; `locked` and in `LOCKED_ENTRY_IDS`; one rule rung; no `system_one`/`model`/`paco` rung (a registry test pins that the two ids have exactly one rung, of kind `rule`).

## 5. The single call sites (move, don't improve)

**`approval.bind` — `CapabilityRunner.execute`, P3+P4 (`capability-runner.ts:192–219`).** Extract the block into one private `bindApproval(input, …): { ok: true } | { ok: false; result: CapabilityResult; code: string }` that returns **exactly** today's two failure results (P3's `error_ref` string; P4's `"${code}: ${message}"`) and calls the sink **once** with the same argument object (same field set and order, same random ids, the `standing_trial` spread unchanged). Right after it returns, before any branch: `decideSync(APPROVAL_BIND, { ok, code }, { run_id: input.run_id ?? null, tool_call_id: input.tool_call_id ?? null, recorder })` with the same `recorder` the runner already built (`:120`). Then the raw result drives the branch as today (R1). Rules:
- Reached only when `approved_approval_id` is set (so a first call that asks writes no bind row; a standing use writes none — Decision 1).
- `denied_on_revalidation` (P2) returns before the block: no bind row (the consume was never attempted); `tool.policy` keeps that row.
- A sink that **throws** propagates exactly as today, with no bind row (a throw is not a verdict; R2).
- The run-level path records through the runner's no-op recorder (`core-worker.ts:801–809` passes none), as tool.policy does there today.
- `capability-runner.ts` stays under the 50-line function rule: `execute` loses lines.

**`secret.redact` — one private `RunStore.redactReport(seam, run_id, text): string`** that replaces the three `truncateForChat(…, this.redact)` calls at `:7275`, `:7306`, `:7327`: it computes `out = this.redact(text)`, and **only when `this.redactionEnabled`** calls `decideSync(SECRET_REDACT, { masked: out !== text, seam }, { run_id, tool_call_id: null, recorder: this.decisionRecorder })`, then returns `truncateForChat(text, this.redact)` — the same function, the same arguments, so the stored bytes, `payload_hash` and the chat-turn copy are unchanged by construction (the redactor runs twice on a report; it is a pure closure, `secret-broker.ts:72–76`). With the firewall off: no decision, no row (as today, nothing is masked). The recorder:
- is injected, not imported: `RunStore.open/openInMemory` options gain `decisionRecorder?: (store: RunStore) => DecisionRecorder`, built in the constructor after `migrate()`; `cli.ts`'s `storeOptions` passes `storeRecorder` **always** (not only when armed). Reason: `record.ts` imports `run/incident-alert.js` → `invariant-sweep.js` → `run-store.js` at run time; a store import of `record.ts` would be a cycle [read of the four import lists]. Absent → a no-op recorder; a boot test pins that the daemon's store is built with it, and the live gate's silent-degradation line fails if it is not;
- runs on the caller's connection, inside whatever transaction the enqueue is in, so a rolled-back report rolls back its row;
- cannot recurse: R1 is reached only through the three report wrappers; the recorder's failure path (`recordFailed` → `openAlertedIncident` → `openIncident` → ledger R2, and `alertOpened` → unredacted `enqueueNotification`) never reaches R1 [traced]. A test pins it (a recorder that fails every write: the report is enqueued with the masked text, exactly one `decision_record_failed` incident, the call returns).

## 6. The differential (Stage 4's gate column: "command corpus, path corpus and policy matrix identical", plus binding and redaction)

**Harness:** `scripts/check-ladder-stage4-differential.mjs --old-dist <dir> [--base <sha>]` loads the corpora, runs each item through the old build and through this build (each against its own temp DB, VACUUM copies where a DB is read), and compares projections. Old builds come from worktrees verified by `scripts/old-dist-provenance.mjs`. **Bases:** command and path corpora against **`548cb87`** (the last commit before Stage 3 registration; `command-matcher.ts` unchanged since `55d3ac6` 2026-10-01 and `gate-path.ts` since `86f4601` 2026-10-20 [git log]) — this proves Stage 3's wiring of `tool.shell_class` and `tool.path` too, which its smoke gate never compared; policy, binding and redaction against **`1451a66`** (pre-4B; Stage 4A intentionally changed policy v3 and the tap binding), plus the policy matrix's no-`standing` half against `548cb87` as well. Vitest characterisation tables, written red-first in the plan's first task, pin the same items inside the suite.

**PASS (for every corpus):** zero differences in the compared projection; any difference is FAIL with the item printed (redacted). Excluded from comparison, by name only: ids, timestamps, `latency_ms`, the random `tool_`/`op_` ids (mapped pairwise), and `decisions` rows whose `entry_id ∈ {approval.bind, secret.redact}` — those are instead **required** (counts below). **Self-test:** each run also feeds one planted one-byte divergence (a known item mutated on the new side only) and must report exactly it, else the harness exits FAIL (a comparator that sees nothing proves nothing).

1. **Command corpus.** (a) every string literal in `tests/omp/command-matcher.test.ts` (the `it.each` tables); (b) the bash calls in the live omp transcripts `omp/sessions/chat-8744196214/*.jsonl` — **171 calls, 147 distinct** [parsed: `toolCall` with `name: "bash"`, `arguments.command`], extracted at gate time into the scratch dir, never written to the repo or the gate's output (the repo is public; transcripts may carry tokens); (c) one item per known miss in ADR 0028's residuals (`docs/decisions/0028-*.md:239–241`: `dd`, `unlink`, `python3 -c` / `node -e` / `perl -e`, ANSI-C `$'…'`, spaced arithmetic beside a multi-line quote, an apostrophe in nested double quotes inside `$()`, `bash file.sh`) — pinned as today's (miss) answer, not fixed. Compared: `classifyCommand` kind + label, and at the bridge seam the card's `Action:` label, whether the call asked, and the `tool.shell_class` row (new side only; old base has none — compared head-vs-`1451a66`).
2. **Path corpus.** (a) `tests/omp/gate-path.test.ts`; (b) at least one item per branch of `gateTargets` (`gate-path.ts:57–66`) and its resolver (`:25–37`): empty → `missing_path`; a control char or backslash → `bad_path`; more than `MAX_GATE_TARGETS` candidates → `bad_path`; `:`-prefixed (valid and invalid), `@`-prefixed (URL → `url_read`, `@/`/`@~` valid, other → `bad_path`); a URL and a `www.` path → `url_read`; `~`, `~/x`, `~x`; `/` and `///` (→ cwd); a quoted path; a path with `:`/`?`/`#` (the peel candidates); relative and `..` — each for `fs_read` and `fs_write` against `isDeniedRead`/`isDeniedWrite`, plus every protected path in `src/omp/protected-paths.ts`; (c) the 13 live `read`/`write`/`edit` inputs from the same transcripts [7 + 3 + 3]. Compared: `gateTargets` output, the gate's deny code at the bridge seam, the `tool.path` row's verdict/reason (head vs `1451a66`).
3. **Policy matrix.** `decideCapability` over: each registered capability's `side_effect_level`/`risk_level`/`category` × {allowed, forbidden, neither} × `approval_gates` {∅, its level} × `trust_ask` {absent, true} × `standing` {absent, present} × `coding_agent` delegation {allowed, not}; seeded from `tests/policy/*.test.ts`. Compared: `{decision, reason}` and the `tool.policy` row through `CapabilityRunner.execute` with a stub sink (verdict, reason code, row count incl. the dedup).
4. **Approval-binding matrix.** Through `CapabilityRunner.execute` with the **real** store sinks on a temp DB: the omp sink — happy path; each of the seven refusals produced by its real precondition (other run's row, `pending`/`denied`/`consumed`/`expired` states, `expires_at` 1 ms past, capability changed, one byte of input changed, other worker, other requester, operator-approver swap on a schedule-born run, lease expired, run not `running`); `standing_trial` on a candidate row (`sealing` follows) and on a non-candidate row (no credit); a second consume of the same row; P2 (`denied_on_revalidation`, row stays `approved`); P3 (no sink). The run-level sink — through the eval fixture seam (`force_gated_capability`, `eval-runner.ts:256/273`): happy path and each of its eight codes. Compared: the `CapabilityResult` (status, `error_ref` bytes), every `tool_approvals`/`approvals` column, `standing_approvals`/`standing_uses` rows, ledger event types and payloads, incident rows. **Required on the new side:** exactly one `approval.bind` row per attempted consume (omp sink), `bound` iff the old side's result was not `failed`, `reason_code` = the mapped code; zero on P2 and on first calls.
5. **Redaction corpus (seeded; the live one has no secret, §2.2).** A synthetic broker with nine fake values (realistic shapes: `123456789:AA…` bot token, `sk-…`, `AIza…`, `1//0g…` refresh token, a 64-hex key, a value with `$^*+?.()[]{}|\`, a value that is a substring of another, a 5-char value that must **not** mask, a value with a newline). Texts: every live `final_report` payload text from a VACUUM copy (633), each as-is and with one value planted at the start, the end, twice, and straddling offset 3900 (cut boundary), and mixed into the three wrappers (R1a–c); plus empty, whitespace-only, 3,899 / 3,900 / 3,901 chars, and the firewall-off store (identity). Compared: the outbox row byte-for-byte (`payload_json`, `payload_hash`, state), the evolution report's `chat_turns` text, and the return value. **Required on the new side:** one `secret.redact masked` row per planted call with `reason_code` = the seam, zero for clean texts and for the firewall-off store; and a full-DB scan of every TEXT column on both sides finds **no** seeded value.

## 7. Live gate — `scripts/live-gate-ladder-stage4b.mjs` (on `dist/`, a VACUUM copy, a synthetic broker; never the live DB for writing, never real secret values)

Lines (each PASS/FAIL; exit 0 only if all PASS):
1. Registry: 20 ids, both new entries locked, one `rule` rung each, `entryProblems` empty for all 20; `insertLadderMove` refuses both ids.
2. Bind, through the real bridge: a schedule-born run asks for `launchctl list` (classified `external_write`, side-effect free; chosen so the gate writes nothing to any third party), the tap is resolved through `resolveToolApprovalForTest` + the waiter (the seam `live-gate-ladder-2b-hooks.mjs:220` uses), the resume consumes → one `approval.bind bound` row with the call's `tool_call_id`; the command's own exit is not asserted.
3. Bind refusals, through the runner with the real omp sink: expired, action mismatch (one byte), lease lost → `unbound` with `expired` / `action_mismatch` / `lease_lost`, results byte-equal to the `1451a66` dist on the same copy.
4. Redact: a final report carrying a seeded value at offset 3,895 → outbox text byte-equal to the old dist's, `«redacted»` whole, `… (truncated)` intact, one `masked` row `final_report`; a failure notice and an evolution report likewise; a clean report → no row.
5. **Silent degradation:** the count of `secret.redact masked` rows equals the number of seeded report calls **and** the full-copy scan finds 0 seeded values; the count of `approval.bind` rows equals the number of resumes. Either zero where it should not be → FAIL (catches a store built without the recorder, or an unwired call site).
6. Recorder fault: a `BEFORE INSERT` trigger on `decisions` raising for the two ids → the consume still succeeds and the command still runs; the report is still enqueued masked; one `decision_record_failed` incident per entry; the gate returns within 5 s (no recursion).
7. Firewall off: a store opened without `redact` → reports byte-equal to the old dist, zero `secret.redact` rows.
8. The Stage 4A gate `live-gate-standing-approval.mjs` and `live-gate-cleanroom-runtime.mjs` still PASS on this build (the consume block moved under the standing trial).

## 8. Rollback check — `scripts/check-ladder-stage4b-rollback.mjs` (pattern `check-decisions-rollback.mjs`)

No schema change: the two ids are new values in existing `decisions` columns. On a VACUUM copy written by this build (rows of both ids present, a standing row from the 4A seed), the `1451a66` dist opens it, runs its migrations, renders the digest and `/status` (count lines for unknown ids render, `digest.ts:91–103`), resolves an approval, runs a resume (no bind row written), enqueues a masked report (no redact row), and refuses a `review_ok` tap on an `approval.bind` decision (`outcomes.ts:40` checks `ENTRY_IDS`); then this build reopens it. PASS = no throw, no row lost, outputs as the old build alone would give.

## 9. Protected files touched (Tier A under the approved spec)

`src/decisions/entries/approval-bind.ts` (new), `src/decisions/entries/secret-redact.ts` (new), `src/decisions/entry-ids.ts`, `src/decisions/registry.ts` (all under `src/decisions/`), `src/capabilities/capability-runner.ts`, `src/run/run-store.ts`, `src/cli.ts` (the recorder in `storeOptions`), `docs/decisions/0030-decision-ladder.md` + its index row. Not protected, touched: `src/telegram/telegram-daemon.ts` only if the boot test needs a seam; tests; `scripts/live-gate-ladder-stage3-wired.mjs:35` (18 → 20 ids). Untouched: `src/config/secret-broker.ts`, `src/policy/`, `src/omp/` (the bridge is not edited; `tool-approval-sink.ts` keeps its mapping).

## 10. Risks

| Risk | Mitigation |
|---|---|
| The extracted `bindApproval` changes argument order, the random ids or the `standing_trial` spread, and Stage 4A's credit or sealing shifts | binding matrix compares `standing_*` rows; line 8 reruns the 4A gate |
| Redacting twice in `redactReport` diverges from once (a non-idempotent redactor) | the redactor is a pure closure over fixed values; the corpus compares bytes and `payload_hash`; the decision uses the first result only for `masked` |
| A store built without the recorder records nothing, silently | injected factory + boot test + gate line 5 |
| Recursion through the incident path | R1 unreachable from it (traced); gate line 6 bounds it |
| A `secret.redact` row written inside a caller's transaction lengthens it | one INSERT on a masked report only (none on clean; 0 masked reports live in 30 days, §2.2) |
| The command corpus leaks a token from the transcripts | extracted to the scratch dir, never logged unredacted, never committed; the harness prints items through the redactor |
| Reading "the seam acts on `r.verdict`" (Stage 3 spec) against "raw drives" (Stage 3 code) | ruling R1, stated; a follow-up reconciles the Stage 3 spec text |
| The digest and `/status` gain `· approval.bind N` / `· secret.redact N` count lines | expected (Stage 3 added its rows the same way); the only visible change; named in the ship report |

## Decision needed (Paco, at the spec tap)

1. **Does `approval.bind` absorb Stage 4A's standing case?** Today a standing use is recorded by `tool.policy` v3 (`standing` / `standing_mismatch`) and authorised by the sink CAS; the CAS's specific refusal code (`schedule_mismatch`, `expired`, `already_used`, …) is dropped (`capability-runner.ts:232`).
   - **A (recommended) — keep 4A as approved:** `approval.bind` records the consume only. You approved Stage 4A Rev 4 with this line, and its ADR amendment (drafted, awaiting your signature) says it; absorbing the case would re-mean §8.3's "B14 gains one case" a second time and move a call site inside the runner's policy order. The dropped code becomes a follow-up (a `tool.policy` v4 reason, or a ledger field).
   - **B — `approval.bind` also records the standing CAS** with its refusal code (a second call site in `authoriseStanding`; `tool.policy` keeps its row). Costs one more call site and an edit to the unsigned 4A amendment.
2. **Does `approval.bind` cover the tap's binding (chat, requester, pending/expiry at resolve)?**
   - **A (recommended) — consume only:** the consume is what authorises execution and is B14 as inventoried; the resolve already leaves `processed_triggers` rows and `approval_resolved` events; one call site.
   - **B — also the resolve side:** a second call site inside `processApprovalTrigger`'s raw `BEGIN IMMEDIATE`, where the intake must never throw (a throw wedges the poll loop, kill switch included); rows for `APPROVAL_CHAT_MISMATCH` etc.
3. **How wide is `secret.redact`?**
   - **A (recommended) — E8 as inventoried:** the three report wrappers through `truncateForChat` (R1a–c). Smallest change, no path from the recorder's own failure back into the seam.
   - **B — every ADR 0015 seam in the store:** also the ledger append (R2), the approval cards (R3) and `redactSecretValues` (R4). Needs a re-entrancy guard (the recorder's incident path appends a ledger event through R2 — a monitor observing its own output), adds a `decideSync` to all ~6,200 monthly ledger appends, and R4 is the judge redactor's first step, which ADR 0030 decision 12 already governs. The core-worker cards (R5) would still be outside unless routed through the store (byte-identical in production, where store and worker share one broker — §2.2 — but not in tests that build them apart).

## Rulings in this Rev (overturnable by review)

- **R1 — raw drives, the entry records.** As Stage 3's code does: the call site branches on the sink's result / the redactor's output; `r.verdict` is never a second decision. Identical by construction while the rule is total; a thrown rule records `fail` and changes nothing.
- **R2 — a throwing sink writes no bind row** and propagates as today.
- `approval.bind` is `alwaysRecord`; `secret.redact` records only `masked`.
- Reason codes are a closed snake_case union with a fixed map (tool-policy precedent), not the sinks' raw strings.
- `secret.redact` decides only when the firewall is armed; firewall-off stays row-free (move, don't improve; "unarmed" visibility is a follow-up).
- The store's recorder is an injected factory (no run-time import of `record.ts` from `run-store.ts`).
- The command/path differential base is `548cb87`, not `1451a66`, so Stage 3's wiring is compared too.
- Follow-ups recorded, not built: the run-level sink's missing expiry and `changes` checks (P7, eval-only path); object keys unmasked in ledger payloads (R2); approval-prompt `action_summary` stored unredacted (R3); the Stage 3 spec's invariant-1 wording; the standing CAS refusal code (Decision 1-A).
