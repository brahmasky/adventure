# No model call through Google's Antigravity login

**Status:** Rev 0.4 — 2026-11-12. Rev 0.1 was reviewed by a senior reviewer (Opus 5.5: 4 blockers, 6 warnings) and
codex (5 blockers, 4 warnings); both said not ready. A scoped codex re-review of Rev 0.2 closed 8 of 12 rows and
raised 3 new blockers and 3 warnings. A third scoped codex pass on Rev 0.3 closed every open row and raised one new
blocker in §3.4, taken in Rev 0.4 as codex prescribed; that last fix has not been re-reviewed. Every finding was
checked first-hand and taken (§10). Awaiting Paco's approval. No code before that.
**Scope** from the direction review ([`docs/research/direction-review-2026-11.md`](../../research/direction-review-2026-11.md) §4)
and Paco in chat 2026-11-12 ("spec the P0 slice"). **Brainstorming skipped:** scope and forks F1, F2 came from that
chat. F3 is the orchestrator's draft and is decided by Paco's approval of this spec.
**Changes what these rules mean** (Tier C, Paco signs): ADR 0032 D7's fallback, D10's wording, 7.1, 7.2, 7.4, 7.6,
7.9, 7.10, a new 7.11, §10, Consequences; ADR 0027 §1; ADR 0035 G3. Full list in §4.
**Code touched:** `src/omp/model-roles.ts`, `src/omp/model-tiers.ts`, `src/omp/model-roles-tick.ts` (protected; this
spec's approval is Paco's hand), `src/capabilities/idea-panel.ts`, `src/capabilities/idea-panel-seats.ts`,
`src/report/brief-writer.ts`, `src/gateway/gateway.ts` (panel renders), `src/media/media-ingest.ts` and its call in
`src/core/core-worker.ts`, tests, gate scripts, docs.
**Queue:** item P0 of `tasks/todo.md`. The slice removes; it adds no new kind of leg.

## 1. Why

Houge reaches models through four OAuth logins held by omp. Google's Antigravity terms (§6, read 2026-11-12) say
that using third-party software with Antigravity OAuth is a breach and may be grounds for suspension of "your
Antigravity and/or Gemini CLI accounts". omp is third-party software. Since 2026-10-15 that login carried 280 of
568 non-Jev model calls. A suspension would also take `agy`, the official client that carries voice.

ADR 0032 D7 accepted the terms risk of the Anthropic login. It did not weigh Google's, and its fallback from
Anthropic is Claude on Antigravity.

**Goal:** after this slice Houge holds no Antigravity login in omp, and no role, tier, static list, override,
probe or script default can send a call to the `google-antigravity` provider. Voice stays on `agy` (ADR 0032 1.6),
Google's own client.

## 2. The live system (probed 2026-11-12)

**Calls since 2026-10-15** (`ledger_events`, `llm_attempt`):

| Provider | Calls | Roles |
|---|---|---|
| `google-antigravity` | 280 | reader 272, judge 4, probe 3, extract 1 |
| `anthropic` | 183 | compose 167, lane 10, chair 4, probe 2 |
| `kimi-code` | 97 | distill 47, extract 28, cascade 9, improve_pick 5, judge 4, lane 2, probe 1, consolidate 1 |
| `openai-codex` | 5 | — |
| `agy-cli` (voice) | 3 | — |

No `compose` row has run on Kimi in that window.

**omp itself uses the login, outside every Houge leg.** omp's own `agent.db` in the `houge` profile
(`usage_history`: provider and timestamp columns only were read) holds 60 `google-antigravity` usage polls, the
latest at 2026-11-12 04:57:07Z, the second Paco's `/models set` re-read the catalog. Houge's ledger has no
Antigravity row near it. `model_usage` there also lists three `google-antigravity/claude-*` models as used. So the
ledger cannot see everything omp does with a stored login: while the credential is stored, omp polls that account.
omp has `login` and `auth export|import` (import merges) and no `logout` command.

**Where the provider appears in `src/`:** `model-tiers.ts` (four tiers: `opus@antigravity`, `sonnet@antigravity`,
`gemini-flash`, `gemini-pro`; seeds; two family maps; a label), `model-roles.ts` (`ROLE_LEGS`,
`STATIC_ROLE_LISTS`, `ALLOWED_PROVIDERS`). `protected-paths.ts` names the `.antigravity` dotfile directories; that
is a deny list and stays. **In `scripts/`:** 14 files (§6.3). **In `tests/`:** 39 files, 195 mentions.

**Roles with a leg on it:** every role but `chair`. `vision` has no other leg.

**The panel names its judges in code.** `PANEL_JUDGE_NAMES = ["kimi", "gemini", "codex"]`
(`idea-panel.ts:43`), `PANEL_JUDGE_SEAT_INDEX.gemini = 2` (`idea-panel-seats.ts:18`), one lens per name
(`PANEL_JUDGE_LENSES`: opportunity, technical novelty, buildability), and three renderers that list the three
names (`report/brief-writer.ts:30`, `gateway/gateway.ts:1685–1841`). Changing `JUDGE_SEATS` alone would leave a
judge with an empty chain that fails every week.

**`/models` cannot remove a leg.** An override's matches serve first and the code list follows; a pattern is
matched only against allow-listed providers. Paco's override `/models set reader kimi` has stood since
2026-11-12 04:57Z. The pattern matches the provider string, so six `kimi-code` ids come before the list, and the
live reads ran on `k3`, not the tier head `k3.1-pro`.

**Static mode has no allow-list filter** (`resolveRole`): what `STATIC_ROLE_LISTS` names is what runs.

**Probes that call a model.** The daily tier tick probes a tier's new head with a one-leg call
(`model-probe.ts`); it returns `ran: false` inside its 24-hour latch. The contract probe uses Tiny's head, else
Fast's. A refused omp version check writes no `llm_attempt` row (`providers/omp.ts`).

**The planner's walk.** A leg failure inside a role walks that role's list (`retryNextLeg`, `pinWalk`); only
`stepUp` (Fast → Default → Thinking) writes `routed_escalation`. Resolved lists hold a tier's adopted head and
its previous head, so today Default resolves to `opus-5-5`, `opus-5`, then Kimi: two Anthropic selectors before
Kimi.

**A photo read carries no planner family, and cannot at that point.** `buildMediaCall` (`media-ingest.ts:275`, called from
`core-worker.ts:1635`) builds the seat with role `reader` and no `plannerFamily`. A Claude photo read under a
Claude planner would be neither reordered nor flagged as a family collapse. (Rev 0.1 claimed the opposite; the
call it cited is the lookup lane's.)

**Open incidents today:** `trust_tap_budget`, `omp_read_format_drift`. No `role_unresolved` is open. The tick
closes `role_unresolved` only for keys in the current resolution (`model-roles-tick.ts`, `syncUnresolved`), so an
incident for a seat that no longer exists would never close.

**Reader speed, real prompt** (`buildReaderQuestion`, content at the 8,000-char cap, one call at a time, one
sample each, the arguments `ompOneShotArgs` builds):

| Model | Seconds | Tokens out |
|---|---|---|
| `anthropic/claude-sonnet-5-5:low` | 9.8 | 1,102 |
| `openai-codex/gpt-6.1-sol:low` | 11.0 | 335 |
| `kimi-code/k3.1-pro:low` | 16.3 | 601 |
| `kimi-code/k3:low` | 16.8 | 851 |
| live `google-antigravity/gemini-3.8-flash` (272 calls) | 12.2 mean | 988 mean |
| live `kimi-code/k3` (one call, 7,207 tokens in) | 40.8 | 1,660 |

The one live Kimi read is not explained by the probe.

**A photo on Kimi works:** a generated two-square test image was described correctly by `kimi-code/k3:low` in
5.8 s and by `kimi-code/k3.1-pro:low` (the tier head) in 7.9 s.

**`agy` as a reader is not offered here.** `agy` 1.5.6 under `--sandbox` alone answered a search prompt with
18,689 input tokens against about 8,500 for its bare system prompt and reported search results: the search ran.
`--settings` and `--mode plan` were not tried.

**Terms of the legs that remain** (read 2026-11-12): Anthropic — OAuth is for Claude Code and native applications
(primary; accepted in D7). Kimi — sign-in is described for its own clients; third-party tools are told to use a
Kimi Code Console API key; a tampered User-Agent may suspend membership benefits (primary). OpenAI — a partner
programme for "Sign in with ChatGPT" exists; omp's standing in it was not established (secondary only).

## 3. Decision

### 3.1 Role lists

| Role | Today | After | What it loses |
|---|---|---|---|
| `fast` | `sonnet@anthropic`, `sonnet@antigravity`, `gemini-flash` | `sonnet@anthropic:low`, `kimi:low` | Claude and Gemini as fallbacks |
| `default` | `opus@anthropic`, `opus@antigravity`, `kimi` | `opus@anthropic:medium`, `kimi:low` | Opus as its own fallback |
| `thinking` | `opus@anthropic`, `opus@antigravity`, `kimi` | `opus@anthropic:high`, `kimi:high` | the same |
| `reader` | `gemini-flash`, `kimi`, `codex-sol` | `kimi:low`, `codex-sol:low` | Gemini Flash, its head for 272 calls |
| `vision` | `gemini-flash` | `kimi:low`, `sonnet@anthropic:low` | Gemini; gains a second leg (F1) |
| `tiny` | `kimi`, `gemini-flash` | `kimi:low`, `sonnet@anthropic:low` | Gemini as the non-Kimi leg (F1) |
| `judges` | `kimi`, `codex-sol`, `gemini-pro` | `kimi`, `codex-sol` | the third judge (F2, F3) |
| `chair` | `opus@anthropic` | unchanged | — |
| `reviewer` | `kimi:high`, `opus@antigravity:medium` | `kimi:high`, `opus@anthropic:medium` | nothing in model; the login changes (F1) |
| `grow_review` | `kimi`, `gemini-pro`, `codex-sol` | `kimi:high`, `codex-sol:high` | one of three families |

`STATIC_ROLE_LISTS` names every selector of the same shape explicitly with the seeded heads (`k3`,
`claude-sonnet-5-5`, `claude-opus-5-5`, `gpt-6.1-sol`), since static mode filters nothing. Static and resolved
modes both have two judge seats.

**F1 — backup legs may use the Anthropic login (Paco 2026-11-12).** `vision`, `tiny` and `reviewer` get a Claude
leg behind Kimi; it runs only when Kimi fails. This keeps "every multi-leg role keeps a non-Kimi leg" and widens
what the Anthropic login carries beyond planner and chair.

**F2 — two judges, quorum 2 (Paco 2026-11-12).** One failed judge aborts that week's panel. A Gemini judge on
`agy` is a later slice.

**F3 — the technical-novelty lens is dropped with its judge (draft; Paco decides with this spec).** The panel
keeps opportunity (Kimi) and buildability (Codex). The alternative, one model judging through two lenses, would
keep three scores and lose the rule of one lens per seat and the family diversity ADR 0027 rests on.

**Reader order:** Kimi, then Codex, as today minus Gemini. Codex was faster in the probe with a third of the
output; which reads better is not measured, and `/models set reader` chooses without a build.

### 3.2 Tiers, allow-list, overrides, retired keys

- The four tiers on `google-antigravity` leave `TIERS`, `TierId`, `SEED_HEADS` and the two family maps. The tick
  then has nothing to probe there, and the empty-tier card for `gemini-pro` cannot arise.
- `ALLOWED_PROVIDERS` becomes `anthropic`, `kimi-code`, `openai-codex`. `/models set` refuses a pattern that
  matches only Antigravity models with the existing "outside this role's providers" line.
- A stored override naming a removed model matches nothing after the filter and the role resolves on its list.
  `model_tiers` rows of removed tiers are ignored as unknown tiers and left in place. No migration.
- **Retired keys.** `judges:2` stops being a key. The tick's `syncUnresolved` also closes, silently, any open
  `role_unresolved` whose subject is not a current key, and `/models reset judges` clears a stored override for a
  seat that no longer exists. `/models set judges 2 …` answers `no_seat`.
- `HOUGE_MODEL_ROLES=static` stays the rollback of the *resolver* and no longer brings Antigravity back.

### 3.3 The panel

`PANEL_JUDGE_NAMES` is `["kimi", "codex"]`, with seats 0 and 1 and the two lenses of F3. The three renderers show
the judges a row holds: a new row shows two, a row written before this slice still shows its `gemini` score and
reason. The chair's prompt is unchanged.

### 3.4 A photo read is checked for family collapse once the planner's model is known

A photo is ingested before the turn is routed and pinned (`planner-supervisor.ts`, the ingest ahead of the pin
walk), so the turn's planner family does not exist yet at `buildMediaCall`, and `plannerFamily()` there can be the
previous turn's. The slice therefore does not pass a family into the photo seat and does not reorder its legs:
a photo runs its list in order, Kimi first.

Instead the ingest result carries the family of the leg that served it, and the supervisor compares it with the
family of each model that actually answers the turn, as `message_end` reports it. A pin can fail and a retry can
pin another family, so the pin walk alone does not say which model answered. On the first answer of the same
family it writes the same `wall_collapse` ledger event and keeps the same incident a collapsed reader call does
(ADR 0032 D10: the read proceeds, audited), once per photo read. A turn with no planner answer (a lane reply, a
turn that fails before any answer) has no comparison; a turn that fails after an answer still has it.
This covers both ways the slice makes a collapse possible: Kimi down (photo on Claude, planner on Claude) and
Anthropic down (photo on Kimi, planner on Kimi).

### 3.5 The login is removed

The slice is not done while omp holds the credential (§2: omp polls the account on its own). After the code ships
and the gate passes, Paco removes the Antigravity login from the `houge` profile with omp's own command: start
`omp --profile houge` in a terminal and enter `/logout google-antigravity`. omp 18.19.0 ships that slash command
("Logout from OAuth provider"; it removes one stored credential and refreshes the provider's models). Credentials
are Paco's hand. `agy` keeps its own login and is not touched.

Straight after the removal, before the 24-hour window starts, the orchestrator shows: `omp --profile houge models
--json` still parses and lists the three remaining providers; `/models`, `/status` and `/usage` answer; one due
daily tick runs with `ran === true` and opens no `model_catalog_unavailable` or `role_unresolved`. To verify the
removal it reads only the provider and timestamp columns of omp's usage tables.

### 3.6 New rule, ADR 0032 7.11

> **7.11 No leg reaches a model through `google-antigravity`.** No role leg, tier, static selector or allow-list
> entry names that provider; a `/models` override cannot select it; no script default calls it; the `houge` omp
> profile holds no login for it. Google models reach Houge only through `agy` (1.6).

### 3.7 What this slice does not do

It adds no leg on `agy` or `codex exec` for a seat, does not change the Anthropic login (D7 stands), does not
move Kimi from its login to a Console key, and does not change the reader's prompt or the wall.

## 4. Rules changed

| Rule | Today | After |
|---|---|---|
| ADR 0032 D7 | fallback is "each role's next code-owned leg" | text unchanged; the planner's next leg is Kimi |
| ADR 0032 D10 row | "after its Gemini and Kimi legs"; reader only | "after its Kimi leg"; a photo read is audited too, by the comparison of §3.4 (no reordering) |
| ADR 0032 7.1 | `grow_review`: three legs (Kimi, Gemini pro, Codex) | two legs (Kimi, Codex) |
| ADR 0032 7.2 | eight tiers; Gemini rename text | four: `opus@anthropic`, `sonnet@anthropic`, `codex-sol`, `kimi` |
| ADR 0032 7.4 allow-list | four providers | three |
| ADR 0032 7.6 | card proposals name Gemini and `gpt-oss-120b` | the Gemini clauses go |
| ADR 0032 7.9, last sentence | "walks to the next candidate" | names Kimi as that candidate |
| ADR 0032 7.10 | static: "judge seat 2 empty" | static and resolved both have two seats |
| ADR 0032 7.11 | — | new (§3.6) |
| ADR 0032 §10 | `chains().judges[2]` residual; Antigravity ceiling line | both removed |
| ADR 0032 Consequences | four subscription logins | three |
| ADR 0027 §1 | three judges, three lenses, four families with the chair | two judges, two lenses, three families; quorum 2 unchanged |
| ADR 0027 Consequences | four panel calls a week | three (two judges and the chair) |
| ADR 0035 G3 | `grow_review`: three legs | two legs (Kimi, Codex); still no Claude-family leg |

## 5. Tests

**ADR conformance (`tests/adr/`):**
- `0032-7.11-no-antigravity`: `ROLE_LEGS`, `STATIC_ROLE_LISTS`, `TIERS` and `ALLOWED_PROVIDERS` hold no such
  provider (this also covers 7.4); `matchOverride` returns nothing for a catalog of only Antigravity models; a
  scan of `src/` finds the string only in `protected-paths.ts`, and a scan of `scripts/` finds it only in the
  files §6.3 marks as recordings or historical.
- `0027-1-two-judges`: two names, two lenses, two seats; quorum 2; either judge failing aborts.
- `0032-role-invariants`: `reviewer` has no `openai-codex` leg (the writer's family); `grow_review` has no
  Claude-family leg; no chat role has an `openai-codex` leg; every multi-leg role has a non-Kimi leg.

**Unit:**
- Lists, tiers and static lists of §3.1 and §3.2; the existing 7.10 test (a static selector matches a tier) holds.
- A stored override naming a removed model resolves on the list; `/models set reader gemini` and
  `/models set vision flash` are refused; `/models set judges 2 …` is `no_seat`; `/models reset judges` clears a
  stored seat-2 override.
- The tick closes an open `role_unresolved` for `judges:2` silently and probes no removed tier.
- **Planner walk.** Default with Anthropic failing `auth`: the turn walks `opus-5-5` → `opus-5` → `kimi-code` in
  the same role and writes **no** `routed_escalation`. Fast exhausted steps up to Default, then Thinking, and with
  every selector spent ends `no_planner_leg`, including the case where the Kimi selector was already spent in a
  lower role.
- Panel: exactly two judge calls; both valid → a shortlist; either failing → abort; a pre-slice row renders its
  `gemini` score.
- Photo: the legs run in list order whatever the planner's family (Kimi first, also under a Kimi planner); the
  ingest result carries the serving leg's family; a planner answer of the same family writes one `wall_collapse`
  (Claude photo with a Claude answer; Kimi photo with a Kimi answer), also when the answer comes on a retry leg
  after a failed pin, and never twice for one photo; a cross-family answer writes none; a lane-ended turn and a
  turn that fails before any answer write none.
- Fixtures that use an Antigravity selector as an arbitrary example move to an allow-listed provider. Captured
  omp frames (`tests/fixtures/omp-frames/*`) are recordings and stay.

## 6. Gates

### 6.1 Live gate `scripts/live-gate-no-antigravity.mjs`

Real omp, the real catalog, a copy of the live DB with no stored override. Every line must run and produce the
row it names; a refused call or a call with no audit row is INCONCLUSIVE, and one INCONCLUSIVE line means no PASS.

1. `resolveAll()` heads: every role and both judge seats resolve, none on `google-antigravity`, and the window
   holds zero `model_roles_fallback` rows (a fall to the static lists would otherwise look the same).
2. `/models set reader gemini` is refused; a seeded override naming a Gemini id resolves on the list; a seeded
   open `role_unresolved` for `judges:2` is closed by the tick.
3. A real web read: one `reader` attempt, `kimi-code`, model `k3.1-pro`, outcome ok.
4. A real photo: one attempt on `kimi-code`, model `k3.1-pro`, ok, and the digest names the planted object; an
   injection image is flagged.
5. **Planner on Kimi as head.** With the gate's role lists set to Kimi first (the Proxy the loud-degradation gate
   uses), one real turn that calls a bridge tool completes with a `compose` row on `kimi-code`. This proves Kimi
   can run a planner turn; the walk to it is proven by the unit test in §5, not here.
6. One daily model tick with `ran === true`: no probe for a removed tier, no empty-tier card, no
   `role_unresolved` opened.
7. A real two-judge panel: exactly two judge attempts, both ok, a shortlist written.
8. One real grow review and one reviewer verdict, each with an ok attempt on `kimi-code`.

**PASS:** lines 1–8 all ran and passed, and the gate window holds zero `llm_attempt` rows with provider
`google-antigravity`.

### 6.2 After the kickstart and the login removal

Reported, not assumed, 24 hours after the login is removed (the window covers the 08:00 brief):
zero `google-antigravity` `llm_attempt` rows; zero new `google-antigravity` rows in omp's `usage_history`,
`model_usage` and `model_perf`; every role still resolves; no `role_unresolved`; the brief ran with its reader
rows ok.

### 6.3 Existing gates and scripts

| File | Disposition |
|---|---|
| `live-gate-jev-tree.mjs` (line 531 asserts a `gemini` match on Antigravity) | assertion replaced: the pattern matches nothing and is refused |
| `live-gate-omp.mjs` (line 112 requires a Gemini reader and photo model) | Kimi; the affected full cases run, not only `--smoke` |
| `live-gate-model-tiers.mjs` (requires the `gemini-pro` tier at setup and plants `google-antigravity/gemini-3.1-pro`) | its synthetic empty-tier and card scenario moves to the `codex-sol` tier: the gate swaps that tier's pattern for its synthetic one, plants an `openai-codex` selector, and proposes an `openai-codex` id; its other lines follow the new lists |
| `live-gate-media.mjs`, `live-gate-grow.mjs` (line 577), `live-gate-chat-is-for-paco.mjs` | amended to the new lists |
| `capture-omp-frames.mjs` (the default at line 9 and the bad-model call at line 23), `probe-omp-agent-end.mjs` (line 15) | every selector moves to an allow-listed provider; the recorded `json-error-bad-model.jsonl` stays as recorded |
| `stage4-diff-lib.mjs`, `stage4-corpora/model.mjs`, `stage4-corpora/supervision.mjs` | fixtures with their own selector literals; unchanged |
| `live-gate-ladder-remainder-r4.mjs`, `check-ladder-remainder-r4-rollback.mjs`, `check-chat-is-for-paco-rollback.mjs` | historical evidence of their own slices; unchanged |

`live-gate-loud-degradation` and `live-gate-jev-tree` must pass after their amendments.
**Differential:** every corpus is expected to show 0 differences; the model and supervision corpora inject their
own lists and never read the code lists.

### 6.4 Rollback

There is no rollback check: the slice writes nothing new to the DB, so one would prove nothing. A revert restores
the Antigravity legs at once (their tier rows are still adopted), which reinstates the exposure this slice
removes. A revert is therefore Tier C, Paco's decision, and after the login is removed it would only produce
`auth` failures that walk to the next leg.

## 7. Order at deploy

1. Paco sends `/models reset reader` (the stopgap override puts six Kimi ids ahead of Codex).
2. Merge, rebuild, check `houge.parked` / `houge.kill` and no run in flight, kickstart.
3. First tick: one `model_change` row for Vision; `judges:2` drops out; nothing pages.
4. Live gate on the running build, then Paco removes the login (§3.5), then the 24-hour check (§6.2).

## 8. Docs to re-read on ship

README, `docs/reference/configuration.md` (roles table, tiers, allow-list, "Four OAuth logins"),
`deploy/launchd/README.md`, ROADMAP §5 ("Claude via Antigravity, then Kimi"), the ADR 0032, 0027 and 0035
amendments and the index rows, `tasks/todo.md` P0, `tasks/lessons.md`, `sessions.md`.

## 9. Residuals this slice leaves open (Paco accepts or not; Tier C)

- **R1 Kimi's login.** Kimi heads `reader`, `vision`, `tiny`, a judge seat, `reviewer` and `grow_review`, on a
  login Kimi's own page does not offer to third-party tools. The stake is membership benefits. Whether omp can use
  a Kimi Code Console key, and which User-Agent it sends, is not probed.
- **R2 Codex inside omp.** Its standing under OpenAI's programme is unknown.
- **R3 Anthropic.** D7 is unchanged and now also carries three backup legs.
- **R4 Kimi leaves next year.** Then `reader` and `grow_review` rest on Codex alone, `vision`, `tiny` and
  `reviewer` on Claude alone, and the panel has one judge and cannot reach quorum. A slice that puts seats on
  official clients (`agy` with its search closed, `codex exec`) has to land before that.
- **R5 The day Kimi is down:** reader goes to Codex; photos and Tiny go to Claude (a family collapse, audited);
  judge seat 0 fails and the panel skips that week. **Kimi and Anthropic both down:** the planner has no leg
  (`no_planner_leg`).
- **R6 Reader quality.** Gemini Flash read 272 pages; Kimi's digests are measured only by the probe and one live
  turn. The 40.8 s live Kimi read is unexplained.
- **R7** omp's `model_usage` lists Antigravity Claude models as used with no matching ledger row. Not explained;
  it ends with the login.

## 10. Review record

**Rev 0.1 → 0.2 (2026-11-12).** Senior review on Opus 5.5 (a model other than the author, Fable 5.2, and codex),
read-only against the code, the live DB and omp's catalog; codex design pass, read-only. Every finding was
re-checked by the author against the file or query it cited. All were confirmed; none was rejected.

| Finding | Source | Taken as |
|---|---|---|
| omp polls the Antigravity account on its own while the login is stored; the ledger cannot see it | senior B1 | §2, §3.5, 7.11, §6.2; login removal is in the slice |
| The panel hard-codes three judge names; a phantom judge would fail weekly and the novelty lens vanish unnamed | senior B2, codex 1 | §2, §3.3, F3, panel tests, gate line 7 |
| The planner-fall test asserted `routed_escalation`; the fall is an in-role walk past two Anthropic selectors | senior B3, codex W | §2, §5 planner walk |
| ADR text left unnamed (0032 D10, 7.1, 7.6, 7.10, §10, Consequences; 0035 G3); no test for 0027 §1 or 7.4 | senior B4, codex 5 | §4, §5 ADR tests |
| An open `role_unresolved` for a retired seat would never close | codex 2 | §3.2 retired keys, gate line 2 |
| `live-gate-jev-tree` and `live-gate-omp` assert the opposite of this slice; 14 scripts name the provider, not 1 | senior W2, codex 3 | §6.3 |
| PASS could hide a skipped tick or an unaudited call | codex 4, senior W3 | §6.1: every line must run; `ran === true`; `resolveAll()` heads; zero `model_roles_fallback` |
| The stored `reader` override is six Kimi ids, not the list order | senior W1 | §2, §7 step 1; gate copy has no override |
| The rollback check proves nothing; a revert reinstates the exposure | senior W4 | §6.4 |
| The photo call passes no planner family; Rev 0.1 said it did | senior W5 | §2, §3.4, photo tests; photo probed on the tier head |
| The differential corpora inject their own lists and will not move | senior W6 | §6.3 |
| Static mode filters nothing; operator scripts default to Antigravity; role-diversity assertions missing | senior notes, codex W | §3.1, §6.3, §5 `0032-role-invariants` |

Not checked by either reviewer: omp's internal model choice for compaction, the Kimi and OpenAI terms beyond the
pages cited, the probe timings.

**Rev 0.2 → 0.3 (2026-11-12).** Scoped codex re-review of Rev 0.2: 8 of the 12 rows above closed, 4 still open,
3 new blockers, 3 warnings. Each was re-checked by the author; all confirmed, none rejected.

| Finding | Taken as |
|---|---|
| The login-removal mechanism was left to a later probe | §3.5: omp's `/logout google-antigravity` (present in the installed 18.19.0), with an immediate recheck |
| The planner family does not exist at photo ingest, and `plannerFamily()` can be the previous turn's | §3.4 rewritten: no family passed, the comparison runs after the pin walk |
| Passing a Kimi planner's family would have put Claude ahead of Kimi, against the Kimi-first test | §3.4, §5: photos never reorder |
| `live-gate-model-tiers` needs the `gemini-pro` tier and plants an Antigravity selector; "amended" was not a design | §6.3: the scenario moves to `codex-sol` |
| `capture-omp-frames.mjs` line 23 still calls Antigravity | §6.3 |
| No dependency check straight after the login removal | §3.5 |
| ADR 0027 Consequences still says four panel calls | §4 |

**Rev 0.3 → 0.4 (2026-11-12).** Third scoped codex pass, on Rev 0.3's changed sections: every open row, blocker and
warning closed; one new blocker. Checked by the author and taken as prescribed. Rev 0.4 has not been re-reviewed.

| Finding | Taken as |
|---|---|
| Comparing after the first pin walk can misreport: a failed pin leaves the model unknown and a retry can pin another family | §3.4, §5: compare against each model that actually answers (`message_end`), once per photo read; no comparison without a planner answer |
