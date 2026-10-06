# Jev decision tree — categories, lanes and model roles (ADR 0029 lane 2, widened)

- **Date:** 2026-10-06 · **Rev 1** · **Status:** design approved in conversation; awaiting Paco's read of this text
- **Amends:** [ADR 0029](../../decisions/0029-jev-system-one.md) (the lane-1-first shape becomes one decision tree; lanes
  are the leaf type), [ADR 0028](../../decisions/0028-omp-runtime.md) (model roles replace the `HOUGE_OMP_*` chains;
  D10 reader family resolved at read time)
- **Supersedes:** spec [2026-10-04 §6.1 "Lane 2 — model routing"](2026-10-04-jev-system-one-design.md) and the lane 1
  question set in §5 of that spec (the memory and status lanes themselves are kept)
- **Inputs:** research [02-model-routing-lane.md](../research/2026-10-04-jev-lanes/02-model-routing-lane.md); mu
  ([qybaihe/mu](https://github.com/qybaihe/mu), MIT), read 2026-10-06: its `input.preflight`, `swarm.routing`,
  `cascade.ts`, wording rules and the 2026-09-21 retrospective; live DB counts (305 Telegram turns since 2026-07-02)

## 1. Why this shape (Paco's rulings, 2026-10-06)

1. **One tree, not "lane 1, else lane 2".** Lane 1 shipped as "is this memory or status? if not, the planner". That is
   a compromise of what had been built, not a design. The front of Houge is one decision point: *message → what
   kind of work is this → the handler for that kind*, with memory as one branch among equals. Learning from mu means
   taking its shape (one judged question set per message, many bounded decision points, every verdict in a ledger),
   not its coding-agent categories.
2. **Lane vs planner is "who decides the next step", not "how hard".** "明天天气怎么样" and "帮我安排台湾12天行程" both need
   an LLM and tools. The first has a fixed step list that code can write down before anything runs (build the query,
   search, maybe fetch, compose); the model only fills in words. The second cannot be written down: each search
   depends on what the previous one found, and the model must choose the next tool, how many times, and when to
   stop. A **lane** is a workflow whose control flow is code; the **planner** (Houge's omp agent session, which runs
   every turn today) is the handler whose control flow is the model's. Lanes are cheaper, faster, deterministic and
   testable; the planner is the floor under all of them.
3. **No hand-written model chains in `.env`.** Houge is a product in production, not a lab. OpenClaw and Hermes ask
   their users for a primary model plus fallbacks or task slots; omp, Houge's own runtime, already has named model
   **roles** (Default, Fast, Thinking, …) resolved from preference lists against the signed-in accounts, so a retired
   model (Opus 4 → 5.5 happened in months) is a list update, not an operator edit. Houge routes to roles; omp's
   resolution, Paco's `/models` overrides in the DB, and a daily change notice replace the seven `HOUGE_OMP_*` chains.
4. **Arm on Paco's word, evidence while armed.** As for lane 1 (ADR 0029 amendment 2026-10-06): a replay sanity check
   informs the decision; no shadow period gates it. Every per-turn bar still sends an unsure turn to today's path.
5. **`research` keeps its name.** Houge already uses that word for this kind of turn: the lesson *scope* `research`
   means "lessons that steer research turns". One word for one kind of turn. The 2026-10-02 confusion was the lesson
   *theme* `research` reading as the scope; that theme is now `sources`. Three lists, three meanings: category
   `research` (a turn), scope `research` (which lessons apply), theme `sources` (what a lesson is about).

## 2. The decision point

Runs once per Telegram text turn, before any handler, replacing lane 1's triage call (same slot in
`planner-supervisor.startTurn`, same `decide()` path, same egress envelope Paco approved for lane 1).

### 2.1 Code before the judge (no Jev call)

- A turn that lands while an approval card is open keeps today's code-owned "tap Approve" nudge (`ack_nudged`).
- A greeting or bare thanks/ack ("谢谢", "ok", "👍") **after a plain answer** → category `answer`, Fast role.
  The rule reads the previous Houge turn: after a question or a proposal it does not apply; Jev classifies.
- `think harder` / `认真想` / `ultrathink` anywhere in the message → Thinking role for the turn; Jev still classifies.

### 2.2 State (code-observed facts only)

`latest_message`, `recent_turns` (the thread as the planner would see it, sanitised and broker-redacted),
`modality`, `last_houge_turn { kind: answer | clarify | proposal, age_s }`. `proposal` is a code regex over the previous
Houge reply (ends in a question, or contains an offer such as 要不要 / 我可以 / approve). Nothing model-authored.

### 2.3 Questions (one request; wording per mu's measured rules: one predicate each, state fields in backticks, an escape option)

| id | type | question | answers |
|---|---|---|---|
| `category` | choice | What work does `latest_message` ask Houge to do? If `latest_message` only agrees to, picks or continues something Houge offered in `recent_turns`, answer for that offered work. | the 11 categories of §3 |
| `sets_rule` | boolean | Does `latest_message` state a rule for Houge to follow from now on? | p(yes) |
| `rule_scope` | choice | Is that rule about how Houge answers, or about how Houge researches? | `ask`, `research` |
| `breadth` | score | How much ground does `latest_message` cover? | one known thing · one topic · several topics · open-ended |
| `reasoning` | score | How much careful reasoning does answering need? | recall · straightforward · non-obvious analysis · deep multi-factor |
| `actions` | score | How many tool actions does it need? | none · one or two reads · several including changes · many with checks |

All six ride one request. `rule_scope` is read only when `sets_rule` is yes; its default is the category (`research` →
`research`, else `ask`), and Jev's answer overrides it only at p ≥ 0.6.

### 2.4 Policy (code)

- **Bars by answer type** (mu): a choice counts at p ≥ 0.6; a boolean is three-zone (yes ≥ 0.8, no ≤ 0.2, unsure
  between); a score is its expected level. The two no-planner branches keep lane 1's stricter bars: `memory` p ≥ 0.85
  and `status` p ≥ 0.8, with lane 1's confidence and gap floors.
- **Guards:** a bare acknowledgement can never enter `memory` or `status` (if Jev says so, the turn goes to the
  planner). `self_change`, `machine_task`, `schedule`, `mail_calendar` never run below the Default role.
- **Gear** = the highest of the three scores: ≤ 1.2 light, < 2.5 standard, else heavy → Fast / Default / Thinking.
  `reasoning` sets the effort level (low / medium / high) on that role.
- **Lane limits:** a lane-shaped category whose scores exceed its lane's limits (§3) goes to the planner.
- **Cascade below the bar (mu idea 6):** when `category`'s top answer is under 0.6, one Kimi one-shot on the ticks seat
  picks between Jev's top two **planner** categories (a model guess can never route into a no-planner lane). Kimi
  failing or unsure → planner, Default. Its verdict is ledgered on the decision row as `cascade: kimi`.
- **Jev down, skipped, or any failure anywhere** → planner on the Default role: today's behaviour, one ledger row,
  every outage class paging as now.

## 3. Categories and lanes

A **lane**: code owns the steps; one one-shot model call composes on the role and effort §2.4 picked, with the thread,
lessons and relevant facts rendered as the planner gets them today; no planner session, no transcript, no tool
schemas. Every lane reply is a card with **Ask Houge anyway**. Any failure (tool error, empty result, compose
failure, cap) falls through to the planner with a ledger row naming the reason. A lane never asks Paco anything;
anything needing an approval is not a lane.

| # | Category | Meaning | Lane | Lane limits (else planner) | Role floor |
|---|---|---|---|---|---|
| 1 | `answer` | chat, an explanation, an opinion, writing; nothing to fetch or do | **answer lane**: compose from the thread | `actions` = none | Fast |
| 2 | `lookup` | one fact or item a search answers | **lookup lane**: code builds the query; `web_search`; fetch the top page through the reader wall when snippets will not do (a how/why question, or a dated page); compose with a source line | `breadth` ≤ one topic, `actions` ≤ a few reads | Fast |
| 3 | `research` | investigate a topic: several sources, compare, conclude, recommend | planner | — | Thinking |
| 4 | `memory` | save, correct or retire a lesson or fact | **memory lane** (as built: distill → reconcile → save in one transaction; card with Undo) | — | ticks seat |
| 5 | `self_change` | change or diagnose Houge itself | planner | — | Default |
| 6 | `machine_task` | shell, files, a project on the Mac | planner | — | Default |
| 7 | `schedule` | create, change or cancel a scheduled job or reminder | **schedule lane**: one-shot extracts goal, cadence and time zone as JSON → code validates → `schedule_task`; cancel/change by matching an existing schedule | — | Default |
| 8 | `wiki` | build or refine a wiki page | **wiki lane**: topic → `wiki_build` / `wiki_refine` | — | Default |
| 9 | `mail_calendar` | Gmail and Calendar | planner until SP2 defines its lane | — | Default |
| 10 | `status` | Houge's own state: restart, version, health | **status lane** (as built) | — | — |
| 11 | `other` | none of the above | planner | — | Default |

**`sets_rule` = yes with any category:** the memory lane saves first (scope from `rule_scope`), then that category's
handler runs; a planner turn carries the `[memory]` note as the mixed path does today. Not durable, or refused by the
cap: nothing saved, the turn proceeds as if `sets_rule` were no. `memory` alone ends at the card.

**Why `research` is the planner, not a lane:** it is the one workflow whose steps are not known in advance (which
sources, how many, when to stop) and whose results Paco judges most. Houge's older code-owned research program
(`/run`) still exists; whether it becomes a research lane on the routed role is a stage-C decision from the ledger.

## 4. Model roles

| Houge seat | omp role | Effort |
|---|---|---|
| planner / compose, light gear | Fast (`smol`) | from `reasoning` |
| planner / compose, standard gear | Default | from `reasoning` |
| planner / compose, heavy gear | Thinking (`slow`) | from `reasoning` |
| reader (web and mail reads) | Fast, resolved **cross-family** at read time (ADR 0028 D10 fix: the first candidate whose family differs from the planner's current family) | low |
| media | Vision | low |
| ticks (distill, reconcile, digests, the cascade) | Tiny | low |
| self-write council (judges, chair, reviewer) | Thinking / Advisor | unchanged |

**Resolution**, in order: (1) Paco's override for the role (DB, set by `/models`); (2) the role's preference list
matched against the models omp reports available for profile `houge` (`get_available_models` over RPC); (3) filtered
to subscription providers only (Anthropic, Antigravity, Kimi, Codex) — a metered provider is never auto-picked
(AGENTS.md flat-rate invariant). The result is an ordered candidate list; a failure walks the list, an exhausted role
steps up (Fast → Default → Thinking); any error on a routed turn steps up, including Kimi's `other` class, a dead end
today. Codex stays the self-write writer only; no chat turn is ever routed to it.

**Open for spec review (probe the real omp):** whether (2) reuses omp's own resolver and `priority.json` lists, or a
small Houge-side list of name patterns per role matched against the same RPC list. `set_model` over RPC takes an exact
`provider/id`, so Houge resolves before pinning either way.

**Change notice:** a daily tick resolves every role and diffs against the stored result. Changed → one Telegram line
("Thinking now resolves to X, was Y"), ledgered. No candidate → incident `role_unresolved`, turns step up.

**`/models`:** `/models` lists role → model, effort, default or override; `/models set <role> <pattern>` checks the
pattern against the available list before saving; `/models reset <role>`. Every change is a ledger row. The seven
`HOUGE_OMP_*` chain variables are removed from `.env` and `configuration.md`; `HOUGE_OMP_BIN` and the profile stay.

## 5. The planner lane: a turn-owned chain

Today the supervisor indexes one global chain for pinning and retries (`promptTop`, `retryNextLeg`, `legIndex`). Each
turn now carries its own ordered candidate list from §4.

- **Cold spawn:** the child starts on the Default role's first candidate (omp rejects an unknown `--model` at start);
  the turn's first candidate is applied by the same `set_model` frame that re-pins after a resume today, plus
  `set_thinking_level` from `reasoning`. One frame, no respawn.
- **Retries** walk the turn's list, then step up a role. `noteActualModel` audits against the turn's list.
- **Failed pin** (`planner_model_reset_failed`): answer on the model the child holds, incident as today, decision row
  marked `pin_failed`; no escalation on a child that just refused a pin.
- **Mid-turn escalation** to the next role up, one frame (one ~50K cache re-write): a Fast turn that emits a tool
  call; the planner asking through a code-owned marker; omp's classified `model_refusal` frame. Never a text heuristic
  over a normal answer. Ledgered `routed_escalation {from, to, kind}`.

## 6. Ledger and corrections

`jev_decisions` rows widen (migration): `category`, `breadth`, `reasoning`, `actions`, `lane`, `role`, `effort`,
`model`, `cascade`, plus the existing status / decision / instants. The `triage` event carries `category`, `lane`,
`role` and the `verdict`. The first `llm_attempt` of a routed turn carries `routed_by` (the decision id), so a routed
turn's cost and errors join to its decision. Corrections ledgered on the row as `paco_correction`: an Ask Houge anyway
tap, `think harder` on the next turn, an escalation, a session rating ≤ 1. This is the verdict → action → outcome chain
mu's retrospective found missing.

## 7. Calibration and the replay

New question hashes → new `CALIBRATED_ROWS` per question and language, committed on Paco's word after the replay.
The replay (`houge jev replay triage`, extended to the full set) rebuilds each of the ~300 Telegram turns at its live
instant (the recorded `thread_cut_at` / `state_built_at`) and asks once. Proxy label per turn from the tools the
planner used: none → `answer`; `web_search` only and ≤ 2 steps → `lookup`; ≥ 3 steps or `wiki_build` → `research`;
`self_*` → `self_change`; `schedule_task` → `schedule`; `lesson_write` / `memory_correct` → `memory`; `houge_status`
→ `status`. Report: the category confusion matrix, score distributions per proxy, permutation agreement, and three
costly cells — anything wrongly into `memory` / `status` (a swallowed turn), `self_change` / `machine_task` rated
light (under-powered), lane-shaped turns sent to the planner (cost only). Evidence for Paco's decision; the labelling
CLI stays for tuning the bars.

## 8. Safety nets

Kept: every Jev outage class pages (`jev_*`); `jev_skip_rate`; Ask Houge anyway as the correction label, with the
3-in-7-days auto-disable left as built (Paco, 2026-10-06). New sweep invariants: `lane_fallthrough_rate` (a lane that
falls through on half or more of ≥ 3 turns in 24 h is broken, not quiet; sticky until a lane turn succeeds) and
`role_unresolved`. Model-resolution changes are a notice, not an incident.

## 9. Tests and live gates

- **Policy** as a table: answers → lane, role, effort, including every guard and every bar edge.
- **Each lane** hermetic with a stubbed search / one-shot: success, empty result, compose failure, cap, and the
  fall-through row; the card's buttons.
- **Role resolver** against a fake available-model list: override, retirement, a metered provider excluded, step-up on
  an empty role, the change notice.
- **Supervisor:** cold spawn, pin, retry walk, failed pin, the three escalation triggers, audit against the turn's list.
- **Migration** of the widened rows; the replay's proxy labels; the cascade's category restriction.
- **Live gate per stage** (`scripts/live-gate-jev-tree.mjs`, DB copy, real Jev, real one-shots): one turn per lane, one
  that overflows its lane, a bare "好" after a proposal, a `sets_rule` turn on a lookup, the parity and skip-rate
  cases, and role resolution against the real omp model list of profile `houge`. Cases judge by the recorded verdict
  (INCONCLUSIVE when Jev's call takes another path, never a false FAIL).

## 10. Staging

One spec; a plan, a build and a live gate per stage. Arm each stage on Paco's word after its replay.

- **A** — the decision point, roles and `/models`, the planner lane with the turn-owned chain; memory and status
  re-attached to the tree. Every other category goes to the planner on its role: the only visible change is which
  model answers.
- **B** — the `answer` and `lookup` lanes (58% of past turns).
- **C** — the `schedule` and `wiki` lanes; the research-lane question, from stage A/B rows.
- `mail_calendar` lands with SP2.

## 11. Docs on ship

ADR 0029 amendment (tree, lanes as the leaf type, roles) and ADR 0028 amendment (config, D10); `configuration.md`
(`HOUGE_OMP_*` chains removed, `/models`, new incidents and ledger fields); `jev-decision-layer.md` rewritten around
the tree; CONTEXT.md terms *category*, *lane*, *role*; README; `tasks/todo.md`, `sessions.md`.

## Appendix A. Parked from mu for later lanes

| mu idea | For | Note |
|---|---|---|
| `tool.injection`: one yes/no per passage, batched, withhold over 0.5 with a note in place; wording measured at 70/79 planted attacks caught vs 11 for a pattern scan, 0/1,520 clean passages withheld | lane 3 | monotone (adds caution only); ported wording is MIT, attribute |
| `notify.routing`: tell now / later / never | lane 4 (inbound triage, digest) | the shape of the digest decision |
| `memory.applied`: was each recalled lesson followed; a lesson recalled often and never followed retires | lane 5 (credit, stage C memory) | `memory.merge` is **not** taken: ADR 0029 rules out Jev-decided reconcile verdicts |
| `turn.continue` (a run that ends on "next I'll…" is sent back, never toward a hard-to-undo step) and `turn.completion` (was "done" verified) | SP4 | |
| Retrospective lessons: rules filter before the judge (their output screening spent 54% of Jev input and dropped nothing); verdict → action → outcome per decision point | applied here (§2.1, §6) | |

## Appendix B. Rejected

- **Jev classifies, Kimi picks effort:** a second judgment with no probabilities to threshold or calibrate, 1–5 s on
  every planner turn.
- **omp's `--thinking auto` inside the child:** thinking level only (no Opus-cap relief), coding-shaped criteria, and
  the Jev key in the sandboxed child (ADR 0015). Already rejected in ADR 0029.
- **Per-turn chains in `.env` by gear:** operator edits for every model change; §1 ruling 3.
- **A one-line category hint in the planner prompt** (mu's preflight hint): the planner has the full message and
  tools; a wrong hint steers. Revisit from the ledger.
