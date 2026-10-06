# Jev decision tree — categories, lanes and model roles (ADR 0029 lane 2, widened)

- **Date:** 2026-10-06 · **Rev 3** (two reviews and their confirmation passes folded in; see §12) · **Status:** awaiting Paco's read
- **Amends:** [ADR 0029](../../decisions/0029-jev-system-one.md) (the lane-1-first shape becomes one decision tree; lanes
  are the leaf type), [ADR 0028](../../decisions/0028-omp-runtime.md) (model roles replace the `HOUGE_OMP_*` chains;
  D10 reader family becomes a skip rule at read time)
- **Supersedes:** spec [2026-10-04 §6.1 "Lane 2 — model routing"](2026-10-04-jev-system-one-design.md) and the lane 1
  question set in §5 of that spec (the memory and status lanes themselves are kept)
- **Inputs:** research [02-model-routing-lane.md](../research/2026-10-04-jev-lanes/02-model-routing-lane.md) and
  [00-jev-capabilities.md](../research/2026-10-04-jev-lanes/00-jev-capabilities.md); mu
  ([qybaihe/mu](https://github.com/qybaihe/mu), MIT), read 2026-10-06: `input.preflight`, `swarm.routing`,
  `cascade.ts`, the wording rules and the 2026-09-21 retrospective; the live DB (305 Telegram runs since 2026-07-02;
  397 user chat turns including steered and nudged ones); `omp --profile houge models --json` (probed 2026-10-06)

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
   **roles** (Default, Fast, Thinking, …) resolved from preference lists against the available models, so a retired
   model (Opus 4 → 5.5 happened in months) is a list update, not an operator edit. Houge routes to roles. The seven
   `HOUGE_OMP_*` chains move from configuration into code-owned role lists (reviewed in pull requests, never edited
   on the mini), with Paco's `/models` overrides in the DB and a daily change notice.
4. **Arm on Paco's word, evidence while armed.** As for lane 1 (ADR 0029 amendment 2026-10-06): a replay sanity check
   informs the decision; no shadow period gates it. Every per-turn bar still sends an unsure turn to today's path.
5. **`research` keeps its name.** Houge already uses that word for this kind of turn: the lesson *scope* `research`
   means "lessons that steer research turns". One word for one kind of turn. The 2026-10-02 confusion was the lesson
   *theme* `research` reading as the scope; that theme is now `sources`. Three lists, three meanings: category
   `research` (a turn), scope `research` (which lessons apply), theme `sources` (what a lesson is about).

## 2. The decision point

Runs once per Telegram text turn, before any handler, replacing lane 1's triage call (same slot in
`planner-supervisor.startTurn`, same `decide()` path and `settleTriage` finaliser, same egress envelope Paco approved
for lane 1: the latest message ≤ 8K chars, the thread, ≤ 24K chars per request).

### 2.1 Code before the judge (no Jev call)

- A turn that lands while an approval card is open keeps today's code-owned "tap Approve" nudge (`ack_nudged`).
- A greeting or bare thanks/ack ("谢谢", "ok", "👍") **after a plain answer** → category `answer`, Fast role. The rule
  reads the previous Houge turn: after a question or a proposal it does not apply; Jev classifies.
- `think harder` / `认真想` / `ultrathink` anywhere in the message → Thinking role for the turn; Jev still classifies.

### 2.2 State (code-observed facts only)

`latest_message`, `recent_turns` (the thread as the planner would see it, sanitised and broker-redacted),
`modality`, `last_houge_turn { kind: answer | clarify | proposal, age_s }`. `kind` is computed **at read time** from the
stored previous Houge reply: `clarify` is the stored intent; `proposal` is a code regex over the text (an offer such as
要不要 / 我可以 / 需要我 / approve, or a trailing question after a tool run); the stored `chat_turns.intent` enum
(`clarify | loop`) is not widened, since it feeds the clarify cap. Nothing model-authored.

### 2.3 Questions (one request)

Wording follows mu's measured rules: one predicate per question, state fields in backticks, no "and/or", an escape
option on every choice. TypeSafe's three types are used by their wire names (00-jev-capabilities.md): `choice`
(answers with `choice`, `probabilities`, `confidence`), `score` (ordered levels; answers with `score`, `probabilities`,
`confidence`) and `noul` (yes/no; answers with `noul` = p(yes) and **no `confidence`**).

| id | type | question | answers |
|---|---|---|---|
| `category` | choice | What work does `latest_message` ask Houge to do? If `latest_message` only agrees to, picks or continues something Houge offered in `recent_turns`, answer for that offered work. | the 11 categories of §3 |
| `sets_rule` | noul | Does `latest_message` state a rule for Houge to follow from now on? | p(yes) |
| `rule_scope` | choice | Is that rule about how Houge answers, or about how Houge researches? | `ask`, `research` |
| `breadth` | score | How much ground does `latest_message` cover? | one known thing · one topic · several topics · open-ended |
| `reasoning` | score | How much careful reasoning does answering need? | recall · straightforward · non-obvious analysis · deep multi-factor |
| `actions` | score | How many tool actions does it need? | none · one or two reads · several including changes · many with checks |

All six ride one request. `rule_scope` is read only when `sets_rule` is yes; its default is the category (`research` →
`research`, else `ask`), and Jev's answer overrides it only at p ≥ 0.6.

**Client and rows.** `Question` becomes a discriminated union over the three types; `criteriaHash` covers each shape;
`validateAnswer` is per type (a `noul` outside [0, 1], a `score` outside its levels, a `choice` not the argmax → the
whole call is `skipped{parse}`, never partial). `decide()` persists per type: `choice` as today; `score` with
`answers_json` = the level probabilities and `confidence`; `noul` with `answers_json = {true: p, false: 1 − p}`,
`confidence` null, `margin = |2p − 1|`. The replay rows and the report generalise over the union before the §7 replay
runs (today's `p_memory / p_status / p_none` columns become per-question records).

### 2.4 Policy (code)

- **Bars by answer type** (mu): a choice counts at p ≥ 0.6; a `noul` is three-zone (yes ≥ 0.8, no ≤ 0.2, unsure
  between); a score is its expected level. The two no-planner branches keep lane 1's stricter bars: `memory` p ≥ 0.85
  and `status` p ≥ 0.8, with lane 1's confidence and gap floors.
- **Guards:** a bare acknowledgement can never enter `memory` or `status` (if Jev says so, the turn goes to the
  planner). `self_change`, `machine_task`, `schedule`, `mail_calendar` never run below the Default role. `memory` with
  `sets_rule` = no (a correction or retirement of a stored memory, not a new rule) goes to the planner, whose
  `memory_correct_write` path holds the approval card (ADR 0028, 2026-10-02): the lane saves rules only.
- **Gear** = the highest of the three scores: ≤ 1.2 light, < 2.5 standard, else heavy → Fast / Default / Thinking.
  `reasoning` sets the effort level (low / medium / high) on that role.
- **Unsure is no:** a `sets_rule` in the unsure zone saves nothing and routes by category alone (`memory` + unsure →
  the planner, like a correction). A category under its bar with no cascade candidate left (the top two were `memory`
  and `status`) → planner, Default.
- **Lane limits:** a lane-shaped category whose scores exceed its lane's limits (§3) goes to the planner.
- **Cascade below the bar (mu idea 6):** when `category`'s top answer is under 0.6, one Kimi one-shot on the Tiny role
  picks between Jev's top two categories **after removing `memory` and `status`** (a model guess can never route into
  a no-planner lane); if only one remains it is taken without a call. Kimi failing or unsure → planner, Default. The
  verdict is ledgered on the turn row as `cascade: kimi`.
- **Jev down, skipped, or any failure anywhere** → planner on the **Default role as resolved** (§4, Paco's override
  included). That is "today's behaviour" once stage A ships; the Default role's code list *is* today's planner chain.
  One ledger row; every outage class pages as now.

## 3. Categories and lanes

A **lane**: code owns the steps; one one-shot model call composes on the role and effort §2.4 picked, with the thread,
lessons and relevant facts rendered as the planner gets them today (`buildSystemPrompt`); no planner session, no
transcript, no tool schemas. Every lane reply is a card with **Ask Houge anyway**. Any failure (tool error, empty
result, compose failure, cap) falls through to the planner with a ledger row naming the reason. A lane never asks Paco
anything; anything needing an approval is not a lane.

| # | Category | Meaning | Lane | Lane limits (else planner) | Role floor |
|---|---|---|---|---|---|
| 1 | `answer` | chat, an explanation, an opinion, writing; nothing to fetch or do | **answer lane**: compose from the thread | `actions` = none | Fast |
| 2 | `lookup` | one fact or item a search answers | **lookup lane**: code builds the query; `web_search`; fetch the top page through the reader wall when snippets will not do (a how/why question, or a dated page); compose with a source line | `breadth` ≤ one topic, `actions` ≤ a few reads | Fast |
| 3 | `research` | investigate a topic: several sources, compare, conclude, recommend | planner | — | Thinking |
| 4 | `memory` | a rule or preference to follow from now on; or correct / retire a stored lesson or fact | **memory lane** for a rule (as built: distill → reconcile → save in one transaction; card with Undo); the planner for a correction or retirement (`sets_rule` = no), where the approval card lives | — | Tiny seat |
| 5 | `self_change` | change or diagnose Houge itself | planner | — | Default |
| 6 | `machine_task` | shell, files, a project on the Mac | planner | — | Default |
| 7 | `schedule` | create, change or cancel a scheduled job or reminder | **schedule lane** (stage C): one-shot extracts goal, cadence and time zone as JSON → code validates → `schedule_task`. A change or cancel names a task: by its id when quoted, else a one-shot picks among the chat's enabled `scheduled_tasks` at p ≥ 0.8; below that the planner takes it (a lane never asks) | — | Default |
| 8 | `wiki` | build or refine a wiki page | **wiki lane** (stage C): topic → `wiki_build` / `wiki_refine` | — | Default |
| 9 | `mail_calendar` | Gmail and Calendar | planner until SP2 defines its lane | — | Default |
| 10 | `status` | Houge's own state: restart, version, health | **status lane** (as built) | — | — |
| 11 | `other` | none of the above | planner | — | Default |

**`sets_rule` = yes with any category:** the memory lane saves first (scope from `rule_scope`), then that category's
handler runs; a planner turn carries the `[memory]` note as the mixed path does today. Not durable, or refused by the
cap: nothing saved, the turn proceeds as if `sets_rule` were no. `memory` + `sets_rule` = yes ends at the card.

**Why `research` is the planner, not a lane:** it is the one workflow whose steps are not known in advance (which
sources, how many, when to stop) and whose results Paco judges most. Houge's older code-owned research program
(`/run`) still exists; whether it becomes a research lane on the routed role is a stage-C decision from the ledger.

## 4. Model roles

| Houge seat | Role | Effort | Eligible providers |
|---|---|---|---|
| planner / compose, light gear | Fast | from `reasoning` | chat set |
| planner / compose, standard gear | Default | from `reasoning` | chat set |
| planner / compose, heavy gear | Thinking | from `reasoning` | chat set |
| reader (web and mail reads) | Reader: its own list (today's reader chain), chosen **cross-family** at read time | low | chat set + Codex |
| media | Vision | low | chat set |
| ticks (distill, reconcile, digests, the cascade) | Tiny | low | chat set |
| self-write council | Judges (an indexed list, today's judges chain, one seat per judge), Chair, Reviewer: three roles | unchanged | chat set + Codex |

**Resolution is Houge's, in code.** omp's own resolver is internal (`resolveRoleChain` is not reachable over RPC;
`get_available_models` returns models, not roles), omp has no preference list for Default or Vision, and its Fast and
Thinking lists include Codex models. So each role has a **code-owned ordered list of exact selectors** (`provider/id[:effort]`, no fuzzy matching) in
`src/omp/model-roles.ts`
(today's `DEFAULTS` chains in `omp-config.ts` become these lists: Default = today's planner chain, Tiny = `kimi-code/k3`
first so the armed memory lane keeps its model, Reader = today's reader chain, Vision = today's media chain; Judges, Chair and
Reviewer = today's three council chains, kept separate so judge diversity and the reviewer's head do not change). omp's `priority.json` is reference for maintaining the lists, never read at run
time. Resolution, in order:

1. the **provider allow-list** `{anthropic, google-antigravity, kimi-code, openai-codex}` is applied to the available
   list **before any matching** (the live `omp models` catalog also lists `google`, `moonshot` and `ollama`, which are
   metered or absent; a pattern like `gemini-3.8-flash` must never match `google/…`), then the seat's eligibility
   (chat seats exclude `openai-codex`: no chat turn is ever routed to Codex, which stays the self-write writer);
2. Paco's override for the role, if any (§4.2), as a pattern through the same filters;
3. the role's selector list, each kept only when the catalog lists it, duplicates dropped.

Only a `/models` override is a *pattern* (a substring such as `opus` or `gemini-3.1-pro`), matched against the filtered
catalog at `/models set` time and again at each resolution.

The result is an ordered candidate list. The available list comes from `omp --profile houge models --json`
(session-less, verified: `{models: [{provider, id, selector, thinking, …}]}`), read at boot and by the daily tick, and
from `get_available_models` over RPC when a child is up. The catalog lists models the provider still catalogues, not
models the account can use today: a retired or unavailable model surfaces as `model_missing` at spawn or pin and the
list walks on, as it does today.

A failure walks the list; an exhausted role steps up (Fast → Default → Thinking); Thinking exhausted → `no_planner_leg`
and its incident, as today. Step-up on a routed turn happens on the retryable kinds (`quota`, `auth`, `transport`,
`timeout`, `model_missing`) plus **`other` once, only while no bridge tool has executed in the turn** (a deterministic
failure after a side effect must not be re-spent on a bigger model); the Kimi case is exactly this. Retries on the
retryable kinds keep today's semantics unchanged: the omp transcript already holds every executed tool's result, and
the retry re-prompts the next model with `RETRY_NOTE` to continue, not to replay; this spec adds no new retry after a
side effect. Ledgered `routed_escalation {from, to, kind}`.

### 4.1 Change notice and incidents

A daily tick resolves every role and diffs against the last stored resolution (`model_roles_resolved` ledger row).
Changed → one Telegram line ("Thinking now resolves to X, was Y"). A role with no candidate → incident
`role_unresolved`; its turns step up. Model-resolution changes are a notice, not an incident.

### 4.2 `/models`

`/models` lists role → model, effort, default or override, and the candidate list. `/models set <role> <pattern>`
validates the pattern against the filtered available list before saving; a pattern that matches nothing, or only a
provider outside the allow-list, is refused with the reason. `/models reset <role>`. Overrides are append-only
`model_role_override` ledger rows (latest per role wins), read at each resolution — no restart, no settings table.
Gated where `/memories` is gated: the Telegram command parser and the gateway's allowlisted-chat branch, not the
command module itself. The seven `HOUGE_OMP_*` chain variables are removed from `configuration.md`
(`.env` sets none of them today; only `HOUGE_OMP_BIN` and the profile stay).

### 4.3 Rollback switch

`HOUGE_MODEL_ROLES=static|resolved` (default `resolved`). `static`: each role is its code list of exact selectors in
order, no catalog check, no override, no tick — exactly today's chain semantics (a retired selector is walked past on
`model_missing` at spawn or pin), so the pre-stage-A model path is reproduced seat for seat. Together with `HOUGE_JEV_TRIAGE_ENABLED=off` (category → planner, as before) this
is stage A's rollback. Both are read from `process.env` per call, and `.env` is parsed once at boot, so a change needs
a kickstart (as for the lane 1 flag today); the disarm marker file stays the live kill for the Jev side.

## 5. The planner lane: a turn-owned chain

Today the supervisor indexes one global chain for spawning, pinning and retries (`sessionLeg`, `legIndex`, `promptTop`,
`retryNextLeg`, `recordStartMissing`, `spawn`). Two axes replace it:

- **The spawn axis is the Default role's candidate list.** The child cold-spawns on Default's first candidate; a start
  refusal (`Model "…" not found`, omp 18.4.4's exact line) advances along Default's list, as today along `cfg.planner`.
  The child begins warming before triage, as today (slot B).
- **The turn axis is the turn's own candidate list** from §4 (the routed role). After spawn or resume and before the
  first prompt, the turn's first candidate is applied with two RPC commands, `set_model` then `set_thinking_level`,
  the same place `promptTop` re-pins after a resume today. `legIndex` indexes the turn's list; `retryNextLeg` walks
  it, then steps up a role; `noteActualModel` audits against the turn's list. The next turn re-pins to its own first
  candidate, never to the spawn leg.
- **A pin that omp answers `Model not found`** is `model_missing`, a retryable kind. Today the session wrapper
  rejects every refused RPC as `command_failed:<type>` and drops omp's text (planner-session.ts:150); it keeps the
  text on the `PlannerRpcError` and the supervisor classifies it with `classifyOmpError` (`Model not found:
  provider/id` → `model_missing`). One `model_missing` attempt row, then the turn's list walks on (so a Default[0] that was refused at spawn never becomes a per-turn failure). Only a
  transport or RPC failure of the pin is a **failed pin** (`planner_model_reset_failed`): answer on the model the
  child holds, incident as today, row marked `pin_failed`, no escalation on a child that just refused a pin. The
  respawn rule `leg === 0 && sessionLeg > 0` (planner-supervisor.ts:587) is removed: `set_model` moves the child to
  any available model, so a refused spawn leg no longer forces a restart.
- **No mid-prompt escalation.** `set_model` only runs between prompts (today's retry boundary); a Fast planner turn
  that emits a tool call is not interrupted — it finishes on Fast and the row is marked `fast_used_tool`, a
  calibration signal (and the reason `actions` = none is the Fast condition). Escalation happens at the retry
  boundary only, on the kinds in §4, where `model_refusal` is the classified error text, as today.
- Codex stays the self-write writer only; no chat turn is ever routed to it.

## 6. Ledger and corrections

- **Per-question rows** (`jev_decisions`) stay as they are: one row per question, status, decision, instants.
- **One per-turn row** (new table `jev_verdicts`, keyed `verdict_id`, one per decision point call): `run_id`, `category`,
  `breadth`, `reasoning`, `actions`, `sets_rule`, `rule_scope`, `lane`, `role`, `effort`, `model`, `cascade`,
  `save_outcome` (`saved | not_durable | capped | none`), `route_outcome` (`act | fallback | pin_failed`),
  `handler_outcome` (`lane_reply | fallthrough:<reason> | planner_done | planner_failed`), `created_at`. A Jev-skipped
  or failed call writes the row too, with `category` null, `route_outcome = fallback` and the skip reason, so the §9
  join holds through an outage. The triage finaliser writes the row with `handler_outcome` pending (inside the lesson transaction when a rule was saved, as
  today); the handler's end updates `handler_outcome` in its own transaction. The `triage` event carries `category`,
  `lane`, `role`, `verdict`. The first `llm_attempt` of a routed turn carries `routed_by = verdict_id`.
- **Corrections** ledgered on the turn row as `paco_correction`: an Ask Houge anyway tap, `think harder` on the next
  turn, an escalation, a session rating ≤ 1. This is the verdict → action → outcome chain mu's retrospective found
  missing.

## 7. Calibration and the replay

New question hashes → new `CALIBRATED_ROWS` per question and language, committed on Paco's word after the replay. The
replay (`houge jev replay triage`, generalised over the question union) rebuilds each Telegram run since 2026-07-02
(`runs.source = 'telegram'`, 305 today) at its live instant and asks once. Proxy label per run from the tools the
planner used, **first match in this order**: `houge_status` → `status`; `memory_correct_write` → `memory` (correction);
`lesson_write` → `memory` (rule); `self_write_* | self_diagnose | skill_author` → `self_change`; `wiki_build |
wiki_refine` → `wiki`; `schedule_task` → `schedule`; `gmail_* | google_api` → `mail_calendar`; `shell | shell_external |
fs_*` → `machine_task`; `web_search` with ≥ 3 steps or ≥ 2 `http_fetch` → `research`; `web_search` or `http_fetch` with
≤ 2 steps → `lookup`; no tool → `answer`, except when the previous Houge turn was a proposal (the ack ambiguity) →
**unlabelled**. Report: the category confusion matrix, score distributions per proxy, permutation agreement, and
three costly cells — anything wrongly into `memory` / `status` (a swallowed turn), `self_change` / `machine_task` rated
light (under-powered), lane-shaped turns sent to the planner (cost only). Evidence for Paco's decision; the labelling
CLI stays for tuning the bars.

## 8. Safety nets

Kept: every Jev outage class pages (`jev_*`); `jev_skip_rate`; Ask Houge anyway as the correction label, with the
3-in-7-days auto-disable left as built (Paco, 2026-10-06). New sweep invariants: `lane_fallthrough_rate` (a lane that
falls through on half or more of ≥ 3 turns in 24 h is broken, not quiet; sticky until a lane turn succeeds) and
`role_unresolved` (§4.1). The D10 reader rule becomes a **skip rule**: the first reader candidate whose family differs
from the planner's current family runs first; when every candidate shares it, the read runs anyway and is flagged
`family_collapse`, as today.

## 9. Tests and live gates

- **Policy** as a table: answers → lane, role, effort, including every guard and every bar edge, the `memory` +
  `sets_rule` split, and the cascade's exclusion of `memory` / `status`.
- **Jev client**: the three types round-trip; per-type validation and persistence; a `noul` row's nulls.
- **Each lane** hermetic with a stubbed search / one-shot: success, empty result, compose failure, cap, and the
  fall-through row; the card's buttons.
- **Role resolver** against a fake `omp models --json`: allow-list before matching (a `google/` twin of an Antigravity
  model is never chosen), seat eligibility (Codex never on a chat seat), override, retirement, step-up on an empty
  role, the change notice, `static` mode.
- **Supervisor:** cold spawn and start refusal on the Default axis, pin with two commands, retry walk on the turn axis,
  failed pin, `other` once with no tool executed, `other` final after a tool, audit against the turn's list.
- **Migration** of `jev_verdicts`; the replay's proxy precedence; the cascade's category restriction.
- **Live gate per stage** (`scripts/live-gate-jev-tree.mjs`, DB copy, real Jev, real one-shots): one turn per lane, one
  that overflows its lane, a bare "好" after a proposal, a `sets_rule` turn on a lookup, a `memory` correction routed
  to the planner, the parity and skip-rate cases, and role resolution against the real `omp --profile houge models`
  list. Cases judge by the recorded verdict (INCONCLUSIVE when Jev's call takes another path, never a false FAIL).
- **Stage A PASS criterion:** every routed turn's first `llm_attempt` joins to a `jev_verdicts` row; `pin_failed` = 0;
  each role resolves to the expected head of its list for profile `houge`; the memory lane's distill and reconcile
  still run on `kimi-code/k3`; `jev_skip_rate` unchanged against the 7-day baseline.

## 10. Staging

One spec; a plan, a build and a live gate per stage. Arm each stage on Paco's word after its replay.

- **A** — the decision point (three question types), roles with the code lists, `/models`, the rollback switch, the
  planner lane with the two-axis chain; memory and status re-attached to the tree. Every other category goes to the
  planner on its role: the only visible change is which model answers a planner turn (memory stays on K3).
- **B** — the `answer` and `lookup` lanes (58% of past turns).
- **C** — the `schedule` and `wiki` lanes; the research-lane question, from stage A/B rows.
- `mail_calendar` lands with SP2.

The routing policy lives under `src/jev/`, not `src/policy/`: it never produces allow or deny, so it is not gate
machinery and not on the protected surface (ADR 0029 §2); the self-write writer may propose changes to it like any
other code, subject to the usual review.

## 11. Docs on ship

ADR 0029 amendment (tree, lanes as the leaf type, roles) and ADR 0028 amendment (config, D10 skip rule);
`configuration.md` (`HOUGE_OMP_*` chains removed, `HOUGE_MODEL_ROLES`, `/models`, new incidents and ledger fields);
`jev-decision-layer.md` rewritten around the tree; CONTEXT.md terms *category*, *lane*, *role*; README;
`tasks/todo.md`, `sessions.md`.

## 12. Review log (Rev 1 → Rev 3)

Two reviews of Rev 1 on 2026-10-06, both NOT READY: a senior review against the live omp, DB and code, and a Codex
design pass. Every finding was verified first-hand before being folded in; none changed §1.

| Finding (both reviews unless noted) | Rev 2 |
|---|---|
| The Jev client is `choice`-only; TypeSafe's yes/no type is `noul` and answers without `confidence`; the row writer and replay assume choice | §2.3 types by wire name, per-type validation and persistence, replay generalised |
| omp's resolver is not reachable over RPC and has no list for Default or Vision; its lists include Codex; the live catalog includes metered `google` / `moonshot` | §4: Houge-owned code lists, allow-list before matching, seat eligibility |
| "Jev failure → today's behaviour" undefined once chains move | §2.4: Default as resolved, override included |
| No rollback for the model path independent of the Jev flag (senior) | §4.3 `HOUGE_MODEL_ROLES=static` |
| `memory` conflated rules with gated fact corrections (Codex) | §2.4 / §3: rules → lane, corrections → planner |
| Spawn warms before triage and `sessionLeg` indexes the global chain | §5 two axes: spawn on Default's list, turn on its own |
| Mid-prompt escalation impossible (tool calls are seen after the model chose them); `model_refusal` is classified text; pin is two commands | §5: escalation only at the retry boundary; `fast_used_tool` as a signal |
| Stepping up on every `other` re-spends deterministic failures | §4: retryable kinds + `other` once with no tool executed |
| Per-turn fields on per-question rows; no turn-level outcome after a save-then-route | §6 `jev_verdicts` with three outcomes |
| Cascade undefined when the top two are lanes (Codex) | §2.4: exclude `memory` / `status`, take the one left |
| `/models` storage and the tick's data source; no `/models` parser entry | §4.1–4.2: ledger rows, `omp models --json` |
| Replay proxy labels mislabel wiki / memory_correct / ambiguous acks | §7 precedence, unlabelled acks |
| The memory lane's seat would move from K3 to Gemini under omp's Tiny list (senior) | §4 Tiny list keeps K3 first; PASS criterion in §9 |
| D10 "fix" is new behaviour (senior) | §8 skip rule, stated |
| Proposal detection must not widen the stored intent enum (senior) | §2.2 read-time regex |
| `scheduled_tasks` has no fuzzy match (senior) | §3 schedule lane: id, else one-shot pick ≥ 0.8, else planner |
| Re-pass on Rev 2 (Codex, NOT READY): pin `model_missing` vs `pin_failed` needs a classified path (the wrapper drops omp's text); `static` undefined for patterns; Reader named twice, Council one role; `sets_rule` unsure zone and a zero-candidate cascade unspecified; retries after a side effect | §5 error text kept and classified; §4 lists are exact selectors, only overrides are patterns, `static` = today's chain semantics; §4 three council roles; §2.4 unsure is no; §4 retry semantics unchanged |
| Re-pass on Rev 2 (senior, READY): a spawn-refused Default[0] would become a per-turn `pin_failed`; `.env` is not read live; Reader list named twice; skipped turns need a verdict row; where `/models` is gated | §5 `model_missing` on pin walks the list, respawn rule removed; §4.3 wording; §4 table; §6; §4.2 |

## Appendix A. Parked from mu for later lanes

| mu idea | For | Note |
|---|---|---|
| `tool.injection`: one `noul` per passage, batched, withhold over 0.5 with a note in place; wording measured at 70/79 planted attacks caught vs 11 for a pattern scan, 0/1,520 clean passages withheld | lane 3 | monotone (adds caution only); ported wording is MIT, attribute |
| `notify.routing`: tell now / later / never | lane 4 (inbound triage, digest) | the shape of the digest decision |
| `memory.applied`: was each recalled lesson followed; a lesson recalled often and never followed retires | lane 5 (credit, stage C memory) | `memory.merge` is **not** taken: ADR 0029 rules out Jev-decided reconcile verdicts |
| `turn.continue` (a run that ends on "next I'll…" is sent back, never toward a hard-to-undo step) and `turn.completion` (was "done" verified) | SP4 | |
| Retrospective lessons: rules filter before the judge (their output screening spent 54% of Jev input and dropped nothing); verdict → action → outcome per decision point | applied here (§2.1, §6) | |

## Appendix B. Rejected

- **Jev classifies, Kimi picks effort:** a second judgment with no probabilities to threshold or calibrate, 1–5 s on
  every planner turn.
- **omp's `--thinking auto` inside the child:** thinking level only (no Opus-cap relief), coding-shaped criteria, and
  the Jev key in the sandboxed child (ADR 0015). Already rejected in ADR 0029.
- **Reusing omp's resolver or reading its `priority.json` at run time:** not reachable over RPC; a TS-internal
  dependency under `dependencies: {}`; no Default list; Codex in the chat lists.
- **Per-turn chains in `.env` by gear:** operator edits for every model change; §1 ruling 3.
- **Mid-prompt escalation of a Fast turn that calls a tool:** the call is already chosen when seen; interrupting and
  re-prompting a bigger model risks repeating a side effect.
- **A one-line category hint in the planner prompt** (mu's preflight hint): the planner has the full message and
  tools; a wrong hint steers. Revisit from the ledger.
