# Mandate and follow-up — why a run was allowed, and where later input goes

**Rev 0.1 · 2026-11-11 · status: DRAFT for design review by a separate Claude session.** Not reviewed by
spec-review-senior or codex yet. No code until every BLOCKER is closed and Paco approves.

- **Origin:** the comparison of Houge with `deepseek-ai/dsh-superagent-prototype` (MIT, research prototype released
  2026-10-31), Paco in chat 2026-11-11: "go ahead with the Houge spec for mandate + PR follow-up". Its domain model
  is in that repo's `docs/001-domain.md`, `002-authorization.md`, `003-execution.md`.
- **Brainstorming skipped:** scope came from that chat. **This spec reframes part of it**: Houge has no
  pull-request seam (§2), so "PR follow-up" becomes "follow-up on work Houge sent to Paco", with GitHub as a later
  Source. Decision F1 lets Paco drop the follow-up half.
- **Fits after:** grow zone 1a (approved 2026-11-10, being built). The Mandate is designed to be the record that
  1b's `delegate` and slice 2's async jobs carry. It is not a retrofit for its own sake.

## 1. Why

Delegation (1b) and standing agents (slice 2) create work that runs outside Paco's turn: a child omp process, or a
job that finishes after the turn ended and posts back. Two questions then need code answers, not prompt answers:

1. **Why was this work allowed, and how far may it go?** Today a run's `contract_json` records *what* it may do
   (actions, budget, approval gates). It does not record *why* it was admitted: who asked through which Source, which
   ladder decisions admitted it, the registry version they ran under, the turn's trust level. A child spawned from a
   turn needs that, so the rule "a child never exceeds its parent" can be checked by code.
2. **When Paco answers a piece of that work later, where does the answer go?** A reply to a job's card today enters
   the front door as a fresh turn in the chat's one planner session. That works for a single conversation. It does
   not work once several jobs post cards: the planner has to guess which job a reply is about, and the job that
   asked never sees the answer.

dsh-superagent answers both with two concepts. **Mandate**: an immutable record of what an accept granted (policy
version, scope, strength, matched rules, requester identity, how the Source received it). **Subscription**: a later
message on a thread reaches the work that owns it, with no re-admission and no new authority.

## 2. The live system this builds on (probed 2026-11-11, read-only, `houge.sqlite`)

| Fact | Value / location |
|---|---|
| Runs, all time | 603, every one `type = 'turn'`, `program = 'turn'`; every one has `contract_json` |
| Contract compiler | `src/contracts/task-contract.ts`: fixed per program; `base` = objective, budget, allowed / forbidden actions, output, approval gates, stop condition, eval hooks; `contract_hash = stableHash(base)` |
| Delegation budget | `max_agent_delegations: 0` in every contract; read nowhere else in `src/` (`grep`) |
| What admitted a run | Not in the contract. `decisions` rows carry `entry_id`, `entry_version`, `run_id` (901 rows over 88 runs); `turn.contract` (v1, rule only) records `compile / restrict / refuse` |
| Registry version | No single value exists; versions live per entry |
| Trust | `turn.trust` levels `clean / untrusted / hostile`, carried by the conversation until `/fresh` (ADR 0034 §8) |
| Protected surface | `src/decisions`, `src/policy`, `src/omp`, `docs/decisions` are protected. **`src/contracts` is not**: a self-write may edit `task-contract.ts` |
| Pull requests | None. Self-write lands a local branch; Paco's [Merge & reload] tap merges it (`src/capabilities/self-write-merge.ts`); push only if `HOUGE_SELFWRITE_PUSH` (default off); a planner `git push` is `external_write` (`src/omp/command-matcher.ts:119`). ADR 0023 (external repos) is dormant since 2026-09-30 |
| Reply → run mapping | `RunStore.resolveQuotedTurn` (`src/run/run-store.ts:2167`): `notification_outbox.provider_message_id = 'telegram:<id>'` → `run_id`. Only a `final_report` resolves; evolution reports and cards do not |
| Quote use | `chat_turns.quoted_turn_id`: **0 of 108 user turns** since the column landed (2026-10-09). Either Paco never replies-to, or resolution misses. Probe P1 below |
| Approvals | Bound to `run_id` + `action_fingerprint`; standing approvals bound to `schedule_id` + `chat_id` + fingerprint |

### 2.1 dsh → Houge mapping

| dsh | Houge today | Gap |
|---|---|---|
| Source / Trigger | Trigger Adapter / Typed Task Event (Telegram, schedule, CLI; mail poller) | none |
| Eval (gate + assessment) | front door + decision ladder | none |
| Ticket | Run, but one run = one turn | work that spans turns has no row |
| Mandate | Task Contract (≈70%: scope, budget, gates) | admission facts, registry version, trust, parent link, immutability rule |
| Assignment / Executor | `PlannerSupervisor`; 1b's `delegate` child | none for this spec |
| Subscription | the chat's one omp transcript | no routing to a specific owning run |
| Policy version | per-entry `version` | no pinned aggregate |

**Rejected:** adopting dsh's vocabulary or adding Ticket, Thread, Subscription as new Houge concepts (AGENTS.md:
few concepts; CONTEXT.md terms stand). Mandate becomes a part of the Task Contract, not a sibling table.

## 3. Decisions for Paco

| Id | Question | Options | Recommendation |
|---|---|---|---|
| **M1** | Where does the Mandate live? | **A** a new `admission` + `parent` block inside the compiled Task Contract, hashed with it. **B** a separate `mandates` table referencing `run_id` | **A**: one concept, one hash, already stored on every run |
| **M2** | Which code owns the rule? | **A** the authority half (admission block, MD1–MD6 checks) is a plain-code module in protected `src/decisions/` (or `src/policy/`), **not a ladder entry**: a subset check is mechanics, and no outcome can show it wrong (ADR 0034 §1). `turn.contract` keeps the one verdict that is a decision (admit / refuse); the Task Contract module stays the compiler. **B** add `src/contracts` to `PROTECTED_DIRS` | **A**: code owns the gate in protected code, and program contracts stay editable by self-write |
| **M3** | When does it ship? | **A** with 1b `delegate` (first consumer). **B** now, before 1b, on turns only | **A**: a Mandate nobody reads is dead weight; 1b's leaf rules need it on day one |
| **F1** | Follow-up | **A** reframed (§5): a Paco reply to a message a run sent reaches that run's Mandate. **B** drop; Mandate only. **C** wait for a GitHub Source (ADR 0023 P3) and build dsh's PR follow-up then | **A**, scheduled with slice 2 (async jobs), since only async work needs it |

## 4. Slice M — the Mandate

### 4.1 Fields (added to `CompiledTaskContract`)

```ts
interface Admission {
  source: "telegram" | "schedule" | "cli" | "delegate" | "job";   // the Typed Task Event source; delegate/job widen TypedTaskEvent (src/domain/types.ts)
  requester: string;            // identity as the Source gave it (Telegram user id, schedule id, parent run id)
  trigger_ref: string;          // the event's idempotency key
  decision_ids: string[];       // the `decisions` rows that admitted it (turn.contract, turn.handler, …)
  registry_version: string;     // stableHash of the sorted `entry_id:version` list at admission
  trust: "clean" | "untrusted" | "hostile";   // turn.trust at admission
  strength: "explicit" | "inferred";          // explicit = Paco's own message or tap; inferred = schedule, job, mail rule
}
interface MandateBlock { admission: Admission; parent: { run_id: string; contract_hash: string } | null }
```

`contract_hash` covers `base` plus `MandateBlock`. `registry_version` is computed once per boot from the live
registry (code, no I/O) and logged at boot.

### 4.2 Rules (code-owned; each gets a `tests/adr/0034-<id>` test)

- **MD1 Immutable.** A Mandate is written once with the run row. No code path updates `contract_json` after insert
  (grep target: `UPDATE runs SET contract_json`).
- **MD2 Wider scope is a new run.** A run may not gain an action, lose a gate, or raise a budget. A request beyond
  scope goes back through the front door as new work.
- **MD3 A child never exceeds its parent.** For a `delegate` or `job` run: `allowed ⊆ parent.allowed`,
  `forbidden ⊇ parent.forbidden`, `approval_gates ⊇ parent.approval_gates`, budget ≤ parent's remaining (read from the live budget ledger, `src/budget/`, not from the parent contract),
  `max_agent_delegations = parent − 1` (a leaf is 0). Checked before the child process starts; a violation refuses
  the spawn with a fixed code, never trims silently.
- **MD4 Trust only tightens.** A child's `admission.trust` ≥ parent's level (clean < untrusted < hostile). With
  grow-zone P2-C this keeps outside-derived text from regaining trust through a child.
- **MD5 Strength does not inflate.** An `inferred` parent yields `inferred` children. Only Paco's own message or
  tap is `explicit`. Anything gated on `explicit` (§5) checks this field, not prose.
- **MD6 Revalidate before resume (slice F).** Before a stored run takes new input, its `registry_version` is
  compared with the live one. Equal: proceed. Different: re-run only the entries whose version changed against the
  stored admission facts; a verdict that no longer admits ends the run as `revoked` with a `/changes` line. dsh's
  "a policy change is delivered, not a kill" applies to running work: a live child is not killed on a registry
  change; it finishes under its Mandate and the change is recorded.

### 4.3 What it costs

- One migration: none (the block rides in `contract_json`). Old rows lack it; readers treat a missing block as
  `{ source: run.source, strength: "explicit", parent: null }` only for display, never for MD3–MD6.
- Ledger: one `mandate.admitted` event per run with the hash, never the requester's raw text.
- hyjj tie (no code dependency): the block is the "instruction → authorization → action → principal" record that
  huoyanjinjing's capture wants; MD3 is its roadmap rule "a child may never exceed its parent's scope".

## 5. Slice F — follow-up on work Houge sent (F1 = A)

**Problem:** with async jobs, several runs may each have a card or question in Paco's chat. Paco answers one by
Telegram reply.

**Rule:** a Telegram reply whose `reply_to_message_id` maps (through `notification_outbox`) to a message an
**open-for-follow-up** run sent reaches that run, under its Mandate, with no front-door admission. Everything else
is a normal turn.

- **Open for follow-up:** a run that asked a question, posted a card, or reported `ready`, until it ends plus 14
  days (dsh uses two weeks), or Paco stops it. Turn runs are never open: the chat transcript already serves them.
- **Mapping:** extend `resolveQuotedTurn`'s outbox lookup to any intent type the owning run marks as
  follow-up-able, not only `final_report`.
- **No new authority:** the reply runs inside the owner's Mandate (MD2). A reply asking for more is handed back to
  the front door once, with one line to Paco ("that is new work; started it as a turn").
- **Stop wins:** a reply that the ladder reads as stop (existing `turn.settle` / stop handling) ends the owner run
  even though admission is skipped.
- **Revalidate:** MD6 runs before the owner takes the reply.
- **Not subscribed:** non-Paco input (mail, schedules, CI) never reaches an owner run this way. When a GitHub Source
  exists (ADR 0023 P3), its PR comments become one more mapping into the same rule; that is out of scope here.

## 6. ADRs touched

| ADR | Change | Tier |
|---|---|---|
| 0034 | New rules MD1–MD6 under §1/§4 (plain code, no new entry); trust carry extended to children (MD4) | C (meaning) |
| 0035 (grow zone, with 1a) | "delegated children never write the zone" becomes checkable via `admission.source` | wording |
| 0032 | 1b `delegate` spawns only with a passing MD3 | wording, lands with 1b |
| 0031 | a reply routed to an owner run, and a `revoked` run, are `/changes` lines, not pushes | wording |
| 0011, 0023 | cited, not changed | — |

CONTEXT.md: extend **Task Contract** with "carries a Mandate: the admission facts and parent link that say why the
run may exist"; add **Mandate** as a term. No new env var in slice M. Slice F may add
`HOUGE_FOLLOWUP_DAYS` (default 14) — or hard-code it (AGENTS.md: fewer settings); reviewer's call.

## 7. Testing and live gate

- Hermetic: MD1–MD5 as `tests/adr/0034-md<n>-*.test.ts`; a child-spawn test that a wider child is refused, not
  trimmed; a registry-version change test for MD6 with one entry bumped.
- Live gate (`scripts/live-gate-mandate.mjs`, with 1b): one real `delegate` from a real turn. **PASS** only if the
  child row's Mandate names the parent's hash, its allowed set is a strict subset, a planted over-wide child is
  refused with the fixed code, and the ledger has exactly one `mandate.admitted` per run. A child that ran without
  a Mandate block is a FAIL even if its answer was right.
- Slice F gate (with slice 2): two async runs post cards; Paco replies to the second; PASS only if the second run
  takes the reply and the first does not, and a beyond-scope reply opens a new turn with the one-line notice.

## 8. Probes for the reviewer (live system, read-only)

- **P1** Why is `quoted_turn_id` empty on all 108 user turns since 2026-10-09? Replay one Telegram reply through
  `resolveQuotedTurn` on a DB copy. If resolution is broken, slice F starts with that fix.
- **P2** Is `turn.contract` the right decision to carry admission, or should `turn.handler` (which already decides
  the route) supply the `decision_ids`? Join `decisions` on `run_id` for a week of runs.
- **P3** Can a `registry_version` hash be computed without importing every entry at boot (startup cost)?
- **P4** Does any path today build a run without `compileTaskContract` (self-write, skill job, mail triage)? Each
  one needs an admission source or an explicit exemption.

## 9. Questions for the design review

1. Is "Mandate inside the Task Contract" (M1-A) the right cut, or does the immutable admission record deserve its
   own row because the contract's program half changes with code?
2. MD6 re-runs only changed entries. Is that sound when an entry's *inputs* (e.g. Paco's allowed list) change
   without a version bump?
3. Slice F: is a reply-mapping rule enough, or will Paco also need an explicit `/to <run>` for non-reply answers?
4. Does skipping admission for follow-ups open a path around `turn.trust`? (Proposed: the reply turn's own trust
   is computed as usual and MD4 applies, so a hostile reply still tightens.)
5. Is anything here dsh-shaped (team, many requesters) that a single-operator Houge does not need? `strength` is
   the candidate: with one human, it may reduce to "Paco vs not Paco".

## 10. Change log

- **Rev 0.1 (2026-11-11):** first draft from the dsh-superagent comparison; PR follow-up reframed (no PR seam).
