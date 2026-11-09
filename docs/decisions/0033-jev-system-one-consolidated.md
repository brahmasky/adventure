# ADR 0033: Jev as System One — a typed decision layer in front of the models (consolidated)

- **Status:** accepted 2026-11-05 (signed by Paco, rulings A1–A5 included); consolidates and supersedes
  [ADR 0029](0029-jev-system-one.md) with no change of meaning; amended 2026-11-05 (no off switch, no shadow — signed by
  Paco 2026-11-06); amended 2026-11-06 (drift rewording — signed by Paco 2026-11-06); amended 2026-11-09 (spec
  2026-11-09-sp2-mail-triage: lane 4 is `mail.triage`; the mail egress class `MailJevState` approved, D3; mail outages
  page through the Jev incidents plus `mail_jev_failing`) — awaiting Paco's signature
- **Date:** 2026-11-04
- **Deciders:** Paco
- **Supersedes:** [0029](0029-jev-system-one.md), with every amendment to it (in 0029, [0030](0030-decision-ladder.md),
  [0031](0031-chat-carries-what-needs-paco.md)); specs are listed under History

## Context

Houge makes many small typed judgment calls a day (what a message is, which model answers, whether a lesson is saved,
whether a read page carries instructions); each was hard-coded or cost a full planner turn. Jev (TypeSafe System One)
answers `choice` / `score` / `noul` questions over a JSON state with calibrated probabilities in about 0.3 s, cheaply,
and cannot generate text. Paco (2026-10-02, broadened 2026-10-04): "always use Jev for decision first, and subsequent
LLM including Claude for slightly lower probability items", with loose code: Jev picks a lane, a model composes in it.
Binding vendor facts: questions in one request are independent; `confidence` is a pure function of the probabilities,
so thresholds are per question, criteria wording and model version; known weaknesses are literal reading, option-order
bias, weaker CJK and adversarial content; inputs are not trained on but are hosted in the US, retention unpublished.

This ADR consolidates ADR 0029, its nine amendment sections (among them 0029's amendments to 0013, 0014, 0019 and
AGENTS.md, and the ones from ADR 0030 and ADR 0031) and its build notes, into one text with no change of meaning.

## Decision

We add a third layer. **System One (Jev)** answers typed questions; **code** enforces thresholds, floors and
fall-through; **System Two (omp seats)** composes inside the lane code picked. Jev is one rung of the decision ladder
([ADR 0034](0034-decision-ladder-consolidated.md)); what a Jev verdict may cause depends on what it read (ADR 0034 R12).

### A. The decision call (old decision 1)
- **A1.** One Jev request per decision point, carrying every question that point may need; code ignores answers it does
  not use. **A2.** Questions come from a frozen library, each with a `criteria_hash`; thresholds are keyed by
  `(question, criteria_hash, language)`.
- **A3.** Every answer writes a `jev_decisions` row: ids, probabilities, thresholds, outcome — never text (a run-less ladder
  entry's own request — `improve.route`, `memory.kind`, `mail.triage` — writes none: its `decisions` row carries the p). A generic
  replay harness comes with the library; golden sets run as daily ticks and in the version check (ADR 0034 6.2). State parity: answered rows record
  `thread_cut_at` (the claim, when live read the thread) and `state_built_at` (when it computed
  `last_houge_turn.age_s`); the replay rebuilds from both, reading the thread through the cut's own millisecond, and its
  report blocks on any state mismatch. Rows written before that migration fall back to their write time.
- **A4.** Jev rounds each probability to two decimals, so the client accepts a sum within n × 0.005 of 1 for n options
  (plus float error). A sum past that bound is still `probability_sum`.

### B. Monotone safety (old decision 2, B1–B3 word for word; old consequences)
- **B1.** Jev enters a security-bearing decision only as `ask := code_ask ∨ (jev_flag ∧ conf ≥ τ)`. It never produces
  `allow` or `deny`, never shortens an approval, never clears a taint, and never touches self-write, the reader wall's
  existence, the invariant sweep, the kill switch or `/approve` consumption.
- **B2.** Cards show `⚑ flagged: <class>` only — no score, no "safe". **B3.** Added taps are budgeted per day
  (default 3); excess is an incident. The budget also counts trust asks.
- **B4.** No Jev in any deny path, ever — with one named exception (the code-owned `edit`/`write` redirect to `bash`,
  in the cases ADR 0034 rule 2.4 names). Every other Jev verdict stays out of deny paths. ADR 0034 also records three
  applications of B1 (withholding a passage; `turn.settle`'s send-back; that redirect).
- **B5.** No Jev-decided reconcile verdicts; no per-turn prompt assembly by Jev in v1; no `exfil_shape` through Jev;
  nothing Jev does may be invisible to the ledger.
- **B6.** Jev is a closed-enum component from a third model family beside the reader wall; it never decides whether the
  wall applies (ADR 0014). `contains_instructions` on reader-wall output is `reader_flag ∨ jev_flag`, ledgered; a flag
  taints later external-write cards in the run with one line (the lane 3 design). The injection judge
  (`tool.injection`) that runs before the reader is ADR 0034's.

### C. Fail toward today (old decision 3)
- **C1.** `none`, low confidence, a missing language calibration, or any Jev failure (no key, fuse, 401/403, 422, 429,
  529, timeout, parse, oversized state) yields today's behaviour exactly, with a ledger row.
- **C2.** At the front door "today's behaviour" is the planner on the Default role as resolved (a `/models` override
  included): any Jev failure, skip, unarmed question or thrown stage runs it, with one verdict row.

### D. State and egress (old decision 4)
- **D1.** State is code-observed fact, redacted by the broker and stripped of credential-shaped tokens. OTP codes and
  links from `trusted_extract` never enter a state. A state never carries a model-authored justification.
- **D2.** Approved egress: Paco's Telegram text under the 2026-09-25 caps, and, by Paco's ruling R11 (every new class,
  after redaction — ADR 0034 rule 7.2, which also holds the judge redactor and the residual), the classes it was
  recorded against: web, mail and calendar content, shell output, files and replies. **Paco's inbound mail** (2026-11-09,
  D3): the mail egress class for Jev is `MailJevState` (`src/mail/envelope.ts`) — redacted sender name, sender address,
  known flag, redacted subject and snippet, labels, importance — built by code, never by a model; no time, presence,
  thread, id or language field, never the body or an attachment. Every untrusted text field passes the gmail-read caps and
  the judge redactor (ADR 0034 7.2, `codeShapes` and `linkTokens`) before it is stored, sent or shown; the address passes an
  addr-spec allowlist and is sent as is (it is the sender-rule key). `tests/adr/0033-mail-egress.test.ts` pins the key set
  and the masking on the real request.

### E. The metered leg and outages (old decision 6; ADR 0019 amendment)
- **E1.** Jev is a free, non-generative leg outside the flat-rate chains, metered under the ADR 0019 ceiling and fuse,
  and treated as free by Paco until he says otherwise. The ceiling is active for it: Jev is its one leg, checked before
  every attempt.
- **E2.** Every Jev outage class is an alerted incident that pages; none is a silent retry: `jev_auth` (401/403),
  `jev_question_invalid` (422), `jev_rate_limited` (429), `jev_overloaded` (529), and `jev_no_key`. Jev is excluded
  from `llm_leg_failing`; these incidents replace it.
  **E3.** The daemon builds the Jev client per call and reads the broker key each time, so a key added later takes
  effect without a restart; `jev_no_key` therefore opens on the first armed turn, not at boot.
- **E4.** Timeout, parse, transport and `error` skips open no incident per call. The sweep opens `jev_skip_rate` when
  they are at least half of 3 or more triage calls in 24 h, holds it until an answered call lands, and it pages.
- **E5.** A lane that fails pages: the sweep's `lane_fallthrough_rate` opens per lane when, of at least 3 settled turns
  in 24 h, half or more fell through to the planner. **Mail** (2026-11-09): `mail.triage` is in `JEV_PAGED_ELSEWHERE`, so
  a Jev outage on mail reaches Paco through the Jev incidents, plus the `mail_jev_failing` sweep check (page: at least 5
  `fail`-rung `mail.triage` decisions and no `system_one` answer in 24 h — a timeout storm opens no per-call incident and
  `jev_skip_rate` reads the front door's point only); every mail still pings meanwhile (`fail` = `ping`, D4).
- **E6.** AGENTS.md carries the invariant line for this ADR, as it reads today: Jev, a non-generative typed decider, is
  one rung of the decision ladder; what it may cause depends on what it read (ADR 0034 R12); it never gates an action
  (with the one named exception, B4); every outage reaches Paco.

### F. Model alias and the version check (old decisions 1 and 5; amendment 2026-10-07)
- **F1.** Jev requests name TypeSafe's moving alias `jev-latest`, never a pinned version. The response's `model` field
  (the versioned id behind the alias) is validated by `JEV_MODEL_ID` and recorded on every row as
  `jev_decisions.model_reported`.
- **F2.** Calibration approves questions and bars, not a model version. A row arms a question for
  `(question_id, criteria_hash, lang)` and holds for a reported model only while that model is `trusted`.
- **F3.** A version move is checked by code against Paco's approved reference turns and labels (the **Anchor**). A
  version that agrees within Jev's own noise arms, with one notice. A drift disarms the failing questions and their
  dependents and pages once, with an Accept button: `jev_model_drifted`, or `jev_model_insufficient` when the reference
  is too small. Safety judges never disarm on a version move.
- **F4.** Paco's Accept on a drifted or insufficient version re-arms the disarmed questions and makes that version's
  answers the reference later versions are checked against (his decision, 2026-10-23); a later model that passes the
  check also arms them again.
- **F5.** The check cannot cost the answer: it runs after the answered decision is held, inside a try/catch.
- **F6.** Routing of version-check messages: `jev_model_drifted`, `jev_model_insufficient` and `jev_model_check_stalled`
  are card kinds (the Accept card or the stalled notice is the page, sent to the job's chat or the operator chat).
  Routine notices (deferred, passed) are log rows ([ADR 0031](0031-chat-carries-what-needs-paco.md)).
- **F7.** Replay tools compare against no pin. A run's evidence is its own reported model; a model change mid-run warns,
  across a resume too. The intent replay's reference is the first model Jev reported; off-model rows are recorded but
  excluded from the verdict. The triage report refuses a file (canonical or permuted) with more than one reported model,
  suggests rows only with the model the rows reported.
- **F8.** Golden-set drift does not disarm, and `decision_bar_stale` is retired; ADR 0034 holds both kinds.

### G. Arming (old decision 5, as amended)
- **G1.** A Jev question arms per question and per language, on a calibrated row Paco commits (`CALIBRATED_ROWS`),
  normally after `houge jev replay triage` on a DB copy. Paco may arm on his word; evidence then accrues while armed.
  The replay report and labelling stay available for tuning bars (sized against the measured volume, reported with
  Wilson lower bounds), not as an arming gate.
- **G2.** A criteria change gives a question a new hash, so it is unarmed until a row names the new hash; an unarmed
  question routes `uncalibrated` to the planner on Default, and no lane acts. **G3.** The front door's calibrated tree
  rows disarm on a model move per F3. New ladder entries never shadow; provisional bars: ADR 0034 (R13, R6).
- **G4.** Rows armed on Paco's word: the six tree questions and `category:status`, zh and en (2026-10-09);
  `category:answer` and `category:lookup`, zh and en, on the `category` question's hash (2026-10-10).
- **G5.** The memory lane acts on the `category` plus `rule` rows; the status lane on `category:status` plus `rule`;
  the answer and lookup lanes on their `category:answer` / `category:lookup` rows (I2).
- **G6.** `HOUGE_JEV_CALIBRATION_FILE` is for live gates only: outside `HOUGE_JEV_GATE=1` a set file holds the front door off.
  A `houge.jev-disarmed` marker an older build left also holds it off until removed by hand; no code writes it any more.
  `/status` names either cause.

### H. The front door: one decision tree (amendment 2026-10-07)
- **H1.** Every Telegram text turn passes one Jev request of six questions: `category` (11 values), `sets_rule`,
  `rule_scope`, and the gear scores `breadth`, `reasoning` and `actions`. On the ladder it is the entry `turn.handler`
  (ack rule → Jev tree → Tiny cascade, the planner its `fail` value), with `turn.gear` a separate entry on the same Jev
  call (ADR 0034).
- **H2.** Lanes are the leaf type. A lane is a handler whose control flow is code, with one one-shot compose; it falls
  through to the planner on any doubt. Every category without a lane runs the planner on its routed model role (Fast,
  Default or Thinking; roles are ADR 0032's). The planner is the floor. Codex stays the self-write writer, untouched.
- **H3.** Below the `category` bar, one cascade call on the Tiny role, bounded at 20 s, picks between Jev's top two
  categories after `memory` and `status` are removed, so a model guess never routes into a no-planner lane. Failure,
  timeout or an answer outside the two means the planner on Default and nothing saved. The verdict's `cascade` is
  `tiny`. Flat-rate legs only.
- **H4.** `jev_verdicts` is the per-turn row (category, scores, rule answers, lane, role, effort, cascade, save / route
  / handler outcomes, reason, skip reason, quoted turn), written in the same transaction as the `triage` event, joined
  to the turn's first model call through `routed_by`, and closed at the run's terminal so none stays `pending`.
- **H5.** A Telegram quote anchors the turn: `chat_turns.quoted_turn_id` resolves a reply to its stored turn, which goes
  into Jev's state and the planner prompt; an unresolved quote is a ledger note (`quote_unresolved`), never a failure.
- **H6.** The routing policy stays under `src/jev/` (`tree-policy.ts`), not `src/policy/`: it produces no allow or deny,
  so it is not gate machinery and not protected. **H7.** A refused-pin step-up records the cause that started the walk,
  so such a verdict reads `escalation`.

### I. Lanes (amendments 2026-10-07, 2026-10-10)
- **I1.** Lanes today: `memory`, `status`, `answer`, `lookup`. `answer` and `lookup`: code owns the steps, one Fast-role
  one-shot composes, no planner session and no tool in the model's hands. A status verdict is handled in code
  (ADR 0013 amendment, L1).
- **I2.** An answer or lookup lane fires only when its row is armed, the
  rule and gear rows are armed, `category` picks it at p ≥ 0.6, the message is no bare ack and no `think harder`, and
  the scores sit inside its limits (answer: `actions` ≤ 0.5 and `breadth` ≤ 1.5; lookup: both ≤ 1.5). Otherwise the
  planner runs, the reason naming why (`routed`, `lane_limits`, `bare_ack_guard`). A lookup that names a URL is the
  planner's (`lane_limits`).
- **I3.** Every lane card (answer, lookup, memory, status) ends with 🔍 Dig deeper (`lane:ask:<run_id>`; the legacy
  `memlane:ask:` still parses). The tap re-runs the message on the planner and labels the lane's verdict `ask_anyway`.
- **I4.** Taps are corrections, not lane faults, and never disarm. Three taps on one lane in seven days open
  `triage_overrides` for that lane (subject `jev:lane:<lane>`), resolved once the count is under three. The kind routes
  to the log, not chat (ADR 0031); a lane that truly fails pages through `lane_fallthrough_rate` (E5).
  **I5.** Two-request guard: a confident memory route whose `actions` level is ≥ 1.5 saves the rule and runs the planner
  (`two_request`) instead of ending at the card.
- **I6.** The reader wall on lookups (ADR 0014): the search result set passes a strict quarantined reader before
  anything composes. The composer sees a code-built `[n] <url>` list and the reader digests, never titles or snippets. A
  thin read (`answer_to_objective` null) fetches the top page once and reads it again. The ledger holds no read text.
- **I7.** A planner turn after lane turns gets a fenced catch-up block of what it missed (at most 6 entries and
  2 000 chars), built from code-written `lane_replies` lines; the lookup lane's prose is never carried.
- **I8.** Records: there is no `lane_failed` reason. A fall-through is the verdict's `lane` + `reason` +
  `route_outcome = fallback` + `handler_outcome = fallthrough:<why>`; the status and memory lanes do not re-label
  `jev_skipped`. `LlmCallRole` has `lane`; `triage_override` carries `lane`. The tree reads the threshold set named by
  `TREE_THRESHOLD_VERSION` (`src/jev/tree-policy.ts`), bumped when a bar or a routing rule changes.

### J. The memory lane and saves (old decision 7 lane 1; amendment 2026-10-17)
- **J1.** A memory instruction on the memory lane is saved on the ticks seat and answered with an undoable
  code-owned card, with no planner turn; the memory shortcut's instant save stays, permanently (ADR 0034 rule 2.2).
  The planner's floor still catches every unsure turn.
- **J2.** `sets_rule` does not gate the memory lane: `category: memory` at the memory bar takes it. The lane asks
  `memory_kind` in its own Jev request, never in the shared tree request. A confident `fix` or `other` hands the turn to
  the planner; `rule` / `fact` / `both` save; Jev failing or below 0.85 leaves the kind to the distill. A Jev outage
  there opens the usual Jev incident and never blocks the save. (The entry is ADR 0034's `memory.kind`.)
- **J3.** Any lane may write a fact: a save-first (`sets_rule` = yes) on the answer, lookup, status and planner routes
  runs through the same service and asks the same `memory_kind` call; there an escape answer abstains, so it never
  suppresses the save. The planner's own `lesson_write` does not ask Jev: the distill decides.
  **J4.** Every save is announced on the memory card with one ↩️ Undo per item (rule: `memlane:undo`, fact:
  `memory:undo`). The run that saved is skipped by the background episodic pass.
  **J5.** A planner-only turn saves at most one lesson; a second `lesson_write` gets `already_saved_this_turn`.

### K. Planned lanes (old decision 7)
Each is its own spec → review → plan → build → live gate: (3) `injection_suspected` on reader-wall output (partly
delivered by ADR 0034's `tool.injection`), then a `risk` score on plain shell commands, both monotone; (4) **redefined
2026-11-09 as `mail.triage`** (spec 2026-11-09-sp2-mail-triage, SP2 slice 1): inbound mail from Paco's own Gmail, triaged
by code floors, his sender rules and one Jev request (`mail_urgency`, `mail_kind`; decision point `mail`, run-less) into
a card now or `/inbox` — the 2026-10-04 lane 4 premises moved (the digest is gone, Houge's own notifications are routed
by code per topic, ADR 0031, and are out of scope; nothing is pushed on a timer; the `wrong urgency` tap makes a sender
rule, announced with undo). What its verdict may cause is ADR 0034 rule 2.6; (5) context relevance, driving lesson
credit (ships armed, ADR 0034 1.6). Lane 1 is I–J; lane 2 (model routing by
judged complexity) is H2 on ADR 0032's roles, and resolving the reader cross-family is ADR 0032's D10.

### L. Rules this ADR places on other ADRs
- **L1. ADR 0013.** "Code owns the gates, the model composes between them" reads: code owns the gates and the
  thresholds; Jev answers typed judgment calls under those thresholds; the model composes between them. Jev may make
  Houge more cautious, never less (B1).
- **L2.** ADR 0014: B6. ADR 0019: E1–E3. AGENTS.md: E6. ADR 0005: lesson credit is defined with lane 5 (K).

## Consequences

- Easier: a judgment call is a question plus a threshold row, not a branch; every decision is replayable from its row;
  Opus quota goes to turns that need it; SP2's inflow lands on the ladder as `mail.triage` (K).
- Harder: thresholds are a maintained artefact (per question, hash, language); a criteria edit is a calibration event;
  CJK needs its own evidence per question; one more provider in the audit, one more secret in the broker's use.
- Accepted risks: Jev is steerable by injected text (labels stay advisory or monotone, so steering degrades quality,
  never safety); US retention of chat text under a self-serve account; a lane false positive swallows a question for
  one turn (bars, Dig deeper, the catch-up block); the memory lane is not faster than the planner, only cheaper and
  deterministic; research read as lookup routes some research turns to Fast instead of Thinking.
- Revisit when: TypeSafe ships adversarial hardening or a retention commitment; Jev volume makes the metered ceiling
  bind; omp exposes per-turn tool toggling or native skills; SP3's quota invariant lands (lane 2 v2 reads 7-day utilisation); `actions`
  proves blind to a second request (then a seventh `noul` question, parked).

## Alternatives considered

- **Jev for memory only:** rejected by Paco; the same layer serves every lane. **Jev as a security gate:** rejected;
  the vendor disclaims adversarial robustness, Jev read a credential-exfil request as benign in the replay, and the hard
  lines are code-owned (kept as a monotone pre-gate only).
- **Kimi one-shot as the decider:** kept as the fallback below the Jev floor and the composer inside lanes; rejected as
  System One (1–5 s, no probability distribution, poorly calibrated verbal confidence, equally injectable).
- **Local classifier (embeddinggemma centroids):** right for near-duplicate and novelty checks; cannot read boundary
  rules; needs labelled examples Houge lacks. **omp's `--thinking auto`:** thinking-level only, coding-shaped, and would
  put `TYPESAFE_API_KEY` in the sandboxed child's environment (ADR 0015).
- **Route-and-inform for the memory lane:** Paco chose skip; other routes save first and run the planner, and the
  catch-up block closes the transcript gap. **A pinned Jev version:** rejected 2026-10-07; the alias and version check.

## History

| date | what changed | spec | signed by Paco on |
|---|---|---|---|
| 2026-10-04 | ADR 0029: System One layer, decisions 1–7 | [jev-system-one](../superpowers/specs/2026-10-04-jev-system-one-design.md) | 2026-10-04 (design), accepted 2026-10-06 |
| 2026-10-06 | Amendments to 0013, 0014, 0019, AGENTS.md (L1–L2, E6); build notes (per-call client, skip rate, calibration file); lane 1 armed on Paco's word, decision 5 no longer an arming gate | same | 2026-10-06 |
| 2026-10-07 | Alias `jev-latest`; version move checked by code; drift pages | same | approved (date not recorded) |
| 2026-10-07 | One decision tree; lanes as the leaf type; `jev_verdicts`; Tiny cascade; lane 1's three questions retired | [decision-tree](../superpowers/specs/2026-10-06-jev-decision-tree-design.md) | 2026-10-09 |
| 2026-10-09 | Tree armed on Paco's word (14 rows); probability-sum tolerance scales with option count | same | 2026-10-09 |
| 2026-10-10 | Stage B: answer and lookup lanes, Dig deeper, taps page and never disarm (replaced the auto-disable marker), two-request guard, reader wall on lookups, catch-up block, `HOUGE_JEV_LANES_OFF` | [stage-b](../superpowers/specs/2026-10-10-jev-tree-stage-b-design.md) | 2026-10-10 |
| 2026-10-12 | ADR 0030: front door is `turn.handler`; decision 2 applications; one deny-path exception; R11 egress replaces per-class approval; no shadow for new entries; golden or stale-bar drift pages instead of disarming; added-tap budget counts trust asks | [decision-ladder](../superpowers/specs/2026-10-12-decision-ladder-design.md) | 2026-10-12 |
| 2026-10-17 | Memory lane writes rules and facts on `memory_kind`; any lane may write a fact | [memory-write](../superpowers/specs/2026-10-15-memory-write-thread-anchor-design.md) | asked for 2026-10-17 |
| 2026-10-23 | Version check built: drift disarms only drifting triage questions; Accept re-anchors (decision 5 edited in place, no dated section) | [version-check](../superpowers/specs/2026-10-22-jev-version-check-design.md) | 2026-10-23 |
| 2026-11-03 | ADR 0031: `triage_overrides` to the log; outage kinds and `jev_skip_rate` still page; version-check kinds are cards | [chat-is-for-paco](../superpowers/specs/2026-11-03-chat-is-for-paco-design.md) | 2026-11-04 |
| 2026-11-04 | Consolidated into this ADR, no change of meaning | — | 2026-11-05 |
| 2026-11-04 | Version-drift wording (F3–F4): ADR 0029 decision 5 said a drift "disarms only the drifting triage questions"; ADR 0030 decision 9 said it "disarms the failing questions and their dependents, pages once with Accept, and arms again on Paco's tap". This ADR states 0030's form, with Accept making the new answers the reference | [version-check](../superpowers/specs/2026-10-22-jev-version-check-design.md) | 2026-11-05 |
| 2026-11-05 | No off switch, no shadow: front-door shadow, HOUGE_JEV_LANES_OFF and HOUGE_JEV_TRIAGE_ENABLED removed; HOUGE_JEV_ENABLED is the front door's STOP flag; F7's live-shadow-stats clause named a reader no code had | [no off switch](../superpowers/specs/2026-11-05-jev-no-off-switch-no-shadow-design.md) | 2026-11-06 |
| 2026-11-06 | Drift rewording, no change of meaning: golden sets run as ticks, not in the sweep (A3); `TREE_THRESHOLD_VERSION` no longer pinned to a stage-B value (I8) | — | 2026-11-06 |
| 2026-11-09 | SP2 mail triage: lane 4 redefined as `mail.triage` (K); the mail egress class `MailJevState` approved by Paco (D2, his D3); mail outages page through the Jev incidents plus `mail_jev_failing` (E5); run-less entries write no `jev_decisions` row (A3) | [sp2-mail-triage](../superpowers/specs/2026-11-09-sp2-mail-triage-design.md) (Rev 1.3.1) | awaiting Paco's signature |

## Reference map

Code and docs cite ADR 0029 by decision number and by `§` numbers. The `§` numbers are sections of the 2026-10-04 spec
(ADR 0029 itself had no sections), except `§2`, which means decision 2.

| old locator | new location |
|---|---|
| decision 1 / spec §3, §3.1, §3.2 (library, `decide()`) | A1–A3 |
| decision 2, `§2`, "monotone rule", "decision 2: ask := code_ask ∨ …", "three added taps a local date", spec §4 | B1–B5 |
| decision 3 / decision 4, spec §4.5 (egress redaction) | C1–C2 / D1–D2 |
| decision 5, "decisions 1 and 5", spec §3.5 (`CALIBRATED_ROWS`), §3.7 (golden set, skip rate) | F2–F4, G1–G6, E4 |
| decision 6 / decision 7 (lane order), "lane 2" | E1–E3 / H2, J1, K |
| spec §3.3 (client, outage incidents) / §3.4 (`jev_decisions`), "ledger events", "events require their enum/number fields", "the ADR 0029 case" (that test) | E2–E3 / A3, H4 |
| spec §3.6 (replay harness), "§3.6 parity" (state parity) / §3.8 (flags) | A3 (parity clause), F7 / G6, I2 |
| spec §5 (the decision before the planner), "stage A tree + stage B lanes" | H, I, J |
| spec §5.1 slot A (bare ack while an approval card waits) | ADR 0034 `intake.bare_ack` |
| spec §5.1 slot B (triage before the planner); "lane 1 slots" (both) | H1–H2, C2 (+ slot A row) |
| spec §5.5 (memory lane, lesson-write service), "§5.5, R12" | J1–J5; ADR 0034 R12 |
| spec §5.6, "stage B §6" (card, Undo, Dig deeper) / §5.8 (ledger, incidents, flags) | I3, J4 / A3, E2, H4 |
| amendments 2026-10-06 (lane 1 armed) / 2026-10-07 (alias) | G1 / F1–F7 |
| amendments 2026-10-07 (one decision tree) / 2026-10-09 (tree armed) | H1–H7, C2, E5 / G4, A4 |
| amendments 2026-10-10 (stage B) / 2026-10-12 (decision ladder) | I1–I8, G4, G6 / B3–B4, D2, G3, H1 |
| amendments 2026-10-17 (rules and facts) / 2026-11-03 (chat is for Paco) | J2–J4 / E2, E4, F6, I4 |
| "Amendments to prior ADRs" (0013, 0014, 0019, AGENTS.md); line cites `ADR 0029:126` (AGENTS.md line), `:226–227` (lane fall-through, skip rate) | L1–L2, E6; E5, E4 |
