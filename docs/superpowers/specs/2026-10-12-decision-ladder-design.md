# Decision ladder — every Houge decision on one list, judged inside the loop, improved from outcomes

- **Date:** 2026-10-12 · **Rev 3** · **Status:** draft; two review rounds (senior against the live system, with probes
  P1–P4 run; codex). Rev 3 closes the round 2 blockers (§15).
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
| R11 | **Egress approved for every new class**, after redaction: web pages, mail and calendar content, shell output, downloaded files and the planner's final reply may go to TypeSafe (ADR 0029 decision 4 asks for this approval per class) | §7.0 |

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
- **Pre-ship sanity gate (not calibration), with thresholds that can fail** (senior N5):
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
  - `reason_code?` (a code-owned enum per entry, never model or tool text), `armed_mode`, `latency_ms`;
  - `jev_decision_id?` (FK to `jev_decisions`, kept as the raw per-call record that calibration needs);
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
     - The last 200 Telegram user texts from `chat_turns` go through the pre-stage-1 build and the stage 1 build, on
       two copies of the DB, with Jev live.
     - The persisted `jev_decisions`, `jev_verdicts` and `triage` rows must match, field by field.
     - A mismatch where Jev's own probabilities differ between the two calls is reported separately, as Jev
       nondeterminism, never counted as a pass.
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

Paco approved every new class going to TypeSafe on 2026-10-12. Two rules bound what is sent.

**1. Only content of outside origin, or content seen after it, is judged and sent.**

- A turn's local data stays local until something from outside enters it. Before that, local shell output and local
  file reads are neither judged nor sent: before the first outside read, a planted instruction can only come from
  Paco's own files.
- Once a turn is `untrusted` (§7.2), every later shell output and built-in read is judged, because a local command can
  now echo downloaded content (`curl -o ~/x`, then `cat ~/x`).
- A built-in read of a file modified since the turn started is judged at any trust level, so a file written this turn
  counts as outside content (§7.1).

**2. One judge redactor, `src/decisions/egress.ts`, distinct from `jev/egress-redact.ts`.**

- That redactor was built for Paco's Telegram text: it strips heredocs to the end of the text and replaces every URL
  (`egress-redact.ts:8,16`), which would blind an injection judge (senior N2, checked on `dist`).
- The judge redactor removes **secrets only**:
  1. the broker's known secret values, injected into the stage 2a state builder through a new `RunStore` method that
     exposes the existing private redactor (`run-store.ts:1030`);
  2. credential shapes: bearer tokens, provider key prefixes, long hex and base64 tokens;
  3. `NAME=value` and `NAME: value` where NAME matches `(?i)(pass|secret|token|key|auth|cookie|session|pwd)`;
  4. one-time codes and sign-in links of the shapes `trusted_extract` recognises (mail).
- It keeps URLs, heredoc markers and prose, because the judge must read them.
- A test feeds a seeded corpus through each judge's state builder and asserts no seed survives: API keys, `.env` lines
  (including a nested `.env`), OTPs, magic links, bearer tokens, `password=…`.
- **Accepted residual, stated in ADR 0030:** a secret with no recognisable shape, inside outside-origin content, can
  reach TypeSafe. That is the class Paco approved in R11. Paco's local files never go unless the turn already read
  something from outside.
- The passage text is never written to the ledger (§5.2).

### 7.1 `tool.injection`: does a tool result carry instructions aimed at the AI?

**Where.**

- **Shell and the four wall tools** are judged inside Houge, which already holds their bytes:
  - shell in `bridge-handler.ts` before the result is returned, on the success **and** failure paths (`failureText`
    renders output from `error_ref`);
  - wall tools before the quarantined reader.
- **Built-in `read`** is judged through Houge's extension (P1 PASS):
  - The extension first caps the result to 32 KiB, truncating `content` **and** `details.displayContent` with a
    truncation note, so nothing past the judged bytes reaches the model (codex B11).
  - It sends a new bridge request kind `judge_read` with the capped text, the path, and whether the file's mtime is
    after the turn started. The bridge authenticates it like every other request.
  - Houge replies `unchanged` or with the rewritten text, and the extension applies it to both fields.
  - The extension's timer is 5 s (omp's limit is 30 s). On expiry or a bridge error, the extension applies the code
    floor itself (the phrase list ships in the extension) and sends a `report` with `judge_timeout`. Houge raises the
    turn to `untrusted` and records the `fail` verdict.

**What is judged:** only bytes that reach a model.

- reader input: the first 8000 chars;
- shell output after its 32 KiB cap;
- read results after the cap above.

**Rung 1 (code): withhold, pass, or abstain.** The floor is the initial verdict even when the rung abstains (codex
S16).

- **Withhold:** a passage matching the fixed phrase floor.
- **Pass** (no judge, nothing sent), and only these:
  - shell output or a built-in read in a turn still `clean`, where a read file was not modified this turn (§7.0
    rule 1);
  - an empty result.
  - There is no length-based pass (codex B10, senior N3).
- **Abstain:** everything else, including all wall-tool results and all network shell output.

**Rung 2 (Jev):**

- one `noul` per passage of about 900 chars;
- batches of 16, sent concurrently;
- a total bound of 3 s per tool call;
- wording ported from mu (MIT, attributed);
- provisional bar p > 0.5 withholds, replaced with `[withheld: text aimed at the assistant]`.

**Monotone** (`pass < withhold`). Withholding is a transform of data the model reads, not an allow or deny of an action.
ADR 0030 records it as monotone under ADR 0029 decision 2.

**Fail:** the floor's answer, never worse than today. **Always record.**

**Outcomes:** review taps; Paco accepting a "trust this source" proposal (§8.3).

**Effect on `turn.trust`:** any withhold raises the turn to hostile.

### 7.2 `turn.trust`: turn-wide trust level (code, locked)

**Levels:**

- `clean`;
- `untrusted`: a wall tool result, network shell output (`tool.shell_netread`, below), a read of a file modified this
  turn, or a `judge_timeout`;
- `hostile`: `tool.injection` withheld something.

The level only rises within a turn. It is held on the active turn object, persisted as a `turn_trust` ledger event on
each rise (so `improve.route` and the review can read it later; senior #7), and is an input to `tool.policy`.

**`tool.shell_netread`** (new code entry, best effort, its own tests). Does a command read from the network?

- Patterns: `curl` and `wget` of any method; `http`/`httpie`; `ssh`/`scp`/`rsync` with a host; `git fetch`, `clone`
  and `pull`; `nc`; `python`/`node` with url, fetch or http modules; pipes into these.
- It is separate from `tool.shell_class`, which keeps today's approval classification untouched.

**Effects** follow ADR 0029 decision 2 exactly: a raised level only **adds a tap**
(`ask := code_ask ∨ trust_ask`). It never denies on its own (senior N1).

- **untrusted:**
  - `memory_correct` keeps today's `tainted_turn` refusal (B9: a code rule that already exists, unchanged);
  - `lesson_write`, `schedule_task`, `self_write_propose` and `skill_author` additionally ask.
- **hostile:**
  - every bridge side effect asks, including plain shell (today tap-free, D5);
  - the built-in `edit` and `write` cannot wait for a tap: their gate is a synchronous allow/deny under omp's 30 s
    `tool_call` limit. At hostile they return a model-visible redirect: "this turn read text aimed at the assistant;
    make this change through `bash`, which will ask Paco".
    - That routes the same action to the asking path, so the action stays available behind a tap. ADR 0030 records it
      as the ask form for built-ins.
  - in a schedule-born turn the cards are sent as usual and expire under the normal approval timeout if nobody taps.
    The report says why; incident `hostile_schedule_turn` pages once.
  - standing approvals do **not** apply (§8.3).
- **Tap budget:** ADR 0029's added-tap budget (default 3 a day) counts trust asks. Beyond it the taps still ask, and
  incident `trust_tap_budget` opens.
- The approval card states the reason: "this turn read text aimed at the assistant".

### 7.3 `turn.settle`: done, or stopped halfway?

**Monotone** in the sense of more verification: `settle < send_back`. A Jev rung can only move a turn toward one more
pass, never cut a reply short. That is how it satisfies §4.1's effect rule (senior N6): the send-back is a bounded,
reply-only continuation with no side effect of its own. Any gated step inside it still asks.

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

- runs started by an improvement. A new run source `improvement` (added to `domain/types.ts`) tags every background
  run `improve.route` starts, and the digest and cards are notifications, never runs;
- schedule-born runs;
- turns whose persisted `turn_trust` reached `untrusted` or `hostile`. Their text may carry injected content, and a
  skill or lesson would put it into every system prompt.

**Rungs:**

1. **Code.** Exact mappings. These are the only rungs whose verdicts cause automatic effects (§4.1):
   - a stated rule → lesson (the existing save-first path, Undo);
   - an approval streak → standing approval (stage 4, §8.3);
   - recurrence → **skill authoring starts** (R4). Recurrence means 3 Telegram turns from Paco at trust `clean` in
     14 days, same `turn.handler` category, request cosine ≥ the relevance gate (A25).
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
| tool gap | — | digest line; self-write only on Paco's tap | `self_write_propose` |
| nothing | recorded | recorded | — |

**Authoring input (codex W12).**

- Recurrence starts a new run (source `improvement`, type `skill_author`), whose contract is compiled like today's
  skill contract (`core-worker.ts:1688`). Its objective is a code-built origin record: the matched turns' run ids,
  plus **Paco's own request texts** (never tool output or replies).
- It claims the evolution lane like any skill run (`evolution-lane.ts:71`), uses that contract's existing budget, and
  is refused while the lane is busy (retried at the next digest).
- Gate A (`skill-router.ts`) anchors to that objective as it anchors to a contract objective today.
- A recurrence cluster that has already started authoring never starts another in 30 days.

**Measuring each improvement.** Each improvement is itself a decision row whose outcome is checked:

- **A lesson** from correction X is flagged when a correction routed to the same lesson scope recurs within 30 days.
  The digest proposes a rewrite or retirement.
- **A skill:** usage and re-verification (`skill-reverify.ts`).
- **A standing approval:** revocations.

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

**Why the scope is narrow.** Rev 1 claimed a byte-identical fingerprint cannot produce a different effect. The review
showed it can (senior B6, codex B8):

- `git push` has the same bytes across runs while pushing different commits; the DB copy holds one (`8a6651c01f`);
- a script operand (`bash file.sh`, `python x.py`) can be rewritten without a tap;
- `curl -d @file` posts whatever the file holds.

So eligibility is an allowlist, not "anything but destructive".

**Eligible.** One permitted command shape, checked token by token with `command-matcher.ts`'s own tokenizer. Every
token must fit; an unknown token or option disqualifies the whole command (codex B12, senior N4):

- Segments are joined only by `&&`. Each segment is one of:
  - `mkdir -p <rel>` or `cd <rel>`, where `<rel>` is a relative path with no `..`, inside the chat workspace;
  - `curl` with options only from this list:
    - `-s` / `-S` / `-sS`, `--compressed`, `--max-time <n>`;
    - `-A <literal>`, `-H <literal>`;
    - `-X POST|GET|PUT`;
    - `-d` / `--data` / `--data-raw <literal>`, where the literal never starts with `@`;
    - `-c <file>`;
    - `-b <file>` only when an earlier segment of the same command wrote that file with `-c`;
    - one URL literal.
- Rejected outright, as any token: `-F`, `--form`, `--data-binary`, `--data-urlencode`, `-T`, `--upload-file`, `-K`,
  `--config`, `-o` / `-O`, any other option; pipes; redirects; `;`, `||` and `&`; `$(…)`, backticks and variables; any
  other program (`wget`, `httpie` and script interpreters included).
- **The config files curl reads are protected:** `~/.curlrc`, `~/.netrc` and `~/.config/curl/` join the write-deny list
  in `protected-paths.ts` in stage 4, so no turn can plant options for a later run.
- **The same chat** as the approvals.
- **The Alishan check:** its command starts `mkdir -p .tmp/ali && cd .tmp/ali && curl -s -c cj.txt -A "Mozilla/5.0" …`.
  The stored schedule goal is truncated at 300 characters, so the stage 4 plan reads the full command from the run's
  session transcript and confirms it fits.
  - If it does not fit, Houge proposes a rewrite of the schedule's command into the permitted shape, and Paco taps to
    accept it. The grant waits for three approvals of the new command.

**Never:** `destructive`, `paid`, `memory_correct_write`, or any turn at `turn.trust` hostile.

**Grant:**

- 3 consecutive `consumed` approvals of one `action_fingerprint`, in one chat:
  - `expired` neither counts nor resets the streak;
  - `denied` resets the streak and blocks a grant for 30 days.
- On grant:
  - a `ladder_moves` row (`granted_by: auto`, the only auto row the store accepts, §4.3);
  - an urgent card: "From now on I'll run *<action label>* without asking", with a Revoke button
    (`dec:sa:<move_id>:revoke`).

**Use:**

- A matching fingerprint consumes no card.
- It writes a decision row (`rung: rule`, `reason_code: standing`, linking `move_id`).
- Re-validation (B14) still runs, and the kill switch overrides everything.
- The binding check (B14) gains one case: a standing move stands in for the same-run approval, for that fingerprint and
  chat only.

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
    - `turn.settle`'s send-back is a reply-only continuation;
    - the built-in `edit`/`write` redirect at hostile is the ask form for a gate that cannot wait;
  - "no Jev in any deny path, ever" is kept: no Jev verdict reaches a deny;
  - the added-tap budget (3 a day) now also counts trust asks (§7.2);
  - **decision 4** (egress): R11 is recorded as Paco's approval of web, mail and calendar content, shell output, files
    and replies, with §7.0's boundary and redactor, and the accepted residual;
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

## 13. Build stages

Five stages (stage 2 split into 2a and 2b after review). Each gets its own plan, per-task reviews, final reviews, a
live gate, a docs sync and Paco's merge where protected files are touched.

| Stage | Contents | Protected files touched (Paco's merge) | Live gate PASS |
|---|---|---|---|
| 1 Engine + door | ADR 0030 and the AGENTS.md edit first; registry, runner, `decisions`, `decision_outcomes`, `ladder_moves`; `jev_verdicts` gains `decision_id`; `turn.handler` + `turn.gear` migrated; `src/decisions/` protected; off switch; **daily digest and urgent cards** (counts, unsure list, callbacks) | ADR, AGENTS.md, self-write-guard, run-store, core-worker | P6 dual run: 0 mismatches over 200 texts; all nine `jev_verdicts` consumers green; the digest renders on the DB copy and a ❌ tap writes an outcome |
| 2a In-Houge judges | supervisor terminal-`agent_end` fix (P7); `tool.injection` on shell and wall tools; `tool.shell_netread`; `turn.trust` with `turn_trust` events; judge redactor; injection and trust items in the digest | bridge-handler, planner-supervisor, capability-policy, run-store | the §4.2 injection sanity gate passes (recall ≥ 85%, clean withholds ≤ 1%); no seeded secret leaves; a planted turn reaches hostile, a plain shell call asks, a built-in write gets the bash redirect; a clean local-only turn sends nothing to TypeSafe |
| 2b Hooks + learning | extension `judge_read` and `session_stop`; `turn.settle`; `todo` with reminders off; `improve.route` with source `improvement`; improvement items in the digest | extension, planner-supervisor, planner-session, domain types | a planted file read past the 32 KiB cap is withheld in both fields; the §4.2 settle gate passes (≤ 10% send-backs, Paco's sample read); a "scheduled" claim with no call is sent back once, and a first-pass attachment survives; past corrections route to the expected targets; 3 clean similar synthetic turns start authoring, while a hostile turn, a schedule-born run and an improvement run do not count |
| 3 Unprotected families | intake, context, supervision and settle entries migrated | core-worker, planner-supervisor (some) | differential on behaviour (§6.2); full suite and existing gates green |
| 4 Protected families + standing | `tool.policy`, `tool.shell_class`, `tool.path`, `approval.bind`, `selfwrite.guard`, `fetch.ssrf`, `posture.kill`, `secret.redact`; `approval.standing`; curl config files write-denied | policy, bridge, self-write-guard, gate-path, command-matcher, protected-paths | differential: command corpus, path corpus and policy matrix identical; 3 approvals of the real Alishan command on the copy → grant → the 4th runs without a card → a deny revokes; `git push`, `curl -F`, `--data-urlencode @`, `-K`, `-d @file` and an extra plain segment are never granted |

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

