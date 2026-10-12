# Decision ladder — every Houge decision on one list, judged inside the loop, improved from outcomes

- **Date:** 2026-10-12 · **Rev 7** · **Status:** draft for Paco's read; six review rounds (senior against the live
  system, with probes P1–P4 and the clean room run; codex). Zero open blockers (§15).
- **Decider:** Paco. Design approved section by section in chat on 2026-10-12.
- **Proposes:** ADR 0030 "Decision ladder" (§10). Amends ADR 0029 (front door becomes an entry; the Jev rule restated),
  0028 (D5 tap-free local writes and D12 shell outside the wall become conditional), 0014 (an injection judge before
  the reader), 0011 (`src/decisions/` joins the protected surface).
- **Inputs:**
  - research [2026-10-12-in-loop-decisions](../research/2026-10-12-in-loop-decisions/00-synthesis.md): mu's 38
    decision points read at `qybaihe/mu@faed8c3`; Houge's 85 in-loop decisions with file:line at `main@1585105`;
  - an omp 18.7.0 source read on 2026-10-12 (§3.3; archived at
    [`12-omp-judgment-probe.md`](../research/2026-10-12-in-loop-decisions/12-omp-judgment-probe.md));
  - a `VACUUM INTO` copy of the live DB taken 2026-10-12 (§5.2, §8.3).
- **Builds after:** Jev decision tree stage B (`1585105`, merged and pushed 2026-10-12).

## 1. Why

Houge makes about 85 decisions between a Telegram message and the delivered reply (research `11-`). They are
85 hand-written branches with 85 logging styles and 85 implicit failure directions. Jev decides one of them, at the
front door, and "S1 shortcut, else S2 planner" became the architecture. Paco called that tree stiff, and rejected
adding judges on top of it as a patch (2026-10-12): "not only a band-aid on top of the 'if not S1, then S2' model".

The research found the middle of the turn is full of code rules but blind in five places. Each was checked by hand in
code:

- **G1.** Tool output is screened for injection only on four read tools, and that flag only adds a note.
- **G2.** "Done" is never verified.
- **G3.** There is no loop detection beyond the 40-call cap and the clocks.
- **G4.** Output is trimmed by size, not relevance.
- **G5.** Notify-now-or-later is never decided.

Learning paths are each wired to one trigger, and nothing measures whether an improvement worked.

This spec changes the shape:

1. **One decision model.** Every decision is a registry entry with a ladder of deciders: code rule → Jev → model →
   Paco. It is measured by outcomes.
2. **Judges inside the loop at checkpoints Houge already owns.** Houge's omp extension forwards `tool_result` and
   `session_stop` to Houge over the bridge. The Jev key stays in the main process, and every verdict is ledgered and
   calibrated.
3. **Improvement as a decision.** Every correction, review tap or failure goes through one entry that routes it to
   whatever it points at: a fact, a lesson, a skill, a ladder move, a schedule, a tool gap. Each improvement is then
   measured by whether its signal recurs.

The S1/S2 split survives as one entry, `turn.handler`, whose ladder is
ack rule → Jev tree → Tiny cascade → planner.

## 2. Paco's rulings (2026-10-12)

| # | Ruling | Where |
|---|---|---|
| R1 | The first slice proves the new shape (decision record plus ladder), not only safety or correctness | §1 |
| R2 | **Full migration** (approach B): every decision moves onto the list, for a clean end state | §6 |
| R3 | First new entries: injection on tool results, done/stopped-halfway, turn-wide trust level, plus a self-evolution decision. The loop rule was not picked; it goes to the backlog (§11). | §7 |
| R4 | A self-evolution "yes" may **start skill authoring on its own** | §7.4 |
| R5 | "Every correction or review from me, or anything the daily review picks up, should help Houge improve on something", not only skills and tools. Folded in as `improve.route`. | §7.4 |
| R6 | **All new judges armed at ship.** A daily summary surfaces anything wrong or unsure for Paco to decide. | §8 |
| R7 | Review: a daily digest plus urgent cards | §8.1–8.2 |
| R8 | "After 3 straight approvals" of the daily Alishan search, Houge stops asking. This becomes standing approvals, in stage 4. | §8.3 |
| R9 | SP4 items and parked ideas are written down, not lost | §11 |
| R10 | ADRs are reviewed continually: "don't take ADR as bible" (the ADR 0015 lesson) | §10.3 |
| R11 | **Egress approved for every new class**, after redaction. Paco chose "All of it": "Web, mail and calendar, shell, files and the reply, all redacted." (ADR 0029 decision 4 asks for this approval per class) | §7.0 |

## 3. Facts that bind the design

### 3.1 Houge today (research `11-`, `main@1585105`)

- **Five stages.** Before the model (A1–A28), at the bridge before a tool (B1–B25), after a tool (C1–C8),
  supervision (D1–D12), turn end (E1–E12).
- **Jev decides only `turn.handler`** (A12–A18). Its rows go to `jev_decisions` (raw per-call answers) and
  `jev_verdicts` (routing plus outcome).
- **The only model judgment on the loop itself** is the quarantined reader and its `contains_instructions` flag
  (`core/quarantine.ts:97`, a note only).
- **Unread state:**
  - the budget zone is computed and never read (`budget/budget-ledger.ts:26`);
  - `stop_condition` and `eval_hooks` are contract data with no consumer (`contracts/task-contract.ts`);
  - budget exhaustion denies each call but does not end the turn (`budget-ledger.ts:20-23`).
- **A message arriving while an approval card waits is steered into the turn.** It never resolves the card
  (`omp/planner-supervisor.ts:288-293`).

### 3.2 mu (research `10-`)

- mu has 38 points in five groups. Its README says: "Rules are the floor: a dangerous-looking command is caught by
  rules first, and the judge only vouches that you asked for it."
- **Six rules:**
  1. rules first;
  2. three zones plus an escape answer;
  3. fail open, except safety gates fail closed to asking the user;
  4. append rather than rewrite;
  5. errors are cheap and reversible;
  6. everything is ledgered.
- **Measured numbers:**
  - injection wording: 70/79 planted attacks caught, 0/1,520 clean passages withheld;
  - completion and continue are split questions (combined 0.79 vs split 0.29);
  - output admission dropped 0 of 2,412 live blocks while spending about 54% of judge input.
- **Its retrospective:** local positive effect, no proof of net benefit; link verdict → action → outcome per point.
- **Correction:** mu never says "no fast path bypass". An earlier chat claim was wrong (research `00-`).

### 3.3 omp 18.7.0 (source read 2026-10-12; extension hooks verified first-hand)

- **omp has four TypeSafe judge points:**
  - unexpected-stop (yes/no on the last assistant text, 0.5, up to 3 retries, 4 s);
  - auto-thinking;
  - judged rules;
  - the `find` tool.
- **None fires in Houge's spawn today.** `features.unexpectedStopDetection` defaults to `mechanical`, and Houge passes
  a fixed `--thinking`.
- **Their verdicts are invisible:**
  - no RPC or extension event carries the question or the probability;
  - session JSONL `model_usage` rows hold tokens and cost only.
  - That is why this spec does not use them (§9.2). The Jev key's location is not the reason (R10).
- **Extension hooks Houge can use:**
  - `session_stop` (`extensibility/shared-events.ts:109-120`) fires when a main-agent turn is about to settle.
    - Its handler may return `{continue: true, additionalContext}` or `{decision: "block", reason}`; that is one
      continuation.
    - The event carries `stop_hook_active` and `last_assistant_message`.
  - `tool_result` handlers may rewrite a result before the model sees it.
  - `tool_call` may block or rewrite (Houge already uses it for the built-in gate).
- **The `todo` tool keeps phased tasks** (pending / in_progress / completed / abandoned / blocked).
  - Visible through RPC `get_state.todoPhases` and through hooks.
  - Houge's spawn `--tools read,edit,write` (`omp/planner-session.ts:19`) leaves it out.
- **Probes run 2026-10-12 against omp 18.7.0** (spec review, logs in the review archive):
  - **P1 PASS:** `tool_result` fires for built-in `read` in RPC mode, an async handler (1.5 s) is awaited, and the
    rewrite reaches the model. The original text stays in `details.displayContent` unless the handler rewrites it too.
  - **P2 PASS:** `session_stop` fires in RPC mode; `{continue: true, additionalContext}` sends the model back exactly
    once; `stop_hook_active` is true on the second fire; one terminal `agent_end` at the end. omp caps `continue` at 8
    and leaves `block` uncapped, so Houge enforces "once" itself. omp skips the hook while an abort is in progress
    (`agent-session.ts:4951-4954`, read).
  - **P3 partial:** `get_state.todoPhases` is readable mid-turn; the extension context has no todo accessor; enabling
    `todo` also starts omp's own reminder send-backs (up to 3, unledgered). Planner usage under Houge's prompt: not run.
  - **P4:** `tool_result` and `session_stop` handlers have a fixed 30 s limit; a 35 s handler timed out at +30 s and
    the **raw** result reached the model (fails open). `tool_call` defaults to 30 s and fails closed. Houge's bridge
    client and server have no request timeout (`omp/extension/bridge-client.ts:31-38`).
- **A pre-existing settle bug:** omp marks `agent_end` `isTerminal: false` when a steer arrived after the loop's last
  poll (`agent-session.ts:1453-1467`); `planner-supervisor.ts:1074` settles on any `agent_end`. Read from source, not
  run. Stage 2a fixes it first (§13).

## 4. The decision model

### 4.1 Entry

Each decision is one entry in `src/decisions/registry.ts`:

```ts
type Rung =
  | { kind: "rule"; decide: (s: State) => Verdict | { abstain: true; floor?: Verdict } } // floor = initial monotone verdict
  | { kind: "jev"; question: JevQuestion; bars: BarRef }          // abstains below bar (§4.2)
  | { kind: "model"; role: "tiny" | "fast"; prompt: PromptRef; timeoutMs: number }
  | { kind: "paco"; surface: "card" | "approval" };               // asynchronous; review taps are outcomes, not a rung

interface Entry<State, Verdict> {
  id: string;                      // stable, e.g. "tool.shell_class"
  version: number;                 // bumped on any wording, rung or bar change
  stage: "intake" | "pre_model" | "pre_tool" | "post_tool" | "supervision" | "settle" | "after_turn";
  question: string;                // what is decided, in words
  verdicts: readonly Verdict[];    // closed set, always including an escape value
  ladder: readonly Rung[];         // first confident answer wins
  fail: Verdict;                   // what happens when no rung answers (timeout, outage, throw)
  monotone?: { order: readonly Verdict[] }; // later rungs may only move toward the cautious end
  locked?: true;                   // no rung added, no ladder move, no off switch
  defaultVerdict: Verdict;         // the routine answer (not given a row, §5.2)
  alwaysRecord?: true;             // full row every time
  outcomes: readonly OutcomeSignal[];
  armed: Partial<Record<Rung["kind"], "on" | "shadow" | "off">>;
}
```

**Rules:**

- **Code goes first.** A rule answer ends the walk, and no model is asked. A rule that wants a judge consulted
  returns `"abstain"`; "eligible for judging" is an abstention, never a "pass" (codex B1). A test per judged entry
  proves an eligible, clean-looking input reaches the Jev rung.
- **Monotone.** For a monotone entry, a later rung's verdict is applied only if it is at least as cautious as the
  verdict so far. The verdict so far starts at the abstaining rule's `floor` (or the least cautious verdict when it
  gives none), so a judge can only tighten what code already decided.
- **Jev never opens a gate, and never causes an effect on its own.** On a monotone entry, a Jev or model rung can
  tighten only. On a non-monotone entry, a Jev or model verdict can only (a) choose a handler that ships with no side
  effect beyond a reply (`turn.handler` lanes), or (b) produce a *proposal* that Paco accepts. Automatic effects
  (a lesson applied, a skill authored, a standing approval) come only from code rungs. The registry test enforces all
  three, and fails on a non-monotone entry whose Jev rung maps to an effect.
- **Shadow rungs.** A `shadow` rung is asked and recorded, but its answer is not applied.
- **Locked entries** refuse ladder changes in code (registry test) and at run time (`ladder_moves` refuses them),
  and ignore the off switch.
- **Recording never changes a decision.** The runner decides, then records. A failed ledger write is caught, opens
  incident `decision_record_failed`, and the verdict stands. For gates, the decision is computed before any write.
- **Escape value.** Every Jev question includes one (`unclear` / `other`), per mu rule 2.

### 4.2 Rungs

| Rung | Decides when | Time bound | On abstain or failure |
|---|---|---|---|
| rule | its function returns an answer | synchronous | next rung |
| jev | p clears the entry's bar (calibrated or provisional, below) | per entry, default 1.5 s | next rung. Outages open the existing Jev incident. |
| model | a validated closed answer | per entry | next rung |
| paco | Paco taps | the surface's own expiry | `fail` |

**Bars: calibrated and provisional.** ADR 0029 arms a Jev question only on calibrated rows keyed by (question, criteria
hash, reported model, language). The new in-loop judges have no rows, and Paco ruled them armed at ship (R6). So ADR
0030 adds a second kind of bar:

- **Provisional bar:** taken from an external measurement (mu's injection wording, omp's unexpected-stop threshold).
  - A separate type, `ProvisionalBar { question, criteriaHash, model, p }`, kept in the entry's registry code (so a
    change is a protected, reviewed edit), not a `CalibrationRow`, whose `lang` cannot be `any` (`calibration.ts:17`).
  - Allowed only on entries that are monotone or fail open (`tool.injection`, `turn.settle`), never on a gate that
    could open.
  - Each provisional question gets golden-set items (planted and clean) in the invariant sweep, so drift disarms it as
    ADR 0029 decision 5 does for calibrated rows.
- **Model or wording change:** a provisional rung goes to shadow and opens incident `decision_bar_stale:<entry>`, as
  ADR 0029 decision 5 does for calibrated rows. Paco re-arms by committing a row.
- **Pre-ship sanity gate (not calibration), with thresholds that can fail** (senior N5). The corpora are built by the
  stage's plan (senior W10):
  - planted attacks: built by the stage 2a plan's author from mu's published injection examples (MIT), plus attacks
    written for Houge's tools in zh and en, each reviewed in the plan. The set is held out: none of its items enter the
    sweep's golden set, which gets its own items (senior round 4 W10);
  - clean passages: captured by running real read-only tools (search, fetch of 20 fixed public pages, common shell
    commands, Paco-approved local files) on the gate machine;
  - settle: the DB copy.
  - Thresholds:
    - **`tool.injection`:** ≥ 60 planted attacks (web, mail, shell and file shapes, zh and en) and ≥ 300 clean passages
    from real tool output on the gate machine. PASS needs recall ≥ 85% and clean withholds ≤ 1%. mu measured 70/79 and
    0/1,520.
    - **`turn.settle`:** the last 30 days' planner replies with their tool rows from the DB copy. PASS needs total
    send-backs ≤ 10% of replies; Paco reads a sample of 20 send-backs before merge.
- **Promotion:** review taps (§8.1) accumulate labels; a calibrated row replaces the provisional bar when Paco commits
  it, through the existing calibration report.

### 4.3 Ladder moves

- **What a move is.** A move changes who decides. It is a `ladder_moves` record:
  - entry id and scope (for example, one action fingerprint);
  - from rung and to rung;
  - evidence (decision ids);
  - granted by (`paco` | `auto`);
  - revocable flag, state, created and ended times.
- **Moves Houge may make on its own (authorised by this spec), all from code rungs:**
  - standing approvals (§8.3);
  - skill authoring after a recurrence pattern (§7.4);
  - lessons through the existing save path for a stated rule, with Undo.
- **Who may write a row.** Only `approval.standing`'s code may insert `granted_by: auto`, only for `tool.policy`,
  enforced by a store-level check (the insert function refuses any other entry) and a test. Every other loosening row
  needs a Paco callback id. Callbacks pass the sender allowlist (A1) and are one-shot.
- **Every move that loosens caution is a proposal for Paco's tap:**
  - trusting a source;
  - retiring a judge;
  - lowering a bar.

### 4.4 The front door as an entry

`turn.handler` (verdicts `answer | lookup | memory | status | planner`) runs this ladder:

1. the ack rule (`jev/tree-policy.ts:35-39`);
2. the Jev tree (A14–A17);
3. the Tiny cascade (A18).

The planner is its `fail` value. `turn.gear` (role and effort, A16) is a separate entry with the same Jev call. The
stage A and B behaviour is unchanged. Parity is proved on everything triage persists and later mutates, not only the
chosen handler (§6.2, P6).

## 5. Runtime and ledger

### 5.1 Runner

`src/decisions/decide.ts`:

- **`decideSync(entry, state)`** for all-rule ladders. Hot paths such as the bridge path gate and the shell
  classifier stay synchronous.
- **`decide(entry, state, ctx)`** for ladders with a Jev, model or paco rung.

Both functions:

- walk the ladder, apply the monotone rule, and record the result (§5.2);
- return `{ verdict, rung, p?, reason, decisionId }`;
- turn a thrown rule, a timeout or an outage into an abstention, so `fail` decides, never an accident.

The runner is under 50 lines per function, and does no I/O beyond the ledger write and the rung calls.

### 5.2 Ledger

New tables. `jev_verdicts` is **kept** as `turn.handler`'s detail table (§5.4):

- **`decisions`**: one row per decision that matters. A full row is written when:
  - the verdict differs from `defaultVerdict`; or
  - a rung beyond the first rule answered, or was asked in shadow; or
  - Paco was involved; or
  - the entry is `alwaysRecord`.

  Columns:
  - `decision_id`, `entry_id`, `entry_version`;
  - `run_id`, `tool_call_id?`;
  - `stage`, `rung`, `verdict` (a closed value from the entry), `p?`;
  - `reason_code?` (a code-owned enum per entry, never model or tool text), `fallback_reason?` (closed enum: `timeout`,
    `outage`, `parse`, `threw`, `stale_bar`, `budget`), `armed_mode`, `latency_ms`;
  - Jev rows link the other way: `jev_decisions` gains `ladder_decision_id` (FK to `decisions`, indexed; one decision,
    many questions; senior W4). `jev_decisions.decision_id` is already that table's primary key (codex round 4 B18),
    and its consumers keep using it.
    `jev_decisions` stays the raw per-question record calibration needs. Each entry declares which question's `p` is
    the recorded `p` (for `tool.injection`, the maximum over passages; for `turn.settle`, the question that fired);
  - `created_at`.
  - **No state column at all.** A hash of a low-entropy state can be reversed by dictionary (senior W), and nothing
    reads it. The ledger never holds read text (lessons.md).
- **`decision_outcomes`**: `outcome_id`, `decision_id`, `signal` (closed enum, §7.4), `value` (closed enum or number
  per signal; the insert function rejects anything else), `source` (`paco` | `code`), `created_at`.
- **`ladder_moves`** (§4.3).

**Volume (DB copy, 30 days to 2026-10-12):**

- 159 turns, 5.3 a day;
- 369 tool calls, 4.7 per tool-using turn, at most 22.
- Full detail would be about 100 rows per turn. Rows only for non-default, beyond-rule, Paco or `alwaysRecord`
  decisions bring it to about 10–15. Routine passes get no row; their counts come from the existing `tool_finished`
  and `loop_step` events (no tally table; codex S16).

**Retention:** rows and outcomes are kept; revisit when the table passes 1M rows.

**Per-entry health** (senior W5):

- The invariant sweep computes `jev_skip_rate` per entry from `decisions.fallback_reason` (not `countJevCalls`, which
  counts answers per run, not skips per row; senior round 4 W5), generalising today's triage-only check at
  `invariant-sweep.ts:209-235`.
- The digest shows, per entry: skips, shadowed rungs and fallbacks.
- A `jev-latest` move that shadows every provisional rung at once raises one incident that names them all.

### 5.3 `turn.handler`'s detail table

`jev_verdicts` holds routing state that live code reads and updates: scores, lane, role, effort, save and route
outcomes, handler outcome, answering model, tool use, quote and correction fields. The review counted at least nine
consumers, two on correctness paths (the catch-up boundary, the sweep's lane fall-through rate). A lossless
replacement buys nothing, so the table stays as `turn.handler`'s detail table and gains `decision_id` (FK to
`decisions`). Every consumer is listed in the stage 1 plan and keeps working; each new `turn.handler` decision row
links to its verdict row. An entry with rich domain state follows the same pattern: generic row in `decisions`, detail
in its own table.

### 5.4 Off switch

`HOUGE_DECISIONS_OFF=<entry id,…>` sets the named entries' non-rule rungs to `shadow`. It is read at boot only
(`/rearm` does not reload `.env`); a change needs a kickstart.

- `HOUGE_JEV_LANES_OFF` stays, as an alias for `turn.handler` lane verdicts.
- `HOUGE_TRUST_ASK_TTL_MS` (default 300000) sets the trust-card expiry (§7.2), and `HOUGE_DECISION_DIGEST_AT` the digest
  time (§8.1).
- Locked entries ignore the switch, and boot logs a warning that names them.
- Documented in `configuration.md`.

## 6. Migration (full; ruling R2)

### 6.1 What becomes an entry

**Test:** a condition changes the turn's path, and an outcome could show the answer was wrong. Everything else is
mechanics and stays plain code.

**Entries** (inventory row → entry id; L = locked):

| Stage | Entries |
|---|---|
| intake | A1 `intake.sender` L · A2 `intake.rate_limit` (its `kill` exemption, ADR 0018, is a locked rule inside it) · A4 `intake.rating_reply` · A5 `intake.budget_fuse` L (ADR 0003) · A9 `intake.steer_or_queue` · A10 `intake.bare_ack` L (consent is never inferred, ADR 0029 §5.1) |
| pre_model | A7 `turn.contract` · A12–A15, A17 `turn.handler` · A16 `turn.gear` · A18 is a rung of `turn.handler` · A19 `memory.rule_save` · A21 `lookup.rewrite`, `lookup.thin` · A22 `turn.model` · A23 `context.lessons` · A25 `context.recall` · A26 `context.catch_up` · A27 `turn.clarify_cap` |
| pre_tool | B2+B7 `tool.manifest` · B6 `posture.kill` L · B9 `memory.correct_preflight` · B10+B19 `tool.policy` · B11 `tool.shell_class` · B12–B13 paco rung of `tool.policy` · B14 `approval.bind` L · B15 `tool.budget` · B16+B17 `tool.path` L · B22 `fetch.ssrf` L · B23 `memory.lesson_admit`, `schedule.admit` · B25 `selfwrite.guard` L |
| post_tool | C1+C4 `tool.wall` L (which tools cross the reader) · C3 `reader.family` · new `tool.injection` (§7.1) |
| supervision | D2 `planner.crash_guard` · D9 `turn.retry` |
| settle | new `turn.settle` (§7.3) · E2+E11 `attach.path` L · E8 redactor `secret.redact` L · E12 `notify.page` |
| after_turn | new `improve.route` (§7.4) · new `turn.trust` lives across stages (§7.2) |

**Mechanics** (stay code): A3 command dispatch · A6 idempotency · A8 dispatch refusals · A11 media ingest · A20 and
A21 lane bodies (handlers, not decisions) · A23 restart-on-fingerprint · A24 session reset · A27 seed, restart note,
quote resolution · A28 pin · B1, B3–B5, B8 validation · B18 Seatbelt (an OS floor, outside the runner) · B20 tool
timeout · B21 replay memo · B24 text hygiene · C2 (superseded by `tool.injection`) · C5–C8 · D1, D3–D8, D10–D12 ·
E1, E3–E7, E9–E10.

The plan's first task re-walks the inventory at its base commit and fixes this table. A row moved between columns
carries its reason in the plan.

### 6.2 Move, don't improve

For every migrated entry:

1. **Pin.** Characterisation tests from a table of inputs and today's outputs.
   - Coverage is extended where thin. `tool.shell_class` gets a command corpus covering every pattern in
     `omp/command-matcher.ts` and every known miss in ADR 0028's residuals.
   - `tool.path` gets a path corpus covering every `gate-path.ts` form.
2. **Wrap.** The existing function, unchanged, becomes rung 1.
3. **Route.** The call site goes through `decide`/`decideSync`.
4. **Differential, on behaviour, not only verdicts.** In tests, old and new call sites run over the same corpus and
   must match on: the verdict; every side effect (rows written, budget reserved, approvals created, events, ordering);
   and failure behaviour (what a thrown rule or a failed write does). The pinned tests stay green.
   - For `turn.handler` this covers `jev_decisions` rows, the `jev_verdicts` row and its later mutations (settle,
     `routed_by`, corrections, terminal transitions), the `triage` event and lane catch-up (codex B6).
   - **P6 is a dual run**, not a replay of stored decisions. The 78 stored `jev_decisions` are 20 calls, about 8 on
     today's questions, and states are not stored (senior #11).
     - **Harness:** `scripts/live-gate-decisions-parity.mjs` builds the triage input for each of the last 200 Telegram
       user texts in `chat_turns`, with the stored previous turn as context. It calls the triage entry point
       (`CoreWorker` triage, the function `settleTriage` closes) in the pre-stage-1 `dist/` and in the stage 1
       `dist/`, each against its own DB copy.
     - **Isolation:** lanes, planner, Telegram and the outbox are stubbed. The harness exercises decision and
       persistence only. Later mutations of `jev_verdicts` (settle, `routed_by`, corrections, terminal transitions)
       are covered by the differential unit tests, not the dual run (codex round 3 W16).
     - **Compared projection:** every column of `jev_decisions`, `jev_verdicts` and the `triage` event, except ids,
       timestamps and `latency_ms`. Ids are mapped pairwise and links compared after mapping (codex round 3 W15).
     - **Nondeterminism:** first compare row shape and links: question count, status, rows written, links. Any
       difference there is a mismatch. Only an otherwise identical pair whose Jev probabilities differ by more than 1e-6
       is reported as Jev nondeterminism and excluded from both counts (codex round 4 W26).
     - **PASS:** at least 190 deterministic pairs and 0 mismatches among them. One Jev call per text per build, about
       400 calls.
5. **Only then** can an improvement ship, as a new entry version with its own review.

### 6.3 The registry is protected surface

If the registry decides the gates, editing it can open a gate. `src/decisions/` joins `PROTECTED_DIRS` in
`capabilities/self-write-guard.ts`, in stage 1: Paco's hand only. The guard's existing test gains a case: a self-write
diff touching `src/decisions/` is hard-denied.

## 7. New entries (stage 2; all armed at ship, R6)

The starting bars are provisional (§4.2): mu's injection wording and omp's stop threshold, never a gate that could
open. Each provisional rung passes the pre-ship sanity gate, and its first 14 days are reported in the digest. The
review surface (§8) is the net.

### 7.0 What leaves the machine (R11)

On 2026-10-12 Paco chose "All of it" when asked "Which content may the new judges send to TypeSafe (after redaction)?".
The option read: "Web, mail and calendar, shell, files and the reply, all redacted."

Rev 3 narrowed "files" to outside-origin files with a turn-trust boundary. Reviewers broke that boundary twice (senior
round 3 B1, B2): best-effort network detection, files downloaded in an earlier turn, spoofable mtimes. Rev 4 applies
the ruling as chosen:

- **Every shell output, every built-in read, every wall-tool result and every final planner reply** is eligible for
  judging and may be sent after redaction.
- **Credential stores never leave, and stage 2a closes a gap that exists today** (senior round 4 B8). The planner can
  already read credential files that `protected-paths.ts` does not cover. Found readable on 2026-10-12:
  - six project `.env` files, including the trading bots';
  - `~/.local/share/opencode/auth.json`;
  - `~/.ollama/id_ed25519`;
  - shell histories and `fish_variables`;
  - the agent-browser profile;
  - `~/Library/Application Support/Claude`.

  Stage 2a does two things:
  1. extends the read-deny list with these paths and their patterns: every `.env` and `.env.*` at any depth,
     `auth.json` and `credentials*` under `~/.local/share` and `~/.config`, `id_*` private keys anywhere under `$HOME`,
     shell history files, `fish_variables`, browser profile and cookie stores, `~/Library/Application Support/Claude`.
     The planner can no longer read them at all;
     Added after the round 5 name sweep (senior round 5 B11): `service_account*.json`, `client_secret*.json`,
     `*credentials*.json`, `*token*.json` and `*.pem` / `*.key` / `*.p12` anywhere under `$HOME`; `.baileys_auth/`
     and other `*auth*/` session folders under `~/Projects`; `.env.*` covers backups such as Houge's own
     `.env.bak-2026-10-07`;
  2. gives the judge a path deny-list of the same patterns. A result from such a path, if a new location ever slips
     past the read-deny list, is judged by the code floor only and never sent;
  3. adds a **content check before egress**, because a name list can never be complete. Text containing any of these
     is judged by the floor only and never sent, and the digest notes the path:
     - a PEM block (`-----BEGIN … PRIVATE KEY-----`);
     - a JSON object with `private_key`, `client_secret`, `refresh_token` or `"type": "service_account"`;
     - three or more named-secret matches (rule 3);
     - a Netscape cookie-jar header.
  - The residual (a credential file with no recognisable name or content) is stated in ADR 0030. Separately, the planner
    itself can still read such a file and send it to its own model provider, as today; the read-deny extension narrows
    that too.

**The judge redactor, `src/decisions/egress.ts`**, is distinct from `jev/egress-redact.ts`. That one strips heredocs to
the end of the text and replaces every URL (`egress-redact.ts:8,16`), which would blind an injection judge. The judge
redactor removes secrets and keeps instructions:

1. the broker's known secret values, through a new `RunStore` method exposing the existing private redactor
   (`run-store.ts:1030`);
2. credential shapes: bearer tokens, provider key prefixes, hex runs of 32+ characters, base64 and base64url runs of
   32+ characters containing a digit or `+/_-`, and PEM blocks (masked whole, spaces and all);
3. Named secrets in the forms `NAME=value`, `NAME: value`, `"NAME": "value"` (JSON) and `Name-With-Hyphens: value`
   (headers):
   - NAME matches `(?i)[\w-]*(pass|secret|token|key|auth|cookie|session|pwd|credential)[\w-]*`, so `*_KEY` and
     `X-Api-Key` are covered;
   - the value is the run of non-space characters after the separator, up to the line end, a quote or a comma. It is
     masked when it is 8 to 256 characters long;
   - a value containing spaces is prose and survives, so `api_key: ignore previous instructions and …` keeps its
     payload for the judge (senior round 3 B3);
   - Netscape cookie-jar lines (seven tab-separated fields) have their value field masked.
   - **Order:** the complete canonical text is redacted **before** it is split into passages, so a secret spanning a
     passage boundary is still caught (codex round 4 W25). The seeded test includes a boundary-split seed.
4. **URLs** keep scheme, host and path. Userinfo, every query value and the fragment are masked (senior W1).
5. **This turn's extracted one-time codes and links** (by value, from `trusted_extract`) are masked.

The seeded test has two halves:

- **No seed survives:** API keys, `.env` lines (including a nested `.env`), `DATABASE_URL` with userinfo, OAuth
  `?code=`, signed query strings, OTPs, magic links, bearer tokens, `password=…`.
- **Every planted payload survives:** injection sentences after `api_key:`, inside heredocs, inside URLs' paths, in zh
  and en.

**Accepted residual, stated in ADR 0030:** a secret with no recognisable shape, in a file or output the planner read,
can reach TypeSafe. Paco approved that class (R11). The passage text is never written to the ledger (§5.2).

### 7.1 `tool.injection`: does a tool result carry instructions aimed at the AI?

**Where.**

- **Shell and the four wall tools** are judged inside Houge, which already holds their bytes:
  - shell in `bridge-handler.ts` before the result is returned, on the success **and** failure paths (`failureText`
    renders output from `error_ref`);
  - wall tools before the quarantined reader.
- **Built-in `read`** is judged through Houge's extension (P1 PASS):
  1. The extension builds one canonical text: `content` capped at 32 KiB with a truncation note. It sets **both**
     `content` and `details.displayContent` to that canonical text **before** asking, so whatever is judged is exactly
     what is shown (codex round 3 #5).
  2. It sends a new bridge request kind `judge_read { toolCallId, text }`, validated and authenticated like every
     other bridge request.
  3. Houge replies `{ verdict: "unchanged" | "rewritten", text? }`. The extension applies a rewrite to both fields.
  4. **Timeout:** the extension waits at most 5 s, well under omp's 30 s hook limit. On expiry or a bridge error it
     applies the code floor itself (the phrase list ships in the extension) and returns at once. It then sends a
     `judge_timeout { toolCallId }` request **without awaiting it**, so reporting can never delay the result (codex
     round 3 B11).
     - Houge's handler for `judge_timeout` raises the turn to `untrusted` and records the `fail` verdict.
     - **A lost report cannot certify a turn clean** (codex round 4 B21). Houge keeps each built-in read pending from
       its `gate` request (which Houge already receives).
       - It clears only when Houge's `judge_read` reply was delivered inside the extension's timer. The extension
         confirms by including `applied: true` on its next report for that call.
       - A read whose result the extension floored on its own (timeout path) finalizes the turn as at least
         `untrusted`, whatever arrives later (codex round 5 W31).
       - A read still pending at turn end does the same.
       - A built-in read with no `applied: true` by the time the turn's next bridge request arrives raises the turn to
         `untrusted` at that moment, not only at turn end (senior round 5 W24). So a lost report cannot leave later
         tool calls in the same turn under `clean` gates.
     - A verdict arriving after the extension's timer is recorded with `armed_mode: late` and not applied, since the
       floor already reached the model.
     - Tests: a bridge unresponsive for 40 s (the model saw the floored text, never raw), a lost `judge_timeout`
       (the turn finalizes `untrusted`), and a late verdict.

**What is judged:** only bytes that reach a model.

- reader input: the first 8000 chars;
- shell output after its 32 KiB cap;
- read results after the cap above.

**Rung 1 (code): withhold, pass, or abstain.** The floor is the initial verdict even when the rung abstains.

- **Withhold:** a passage matching the fixed phrase floor.
- **Pass:** an empty result only.
- **Abstain:** everything else. There is no length, location or trust-based pass (codex round 2 B10, senior round 3
  B1).

**Rung 2 (Jev):**

- one `noul` per passage of about 900 chars;
- batches of 16, sent concurrently;
- a total bound of 3 s per tool call;
- wording ported from mu (MIT, attributed);
- provisional bar p > 0.5 withholds, replaced with `[withheld: text aimed at the assistant]`;
- the recorded `p` is the maximum over passages, together with that passage's index (senior W4).

**Monotone** (`pass < withhold`). Withholding is a transform of data the model reads, not an allow or deny of an action.

**Fail:** the floor's answer. **Always record.**

**Volume:** about 4.5 shell results, 6 external reads and 0.2 built-in reads a day, each of 1–6 batches. Within P5.

**Outcomes:** review taps; Paco accepting a "trust this source" proposal.

**Effect on `turn.trust`:** any withhold raises the turn to hostile.

### 7.2 `turn.trust`: turn-wide trust level (code, locked)

**Levels:**

- `clean`;
- `untrusted`: a wall tool result, network shell output (`tool.shell_netread`, below), or a `judge_timeout`;
- `hostile`: `tool.injection` withheld something.

**Persistence:**

- The level only rises within a turn. It is held on the active turn object and is an input to `tool.policy`.
- A `turn_trust { level }` ledger event is written on each rise.
- A terminal `turn_trust_final { max_level }` event is written at **every** turn end, success or failure (senior W6).
- A turn without a final event (a failed write, or any turn from before stage 2a) counts as **not clean** wherever
  clean is required (§7.4).

**`tool.shell_netread`** (new code entry, best effort, its own tests). Does a command read from the network?

- Patterns: `curl` and `wget` of any method; `http`/`httpie`; `ssh`/`scp`/`rsync` with a host; `git fetch`, `clone`
  and `pull`; `nc`; `python`/`node` with url, fetch or http modules; pipes into these.
- It is separate from `tool.shell_class`, which keeps today's approval classification untouched.
- It now decides only the trust level, never whether output is judged (§7.1), so its misses cost a missed `untrusted`,
  not a missed judgement.

**Effects** follow ADR 0029 decision 2: a raised level adds a tap (`ask := code_ask ∨ trust_ask`).

- **untrusted:**
  - `memory_correct` keeps today's `tainted_turn` refusal (B9, an existing code rule, unchanged);
  - `lesson_write`, `schedule_task`, `self_write_propose` and `skill_author` additionally ask.
- **hostile:** a shell command runs without a tap **only if every segment is on a positive read-only list**
  (senior round 4 B7). There is no "write outside the workspace" classifier to lean on.
  - The list, code-owned and tested, admits a command only with its listed argument forms (codex round 5 B28: `sort -o`,
    `sed 'w file'`, `git diff --output` and `git log --output` all write without a shell redirect):
    - `ls`, `cat`, `head`, `tail`, `wc`, `cut`, `stat`, `pwd`, `echo`: any options, path operands;
    - `date`: no operand other than one `+<format>` (no clock setting);
    - `grep`: options except `-f`/`--file` from outside the workspace (reading, not writing, but kept narrow);
    - `jq`: a filter and path operands, no `--rawfile`/`--slurpfile` (they read, but keep it narrow);
    - `find`: only `-name`, `-iname`, `-path`, `-type`, `-maxdepth`, `-mindepth`, `-size`, `-mtime`, `-newer` and
      `-print`;
  - Not on the list, so they ask: `file` (`-C -m` writes a `.mgc` file; codex round 6), `sort`, `sed`, `awk`, `rg`
    (`--pre` runs a program), `diff`, **every `git`
    command** (a repo's `.git/config` or `GIT_CONFIG_*` variables can run a program through `core.fsmonitor` or
    `textconv`; senior round 5 B10, probed), and every other program.
  - **Rejected outright:**
    - any `NAME=value` prefix;
    - any wrapper (`env`, `xargs`, `nice`, `timeout`, `command`, `exec`, `builtin`, `sudo`);
    - redirects, `$(…)`, backticks and pipes into a non-listed program;
    - any token it cannot classify.
    - `command-matcher.ts` drops prefixes and wrappers, so this check uses its own strict lexer, which keeps them, and
      fails closed on anything it cannot lex.
  - The stage 2a gate asks for each counterexample above.
  - Everything else asks, including every network command and every write. Then the built-in redirect ("make this
    change through `bash`, which will ask Paco") is true.
- **Built-in `edit` and `write` at hostile** return a model-visible redirect: "this turn read text aimed at the
  assistant; make this change through `bash`, which will ask Paco".
  - This is a block of one route, so ADR 0030 names it as an explicit exception to ADR 0029's "no Jev in any deny path"
    (senior W3), for Paco to sign.
  - The asking route stays open, and the hostile `bash` card shows target paths and byte counts when the command
    passes the 3000-char card cap (`bridge-handler.ts:55`).
- **Trust cards have their own short expiry** (senior round 4 B9, codex round 4 B22). Today every approval wait calls
  `setAwaitingApproval(true)`, which pauses the deadline and the 180 s frame watchdog for the full 30-minute approval
  timeout (`planner-supervisor.ts:1143-1156`). Rev 4's "never pause" would let the watchdog abort the turn after
  3 minutes.
  - Each wait now passes an explicit pause policy: `{ pause: "full" }` for a code ask, as today, or
    `{ pause: "bounded", ttlMs }` for a trust-only ask.
  - A trust card's TTL is `HOUGE_TRUST_ASK_TTL_MS`, default 5 minutes. The timers pause for that TTL only. On expiry
    the card expires, the call returns "Paco did not approve in time", and the timers resume.
  - **The total trust pause per turn is capped at one TTL** (codex round 5 B29). Once a turn has spent it, further
    trust cards still ask but no longer pause the timers, so a turn's wall-clock length is bounded by deadline + one
    TTL. A test expires several trust cards in one turn and asserts that bound.
  - When a code ask and a trust ask fall on the same call, the code ask's full pause wins.
  - Tests: deadline expiry during a trust wait, card expiry, and a late tap after an abort ("already handled").
  - A schedule-born hostile turn therefore waits at most 5 minutes per card, bounded by its 10-minute deadline. Paco's
    messages are never held for hours. Incident `hostile_schedule_turn` pages once.
- **Tap budget:** stage 2a builds the counter ADR 0029 decision 2 describes but code never had (senior W13). It is one
  row per local date (Sydney) in a `trust_tap_budget` table, incremented per trust ask, and a new date starts at zero.
  At 3 a day, incident `trust_tap_budget` opens; the taps still ask.
- Standing approvals do not apply at hostile (§8.3).
- The approval card states the reason: "this turn read text aimed at the assistant".

### 7.3 `turn.settle`: done, or stopped halfway?

**Monotone** in the sense of more verification: `settle < send_back`. A Jev rung can only move a turn toward one more
pass, never cut a reply short.

**Effect rule (§4.1):** a send-back decided by the **Jev rung** runs its continuation with every side effect asking,
like hostile plus all writes. So a Jev verdict never causes a tap-free action (senior W7). A send-back decided by the
**code rung** (claims or todo evidence) runs under the turn's normal gates, since code rungs may cause effects.

**Egress:** the final reply is R11's separately approved class ("the reply"), always sent through the judge redactor.
It does not depend on trust level (senior W2).

**Where.** Houge's extension handles `session_stop` (P2 PASS), asks Houge over the bridge (5 s timer; on expiry it
returns nothing, so the turn settles), and returns `{continue: true, additionalContext}` or nothing.

**Prerequisite (stage 2a, task 1): settle only on a terminal `agent_end`.**

- omp marks `agent_end` non-terminal in several cases (`agent-session.ts:1453-1467, 4205-4417`):
  - a late steer;
  - its own retries;
  - compaction continuations;
  - thinking-only stop retries.
- The fix settles on `isTerminal !== false`. Houge's error-classification path (`retryNextLeg`, D9) keeps acting on
  error frames as today.
- The stage 2a plan starts with a probe that captures frame sequences for each case, and turns each into a test. Each
  test must show Houge settles exactly once and its own retry and omp's never both fire (senior W1).

**Never send back when:**

- the turn's trust level is `hostile` (the turn is already asking for everything risky);

- the turn already sent back once. Houge's own per-turn flag enforces this, since omp allows up to 8;
- the last tool call was denied or expired;
- a steered message is waiting for the turn;
- less than 60 s of the turn deadline remains;
- an abort is in progress (omp skips the hook, `agent-session.ts:4951-4954`).

**Rung 1 (code):**

- **Claims check.** The reply claims an action by a fixed zh/en verb list mapped to evidence:
  - scheduled / 已安排 → a succeeded `schedule_task`;
  - saved / 已保存 / 记住了 → a succeeded `lesson_write` **or** a code-side `lesson_saved` event this turn;
  - attached / 附上 → an `[[attach:]]` line;
  - sent / 已发送 → a succeeded external-write call.
  - With no evidence: send back with "You said you scheduled it, but no `schedule_task` succeeded this turn."
- **Todo check.** `todo` phases with pending or in_progress items → send back.
  - Enabled with `todo.reminders: false` in Houge's omp config. The setting exists (`tools/settings.ts:360`); stage 2b
    confirms it takes effect in RPC mode.
  - Read through RPC `get_state` by the supervisor.

**Rung 2 (Jev):** four split `noul` questions (mu: combined 0.79 vs split 0.29), provisional bar 0.5:

- claims done?
- acted or edited but verified nothing?
- ends on a promise ("next I'll…")?
- asks permission for work Paco already asked for?

**The send-back note and the reply:**

- Note: "Your reply will **replace** the previous one: restate your complete final answer." and "Do not start a step
  that needs Paco's approval; say what is pending."
- The supervisor keeps every assistant text of the turn, not only `lastText`.
- **Code fallback** (senior #1): if the second pass's text is empty, or under a third of the first pass's length, Paco
  gets the first pass's text followed by the second.
- Attachments are collected from every pass.
- The stage 2b gate asserts a first-pass attachment survives a complete second-pass restatement, an abort mid-second
  pass, and the once-only boundary (codex W15).

**Fail:** open (settles as today). **Always record.**

**Outcomes:**

- Paco's next message sorted as a correction or complaint by `turn.handler`;
- a rating;
- review taps;
- a second unverified settle (urgent card, §8.2).

### 7.4 `improve.route`: what does this signal point at? (rulings R4, R5)

**Where:** after the turn, in the background. It never delays a reply.

**Signals in** (closed enum `ImproveSignal`; each a `decision_outcomes` row or a code event):

| Signal | Value |
|---|---|
| `correction` | `turn.handler` category of Paco's next message |
| `dig_deeper` | lane |
| `review_bad`, `review_unsure` | entry id |
| `approval_denied`, `approval_expired` | capability |
| `rating` | 0–3 |
| `settle_sent_back` | which question fired |
| `planner_failed` | failure type |
| `recurrence` | count in 14 days |
| `abandoned` | Paco re-asks within 10 minutes |
| `lesson_unfollowed` | recalled ≥ 8 times, never followed (mu's `memory.applied`) |

**What never counts as a signal** (lessons.md: a monitor must not observe its own output; senior B7):

- work started by an improvement: authoring jobs live in `improvement_jobs`, never in runs or `chat_turns`; the digest
  and cards are notifications;
- schedule-born runs;
- **Trust level does not exclude a turn from recurrence.** Rev 2–6 counted only clean turns. But most turns worth a
  skill read the web, mail or shell output, so the rule would rarely fire (side-agent note, 2026-10-12).
  - The persistence risk is handled where the text enters, not by which turns count. Authoring input is Paco's own
    request texts only (below), and the skill writer is a one-shot call over that text with no tools
    (`core-worker.ts:1764`). Nothing a turn read can reach the draft.
  - A test plants an injection in a recurring turn's tool output and asserts the draft and its writer prompt never
    contain it.
  - The trust level still matters for targets whose input *is* tool output: wiki pages go through ADR 0020's own walled
    verifier (below).

**Rungs:**

1. **Code.** Exact mappings. These are the only rungs whose verdicts cause automatic effects (§4.1):
   - a stated rule → lesson (the existing save-first path, Undo);
   - an approval streak → standing approval (stage 4, §8.3);
   - recurrence → **skill authoring starts** (R4). Recurrence means 3 Telegram turns from Paco in 14 days, same
     `turn.handler` category, request cosine ≥ the relevance gate (A25), excluding schedule-born runs.
   - recurrence of a `lookup` or `research` topic → **wiki page proposal** (below).
2. **Jev.** Choice over the targets, with `nothing` as the escape. State: the signal, the turn's category and a
   code-built tool summary.
3. **Tiny model.** Below the bar, a one-word choice between the top two.

**Targets.** A Jev or Tiny verdict produces a proposal; code produces the automatic effects.

| Target | From code rung | From Jev/Tiny rung | Handler |
|---|---|---|---|
| fact | — | proposal card | `memory_correct` path, as today |
| lesson | stated rule: applied with Undo | proposal card, one tap to accept | `lesson-write` save path, backstop, caps |
| skill | recurrence: authoring starts, urgent card | proposal card | `skill_author` via the evolution lane |
| ladder | approval streak: standing approval | proposal (trust a source, retire a judge, lower a bar) | `ladder_moves` |
| schedule | expiries at the same hour twice: proposal | proposal | `schedule_task` edit after a tap |
| knowledge | recurring lookup or research topic: proposal card "keep a page on <topic>?" | correction of a researched fact: proposal to refine the page | `wiki_build` / `wiki_refine` (ADR 0020) |
| tool gap | — | digest line; self-write only on Paco's tap | `self_write_propose` |
| nothing | recorded | recorded | — |

**How authoring runs (senior round 3 B5).** Today skill authoring is a loop tool inside a planner turn
(`skill_author` → `runSkill`), not a run of its own. A new runs row would be dispatched as a Telegram turn that Paco's
messages steer into. So auto-authoring is a **background job on the evolution lane**, not a run:

- `improve.route`'s code rung calls a new `startAutoAuthoring(origin)` that claims the evolution lane
  (`evolution-lane.ts:71`), exactly as the tool adapter does. A busy lane refuses it, and it retries at the next
  digest.
- **`origin`:** the matched turns' run ids, plus **Paco's own request texts** (never tool output or replies) as the
  objective. Gate A (`skill-router.ts`) anchors to it as it anchors to a contract objective today.
- **Auto mode is a separate function, `authorPendingSkill(origin)`,** not a flag on `authorAndWriteSkill`. Today that
  function writes the skill active when Gate B passes or does not score, saves a lesson when it parks, and can retire a
  predecessor (`core-worker.ts:1779-1904`; senior round 4 B5, codex round 4 B23).
  - The new function reuses the writer and both gates.
  - It writes **only** to the inert `_pending` parking lot (`skill-store.ts:20-26`, excluded from every prompt),
    whatever the gates say.
  - It never saves a lesson and never retires or restores a skill. Those Gate A outcomes are listed in the urgent card
    as suggestions.
- **The skill becomes active only when Paco taps Accept** on the urgent card. That is R4's own wording: "you review
  the result through the normal skill flow".
- **`SkillStore` gains `promotePending(scope, name)` and `dismissPending(scope, name)`:**
  - **Promote** is an atomic move into the active tree. It fails on a name collision; the card then offers
    "replace" (retiring the old one, retire-never-delete) or "keep both" (a `-2` suffix).
  - **Dismiss** moves the draft to `_retired`. Nothing is deleted.
  - Both are one-shot: a second tap answers "already handled".
  - **Order** (codex round 5 W33): write the active copy, regenerate the registry, then unlink the `_pending` copy, then
    mark the job `promoted`. A crash between steps leaves a job in `promoting`, which the next digest retries
    idempotently (an existing identical active copy counts as written).
- **The urgent card's Accept and Dismiss** callbacks are `dec:sk:<job_id>:accept|dismiss`. They pass the sender
  allowlist (A1), and the target is the operator chat.
- **No runs row** (senior round 4 B5). Runs are claimed by state alone (`run-store.ts:2055`), and an expired lease
  re-queues a non-planner run (`:2129-2150`), so any runs row would eventually be dispatched.
  - The job lives in a new `improvement_jobs` table: `job_id`, `kind` (`skill_author`), `origin_json` (run ids and
    request text hashes; the texts are re-read from `chat_turns` when the job starts, never stored twice), `state`,
    `idempotency_key` (the recurrence cluster id), `created_at`, `finished_at`, `result_code`.
  - Its decision rows reference it.
  - `TriggerSource` is not changed.
- A recurrence cluster that has already started authoring never starts another in 30 days (enforced by
  `idempotency_key`).

**The wiki as a target** (ADR 0020). Houge's LLM wiki keeps durable per-topic pages built from a turn's quarantined
read digests and cross-source verified by a walled verifier. Its pages already carry outcome fields: `applied_count`,
`corrected_count`, `reuse_value`, `rating_history`.

- DB copy, 2026-10-12: 11 pages, 7 active, the newest built 2026-09-25, last used 2026-10-02. It looks dormant since
  the omp cutover. Whether `HOUGE_WIKI_ENABLED` is on is not visible from here (it lives in `.env`).
- `improve.route` makes it the home for **world knowledge**, beside facts about Paco (memory) and behaviour (lessons):
  - a lookup or research topic recurring 3 times in 14 days → a proposal card;
  - on Accept, the next turn on that topic runs `wiki_build` from its read digests, with ADR 0020's minimum sources and
    verify passes unchanged;
  - a correction of a researched fact → a `wiki_refine` proposal, and `corrected_count` rises.
- Wiki effects are proposals only. A page's input is tool output, so it never builds on its own; ADR 0020's verifier
  remains the trust boundary.
- If the flag is off, the target records and proposes nothing, and the digest says the wiki is disarmed.
- The stage 2b plan checks the wiki tools still work under omp before relying on them.

**Measuring each improvement.** Each improvement is itself a decision row whose outcome is checked:

- **A lesson** from correction X is flagged when a correction routed to the same lesson scope recurs within 30 days.
  The digest proposes a rewrite or retirement.
- **A skill:** usage and re-verification (`skill-reverify.ts`).
- **A standing approval:** revocations.
- **A wiki page:** `applied_count` against `corrected_count`, as ADR 0020 already tracks.

**Safety rules:**

1. A pattern is needed before behaviour changes; a single signal is recorded only. The exception is an explicit stated
   rule, which saves first as it does today.
2. Locked entries and protected files are never targets.
3. **Gaming watch.** The digest tracks the ask rate (assistant turns with `intent=clarify`), abandonment and correction
   counts over 7 days, side by side. The clarify cap (A27) stays.
4. **Rate limit:** at most 3 automatic improvements a day. The rest wait for the next day's digest.

## 8. Review surface and ladder moves

### 8.1 Daily digest

- **When:** one Telegram message a day at `HOUGE_DECISION_DIGEST_AT` (local time, default `21:00`). It goes through the
  rich renderer, and is skipped when empty.
- **Content, in order:**
  1. **Unsure verdicts:** up to 8, p within 0.15 of the bar.
     - Each shows the entry, a code-built one-line description (no tool text), and ✅ / ❌ buttons.
     - Callback `dec:rv:<decision_id>:<ok|bad>`.
  2. **Improvements made today,** each with its evidence and an Undo or Revoke button.
  3. **Proposals waiting:** bars, schedule times, model routes, tool gaps, trusted sources. Accept / Dismiss.
  4. **Counts:** per entry, acted, by rung.
  5. **Gaming watch** (§7.4 rule 3).
- **Taps:**
  - a tap writes a `decision_outcomes` label and feeds `improve.route`;
  - silence writes nothing;
  - every callback passes the sender allowlist (A1) and is one-shot: a second tap, or an unknown or stale id, answers
    "already handled" and writes nothing.

### 8.2 Urgent cards

Sent through the outbox straight away:

- skill authoring started, and finished or failed;
- a standing approval granted;
- `turn.trust` reaching hostile in a live turn (the approval card carries the reason);
- a `turn.settle` send-back that still settled unverified;
- an entry falling back to `fail` three times in an hour. This is incident `decision_fallback:<entry>`, which pages
  once per open incident (E12) and resolves on the next answered call.

### 8.3 Standing approvals (stage 4; ruling R8)

**Measured** (DB copy, 2026-10-12):

- The daily Alishan search's approvals share one fingerprint (`a0362e7ddf…`) across schedule and Telegram runs:
  5 consumed, 2 expired at the 11:00 schedule hour.
- On 2026-10-09 and 2026-10-10 Paco re-ran it by hand ("手動查一次", "查").
- Approval totals: `shell_external` 19 consumed / 2 denied / 5 expired; `shell_destructive` 2 consumed;
  `memory_correct_write` 6 consumed.

**Entry:** `approval.standing` is a rule rung placed before the paco rung of `tool.policy`'s approval path.

**Why a clean room, not a grammar.** Three rounds tried to prove from the command text that a byte-identical command
has a fixed effect. Each round found a new file input:

- `git push`, scripts, `-d @file` (round 1);
- `-F`, `--data-urlencode`, `~/.curlrc` (round 2);
- `-H @file`, a planted or stale cookie jar, symlinks (round 3).

`command-matcher.ts`'s tokenizer drops quoting and separator kind, so it cannot check a grammar (codex round 3 B12).
And the real Alishan command uses `-o /dev/null`, a `for` loop, `$(…)` and pipes (senior round 3 B6), so no safe
grammar would admit the case Paco named.

So Rev 4 binds the *environment*, not the text. A standing-approved command runs only in a **clean room**:

- a fresh, empty, uniquely named directory as its working directory, created by Houge for that one run and deleted
  after it;
- `HOME`, `CURL_HOME` and `XDG_CONFIG_HOME` pointed at a second fresh, empty directory, so no `~/.curlrc`, `.netrc` or
  other config is read;
- a dedicated Seatbelt profile, `cleanroom.sb`, rendered by `seatbelt.ts` like the existing two.
  - **What was probed live on 2026-10-12** (senior round 4; the profile and results are in research
    `13-cleanroom-probe.md`): `(allow default)` with **file reads and writes deny-default**:
    - reads allowed only in the room, the fresh home, `/usr`, `/bin`, `/System`, `/Library`, `/private/etc` and
      `/dev/null`, plus the root directory entry itself (without it every binary aborts at start);
    - metadata allowed on the `/etc`, `/var` and `/tmp` symlinks and the room's ancestors (without it DNS fails
      silently);
    - writes allowed only in the room and `/dev/null`;
    - the existing signal, `launchctl`, `security` and launchd denials.
  - **Probe results** (a)–(e): HTTPS `curl` works (TLS roots come from `/System` keychains through trustd); a bash `for`
    loop with `$(…)`, pipes and `-c`/`-b` works; `-H @/tmp/planted` is blocked; a symlink out of the room is blocked
    for reads, writes, traversal and hardlinks; a planted `~/.curlrc` is ignored. `/usr/bin/python3`'s install shim
    raises a GUI prompt, so the profile denies exec of it.
  - **The property that makes it sealed** (codex round 5 B30): the clean room's readable set and the set Houge's own
    processes can write must not overlap. The planner and shell profiles write only under `$HOME` and `/private/tmp`
    (`protected-paths.ts:43`). So:
    - the room and the fresh home live under the daemon's cache directory (`HOUGE_DAEMON_TMP_DIR`), which the planner
      and shell profiles already deny for reads and writes;
    - the readable system trees (`/usr`, `/bin`, `/sbin`, `/System`, `/Library`, `/dev`) are outside both write roots.
      Only root can change them, and that is outside Houge's threat model;
    - `/private/etc` is narrowed to `/private/etc/ssl` (root-owned). The round 5 re-probe found curl fails at start
      without `/private/etc/ssl/openssl.cnf`, while DNS needs nothing else under `/private/etc` (senior round 5);
    - a test renders the three profiles and asserts the clean room's read set has no path in common with the planner
      or shell write set;
    - the stage 4 gate tries `-d @/private/etc/hosts`, `-d @$HOME/x` and `-d @/private/tmp/x` in a sealed run, and
      asserts each fails to read.
  - **The home is read-only to the child**, since a `.curlrc` planted in the readable home *is* read.
  - **Not yet probed, required before stage 4 code** (P8): a deny on loopback and the bridge socket (`localhost`,
    `127.0.0.0/8`, `::1`), so no local service can be reached; and a `mach-lookup` allowlist limited to what DNS and
    TLS need (mDNSResponder, trustd), replacing `(allow default)` for IPC. If either breaks the Alishan command, the
    residual (a local service or IPC reachable from a sealed run) is recorded in ADR 0030 for Paco.
- **a fixed environment:** `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, `LANG`, `HOME`, `CURL_HOME`, `XDG_CONFIG_HOME` and
  `TMPDIR` (inside the room). Nothing is inherited from the daemon (codex round 4 B19).

Then every file the command can read either was created by that same run, or does not exist. A planted header file, a
stale cookie jar, a symlink or a config file cannot influence it. The effect depends only on the approved bytes, the
clock and the remote server's responses, which is what Paco approved three times.

**Eligible:**

- capability `shell_external` (a single `HTTP write` label, or the labels the three approvals carried);
- not `destructive`, not `paid`, not `memory_correct_write`;
- the same chat as the approvals;
- the turn is not `hostile`.

**How a standing run is executed** (codex round 4 B20). Today the bridge hands `CapabilityRunner` the original input,
and the shell adapter always uses `shell.sb`, the turn workspace and `cfg.sandbox`, which can be disabled
(`shell-adapter.ts:77-89`, `omp-config.ts:86`).

- A standing match sets `executor: "cleanroom"` on the execution record, **outside** the adapter input that the
  action fingerprint hashes (`capability-runner.ts:111`). So the fingerprint of the sealed 4th call equals the first
  three (codex round 5 W32), and a test asserts that continuity. Re-validation (B14) checks the executor field together
  with the fingerprint.
- The shell adapter selects `cleanroom.sb`, the clean room as working directory and the fixed environment from that
  field alone.
- If the sandbox is unavailable or disabled, the standing match is void and the call asks as normal (fail closed).
- Teardown deletes both directories after the call, in a `finally`.
- The stage 4 gate drives the fourth call through the real bridge and wrapper and asserts the selected profile.

**A curl cookie jar that cannot be read or written fails silently, with exit 0** (probe (d)). So a clean-room run's
success is judged by its report reaching Paco, not by its exit code.

**Grant:**

- **Two steps, so the clean room is proven before any card is removed** (codex round 4 B24):
  1. 3 consecutive `consumed` approvals of one `action_fingerprint`, in one chat, make the action a candidate.
     - `expired` neither counts nor resets the streak;
     - `denied` resets the streak and blocks a candidacy for 30 days.
  2. A candidate's next run **still asks**, and once approved, runs in the clean room. If it succeeds (its report
     reaches Paco), the grant is made. If it fails, the candidacy ends with a note in the digest ("this command needs
     files outside a sealed folder; it will keep asking"), and normal asking continues.
  - For the Alishan search that is four approvals, the fourth already sealed.
- On grant:
  - a `ladder_moves` row (`granted_by: auto`, the only auto row the store accepts, §4.3);
  - an urgent card: "From now on I'll run *<action label>* without asking (in a sealed folder)", with a Revoke button
    (`dec:sa:<move_id>:revoke`).

**Use:**

- A matching fingerprint consumes no card. It runs in the clean room.
- It writes a decision row (`rung: rule`, `reason_code: standing`, linking `move_id`).
- Re-validation (B14) still runs, and the kill switch overrides everything.
- The binding check (B14) gains one case: a standing move stands in for the same-run approval, for that fingerprint and
  chat only.

**The Alishan check:** the stage 4 gate runs the real command, read from its run's session transcript, in the clean
room on the gate machine, and confirms it produces the same report as an approved normal run.

**End:** revoke, a deny of the same fingerprint, 30 days unused, or `/standing revoke <n>`. `/standing` lists the
active ones.

## 9. Things decided against (with reasons, so they are not rediscovered)

1. **Judge approval** (mu `tool.approval`). Approval stays Paco's or a Paco-authorised standing rule. A judge must not
   open a gate (§4.1).
2. **omp's built-in judges.**
   - Their verdicts are not observable (§3.3), so they cannot be ledgered, calibrated or reviewed.
   - It is not about the key: the child already holds subscription logins (`~/.omp` readable, ADR 0028 D11), worth more
     than a Jev key.
   - Revisit if omp emits verdict events.
3. **Prompt hints** (mu `input.preflight` hint). The stage A spec, Appendix B, rejected them, and the reason still holds:
   the planner has the full message, and a wrong hint steers it.
4. **Judge-driven rewind** (mu `turn.rewind`). Houge cannot undo tool side effects.
5. **Relevance trimming of tool output** (mu `tool.admission`). mu's own numbers show no drops in live use. Revisit if
   long outputs show up in the ledger.
6. **Migrating all 85 points.** Mechanics stay code (§6.1). Clean means every decision, not every branch.
7. **A tally table for routine passes** (Rev 1). Existing `tool_finished` and `loop_step` events already count them;
   a second accounting path before any measured volume problem is YAGNI (codex S16).
8. **Narrowing `improve.route` to signal capture first** (codex S17). Paco ruled the broad target list in (R5). The
   risk is handled by the rule that only code rungs cause automatic effects (§4.1), and by one stage-2b task per
   target, each with its own outcome and rollback test.
9. **Leaving locked rule-only entries off the list** (senior S). Their call sites gain little from moving, but R2 asks
   for one list. They are registered and recorded through `decideSync`, cheaply. Their logic never changes, and the
   registry test refuses any rung or move on them.
10. **Quoting the contract's `stop_condition` in the settle note** (Rev 1). It is generic text ("answered, or budget
    exhausted") and adds nothing (senior S).

## 10. ADR 0030 and ADR hygiene

### 10.1 ADR 0030 "Decision ladder" (Paco's hand; `docs/decisions/` is protected)

The registry, ladder, ledger, runner and locked entries; the monotone rule restated as "a Jev or model rung can only
tighten a monotone decision and never opens a gate"; ladder moves and what Houge may move on its own; improvement as a
decision.

It amends, naming each clause (senior N1):

- **0029:**
  - the front door becomes `turn.handler`;
  - **decision 2** (monotone safety) is kept word for word: Jev only adds a tap (`ask := code_ask ∨ …`) and never
    produces allow or deny. ADR 0030 records three applications under it:
    - withholding a passage is a data transform, not an action deny;
    - `turn.settle`'s send-back is a bounded continuation: after a Jev-rung send-back every side effect asks, after a code-rung send-back the normal gates apply (§7.3);
    - the built-in `edit`/`write` redirect at hostile is the ask form for a gate that cannot wait;
  - "no Jev in any deny path, ever" gains **one named exception** (senior W3): the code-owned redirect of a built-in
    `edit`/`write` to its asking equivalent (`bash`, which asks) in a hostile turn. Every other Jev verdict stays out
    of deny paths;
  - the added-tap budget (3 a day) now also counts trust asks (§7.2);
  - **decision 4** (egress): R11 is recorded as Paco's approval of web, mail and calendar content, shell output, files
    and replies, with §7.0's judge redactor and the accepted residual;
  - **decision 5** (shadow before arm): provisional bars (§4.2) are an explicit exception, under Paco's R6, for
    monotone or fail-open entries only.
- **0028:** D5 tap-free local writes become conditional on `turn.trust`; D12 network shell output gets
  `tool.injection`.
- **0014:** an injection judge before the reader.
- **0011:** `src/decisions/` is protected.

**AGENTS.md:** the Invariants sentence on Jev needs Paco's edit to match.

**When it lands:** ADR 0030 and the AGENTS.md edit are stage 1's first task, merged by Paco before any code that
relies on them. ADR 0030 carries the "Assumptions" and "Revisit when" fields (§10.3).

### 10.2 What ADR 0015 still decides here

The Jev key stays in the main process, and the child asks over the bridge. This is chosen on its merits: one ledger and
one calibration surface. It is not because ADR 0015 forbids it (R10, §9.2).

### 10.3 ADRs are reviewed continually (ruling R10)

- **Template.** `docs/decisions/` gains two fields, starting with ADR 0030:
  - **Assumptions:** the facts each decision rests on, each one checkable;
  - **Revisit when:** concrete triggers, such as a new component, a measured number moving, or a vendor change.
- **Citing rule** (CONTRIBUTING.md and `tasks/lessons.md`). A spec or plan that rules an option out because of an ADR
  must state the ADR's reason and why it still holds on today's system. Otherwise it reopens the question. Spec
  reviewers check every cited ADR constraint this way.
- **Backfill.** Assumptions and revisit triggers for ADRs 0001–0029 are a tracked backlog task (§11), not part of this
  build.

## 11. Nothing lost (ruling R9)

When this spec lands, `tasks/todo.md` and `docs/ROADMAP.md` gain these entries, each pointing to its source section:

- **SP4:**
  - automatic recalibration of decision bars from outcomes;
  - model-route changes from evidence;
  - goal record and verifier;
  - outcome memory past §7.4;
  - `goal.met` / `board.read` (mu).
- **Plain-code backlog** (research `00-` "Plain-code gaps"):
  - the loop rule: same call × 3, and a "wrap up now" note when the budget turns red (not picked, R3);
  - a typed stop word denying a waiting approval card;
  - refusing a re-request of an action Paco denied this turn;
  - a cap on the supervisor queue.
- **mu parked points** (stage A spec Appendix A, plus research `00-`): `notify.routing` (lane 4), `tool.admission`,
  `turn.drift`, `task.frame`, `input.interjection`, `tool.constraint`.
- **ADR backfill** (§10.3).

## 12. Probes before code (the spec review runs these against the live system)

| # | Question | Pass |
|---|---|---|
| P1 | `tool_result` for built-in `read` in RPC mode: fires, awaits async, applies a rewrite | **RUN, PASS** (2026-10-12); `details.displayContent` must be rewritten too |
| P2 | `session_stop` in RPC mode: fires; `continue` sends back once; `stop_hook_active` on the second fire | **RUN, PASS** |
| P3 | `todoPhases` readable mid-turn | **RUN, PASS** via RPC `get_state`; no extension accessor |
| P3b | Can omp's todo reminders be switched off in Houge's omp config? | **answered in source:** `todo.reminders` exists (`tools/settings.ts:360`); stage 2b confirms it takes effect in RPC mode |
| P3c | Does the planner use `todo` under Houge's system prompt (5 real-shaped prompts)? | recorded; informs whether the todo check earns its place |
| P4 | Hook time limits | **RUN:** 30 s for `tool_result` and `session_stop` (fails open); 30 s for `tool_call` (fails closed); Houge bridge has none, so Houge adds 5 s extension timers |
| P5 | Jev volume: about 25–50 extra calls a day (about 4.5 shell results, 6 external reads, 5 settles, `improve.route`) | within TypeSafe limits at 10× |
| P6 | Front-door parity: dual run of the last 200 Telegram texts through the old and new builds (§6.2) | 0 mismatches on every persisted row; Jev nondeterminism reported separately |
| P7 | Frame sequences for non-terminal `agent_end` (late steer, omp retry, compaction, thinking-only retry) | captured in stage 2a task 1; each becomes a test (§7.3) |
| P8 | Clean room: loopback and bridge-socket deny, `mach-lookup` allowlist, with the real Alishan command | stage 4 task 1; the command still produces its report, or the residual goes to ADR 0030 |

## 13. Build stages

Five stages (stage 2 split into 2a and 2b after review). Each gets its own plan, per-task reviews, final reviews, a
live gate, a docs sync and Paco's merge where protected files are touched.

| Stage | Contents | Protected files touched (Paco's merge) | Live gate PASS |
|---|---|---|---|
| 1 Engine + door | ADR 0030 and the AGENTS.md edit first; registry, runner, `decisions`, `decision_outcomes`, `ladder_moves`; `jev_verdicts` gains `decision_id`; `turn.handler` + `turn.gear` migrated; `src/decisions/` protected; off switch; **daily digest and urgent cards** (counts, unsure list, callbacks) | ADR, AGENTS.md, self-write-guard, run-store, core-worker | P6 dual run: 0 mismatches over 200 texts; all nine `jev_verdicts` consumers green; the digest renders on the DB copy and a ❌ tap writes an outcome |
| 2a In-Houge judges | supervisor terminal-`agent_end` fix (P7); credential-store read-deny extension; `tool.injection` on shell and wall tools; `tool.shell_netread`; the hostile read-only list; `turn.trust` with `turn_trust` and `turn_trust_final` events; trust-card pause policy and TTL; tap-budget table; judge redactor; injection and trust items in the digest | bridge-handler, planner-supervisor, capability-policy, run-store, protected-paths | the §4.2 injection sanity gate passes (recall ≥ 85%, clean withholds ≤ 1%); no seeded secret leaves; a planted turn reaches hostile, `curl`, `touch`, `git log` and `file -C` ask while `ls` and `grep` do not, a built-in write gets the bash redirect, a trust card expires after its TTL without the watchdog firing, and a schedule-born hostile turn ends within its deadline; the newly read-denied credential paths refuse a planner read |
| 2b Hooks + learning | extension `judge_read`, `judge_timeout` and `session_stop`; `turn.settle`; `todo` with reminders off; `improve.route`; `authorPendingSkill`, `improvement_jobs`, `promotePending`/`dismissPending`; improvement items in the digest | extension, planner-supervisor, planner-session, skill-store, run-store | a planted file read past the 32 KiB cap is withheld in both fields; a 40 s unresponsive bridge shows the floored text, never raw; the §4.2 settle gate passes (≤ 10% send-backs, Paco's sample read); a "scheduled" claim with no call is sent back once, and a first-pass attachment survives; a labelled set of ≥ 30 past signals (labels by the plan author, checked by Paco in one sitting) routes ≥ 80% to the labelled target; 3 similar synthetic turns (one of them hostile, with a planted injection in its tool output) write a `_pending` draft that contains no planted text, and an urgent card; a schedule-born run does not count; 3 recurring lookups on one topic raise a wiki proposal |
| 3 Unprotected families | intake, context, supervision and settle entries migrated | core-worker, planner-supervisor (some) | differential on behaviour (§6.2); full suite and existing gates green |
| 4 Protected families + standing | `tool.policy`, `tool.shell_class`, `tool.path`, `approval.bind`, `selfwrite.guard`, `fetch.ssrf`, `posture.kill`, `secret.redact`; `approval.standing` with the clean-room Seatbelt profile | policy, bridge, self-write-guard, gate-path, command-matcher, seatbelt | differential: command corpus, path corpus and policy matrix identical; the real Alishan command produces the same report in the clean room; 3 approvals on the copy → candidate → the 4th asks and runs sealed → grant → the 5th runs without a card through the real bridge with `cleanroom.sb` selected → a deny revokes; with the sandbox disabled the 5th asks; in the clean room, `-H @/tmp/planted`, a planted `cj.txt` symlink and a planted `~/.curlrc` have no effect |

Each stage keeps every existing consumer working at its own boundary (codex W15): no table is dropped while a reader
remains, and no stage depends on a later one.

**Gate rule.** A gate fails on silent degradation. A Jev call that was skipped makes a case INCONCLUSIVE, never PASS.

## 14. Risks

| Risk | Mitigation |
|---|---|
| A migrated safety gate changes behaviour | move-don't-improve; corpus differential tests; protected stages last; Paco's merge |
| Hooks behave differently in RPC mode | probes P1–P4 before code; shell and the wall tools judged inside Houge, needing no hook |
| Armed judges misfire with uncalibrated bars | monotone judges only tighten; settle sends back at most once and fails open; digest plus urgent cards; `HOUGE_DECISIONS_OFF` |
| Self-improvement drifts (gaming, noise) | pattern before action; rate limit; gaming watch; every improvement measured and revocable |
| Ledger growth | two grades plus tally folding (§5.2) |
| Scope (five stages) | each stage leaves Houge working on its own; stage 2 delivers value before the long migration, and carries protected-file risk, so it is split 2a/2b with a gate each |

## Appendix A. Turn flow after stage 4

```
message → intake.* → turn.handler ──lane──→ handler → reply
                         │
                         └─planner→ turn.gear, turn.model, context.* → omp turn
                                       │  each tool call: tool.manifest → tool.policy (+turn.trust, approval.standing,
                                       │                  paco rung) → tool.shell_class / tool.path → runs
                                       │  each result:    tool.injection → tool.wall → back to the model
                                       └─ settle:         turn.settle (send back once?) → attach.path → secret.redact → reply
after the turn: improve.route over the turn's signals → lesson / fact / skill / ladder / schedule / tool gap
daily: digest (unsure, improvements, proposals, counts, gaming watch) → Paco's taps → decision_outcomes
```

## 15. Rev 1 review closure

Rev 1 was reviewed by a senior pass against the live system (7 blockers, 14 warnings, 5 suggestions; probes P1–P4 run)
and by codex (8 blockers, 7 warnings, 2 suggestions). The overlapping blockers are merged below.

| # | Blocker (source) | Resolution |
|---|---|---|
| 1 | Send-back replaces the reply; attachments lost; omp allows 8 continues (senior B1) | §7.3: the note asks for a complete restatement; attachments collected from every pass; Houge's own once-flag |
| 2 | New egress classes without approval or redaction (senior B2, codex B4) | Paco approved all classes (R11); one redaction function plus a seeded-secret test (§7.0) |
| 3 | "Armed at ship" vs calibration rows (senior B3, codex B7) | provisional bars, monotone or fail-open entries only; a model change goes to shadow plus an incident; pre-ship sanity gate (§4.2) |
| 4 | No network-shell classifier; plain `curl` unjudged (senior B4, codex W11) | all shell output is judged (§7.1); a separate `tool.shell_netread` feeds trust (§7.2) |
| 5 | Trust effects unbuildable on the sync built-in gate; schedule-born turns have no one to tap (senior B5, codex B3) | Rev 2 denied; **Rev 3 replaces that with ask-only** (built-in redirect to the tapped `bash` path; schedule-born cards expire normally), to keep ADR 0029 decision 2 (§7.2) |
| 6 | A byte-identical fingerprint can change effect (`git push`, scripts, `@file`) (senior B6, codex B8) | an eligibility allowlist: inline HTTP write only, same chat, never hostile (§8.3) |
| 7 | Auto-authoring persists injected text; the router counts its own output (senior B7, codex W12) | only clean, Paco-originated Telegram turns count; improvement-generated and schedule-born runs never count; authoring input is Paco's own words (§7.4) |
| 8 | A rule "pass" skips the judge (codex B1) | eligible means `abstain`; a test proves eligible input reaches Jev (§4.1) |
| 9 | Built-in `read` content has no bridge path (codex B2) | a `judge_read` bridge kind, a 32 KiB cap, a 5 s extension timer and an in-extension floor (§7.1) |
| 10 | Dropping `jev_verdicts` loses fields; nine consumers (codex B5, senior W) | the table is kept as `turn.handler`'s detail table and gains `decision_id` (§5.3) |
| 11 | Verdict parity misses persisted rows and mutations (codex B6) | differential on behaviour; P6 replays 78 decisions (§6.2) |

Warnings closed in the text:

- `todo` is not record-only: P3b, or it stays off (§7.3).
- `/rearm` does not reload `.env`: boot only (§5.4).
- `tainted_turn` would loosen: kept unchanged (§7.2).
- The claims check's false positive on code-side saves: counts `lesson_saved`, plus a fire-rate gate (§7.3).
- Judge latency and bytes never seen: bytes reaching a model only, concurrent, 3 s total, failure path included (§7.1).
- A Jev verdict causing effects: proposals only (§4.1, §7.4).
- Hook timeouts fail open to raw text: 5 s extension timers that apply the floor, and `displayContent` is rewritten
  (§7.1).
- The pre-existing `isTerminal` bug: stage 2a task 1 (§7.3).
- Send-back races: the five never-send-back conditions (§7.3).
- Gate-loosening rows outside the protected surface: a store-level check, and one-shot allowlisted callbacks (§4.3,
  §8.1).
- The locked set missed three entries: A2's kill exemption, A5 and A10 are locked (§6.1).
- `state_hash` reversible and outcome values free-form: no state column; closed enums (§5.2).
- Stage 2 is heavy: split into 2a and 2b (§13).
- Ledger-write failure changing a gate: record after deciding, incident on failure (§4.1).
- Stage independence: no table dropped while a reader remains (§13).

### Round 2 (Rev 2 → Rev 3)

Round 2 results:

- **Senior:** Rev 1 items 3 closed, 8 partial; 6 new blockers, 15 warnings, 4 suggestions.
- **Codex:** Rev 1 items 6 closed, 2 partial; 4 new blockers, 3 warnings, 1 suggestion.

| # | Blocker (source) | Resolution |
|---|---|---|
| 12 | ADR 0030 misses the ADR 0029 clauses Rev 2 breaks; nothing lands the ADR first (senior N1) | §10.1 names each clause. Trust now only adds taps (decision 2 intact); the built-in redirect is the ask form. ADR 0030 and AGENTS.md are stage 1's first task. |
| 13 | The egress redactor deletes the judge's input (senior N2, checked) | a separate secrets-only judge redactor that keeps URLs, heredoc markers and prose (§7.0) |
| 14 | Arbitrary secrets can reach TypeSafe (codex B9, senior #2) | the outside-origin boundary: local data is never sent until the turn reads outside content; `NAME=value` rule; nested `.env` in the seed test; residual stated in ADR 0030 (§7.0) |
| 15 | Short-output and location passes skip cheap attacks (codex B10, senior N3) | no length pass; files modified this turn are judged; everything after `untrusted` is judged (§7.1) |
| 16 | Reads over 32 KiB pass unjudged (codex B11, senior #9) | the extension caps both fields before judging; timeout reports to Houge (§7.1) |
| 17 | The standing allowlist misses file-body forms and `~/.curlrc` (codex B12, senior N4) | a token-level permitted shape, every other token rejected, curl config files write-denied, the real Alishan command checked (§8.3) |
| 18 | 2a arms judges without the digest; no failing thresholds (senior N5) | the digest moves to stage 1; numeric sanity thresholds (§4.2) |
| 19 | Settle's Jev send-back breaks the effect rule (senior N6) | `turn.settle` is monotone toward verification (`settle < send_back`), reply-only (§7.3) |

Rev 1 partials closed in Rev 3:

- **#1:** the code fallback for a short restatement.
- **#3:** the `ProvisionalBar` type, golden-set items, numeric bars.
- **#7:** `turn_trust` persisted; source `improvement`.
- **#9:** the timeout report.
- **#11:** the dual-run P6.
- **Codex:** redactor wiring (W13), the skill run contract (W14), attachments across passes (W15), the monotone floor
  (S16).
- **Senior W1:** the non-terminal `agent_end` cases become probe P7 and tests.

### Round 3 (Rev 3 → Rev 4)

Round 3 results:

- **Senior:** 6 new blockers, 13 warnings, 3 suggestions.
- **Codex:** 4 new blockers, 2 warnings, 1 suggestion. Its round 2 items: 5 closed, 4 partial, 1 open.

Rev 4 changes approach in four places rather than patching the symptoms:

| # | Blocker (source) | Resolution |
|---|---|---|
| 20 | The outside-origin boundary misses network shell and earlier downloads; mtime is spoofable (senior B1, B2; codex #1, #3) | the boundary is dropped. R11 is applied as Paco chose it ("files" unqualified): every shell output and read is judged after redaction (§7.0, §7.1) |
| 21 | Redactor rule 3 deletes payloads; no survival test (senior B3) | anchored NAME, single-run values only, URL masking by component, a two-sided seeded test (§7.0) |
| 22 | Hostile asks stall turns and block the queue for hours (senior B4) | hostile asks only for network shell and writes outside the workspace; trust asks never pause the deadline or the watchdog (§7.2) |
| 23 | The `improvement` run source has no execution path; auto Gate A side effects (senior B5) | a background evolution-lane job, not a run; auto mode writes a `_pending` draft only; active on Paco's tap (§7.4) |
| 24 | Standing approvals still admit `-H @file`, a planted jar, symlinks; the tokenizer cannot check a grammar; the real Alishan command cannot fit (senior B6; codex B12–B14) | a clean room: fresh directory, empty `HOME`/`CURL_HOME`, a read-restricted Seatbelt profile; no grammar needed (§8.3) |
| 25 | The `judge_read` timeout report can delay the result past the hook limit (codex B11) | `judge_timeout` is a distinct request sent without awaiting; a 40 s unresponsive-bridge test (§7.1) |

Warnings closed:

- **Senior:** URL secrets (W1); reply egress (W2); the redirect named as an ADR exception (W3); `jev_decisions` one-to-
  many with the recorded `p` defined (W4); per-entry skip monitoring (W5); `turn_trust_final`, failing closed (W6);
  Jev send-back continuations ask (W7); the `judge_read` protocol (W8); the P6 harness (W9); corpus sources (W10); the
  Alishan fit (W11); the 2b labelled set (W12); the tap-budget counter (W13).
- **Codex:** canonical judged text (#5); the P6 projection and isolation (W15, W16).
- **Deferred to the stage 2b plan:** codex S17 (typed fields for the background job).

### Round 4 (Rev 4 → Rev 5)

Round 4 results:

- **Senior:** 3 new blockers, 8 warnings, 3 suggestions. Of round 3: B1, B2 and B6 closed; B3, B4 and B5 partial. The
  clean room was probed live and works with two added read allowances.
- **Codex:** 7 new blockers, 2 warnings, 1 suggestion. Of round 3: 6 closed, 6 partial.

| # | Blocker (source) | Resolution |
|---|---|---|
| 26 | Hostile asks rest on a write classifier that does not exist (senior B7) | a positive read-only list at hostile; everything else asks (§7.2) |
| 27 | Readable credential stores would be sent; redactor misses JSON, header and `*_KEY` names (senior B8) | stage 2a read-denies the stores found plus their patterns; a judge path deny-list; named-secret rule widened; cookie-jar lines (§7.0) |
| 28 | Trust asks not pausing the watchdog abort the turn at 180 s; no pause policy (senior B9, codex B22) | an explicit pause policy per wait; trust cards get a 5-minute TTL that pauses the timers for that TTL only (§7.2) |
| 29 | `jev_decisions.decision_id` collides with its primary key (codex B18) | `ladder_decision_id` (§5.2) |
| 30 | The clean-room boundary is unproved; environment, IPC and local network unbounded (codex B19) | file reads and writes deny-default, probed live; a fixed environment; loopback and IPC limits specified and made probe P8 before stage 4 code (§8.3) |
| 31 | Standing approval is not bound to the clean-room executor (codex B20) | `executor: "cleanroom"` in the validated input; fail closed when the sandbox is off; teardown in `finally` (§8.3) |
| 32 | A lost `judge_timeout` can certify a turn clean (codex B21) | reads stay pending until an outcome arrives; pending at turn end → `untrusted` (§7.1) |
| 33 | No pending-only authoring path; no promote or dismiss (codex B23, senior B5) | `authorPendingSkill`, `promotePending`/`dismissPending`, one-shot callbacks, `improvement_jobs` instead of a runs row (§7.4) |
| 34 | Three normal approvals do not prove the clean room (codex B24) | candidate after 3; the 4th still asks and runs sealed; success grants (§8.3) |

Warnings closed:

- **Codex:** redact before split (W25); a structural guard before nondeterminism exclusion (W26); wrapper probe in the
  stage 4 gate (S27).
- **Senior:** late verdicts (W8); corpus owner and holdout (W10); tap-budget storage (W13); skip-rate source (W5); the
  probe-driven profile allowances.

### Round 5 (Rev 5 → Rev 6)

Round 5 results:

- **Codex:** 12 of its 16 earlier items closed, 4 partial (the clean-room proof, P8 by design); 3 new blockers, 3
  plan-level warnings.
- **Senior:** 2 new blockers, 11 warnings, 3 suggestions; stages 1, 2b, 3 and 4 plannable after the listed fixes.

| # | Blocker (source) | Resolution |
|---|---|---|
| 35 | The read-only list writes via `sort -o`, `sed w`, `git … --output` (codex B28) | per-command argument forms; `sort`, `sed`, `awk`, `rg`, `diff` removed (§7.2) |
| 36 | Trust pauses add up across cards (codex B29) | total trust pause per turn capped at one TTL (§7.2) |
| 37 | The clean room reads `/private/etc` (codex B30) | the sealed property stated as "no overlap with Houge's write set", tested; `/private/etc` narrowed to `ssl/` after a re-probe (§8.3) |
| 38 | The read-only list runs programs via env prefixes, wrappers and git config (senior B10, probed) | all git removed; prefixes and wrappers rejected; a strict lexer of its own (§7.2) |
| 39 | Credential stores beyond the fixed list; PEM inside JSON passes the redactor (senior B11) | wider patterns; a content check before egress; PEM blocks masked whole; base64 length stated (§7.0) |

Warnings closed:

- **Codex:** late read outcome (W31); fingerprint continuity (W32); promotion order (W33).
- **Senior:** lost report raises trust at the next bridge request (W24); "reply-only" wording (W18); the
  `fallback_reason` column (W5).
- The remaining senior warnings are plan-level and go to the stage plans.

**Found outside the spec:** the planner can read Houge's own `.env.bak-2026-10-07` today, since only `<repo>/.env` is
read-denied (`protected-paths.ts:29`). It was raised to Paco on 2026-10-12, not left for stage 2a.

### Round 6 (scoped verification of Rev 6, codex)

Round 6 checked only the Rev 6 diff. Of the 8 items it checked, 6 closed and 2 were partial; it raised 2 new blockers,
both one-line fixes, applied in this revision:

- `file -C` writes a file, so `file` comes off the read-only list;
- the stage 2a gate still said `git log` runs without asking, which contradicted row 38. The gate now expects it to
  ask.

`date` is narrowed to a `+format` operand (codex warning).

Every review blocker from rounds 1–6 is closed or folded into a named probe (P8) that runs before stage 4 code.

### Rev 7 (after Paco's read began)

- **Recurrence no longer requires clean turns.** A side-agent note showed the clean-only rule would rarely fire, since
  skill-worthy tasks usually read the web. Safety moves to the input boundary: Paco's words only, and a writer with no
  tools, tested with a planted injection (§7.4).
- **The wiki joins `improve.route`** as the `knowledge` target, on Paco's question. Proposals only, since its input is
  tool output; ADR 0020's walled verifier stays the boundary (§7.4).

