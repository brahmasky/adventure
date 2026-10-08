# Jev decision tree — Stage A Implementation Plan

**Rev 5 (2026-10-08)** — rebased onto `main@80e23bb` (omp unpin `a49da40`, Jev alias `c026e5c`, test-gate env `de914ef`):
no omp version text; Jev model = the REPORTED id everywhere (arming, replay rows, the gate's probe, the alias-move page on
the tree's rows); cascade verdict value `kimi` → `tiny`; the lane 1 orphan files get a deleting step (Task 12 Step 3f);
line anchors remapped (see Review record, Round 5).
**Rev 4 (2026-10-07)** — Paco's rulings: the cascade is live in stage A (Tiny role, 20 s bound); Tiny and Fast lists
changed (Kimi exits next year); omp version pin → contract probe as a separate slice (see Review record, Round 4).
**Rev 3 (2026-10-07)** — Codex round 2 folded in (Tasks 1, 12, 14; see Review record, Round 2).
**Rev 2 (2026-10-07)** — review gate round 1 folded in (see "Rev 2 additions" and the Review record at the end).
**Rev 1 (2026-10-07)** — first draft from the code at `main@94e3b4c`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Telegram text turn passes one Jev decision point (six questions, three answer types) that picks a
category, a lane and a model role; memory and status stay lanes, every other category runs the planner on its routed
role (Fast / Default / Thinking) resolved from code-owned lists against omp's live catalog, a Telegram quote anchors the
turn to the stored message it replies to, and every turn leaves one `jev_verdicts` row joined to its first model call.

**Architecture:** `src/jev/` gains the three-type client and question union, the tree's six frozen questions, a pure
routing policy (`tree-policy.ts`) and the `jev_verdicts` ledger. `src/omp/` gains code-owned role lists
(`model-roles.ts`), a catalog reader (`omp --profile houge models --json`) and a `RoleResolver` that applies the provider
allow-list, seat eligibility, Paco's `/models` overrides (append-only ledger rows) and the per-child refused set. The
planner supervisor moves from one global chain to two axes: it spawns on the Default role's candidates and pins each turn
to its own routed candidates (`set_model` + `set_thinking_level`), walking and stepping up roles at the retry boundary.
`CoreWorker.triageTurn` becomes the tree's decision point, reusing lane 1's `decide()` / `settleTriage` finaliser and
egress envelope.

**Tech Stack:** Node ≥ 22 (`node:sqlite`, `node:crypto`, `node:child_process`), TypeScript strict, vitest (hermetic: real
in-memory SQLite, stubbed `fetch`, fake omp session / fake omp binary). Zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-06-jev-decision-tree-design.md` (Rev 8; stage A = §10 bullet A). ADRs:
`docs/decisions/0029-jev-system-one.md`, `docs/decisions/0028-omp-runtime.md`. Seam facts below were gathered against
`main@94e3b4c` and re-anchored to `main@80e23bb` in Rev 5; they are quoted with `file:line`; when the code and this plan disagree, read the code, fix the plan line,
and say so in the task report.

## Global Constraints

- `dependencies: {}` stays empty (ADR 0001/0016). Node stdlib + devDeps only.
- No chat turn is ever routed to `openai-codex` (Codex stays the self-write writer; Reader and the council may use it).
- Provider allow-list, applied to the catalog **before any matching**: `anthropic`, `google-antigravity`, `kimi-code`,
  `openai-codex`. Never `google`, `moonshot`, `ollama`.
- Jev egress stays inside the lane 1 envelope: latest message ≤ `MAX_LATEST_MESSAGE_CHARS` (8 000), whole request ≤
  `MAX_REQUEST_CHARS` (24 000), skip never truncate (`skipped{state_too_large}`), every text field through
  `sanitizeJevText` + the broker's `redact`.
- Jev never produces allow/deny; the routing policy lives in `src/jev/`, never `src/policy/` (spec §10).
- Any Jev failure, skip, unarmed question or thrown stage → planner on the **Default role as resolved** (override
  included), effort from the list; one `jev_verdicts` row; outage paging unchanged.
- Bars (spec §2.4): choice p ≥ 0.6; `noul` yes ≥ 0.8 / no ≤ 0.2 / unsure between; `memory` p ≥ 0.85 and `status`
  p ≥ 0.8 keep lane 1's floors (`minConf` 0.7, `minGap` 0.5); gear = max score: ≤ 1.2 Fast, < 2.5 Default, else
  Thinking; `rule_scope` overrides its category default only at p ≥ 0.6.
- `HOUGE_MODEL_ROLES=static|resolved` (default `resolved`) and `HOUGE_JEV_TRIAGE_ENABLED` are read from `process.env`
  per call; `.env` is parsed once at boot, so a change needs a kickstart.
- Every new ledger event type gets a `requiredPayloadFields` entry (`src/run/run-ledger.ts`) or the build fails.
  Payloads carry ids, enums and numbers only — never message text, never omp's error text.
- Functions under 50 lines. Match surrounding style and comment density. Tests in `tests/<area>/` mirroring `src/`;
  each test states why the behaviour matters.
- Commands: `npm run typecheck && npm test && npm run build`. Single file: `npx vitest run tests/<path>.test.ts`.
  Commit per task, stage by name, Conventional Commits, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Repo is public: neutral fixture strings only ("以后回复短一点", "did you restart?", "明天天气怎么样").

## Decisions taken while planning (Paco, 2026-10-07, and probes)

1. **The catalog is the authority** (Paco: "the command output should be used as the latest reference, regardless
   what's in the doc"). `omp --profile houge models --json` (probed 2026-10-07; copy of the output in the build
   session's scratchpad) does **not** list `openai-codex/gpt-5.5`, today's judge seat 2 and reader leg 3, though it
   answered as a judge on 2026-10-03. Resolution keeps spec §4 step 3 (a selector the catalog does not list is
   dropped), and the code lists use catalogued ids: `gpt-5.5` → `openai-codex/gpt-6.1-sol` (one-shot probe 2026-10-07:
   `OK`, `stopReason: stop`). Static mode therefore differs from the pre-stage-A chain in that one selector.
2. **Routed effort is clamped to the model's catalogued `thinking` levels** (Paco, 2026-10-07). Resolved mode: the
   nearest supported level, ties round up (`medium` on `kimi-code/k3`, which supports `low/high/max`, becomes `high`); a
   model whose catalog `thinking` is null gets no `set_thinking_level`. Static mode: the selector's own effort only;
   routed effort is ledgered but not applied (today's semantics).
3. **The catalog moves within hours, so lists carry both generations.** Two probes on 2026-10-07, hours apart: the
   first listed `google-antigravity/claude-opus-4-6` and split ids `claude-opus-5-5-low/-medium/-high`; the second lists
   only `google-antigravity/claude-opus-5-5` and `claude-sonnet-5-5` (thinking `low/medium/high`) and no 4-6. Resolution
   drops an uncatalogued entry, so a list keeps the older id behind the newer as resilience. Fast and Thinking are new
   lists (the spec names the roles, not their lists); Paco may change any list in the plan review (a list edit in
   `src/omp/model-roles.ts`):
   - Default: `anthropic/claude-opus-5-5:medium`, `google-antigravity/claude-opus-5-5:medium`,
     `google-antigravity/claude-opus-4-6:medium`, `kimi-code/k3:low` (today's planner chain plus one Antigravity leg)
   - Fast (Rev 4, Paco 2026-10-07: k3 removed): `anthropic/claude-sonnet-5-5:low`,
     `google-antigravity/claude-sonnet-5-5:low`, `google-antigravity/gemini-3.8-flash:low`
   - Thinking: `anthropic/claude-opus-5-5:high`, `google-antigravity/claude-opus-5-5:high`,
     `google-antigravity/claude-opus-4-6:high`, `kimi-code/k3:high`
   - Reader: `google-antigravity/gemini-3.8-flash:low`, `kimi-code/k3:low`, `openai-codex/gpt-6.1-sol:low`
   - Vision: `google-antigravity/gemini-3.8-flash:low`
   - Tiny (Rev 4, Paco 2026-10-07): `kimi-code/k3:low`, `google-antigravity/gemini-3.8-flash:low` (memory ticks and the
     cascade)
   - Judges (one per seat): `kimi-code/k3`, `openai-codex/gpt-6.1-sol`, `google-antigravity/gemini-3.1-pro`
   - Chair: `anthropic/claude-opus-5-5:low` · Reviewer: `kimi-code/k3:high`, `google-antigravity/claude-opus-5-5:medium`,
     `google-antigravity/claude-opus-4-6:medium`
   These are the resolved-mode `ROLE_LISTS`; `STATIC_ROLE_LISTS` stay today's exact chains (Decision 1 as amended).
   **Kimi exits next year** (Paco is not renewing it): every list keeps a non-Kimi leg so resolution drops k3 without
   emptying a role; judge seat 1 (override key `judges:0`, `kimi-code/k3`, a single-selector seat that never falls
   back) needs a replacement then — a list edit the daily notice will prompt.
   A consequence the gate must respect: the daily change notice will fire whenever the catalog flaps a list's head.
4. **Catalog unavailable** (the CLI fails or returns no parseable list, at boot and on every tick since): resolution
   runs with static semantics for filtering (no catalog check, no clamp) but still applies overrides as exact list
   matches only; one `model_catalog_unavailable` ledger note per failed read. A catalog outage never empties a role.
5. **`get_available_models` over RPC is not used in stage A.** The CLI catalog (boot + daily tick + `/models set`) and
   the per-child refused set cover the cases the RPC read would; adding a second source creates a disagreement case
   with no owner. Flagged for Paco's plan review (spec §4 names both sources).
6. **Arming.** The six tree questions have new criteria hashes, so they arm only from new `CALIBRATED_ROWS` committed on
   Paco's word after the replay (spec §7). Until then every turn routes `uncalibrated` → planner on Default, and the
   memory and status lanes **do not act** (the lane 1 rows name the retired lane 1 hashes). Sequence: build → replay on a
   DB copy (Task 12 CLI) → Paco commits rows → live gate armed → merge → kickstart. The lane 1 questions, `triageVerdict`
   and their rows leave the live path in Task 10; the files go in Task 12 Step 3f (orphans of this change).
7. **`OmpConfig` keeps its seven chain fields**, now filled from the resolver: `resolveOmpConfig(env, chains =
   staticRoleChains())`. Every existing `cfg.reader` / `cfg.judges` / … consumer keeps working; callers that hold a
   `RoleResolver` pass `roles.chains()`. The seven `HOUGE_OMP_*` chain variables are removed from `DEFAULTS` (a set
   variable is ignored and named once in a boot warning).

## Rev 4 rulings (Paco, 2026-10-07; these win over the Rev 2 blocks below where they disagree)

13. **No omp version pin (shipped on main 2026-10-07, `a49da40`; the contract probe is a separate slice).** Paco
    2026-10-07: no hard-coded omp version, as with model chains. `HOUGE_OMP_VERSION` / `_ALLOW` are gone;
    `checkOmpVersion(cfg)` accepts any `x.y.z` and refuses only an omp that will not run or prints no version
    (`not_runnable` / `no_version` → incident `omp_unavailable`). A follow-up slice (ROADMAP) adds a once-per-new-version
    contract probe (catalog parses, start/pin refusal texts classify, an RPC session opens). Stage A adds no version text.
14. **The cascade is live in stage A, bounded at 20 s (reverses Rev 2's Decision 8 deferral, Q5, F10).** A below-bar
    turn with two candidates makes one one-shot under the new `LlmCallRole` `"cascade"`, which `seatChain` maps to the
    Tiny chain (`cfg.ticks`, through its `default` branch, `src/llm/registry.ts:140`). The prompt names the two
    categories (with their criteria) and asks for exactly one name; the answer is parsed as an exact token (surrounding
    quotes, backticks, asterisks and a final full stop stripped, case folded). The whole pick is bounded at
    `CASCADE_TIMEOUT_MS = 20 000` on the user's path, raced against the turn's own signal; the omp legs carry an 18 s
    chain deadline inside it (`OneShotAdapterOptions.deadlineMs`), so a slow leg is audited `timeout` rather than cut
    as `shutdown`. A failure, timeout or answer outside the two → `applyCascade(plan, null)`: `cascade_failed`, planner
    on Default, nothing saved (Task 5 F5). The verdict's `cascade` column reads `tiny` whenever the call was made (Rev 5:
    the role's name, not a vendor's; the spec's `kimi` is amended in Task 14 Step 1b, and the Tiny leg that answered is
    on the `llm_attempt` row), and the `triage` event carries
    `cascade_between: [a, b]`. The value `deferred` is gone from the type and the CHECK. In shadow mode nothing is armed,
    so no plan reaches the cascade and no call is made.

Interface contract deltas (Rev 4; Task 10 owns all of them):

```ts
// src/run/run-store.ts — LlmCallRole gains "cascade" (seatChain's default branch → cfg.ticks = the Tiny role)
// src/llm/providers/omp.ts — OneShotInput gains `deadlineAt?: number` (epoch ms; each leg's timeout is what it leaves;
//   no leg starts once it has passed — that leg is not audited, since it never ran)
// src/llm/registry.ts — OneShotAdapterOptions gains `deadlineMs?: number` (→ deadlineAt = Date.now() + deadlineMs per call)
// src/core/core-worker.ts
export const CASCADE_TIMEOUT_MS = 20_000;
export function parseCascadePick(answer: string, between: readonly [Category, Category]): Category | null;
// JevVerdictInsert / JevVerdictRow: cascade: "tiny" | null (as the Ledger contract below; no "deferred")
```


## Rev 2 additions (review gate round 1 folded in, 2026-10-07)

Both plan reviews of Rev 1 (Codex: 5 blockers, 3 risks; senior live-probe: 4 blockers, 7 warnings) were verified first-hand; every confirmed finding is folded into Tasks 5–11 and 13 below. Where these blocks and the Rev 1 Decisions / contract above disagree, these win.

#### Decisions (Stream A: roles, supervisor)


- **Decision 1, replace the last sentence:** "`ROLE_LISTS` (resolved mode) use catalogued ids. `STATIC_ROLE_LISTS`
  (`HOUGE_MODEL_ROLES=static`, and every caller with no resolver) are today's seven `HOUGE_OMP_*` defaults string for
  string, `openai-codex/gpt-5.5` included. Static mode therefore runs the pre-stage-A chains seat for seat. Its accepted
  residual differences: (a) a selector the running child refused is skipped for the child's life (Q9); (b) the respawn
  onto planner[0] at the next turn is gone (Task 8: `set_model` moves the live child); (c) while
  `HOUGE_JEV_TRIAGE_ENABLED` is not `off`, routed turns may step up and retry `other` once. `off` + static, after
  a kickstart, is the **model-list rollback**: (a) holds even then, and (b) is gone in every mode, so it is not today's
  supervisor exactly. Restoring today's behaviour in full (lane 1 included) is a `git revert` of the merge, a rebuild and a
  kickstart (Task 14 Step 4 documents the procedure)."
- **Decision 4, replace with:** "Catalog unavailable (the CLI fails or returns no parseable list): resolution keeps each
  `ROLE_LISTS` entry whole (no catalog check, no clamp) and applies overrides as exact list matches only. Each failed
  read leaves one `model_catalog_unavailable` ledger note. A failed read is retried hourly. Two consecutive failures open
  the alerted incident `model_catalog_unavailable` (subject `omp`), and the next good read resolves it. A catalog outage
  never empties a role. A catalog that does empty a role (it lists none of the role's selectors) sends Fast up a role
  and every other role to its static list (one `model_roles_fallback` note per role per read). A `no_planner_leg` asks
  for a re-read at most once per 10 minutes."
- **Decision 7, replace "`staticRoleChains()`" sentence:** "`resolveOmpConfig(env, chains = staticRoleChains())`:
  without a resolver the seat chains are today's exactly."
- **Open questions:** Q10 staleness part superseded by F14 (hourly retry + incident). Q12 closed by F15. Q16 applies in
  resolved mode only.

#### Decisions (Stream B: policy, decision point, gate)


8. ~~The cascade call is deferred to stage B~~ **Superseded by Decision 14 (Paco, Rev 4): the cascade is live in stage
   A on the Tiny role, bounded at 20 s.** The senior review's cost reading stays on record: in stage A the cascade only
   picks Fast/Default/Thinking (memory and status are removed before the call), and a k3 one-shot cost p50 7.7 s / p90
   14.3 s (78 live rows) on the user's path; the 20 s bound caps the tail, and a failure still saves nothing.
9. **Arming is per decision, and two couplings are Paco's call at row commit.** Rows arm `category`, the status
   pseudo-row `category:status`, `rule` (`sets_rule` + `rule_scope` together) and `gear` (the three scores)
   independently. (a) The **memory lane needs `category` + `rule` rows**, and the **status lane needs `status` + `rule`
   rows** (so a stated rule is never swallowed by a code reply that could not read it). (b) **Arming `category` alone
   already changes the model path**: research turns run on Thinking and self_change / machine_task / schedule / wiki /
   mail_calendar / other on at least Default (the role floors), even with `gear` unarmed. "Lane 1 parity only" (memory
   + status, no model change) is therefore not available; the Task 12 report should show, per arming combination,
   which turns change model.
10. **Rollback and the `off` exit.** `HOUGE_JEV_TRIAGE_ENABLED=off` writes exactly one verdict row (category null,
    Default, reason `jev_skipped`, skip `disabled`) and one `triage` event, and attaches **no route**, so the supervisor
    pins nothing (no `routed_by`, no step-up) and `think harder` is ignored. With `HOUGE_MODEL_ROLES=static` that is the
    pre-stage-A model path, except the residual static differences Stream A lists. The disarm marker caps at `shadow`,
    which still attaches the Default route: only `off` + kickstart reverts the model path. Restoring lane 1 itself is a
    `git revert` of the merge + rebuild + kickstart.
11. **Merge gate.** Memory and status stop acting on any build without the tree's rows (Decision 6), so the merge is
    blocked until they arm: after Paco commits `CALIBRATED_ROWS`, `scripts/live-gate-jev-tree.mjs --real-calibration`
    must PASS, including its check that the committed rows arm `category`, `rule`, `status` and `memory` in zh and en,
    and cases 1 (memory) and 2 (status) acting (INCONCLUSIVE there is a FAIL). Before that, omp's startup check must
    pass: omp runs and reports a version (Decision 13; no pin since `a49da40`).
12. **A verdict never stays `pending`.** Every run terminal (`ompComplete`, `ompFail`, lease recovery; every supervisor
    path and the boot recovery funnel into these) closes a still-pending verdict, guarded on `pending`, so §7/§9
    evidence and the `lane_fallthrough_rate` sweep never count an open turn.

Open-questions table updates: **Q5** → (Rev 4) "Live, Tiny role, 20 s bound (Decision 14)". **Q10** → "Refused in static;
validated against the cached catalog; a failed read retries hourly and pages after 2 failures (F14, Task 7)". **Q12** →
"Closed: `llm_attempt` carries `effort` (Task 8), asserted by Task 13". **Decision 6** gains: "merge is blocked until
they arm (Decision 11)".

---

#### Interface contract deltas


```ts
// src/omp/model-roles.ts — added
export const STATIC_ROLE_LISTS: Readonly<Record<RoleName, readonly string[]>>; // today's HOUGE_OMP_* defaults; fast = thinking = default
export function roleSelectors(role: RoleName, seat?: number, mode?: ModelRolesMode): ModelString[];
// staticRoleChains() reads STATIC_ROLE_LISTS; resolveRole(mode "static") reads STATIC_ROLE_LISTS

// src/omp/role-resolver.ts — added
export const CATALOG_RETRY_MS: number;        // 1 h
export const CATALOG_INCIDENT_AFTER: number;  // 2
export const NO_LEG_REFRESH_MS: number;       // 10 min
class RoleResolver {
  constructor(d: { store; env?; readCatalog; now?: () => number });
  retryFailedRead(): Promise<boolean> | null; // null = nothing due
  requestRefresh(): void;                     // fire-and-forget, rate-limited
}
// candidates()/chains(): F7 fallback; resolveAll(): no fallback (head null when emptied)

// src/omp/planner-supervisor.ts
// SupervisorDeps.roles: Pick<RoleResolver, "candidates" | "requestRefresh">

// src/llm/audit.ts — LlmAttempt gains effort?: OmpEffort (on the llm_attempt payload when set)
// ledger (Task 9 owns): model_roles_fallback {role}
// incident (Task 7 owns): model_catalog_unavailable, subject "omp"
```

---

## Interface contract (every task's implementer reads this)

Names below are binding across tasks. A task may add private helpers; it may not rename these.

### Jev client and questions (Tasks 1–3)

```ts
// src/jev/jev-client.ts
export interface JevChoiceQuestion { type: "choice"; instructions: string; criteria: Record<string, string> }
export interface JevScoreQuestion  { type: "score";  instructions: string; criteria: string[] }            // ordered levels, 2–10
export interface JevNoulQuestion   { type: "noul";   instructions: string; criteria?: { true: string; false: string } }
export type JevQuestion = JevChoiceQuestion | JevScoreQuestion | JevNoulQuestion;
export interface JevRequest { state: unknown; questions: Record<string, JevQuestion> }
export interface JevChoiceAnswer { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
export interface JevScoreAnswer  { type: "score"; score: number; probabilities: Record<string, number>; confidence: number } // keys "0".."n-1"
export interface JevNoulAnswer   { type: "noul"; noul: number }                                                              // p(yes), no confidence
export type JevAnswer = JevChoiceAnswer | JevScoreAnswer | JevNoulAnswer;
// JevResult ok-branch: answers: Record<string, JevAnswer>

// src/jev/questions/types.ts
export interface ChoiceQuestion { id: string; type: "choice"; instructions: string; criteria: ReadonlyArray<readonly [string, string]> }
export interface ScoreQuestion  { id: string; type: "score";  instructions: string; levels: readonly string[] }
export interface NoulQuestion   { id: string; type: "noul";   instructions: string; criteria?: { true: string; false: string } }
export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;
export function optionsOf(q: ChoiceQuestion): string[];
export function toJevQuestion(q: Question): JevQuestion;
export function criteriaHash(q: Question): string; // a ChoiceQuestion hashes byte-identically to today

// src/jev/decide.ts — Decision.answered.answers: Record<string, JevAnswer>; marginOf(a: JevAnswer): number;
// per-type row: choice as today; score answers_json = level probabilities, confidence, top_prob, margin p1−p2;
// noul answers_json = {"true": p, "false": 1 − p}, confidence null, top_prob max(p, 1 − p), margin |2p − 1|.
export function topProbOf(a: JevAnswer): number;

// src/jev/questions/tree.ts
export const CATEGORIES = ["answer", "lookup", "research", "memory", "self_change", "machine_task", "schedule", "wiki",
  "mail_calendar", "status", "other"] as const;
export type Category = (typeof CATEGORIES)[number];
export const TREE_CATEGORY: ChoiceQuestion;   // id "category"
export const TREE_SETS_RULE: NoulQuestion;    // id "sets_rule"
export const TREE_RULE_SCOPE: ChoiceQuestion; // id "rule_scope"; options "ask", "research"
export const TREE_BREADTH: ScoreQuestion;     // id "breadth"
export const TREE_REASONING: ScoreQuestion;   // id "reasoning"
export const TREE_ACTIONS: ScoreQuestion;     // id "actions"
export const TREE_QUESTIONS: readonly Question[]; // the six, in that order
export type HougeTurnKind = "answer" | "clarify" | "proposal";
export type LastHougeTurn = { kind: HougeTurnKind; age_s: number } | null;
export function isProposal(text: string): boolean;               // code regex, spec §2.2
export function lastHougeTurnOf(recent: ChatTurnRow[], nowMs: number): LastHougeTurn;
export function quotedTurnFromRow(row: ChatTurnRow, nowMs: number): QuotedTurn; // one builder for live and replay
export interface QuotedTurn { role: "houge" | "user"; kind: HougeTurnKind; age_s: number; text: string }
export interface TreeStateInput { userText: string; recentTurns: ChatTurnRow[]; turnChars: number; modality: TurnModality;
  lastHougeTurn: LastHougeTurn; quotedTurn: QuotedTurn | null }
export type TreeStateResult = { ok: true; state: Record<string, unknown>; chars: number } | { ok: false; skip: "state_too_large" };
export function buildTreeState(i: TreeStateInput, brokerRedact?: (s: string) => string): TreeStateResult;
```

### Quote (Task 4)

```ts
// src/run/run-store.ts
// ChatTurnRow gains `quoted_turn_id: string | null`; recordChatTurn input gains `quoted_turn_id?: string`.
// Migration "2026-10-07-chat-turns-quoted": ALTER TABLE chat_turns ADD COLUMN quoted_turn_id TEXT.
export type QuoteResolution =
  | { ok: true; role: "houge" | "user"; turn: ChatTurnRow }
  | { ok: false; reason: "no_mapping" | "ambiguous" | "not_final" };
resolveQuotedTurn(chat_id: string, reply_to_message_id: number): QuoteResolution;

// src/omp/turn-context.ts — TurnPromptInput gains `quoted?: string` (one rendered line, ends with "\n");
// buildTurnPrompt: `${note}${s.seed}${prefix}${cap}${context}${quoted}${i.message}`.
export function quotedLine(q: QuotedTurn, turnChars: number): string; // "[replying to houge, 3600 s ago: …]\n"
```

### Routing policy (Task 5)

```ts
// src/jev/tree-policy.ts
export type TurnRole = "fast" | "default" | "thinking";
export type Effort = "low" | "medium" | "high";
export type Lane = "memory" | "status" | "planner";
export type PreJudge = { kind: "ack_answer" } | { kind: "judge"; thinkHarder: boolean };
export function preJudge(i: { text: string; lastHougeTurn: LastHougeTurn; quoted: boolean }): PreJudge;
export interface TreeBars { choice: number; nounYes: number; nounNo: number; memory: number; status: number; minConf: number;
  minGap: number; ruleScope: number; gearLight: number; gearHeavy: number }
export const TREE_BAR_DEFAULTS: TreeBars; // 0.6, 0.8, 0.2, 0.85, 0.8, 0.7, 0.5, 0.6, 1.2, 2.5
export interface Armed { category: boolean; status: boolean; memory: boolean; gear: boolean; rule: boolean }
export function treeArmed(lang: Lang, model: string, rows: readonly CalibrationRow[]): Armed; // "category:status" pseudo-row arms status
export function treeArmingRows(rows: readonly CalibrationRow[]): CalibrationRow[]; // Rev 5: what the alias-move page counts
export type RouteReason = "routed" | "uncalibrated" | "below_bar" | "bare_ack_guard" | "lane_limits" | "correction"
  | "cascade" | "cascade_failed" | "ack_rule" | "jev_skipped";
export interface Route { category: Category | null; lane: Lane; role: TurnRole; effort: Effort | null;
  save: { scope: "ask" | "research" } | null; reason: RouteReason; cascade: "tiny" | null; thinkHarder: boolean }
export type RoutePlan = { kind: "final"; route: Route } | { kind: "cascade"; between: readonly [Category, Category]; base: Route };
export function routeTree(answers: Record<string, JevAnswer>, o: { bars: TreeBars; armed: Armed; thinkHarder: boolean; bareAck: boolean }): RoutePlan;
export function applyCascade(plan: Extract<RoutePlan, { kind: "cascade" }>, pick: Category | null): Route;
export function fallbackRoute(reason: RouteReason, thinkHarder: boolean): Route; // planner, Default, effort null
export const ROLE_FLOOR: Readonly<Record<Category, TurnRole | null>>;
```

### Roles (Tasks 6–7)

```ts
// src/omp/model-roles.ts
export type RoleName = "fast" | "default" | "thinking" | "reader" | "vision" | "tiny" | "judges" | "chair" | "reviewer";
export const ROLE_NAMES: readonly RoleName[];
export const ROLE_LISTS: Readonly<Record<RoleName, readonly string[]>>; // judges: one selector per seat index
export const ALLOWED_PROVIDERS: readonly string[];
export const CHAT_ROLES: ReadonlySet<RoleName>;   // fast, default, thinking, vision, tiny: never openai-codex
export interface CatalogModel { provider: string; id: string; thinking: readonly OmpEffort[] | null }
export type ModelRolesMode = "static" | "resolved";
export function resolveModelRolesMode(env: NodeJS.ProcessEnv): ModelRolesMode;
export const selectorKey = (m: Pick<ModelString, "provider" | "model">): string => `${m.provider}/${m.model}`;
export interface ResolveInput { role: RoleName; seat?: number; catalog: readonly CatalogModel[] | null; override: string | null;
  refused: ReadonlySet<string>; mode: ModelRolesMode }
export function resolveRole(i: ResolveInput): ModelString[];                       // pure, spec §4 steps 1–4
export function matchOverride(pattern: string, role: RoleName, catalog: readonly CatalogModel[]): CatalogModel[];
export function clampEffort(m: ModelString, effort: Effort | null, catalog: readonly CatalogModel[] | null, mode: ModelRolesMode): ModelString;
export const STEP_UP: Readonly<Record<TurnRole, TurnRole | null>>;                 // fast→default→thinking→null
export interface RoleChains { planner: ModelString[]; reader: ModelString[]; media: ModelString[]; ticks: ModelString[];
  judges: ModelString[]; chair: ModelString[]; reviewer: ModelString[] }
export function staticRoleChains(): RoleChains;

// src/omp/model-catalog.ts
export function parseOmpCatalog(json: string): CatalogModel[] | null;           // validates {models:[{provider,id,thinking}]}
export function readOmpCatalog(cfg: Pick<OmpConfig, "bin" | "profile">, exec?: ExecFileAsync): Promise<CatalogModel[] | null>;

// src/omp/role-resolver.ts
export type OverrideKey = RoleName | `judges:${number}`;
export interface ResolvedRole { key: OverrideKey; head: string | null; candidates: string[]; source: "list" | "override" }
export class RoleResolver {
  constructor(d: { store: RunStore; env?: () => NodeJS.ProcessEnv; readCatalog: () => Promise<CatalogModel[] | null> });
  refreshCatalog(): Promise<boolean>;
  catalog(): readonly CatalogModel[] | null;
  candidates(role: RoleName, o?: { refused?: ReadonlySet<string>; effort?: Effort | null; seat?: number }): ModelString[];
  chains(): RoleChains;
  resolveAll(): ResolvedRole[];
}
// src/omp/omp-config.ts — resolveOmpConfig(env, chains: RoleChains = staticRoleChains()): OmpConfig
// src/run/run-store.ts — latestModelRoleOverrides(): Map<OverrideKey, string>  (latest per key; "" = reset → absent)
//                        recordModelRoleOverride(i: { key: OverrideKey; pattern: string; actor: string }): void
```

### Supervisor (Task 8)

```ts
// src/omp/planner-supervisor.ts
export interface TurnRoute { role: TurnRole; effort: Effort | null; verdict_id: string | null }
export type TriageOutcome =
  | { kind: "fallthrough"; route?: TurnRoute; quote?: QuoteRef }
  | { kind: "inform"; note: string; route?: TurnRoute; quote?: QuoteRef }
  | { kind: "lane_reply"; text: string; buttons: NotificationButton[]; quote?: QuoteRef };
export interface QuoteRef { turn_id: string; line: string } // line = quotedLine(...)
// SupervisorDeps gains: roles: Pick<RoleResolver, "candidates">
// TurnOutcomeSink gains: routeEnd?(i: { run_id: string; verdict_id: string; handler_outcome: "planner_done" | "planner_failed";
//   model: string | null; fast_used_tool: boolean; pin_failed: boolean }): void
// PlannerRpcError gains `readonly detail?: string` (omp's text, ≤ 200 chars, for classifyOmpError only; never in a ref or incident)
// LlmAttempt (src/llm/audit.ts) gains `routed_by?: string`; the llm_attempt payload carries it when set.
// Ledger event "routed_escalation" {from: string, to: string, kind: LlmErrorKind}, written by the supervisor.
```

### Ledger (Task 9)

```ts
// table jev_verdicts (migration "2026-10-07-jev-verdicts")
// verdict_id TEXT PK, run_id TEXT NOT NULL, category TEXT, breadth REAL, reasoning REAL, actions REAL, sets_rule REAL,
// rule_scope TEXT, lane TEXT NOT NULL, role TEXT NOT NULL, effort TEXT, model TEXT, cascade TEXT,
// save_outcome TEXT NOT NULL CHECK IN ('saved','not_durable','capped','none'),
// route_outcome TEXT NOT NULL CHECK IN ('act','fallback','pin_failed'),
// handler_outcome TEXT NOT NULL ('pending' | 'lane_reply' | 'fallthrough:<reason>' | 'planner_done' | 'planner_failed'),
// reason TEXT NOT NULL, skip_reason TEXT, fast_used_tool INTEGER NOT NULL DEFAULT 0, paco_correction TEXT,
// quoted_turn_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL; index (run_id).
export interface JevVerdictInsert { run_id: string; category: Category | null; breadth: number | null; reasoning: number | null;
  actions: number | null; sets_rule: number | null; rule_scope: "ask" | "research" | null; lane: Lane; role: TurnRole;
  effort: Effort | null; cascade: "tiny" | null; save_outcome: "saved" | "not_durable" | "capped" | "none";
  route_outcome: "act" | "fallback"; reason: RouteReason; skip_reason: SkipReason | null; quoted_turn_id: string | null; created_at?: string }
insertJevVerdict(i: JevVerdictInsert): string;                         // returns verdict_id
updateJevVerdict(verdict_id: string, p: Partial<{ handler_outcome: string; model: string | null; route_outcome: "pin_failed";
  fast_used_tool: boolean; paco_correction: "ask_anyway" | "think_harder" | "escalation" | "low_rating" }>): void;
getJevVerdictForRun(run_id: string): JevVerdictRow | undefined;
latestJevVerdictForChat(chat_id: string, beforeIso: string): JevVerdictRow | undefined;
// "triage" event payload gains: category, route_lane, role, verdict_id (required fields list updated).
```

### Commands and ticks (Task 11)

```ts
// src/triggers/telegram-command-parser.ts
| { type: "models"; action: "list" }
| { type: "models"; action: "set"; role: RoleName; seat?: number; pattern: string }
| { type: "models"; action: "reset"; role: RoleName; seat?: number }
// src/gateway/models-commands.ts
export function handleModels(store: RunStore, roles: RoleResolver, event: TypedTaskEvent): GatewayIntakeResult;
// src/omp/model-roles-tick.ts
export function runModelRolesTick(i: { store: RunStore; roles: RoleResolver; now: string; signal?: AbortSignal;
  notify: (text: string) => void }): Promise<{ ran: boolean; changed: string[]; unresolved: string[] }>;
// ledger: "model_roles_resolved" {roles: ResolvedRole[] as JSON-safe heads/candidates}, "model_role_override" {key, pattern, actor},
// "model_catalog_unavailable" {reason}; incidents: "role_unresolved" (subject = role key); sweep kind "lane_fallthrough_rate".
```

---

## File map

| File | Responsibility | Task |
|---|---|---|
| `src/jev/jev-client.ts` | three wire types, per-type validation | 1 |
| `src/jev/questions/types.ts` | `Question` union, `toJevQuestion`, `criteriaHash` per shape | 1 |
| `src/jev/decide.ts` | per-type rows, `marginOf` / `topProbOf` over the union | 2 |
| `src/jev/questions/tree.ts` (new) | six frozen questions, `isProposal`, `lastHougeTurnOf`, `buildTreeState` | 3 |
| `src/run/run-store.ts`, `src/omp/turn-context.ts` | quote resolution, `chat_turns.quoted_turn_id`, `quotedLine`, prompt slot | 4 |
| `src/jev/tree-policy.ts` (new) | `preJudge`, `routeTree`, `applyCascade`, bars, arming | 5 |
| `src/omp/model-roles.ts`, `src/omp/model-catalog.ts` (new) | code lists, pure resolution, effort clamp, catalog parse/read | 6 |
| `src/omp/role-resolver.ts` (new), `src/omp/omp-config.ts`, `src/llm/registry.ts`, `src/llm/providers/omp.ts`, `src/status/houge-status.ts`, `src/core/core-worker.ts` (config call sites), `src/run/run-store.ts` (override rows) | resolver service, seat consumers on resolved chains, D10 skip rule | 7 |
| `src/omp/planner-supervisor.ts`, `src/omp/planner-session.ts`, `src/llm/audit.ts`, `src/run/run-store.ts` (`routed_by`) | two-axis chain | 8 |
| `src/run/run-store.ts`, `src/run/run-ledger.ts` | `jev_verdicts`, new event types | 9 |
| `src/core/core-worker.ts`, `src/jev/calibration.ts`, `src/run/run-store.ts` (`LlmCallRole` `cascade`), `src/llm/registry.ts` + `src/llm/providers/omp.ts` (chain deadline), remove `src/jev/questions/triage.ts` + lane 1 `thresholds.ts` parts | the decision point, the live cascade (Tiny, 20 s), lanes on the tree, corrections | 10 |
| `src/triggers/*`, `src/gateway/gateway.ts`, `src/gateway/models-commands.ts` (new), `src/omp/model-roles-tick.ts` (new), `src/telegram/telegram-daemon.ts`, `src/run/invariant-sweep.ts` | `/models`, daily tick + notice + `role_unresolved`, `lane_fallthrough_rate` | 11 |
| `src/jev/triage-replay.ts`, `src/jev/triage-report.ts`, `src/jev/replay-core.ts`, `src/jev/replay-report.ts`, `src/cli.ts` | replay over the union, proxy labels, report | 12 |
| `scripts/live-gate-jev-tree.mjs` (new) | stage A live gate | 13 |
| docs (ADR 0029/0028 amendments, `configuration.md`, `jev-decision-layer.md`, `CONTEXT.md`, README, `tasks/todo.md`, `sessions.md`) | ship | 14 |

**Execution order (binding):** 1 → 2 → 3 → 4 → 5 → 9 → 6 → 7 → 8 → 10 → 11 → 12 → 13 → 14. Task 9 is the single owner
of every new stage A ledger event type, so it lands before any writer (Tasks 7, 8, 10, 11). Sections below are in task-number
order; each task opens with any binding **Assembly overrides** that reconcile it with its neighbours.

---

## Open questions for review (each has a default the tasks implement; Paco or a reviewer may overturn)

| # | Question | Default in the tasks | Task |
|---|---|---|---|
| Q1 | The "agrees to / continues something Houge offered" clause is on `breadth`, `reasoning`, `actions` too, not only `category` | Kept: without it a bare "好" accepting a heavy offer scores level 0 and runs light | 3 |
| Q2 | `status` also gets lane 1's floors (confidence ≥ 0.7, top-two gap ≥ 0.5), which lane 1 applied to memory only | Kept: stricter on a no-planner lane | 5 |
| Q3 | `sets_rule` = yes inside a status question | Save, then the planner (the status lane is a code reply that would not mention the saved lesson) | 5 |
| Q4 | `HOUGE_JEV_TRIAGE_ENABLED=shadow` | Treated as nothing armed: Default route, Jev's answers kept in `jev_decisions` only | 10 |
| Q5 | Cascade in stage A | **Closed (Paco, Rev 4, Decision 14): live, on the Tiny role (`LlmCallRole` `cascade`), bounded at 20 s.** Failure / timeout / an answer outside the two → `cascade_failed`, planner on Default, nothing saved; the verdict reads `cascade = 'tiny'` and the `triage` event carries `cascade_between`. (Rev 2 had deferred it: k3 one-shot p50 7.7 s / p90 14.3 s, and in stage A the cascade only picks a role.) | 5, 10, 12, 13 |
| Q6 | Env overrides for the tree bars (lane 1 had `HOUGE_JEV_TRIAGE_MIN_*`) | None; the three lane 1 variables are no longer read and leave `configuration.md` | 5, 14 |
| Q7 | A `/models` override's place in the candidate list | Override matches first, then the role's catalogued list as fallback | 6 |
| Q8 | Catalog unavailable: routed effort | Not applied (no levels to clamp to) | 6 |
| Q9 | Refused set in `static` mode | Applied (a refusal is evidence in any mode) | 6, 8 |
| Q10 | `/models set` in `static` mode; catalog staleness | Refused in static; validated against the cached catalog; a failed read is retried hourly and the 2nd consecutive failure opens alerted incident `model_catalog_unavailable` (Task 7 owns it) | 7, 11 |
| Q11 | Boot catalog read | Awaited before the first poll, bounded at 15 s | 7 |
| Q12 | The gate could not tell a Thinking pin from a Default one | **Closed:** `llm_attempt` carries `effort` (Task 8); the gate asserts it (Task 13) | 8, 13 |
| Q13 | Replay proxy labels: "steps" | Counts `web_search` + `http_fetch` steps only; runs whose tools match no rule are unlabelled | 12 |
| Q14 | `get_available_models` over RPC (spec §4 names it) | Not used (Decision 5) | — |
| Q15 | A quote whose outbox row is absent | `no_mapping`; `ambiguous` only when several rows match | 4 |
| Q16 | D10 skip rule ordering | Every other-family reader candidate runs before the same-family ones (spec says the first) | 7 |

---

### Task 1: Jev client and question union — three wire types, per-type validation, per-shape `criteriaHash`

**Contract deviation:** one exported helper is added beyond the contract, `choiceAnswer(a: JevAnswer | undefined):
JevChoiceAnswer | undefined` in `src/jev/jev-client.ts`. `JevResult.answers` widens to `JevAnswer` in this task, and five
existing consumers read `.choice` / `.probabilities` / `.confidence` off it (`decide.ts`, `thresholds.ts`,
`triage-replay.ts`, `replay.ts`, and `core-worker.ts` through `Decision`). Without a narrowing helper this commit does not
typecheck, so the lane 1 consumers narrow through `choiceAnswer`. Task 5 (`routeTree`) can use it too. Nothing is renamed.

**Sequencing note:** after this task `decide()` still persists **choice answers only**. A score or noul answer is
`skipped{parse}` (a small bridge, about 6 lines, in `decide.ts`). Task 2 replaces the bridge with per-type rows. Each commit
typechecks and passes the suite. Behaviour does not change for any question that ships today, because every lane 1 and
intent question is a choice.

**Files:**
- Modify: `src/jev/jev-client.ts:23-39` (wire types), `:149-190` (`validateResponse`, `validateChoice` → per-type validators)
- Modify: `src/jev/questions/types.ts:1-30` (whole file: `Question` union, `toJevQuestion`, `criteriaHash` per shape)
- Modify: `src/jev/questions/triage.ts:6,13,35,45` (the three lane 1 questions typed `ChoiceQuestion`; `optionsOf` now takes one)
- Modify: `src/jev/decide.ts:4,77,83,91` (choice-only bridge)
- Modify: `src/jev/thresholds.ts:3,51-52` (`triageVerdict` takes `Record<string, JevAnswer>`, narrows)
- Modify: `src/jev/triage-replay.ts:9,11,45,61,148,162-166` (narrow; `ChoiceQuestion` for the permuted lane)
- Modify: `src/jev/triage-report.ts:46-48` (literal answers gain `type: "choice"`)
- Modify: `src/jev/replay.ts:9,153` (narrow the intent answer)
- Test: `tests/jev/jev-client.test.ts` (new describe block; line 39 narrowed), `tests/jev/questions.test.ts` (new describe
  block; helper typed `ChoiceQuestion`), plus type-only fixture updates in `tests/jev/thresholds.test.ts:17`,
  `tests/jev/decide.test.ts:119`, `tests/jev/replay.test.ts:15`, `tests/jev/triage-replay.test.ts:176-177`

**Interfaces:**
- Consumes: nothing new.
- Produces (contract, verbatim):
  ```ts
  // src/jev/jev-client.ts
  export interface JevChoiceQuestion { type: "choice"; instructions: string; criteria: Record<string, string> }
  export interface JevScoreQuestion  { type: "score";  instructions: string; criteria: string[] }
  export interface JevNoulQuestion   { type: "noul";   instructions: string; criteria?: { true: string; false: string } }
  export type JevQuestion = JevChoiceQuestion | JevScoreQuestion | JevNoulQuestion;
  export interface JevRequest { state: unknown; questions: Record<string, JevQuestion> }
  export interface JevChoiceAnswer { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  export interface JevScoreAnswer  { type: "score"; score: number; probabilities: Record<string, number>; confidence: number }
  export interface JevNoulAnswer   { type: "noul"; noul: number }
  export type JevAnswer = JevChoiceAnswer | JevScoreAnswer | JevNoulAnswer;
  // JevResult ok-branch: answers: Record<string, JevAnswer>
  export function choiceAnswer(a: JevAnswer | undefined): JevChoiceAnswer | undefined; // added (see deviation)

  // src/jev/questions/types.ts
  export interface ChoiceQuestion { id: string; type: "choice"; instructions: string; criteria: ReadonlyArray<readonly [string, string]> }
  export interface ScoreQuestion  { id: string; type: "score";  instructions: string; levels: readonly string[] }
  export interface NoulQuestion   { id: string; type: "noul";   instructions: string; criteria?: { true: string; false: string } }
  export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;
  export function optionsOf(q: ChoiceQuestion): string[];
  export function toJevQuestion(q: Question): JevQuestion;
  export function criteriaHash(q: Question): string; // a ChoiceQuestion hashes byte-identically to today
  ```

Validation codes. Each one ends up in `detail: "response failed validation: <code>"` and makes the whole call
`{ok:false, reason:"error", error_kind:"parse"}`, which `decide()` maps to `skipped{parse}`. The existing codes are
unchanged: `not_choice`, `choice_not_option`, `confidence_out_of_range`, `probabilities_missing`, `probability_keys`,
`probability_range`, `probability_sum`, `choice_not_argmax`. New codes:
- `not_score`: wrong type, or the score is not a finite number.
- `score_out_of_range`: the score is outside [0, n−1].
- `not_noul`: wrong type, or the noul is not a number.
- `noul_out_of_range`: the noul is outside [0, 1] or is not finite.

Score probabilities must be keyed exactly `"0".."n-1"`, otherwise `probability_keys`. They must also be in range and sum
to 1, otherwise `probability_range` or `probability_sum`. The answer's `type` must equal the question's `type`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/jev/jev-client.test.ts`. The file already defines `json`, `client`, `REPORTED` (the versioned id a response reports) and `JevRequest`:

```ts
// Spec §2.3: the tree asks all three TypeSafe types in one request. One malformed answer of ANY type fails the whole call
// as parse (skipped, never partial): a gate must never read a half-validated answer set as "this question said nothing".
describe("createJevClient — three answer types (spec §2.3)", () => {
  const LEVELS = ["none", "one or two reads", "several including changes", "many with checks"];
  const REQ3: JevRequest = {
    state: { latest_message: "明天天气怎么样" },
    questions: {
      category: { type: "choice", instructions: "pick", criteria: { other: "o", lookup: "l" } },
      actions: { type: "score", instructions: "how many", criteria: LEVELS },
      sets_rule: { type: "noul", instructions: "a rule?" }
    }
  };
  const answers3 = (over: Record<string, unknown> = {}) => ({
    category: { type: "choice", choice: "lookup", probabilities: { other: 0.2, lookup: 0.8 }, confidence: 0.6 },
    actions: { type: "score", score: 1.1, legend: { "0": "none" }, probabilities: { "0": 0.1, "1": 0.7, "2": 0.2, "3": 0 }, confidence: 0.7 },
    sets_rule: { type: "noul", noul: 0.05 },
    ...over
  });
  const body3 = (over: Record<string, unknown> = {}) => ({ model: REPORTED, answers: answers3(over), usage: { input_tokens: 500, output_tokens: 0 } });

  it("round-trips one answer of each type, typed by its discriminant; a noul carries no confidence", async () => {
    const fetchImpl = vi.fn(async () => json(200, body3()));
    const { call } = client(fetchImpl as unknown as typeof fetch);
    const r = await call(REQ3);
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.answers.category).toEqual({ type: "choice", choice: "lookup", probabilities: { other: 0.2, lookup: 0.8 }, confidence: 0.6 });
    expect(r.answers.actions).toEqual({ type: "score", score: 1.1, probabilities: { "0": 0.1, "1": 0.7, "2": 0.2, "3": 0 }, confidence: 0.7 });
    expect(r.answers.sets_rule).toEqual({ type: "noul", noul: 0.05 });
    // The request carries each type's wire shape untouched (score levels as an ordered array).
    const sent = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as { questions: Record<string, unknown> };
    expect(sent.questions.actions).toEqual({ type: "score", instructions: "how many", criteria: LEVELS });
  });

  it.each([
    ["a noul above 1", { sets_rule: { type: "noul", noul: 1.2 } }, "noul_out_of_range"],
    ["a negative noul", { sets_rule: { type: "noul", noul: -0.1 } }, "noul_out_of_range"],
    ["a noul that is not a number", { sets_rule: { type: "noul", noul: "0.5" } }, "not_noul"],
    ["a score above n − 1", { actions: { type: "score", score: 3.2, probabilities: { "0": 0, "1": 0, "2": 0, "3": 1 }, confidence: 1 } }, "score_out_of_range"],
    ["a negative score", { actions: { type: "score", score: -0.5, probabilities: { "0": 1, "1": 0, "2": 0, "3": 0 }, confidence: 1 } }, "score_out_of_range"],
    ["score probabilities keyed by level name, not index", { actions: { type: "score", score: 1, probabilities: { none: 0.1, "one or two reads": 0.9 }, confidence: 1 } }, "probability_keys"],
    ["score probabilities missing a level", { actions: { type: "score", score: 1, probabilities: { "0": 0.2, "1": 0.8, "2": 0 }, confidence: 1 } }, "probability_keys"],
    ["score probabilities that do not sum to 1", { actions: { type: "score", score: 1, probabilities: { "0": 0.5, "1": 0.5, "2": 0.5, "3": 0 }, confidence: 1 } }, "probability_sum"],
    ["a score answer with confidence out of range", { actions: { type: "score", score: 1, probabilities: { "0": 0, "1": 1, "2": 0, "3": 0 }, confidence: 2 } }, "confidence_out_of_range"],
    ["a choice that is not the argmax", { category: { type: "choice", choice: "other", probabilities: { other: 0.2, lookup: 0.8 }, confidence: 0.6 } }, "choice_not_argmax"],
    ["an answer whose type is not the question's", { sets_rule: { type: "choice", choice: "true", probabilities: { true: 1 }, confidence: 1 } }, "not_noul"]
  ])("%s → the whole call is error/parse naming the check (the valid answers beside it are dropped too)", async (_label, over, code) => {
    const fetchImpl = vi.fn(async () => json(200, body3(over)));
    const { call } = client(fetchImpl as unknown as typeof fetch);
    expect(await call(REQ3)).toMatchObject({ ok: false, reason: "error", error_kind: "parse", detail: `response failed validation: ${code}` });
  });

  it("the edges are valid: noul 0 and 1, score 0 and n − 1", async () => {
    const edges = [
      { sets_rule: { type: "noul", noul: 0 }, actions: { type: "score", score: 0, probabilities: { "0": 1, "1": 0, "2": 0, "3": 0 }, confidence: 1 } },
      { sets_rule: { type: "noul", noul: 1 }, actions: { type: "score", score: 3, probabilities: { "0": 0, "1": 0, "2": 0, "3": 1 }, confidence: 1 } }
    ];
    for (const over of edges) {
      const { call } = client(vi.fn(async () => json(200, body3(over))) as unknown as typeof fetch);
      expect((await call(REQ3)).ok).toBe(true);
    }
  });
  // Σ i·pᵢ can overshoot the top level by one rounding ulp; voiding the whole decision point for it would send every such
  // turn to the fallback. Within 1e-9 the score is clamped onto the endpoint; anything further is still out of range.
  it("a score a hair past an endpoint is clamped, not rejected", async () => {
    const over = { actions: { type: "score", score: 3 + 1e-12, probabilities: { "0": 0, "1": 0, "2": 0, "3": 1 }, confidence: 1 } };
    const { call } = client(vi.fn(async () => json(200, body3(over))) as unknown as typeof fetch);
    const r = await call(REQ3);
    expect(r.ok && r.answers.actions).toMatchObject({ type: "score", score: 3 });
  });
});
```

Replace `tests/jev/jev-client.test.ts:39`. The answer is now a union, so the test narrows by asserting the discriminant:

```ts
    if (r.ok) expect(r.answers.intent).toMatchObject({ type: "choice", choice: "research" });
```

In `tests/jev/questions.test.ts`, replace the import on line 2 and the helper on line 6:

```ts
import { criteriaHash, optionsOf, toJevQuestion, type ChoiceQuestion, type NoulQuestion, type ScoreQuestion } from "../../src/jev/questions/types.js";
```
```ts
const q = (criteria: ReadonlyArray<readonly [string, string]>): ChoiceQuestion => ({ id: "t", type: "choice", instructions: "pick", criteria });
```

Line 18 reads `.criteria` off the `JevQuestion` union, where it is optional on a noul:

```ts
    expect(Object.keys(toJevQuestion(q([["none", "n"], ["status", "s"], ["memory", "m"]])).criteria ?? {})).toEqual(["none", "status", "memory"]);
```

Then append:

```ts
// Spec §2.3: `Question` is a union over TypeSafe's three types. The hash is the calibration key: a choice question must
// hash byte-identically to the choice-only hash (or every committed calibration row silently disarms), and each new
// shape must hash its own exact request so a wording or level edit disarms that question.
describe("criteriaHash over the question union", () => {
  it("a choice question hashes exactly as before the union (pinned: lane 1's committed `scope` row)", () => {
    // A literal copy of lane 1's TRIAGE_SCOPE, so the pin survives that module's removal; the hash is calibration.ts's.
    const scope: ChoiceQuestion = {
      id: "scope", type: "choice",
      instructions: "If `latest_message` is a preference or correction, which part of Houge's behaviour is it about?",
      criteria: [
        ["ask", "How Houge replies in conversation: length, tone, language, format, what to include or leave out."],
        ["research", "How Houge searches, which sources it trusts, or how it cites and reports what it found."]
      ]
    };
    expect(criteriaHash(scope)).toBe("d3f6c9008b3eaf1e7a4556dd443e422703f8c306932c88de2abf46ff3763e7a4");
  });
  it("a score hashes its ordered levels; reordering or rewording a level changes it", () => {
    const s: ScoreQuestion = { id: "breadth", type: "score", instructions: "How much ground?", levels: ["one known thing", "one topic", "several topics", "open-ended"] };
    const h = criteriaHash(s);
    expect(h).not.toBe(criteriaHash({ ...s, levels: ["one topic", "one known thing", "several topics", "open-ended"] }));
    expect(h).not.toBe(criteriaHash({ ...s, levels: ["one known thing", "one topic", "several topics", "open ended"] }));
    expect(h).not.toBe(criteriaHash({ ...s, instructions: "How much ground does it cover?" }));
  });
  it("a noul hashes its criteria when present; the type is in every hash", () => {
    const n: NoulQuestion = { id: "sets_rule", type: "noul", instructions: "A rule?" };
    expect(criteriaHash(n)).not.toBe(criteriaHash({ ...n, criteria: { true: "yes", false: "no" } }));
    expect(criteriaHash({ ...n, criteria: { true: "yes", false: "no" } })).not.toBe(criteriaHash({ ...n, criteria: { true: "no", false: "yes" } }));
    const asScore: ScoreQuestion = { id: "x", type: "score", instructions: "pick", levels: ["n", "m"] };
    expect(criteriaHash(asScore)).not.toBe(criteriaHash(q([["n", "n"], ["m", "m"]])));
  });
  it("toJevQuestion renders each type's wire shape", () => {
    expect(toJevQuestion({ id: "a", type: "score", instructions: "i", levels: ["x", "y"] })).toEqual({ type: "score", instructions: "i", criteria: ["x", "y"] });
    expect(toJevQuestion({ id: "b", type: "noul", instructions: "i" })).toEqual({ type: "noul", instructions: "i" });
    expect(toJevQuestion({ id: "c", type: "noul", instructions: "i", criteria: { true: "t", false: "f" } })).toEqual({ type: "noul", instructions: "i", criteria: { true: "t", false: "f" } });
  });
});
```

The pinned hash `d3f6c900…e7a4` is the `scope` row in `src/jev/calibration.ts:24-25`. It was confirmed on 2026-10-07
against `dist/` built from `main@94e3b4c`, with `criteriaHash(TRIAGE_SCOPE)`. The test inlines the question text, so the
pin survives Task 10's removal of `questions/triage.ts`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/jev/jev-client.test.ts tests/jev/questions.test.ts`
Expected: FAIL.
- In the three-type block, the round-trip test and every score/noul case fail. Today's `validateChoice` rejects a noul or
  score answer as `not_choice`, so the call returns `ok:false` and the detail names `not_choice`, not the expected code.
- `toJevQuestion renders each type's wire shape` throws `TypeError` (today's `toJevQuestion` iterates `q.criteria` on a
  score question).
- The pin test **passes** already. It is a regression guard and must stay green through this task.

- [ ] **Step 3: Implement the client types and validators**

In `src/jev/jev-client.ts`, replace lines 23-39. Today these hold `JevChoiceQuestion`, `JevRequest`, `JevChoiceAnswer` and
the `JevResult` union:

```ts
export interface JevChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}
/** Ordered levels, 2–10 (00-jev-capabilities.md §1); the answer's probabilities are keyed "0".."n-1". */
export interface JevScoreQuestion {
  type: "score";
  instructions: string;
  criteria: string[];
}
/** Yes/no; criteria optional. */
export interface JevNoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
}
export type JevQuestion = JevChoiceQuestion | JevScoreQuestion | JevNoulQuestion;
export interface JevRequest {
  state: unknown;
  questions: Record<string, JevQuestion>;
}
export interface JevChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}
/** `score` is the expected level in [0, n−1]; `probabilities` are keyed "0".."n-1". */
export interface JevScoreAnswer {
  type: "score";
  score: number;
  probabilities: Record<string, number>;
  confidence: number;
}
/** `noul` = p(yes). TypeSafe sends no confidence for this type. */
export interface JevNoulAnswer {
  type: "noul";
  noul: number;
}
export type JevAnswer = JevChoiceAnswer | JevScoreAnswer | JevNoulAnswer;

/** Narrows to a choice answer; undefined for a missing answer or another type. */
export function choiceAnswer(a: JevAnswer | undefined): JevChoiceAnswer | undefined {
  return a?.type === "choice" ? a : undefined;
}
export type JevResult =
  | { ok: true; model: string; answers: Record<string, JevAnswer>; input_tokens: number; latency_ms: number }
  | { ok: false; reason: "no_key" | "fused" | "auth" | "error"; detail: string; error_kind?: LlmErrorKind };
```

Then replace `validateResponse` and `validateChoice` (lines 149-190, through the end of the file) with:

```ts
function validateResponse(
  body: unknown,
  req: JevRequest
): Validated<{ model: string; answers: Record<string, JevAnswer>; input_tokens: number; output_tokens: number }> {
  if (typeof body !== "object" || body === null) return { ok: false, code: "body_not_object" };
  const b = body as Record<string, unknown>;
  if (typeof b.model !== "string") return { ok: false, code: "model_missing" };
  if (!JEV_MODEL_ID.test(b.model)) return { ok: false, code: "model_invalid" };
  if (typeof b.answers !== "object" || b.answers === null) return { ok: false, code: "answers_missing" };
  const usage = b.usage as Record<string, unknown> | undefined;
  if (typeof usage?.input_tokens !== "number") return { ok: false, code: "usage_input_tokens_missing" };
  const output_tokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  const answers: Record<string, JevAnswer> = {};
  for (const [id, question] of Object.entries(req.questions)) {
    const raw = (b.answers as Record<string, unknown>)[id];
    if (raw === undefined) return { ok: false, code: `answer_missing:${id}` };
    const answer = validateAnswer(raw, question);
    if (!answer.ok) return answer; // one malformed answer fails the whole call: never a partial answer set
    answers[id] = answer.value;
  }
  return { ok: true, value: { model: b.model, answers, input_tokens: usage.input_tokens, output_tokens } };
}

/** Per type, against the question that was asked: the answer's type must be the question's. */
function validateAnswer(raw: unknown, q: JevQuestion): Validated<JevAnswer> {
  if (typeof raw !== "object" || raw === null) return { ok: false, code: "answer_not_object" };
  const a = raw as Record<string, unknown>;
  switch (q.type) {
    case "choice": return validateChoice(a, Object.keys(q.criteria));
    case "score": return validateScore(a, q.criteria.length);
    case "noul": return validateNoul(a);
  }
}

/** Every key present, nothing else, each in [0, 1], summing to 1 within tolerance. */
function validateDistribution(raw: unknown, keys: readonly string[]): Validated<Record<string, number>> {
  if (typeof raw !== "object" || raw === null) return { ok: false, code: "probabilities_missing" };
  const probs = raw as Record<string, unknown>;
  if (Object.keys(probs).length !== keys.length || !keys.every((k) => typeof probs[k] === "number")) {
    return { ok: false, code: "probability_keys" };
  }
  const p = probs as Record<string, number>;
  if (!keys.every((k) => Number.isFinite(p[k]) && p[k]! >= 0 && p[k]! <= 1)) return { ok: false, code: "probability_range" };
  const sum = keys.reduce((s, k) => s + p[k]!, 0);
  if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) return { ok: false, code: "probability_sum" };
  return { ok: true, value: p };
}

function validConfidence(c: unknown): c is number {
  return typeof c === "number" && c >= 0 && c <= 1;
}

function validateChoice(a: Record<string, unknown>, options: string[]): Validated<JevChoiceAnswer> {
  if (a.type !== "choice" || typeof a.choice !== "string") return { ok: false, code: "not_choice" };
  if (!options.includes(a.choice)) return { ok: false, code: "choice_not_option" };
  if (!validConfidence(a.confidence)) return { ok: false, code: "confidence_out_of_range" };
  const p = validateDistribution(a.probabilities, options);
  if (!p.ok) return p;
  // The reported choice must be an argmax of its own vector (any tied option is accepted): a mismatch is a malformed answer.
  if (p.value[a.choice] !== Math.max(...options.map((o) => p.value[o]!))) return { ok: false, code: "choice_not_argmax" };
  return { ok: true, value: { type: "choice", choice: a.choice, probabilities: p.value, confidence: a.confidence } };
}

/** Float slack on the expected level: Σ i·pᵢ can land a hair past an endpoint; one rounding ulp must not void the whole call. */
const SCORE_ENDPOINT_TOLERANCE = 1e-9;

/** `score` is the expected level, so it lies in [0, n−1] (clamped within the tolerance); probabilities are keyed "0".."n-1". */
function validateScore(a: Record<string, unknown>, levels: number): Validated<JevScoreAnswer> {
  if (a.type !== "score" || typeof a.score !== "number" || !Number.isFinite(a.score)) return { ok: false, code: "not_score" };
  if (a.score < -SCORE_ENDPOINT_TOLERANCE || a.score > levels - 1 + SCORE_ENDPOINT_TOLERANCE) return { ok: false, code: "score_out_of_range" };
  const score = Math.min(levels - 1, Math.max(0, a.score));
  if (!validConfidence(a.confidence)) return { ok: false, code: "confidence_out_of_range" };
  const p = validateDistribution(a.probabilities, Array.from({ length: levels }, (_, i) => String(i)));
  if (!p.ok) return p;
  return { ok: true, value: { type: "score", score, probabilities: p.value, confidence: a.confidence } };
}

/** p(yes) in [0, 1]; no confidence on this type. */
function validateNoul(a: Record<string, unknown>): Validated<JevNoulAnswer> {
  if (a.type !== "noul" || typeof a.noul !== "number") return { ok: false, code: "not_noul" };
  if (!Number.isFinite(a.noul) || a.noul < 0 || a.noul > 1) return { ok: false, code: "noul_out_of_range" };
  return { ok: true, value: { type: "noul", noul: a.noul } };
}
```

`validateAnswer`'s `switch` covers every arm of `JevQuestion`. A missing arm fails tsc with TS2366 ("Function lacks ending return
statement"), so a fourth type cannot be added silently.

- [ ] **Step 4: Implement the question union**

Replace `src/jev/questions/types.ts` whole:

```ts
import { createHash } from "node:crypto";
import type { JevChoiceQuestion, JevNoulQuestion, JevQuestion, JevScoreQuestion } from "../jev-client.js";

/**
 * A frozen Jev question (ADR 0029 §3.1), one of TypeSafe's three wire types. Choice criteria are an ORDERED list
 * because jev-1.13 leans toward the first option: order is part of the calibration key, so the hash covers it. Score
 * levels are ordered by meaning (level 0 first). The model id is NOT in the hash — it is the second key of a threshold
 * row (§3.5), so a model move and a wording edit are told apart in the rows.
 */
export interface ChoiceQuestion {
  id: string;
  type: "choice";
  instructions: string;
  criteria: ReadonlyArray<readonly [string, string]>;
}
export interface ScoreQuestion {
  id: string;
  type: "score";
  instructions: string;
  levels: readonly string[];
}
export interface NoulQuestion {
  id: string;
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
}
export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;

export function optionsOf(q: ChoiceQuestion): string[] {
  return q.criteria.map(([option]) => option);
}

/** The wire shape. A choice's criteria object keeps the listed order as its insertion order. */
export function toJevQuestion(q: Question): JevQuestion {
  switch (q.type) {
    case "choice": {
      const criteria: Record<string, string> = {};
      for (const [option, text] of q.criteria) criteria[option] = text;
      return { type: "choice", instructions: q.instructions, criteria } satisfies JevChoiceQuestion;
    }
    case "score":
      return { type: "score", instructions: q.instructions, criteria: [...q.levels] } satisfies JevScoreQuestion;
    case "noul":
      return (q.criteria
        ? { type: "noul", instructions: q.instructions, criteria: { true: q.criteria.true, false: q.criteria.false } }
        : { type: "noul", instructions: q.instructions }) satisfies JevNoulQuestion;
  }
}

/**
 * sha256 over the exact request shape, per type. A choice hashes `{type, instructions, criteria: [[opt, text], …]}` —
 * byte-identical to the choice-only hash, so lane 1's calibration rows still name their questions. A score hashes its
 * ordered levels; a noul its `[["true", …], ["false", …]]` pair, or no `criteria` key when it has none.
 */
export function criteriaHash(q: Question): string {
  return createHash("sha256").update(JSON.stringify(hashShape(q))).digest("hex");
}

function hashShape(q: Question): Record<string, unknown> {
  switch (q.type) {
    case "choice": return { type: q.type, instructions: q.instructions, criteria: q.criteria.map(([o, t]) => [o, t]) };
    case "score": return { type: q.type, instructions: q.instructions, criteria: [...q.levels] };
    case "noul": return q.criteria
      ? { type: q.type, instructions: q.instructions, criteria: [["true", q.criteria.true], ["false", q.criteria.false]] }
      : { type: q.type, instructions: q.instructions };
  }
}
```

The choice arm of `hashShape` is today's expression character for character. The pin test proves it.

- [ ] **Step 5: Keep the existing consumers compiling (choice-only, behaviour unchanged)**

`src/jev/questions/triage.ts`: line 6 becomes
`import { toJevQuestion, type ChoiceQuestion, type Question } from "./types.js";`. Lines 13, 35 and 45 change
`export const TRIAGE_LANE: Question = {` (and the same for `TRIAGE_COMPLETE` and `TRIAGE_SCOPE`) to
`export const TRIAGE_LANE: ChoiceQuestion = {`. `TRIAGE_QUESTIONS: readonly Question[]` (line 55) stays.

`src/jev/decide.ts`:
- Line 4 becomes `import { choiceAnswer, type JevChoiceAnswer, type JevRequest, type JevResult } from "./jev-client.js";`
- Replace line 77, `if (i.questions.some((q) => !r.answers[q.id])) return { status: "skipped", reason: "parse" }; // fail loud, never partial`,
  with:
  ```ts
    // Choice-only until the per-type rows land: a missing or non-choice answer fails loud, never a partial set.
    const answers: Record<string, JevChoiceAnswer> = {};
    for (const q of i.questions) {
      const a = choiceAnswer(r.answers[q.id]);
      if (!a) return { status: "skipped", reason: "parse" };
      answers[q.id] = a;
    }
  ```
- Line 83, `const a = r.answers[q.id]!; // checked above: every requested id is present`, becomes
  `const a = answers[q.id]!; // checked above: every requested id is present`.
- In the return on line 91, `answers: r.answers,` becomes `answers,`.

`src/jev/thresholds.ts`:
- Line 3 becomes `import { choiceAnswer, type JevAnswer, type JevChoiceAnswer } from "./jev-client.js";`
- Lines 62-63 become:
  ```ts
  export function triageVerdict(answers: Record<string, JevAnswer>, bars: TriageBars, lang: Lang, model: string, rows: readonly CalibrationRow[] = CALIBRATED_ROWS): TriageDecision {
    const lane = choiceAnswer(answers.lane); const complete = choiceAnswer(answers.complete); const scope = choiceAnswer(answers.scope);
  ```
  The rest of the function reads `lane`, `complete` and `scope` exactly as before. The `p` helper on line 33 keeps its
  `JevChoiceAnswer` parameter.

`src/jev/triage-replay.ts`:
- Line 9 becomes `import { choiceAnswer, JEV_REQUEST_MODEL, type JevAnswer, type JevRequest, type JevResult } from "./jev-client.js";`
- Line 11 becomes `import { criteriaHash, toJevQuestion, type ChoiceQuestion } from "./questions/types.js";`
- Line 45 becomes `export const TRIAGE_LANE_PERMUTED: ChoiceQuestion = { ...TRIAGE_LANE, criteria: [...TRIAGE_LANE.criteria].reverse() };`
- Line 61's signature becomes `export function replayVerdict(answers: Record<string, JevAnswer>, bars: TriageBars, lang: Lang, model: string): TriageReplayVerdict {`
- Line 148's signature becomes `async function dispatchTurn(d: TriageReplayDeps, row: Prepared, lane: ChoiceQuestion, models: Set<string>): Promise<TriageReplayRow> {`
- Replace lines 162-166, from `const a = r.answers.lane!;` through the `...(r.answers.scope ? …)` line, with:
  ```ts
    // The client validated each answer against its question's type, so these are choice answers; a miss is a parse failure.
    const a = choiceAnswer(r.answers.lane); const complete = choiceAnswer(r.answers.complete); const scope = choiceAnswer(r.answers.scope);
    if (!a) return { ...rest, status: "jev_failed", error: "error" };
    return { ...rest, status: "ok", usd: jevUsd(r.input_tokens, d.env), model: r.model, criteria_hash_lane: criteriaHash(lane), jev_lane: a.choice,
      p_memory: a.probabilities.memory ?? 0, p_status: a.probabilities.status ?? 0, p_none: a.probabilities.none ?? 0,
      conf_lane: a.confidence, margin_lane: marginOf(a), p_pure: complete?.probabilities.pure ?? 0,
      ...(scope ? { scope: scope.choice } : {}),
  ```
  The `verdict:` line that follows is unchanged.

`src/jev/triage-report.ts:46-48`: each of the three literal answers inside `verdictAt` gains `type: "choice", ` as its
first property: `lane: { type: "choice", choice: r.jev_lane ?? "none", …`, `complete: { type: "choice", choice: pPure >= 0.5 …`,
`scope: { type: "choice", choice: scope, …`.

`src/jev/replay.ts`:
- Line 9 becomes `import { choiceAnswer, JEV_REQUEST_MODEL, type JevRequest, type JevResult } from "./jev-client.js";`
- Replace line 153, `const answer = jev.answers.intent!;`, with the two lines below. `dispatchTurn` stays at 46 lines.
  ```ts
    const answer = choiceAnswer(jev.answers.intent); // the client validated it against the choice question: a miss is a parse failure
    if (!answer) { emit(deps, rows, { ...prepared.base, status: "jev_failed", error: "parse" }); return { spentUsd: newSpent, estimatedUsd: estUsd }; }
  ```

Type-only test fixture updates. The answer literals gain the discriminant; nothing about behaviour changes.
- `tests/jev/thresholds.test.ts:17`: `return { type: "choice", choice, probabilities, confidence: (pMax - 1 / n) / (1 - 1 / n) }; // Jev's documented confidence formula`
- `tests/jev/decide.test.ts:119`: `marginOf({ type: "choice", choice: "a", probabilities: { a: 0.5, b: 0.3, c: 0.2 }, confidence: 0 })`
- `tests/jev/replay.test.ts:15`: `answers: { intent: { type: "choice", choice, confidence, probabilities: { … unchanged … } } }`
- `tests/jev/triage-replay.test.ts:176-177`: `Object.keys(sent[0]!.questions.lane!.criteria ?? {})` and
  `Object.keys(sent[0]!.questions.complete!.criteria ?? {})`

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run tests/jev && npm run typecheck`
Expected: PASS. All of `tests/jev` is green (162 tests in the draft build), and tsc exits 0. Also run `npx vitest run tests/core`.
It must stay green because `core-worker.ts` still compiles against the choice-only `Decision`.

- [ ] **Step 7: Commit**

```bash
git add src/jev/jev-client.ts src/jev/questions/types.ts src/jev/questions/triage.ts src/jev/decide.ts src/jev/thresholds.ts \
  src/jev/triage-replay.ts src/jev/triage-report.ts src/jev/replay.ts \
  tests/jev/jev-client.test.ts tests/jev/questions.test.ts tests/jev/thresholds.test.ts tests/jev/decide.test.ts \
  tests/jev/replay.test.ts tests/jev/triage-replay.test.ts
git commit -m "$(cat <<'EOF'
feat(jev): client speaks choice, score and noul; Question union with per-shape criteria hash

One malformed answer of any type fails the whole call as parse. A choice
question hashes byte-identically to before (pinned to lane 1's committed
scope row). decide() still persists choice answers only until per-type rows.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

---

### Task 2: `decide()` per-type persistence; `marginOf` / `topProbOf` over the union

**Files:**
- Modify: `src/jev/decide.ts:4,34,41-45,77-91` (after Task 1; replaces Task 1's bridge)
- Modify: `src/core/core-worker.ts:140-141` (imports), `:2590-2592` (narrow the lane answer)
- Test: `tests/jev/decide.test.ts` (new describe block)

**Interfaces:**
- Consumes: Task 1 (`JevAnswer`, `choiceAnswer`, `Question`).
- Produces (contract):
  ```ts
  // src/jev/decide.ts
  // Decision.answered.answers: Record<string, JevAnswer>
  export function marginOf(a: JevAnswer): number;   // choice/score p1 − p2; noul |2p − 1|
  export function topProbOf(a: JevAnswer): number;  // max of the stored vector; noul max(p, 1 − p)
  ```
  Row per type:

  | answer type | `answers_json` | `confidence` | `top_prob` | `margin` |
  |---|---|---|---|---|
  | choice | option probabilities (as today) | Jev's | max | p1 − p2 |
  | score | `{"0":…, …, "n-1":…}` | Jev's | max | p1 − p2 |
  | noul | `{"true": p, "false": 1 − p}` | **null** | max(p, 1 − p) | \|2p − 1\| |

Callers that assumed choice-only answers. Every one was found by grepping `JevChoiceAnswer`, `.probabilities` and
`marginOf` over `src`, `tests` and `scripts`:
- `src/core/core-worker.ts:2590-2592`: fixed here.
- `src/jev/thresholds.ts`, `src/jev/triage-replay.ts`, `src/jev/replay.ts`, `src/jev/triage-report.ts`: already narrowed in
  Task 1, and they accept `Record<string, JevAnswer>`.
- `src/jev/intent-question.ts` uses `JevChoiceQuestion` only (a request type), so it needs no change.
- `scripts/live-gate-jev.mjs:33` and `scripts/live-gate-jev-triage.mjs` read `.choice` at runtime off choice answers. That
  still works because the shape only gains `type`.

- [ ] **Step 1: Write the failing tests**

In `tests/jev/decide.test.ts`:
- Line 3 becomes `import { decide, marginOf, persistDecisionRows, recordSkip, stateHash, topProbOf } from "../../src/jev/decide.js";`
- Line 5 becomes `import { criteriaHash, type Question } from "../../src/jev/questions/types.js";`

Then append. The block reuses the file's `json` and `setup` helpers:

```ts
// Spec §2.3 / §9: decide() persists per type. The replay and the calibration report read these rows back, so a score row
// must carry its level vector and confidence, and a noul row its {true, false} pair with a NULL confidence (TypeSafe sends
// none; inventing one would put a number in the column the bars and the Wilson report read as Jev's own).
describe("decide — per-type rows", () => {
  const QS: readonly Question[] = [
    { id: "category", type: "choice", instructions: "pick", criteria: [["other", "o"], ["lookup", "l"]] },
    { id: "breadth", type: "score", instructions: "how much", levels: ["one known thing", "one topic", "several topics", "open-ended"] },
    { id: "sets_rule", type: "noul", instructions: "a rule?" }
  ];
  const ANSWERS = {
    category: { type: "choice", choice: "lookup", probabilities: { other: 0.3, lookup: 0.7 }, confidence: 0.4 },
    breadth: { type: "score", score: 1.1, probabilities: { "0": 0.1, "1": 0.7, "2": 0.2, "3": 0 }, confidence: 0.65 },
    sets_rule: { type: "noul", noul: 0.25 }
  };
  const body = () => ({ model: REPORTED, usage: { input_tokens: 700, output_tokens: 0 }, answers: ANSWERS });

  it("writes a score row with its level vector and a noul row with {true, false}, a null confidence and |2p − 1|", async () => {
    const { store, input } = setup(vi.fn(async () => json(200, body())) as unknown as typeof fetch);
    const d = await decide({ ...input, questions: QS });
    expect(d.status).toBe("answered"); if (d.status !== "answered") return;
    expect(d.answers.sets_rule).toEqual({ type: "noul", noul: 0.25 });
    persistDecisionRows(store, d.rows, "fallback", null);
    const [cat, breadth, rule] = store.listJevDecisions("run_1");
    expect(cat).toMatchObject({ question_id: "category", answers_json: JSON.stringify({ other: 0.3, lookup: 0.7 }), confidence: 0.4, top_prob: 0.7 });
    expect(breadth).toMatchObject({ question_id: "breadth", criteria_hash: criteriaHash(QS[1]!), confidence: 0.65, top_prob: 0.7,
      answers_json: JSON.stringify({ "0": 0.1, "1": 0.7, "2": 0.2, "3": 0 }) });
    expect(breadth!.margin).toBeCloseTo(0.5, 9);
    expect(rule).toMatchObject({ question_id: "sets_rule", answers_json: JSON.stringify({ true: 0.25, false: 0.75 }), confidence: null, top_prob: 0.75, margin: 0.5 });
    store.close();
  });
  it("an answer whose type is not its question's is skipped{parse} even from a client that skipped validation", async () => {
    const { store, input } = setup(vi.fn() as unknown as typeof fetch);
    const answers = { ...ANSWERS, sets_rule: { type: "choice", choice: "true", probabilities: { true: 1 }, confidence: 1 } };
    const client = vi.fn(async () => ({ ok: true as const, model: REPORTED, answers, latency_ms: 5, input_tokens: 9 }));
    expect(await decide({ ...input, questions: QS, client: client as unknown as typeof input.client })).toEqual({ status: "skipped", reason: "parse" });
    store.close();
  });
  it("marginOf and topProbOf read a noul as the pair (p, 1 − p) and a score as its level vector", () => {
    expect(marginOf({ type: "noul", noul: 0.9 })).toBeCloseTo(0.8, 9);
    expect(marginOf({ type: "noul", noul: 0.1 })).toBeCloseTo(0.8, 9); // symmetric: a confident no is as sure as a confident yes
    expect(topProbOf({ type: "noul", noul: 0.1 })).toBeCloseTo(0.9, 9);
    expect(marginOf({ type: "score", score: 2, probabilities: { "0": 0, "1": 0.2, "2": 0.8 }, confidence: 0.8 })).toBeCloseTo(0.6, 9);
    expect(topProbOf({ type: "choice", choice: "a", probabilities: { a: 0.6, b: 0.4 }, confidence: 0.2 })).toBe(0.6);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/jev/decide.test.ts`
Expected: FAIL.
- `writes a score row …`: `decide` returns `{status:"skipped", reason:"parse"}` because Task 1's bridge rejects non-choice
  answers, so `expect(d.status).toBe("answered")` fails.
- `marginOf and topProbOf …`: `topProbOf is not a function`. `marginOf` on a noul reads `undefined.probabilities`, which
  is a TypeError.
- `an answer whose type is not its question's …` already passes through the bridge. Keep it: it pins the type check that
  replaces the bridge.

- [ ] **Step 3: Implement**

In `src/jev/decide.ts`, line 4 becomes:

```ts
import type { JevAnswer, JevRequest, JevResult } from "./jev-client.js";
```

In the `Decision` union (line 34), `answers: Record<string, JevChoiceAnswer>;` becomes `answers: Record<string, JevAnswer>;`.

Replace the `marginOf` block. Today it reads:
```ts
/** p1 − p2: the gap between the top two options, a steadier signal than confidence when n > 2. */
export function marginOf(a: JevChoiceAnswer): number {
  const sorted = Object.values(a.probabilities).sort((x, y) => y - x);
  return (sorted[0] ?? 0) - (sorted[1] ?? 0);
}
```
with:
```ts
/** The probability vector a row stores: a choice's options, a score's levels "0".."n-1", a noul's {true: p, false: 1 − p}. */
function distributionOf(a: JevAnswer): Record<string, number> {
  return a.type === "noul" ? { true: a.noul, false: 1 - a.noul } : a.probabilities;
}

/** p1 − p2: the gap between the top two entries, a steadier signal than confidence when n > 2. A noul's is |2p − 1|. */
export function marginOf(a: JevAnswer): number {
  if (a.type === "noul") return Math.abs(2 * a.noul - 1);
  const sorted = Object.values(a.probabilities).sort((x, y) => y - x);
  return (sorted[0] ?? 0) - (sorted[1] ?? 0);
}

/** The largest entry of the stored vector: a noul's is max(p, 1 − p). */
export function topProbOf(a: JevAnswer): number {
  return Math.max(...Object.values(distributionOf(a)));
}
```

Replace Task 1's bridge, from `// Choice-only until the per-type rows land: …` through its closing `}`, with:

```ts
  // Fail loud, never partial: a missing answer, or one whose type is not its question's (a client that skipped validation).
  if (i.questions.some((q) => r.answers[q.id]?.type !== q.type)) return { status: "skipped", reason: "parse" };
```

In the row loop, replace:
```ts
    const a = answers[q.id]!; // checked above: every requested id is present
    rows.push({
      run_id: i.run_id, point: i.point, question_id: q.id, criteria_hash: criteriaHash(q), model_reported: r.model, state_hash: sh, lang: i.lang,
      answers_json: JSON.stringify(a.probabilities), confidence: a.confidence, top_prob: Math.max(...Object.values(a.probabilities)), margin: marginOf(a),
```
with:
```ts
    const a = r.answers[q.id]!; // checked above: every requested id is present, with its question's type
    rows.push({
      run_id: i.run_id, point: i.point, question_id: q.id, criteria_hash: criteriaHash(q), model_reported: r.model, state_hash: sh, lang: i.lang,
      answers_json: JSON.stringify(distributionOf(a)), confidence: a.type === "noul" ? null : a.confidence, top_prob: topProbOf(a), margin: marginOf(a),
```
In the final return, `answers,` becomes `answers: r.answers,`.

`jev_decisions.confidence` is `REAL` and nullable (`src/run/run-store.ts:6743`; `JevDecisionRow.confidence: number | null`
at line 910), so no migration is needed.

In `src/core/core-worker.ts`:
- Line 140 becomes `import { decide, marginOf, persistDecisionRows, recordSkip, topProbOf, type JevDecisionInsert, type SkipReason } from "../jev/decide.js";`
- Line 141 becomes `import { choiceAnswer, createJevClient, type JevRequest, type JevResult } from "../jev/jev-client.js";`
- Replace lines 2590-2592. Today:
  ```ts
      const lane = d.answers.lane!;
      const numbers: TriageNumbers = { lane: lane.choice, complete: d.answers.complete?.choice, scope: d.answers.scope?.choice,
        confidence: lane.confidence, top_prob: Math.max(...Object.values(lane.probabilities)), margin: marginOf(lane), verdict: verdictLabel(verdict) };
  ```
  becomes:
  ```ts
      const lane = choiceAnswer(d.answers.lane);
      if (!lane) return this.triageSkip(i, state, lang, "parse"); // unreachable: decide() checked every answer against its question's type
      const numbers: TriageNumbers = { lane: lane.choice, complete: choiceAnswer(d.answers.complete)?.choice, scope: choiceAnswer(d.answers.scope)?.choice,
        confidence: lane.confidence, top_prob: topProbOf(lane), margin: marginOf(lane), verdict: verdictLabel(verdict) };
  ```
  `triageTurnInner` grows by one line, to about 35. Task 10 replaces this whole block with the tree's decision point.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run tests/jev tests/core && npm run typecheck`
Expected: PASS (the draft build ran 449 tests across 40 files), and tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/jev/decide.ts src/core/core-worker.ts tests/jev/decide.test.ts
git commit -m "$(cat <<'EOF'
feat(jev): decide() persists score and noul rows; marginOf and topProbOf over the answer union

A noul row stores {true: p, false: 1 - p} with a null confidence and
margin |2p - 1|; an answer whose type is not its question's is skipped{parse}.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

---

### Task 3: The tree's six frozen questions, `isProposal`, `lastHougeTurnOf`, `buildTreeState`

**Wording note (read before reviewing the hash):**
- The spec §2.3 table gives the offered-work clause ("If `latest_message` only agrees to, picks or continues something
  Houge offered in `quoted_turn` or `recent_turns`, answer for that offered work") on `category` only. This task also puts
  it on the three score questions. Without it, a bare "好" that accepts a heavy offer would score `breadth`, `reasoning`
  and `actions` at level 0. Two things follow. The gear (spec §2.4: the max score, ≤ 1.2 → Fast) never rises above the
  category's role floor. And `reasoning` sets effort `low`. An accepted "要不要我诊断一下为什么重启失败？" would then run
  `self_change` on Default at low effort instead of Thinking. Flagged in Drafter notes for Paco's review. Removing it is a
  one-line edit per question.
- `rule_scope` is reworded from the spec's "Is that rule about …" to "Is the rule in `latest_message` about …". Jev
  evaluates each question independently (00-jev-capabilities.md §1: "One answer does not become context for another
  question"), so "that rule" has no antecedent.
- `rule_scope` has no escape option. The contract fixes it to `ask | research`. Its escape is in code: it is read only
  when `sets_rule` is yes, and it overrides the category default only at p ≥ 0.6.

**Category option order.** jev-1.13 leans toward the first option (00-jev-capabilities.md §5, weakness 8). Lane 1 put the
fall-through first (`none`, `src/jev/questions/triage.ts:21`) so that the bias goes where a wrong pick costs least. The
same rule applies here, with the options ordered by the cost of a wrong pick, cheapest first:
1. `other`, the escape. It routes to the planner on Default, which is exactly the fallback path (spec §2.4), so a biased
   pick changes nothing.
2. `self_change`, `machine_task`, `schedule`, `mail_calendar`, `wiki`. In stage A these all run the planner on Default (the
   role floor, §3), so a confusion among them, or with `other`, routes identically.
3. `research`. It runs the planner on Thinking, so a wrong pick costs money but never under-powers a turn.
4. `lookup`, `answer`. They have a Fast floor, so a wrong pick can under-power a turn. Stage B lanes will take them.
5. `status`, `memory`. These are the no-planner lanes. A wrong pick swallows the turn, the costliest error (spec §7), so
   they come last. `memory` is the very last because it is the only branch that writes.

**Files:**
- Create: `src/jev/questions/tree.ts`
- Test: `tests/jev/tree-questions.test.ts` (flat under `tests/jev/`, like `tests/jev/questions.test.ts` for `src/jev/questions/`)

**Interfaces:**
- Consumes: Task 1 (`ChoiceQuestion`, `ScoreQuestion`, `NoulQuestion`, `Question`, `toJevQuestion`).
  - `feedTurnText(text, maxChars)`: `src/capabilities/intent.ts:88`
  - `sanitizeJevText(text, brokerRedact?)`: `src/jev/egress-redact.ts:23`
  - `MAX_LATEST_MESSAGE_CHARS`, `MAX_REQUEST_CHARS`: `src/jev/intent-question.ts:12-13`
  - `ChatTurnRow`: `src/run/run-store.ts:352`
  - `TurnModality`: `src/media/media-config.ts:9`
  - In tests, `ACK_NUDGE_TEXT`: `src/omp/bare-ack.ts:16`
- Produces (contract, verbatim):
  ```ts
  export const CATEGORIES = ["answer", "lookup", "research", "memory", "self_change", "machine_task", "schedule", "wiki",
    "mail_calendar", "status", "other"] as const;
  export type Category = (typeof CATEGORIES)[number];
  export const TREE_CATEGORY: ChoiceQuestion;   // id "category"
  export const TREE_SETS_RULE: NoulQuestion;    // id "sets_rule"
  export const TREE_RULE_SCOPE: ChoiceQuestion; // id "rule_scope"; options "ask", "research"
  export const TREE_BREADTH: ScoreQuestion;     // id "breadth"
  export const TREE_REASONING: ScoreQuestion;   // id "reasoning"
  export const TREE_ACTIONS: ScoreQuestion;     // id "actions"
  export const TREE_QUESTIONS: readonly Question[];
  export type HougeTurnKind = "answer" | "clarify" | "proposal";
  export type LastHougeTurn = { kind: HougeTurnKind; age_s: number } | null;
  export function isProposal(text: string): boolean;
  export function lastHougeTurnOf(recent: ChatTurnRow[], nowMs: number): LastHougeTurn;
  export function quotedTurnFromRow(row: ChatTurnRow, nowMs: number): QuotedTurn; // orchestrator addition: one builder for live (Task 10) and replay (Task 12)
  export interface QuotedTurn { role: "houge" | "user"; kind: HougeTurnKind; age_s: number; text: string }
  export interface TreeStateInput { userText: string; recentTurns: ChatTurnRow[]; turnChars: number; modality: TurnModality;
    lastHougeTurn: LastHougeTurn; quotedTurn: QuotedTurn | null }
  export type TreeStateResult = { ok: true; state: Record<string, unknown>; chars: number } | { ok: false; skip: "state_too_large" };
  export function buildTreeState(i: TreeStateInput, brokerRedact?: (s: string) => string): TreeStateResult;
  ```

**Read-time kind rule** (spec §2.2). `chat_turns.intent` for an assistant row is written in two places:
- `assistantIntentFor(text, usedTool)` (`src/omp/turn-context.ts:301-305`, called at `planner-supervisor.ts:1028`) returns
  `loop` whenever a tool ran. With no tool, it returns `clarify` for a short reply (< 600 chars) that ends in a question,
  and `loop` otherwise.
- `planner-supervisor.ts:253` stores the approval nudge as `loop`, and `run-store.ts:5674` stores evolution reports as
  `evolution_report`.

`hougeTurnKind` applies these checks in order:
1. The offer regex matches → `proposal`. This beats a stored `clarify`: "要不要我直接查？" is stored as `clarify` but offers
   work, and the ack rule and the offered-work clause both need to see it as an offer.
2. Stored `clarify` → `clarify`.
3. Stored `loop` with a trailing `?` or `？` (the same pattern as `assistantIntentFor`) → `proposal`. This is the spec's
   "trailing question after a tool run".
4. Anything else → `answer`.

Known imprecision: `loop` also marks a tool-less reply of 600 chars or more. A long tool-less answer that ends in a question
reads as a proposal, and the only cost is that the §2.1 ack rule does not fire after it (Jev classifies instead), which is
the safe direction. See Drafter notes.

- [ ] **Step 1: Write the failing tests**

Create `tests/jev/tree-questions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MAX_LATEST_MESSAGE_CHARS, MAX_REQUEST_CHARS } from "../../src/jev/intent-question.js";
import {
  buildTreeState, CATEGORIES, isProposal, lastHougeTurnOf, quotedTurnFromRow, TREE_ACTIONS, TREE_BREADTH, TREE_CATEGORY, TREE_QUESTIONS, TREE_REASONING,
  TREE_RULE_SCOPE, TREE_SETS_RULE, type QuotedTurn, type TreeStateInput
} from "../../src/jev/questions/tree.js";
import { optionsOf, toJevQuestion } from "../../src/jev/questions/types.js";
import { ACK_NUDGE_TEXT } from "../../src/omp/bare-ack.js";
import type { ChatTurnRow } from "../../src/run/run-store.js";

/** The one ChatTurnRow builder in this file: a column added to the row type is added here once. */
const turn = (role: "user" | "assistant", text: string, created_at = "2026-10-07T00:00:00.000Z", intent: string | null = null): ChatTurnRow =>
  ({ turn_id: "t", chat_id: "c", run_id: "r", role, text, intent, created_at });
const NOW = Date.parse("2026-10-07T01:00:00.000Z");

// Spec §2.3: the six questions ride one request, and the policy (tree-policy.ts) reads them by id and option name. A
// renamed id or option silently routes every turn to the fallback; a reordered category list moves Jev's first-option
// bias onto a different option. Both are calibration events, so the frozen shape is asserted literally.
describe("the six tree questions (frozen)", () => {
  it("are the six ids in order, with their wire types", () => {
    expect(TREE_QUESTIONS.map((q) => [q.id, q.type])).toEqual([
      ["category", "choice"], ["sets_rule", "noul"], ["rule_scope", "choice"], ["breadth", "score"], ["reasoning", "score"], ["actions", "score"]
    ]);
    expect(TREE_QUESTIONS).toEqual([TREE_CATEGORY, TREE_SETS_RULE, TREE_RULE_SCOPE, TREE_BREADTH, TREE_REASONING, TREE_ACTIONS]);
  });
  it("category offers exactly the eleven categories: the fall-through `other` first, the no-planner lanes last", () => {
    expect(optionsOf(TREE_CATEGORY)).toEqual(["other", "self_change", "machine_task", "schedule", "mail_calendar", "wiki", "research",
      "lookup", "answer", "status", "memory"]);
    expect([...optionsOf(TREE_CATEGORY)].sort()).toEqual([...CATEGORIES].sort());
  });
  it("rule_scope is ask | research (the lesson scopes); score levels are the spec's, in order", () => {
    expect(optionsOf(TREE_RULE_SCOPE)).toEqual(["ask", "research"]);
    expect(TREE_BREADTH.levels).toEqual(["one known thing", "one topic", "several topics", "open-ended"]);
    expect(TREE_REASONING.levels).toEqual(["recall", "straightforward", "non-obvious analysis", "deep multi-factor"]);
    expect(TREE_ACTIONS.levels).toEqual(["none", "one or two reads", "several including changes", "many with checks"]);
  });
  // mu's wording rules (spec §2.3): every question names its state field in backticks; no "and/or"; every criterion says
  // something (an empty criterion is an option Jev cannot read).
  it("follow mu's wording rules", () => {
    for (const q of TREE_QUESTIONS) {
      expect(q.instructions).toContain("`latest_message`");
      expect(JSON.stringify(toJevQuestion(q))).not.toMatch(/and\/or/i);
    }
    for (const [, text] of TREE_CATEGORY.criteria) expect(text.trim().length).toBeGreaterThan(10);
    // The offered-work clause reads the quote first (spec §2.2.1), on the category and on each score question.
    for (const q of [TREE_CATEGORY, TREE_BREADTH, TREE_REASONING, TREE_ACTIONS]) expect(q.instructions).toContain("`quoted_turn` or `recent_turns`");
  });
});

// Spec §2.2: `last_houge_turn.kind` is computed at read time. The ack rule (§2.1) fires only after a plain `answer`, so a
// proposal misread as an answer lets a bare "好" that accepts an offer be settled as small talk on the Fast role.
describe("isProposal / lastHougeTurnOf (read-time kind)", () => {
  it("isProposal matches the offer markers (zh and en) and nothing else", () => {
    for (const t of ["要不要我帮你查一下明天的天气？", "我可以把它写成一个脚本。", "需要我继续吗", "Tap Approve on the card.",
      "Want me to dig into the second source?", "Shall I write it up?", "Should I keep going?", "Would you like me to schedule it?"]) expect(isProposal(t)).toBe(true);
    for (const t of ["明天多云，最高 22 度。", "The change was approved yesterday.", "did you restart?"]) expect(isProposal(t)).toBe(false);
  });
  it("a stored clarify is clarify; an offer wins over the clarify mark", () => {
    expect(lastHougeTurnOf([turn("assistant", "你指的是哪个项目？", "2026-10-07T00:59:30.000Z", "clarify")], NOW)).toEqual({ kind: "clarify", age_s: 30 });
    expect(lastHougeTurnOf([turn("assistant", "要不要我直接查？", "2026-10-07T00:59:30.000Z", "clarify")], NOW)).toEqual({ kind: "proposal", age_s: 30 });
  });
  it("a trailing question after a tool run (`loop`) is a proposal; a `loop` reply without one is an answer", () => {
    expect(lastHougeTurnOf([turn("assistant", "找到三篇相关文章，先看第一篇？", undefined, "loop")], NOW)?.kind).toBe("proposal");
    expect(lastHougeTurnOf([turn("assistant", "Found three articles. Read the first one?\"", undefined, "loop")], NOW)?.kind).toBe("proposal");
    expect(lastHougeTurnOf([turn("assistant", "明天多云，最高 22 度。", undefined, "loop")], NOW)?.kind).toBe("answer");
  });
  it("a trailing question on a row that is not `loop` (no intent, an evolution report) is not a tool-run proposal", () => {
    expect(lastHougeTurnOf([turn("assistant", "today's report is ready?", undefined, null)], NOW)?.kind).toBe("answer");
    expect(lastHougeTurnOf([turn("assistant", "evolution summary — anything else?", undefined, "evolution_report")], NOW)?.kind).toBe("answer");
  });
  it("the approval-card nudge (stored as `loop`) reads as a proposal, so an ack after it is never the plain-answer ack", () => {
    expect(lastHougeTurnOf([turn("assistant", ACK_NUDGE_TEXT, undefined, "loop")], NOW)?.kind).toBe("proposal");
  });
  // One builder for live and replay (spec §2.2.1, §7): a quoted Houge offer must read as a proposal exactly as
  // last_houge_turn does, or "好" quoting an hour-old offer is classified as small talk.
  it("quotedTurnFromRow: a Houge row takes the read-time kind, a user row is neutral, age from created_at", () => {
    expect(quotedTurnFromRow(turn("assistant", "找到三篇，先看第一篇？", "2026-10-07T00:00:00.000Z", "loop"), NOW))
      .toEqual({ role: "houge", kind: "proposal", age_s: 3600, text: "找到三篇，先看第一篇？" });
    expect(quotedTurnFromRow(turn("user", "以后回复短一点", "2026-10-07T00:59:00.000Z"), NOW))
      .toEqual({ role: "user", kind: "answer", age_s: 60, text: "以后回复短一点" });
  });
  it("takes the LAST assistant turn; null with none; age 0 on an unparseable instant", () => {
    const recent = [turn("assistant", "要不要我查？", "2026-10-07T00:00:00.000Z", "clarify"), turn("user", "x"), turn("assistant", "好的。", "2026-10-07T00:59:00.000Z", "loop")];
    expect(lastHougeTurnOf(recent, NOW)).toEqual({ kind: "answer", age_s: 60 });
    expect(lastHougeTurnOf([turn("user", "x")], NOW)).toBeNull();
    expect(lastHougeTurnOf([turn("assistant", "a", "not-a-date", "loop")], NOW)).toEqual({ kind: "answer", age_s: 0 });
  });
});

// Spec §2.2 / §2.2.1: the state is lane 1's approved egress envelope plus `quoted_turn`. Every text field is sanitised and
// broker-redacted (a quote is as much Paco's or Houge's text as the thread), and the quote counts toward the 24K cap: a
// quote that pushes the request over must skip the call, never be truncated or dropped silently.
describe("buildTreeState", () => {
  const QUOTE: QuotedTurn = { role: "houge", kind: "proposal", age_s: 3600, text: "要不要我查一下明天的天气？ ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 VALUE123" };
  const base: TreeStateInput = { userText: "好", recentTurns: [turn("assistant", "long answer with ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345")], turnChars: 4000,
    modality: "text", lastHougeTurn: { kind: "answer", age_s: 12 }, quotedTurn: null };

  it("carries exactly the five fields; quoted_turn is null when the message quotes nothing", () => {
    const r = buildTreeState(base);
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.state).toEqual({ modality: "text", latest_message: "好", recent_turns: [{ role: "houge", text: "long answer with <token>" }],
      last_houge_turn: { kind: "answer", age_s: 12 }, quoted_turn: null });
  });
  it("sanitises and broker-redacts the quote like the thread, and cuts it at turnChars like the thread", () => {
    const redact = (t: string) => t.replace("VALUE123", "<redacted>");
    const r = buildTreeState({ ...base, quotedTurn: QUOTE }, redact);
    expect(r.ok && r.state.quoted_turn).toEqual({ role: "houge", kind: "proposal", age_s: 3600, text: "要不要我查一下明天的天气？ <token> <redacted>" });
    const cut = buildTreeState({ ...base, turnChars: 5, quotedTurn: { ...QUOTE, text: "以后回复短一点，谢谢" } });
    expect(cut.ok && (cut.state.quoted_turn as { text: string }).text).toBe("以后回复短…");
  });
  it("the quote counts toward the request cap: a state that fits without it skips with it", () => {
    const recent: ChatTurnRow[] = [];
    let fit = buildTreeState({ ...base, recentTurns: recent });
    while (fit.ok && fit.chars < MAX_REQUEST_CHARS - 3000) { recent.push(turn("user", "y".repeat(1000))); fit = buildTreeState({ ...base, recentTurns: recent }); }
    expect(fit.ok).toBe(true);
    expect(buildTreeState({ ...base, recentTurns: recent, quotedTurn: { ...QUOTE, text: "z".repeat(3500) } })).toEqual({ ok: false, skip: "state_too_large" });
  });
  it("chars measures the whole request, the six questions included", () => {
    const r = buildTreeState(base);
    expect(r.ok && r.chars).toBe(JSON.stringify({ state: r.ok ? r.state : null, questions: TREE_QUESTIONS.map(toJevQuestion) }).length);
  });
  it("skips a latest message over its own cap, never truncating it", () => {
    expect(buildTreeState({ ...base, userText: "x".repeat(MAX_LATEST_MESSAGE_CHARS + 1) })).toEqual({ ok: false, skip: "state_too_large" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/jev/tree-questions.test.ts`
Expected: FAIL, because the module `../../src/jev/questions/tree.js` is not found.

- [ ] **Step 3: Implement**

Create `src/jev/questions/tree.ts`:

```ts
import { feedTurnText } from "../../capabilities/intent.js";
import type { TurnModality } from "../../media/media-config.js";
import type { ChatTurnRow } from "../../run/run-store.js";
import { sanitizeJevText } from "../egress-redact.js";
import { MAX_LATEST_MESSAGE_CHARS, MAX_REQUEST_CHARS } from "../intent-question.js";
import { toJevQuestion, type ChoiceQuestion, type NoulQuestion, type Question, type ScoreQuestion } from "./types.js";

/**
 * The decision tree's six questions (spec 2026-10-06 §2.3), frozen. Wording follows mu's measured rules: one predicate
 * per question, state fields in backticks, no "and/or", an escape option on every choice. jev-1.13 leans toward the
 * first option, so `category` lists the fall-through option (`other` → the planner on Default, today's path) first and
 * the two no-planner lanes (`status`, `memory`) last. Changing a word or the order changes the criteria hash (types.ts)
 * and un-arms the question until Paco commits a new calibration row.
 */
export const CATEGORIES = ["answer", "lookup", "research", "memory", "self_change", "machine_task", "schedule", "wiki",
  "mail_calendar", "status", "other"] as const;
export type Category = (typeof CATEGORIES)[number];

const HOUGE = "Houge is the AI agent in this conversation; \"Houge\", \"猴哥\", \"you\" and \"your\" mean Houge. ";
const THREAD = "`recent_turns` is the conversation before `latest_message`, oldest first. `quoted_turn`, when not null, is " +
  "the earlier message `latest_message` replies to. ";
/** The offered-work clause (spec §2.2.1): a bare "好" quoting an hour-old proposal is judged as that proposal's work. */
const OFFERED = "If `latest_message` only agrees to, picks or continues something Houge offered in `quoted_turn` or " +
  "`recent_turns`, answer for that offered work.";

export const TREE_CATEGORY: ChoiceQuestion = {
  id: "category",
  type: "choice",
  instructions: `${HOUGE}${THREAD}What work does \`latest_message\` ask Houge to do? ${OFFERED}`,
  criteria: [
    ["other", "None of the other options fits the work `latest_message` asks for."],
    ["self_change", "Change or diagnose Houge itself: its code, its behaviour, its configuration."],
    ["machine_task", "Work on the Mac: shell commands, files, a project on disk."],
    ["schedule", "Create, change or cancel a scheduled job or a reminder."],
    ["mail_calendar", "Read, search, write or change Gmail messages or Google Calendar events."],
    ["wiki", "Build or refine a wiki page."],
    ["research", "Investigate a topic: several sources, compared, with a conclusion or a recommendation."],
    ["lookup", "One fact or one item that a web search answers."],
    ["answer", "Chat, an explanation, an opinion or a piece of writing; nothing to fetch, nothing to do."],
    ["status", "Houge's own state: whether it restarted, which version is live, whether it is healthy."],
    ["memory", "A rule or preference for Houge to follow from now on, or a correction or retirement of a lesson or fact Houge stored."]
  ]
};

export const TREE_SETS_RULE: NoulQuestion = {
  id: "sets_rule",
  type: "noul",
  instructions: `${HOUGE}Does \`latest_message\` state a rule for Houge to follow from now on?`,
  criteria: {
    true: "`latest_message` states how Houge should behave in later turns too, not only in this reply.",
    false: "`latest_message` asks for something in this turn only, corrects one stored fact, or states no rule."
  }
};

export const TREE_RULE_SCOPE: ChoiceQuestion = {
  id: "rule_scope",
  type: "choice",
  instructions: `${HOUGE}Is the rule in \`latest_message\` about how Houge answers, or about how Houge researches?`,
  criteria: [
    ["ask", "How Houge answers: length, tone, language, format, what to include or leave out."],
    ["research", "How Houge researches: how it searches, which sources it trusts, how it cites what it found."]
  ]
};

export const TREE_BREADTH: ScoreQuestion = {
  id: "breadth",
  type: "score",
  instructions: `${HOUGE}${THREAD}How much ground does \`latest_message\` cover? ${OFFERED}`,
  levels: ["one known thing", "one topic", "several topics", "open-ended"]
};

export const TREE_REASONING: ScoreQuestion = {
  id: "reasoning",
  type: "score",
  instructions: `${HOUGE}${THREAD}How much careful reasoning does answering \`latest_message\` need? ${OFFERED}`,
  levels: ["recall", "straightforward", "non-obvious analysis", "deep multi-factor"]
};

export const TREE_ACTIONS: ScoreQuestion = {
  id: "actions",
  type: "score",
  instructions: `${HOUGE}${THREAD}How many tool actions does doing what \`latest_message\` asks need? ${OFFERED}`,
  levels: ["none", "one or two reads", "several including changes", "many with checks"]
};

export const TREE_QUESTIONS: readonly Question[] = [TREE_CATEGORY, TREE_SETS_RULE, TREE_RULE_SCOPE, TREE_BREADTH, TREE_REASONING, TREE_ACTIONS];

export type HougeTurnKind = "answer" | "clarify" | "proposal";
export type LastHougeTurn = { kind: HougeTurnKind; age_s: number } | null;

/** An offer in Houge's own words (spec §2.2): 要不要 / 我可以 / 需要我 / approve (the approval card's verb). */
const OFFER = /要不要|我可以|需要我|\bapprove\b|\bwant me to\b|\bshall i\b|\bshould i\b|\bwould you like me to\b/i;
/** The trailing-question shape turn-context.ts assistantIntentFor uses for a clarify (closing quotes and brackets allowed). */
const TRAILING_QUESTION = /[?？][\s"'”」）)]*$/;

export function isProposal(text: string): boolean {
  return OFFER.test(text);
}

/**
 * Read-time kind of a stored Houge reply (spec §2.2; the stored `intent` enum is not widened). An offer in the text is a
 * proposal, even on a row stored as `clarify` ("要不要我直接查？" offers work: an agreeing "好" must read as taking it).
 * Then the stored clarify mark. Then a trailing question on a `loop` row (assistantIntentFor stores `loop` for every
 * reply that used a tool) is a proposal: a question after a tool run offers the next step. Everything else answers.
 */
function hougeTurnKind(t: ChatTurnRow): HougeTurnKind {
  if (isProposal(t.text)) return "proposal";
  if (t.intent === "clarify") return "clarify";
  if (t.intent === "loop" && TRAILING_QUESTION.test(t.text.trim())) return "proposal";
  return "answer";
}

function ageSeconds(created_at: string, nowMs: number): number {
  const age = Math.round((nowMs - Date.parse(created_at)) / 1000);
  return Number.isFinite(age) ? Math.max(0, age) : 0;
}

/** The last assistant turn before `nowMs`, with its read-time kind and age. One rule for live, the quote and the replay. */
export function lastHougeTurnOf(recent: ChatTurnRow[], nowMs: number): LastHougeTurn {
  const last = [...recent].reverse().find((t) => t.role === "assistant");
  return last ? { kind: hougeTurnKind(last), age_s: ageSeconds(last.created_at, nowMs) } : null;
}

/**
 * A quoted stored turn as the tree's state reads it (spec §2.2.1). ONE builder for the live decision point (Task 10) and
 * the replay (Task 12): a second copy would give every quoted turn a different `state_hash` in the replay.
 * A Houge row gets its read-time kind; a user row has no Houge kind, so "answer", the neutral value the type needs.
 */
export function quotedTurnFromRow(row: ChatTurnRow, nowMs: number): QuotedTurn {
  const houge = row.role === "assistant";
  return { role: houge ? "houge" : "user", kind: houge ? hougeTurnKind(row) : "answer", age_s: ageSeconds(row.created_at, nowMs), text: row.text };
}

export interface QuotedTurn { role: "houge" | "user"; kind: HougeTurnKind; age_s: number; text: string }
export interface TreeStateInput {
  userText: string; recentTurns: ChatTurnRow[]; turnChars: number; modality: TurnModality;
  lastHougeTurn: LastHougeTurn; quotedTurn: QuotedTurn | null;
}
export type TreeStateResult = { ok: true; state: Record<string, unknown>; chars: number } | { ok: false; skip: "state_too_large" };

/**
 * Lane 1's egress envelope (2026-09-25 approval) plus `quoted_turn`: every text field through `feedTurnText` (thread and
 * quote only), `sanitizeJevText` and the broker's redactor; the quote counts toward the request cap. Skip, never truncate.
 */
export function buildTreeState(i: TreeStateInput, brokerRedact?: (s: string) => string): TreeStateResult {
  if (i.userText.length > MAX_LATEST_MESSAGE_CHARS) return { ok: false, skip: "state_too_large" };
  const text = (t: string): string => sanitizeJevText(feedTurnText(t, i.turnChars), brokerRedact);
  const q = i.quotedTurn;
  const state: Record<string, unknown> = {
    modality: i.modality,
    latest_message: sanitizeJevText(i.userText, brokerRedact),
    recent_turns: i.recentTurns.map((t) => ({ role: t.role === "user" ? "user" : "houge", text: text(t.text) })),
    last_houge_turn: i.lastHougeTurn,
    quoted_turn: q ? { role: q.role, kind: q.kind, age_s: q.age_s, text: text(q.text) } : null
  };
  const chars = JSON.stringify({ state, questions: TREE_QUESTIONS.map(toJevQuestion) }).length;
  if (chars > MAX_REQUEST_CHARS) return { ok: false, skip: "state_too_large" };
  return { ok: true, state, chars };
}
```

`buildTreeState` reuses lane 1's envelope exactly (`src/jev/questions/triage.ts:72-83`):
- the same latest-message cap check first;
- the same `feedTurnText` → `sanitizeJevText(…, brokerRedact)` pipeline for each thread line;
- the same `JSON.stringify({ state, questions })` measure against `MAX_REQUEST_CHARS`.

It adds `quoted_turn`, which goes through the thread pipeline and is counted in the same measure. Lane 1's
`buildTriageState` and `lastHougeTurnOf` in `triage.ts` stay in place until Task 10 removes them.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run tests/jev && npm run typecheck`
Expected: PASS (`tree-questions.test.ts` 15 tests in the draft build), and tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/jev/questions/tree.ts tests/jev/tree-questions.test.ts
git commit -m "$(cat <<'EOF'
feat(jev): the decision tree's six frozen questions and its state with the quoted turn

Category lists the fall-through first and the no-planner lanes last;
last_houge_turn.kind is read at read time (offer regex, stored clarify,
trailing question after a tool run); quoted_turn counts toward the 24K cap.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

---

### Task 4: Quote resolution, `chat_turns.quoted_turn_id`, `quotedLine` and the prompt slot (spec §2.2.1)

**Files:**
- Modify: `src/run/run-store.ts` — `ChatTurnRow` (:352-360) gains `quoted_turn_id`, plus the new `QuoteResolution` type;
  `recordChatTurn` (:1115-1135) gains `quoted_turn_id?`; every SELECT that builds a `ChatTurnRow` adds the column
  (`getRecentChatTurns` :1146, :1153; `getChatTurnsBefore` :1169; `getChatTurnsAfter` :1297, :1304;
  `recentTelegramUserTurns` :2635); `resolveQuotedTurn` + two private helpers + module-level `oneTurn` (new);
  migration `applyChatTurnsQuotedMigration` (new, called after `applyJevDecisionInstantsMigration()` at :6692).
  **Removes** `getRunIdByProviderMessageId` (:1611-1625) and `getAssistantChatTurnForRun` (:1627-1639): zero callers in
  `src/`, `tests/`, `scripts/` (probed: `grep -rn` returns only their definitions); they were the half-built "reply-hint"
  lookup that `resolveQuotedTurn` replaces with the spec's stricter rules (chat check, final_report only, no evolution
  report, exactly one row), so leaving them would keep a second, looser resolution path.
- Modify: `src/omp/turn-context.ts` — import (:4), `TurnPromptInput` (:34-42) gains `quoted?`, `quotedLine` (new, after
  `SCHEDULED_PREFIX` :44), `buildTurnPrompt` prompt template (:294).
- Modify (literal `ChatTurnRow` fixtures that the new required field breaks — probed with `tsc --noEmit` on a copy):
  `tests/capabilities/episodic-evidence.test.ts:25-26`, `tests/capabilities/intent.test.ts:18-27`,
  `tests/jev/intent-question.test.ts:6-8`, `tests/jev/questions.test.ts:7-8`.
- Modify: `tests/run/run-store-approvals.test.ts:585-591` — the migration count 29 → 30.
- Create: `tests/run/quoted-turn.test.ts`
- Modify: `tests/omp/turn-context.test.ts` — import `quotedLine`; one test in the seed describe (:395-490); one new describe.

**Interfaces:**
- Consumes: `QuotedTurn` from `src/jev/questions/tree.ts` (Task 3: `{ role: "houge" | "user"; kind: HougeTurnKind; age_s:
  number; text: string }`); `feedTurnText(text, maxChars)` (`src/capabilities/intent.ts:88`); `notification_outbox`
  columns `provider_message_id`, `target_key` (`telegram:<chat_id>`, `notificationTargetKey` run-store.ts:6559),
  `intent_type`, `idempotency_key`, `run_id`; `runs.source_reference` (adapter shape
  `telegram:update:<update_id>:message:<message_id>`, telegram-trigger-adapter.ts:372) and `runs.notify_json`
  (`{"kind":"telegram","chat_id":"<id>"}`, written by `insertRunRow` run-store.ts:6297); the Telegram adapter's provider
  id `telegram:<message_id>` (telegram-notification-adapter.ts:128).
- Produces (contract): `ChatTurnRow.quoted_turn_id: string | null`; `recordChatTurn({ …, quoted_turn_id?: string })`;
  migration `"2026-10-07-chat-turns-quoted"`; `export type QuoteResolution`; `RunStore.resolveQuotedTurn(chat_id: string,
  reply_to_message_id: number): QuoteResolution`; `TurnPromptInput.quoted?: string`; `export function quotedLine(q:
  QuotedTurn, turnChars: number): string`; `buildTurnPrompt` = `${note}${s.seed}${prefix}${cap}${context}${quoted}${i.message}`.

Resolution rules as implemented (spec §2.2.1, Rev 8):
- Houge's reply: outbox rows with `provider_message_id = 'telegram:<id>'`, `target_key = 'telegram:<chat_id>'` and
  `run_id IS NOT NULL`. If any exist, only those with `intent_type = 'final_report'` and an `idempotency_key` that does not
  contain `:evolution_report:` qualify; none qualifying → `not_final`; more than one distinct run → `ambiguous`; else
  that run's `chat_turns` rows with `chat_id = ?`, `role = 'assistant'`, `intent IS NOT 'evolution_report'` (SQLite's
  `IS NOT` keeps a NULL-intent row; `<>` would drop it): exactly one → `{ ok: true, role: "houge" }`, none → `no_mapping`,
  several → `ambiguous`.
- Paco's message (no outbox row matched; Telegram message ids are unique per chat, so the two paths never collide):
  `runs` with `source = 'telegram'`, `source_reference LIKE 'telegram:update:%:message:<id>'` (LIKE anchors both ends,
  so `:message:12` cannot match `:message:123`; the id is a validated positive integer, never a wildcard) and
  `json_extract(notify_json, '$.chat_id') = chat_id` → that run's one `role = 'user'` turn in this chat.
- A non-positive or non-integer id → `no_mapping` without a query.

- [ ] **Step 1: Write the failing tests**

Create `tests/run/quoted-turn.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { RunStore } from "../../src/run/run-store.js";

/**
 * Spec §2.2.1: a Telegram reply anchors the turn to the STORED message it quotes. A wrong resolution would hand Jev and
 * the planner words nobody said in this thread, so anything not provably that one turn resolves to nothing.
 */
let store: RunStore;
beforeEach(() => { store = RunStore.openInMemory(); });
afterEach(() => { store.close(); });

let seq = 0;
/** A Telegram turn run born from message `messageId` in `chat` (the adapter's source_reference, telegram-trigger-adapter.ts:372), with Paco's chat turn. */
function telegramRun(chat: string, messageId: number, text = "以后回复短一点"): string {
  seq += 1;
  const created = store.createOrGet(buildTypedTaskEvent({
    source: "telegram", type: "turn", program: "turn", goal: text, requested_by: { kind: "user", id: "paco" },
    notify: { kind: "telegram", chat_id: chat }, idempotency_key: `telegram:${seq}:${messageId}`,
    source_reference: `telegram:update:${seq}:message:${messageId}`
  }));
  if (created.status !== "created") throw new Error(`expected created, got ${created.status}`);
  store.recordChatTurn({ chat_id: chat, run_id: created.run_id, role: "user", text });
  return created.run_id;
}

/** Claim and deliver the oldest queued notification as Telegram message `id` (the adapter's provider id shape). */
function deliver(id: number): void {
  const claimed = store.claimNextNotification("w", 60);
  if (!claimed) throw new Error("nothing queued");
  store.markNotificationDelivered(claimed.notification_id, `telegram:${id}`);
}

/** Houge's reply to a run: its assistant chat turn, then its final_report delivered as message `id`. */
function hougeReply(run_id: string, chat: string, id: number, text = "要不要我查一下？", intent?: string): void {
  store.recordChatTurn({ chat_id: chat, run_id, role: "assistant", text, ...(intent ? { intent } : {}) });
  store.enqueueFinalReportNotification(run_id, { text, report_path: "r" });
  deliver(id);
}

describe("resolveQuotedTurn (spec §2.2.1)", () => {
  it("a quote of a delivered Houge reply resolves to that run's assistant turn — a NULL intent included", () => {
    // `intent <> 'evolution_report'` would drop a NULL-intent reply; the rule must be NULL-safe
    const run = telegramRun("555", 10);
    hougeReply(run, "555", 11);
    expect(store.resolveQuotedTurn("555", 11)).toMatchObject({ ok: true, role: "houge", turn: { run_id: run, role: "assistant", text: "要不要我查一下？", intent: null } });
  });

  it("a quote of Paco's own message resolves to that run's user turn; message 12 never matches message 123", () => {
    // a prefix match would anchor the turn to a different message of his
    const run = telegramRun("555", 12, "did you restart?");
    telegramRun("555", 123, "明天天气怎么样");
    expect(store.resolveQuotedTurn("555", 12)).toMatchObject({ ok: true, role: "user", turn: { run_id: run, text: "did you restart?" } });
    expect(store.resolveQuotedTurn("555", 1)).toEqual({ ok: false, reason: "no_mapping" });
  });

  it("an unknown id resolves to nothing (a message from before the mapping, or never stored)", () => {
    telegramRun("555", 12);
    expect(store.resolveQuotedTurn("555", 999)).toEqual({ ok: false, reason: "no_mapping" });
  });

  it("a quote from another chat never resolves: Telegram message ids are per chat", () => {
    const run = telegramRun("555", 12);
    hougeReply(run, "555", 13);
    expect(store.resolveQuotedTurn("777", 12)).toEqual({ ok: false, reason: "no_mapping" });
    expect(store.resolveQuotedTurn("777", 13)).toEqual({ ok: false, reason: "no_mapping" });
  });

  it("an evolution report is never the quoted answer: its own message is not_final, and the run's reply skips its row", () => {
    // enqueueEvolutionReportNotification queues final_report too and records a later assistant row (run-store.ts:5648)
    const run = telegramRun("555", 20);
    hougeReply(run, "555", 21, "the answer", "loop");
    store.enqueueEvolutionReportNotification(run, "skill_author", { text: "🐒 report" });
    deliver(22);
    expect(store.resolveQuotedTurn("555", 21)).toMatchObject({ ok: true, role: "houge", turn: { text: "the answer" } });
    expect(store.resolveQuotedTurn("555", 22)).toEqual({ ok: false, reason: "not_final" });
  });

  it("a run with two assistant rows is ambiguous, never a guess", () => {
    const run = telegramRun("555", 30);
    store.recordChatTurn({ chat_id: "555", run_id: run, role: "assistant", text: "first part" });
    hougeReply(run, "555", 31, "second part");
    expect(store.resolveQuotedTurn("555", 31)).toEqual({ ok: false, reason: "ambiguous" });
  });
});

describe("chat_turns.quoted_turn_id (spec §2.2.1: the replay rebuilds the same state)", () => {
  it("records the quoted turn on the new message's row; a plain message reads null", () => {
    const run = telegramRun("555", 40);
    store.recordChatTurn({ chat_id: "555", run_id: run, role: "user", text: "好", quoted_turn_id: "turn_q" });
    expect(store.getRecentChatTurns("555", 10).map((t) => t.quoted_turn_id)).toEqual([null, "turn_q"]);
  });

  it("migrates an older file DB once and reopens idempotently (the ALTER is guarded by table_info)", () => {
    const sqlite = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (p: string) => { exec(sql: string): void; close(): void } };
    const dir = mkdtempSync(join(tmpdir(), "hqt-"));
    try {
      const path = join(dir, "h.sqlite");
      RunStore.open(path).close();
      const raw = new sqlite.DatabaseSync(path); // an older DB: the column and its migration row not yet there
      raw.exec("ALTER TABLE chat_turns DROP COLUMN quoted_turn_id; DELETE FROM schema_migrations WHERE version = '2026-10-07-chat-turns-quoted'");
      raw.close();
      const migrated = RunStore.open(path);
      migrated.recordChatTurn({ chat_id: "555", run_id: "r", role: "user", text: "好", quoted_turn_id: "turn_q" });
      expect(migrated.getRecentChatTurns("555", 1)[0]?.quoted_turn_id).toBe("turn_q");
      migrated.close();
      expect(() => RunStore.open(path).close()).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

In `tests/omp/turn-context.test.ts` add the import and the two tests (the seed test reuses the describe's `completed`,
`current`, `CHAT`, `t` helpers at :395-418):

`tests/omp/turn-context.test.ts` hunk 1 (near line 12). Replace:

```ts
  RESTART_NOTE_PREFIX,
  claimAtDispatch,
  claimRestartNoteAtDispatch,
  SCHEDULED_PREFIX,
  systemPromptFingerprint,
  writeSystemPromptFile,
```

with:

```ts
  RESTART_NOTE_PREFIX,
  claimAtDispatch,
  claimRestartNoteAtDispatch,
  quotedLine,
  SCHEDULED_PREFIX,
  systemPromptFingerprint,
  writeSystemPromptFile,
```

`tests/omp/turn-context.test.ts` hunk 2 (near line 487). Replace:

```ts
    expect(claimAtDispatch(store, CHAT, fired)).toBe(fired.prompt);
    expect(store.getPlannerSessionState(CHAT)!.seed_pending).toBe(1);
  });
});
```

with:

```ts
    expect(claimAtDispatch(store, CHAT, fired)).toBe(fired.prompt);
    expect(store.getPlannerSessionState(CHAT)!.seed_pending).toBe(1);
  });

  it("a quote sits after the seed: a dispatch that lost the seed keeps the quote and the message intact (spec §2.2.1)", async () => {
    // claimAtDispatch strips a lost seed by its exact length from the front; a quote before the seed would be cut
    const store = RunStore.openInMemory();
    completed(store, "earlier message", t(1));
    store.recordPlannerSessionReset(CHAT, "fp", t(6));
    const quoted = "[replying to houge, 3600 s ago: 要不要我查一下？]\n";
    const a = await current(store, "first");
    const run_id = createQueuedTurnRun(store, "好");
    const b = await buildTurnPrompt(deps(store), { run_id, chat_id: CHAT, message: "好", source: "telegram", quoted });
    expect(b.prompt).toBe(`${b.seed}${quoted}好`);
    claimAtDispatch(store, CHAT, a); // the other dispatch claims the seed first
    expect(claimAtDispatch(store, CHAT, b)).toBe(`${quoted}好`);
  });
});

describe("quotedLine (spec §2.2.1)", () => {
  it("names who said it and how long ago, on one line, clipped like a thread turn", () => {
    // a newline inside the quote would let stored text open a second marker line in the planner prompt
    expect(quotedLine({ role: "houge", kind: "proposal", age_s: 3600, text: "要不要\n我查一下？" }, 500)).toBe("[replying to houge, 3600 s ago: 要不要 我查一下？]\n");
    expect(quotedLine({ role: "user", kind: "answer", age_s: 59.6, text: "x".repeat(20) }, 8)).toBe(`[replying to user, 60 s ago: ${"x".repeat(8)}…]\n`);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

```bash
npx vitest run tests/run/quoted-turn.test.ts tests/omp/turn-context.test.ts
```

Expected: FAIL — `store.resolveQuotedTurn is not a function`, `table chat_turns has no column named quoted_turn_id`
(the recordChatTurn and migration cases), `quotedLine is not a function`, and the seed test's prompt lacks the quoted line.

- [ ] **Step 3: Implement the store side**

`src/run/run-store.ts` hunk 1 (near line 357). Replace:

```ts
  text: string;
  intent: string | null;
  created_at: string;
}

/** One historical user turn eligible for Jev replay (Jev spec 2026-09-25). */
export interface ReplayTurnRow {
```

with:

```ts
  text: string;
  intent: string | null;
  created_at: string;
  /** The stored turn this message quoted (a Telegram reply resolved by resolveQuotedTurn, spec §2.2.1); null otherwise. */
  quoted_turn_id: string | null;
}

/** A Telegram quote resolved to the stored turn it replies to (spec §2.2.1), or why it could not be. */
export type QuoteResolution =
  | { ok: true; role: "houge" | "user"; turn: ChatTurnRow }
  | { ok: false; reason: "no_mapping" | "ambiguous" | "not_final" };

/** One historical user turn eligible for Jev replay (Jev spec 2026-09-25). */
export interface ReplayTurnRow {
```

`src/run/run-store.ts` hunk 2 (near line 934). Replace:

```ts
  return text.length > LESSON_MAX_CHARS || (avoid?.length ?? 0) > LESSON_AVOID_MAX_CHARS;
}

export class RunStore {
  /**
   * Secrets-firewall redactor (ADR 0015): masks known secret VALUES at RunStore's own write seams —
```

with:

```ts
  return text.length > LESSON_MAX_CHARS || (avoid?.length ?? 0) > LESSON_AVOID_MAX_CHARS;
}

/** Exactly one stored turn resolves a quote; none is no mapping, several is ambiguous (spec §2.2.1). */
function oneTurn(turns: ChatTurnRow[], role: "houge" | "user"): QuoteResolution {
  const [turn] = turns;
  if (!turn) return { ok: false, reason: "no_mapping" };
  return turns.length === 1 ? { ok: true, role, turn } : { ok: false, reason: "ambiguous" };
}

export class RunStore {
  /**
   * Secrets-firewall redactor (ADR 0015): masks known secret VALUES at RunStore's own write seams —
```

`src/run/run-store.ts` hunk 3 (near line 1119). Replace:

```ts
    text: string;
    intent?: string;
    created_at?: string;
  }): void {
    this.db.prepare(`
      INSERT INTO chat_turns (turn_id, chat_id, run_id, role, text, intent, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      `turn_${randomUUID()}`,
      input.chat_id,
```

with:

```ts
    text: string;
    intent?: string;
    created_at?: string;
    /** The turn this message quoted (spec §2.2.1), so the replay rebuilds the same state. */
    quoted_turn_id?: string;
  }): void {
    this.db.prepare(`
      INSERT INTO chat_turns (turn_id, chat_id, run_id, role, text, intent, created_at, quoted_turn_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `turn_${randomUUID()}`,
      input.chat_id,
```

`src/run/run-store.ts` hunk 4 (near line 1130). Replace:

```ts
      input.role,
      input.text,
      input.intent ?? null,
      input.created_at ?? new Date().toISOString()
    );
  }
```

with:

```ts
      input.role,
      input.text,
      input.intent ?? null,
      input.created_at ?? new Date().toISOString(),
      input.quoted_turn_id ?? null
    );
  }
```

`src/run/run-store.ts` hunk 5 (near line 1143). Replace:

```ts
  getRecentChatTurns(chat_id: string, limit: number, sinceIso?: string): ChatTurnRow[] {
    const rows = sinceIso
      ? this.db.prepare(`
          SELECT turn_id, chat_id, run_id, role, text, intent, created_at
          FROM chat_turns
          WHERE chat_id = ? AND created_at >= ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT ?
        `).all<ChatTurnRow>(chat_id, sinceIso, limit)
      : this.db.prepare(`
          SELECT turn_id, chat_id, run_id, role, text, intent, created_at
          FROM chat_turns
          WHERE chat_id = ?
          ORDER BY created_at DESC, rowid DESC
```

with:

```ts
  getRecentChatTurns(chat_id: string, limit: number, sinceIso?: string): ChatTurnRow[] {
    const rows = sinceIso
      ? this.db.prepare(`
          SELECT turn_id, chat_id, run_id, role, text, intent, created_at, quoted_turn_id
          FROM chat_turns
          WHERE chat_id = ? AND created_at >= ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT ?
        `).all<ChatTurnRow>(chat_id, sinceIso, limit)
      : this.db.prepare(`
          SELECT turn_id, chat_id, run_id, role, text, intent, created_at, quoted_turn_id
          FROM chat_turns
          WHERE chat_id = ?
          ORDER BY created_at DESC, rowid DESC
```

`src/run/run-store.ts` hunk 6 (near line 1166). Replace:

```ts
   */
  getChatTurnsBefore(chat_id: string, limit: number, sinceIso: string, beforeIso: string, excludeRunId: string): ChatTurnRow[] {
    return this.db.prepare(`
      SELECT turn_id, chat_id, run_id, role, text, intent, created_at
      FROM chat_turns
      WHERE chat_id = ? AND created_at >= ? AND created_at < ? AND run_id <> ?
      ORDER BY created_at DESC, rowid DESC
```

with:

```ts
   */
  getChatTurnsBefore(chat_id: string, limit: number, sinceIso: string, beforeIso: string, excludeRunId: string): ChatTurnRow[] {
    return this.db.prepare(`
      SELECT turn_id, chat_id, run_id, role, text, intent, created_at, quoted_turn_id
      FROM chat_turns
      WHERE chat_id = ? AND created_at >= ? AND created_at < ? AND run_id <> ?
      ORDER BY created_at DESC, rowid DESC
```

`src/run/run-store.ts` hunk 7 (near line 1294). Replace:

```ts
  getChatTurnsAfter(chat_id: string, afterIso: string | undefined, limit: number): ChatTurnRow[] {
    return afterIso
      ? this.db.prepare(`
          SELECT turn_id, chat_id, run_id, role, text, intent, created_at
          FROM chat_turns
          WHERE chat_id = ? AND created_at > ?
          ORDER BY created_at ASC, rowid ASC
          LIMIT ?
        `).all<ChatTurnRow>(chat_id, afterIso, limit)
      : this.db.prepare(`
          SELECT turn_id, chat_id, run_id, role, text, intent, created_at
          FROM chat_turns
          WHERE chat_id = ?
          ORDER BY created_at ASC, rowid ASC
```

with:

```ts
  getChatTurnsAfter(chat_id: string, afterIso: string | undefined, limit: number): ChatTurnRow[] {
    return afterIso
      ? this.db.prepare(`
          SELECT turn_id, chat_id, run_id, role, text, intent, created_at, quoted_turn_id
          FROM chat_turns
          WHERE chat_id = ? AND created_at > ?
          ORDER BY created_at ASC, rowid ASC
          LIMIT ?
        `).all<ChatTurnRow>(chat_id, afterIso, limit)
      : this.db.prepare(`
          SELECT turn_id, chat_id, run_id, role, text, intent, created_at, quoted_turn_id
          FROM chat_turns
          WHERE chat_id = ?
          ORDER BY created_at ASC, rowid ASC
```

`src/run/run-store.ts` hunk 8 (near line 1609). Replace:

```ts
  }

  /**
   * Correlate a delivered notification's provider_message_id (e.g. `telegram:<id>`)
   * back to its originating run_id — the feedback path uses the reply-hint to find
   * the prior answer's run and thus its chat turn + scope.
   */
  getRunIdByProviderMessageId(provider_message_id: string): string | undefined {
    const row = this.db.prepare(`
      SELECT run_id
      FROM notification_outbox
      WHERE provider_message_id = ? AND run_id IS NOT NULL
      ORDER BY updated_at DESC
      LIMIT 1
    `).get<{ run_id: string | null }>(provider_message_id);
    return row?.run_id ?? undefined;
  }

  /**
   * The assistant chat turn produced by a given run (the feedback reply-hint path
   * correlates a replied-to message → its run → that run's answer + intent → scope).
   */
  getAssistantChatTurnForRun(run_id: string): ChatTurnRow | undefined {
    return this.db.prepare(`
      SELECT turn_id, chat_id, run_id, role, text, intent, created_at
      FROM chat_turns
      WHERE run_id = ? AND role = 'assistant'
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `).get<ChatTurnRow>(run_id);
  }

  listRecentRunStatuses(limit: number): RunStatusRow[] {
```

with:

```ts
  }

  /**
   * A Telegram quote resolved to the stored turn it replies to (spec §2.2.1), code only; Telegram's own copy of the
   * quoted text is never read. Houge's reply: this chat's outbox row whose provider id is `telegram:<id>` → that run's
   * one assistant turn. Paco's message: the run born from `telegram:update:*:message:<id>` in this chat → its one user
   * turn. Telegram message ids are per chat, so every lookup is scoped to `chat_id`.
   */
  resolveQuotedTurn(chat_id: string, reply_to_message_id: number): QuoteResolution {
    if (!Number.isSafeInteger(reply_to_message_id) || reply_to_message_id <= 0) return { ok: false, reason: "no_mapping" };
    const sent = this.db.prepare(`
      SELECT run_id, intent_type, idempotency_key FROM notification_outbox
      WHERE provider_message_id = ? AND target_key = ? AND run_id IS NOT NULL
    `).all<{ run_id: string; intent_type: string; idempotency_key: string }>(`telegram:${reply_to_message_id}`, `telegram:${chat_id}`);
    return sent.length > 0 ? this.quotedHougeTurn(chat_id, sent) : this.quotedUserTurn(chat_id, reply_to_message_id);
  }

  /**
   * Only a run's `final_report` maps to its answer, and never an evolution report (queued as `final_report` too, under
   * `<run>:evolution_report:<tool>`). The run must hold exactly one assistant turn outside `evolution_report` (`IS NOT`
   * keeps a NULL-intent reply); none or several is unresolved, never a guess.
   */
  private quotedHougeTurn(chat_id: string, sent: Array<{ run_id: string; intent_type: string; idempotency_key: string }>): QuoteResolution {
    const runs = [...new Set(sent.filter((r) => r.intent_type === "final_report" && !r.idempotency_key.includes(":evolution_report:")).map((r) => r.run_id))];
    const [run] = runs;
    if (run === undefined) return { ok: false, reason: "not_final" };
    if (runs.length > 1) return { ok: false, reason: "ambiguous" };
    const turns = this.db.prepare(`
      SELECT turn_id, chat_id, run_id, role, text, intent, created_at, quoted_turn_id
      FROM chat_turns
      WHERE run_id = ? AND chat_id = ? AND role = 'assistant' AND intent IS NOT 'evolution_report'
      ORDER BY created_at ASC, rowid ASC
      LIMIT 2
    `).all<ChatTurnRow>(run, chat_id);
    return oneTurn(turns, "houge");
  }

  /** LIKE anchors both ends: `…:message:12` never matches `…:message:123` (the id is digits, never a wildcard). */
  private quotedUserTurn(chat_id: string, messageId: number): QuoteResolution {
    const runs = this.db.prepare(`
      SELECT run_id FROM runs
      WHERE source = 'telegram' AND source_reference LIKE ?
        AND json_extract(notify_json, '$.kind') = 'telegram' AND json_extract(notify_json, '$.chat_id') = ?
    `).all<{ run_id: string }>(`telegram:update:%:message:${messageId}`, chat_id);
    const [run] = runs;
    if (run === undefined) return { ok: false, reason: "no_mapping" };
    if (runs.length > 1) return { ok: false, reason: "ambiguous" };
    const turns = this.db.prepare(`
      SELECT turn_id, chat_id, run_id, role, text, intent, created_at, quoted_turn_id
      FROM chat_turns
      WHERE run_id = ? AND chat_id = ? AND role = 'user'
      ORDER BY created_at ASC, rowid ASC
      LIMIT 2
    `).all<ChatTurnRow>(run.run_id, chat_id);
    return oneTurn(turns, "user");
  }

  listRecentRunStatuses(limit: number): RunStatusRow[] {
```

`src/run/run-store.ts` hunk 9 (near line 2632). Replace:

```ts
        ORDER BY last_at DESC
        LIMIT ?
      )
      SELECT u.turn_id, u.chat_id, u.run_id, u.role, u.text, u.intent, u.created_at
      FROM chat_turns u
      WHERE u.chat_id = ? AND u.role = 'user' AND u.run_id IN (SELECT run_id FROM picked)
      ORDER BY u.created_at ASC, u.rowid ASC
```

with:

```ts
        ORDER BY last_at DESC
        LIMIT ?
      )
      SELECT u.turn_id, u.chat_id, u.run_id, u.role, u.text, u.intent, u.created_at, u.quoted_turn_id
      FROM chat_turns u
      WHERE u.chat_id = ? AND u.role = 'user' AND u.run_id IN (SELECT run_id FROM picked)
      ORDER BY u.created_at ASC, u.rowid ASC
```

`src/run/run-store.ts` hunk 10 (near line 6690). Replace:

```ts
    this.applyJevDecisionsMigration();
    this.applyLessonChangesMigration();
    this.applyJevDecisionInstantsMigration();
  }

  /** Memory A1 §6: the lesson-set fingerprint each chat's omp session started on, persisted so a restart still compares. */
```

with:

```ts
    this.applyJevDecisionsMigration();
    this.applyLessonChangesMigration();
    this.applyJevDecisionInstantsMigration();
    this.applyChatTurnsQuotedMigration();
  }

  /** Memory A1 §6: the lesson-set fingerprint each chat's omp session started on, persisted so a restart still compares. */
```

`src/run/run-store.ts` hunk 11 (near line 6772). Replace:

```ts
      const cols = this.tableColumns("jev_decisions");
      if (!cols.has("thread_cut_at")) this.db.exec(`ALTER TABLE jev_decisions ADD COLUMN thread_cut_at TEXT`);
      if (!cols.has("state_built_at")) this.db.exec(`ALTER TABLE jev_decisions ADD COLUMN state_built_at TEXT`);
      if (!applied) this.db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`).run(version, new Date().toISOString());
    });
  }
```

with:

```ts
      const cols = this.tableColumns("jev_decisions");
      if (!cols.has("thread_cut_at")) this.db.exec(`ALTER TABLE jev_decisions ADD COLUMN thread_cut_at TEXT`);
      if (!cols.has("state_built_at")) this.db.exec(`ALTER TABLE jev_decisions ADD COLUMN state_built_at TEXT`);
      if (!applied) this.db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`).run(version, new Date().toISOString());
    });
  }

  /** Spec §2.2.1: the turn a Telegram quote resolved to, recorded on the new message's row. Guarded by table_info (idempotent). */
  private applyChatTurnsQuotedMigration(): void {
    const version = "2026-10-07-chat-turns-quoted";
    this.inTransaction(() => {
      const applied = this.db.prepare(`SELECT version FROM schema_migrations WHERE version = ?`).get<{ version: string }>(version);
      if (!this.tableColumns("chat_turns").has("quoted_turn_id")) this.db.exec(`ALTER TABLE chat_turns ADD COLUMN quoted_turn_id TEXT`);
      if (!applied) this.db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`).run(version, new Date().toISOString());
    });
  }
```

- [ ] **Step 4: Implement the prompt side**

`src/omp/turn-context.ts` hunk 1 (near line 1). Replace:

```ts
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chatContextSince, countTrailingClarifyTurns, resolveChatContextTurns, resolveMaxConsecutiveClarify } from "../capabilities/intent.js";
import { composeSystemPrompt } from "../prompt/composer.js";
import { resolveLocalTimeZone } from "../prompt/tz-convert.js";
import { openAlertedIncident, resolveOpenIncidents } from "../run/incident-alert.js";
```

with:

```ts
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chatContextSince, countTrailingClarifyTurns, feedTurnText, resolveChatContextTurns, resolveMaxConsecutiveClarify } from "../capabilities/intent.js";
import type { QuotedTurn } from "../jev/questions/tree.js";
import { composeSystemPrompt } from "../prompt/composer.js";
import { resolveLocalTimeZone } from "../prompt/tz-convert.js";
import { openAlertedIncident, resolveOpenIncidents } from "../run/incident-alert.js";
```

`src/omp/turn-context.ts` hunk 2 (near line 39). Replace:

```ts
  goal?: string;
  /** The spawn-time snapshot (the supervisor's); absent → what the prompt would render now (one-shot callers, tests). */
  applied?: AppliedSnapshot;
}

export const SCHEDULED_PREFIX = (goal: string): string => `[scheduled: ${goal}]\n`;

/**
 * The consecutive-clarify cap (ADR 0010, spec §6): once Houge has asked `HOUGE_MAX_CONSECUTIVE_CLARIFY`
```

with:

```ts
  goal?: string;
  /** The spawn-time snapshot (the supervisor's); absent → what the prompt would render now (one-shot callers, tests). */
  applied?: AppliedSnapshot;
  /** The quoted turn's marked line (quotedLine, spec §2.2.1), placed just before the message. */
  quoted?: string;
}

export const SCHEDULED_PREFIX = (goal: string): string => `[scheduled: ${goal}]\n`;

/**
 * A Telegram quote as one marked line ahead of the message (spec §2.2.1): who said it, how long ago, and the stored
 * text clipped like a thread turn. Whitespace folds to single spaces so the quote can never fake a second line.
 */
export function quotedLine(q: QuotedTurn, turnChars: number): string {
  const text = feedTurnText(q.text.replace(/\s+/g, " ").trim(), turnChars);
  return `[replying to ${q.role}, ${Math.max(0, Math.round(q.age_s))} s ago: ${text}]\n`;
}

/**
 * The consecutive-clarify cap (ADR 0010, spec §6): once Houge has asked `HOUGE_MAX_CONSECUTIVE_CLARIFY`
```

`src/omp/turn-context.ts` hunk 3 (near line 291). Replace:

```ts
  const note = i.source === "schedule" ? "" : restartNote(d, i.chat_id);
  const s = sessionSeed(d, i);
  return {
    prompt: `${note}${s.seed}${prefix}${cap}${context}${i.message}`,
    restartNote: note,
    ...(s.pending ? { seed: s.seed, seedPending: true } : {})
  };
```

with:

```ts
  const note = i.source === "schedule" ? "" : restartNote(d, i.chat_id);
  const s = sessionSeed(d, i);
  return {
    // the quote sits after the seed: claimAtDispatch strips a lost seed by its exact length, from the front
    prompt: `${note}${s.seed}${prefix}${cap}${context}${i.quoted ?? ""}${i.message}`,
    restartNote: note,
    ...(s.pending ? { seed: s.seed, seedPending: true } : {})
  };
```

`claimAtDispatch` (turn-context.ts:103-108) strips a lost seed by `built.restartNote.length + seed.length` from the
front, and a lost restart note by `restartNote.length`; the quote sits after both, so neither strip can cut it (the new
seed test pins this).

- [ ] **Step 5: Fix the fixtures the new required field breaks, and the migration count**

`tests/capabilities/episodic-evidence.test.ts` hunk 1 (near line 23). Replace:

```ts
afterEach(() => { store.close(); });

const turn = (n: number, role: "user" | "assistant", text: string, run_id = "r1"): ChatTurnRow =>
  ({ turn_id: `t${n}`, chat_id: CHAT, run_id, role, text, intent: null, created_at: NOW });
const noSchedule = () => undefined;

describe("checkEvidence — provenance, not truth (spec §4)", () => {
```

with:

```ts
afterEach(() => { store.close(); });

const turn = (n: number, role: "user" | "assistant", text: string, run_id = "r1"): ChatTurnRow =>
  ({ turn_id: `t${n}`, chat_id: CHAT, run_id, role, text, intent: null, created_at: NOW, quoted_turn_id: null });
const noSchedule = () => undefined;

describe("checkEvidence — provenance, not truth (spec §4)", () => {
```

`tests/capabilities/intent.test.ts` hunk 1 (near line 23). Replace:

```ts
    role,
    text,
    intent: role === "assistant" ? intent ?? "answer" : null,
    created_at: "2026-06-19T00:00:00.000Z"
  };
}
```

with:

```ts
    role,
    text,
    intent: role === "assistant" ? intent ?? "answer" : null,
    created_at: "2026-06-19T00:00:00.000Z",
    quoted_turn_id: null
  };
}
```

`tests/jev/intent-question.test.ts` hunk 1 (near line 4). Replace:

```ts
import type { ChatTurnRow } from "../../src/run/run-store.js";

const turn = (role: "user" | "assistant", text: string, i: number): ChatTurnRow => ({
  turn_id: `t${i}`, chat_id: "c", run_id: `r${i}`, role, text, intent: role === "assistant" ? "answer" : null, created_at: `2026-09-01T00:00:0${i}.000Z`
});

describe("buildJevIntentRequest", () => {
```

with:

```ts
import type { ChatTurnRow } from "../../src/run/run-store.js";

const turn = (role: "user" | "assistant", text: string, i: number): ChatTurnRow => ({
  turn_id: `t${i}`, chat_id: "c", run_id: `r${i}`, role, text, intent: role === "assistant" ? "answer" : null, created_at: `2026-09-01T00:00:0${i}.000Z`, quoted_turn_id: null
});

describe("buildJevIntentRequest", () => {
```

`tests/jev/questions.test.ts` hunk 1 (near line 5). Replace:

```ts

const q = (criteria: ReadonlyArray<readonly [string, string]>): Question => ({ id: "t", type: "choice", instructions: "pick", criteria });
const turn = (role: "user" | "assistant", text: string, created_at = "2026-10-04T00:00:00.000Z", intent: string | null = null) =>
  ({ turn_id: "t", chat_id: "c", run_id: "r", role, text, intent, created_at });

describe("criteriaHash (spec §3.1: option ORDER is a calibration variable; the model is a separate key)", () => {
  it("changes when options are reordered or a word changes; does not depend on the model", () => {
```

with:

```ts

const q = (criteria: ReadonlyArray<readonly [string, string]>): Question => ({ id: "t", type: "choice", instructions: "pick", criteria });
const turn = (role: "user" | "assistant", text: string, created_at = "2026-10-04T00:00:00.000Z", intent: string | null = null) =>
  ({ turn_id: "t", chat_id: "c", run_id: "r", role, text, intent, created_at, quoted_turn_id: null });

describe("criteriaHash (spec §3.1: option ORDER is a calibration variable; the model is a separate key)", () => {
  it("changes when options are reordered or a word changes; does not depend on the model", () => {
```

If Tasks 1–3 rewrote `tests/jev/questions.test.ts` or added new `ChatTurnRow` literals (e.g. a `tests/jev/tree.test.ts`
`turn()` helper), `npm run typecheck` names each one (`Property 'quoted_turn_id' is missing`); add `quoted_turn_id: null`
to each, nothing else.

`tests/run/run-store-approvals.test.ts` hunk 1 (near line 582). Replace:

```ts
      expect(store.getRunStatus("run_m1")?.state).toBe("completed");
      expect(store.getLedgerEvents("run_m1")).toHaveLength(1);
      expectTablesAndIndexes(store);
      // 29 = milestone-2 + guardrails + daemon + chat-turns + lesson-blocks + lessons-rows + reload-marker + signal-path + episodic-facts + episodic-consolidate-state + lesson-consolidate-state + episodic-core + scheduled-tasks + metered-fuse + wiki-pages + backup-state + projects + incidents + idea-radar + idea-panel + skill-reverify + omp-runtime + daemon-boots + memory-changes + lesson-theme + planner-session-state + jev-decisions + lesson-changes + jev-decision-instants.
      expect(db(store).prepare("SELECT COUNT(*) AS count FROM schema_migrations")
        .get<{ count: number }>()?.count).toBe(29);
      store.close();

      store = RunStore.open(path);
      expect(db(store).prepare("SELECT COUNT(*) AS count FROM schema_migrations")
        .get<{ count: number }>()?.count).toBe(29);
      expect(store.getRunStatus("run_m1")?.state).toBe("completed");
    } finally {
      store?.close();
```

with:

```ts
      expect(store.getRunStatus("run_m1")?.state).toBe("completed");
      expect(store.getLedgerEvents("run_m1")).toHaveLength(1);
      expectTablesAndIndexes(store);
      // 30 = milestone-2 + guardrails + daemon + chat-turns + lesson-blocks + lessons-rows + reload-marker + signal-path + episodic-facts + episodic-consolidate-state + lesson-consolidate-state + episodic-core + scheduled-tasks + metered-fuse + wiki-pages + backup-state + projects + incidents + idea-radar + idea-panel + skill-reverify + omp-runtime + daemon-boots + memory-changes + lesson-theme + planner-session-state + jev-decisions + lesson-changes + jev-decision-instants + chat-turns-quoted.
      expect(db(store).prepare("SELECT COUNT(*) AS count FROM schema_migrations")
        .get<{ count: number }>()?.count).toBe(30);
      store.close();

      store = RunStore.open(path);
      expect(db(store).prepare("SELECT COUNT(*) AS count FROM schema_migrations")
        .get<{ count: number }>()?.count).toBe(30);
      expect(store.getRunStatus("run_m1")?.state).toBe("completed");
    } finally {
      store?.close();
```

- [ ] **Step 6: Run the tests and the typecheck**

```bash
npx vitest run tests/run/quoted-turn.test.ts tests/omp/turn-context.test.ts tests/run/run-store-approvals.test.ts tests/capabilities tests/jev
npm run typecheck
```

Expected: PASS (probed on a copy of `main@94e3b4c`: quoted-turn 8/8, turn-context 37/37, approvals 16/16), typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/run/run-store.ts src/omp/turn-context.ts tests/run/quoted-turn.test.ts tests/omp/turn-context.test.ts \
  tests/run/run-store-approvals.test.ts tests/capabilities/episodic-evidence.test.ts tests/capabilities/intent.test.ts \
  tests/jev/intent-question.test.ts tests/jev/questions.test.ts
git commit -m "feat(quote): resolve a Telegram quote to its stored turn; chat_turns.quoted_turn_id; quotedLine prompt slot

Spec §2.2.1: a Houge reply resolves through its delivered final_report (never an evolution report, same chat,
exactly one assistant row); Paco's message through the run's source_reference. Removes the unused reply-hint
lookups (getRunIdByProviderMessageId, getAssistantChatTurnForRun) that this replaces.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

---

### Task 5: Routing policy — `src/jev/tree-policy.ts` (pure)

**Contract additions (Rev 2, no renames):**
- `Armed` gains `rule: boolean` (review fix F6): `sets_rule` + `rule_scope` arm on their own rows, separately from
  `category`. `memory` stays in `Armed` and is derived (`category && rule`).
- The `cascade` variant of `RoutePlan` gains `ruleScope: "ask" | "research" | null` (review fix F5): the confident
  `rule_scope` override, carried so `applyCascade` can fix a rule's scope **after** the final category is known.
  Full type: `{ kind: "cascade"; between: readonly [Category, Category]; base: Route; ruleScope: "ask" | "research" | null }`.

**Stage A calls the cascade (Rev 4, plan Decision 14; Rev 2's F10 deferral is reversed):** Task 10 makes the one
Tiny-role call for a `cascade` plan and passes its pick (or `null` on failure, timeout or an invalid answer) to
`applyCascade`. The replay (Task 12) makes no model call and settles a cascade plan as `applyCascade(plan, null)`.
This module stays pure: nothing below changes.

**Further contract additions:** besides the contract's names this module exports four small helpers that Task 10
needs and that would otherwise be duplicated in `core-worker.ts`:
- `thinkHarderIn(text): boolean`. `preJudge` uses it. The decision point also reads it on paths that never reach
  `preJudge` (flag off, posture, modality), so a skipped turn honours `think harder` too.
- `ACK_ROUTE: Route`, the route for an acknowledgement the code settles before Jev (spec §2.1).
- `TREE_STATUS_ARM_ID = "category:status"`, the status lane's arming pseudo-row (lessons.md, "One calibration row
  armed two lanes").
- `TREE_THRESHOLD_VERSION`, stamped on every decision row in place of lane 1's `THRESHOLD_VERSION`, which Task 12
  removes.

**Files:**
- Create: `src/jev/tree-policy.ts`
- Test: `tests/jev/tree-policy.test.ts` (new)

**Interfaces:**
- Consumes:
  - `isBareAck(text)` (`src/omp/bare-ack.ts:11`).
  - `calibratedLang(questionId, hash, model, lang, rows)` and `type CalibrationRow` (`src/jev/calibration.ts:54`, `:16`).
  - `type Lang` (`src/jev/intent-question.ts`).
  - `type JevAnswer`, `type JevChoiceAnswer` (Task 1, `src/jev/jev-client.ts`).
  - `CATEGORIES`, `type Category`, `type LastHougeTurn`, `TREE_CATEGORY`, `TREE_SETS_RULE`, `TREE_RULE_SCOPE`,
    `TREE_BREADTH`, `TREE_REASONING`, `TREE_ACTIONS`, `TREE_QUESTIONS` (Task 3, `src/jev/questions/tree.ts`).
  - `criteriaHash`, `type Question` (Task 1, `src/jev/questions/types.ts`).
- Produces: exactly the contract's "Routing policy (Task 5)" block, plus the four additions above:
  ```ts
  export function thinkHarderIn(text: string): boolean;
  export const ACK_ROUTE: Route;            // answer · planner · fast · low · reason "ack_rule"
  export const TREE_STATUS_ARM_ID = "category:status";
  export const TREE_THRESHOLD_VERSION = "2026-10-07.1";
  ```

**Semantics fixed here (spec §2.1, §2.4, §3; the tests encode each one):**
- **Order.** No category answer, or neither the category question nor the status row armed → `uncalibrated`.
  Then status (it arms on its own row plus the rule rows, so it can act while category and gear are unarmed). Then
  category unarmed → `uncalibrated`. Then the choice bar (cascade below it). Then memory. Everything else → planner,
  reason `routed`.
- **Arming (F6).** `treeArmed` returns five flags, each from its own rows: `category` (the category row), `status`
  (the `category:status` pseudo-row), `rule` (the `sets_rule` **and** `rule_scope` rows), `gear` (the three score
  rows), and `memory = category && rule`. Arming `category` alone already routes every category to its floor (research
  → Thinking, self_change and the other action categories → at least Default); that coupling is Paco's call at row
  commit (plan Decisions).
- **A score is its expected level.** That is TypeSafe's `score` field (00-jev-capabilities.md: `"score":1.05`).
  Bars compare within `1e-9`, so a `1.2` that arrives as `1.2000000000000002` (0.8 + 0.4) still counts as light, and a
  gap of `0.85 − 0.35` (`0.4999…`) still clears 0.5.
- **Gear** = the max of breadth, reasoning and actions: ≤ 1.2 Fast, < 2.5 Default, else Thinking. **Effort** comes
  from reasoning on the same edges (low / medium / high). Gear unarmed → Default with effort `null`.
- **Role** = max(gear role, `ROLE_FLOOR[category]`), using the floors in spec §3's table. `think harder` → Thinking,
  and the effort is kept.
- **The memory and status lanes** need p ≥ 0.85 and p ≥ 0.8 respectively, confidence ≥ 0.7 and p1 − p2 ≥ 0.5 (lane 1's
  floors on both lanes; see Drafter notes). If their own row is unarmed → planner, Default, reason `uncalibrated`,
  with the category recorded.
- **`sets_rule` zones:** yes ≥ 0.8, no ≤ 0.2, unsure in between; unsure counts as no. A save needs `armed.rule` and
  never happens on a bare ack. With `rule` unarmed nothing saves, the memory lane does not act and **the status lane
  does not act** (planner on Default, reason `uncalibrated`): a stated rule is never swallowed by a code reply that
  could not have read it. `save.scope` defaults from the **final** category (`research` → `research`, else `ask`); the
  `rule_scope` answer overrides the default only when its top option is at p ≥ 0.6.
- **Memory** (p ≥ 0.6):
  - p ≥ 0.6 but under its lane bar → planner `below_bar`, and a rule still saves first.
  - Bare ack → `bare_ack_guard`.
  - `sets_rule` not yes → planner `correction`.
  - Otherwise lane `memory`, which saves and ends at the card.
- **Status** clears its bar (and `status` and `rule` are both armed):
  - Bare ack → `bare_ack_guard`.
  - `sets_rule` yes → planner, reason `routed`, saving first. A rule is not "nothing else", so it is not the status
    lane.
  - Otherwise lane `status`.
  - Under its bar but at p ≥ 0.6 → planner `below_bar` (`uncalibrated` when `status` or `rule` is unarmed).
- **Cascade** (top category p < 0.6). Candidates are categories ranked by probability, without `memory` and `status`,
  and only those with p > 0. Ties keep the question's option order, because the sort is stable.
  - Zero candidates → planner, Default, `below_bar`.
  - One candidate → taken without a call: reason `cascade`, `cascade: null`.
  - Two candidates → `{ kind: "cascade", ruleScope }`. `base.save` only marks that a rule saves; its scope is not
    final until a category is picked.
  - `applyCascade` (F5): a pick outside `between`, or `null` → `cascade_failed`, Default, `cascade: "tiny"`, **nothing
    saved** (spec §2.4: a failure anywhere is the Default planner path). Otherwise the pick's floor applies, the route
    gets `cascade: "tiny"`, and a rule's scope is `ruleScope` when set, else the pick's default (a `research` pick
    saves `research` even when `answer` was Jev's first candidate).
- **Lane limits:** stage A has no `answer` or `lookup` lane, and memory and status have no limits (spec §3), so no
  stage A route carries `lane_limits`. The reason stays in the union for stage B.
- **`preJudge`.** A bare ack (`isBareAck`) or a greeting from the list (`谢谢`, `thanks`, `thank you`, `hi`, `你好`;
  trimmed, trailing punctuation dropped, case-folded) → `ack_answer`, but only when `lastHougeTurn.kind === "answer"`
  and the message quotes nothing. Otherwise `judge`, with `thinkHarder` = `/think harder|认真想|ultrathink/i` anywhere
  in the message.

- [ ] **Step 1: Write the failing test** — `tests/jev/tree-policy.test.ts`

```ts
import { describe, expect, it } from "vitest";
import type { CalibrationRow } from "../../src/jev/calibration.js";
import { JEV_REQUEST_MODEL, type JevAnswer, type JevChoiceAnswer } from "../../src/jev/jev-client.js";
import { CATEGORIES, TREE_CATEGORY, TREE_QUESTIONS, type Category, type LastHougeTurn } from "../../src/jev/questions/tree.js";
import { criteriaHash } from "../../src/jev/questions/types.js";
import {
  ACK_ROUTE, applyCascade, fallbackRoute, preJudge, routeTree, thinkHarderIn, TREE_BAR_DEFAULTS, TREE_STATUS_ARM_ID, treeArmed,
  treeArmingRows, type Armed, type Route, type RoutePlan
} from "../../src/jev/tree-policy.js";

/** The versioned id a Jev response reports. Calibration keys on it; the request names the moving alias (JEV_REQUEST_MODEL). */
const REPORTED = "jev-1.13.0";

// Spec §2.4 / §9 "Policy as a table": answers → lane, role, effort. Every bar is tested at its edge because a wrong
// side of a bar either swallows a turn into a no-planner lane (memory / status) or under-powers a turn that changes
// the machine. A test that still passed with a bar moved by 0.01 would prove nothing.
const n = CATEGORIES.length;
/** A category answer: the given probabilities, the rest split evenly; confidence by Jev's documented formula unless given. */
function cat(p: Partial<Record<Category, number>>, confidence?: number): JevChoiceAnswer {
  const used = Object.values(p).reduce((a, b) => a + (b ?? 0), 0);
  const rest = CATEGORIES.filter((c) => p[c] === undefined);
  const probabilities = Object.fromEntries(CATEGORIES.map((c) => [c, p[c] ?? (1 - used) / rest.length]));
  const [choice, pMax] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]!;
  return { type: "choice", choice, probabilities, confidence: confidence ?? (pMax - 1 / n) / (1 - 1 / n) };
}
/** Exactly these probabilities, every other category 0 (for the cascade's zero / one candidate cases). */
const only = (p: Partial<Record<Category, number>>): JevChoiceAnswer => cat(Object.fromEntries(CATEGORIES.map((c) => [c, p[c] ?? 0])));
const scope = (ask: number): JevChoiceAnswer =>
  ({ type: "choice", choice: ask >= 0.5 ? "ask" : "research", probabilities: { ask, research: 1 - ask }, confidence: Math.abs(2 * ask - 1) });
const score = (s: number): JevAnswer => ({ type: "score", score: s, probabilities: { "0": 0.25, "1": 0.25, "2": 0.25, "3": 0.25 }, confidence: 0.5 });
const noul = (p: number): JevAnswer => ({ type: "noul", noul: p });
interface A { category: JevChoiceAnswer; sets_rule?: number; ask?: number; breadth?: number; reasoning?: number; actions?: number }
const answers = (a: A): Record<string, JevAnswer> => ({
  category: a.category, sets_rule: noul(a.sets_rule ?? 0.05), rule_scope: scope(a.ask ?? 0.9),
  breadth: score(a.breadth ?? 1), reasoning: score(a.reasoning ?? 1), actions: score(a.actions ?? 0)
});
const ALL: Armed = { category: true, status: true, memory: true, gear: true, rule: true };
type Opts = Partial<{ armed: Partial<Armed>; thinkHarder: boolean; bareAck: boolean }>;
const plan = (a: A, o: Opts = {}): RoutePlan =>
  routeTree(answers(a), { bars: TREE_BAR_DEFAULTS, armed: { ...ALL, ...o.armed }, thinkHarder: o.thinkHarder ?? false, bareAck: o.bareAck ?? false });
const route = (a: A, o: Opts = {}): Route => {
  const p = plan(a, o);
  if (p.kind !== "final") throw new Error(`expected a final route, got a cascade between ${p.between.join("/")}`);
  return p.route;
};

describe("TREE_BAR_DEFAULTS (spec §2.4)", () => {
  it("are the spec's numbers", () => {
    expect(TREE_BAR_DEFAULTS).toEqual({ choice: 0.6, nounYes: 0.8, nounNo: 0.2, memory: 0.85, status: 0.8, minConf: 0.7, minGap: 0.5,
      ruleScope: 0.6, gearLight: 1.2, gearHeavy: 2.5 });
  });
});

describe("routeTree — gear and effort (the routed role is the visible change of stage A)", () => {
  it.each([
    ["1.2 is light", 1.2, "fast"],
    ["0.8 + 0.4 (1.2000000000000002 in floating point) is still light", 0.8 + 0.4, "fast"],
    ["1.21 is standard", 1.21, "default"],
    ["2.49 is standard", 2.49, "default"],
    ["2.5 is heavy", 2.5, "thinking"]
  ] as const)("max score: %s", (_name, s, role) => {
    expect(route({ category: cat({ answer: 0.9 }), breadth: s, reasoning: 0, actions: 0 }).role).toBe(role);
  });
  it("the gear is the HIGHEST of the three scores, not the reasoning score", () => {
    expect(route({ category: cat({ answer: 0.9 }), breadth: 0, reasoning: 0, actions: 2.6 })).toMatchObject({ role: "thinking", effort: "low" });
  });
  it.each([[1.2, "low"], [1.21, "medium"], [2.49, "medium"], [2.5, "high"]] as const)("effort: reasoning %s → %s", (r, effort) => {
    expect(route({ category: cat({ answer: 0.9 }), breadth: 0, reasoning: r, actions: 0 }).effort).toBe(effort);
  });
  it("gear unarmed: Default with no effort (the list's own effort applies)", () => {
    expect(route({ category: cat({ answer: 0.9 }), breadth: 3 }, { armed: { gear: false } })).toMatchObject({ role: "default", effort: null, reason: "routed" });
  });
  it("think harder: Thinking whatever the gear, the effort reading kept", () => {
    expect(route({ category: cat({ answer: 0.9 }), breadth: 0, reasoning: 0 }, { thinkHarder: true })).toMatchObject({ role: "thinking", effort: "low", thinkHarder: true });
  });
});

describe("routeTree — role floors (spec §3: self_change / machine_task / schedule / mail_calendar never below Default)", () => {
  it.each([
    ["answer", "fast"], ["lookup", "fast"], ["research", "thinking"], ["self_change", "default"], ["machine_task", "default"],
    ["schedule", "default"], ["wiki", "default"], ["mail_calendar", "default"], ["other", "default"]
  ] as const)("%s on a light gear runs on %s", (c, role) => {
    expect(route({ category: cat({ [c]: 0.9 }), breadth: 0, reasoning: 0, actions: 0 })).toMatchObject({ category: c, lane: "planner", role, reason: "routed" });
  });
  it("a heavy gear lifts a Fast-floor category", () => {
    expect(route({ category: cat({ lookup: 0.9 }), breadth: 2.7 }).role).toBe("thinking");
  });
});

describe("routeTree — the choice bar", () => {
  it("p 0.6 counts", () => {
    expect(route({ category: cat({ self_change: 0.6 }) })).toMatchObject({ category: "self_change", reason: "routed", role: "default" });
  });
  it("p 0.59 goes to the cascade between the top two", () => {
    // the rest split evenly: ties keep option order, so "answer" (first in CATEGORIES) is the runner-up
    expect(plan({ category: cat({ self_change: 0.59 }) })).toMatchObject({ kind: "cascade", between: ["self_change", "answer"] });
  });
});

describe("routeTree — memory (a wrong `memory` swallows the turn: the strictest bars)", () => {
  const raw = (p: Partial<Record<Category, number>>, confidence: number): JevChoiceAnswer =>
    ({ type: "choice", choice: "memory", probabilities: Object.fromEntries(CATEGORIES.map((c) => [c, p[c] ?? 0])), confidence });
  it.each([
    ["p 0.85 + sets_rule 0.8: the memory lane saves and ends at the card", { category: cat({ memory: 0.85 }), sets_rule: 0.8 },
      { category: "memory", lane: "memory", save: { scope: "ask" }, reason: "routed" }],
    ["p 0.84 + a rule: planner below_bar, the rule still saves first", { category: cat({ memory: 0.84 }), sets_rule: 0.8 },
      { lane: "planner", role: "default", effort: null, save: { scope: "ask" }, reason: "below_bar" }],
    ["sets_rule 0.79 is unsure = no: a correction for the planner, nothing saved", { category: cat({ memory: 0.9 }), sets_rule: 0.79 },
      { lane: "planner", role: "default", effort: null, save: null, reason: "correction" }],
    ["sets_rule 0.21 is unsure: a correction", { category: cat({ memory: 0.9 }), sets_rule: 0.21 }, { save: null, reason: "correction" }],
    ["sets_rule 0.2 is no: a correction", { category: cat({ memory: 0.9 }), sets_rule: 0.2 }, { save: null, reason: "correction" }],
    ["confidence 0.69 is under the floor", { category: cat({ memory: 0.9 }, 0.69), sets_rule: 0.9 }, { lane: "planner", reason: "below_bar" }],
    ["confidence 0.7 clears", { category: cat({ memory: 0.9 }, 0.7), sets_rule: 0.9 }, { lane: "memory" }],
    // Jev's probabilities sum to 1, so at p ≥ 0.85 the gap floor cannot bind; it is defensive and still enforced
    ["gap 0.49 (an unnormalised answer) is under the floor", { category: raw({ memory: 0.85, other: 0.36 }, 0.9), sets_rule: 0.9 }, { reason: "below_bar" }],
    ["gap 0.85 − 0.35 (0.4999… in floating point) clears", { category: raw({ memory: 0.85, other: 0.35 }, 0.9), sets_rule: 0.9 }, { lane: "memory" }]
  ] as const)("%s", (_name, a, expected) => {
    expect(route(a as A)).toMatchObject(expected);
  });
  it("memory unarmed: planner, Default, uncalibrated, nothing saved", () => {
    expect(route({ category: cat({ memory: 0.95 }), sets_rule: 0.95 }, { armed: { memory: false } }))
      .toMatchObject({ category: "memory", lane: "planner", role: "default", save: null, reason: "uncalibrated" });
  });
  it("rule unarmed: the memory lane never acts, even on a hand-built Armed that says memory", () => {
    // the lane exists to save a rule; without the rule rows it would save on an answer nobody calibrated
    expect(route({ category: cat({ memory: 0.95 }), sets_rule: 0.95 }, { armed: { rule: false } }))
      .toMatchObject({ category: "memory", lane: "planner", save: null, reason: "uncalibrated" });
  });
});

describe("routeTree — sets_rule with any category (save, then that category's handler)", () => {
  it("a rule on a lookup saves first and the planner runs on the lookup's role", () => {
    expect(route({ category: cat({ lookup: 0.9 }), sets_rule: 0.95, breadth: 0, reasoning: 0 }))
      .toMatchObject({ category: "lookup", lane: "planner", role: "fast", save: { scope: "ask" }, reason: "routed" });
  });
  it("unsure saves nothing", () => {
    expect(route({ category: cat({ lookup: 0.9 }), sets_rule: 0.5 }).save).toBeNull();
  });
  it("rule rows unarmed: the turn still routes, nothing saves (an unread answer is never acted on)", () => {
    expect(route({ category: cat({ lookup: 0.9 }), sets_rule: 0.95, breadth: 0, reasoning: 0 }, { armed: { rule: false, memory: false } }))
      .toMatchObject({ category: "lookup", role: "fast", save: null, reason: "routed" });
  });
  it.each([
    ["memory, rule_scope research 0.6 overrides the default ask", { category: cat({ memory: 0.9 }), sets_rule: 0.9, ask: 0.4 }, "research"],
    ["memory, research 0.59 is under the bar: the default ask", { category: cat({ memory: 0.9 }), sets_rule: 0.9, ask: 0.41 }, "ask"],
    ["research, ask 0.59 is under the bar: the default research", { category: cat({ research: 0.9 }), sets_rule: 0.9, ask: 0.59 }, "research"],
    ["research, ask 0.6 overrides the default research", { category: cat({ research: 0.9 }), sets_rule: 0.9, ask: 0.6 }, "ask"]
  ] as const)("rule_scope: %s", (_name, a, s) => {
    expect(route(a as A).save).toEqual({ scope: s });
  });
});

describe("routeTree — status (its own arming row; a wrong status swallows the turn)", () => {
  it("p 0.8 → the status lane", () => {
    expect(route({ category: cat({ status: 0.8 }) })).toMatchObject({ category: "status", lane: "status", reason: "routed", save: null });
  });
  it("p 0.79 → planner below_bar", () => {
    expect(route({ category: cat({ status: 0.79 }) })).toMatchObject({ category: "status", lane: "planner", role: "default", reason: "below_bar" });
  });
  it("status row unarmed, category armed: planner uncalibrated", () => {
    expect(route({ category: cat({ status: 0.9 }) }, { armed: { status: false } })).toMatchObject({ lane: "planner", reason: "uncalibrated" });
  });
  it("status + rule armed, category and gear unarmed: the lane acts; under its bar it is the plain fallback", () => {
    const statusOnly = { armed: { category: false, memory: false, gear: false } };
    expect(route({ category: cat({ status: 0.8 }) }, statusOnly).lane).toBe("status");
    expect(route({ category: cat({ status: 0.79 }) }, statusOnly)).toEqual(fallbackRoute("uncalibrated", false));
  });
  it("status armed but the rule rows not: the lane does NOT act (a stated rule would be swallowed by a code reply)", () => {
    // F6: sets_rule = yes with any category saves (spec §3); unarmed, we cannot read it, so the planner answers
    expect(route({ category: cat({ status: 0.95 }), sets_rule: 0.95 }, { armed: { rule: false, memory: false } }))
      .toMatchObject({ category: "status", lane: "planner", role: "default", save: null, reason: "uncalibrated" });
    expect(route({ category: cat({ status: 0.95 }) }, { armed: { rule: false, memory: false, category: false } }))
      .toEqual(fallbackRoute("uncalibrated", false));
  });
  it("a rule inside a status question saves and goes to the planner (the lane answers status and nothing else)", () => {
    expect(route({ category: cat({ status: 0.9 }), sets_rule: 0.9 })).toMatchObject({ category: "status", lane: "planner", save: { scope: "ask" }, reason: "routed" });
  });
  it("status under the choice bar cascades without status", () => {
    expect(plan({ category: cat({ status: 0.5, lookup: 0.3 }) })).toMatchObject({ kind: "cascade", between: ["lookup", "answer"] });
  });
});

describe("routeTree — the bare-ack guard (an ack never enters memory or status)", () => {
  it.each([
    ["memory with a rule", { category: cat({ memory: 0.95 }), sets_rule: 0.95 }],
    ["status", { category: cat({ status: 0.95 }) }]
  ] as const)("%s → planner bare_ack_guard, nothing saved", (_n, a) => {
    expect(route(a as A, { bareAck: true })).toMatchObject({ lane: "planner", role: "default", save: null, reason: "bare_ack_guard" });
  });
  it("an ack on a non-lane category is routed but never saves", () => {
    expect(route({ category: cat({ lookup: 0.9 }), sets_rule: 0.95 }, { bareAck: true })).toMatchObject({ reason: "routed", save: null });
  });
});

describe("routeTree — unarmed and malformed", () => {
  it("category and status unarmed: the Default fallback, no category", () => {
    expect(route({ category: cat({ answer: 0.9 }) }, { armed: { category: false, status: false } })).toEqual(fallbackRoute("uncalibrated", false));
  });
  it("no category answer: the Default fallback", () => {
    expect(routeTree({}, { bars: TREE_BAR_DEFAULTS, armed: ALL, thinkHarder: true, bareAck: false })).toEqual({ kind: "final", route: fallbackRoute("uncalibrated", true) });
  });
});

describe("routeTree / applyCascade — the cascade (a model guess never routes into a no-planner lane)", () => {
  it("memory and status removed, one left: taken without a call", () => {
    expect(route({ category: only({ memory: 0.5, status: 0.3, lookup: 0.2 }), breadth: 0, reasoning: 0 }))
      .toMatchObject({ category: "lookup", role: "fast", reason: "cascade", cascade: null });
  });
  it("memory and status removed, none left: planner, Default, below_bar", () => {
    expect(route({ category: only({ memory: 0.55, status: 0.45 }) })).toMatchObject({ category: null, lane: "planner", role: "default", effort: null, reason: "below_bar" });
  });
  it("two left: a cascade between Jev's top two, carrying the confident rule_scope", () => {
    expect(plan({ category: cat({ lookup: 0.5, research: 0.3 }), sets_rule: 0.9, ask: 0.9 }))
      .toMatchObject({ kind: "cascade", between: ["lookup", "research"], ruleScope: "ask", base: { category: null, reason: "cascade", cascade: null } });
    expect(plan({ category: cat({ lookup: 0.5, research: 0.3 }), sets_rule: 0.9, ask: 0.5 })).toMatchObject({ kind: "cascade", ruleScope: null });
  });
  const cascade = (o: Opts = {}) => {
    const p = plan({ category: cat({ lookup: 0.5, research: 0.3 }), breadth: 0, reasoning: 0 }, o);
    if (p.kind !== "cascade") throw new Error("expected a cascade");
    return p;
  };
  it("a pick applies its own floor and marks cascade tiny", () => {
    expect(applyCascade(cascade(), "research")).toMatchObject({ category: "research", role: "thinking", reason: "cascade", cascade: "tiny" });
    expect(applyCascade(cascade(), "lookup")).toMatchObject({ category: "lookup", role: "fast" });
    expect(applyCascade(cascade({ thinkHarder: true }), "lookup").role).toBe("thinking");
  });
  const withRule = (ask: number) => {
    const p = plan({ category: cat({ lookup: 0.5, research: 0.3 }), sets_rule: 0.9, ask }, {});
    if (p.kind !== "cascade") throw new Error("expected a cascade");
    return p;
  };
  it("no pick, or a pick outside the two: planner Default, cascade_failed, NOTHING saved (F5)", () => {
    // spec §2.4: a failure anywhere is the Default planner path; a confident sets_rule must not save on a failed pick
    expect(applyCascade(cascade(), null)).toEqual({ ...fallbackRoute("cascade_failed", false), cascade: "tiny" });
    expect(applyCascade(cascade(), "memory")).toMatchObject({ reason: "cascade_failed", lane: "planner" });
    expect(applyCascade(withRule(0.9), null).save).toBeNull();
    expect(applyCascade(withRule(0.9), "memory").save).toBeNull();
  });
  it("the rule's scope follows the PICKED category, not Jev's first candidate (F5, spec §2.3)", () => {
    // rule_scope at 0.5 is under its bar, so the category default decides: research → research, lookup → ask
    expect(applyCascade(withRule(0.5), "research").save).toEqual({ scope: "research" });
    expect(applyCascade(withRule(0.5), "lookup").save).toEqual({ scope: "ask" });
  });
  it("a confident rule_scope (p ≥ 0.6) still overrides the picked category's default", () => {
    expect(applyCascade(withRule(0.9), "research").save).toEqual({ scope: "ask" });
    expect(applyCascade(withRule(0.4), "lookup").save).toEqual({ scope: "research" });
  });
});

describe("preJudge (spec §2.1: code before the judge)", () => {
  const answer: LastHougeTurn = { kind: "answer", age_s: 30 };
  it.each([
    ["谢谢", answer, false, { kind: "ack_answer" }],
    ["Thanks!", answer, false, { kind: "ack_answer" }],
    ["ok.", answer, false, { kind: "ack_answer" }],
    ["你好", answer, false, { kind: "ack_answer" }],
    ["谢谢", { kind: "proposal", age_s: 30 }, false, { kind: "judge", thinkHarder: false }],
    ["好", { kind: "clarify", age_s: 30 }, false, { kind: "judge", thinkHarder: false }],
    ["好", null, false, { kind: "judge", thinkHarder: false }],
    ["好", answer, true, { kind: "judge", thinkHarder: false }],
    ["thanks for the list, now the prices?", answer, false, { kind: "judge", thinkHarder: false }],
    ["Think Harder about the trip plan", answer, false, { kind: "judge", thinkHarder: true }],
    ["ultrathink: 明天天气怎么样", null, false, { kind: "judge", thinkHarder: true }],
    ["请认真想想这个问题", null, false, { kind: "judge", thinkHarder: true }]
  ] as const)("%j after %j (quoted %s)", (text, last, quoted, expected) => {
    expect(preJudge({ text, lastHougeTurn: last as LastHougeTurn, quoted })).toEqual(expected);
  });
  it("thinkHarderIn is the same token rule", () => {
    expect(thinkHarderIn("THINK HARDER")).toBe(true);
    expect(thinkHarderIn("think about it")).toBe(false);
  });
  it("ACK_ROUTE is answer on Fast, low effort, reason ack_rule", () => {
    expect(ACK_ROUTE).toEqual({ category: "answer", lane: "planner", role: "fast", effort: "low", save: null, reason: "ack_rule", cascade: null, thinkHarder: false });
  });
});

describe("treeArmed (each decision arms on its own evidence)", () => {
  const row = (question_id: string, criteria_hash: string, lang: "zh" | "en" = "zh", model = REPORTED): CalibrationRow =>
    ({ question_id, criteria_hash, model, lang, approved: "test", evidence: "test" });
  const all = [...TREE_QUESTIONS.map((q) => row(q.id, criteriaHash(q))), row(TREE_STATUS_ARM_ID, criteriaHash(TREE_CATEGORY))];
  const NONE: Armed = { category: false, status: false, memory: false, gear: false, rule: false };
  it("every row → all armed; mixed inherits zh", () => {
    expect(treeArmed("zh", REPORTED, all)).toEqual({ category: true, status: true, memory: true, gear: true, rule: true });
    expect(treeArmed("mixed", REPORTED, all)).toEqual({ category: true, status: true, memory: true, gear: true, rule: true });
  });
  it("the status pseudo-row arms status only; the category row never arms status", () => {
    expect(treeArmed("zh", REPORTED, [row(TREE_STATUS_ARM_ID, criteriaHash(TREE_CATEGORY))])).toEqual({ ...NONE, status: true });
    expect(treeArmed("zh", REPORTED, all.filter((r) => r.question_id !== TREE_STATUS_ARM_ID)).status).toBe(false);
  });
  it("rule arms on the sets_rule + rule_scope rows alone, without the category row (F6)", () => {
    const ruleRows = TREE_QUESTIONS.filter((q) => q.id === "sets_rule" || q.id === "rule_scope").map((q) => row(q.id, criteriaHash(q)));
    expect(treeArmed("zh", REPORTED, ruleRows)).toEqual({ ...NONE, rule: true });
    expect(treeArmed("zh", REPORTED, all.filter((r) => r.question_id !== "rule_scope")).rule).toBe(false);
  });
  it("memory needs category AND rule; gear needs all three scores", () => {
    expect(treeArmed("zh", REPORTED, all.filter((r) => r.question_id !== "rule_scope")).memory).toBe(false);
    expect(treeArmed("zh", REPORTED, all.filter((r) => r.question_id !== "category")).memory).toBe(false);
    expect(treeArmed("zh", REPORTED, all.filter((r) => r.question_id !== "actions")).gear).toBe(false);
  });
  it("another model, another language, or a stale hash arms nothing", () => {
    expect(treeArmed("zh", "jev-1.14.0", all)).toEqual(NONE);
    expect(treeArmed("en", REPORTED, all)).toEqual(NONE);
    expect(treeArmed("zh", REPORTED, [row("category", "deadbeef")]).category).toBe(false);
  });
  it("rows naming the request alias never arm (they would stay armed across an alias move)", () => {
    expect(treeArmed("zh", JEV_REQUEST_MODEL, all.map((r) => ({ ...r, model: JEV_REQUEST_MODEL })))).toEqual(NONE);
  });
  it("treeArmingRows keeps only a current tree row or the status pseudo-row at its current hash (the alias-move page reads these)", () => {
    const retired = [row("category", "deadbeef"), row("lane", "0123abcd"), row("lane:status", "0123abcd"), row(TREE_STATUS_ARM_ID, "deadbeef")];
    expect(treeArmingRows([...retired, ...all])).toEqual(all);
    expect(treeArmingRows(retired)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/jev/tree-policy.test.ts`
Expected: FAIL with `Failed to resolve import "../../src/jev/tree-policy.js"`.

- [ ] **Step 3: Implement** — `src/jev/tree-policy.ts`

```ts
import { isBareAck } from "../omp/bare-ack.js";
import { calibratedLang, type CalibrationRow } from "./calibration.js";
import type { Lang } from "./intent-question.js";
import type { JevAnswer, JevChoiceAnswer } from "./jev-client.js";
import {
  CATEGORIES, TREE_ACTIONS, TREE_BREADTH, TREE_CATEGORY, TREE_QUESTIONS, TREE_REASONING, TREE_RULE_SCOPE, TREE_SETS_RULE, type Category,
  type LastHougeTurn
} from "./questions/tree.js";
import { criteriaHash, type Question } from "./questions/types.js";

/**
 * The tree's routing policy (spec §2.4): Jev's probabilities in, a lane and a model role out. Pure: code owns every bar
 * (ADR 0013); Jev never applies one and never produces allow/deny, which is why this lives in src/jev/, not src/policy/.
 */
export type TurnRole = "fast" | "default" | "thinking";
export type Effort = "low" | "medium" | "high";
export type Lane = "memory" | "status" | "planner";
export type PreJudge = { kind: "ack_answer" } | { kind: "judge"; thinkHarder: boolean };

/** Bump when a bar or a routing rule changes; stamped on every decision row's threshold_used. */
export const TREE_THRESHOLD_VERSION = "2026-10-07.1";

const GREETINGS: ReadonlySet<string> = new Set(["谢谢", "thanks", "thank you", "hi", "你好"]);
const TRAILING = /[。！!.~～\s]+$/u;
const THINK_HARDER = /think harder|认真想|ultrathink/i;

/** `think harder` / `认真想` / `ultrathink` anywhere in the message (spec §2.1). */
export function thinkHarderIn(text: string): boolean {
  return THINK_HARDER.test(text);
}

/** Spec §2.1: an ack or greeting right after a plain answer, quoting nothing, is settled by code (no Jev call). */
export function preJudge(i: { text: string; lastHougeTurn: LastHougeTurn; quoted: boolean }): PreJudge {
  const ack = isBareAck(i.text) || GREETINGS.has(i.text.trim().replace(TRAILING, "").toLowerCase());
  if (ack && !i.quoted && i.lastHougeTurn?.kind === "answer") return { kind: "ack_answer" };
  return { kind: "judge", thinkHarder: thinkHarderIn(i.text) };
}

export interface TreeBars { choice: number; nounYes: number; nounNo: number; memory: number; status: number; minConf: number;
  minGap: number; ruleScope: number; gearLight: number; gearHeavy: number }
export const TREE_BAR_DEFAULTS: TreeBars = { choice: 0.6, nounYes: 0.8, nounNo: 0.2, memory: 0.85, status: 0.8, minConf: 0.7, minGap: 0.5,
  ruleScope: 0.6, gearLight: 1.2, gearHeavy: 2.5 };

export interface Armed { category: boolean; status: boolean; memory: boolean; gear: boolean; rule: boolean }
/** The status lane's own arming key: the category question's hash under a distinct id, so a `category` row never arms status. */
export const TREE_STATUS_ARM_ID = "category:status";

/**
 * Each decision arms on its own rows (lessons.md 2026-10-06): `rule` on sets_rule + rule_scope, gear on its three
 * scores; the memory lane needs category AND rule. The status lane also needs `rule` at route time (statusBranch).
 */
export function treeArmed(lang: Lang, model: string, rows: readonly CalibrationRow[]): Armed {
  const on = (qs: readonly Question[]): boolean => qs.every((q) => calibratedLang(q.id, criteriaHash(q), model, lang, rows) !== undefined);
  const category = on([TREE_CATEGORY]);
  const rule = on([TREE_SETS_RULE, TREE_RULE_SCOPE]);
  return {
    category,
    status: calibratedLang(TREE_STATUS_ARM_ID, criteriaHash(TREE_CATEGORY), model, lang, rows) !== undefined,
    memory: category && rule,
    gear: on([TREE_BREADTH, TREE_REASONING, TREE_ACTIONS]),
    rule
  };
}

/**
 * The rows that can arm a tree decision today: a tree question, or the status pseudo-row, at its current criteria hash.
 * The alias-move page (`checkJevModelCalibrated`, jev-incidents.ts) reads only these, so a retired lane 1 row or a
 * stale-hash row neither raises nor clears it (it replaces lane 1's `armingRows`, which Task 12 deletes with thresholds.ts).
 */
export function treeArmingRows(rows: readonly CalibrationRow[]): CalibrationRow[] {
  const live = new Set(TREE_QUESTIONS.map((q) => `${q.id}\u0000${criteriaHash(q)}`));
  live.add(`${TREE_STATUS_ARM_ID}\u0000${criteriaHash(TREE_CATEGORY)}`);
  return rows.filter((r) => live.has(`${r.question_id}\u0000${r.criteria_hash}`));
}

/** `lane_limits` has no writer in stage A (memory and status have no limits, spec §3); it is kept for stage B. */
export type RouteReason = "routed" | "uncalibrated" | "below_bar" | "bare_ack_guard" | "lane_limits" | "correction"
  | "cascade" | "cascade_failed" | "ack_rule" | "jev_skipped";
export type RuleScope = "ask" | "research";
export interface Route { category: Category | null; lane: Lane; role: TurnRole; effort: Effort | null;
  save: { scope: RuleScope } | null; reason: RouteReason; cascade: "tiny" | null; thinkHarder: boolean }
/** `ruleScope`: the confident rule_scope override (null = the picked category's default), applied by applyCascade. */
export type RoutePlan = { kind: "final"; route: Route }
  | { kind: "cascade"; between: readonly [Category, Category]; base: Route; ruleScope: RuleScope | null };

/** Spec §3's role floor per category; null for the two lanes that do not run the planner. */
export const ROLE_FLOOR: Readonly<Record<Category, TurnRole | null>> = {
  answer: "fast", lookup: "fast", research: "thinking", memory: null, self_change: "default", machine_task: "default",
  schedule: "default", wiki: "default", mail_calendar: "default", status: null, other: "default"
};

/** Any failure, skip or unarmed question (spec §2.4): the planner on the Default role as resolved, the list's effort. */
export function fallbackRoute(reason: RouteReason, thinkHarder: boolean): Route {
  return { category: null, lane: "planner", role: thinkHarder ? "thinking" : "default", effort: null, save: null, reason, cascade: null, thinkHarder };
}

/** Spec §2.1: an acknowledgement of a plain answer is `answer` on the Fast role. */
export const ACK_ROUTE: Route = { category: "answer", lane: "planner", role: "fast", effort: "low", save: null, reason: "ack_rule", cascade: null, thinkHarder: false };

/** Probabilities and expected levels arrive as floats (0.85 − 0.35 = 0.4999…); a bar compares within this tolerance. */
const EPS = 1e-9;
const atLeast = (x: number, bar: number): boolean => x + EPS >= bar;
const atMost = (x: number, bar: number): boolean => x - EPS <= bar;
const RANK: Readonly<Record<TurnRole, number>> = { fast: 0, default: 1, thinking: 2 };
const higher = (a: TurnRole, b: TurnRole | null): TurnRole => (b !== null && RANK[b] > RANK[a] ? b : a);
const isCategory = (c: string): c is Category => (CATEGORIES as readonly string[]).includes(c);
const choiceOf = (a: JevAnswer | undefined): JevChoiceAnswer | null => (a?.type === "choice" ? a : null);
const scoreOf = (a: JevAnswer | undefined): number | null => (a?.type === "score" ? a.score : null);
const noulOf = (a: JevAnswer | undefined): number | null => (a?.type === "noul" ? a.noul : null);
/** High → low; a stable sort, so ties keep the question's option order. */
const ranked = (a: JevChoiceAnswer): Array<[string, number]> => Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]);
const final = (route: Route): RoutePlan => ({ kind: "final", route });
const NO_OPTION: [string, number] = ["", 0];

type Gear = { role: TurnRole; effort: Effort | null };
type Zone = "yes" | "no" | "unsure";
type RouteOpts = { bars: TreeBars; armed: Armed; thinkHarder: boolean; bareAck: boolean };
interface Ctx { cat: JevChoiceAnswer; top: Category; p: number; gear: Gear; zone: Zone; scope: RuleScope | null; o: RouteOpts }
const DEFAULT_GEAR: Gear = { role: "default", effort: null };

function levelOf<T>(x: number, bars: TreeBars, light: T, standard: T, heavy: T): T {
  return atMost(x, bars.gearLight) ? light : atLeast(x, bars.gearHeavy) ? heavy : standard;
}

/** Gear = the highest of the three expected levels; effort from `reasoning` on the same edges (spec §2.4). */
function gearOf(answers: Record<string, JevAnswer>, bars: TreeBars, armed: boolean): Gear {
  const [breadth, reasoning, actions] = [answers.breadth, answers.reasoning, answers.actions].map(scoreOf);
  if (!armed || breadth == null || reasoning == null || actions == null) return DEFAULT_GEAR;
  return { role: levelOf<TurnRole>(Math.max(breadth, reasoning, actions), bars, "fast", "default", "thinking"),
    effort: levelOf<Effort>(reasoning, bars, "low", "medium", "high") };
}

function zoneOf(p: number | null, bars: TreeBars): Zone {
  if (p === null) return "unsure";
  return atLeast(p, bars.nounYes) ? "yes" : atMost(p, bars.nounNo) ? "no" : "unsure";
}

/** `rule_scope`'s top option when it clears its bar (spec §2.4); null = the final category's default decides. */
function confidentScope(a: JevChoiceAnswer | null, bars: TreeBars): RuleScope | null {
  const [opt, p] = (a ? ranked(a)[0] : undefined) ?? NO_OPTION;
  return (opt === "ask" || opt === "research") && atLeast(p, bars.ruleScope) ? opt : null;
}

/** Spec §2.3: the default scope follows the FINAL category (research → research, else ask). */
const scopeFor = (override: RuleScope | null, category: Category | null): RuleScope =>
  override ?? (category === "research" ? "research" : "ask");

/** A rule saves only when `sets_rule` is yes (zone is "no" while the rule rows are unarmed or on a bare ack). */
function saveFor(t: Ctx, category: Category | null): Route["save"] {
  return t.zone === "yes" ? { scope: scopeFor(t.scope, category) } : null;
}

function plannerRoute(category: Category | null, g: Gear, save: Route["save"], reason: RouteReason, thinkHarder: boolean): Route {
  const role = thinkHarder ? "thinking" : category ? higher(g.role, ROLE_FLOOR[category]) : g.role;
  return { category, lane: "planner", role, effort: g.effort, save, reason, cascade: null, thinkHarder };
}

/** A no-planner lane's bar: its own p, lane 1's confidence floor and the p1 − p2 gap floor. */
function clearsLane(t: Ctx, bar: number): boolean {
  const second = ranked(t.cat)[1]?.[1] ?? 0;
  return atLeast(t.p, bar) && atLeast(t.cat.confidence, t.o.bars.minConf) && atLeast(t.p - second, t.o.bars.minGap);
}

/** Below the choice bar: Jev's top two after removing the lanes (a model guess never routes into memory or status). */
function cascadePlan(t: Ctx): RoutePlan {
  const left = ranked(t.cat).filter(([c, p]) => isCategory(c) && c !== "memory" && c !== "status" && p > EPS).map(([c]) => c as Category);
  const [a, b] = left;
  if (a === undefined) return final(plannerRoute(null, DEFAULT_GEAR, saveFor(t, null), "below_bar", t.o.thinkHarder));
  if (b === undefined) return final(plannerRoute(a, t.gear, saveFor(t, a), "cascade", t.o.thinkHarder));
  // base.save only marks that a rule saves; applyCascade fixes its scope from the pick (F5)
  return { kind: "cascade", between: [a, b], base: plannerRoute(null, t.gear, saveFor(t, null), "cascade", t.o.thinkHarder), ruleScope: t.scope };
}

function statusBranch(t: Ctx): RoutePlan {
  const { o } = t;
  // F6: the lane acts only with the rule rows armed too, so a stated rule is never swallowed by a code reply
  const lane = o.armed.status && o.armed.rule;
  const clears = lane && clearsLane(t, o.bars.status);
  if (clears && o.bareAck) return final(plannerRoute("status", DEFAULT_GEAR, null, "bare_ack_guard", o.thinkHarder));
  if (clears && t.zone !== "yes") {
    return final({ category: "status", lane: "status", role: "default", effort: null, save: null, reason: "routed", cascade: null, thinkHarder: o.thinkHarder });
  }
  if (clears) return final(plannerRoute("status", t.gear, saveFor(t, "status"), "routed", o.thinkHarder)); // a rule is not "nothing else"
  if (!o.armed.category) return final(fallbackRoute("uncalibrated", o.thinkHarder));
  if (!atLeast(t.p, o.bars.choice)) return cascadePlan(t);
  return final(plannerRoute("status", DEFAULT_GEAR, saveFor(t, "status"), lane ? "below_bar" : "uncalibrated", o.thinkHarder));
}

/** Memory at p ≥ the choice bar: a new rule is the lane; a correction (sets_rule no/unsure) is the planner's gated path. */
function memoryBranch(t: Ctx): Route {
  const { o } = t;
  if (!o.armed.memory || !o.armed.rule) return plannerRoute("memory", DEFAULT_GEAR, null, "uncalibrated", o.thinkHarder);
  if (!clearsLane(t, o.bars.memory)) return plannerRoute("memory", DEFAULT_GEAR, saveFor(t, "memory"), "below_bar", o.thinkHarder);
  if (o.bareAck) return plannerRoute("memory", DEFAULT_GEAR, null, "bare_ack_guard", o.thinkHarder);
  if (t.zone !== "yes") return plannerRoute("memory", DEFAULT_GEAR, null, "correction", o.thinkHarder);
  return { category: "memory", lane: "memory", role: "default", effort: null, save: saveFor(t, "memory"), reason: "routed", cascade: null, thinkHarder: o.thinkHarder };
}

export function routeTree(answers: Record<string, JevAnswer>, o: RouteOpts): RoutePlan {
  const cat = choiceOf(answers.category);
  const [top, p] = (cat ? ranked(cat)[0] : undefined) ?? NO_OPTION;
  if (!cat || !isCategory(top) || (!o.armed.category && !o.armed.status)) return final(fallbackRoute("uncalibrated", o.thinkHarder));
  const t: Ctx = { cat, top, p, gear: gearOf(answers, o.bars, o.armed.gear), scope: confidentScope(choiceOf(answers.rule_scope), o.bars),
    zone: o.armed.rule && !o.bareAck ? zoneOf(noulOf(answers.sets_rule), o.bars) : "no", o };
  if (top === "status") return statusBranch(t);
  if (!o.armed.category) return final(fallbackRoute("uncalibrated", o.thinkHarder));
  if (!atLeast(p, o.bars.choice)) return cascadePlan(t);
  if (top === "memory") return final(memoryBranch(t));
  return final(plannerRoute(top, t.gear, saveFor(t, top), "routed", o.thinkHarder));
}

/**
 * The cascade's pick (spec §2.4; the live Tiny call is Task 10's, plan Decision 14). A pick outside the two, or none, is
 * the Default fallback with nothing saved (a failure anywhere). A valid pick fixes the rule's scope from the picked category.
 */
export function applyCascade(plan: Extract<RoutePlan, { kind: "cascade" }>, pick: Category | null): Route {
  const b = plan.base;
  if (pick === null || !plan.between.includes(pick)) return { ...fallbackRoute("cascade_failed", b.thinkHarder), cascade: "tiny" };
  const save = b.save ? { scope: scopeFor(plan.ruleScope, pick) } : null;
  return { ...b, category: pick, role: b.thinkHarder ? "thinking" : higher(b.role, ROLE_FLOOR[pick]), save, cascade: "tiny" };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/jev/tree-policy.test.ts && npm run typecheck`
Expected: PASS, every case. Typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/jev/tree-policy.ts tests/jev/tree-policy.test.ts
git commit -m "feat(jev): tree routing policy — bars, guards, gear, rule arming, cascade plan, pre-judge rules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

---

### Task 6: Model roles — code lists (resolved and static), pure resolution, effort clamp, catalog parse and read

**Assembly overrides (binding; orchestrator, 2026-10-07; this block wins where the task text disagrees):**
- Task 9 lands before this task and owns every new ledger type. This task writes none.

**Contract deviation:**
1. `readOmpCatalog(cfg: Pick<OmpConfig, "bin" | "profile" | "envPassthrough">, exec?)`: the contract says
   `Pick<"bin" | "profile">`. Every other omp spawn builds its env from `buildChildEnv(cfg.envPassthrough)`
   (`src/llm/providers/omp.ts:61`, ADR 0015: the main process never hands its env wholesale to a child). The catalog
   read must run under the same env as the seats it resolves for (the `KIMI_CODE_*` passthrough). A full `OmpConfig`
   still satisfies the wider `Pick`, so callers pass `resolveOmpConfig(process.env)` unchanged. **Task 13's gate must
   pass the full config too** (Codex review item 4).
2. `ExecFileAsync` does not exist in the code today. `src/run/exec-file-async.ts:39` exports only the function
   `execFileAsync`, so `model-catalog.ts` exports `export type ExecFileAsync = typeof execFileAsync`.
3. `clampEffort`'s `effort` parameter and `STEP_UP`'s key type use local aliases (`RoutedEffort`, `PlannerRole`). They
   are structurally `Effort` / `TurnRole` (`src/jev/tree-policy.ts`, Task 5). `src/omp/` imports nothing from
   `src/jev/` today, and the structural types let Task 8 pass `Effort` / `TurnRole` values without casts.
4. Extra exports, all used by Task 7: `roleSelectors`, `overrideCandidates`, `isOverrideKey`, `CATALOG_TIMEOUT_MS`.
5. **(F1)** `STATIC_ROLE_LISTS` is a new export. `roleSelectors` takes a third parameter
   `mode: ModelRolesMode = "resolved"`. `staticRoleChains()` and static `resolveRole` read `STATIC_ROLE_LISTS`, not
   `ROLE_LISTS`.

**Files:**
- Create: `src/omp/model-roles.ts`
- Create: `src/omp/model-catalog.ts`
- Create: `tests/fixtures/omp-models.json` (a neutral catalog in `omp models --json` shape; not a live snapshot)
- Create: `tests/helpers/model-roles.ts`
- Test: `tests/omp/model-roles.test.ts`, `tests/omp/model-catalog.test.ts`

**Interfaces:**
- Consumes: `parseModelString`, `ModelString`, `OmpEffort` (`src/omp/model-string.ts:2-23`); `execFileAsync`,
  `ExecFileAsyncOptions` (`src/run/exec-file-async.ts:20-43`); `buildChildEnv` (`src/omp/child-env.ts:20`);
  `daemonTmpRoot` (`src/run/daemon-tmp.ts:29`); `OmpConfig` (type only, `src/omp/omp-config.ts:3`).
- Produces (contract, `src/omp/model-roles.ts`): `RoleName`, `ROLE_NAMES`, `ROLE_LISTS`, `ALLOWED_PROVIDERS`,
  `CHAT_ROLES`, `CatalogModel`, `ModelRolesMode`, `resolveModelRolesMode`, `selectorKey`, `ResolveInput`,
  `resolveRole`, `matchOverride`, `clampEffort`, `STEP_UP`, `RoleChains`, `staticRoleChains`. Plus `STATIC_ROLE_LISTS`,
  `roleSelectors(role, seat?, mode?)`, `overrideCandidates(role, seat, override, catalog)`, `isOverrideKey(k)`.
- Produces (`src/omp/model-catalog.ts`): `parseOmpCatalog(json): CatalogModel[] | null`,
  `readOmpCatalog(cfg, exec?): Promise<CatalogModel[] | null>`, `type ExecFileAsync`, `CATALOG_TIMEOUT_MS`.
- Produces (tests): `CATALOG_FIXTURE`, `fixtureCatalog()` in `tests/helpers/model-roles.ts` (Task 7 appends `pinnedRoles`).

- [ ] **Step 1: Create the fixture and the test helper**

Create `tests/fixtures/omp-models.json`. It is a neutral catalog in omp's `models --json` shape. It is deliberately
**not** either 2026-10-07 snapshot: the live catalog changed between two probes that day. It holds:
- every id in `ROLE_LISTS` (both Antigravity generations), but not `openai-codex/gpt-5.5`, so it lacks a static id just
  as the live catalog does;
- a `google/gemini-3.8-flash` twin and a `moonshot/kimi-k3` twin, which the allow-list must drop;
- an `ollama` id with a `:tag`, which the selector syntax cannot carry;
- a thinking-null model.

Tests that need a generation missing filter this fixture. None read a live snapshot.

Create `tests/fixtures/omp-models.json`:

```json
{
  "models": [
    { "provider": "anthropic", "kind": "chat", "id": "claude-3-haiku-20240307", "selector": "anthropic/claude-3-haiku-20240307", "thinking": null },
    { "provider": "anthropic", "kind": "chat", "id": "claude-opus-5-5", "selector": "anthropic/claude-opus-5-5", "thinking": ["low", "medium", "high", "xhigh", "max"] },
    { "provider": "anthropic", "kind": "chat", "id": "claude-sonnet-5-5", "selector": "anthropic/claude-sonnet-5-5", "thinking": ["low", "medium", "high", "xhigh", "max"] },
    { "provider": "google", "kind": "chat", "id": "gemini-3.8-flash", "selector": "google/gemini-3.8-flash", "thinking": ["low", "medium", "high"] },
    { "provider": "google-antigravity", "kind": "chat", "id": "claude-opus-4-6", "selector": "google-antigravity/claude-opus-4-6", "thinking": ["minimal", "low", "medium", "high"] },
    { "provider": "google-antigravity", "kind": "chat", "id": "claude-opus-5-5", "selector": "google-antigravity/claude-opus-5-5", "thinking": ["low", "medium", "high"] },
    { "provider": "google-antigravity", "kind": "chat", "id": "claude-sonnet-5-5", "selector": "google-antigravity/claude-sonnet-5-5", "thinking": ["low", "medium", "high"] },
    { "provider": "google-antigravity", "kind": "chat", "id": "gemini-3.1-pro", "selector": "google-antigravity/gemini-3.1-pro", "thinking": ["low", "high"] },
    { "provider": "google-antigravity", "kind": "chat", "id": "gemini-3.8-flash", "selector": "google-antigravity/gemini-3.8-flash", "thinking": ["minimal", "low", "medium", "high"] },
    { "provider": "kimi-code", "kind": "chat", "id": "k3", "selector": "kimi-code/k3", "thinking": ["low", "high", "max"] },
    { "provider": "moonshot", "kind": "chat", "id": "kimi-k3", "selector": "moonshot/kimi-k3", "thinking": ["low", "high", "max"] },
    { "provider": "ollama", "kind": "chat", "id": "gemma4:latest", "selector": "ollama/gemma4:latest", "thinking": ["low", "medium", "high", "max"] },
    { "provider": "openai-codex", "kind": "chat", "id": "gpt-6.1-sol", "selector": "openai-codex/gpt-6.1-sol", "thinking": ["low", "medium", "high", "xhigh", "max"] }
  ]
}
```

Create `tests/helpers/model-roles.ts`:

```ts
import { readFileSync } from "node:fs";
import { parseOmpCatalog } from "../../src/omp/model-catalog.js";
import type { CatalogModel } from "../../src/omp/model-roles.js";

/** A neutral `omp --profile houge models --json` catalog (tests/fixtures/omp-models.json): every list id, both Antigravity generations, the twins. */
export const CATALOG_FIXTURE = new URL("../fixtures/omp-models.json", import.meta.url).pathname;

/** The fixture through the real parser, so a test sees exactly what the resolver would. */
export function fixtureCatalog(): CatalogModel[] {
  const c = parseOmpCatalog(readFileSync(CATALOG_FIXTURE, "utf8"));
  if (!c) throw new Error("the catalog fixture did not parse");
  return c;
}
```

- [ ] **Step 2: Write the failing tests**

Create `tests/omp/model-roles.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  ALLOWED_PROVIDERS, CHAT_ROLES, clampEffort, isOverrideKey, matchOverride, resolveModelRolesMode, resolveRole, ROLE_LISTS, ROLE_NAMES,
  roleSelectors, STATIC_ROLE_LISTS, staticRoleChains, STEP_UP, type ResolveInput
} from "../../src/omp/model-roles.js";
import { formatModelString, parseModelString, type ModelString } from "../../src/omp/model-string.js";
import { fixtureCatalog } from "../helpers/model-roles.js";

const NONE: ReadonlySet<string> = new Set();
const resolved = (i: Partial<ResolveInput> & Pick<ResolveInput, "role">): string[] =>
  resolveRole({ catalog: fixtureCatalog(), override: null, refused: NONE, mode: "resolved", ...i }).map(formatModelString);
const f = (l: ModelString[]) => l.map(formatModelString).join(",");

// Spec 2026-10-06 §4: every seat now runs on a role resolved from these lists. A wrong list or a wrong filter routes a
// chat turn to Codex or to a metered provider. Both are hard lines, so the tests pin the lists and each filter.
describe("role lists (code-owned, spec §4)", () => {
  it("every selector parses, sits on an allowed provider, and no chat role names Codex (Codex stays the self-write writer)", () => {
    for (const role of ROLE_NAMES) {
      for (const s of ROLE_LISTS[role]) {
        const m = parseModelString(s);
        expect(ALLOWED_PROVIDERS).toContain(m.provider);
        if (CHAT_ROLES.has(role)) expect(m.provider).not.toBe("openai-codex");
      }
    }
  });

  // Spec §4.3: HOUGE_MODEL_ROLES=static is the rollback switch, so it must be the pre-stage-A model path seat for seat.
  // These are the HOUGE_OMP_* DEFAULTS of src/omp/omp-config.ts:16-22 (main@80e23bb; unchanged since 94e3b4c), copied verbatim; a list edit that
  // touches static fails here. Two residual differences of static are accepted and live in the supervisor, not in these
  // lists (plan Decision 1): the per-child refused set (Q9) and the removed respawn-on-planner[0] rule (Task 8).
  it("static chains are today's seven HOUGE_OMP_* defaults, string for string (the rollback adds and drops no model)", () => {
    const c = staticRoleChains();
    expect(f(c.planner)).toBe("anthropic/claude-opus-5-5:medium,google-antigravity/claude-opus-4-6:medium,kimi-code/k3:low");
    expect(f(c.reader)).toBe("google-antigravity/gemini-3.8-flash:low,kimi-code/k3:low,openai-codex/gpt-5.5:low");
    expect(f(c.media)).toBe("google-antigravity/gemini-3.8-flash:low");
    expect(f(c.ticks)).toBe("kimi-code/k3:low");
    expect(f(c.judges)).toBe("kimi-code/k3,openai-codex/gpt-5.5,google-antigravity/gemini-3.1-pro");
    expect(f(c.chair)).toBe("anthropic/claude-opus-5-5:low");
    expect(f(c.reviewer)).toBe("kimi-code/k3:high,google-antigravity/claude-opus-4-6:medium");
  });

  it("static Fast and Thinking are the Default list: the rollback routes every turn to today's planner chain", () => {
    expect(STATIC_ROLE_LISTS.fast).toEqual(STATIC_ROLE_LISTS.default);
    expect(STATIC_ROLE_LISTS.thinking).toEqual(STATIC_ROLE_LISTS.default);
  });

  it("static lists parse and stay on allowed providers, with no chat role on Codex", () => {
    for (const role of ROLE_NAMES) {
      for (const s of STATIC_ROLE_LISTS[role]) {
        const m = parseModelString(s);
        expect(ALLOWED_PROVIDERS).toContain(m.provider);
        if (CHAT_ROLES.has(role)) expect(m.provider).not.toBe("openai-codex");
      }
    }
  });

  it("Fast, Thinking and Tiny are the Decision 3 lists (Rev 4: no k3 on Fast; gemini-3.8-flash behind k3 on Tiny)", () => {
    expect(ROLE_LISTS.fast).toEqual(["anthropic/claude-sonnet-5-5:low", "google-antigravity/claude-sonnet-5-5:low",
      "google-antigravity/gemini-3.8-flash:low"]);
    expect(ROLE_LISTS.thinking).toEqual(["anthropic/claude-opus-5-5:high", "google-antigravity/claude-opus-5-5:high",
      "google-antigravity/claude-opus-4-6:high", "kimi-code/k3:high"]);
    expect(ROLE_LISTS.tiny).toEqual(["kimi-code/k3:low", "google-antigravity/gemini-3.8-flash:low"]);
  });

  // Paco 2026-10-07: Kimi is not renewed next year. A role whose only leg is k3 would empty the day the catalog drops it
  // (memory ticks and the cascade would then run the static k3 chain and fail), so every multi-seat role keeps another
  // provider. Judges are one selector per seat by design; seat 0 is the named exception (a list edit then).
  it("every role list except the per-seat judges keeps a non-Kimi leg", () => {
    for (const role of ROLE_NAMES.filter((r) => r !== "judges")) {
      expect(ROLE_LISTS[role].some((s) => parseModelString(s).provider !== "kimi-code"), role).toBe(true);
    }
  });

  it("a catalog that lists none of a role's selectors empties it in resolved mode (RoleResolver falls back, Task 7)", () => {
    expect(resolved({ role: "vision", catalog: fixtureCatalog().filter((m) => m.id !== "gemini-3.8-flash") })).toEqual([]);
  });

  it("every list selector is in the fixture catalog, so resolved mode over it returns the lists unchanged", () => {
    for (const role of ROLE_NAMES.filter((r) => r !== "judges")) expect(resolved({ role })).toEqual(ROLE_LISTS[role]);
    ROLE_LISTS.judges.forEach((s, seat) => expect(resolved({ role: "judges", seat })).toEqual([s]));
  });
});

describe("resolveRole — spec §4 steps 1–4", () => {
  it("applies the provider allow-list before matching: a google/ or moonshot/ twin is never a candidate", () => {
    expect(matchOverride("gemini-3.8-flash", "vision", fixtureCatalog()).map((m) => `${m.provider}/${m.id}`)).toEqual(["google-antigravity/gemini-3.8-flash"]);
    expect(resolved({ role: "vision", override: "gemini-3.8-flash" })).toEqual(["google-antigravity/gemini-3.8-flash:low"]);
    expect(matchOverride("kimi-k3", "tiny", fixtureCatalog())).toEqual([]); // moonshot is metered
  });

  it("never routes a chat seat to Codex, while Reader and the judges may use it", () => {
    expect(matchOverride("gpt-6.1", "default", fixtureCatalog())).toEqual([]);
    expect(resolved({ role: "default", override: "gpt-6.1" })).toEqual(ROLE_LISTS.default);
    expect(matchOverride("gpt-6.1", "reader", fixtureCatalog()).map((m) => m.id)).toEqual(["gpt-6.1-sol"]);
  });

  it("puts the override first, then the catalogued list, duplicates dropped; the override takes the list's effort for that model", () => {
    expect(resolved({ role: "thinking", override: "opus-4-6" })).toEqual([
      "google-antigravity/claude-opus-4-6:high", "anthropic/claude-opus-5-5:high", "google-antigravity/claude-opus-5-5:high", "kimi-code/k3:high"
    ]);
    // A pattern matching two providers' models yields both, in catalog order, each with the list's effort for it.
    expect(resolved({ role: "default", override: "opus-5-5" }).slice(0, 2)).toEqual(["anthropic/claude-opus-5-5:medium", "google-antigravity/claude-opus-5-5:medium"]);
    expect(resolved({ role: "vision", override: "GEMINI-3.1-PRO" })).toEqual(["google-antigravity/gemini-3.1-pro:low", "google-antigravity/gemini-3.8-flash:low"]);
  });

  it("drops a listed selector the catalog no longer lists (a retired model), matching provider/id without the :effort", () => {
    // The 2026-10-07 Antigravity generation change, either way round: the role keeps whichever generation is listed.
    const newGen = fixtureCatalog().filter((m) => !(m.provider === "google-antigravity" && m.id === "claude-opus-4-6"));
    expect(resolved({ role: "default", catalog: newGen })).toEqual(["anthropic/claude-opus-5-5:medium", "google-antigravity/claude-opus-5-5:medium", "kimi-code/k3:low"]);
    const oldGen = fixtureCatalog().filter((m) => !(m.provider === "google-antigravity" && /^claude-(opus|sonnet)-5-5$/.test(m.id)));
    expect(resolved({ role: "default", catalog: oldGen })).toEqual(["anthropic/claude-opus-5-5:medium", "google-antigravity/claude-opus-4-6:medium", "kimi-code/k3:low"]);
  });

  it("skips what the running child refused, in the list and in the override alike", () => {
    expect(resolved({ role: "default", refused: new Set(["anthropic/claude-opus-5-5"]) }))
      .toEqual(["google-antigravity/claude-opus-5-5:medium", "google-antigravity/claude-opus-4-6:medium", "kimi-code/k3:low"]);
    expect(resolved({ role: "thinking", override: "opus-4-6", refused: new Set(["google-antigravity/claude-opus-4-6"]) })[0]).toBe("anthropic/claude-opus-5-5:high");
  });

  it("static mode is the static list in order: no catalog check, no override, uncatalogued gpt-5.5 kept (§4.3)", () => {
    expect(resolved({ role: "fast", mode: "static", catalog: [], override: "opus" })).toEqual(STATIC_ROLE_LISTS.default);
    expect(resolved({ role: "reader", mode: "static" })).toEqual(STATIC_ROLE_LISTS.reader); // the fixture has no gpt-5.5
    expect(resolved({ role: "judges", seat: 1, mode: "static" })).toEqual(["openai-codex/gpt-5.5"]);
    expect(resolved({ role: "default", mode: "static", refused: new Set(["anthropic/claude-opus-5-5"]) }))
      .toEqual(["google-antigravity/claude-opus-4-6:medium", "kimi-code/k3:low"]); // the refused set applies in static too (Q9)
  });

  it("with no catalog in resolved mode, keeps the whole list and applies an override only as an exact list match (Decision 4)", () => {
    expect(resolved({ role: "default", catalog: null })).toEqual(ROLE_LISTS.default);
    expect(resolved({ role: "default", catalog: null, override: "KIMI-CODE/k3" })).toEqual([
      "kimi-code/k3:low", "anthropic/claude-opus-5-5:medium", "google-antigravity/claude-opus-5-5:medium", "google-antigravity/claude-opus-4-6:medium"
    ]);
    expect(resolved({ role: "default", catalog: null, override: "opus" })).toEqual(ROLE_LISTS.default);
  });

  it("resolves each judge seat from its own index; a seat override leads that seat only", () => {
    expect(resolved({ role: "judges", seat: 1 })).toEqual(["openai-codex/gpt-6.1-sol"]);
    expect(resolved({ role: "judges", seat: 1, override: "gemini-3.1-pro" })).toEqual(["google-antigravity/gemini-3.1-pro", "openai-codex/gpt-6.1-sol"]);
    expect(roleSelectors("judges")).toEqual([]); // no seat, no selectors: the judges never form one fallback chain
  });
});

describe("clampEffort — Decision 2", () => {
  const cat = fixtureCatalog();
  const k3 = parseModelString("kimi-code/k3:low");

  it("fits the routed effort to the model's catalogued levels, ties rounding up", () => {
    expect(clampEffort(k3, "medium", cat, "resolved")).toEqual({ provider: "kimi-code", model: "k3", effort: "high" });
    expect(clampEffort(k3, "low", cat, "resolved").effort).toBe("low");
    expect(clampEffort(parseModelString("google-antigravity/gemini-3.1-pro"), "medium", cat, "resolved").effort).toBe("high");
  });

  it("with no routed effort, clamps the selector's own effort, and keeps a selector with none effort-less", () => {
    expect(clampEffort(parseModelString("anthropic/claude-opus-5-5:medium"), null, cat, "resolved").effort).toBe("medium");
    expect(clampEffort(parseModelString("kimi-code/k3"), null, cat, "resolved")).toEqual({ provider: "kimi-code", model: "k3" }); // a judge seat
    expect(clampEffort(parseModelString("google-antigravity/claude-opus-5-5:medium"), "high", cat, "resolved").effort).toBe("high");
  });

  it("strips the effort of a model whose catalog thinking is null: no set_thinking_level", () => {
    expect(clampEffort(parseModelString("anthropic/claude-3-haiku-20240307:low"), "high", cat, "resolved"))
      .toEqual({ provider: "anthropic", model: "claude-3-haiku-20240307" });
  });

  it("static mode and a missing catalog keep the selector as listed (routed effort is ledgered, not applied)", () => {
    expect(clampEffort(k3, "high", cat, "static")).toBe(k3);
    expect(clampEffort(k3, "high", null, "resolved")).toBe(k3);
  });
});

describe("mode, step-up and override keys", () => {
  it("HOUGE_MODEL_ROLES defaults to resolved; only 'static' (any case, trimmed) is the rollback", () => {
    expect(resolveModelRolesMode({})).toBe("resolved");
    expect(resolveModelRolesMode({ HOUGE_MODEL_ROLES: " STATIC " })).toBe("static");
    expect(resolveModelRolesMode({ HOUGE_MODEL_ROLES: "off" })).toBe("resolved");
  });

  it("an exhausted role steps up Fast → Default → Thinking → nothing (no_planner_leg)", () => {
    expect([STEP_UP.fast, STEP_UP.default, STEP_UP.thinking]).toEqual(["default", "thinking", null]);
  });

  it("accepts a role name or judges:<n> as an override key, nothing else", () => {
    expect(["thinking", "judges", "judges:0", "judges:2"].every(isOverrideKey)).toBe(true);
    expect(["planner", "judges:x", "judges:-1", "Thinking", ""].some(isOverrideKey)).toBe(false);
  });
});
```

Create `tests/omp/model-catalog.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CATALOG_TIMEOUT_MS, parseOmpCatalog, readOmpCatalog, type ExecFileAsync } from "../../src/omp/model-catalog.js";
import { CATALOG_FIXTURE } from "../helpers/model-roles.js";
import { NO_OMP_BIN } from "../helpers/omp-env.js";

const cfg = { bin: "/fake/omp", profile: "houge", envPassthrough: [] as string[] };

// The catalog is the authority for resolution (Decision 1), and it is third-party output. A shape omp changes, or a
// read that hangs or throws, must leave the roles on their last good catalog and never stall or crash the daemon.
describe("parseOmpCatalog — omp's catalog is validated, never trusted", () => {
  it("keeps provider, id and thinking for every entry the selector syntax can carry", () => {
    const c = parseOmpCatalog(readFileSync(CATALOG_FIXTURE, "utf8"));
    expect(c?.find((m) => m.provider === "kimi-code" && m.id === "k3")).toEqual({ provider: "kimi-code", id: "k3", thinking: ["low", "high", "max"] });
    expect(c?.find((m) => m.id === "claude-3-haiku-20240307")?.thinking).toBeNull();
    expect(c?.some((m) => m.provider === "ollama")).toBe(false); // "gemma4:latest" is not a provider/id selector
    expect(c?.some((m) => m.provider === "google" && m.id === "gemini-3.8-flash")).toBe(true); // kept here; the allow-list drops it
  });

  it.each([["not json"], ["{}"], ['{"models":"x"}'], ['{"models":[]}'], ['{"models":[{"provider":1,"id":"k3"}]}']])(
    "returns null for %s, so the resolver keeps its last good catalog", (raw) => {
      expect(parseOmpCatalog(raw)).toBeNull();
    });

  it("drops an entry with a malformed thinking field and filters unknown levels out of a good one", () => {
    const c = parseOmpCatalog(JSON.stringify({ models: [
      { provider: "kimi-code", id: "k3", thinking: "high" },
      { provider: "anthropic", id: "claude-opus-5-5", thinking: ["low", "turbo", "high"] }
    ] }));
    expect(c).toEqual([{ provider: "anthropic", id: "claude-opus-5-5", thinking: ["low", "high"] }]);
  });
});

describe("readOmpCatalog — one bounded, session-less read that never throws", () => {
  it("runs `omp --profile <p> models --json` with a timeout and the allowlisted child env (no secret reaches omp)", async () => {
    process.env.HOUGE_TEST_CATALOG_SECRET = "canary-cat-1";
    const calls: Array<{ file: string; args: string[]; opts: Parameters<ExecFileAsync>[2] }> = [];
    const exec: ExecFileAsync = async (file, args, opts) => {
      calls.push({ file, args, opts });
      return { stdout: readFileSync(CATALOG_FIXTURE, "utf8"), stderr: "" };
    };
    try {
      expect((await readOmpCatalog(cfg, exec))?.length).toBeGreaterThan(0);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.file).toBe("/fake/omp");
      expect(calls[0]?.args).toEqual(["--profile", "houge", "models", "--json"]);
      expect(calls[0]?.opts?.timeout).toBe(CATALOG_TIMEOUT_MS);
      expect(Object.values(calls[0]?.opts?.env ?? {})).not.toContain("canary-cat-1");
    } finally {
      delete process.env.HOUGE_TEST_CATALOG_SECRET;
    }
  });

  it("returns null when omp exits non-zero, times out, or prints something that is not a catalog", async () => {
    const fail: ExecFileAsync = async () => { throw Object.assign(new Error("Command failed"), { status: 1 }); };
    const killed: ExecFileAsync = async () => { throw Object.assign(new Error("timed out"), { signal: "SIGTERM" }); };
    const garbage: ExecFileAsync = async () => ({ stdout: "Usage: omp models [--json]", stderr: "" });
    for (const exec of [fail, killed, garbage]) expect(await readOmpCatalog(cfg, exec)).toBeNull();
  });

  it("returns null for a missing binary through the real exec helper", async () => {
    expect(await readOmpCatalog({ ...cfg, bin: NO_OMP_BIN })).toBeNull();
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run tests/omp/model-roles.test.ts tests/omp/model-catalog.test.ts`
Expected: FAIL. Vitest reports `Failed to resolve import "../../src/omp/model-roles.js"` and the same for `model-catalog.js`.

- [ ] **Step 4: Create `src/omp/model-roles.ts`**

Create `src/omp/model-roles.ts`:

```ts
import { parseModelString, type ModelString, type OmpEffort } from "./model-string.js";

/**
 * Model roles (spec 2026-10-06 §4, ADR 0028 amendment). Every Houge seat names a role, and every role is a code-owned,
 * ordered list of exact selectors (`provider/id[:effort]`). Resolution against omp's live catalog is pure and lives here;
 * RoleResolver (role-resolver.ts) holds the catalog, Paco's `/models` overrides and reads the mode per call.
 */
export type RoleName = "fast" | "default" | "thinking" | "reader" | "vision" | "tiny" | "judges" | "chair" | "reviewer";
export const ROLE_NAMES: readonly RoleName[] = ["fast", "default", "thinking", "reader", "vision", "tiny", "judges", "chair", "reviewer"];

/** Planner gears and routed efforts: structurally src/jev/tree-policy.ts `TurnRole` / `Effort` (src/omp imports nothing from src/jev). */
type PlannerRole = "fast" | "default" | "thinking";
type RoutedEffort = "low" | "medium" | "high";

/**
 * The lists `resolved` mode starts from. They start from the pre-stage-A `HOUGE_OMP_*` defaults. `openai-codex/gpt-5.5`
 * (no longer catalogued on 2026-10-07) becomes `openai-codex/gpt-6.1-sol` (plan Decision 1). Antigravity's catalog
 * changed generation during 2026-10-07: `claude-opus-4-6` gave way to `claude-opus-5-5` and `claude-sonnet-5-5`. The
 * lists keep both generations, because resolution drops whatever the catalog does not list, so a provider that rolls
 * back or forward still leaves a leg. Fast and Thinking are new (Decision 3). Judges is one selector per seat index: a
 * judge never falls back. Kimi exits next year (Paco, 2026-10-07): every role list keeps a non-Kimi leg, so resolution
 * drops k3 without emptying a role (Fast carries no k3 at all; Tiny gains gemini-3.8-flash behind it). Judge seat 0 is
 * k3 alone and needs a replacement selector then.
 */
export const ROLE_LISTS: Readonly<Record<RoleName, readonly string[]>> = {
  fast: ["anthropic/claude-sonnet-5-5:low", "google-antigravity/claude-sonnet-5-5:low", "google-antigravity/gemini-3.8-flash:low"],
  default: ["anthropic/claude-opus-5-5:medium", "google-antigravity/claude-opus-5-5:medium", "google-antigravity/claude-opus-4-6:medium", "kimi-code/k3:low"],
  thinking: ["anthropic/claude-opus-5-5:high", "google-antigravity/claude-opus-5-5:high", "google-antigravity/claude-opus-4-6:high", "kimi-code/k3:high"],
  reader: ["google-antigravity/gemini-3.8-flash:low", "kimi-code/k3:low", "openai-codex/gpt-6.1-sol:low"],
  vision: ["google-antigravity/gemini-3.8-flash:low"],
  tiny: ["kimi-code/k3:low", "google-antigravity/gemini-3.8-flash:low"],
  judges: ["kimi-code/k3", "openai-codex/gpt-6.1-sol", "google-antigravity/gemini-3.1-pro"],
  chair: ["anthropic/claude-opus-5-5:low"],
  reviewer: ["kimi-code/k3:high", "google-antigravity/claude-opus-5-5:medium", "google-antigravity/claude-opus-4-6:medium"]
};

/**
 * The lists `static` mode runs (spec §4.3, the rollback switch): the pre-stage-A `HOUGE_OMP_*` defaults
 * (src/omp/omp-config.ts at main@94e3b4c), seat for seat and string for string. Static adds no model: Fast and Thinking
 * are the Default list, so every turn runs today's planner chain. A resolved role that comes up empty against the
 * catalog also falls back to its list here (RoleResolver), so a degraded catalog is never worse than before stage A.
 */
export const STATIC_ROLE_LISTS: Readonly<Record<RoleName, readonly string[]>> = (() => {
  const planner = ["anthropic/claude-opus-5-5:medium", "google-antigravity/claude-opus-4-6:medium", "kimi-code/k3:low"];
  return {
    fast: planner, default: planner, thinking: planner,
    reader: ["google-antigravity/gemini-3.8-flash:low", "kimi-code/k3:low", "openai-codex/gpt-5.5:low"],
    vision: ["google-antigravity/gemini-3.8-flash:low"],
    tiny: ["kimi-code/k3:low"],
    judges: ["kimi-code/k3", "openai-codex/gpt-5.5", "google-antigravity/gemini-3.1-pro"],
    chair: ["anthropic/claude-opus-5-5:low"],
    reviewer: ["kimi-code/k3:high", "google-antigravity/claude-opus-4-6:medium"]
  };
})();

/** Spec §4 step 1: the subscription providers. The catalog also lists metered or absent ones, which never match. */
export const ALLOWED_PROVIDERS: readonly string[] = ["anthropic", "google-antigravity", "kimi-code", "openai-codex"];
/** Codex is the self-write writer: no chat seat is ever routed to it (Reader and the council may use it). */
const CODEX_PROVIDER = "openai-codex";
export const CHAT_ROLES: ReadonlySet<RoleName> = new Set<RoleName>(["fast", "default", "thinking", "vision", "tiny"]);

export interface CatalogModel { provider: string; id: string; thinking: readonly OmpEffort[] | null }
export type ModelRolesMode = "static" | "resolved";

/** `HOUGE_MODEL_ROLES` (spec §4.3), read per call: `static` is the rollback switch, anything else is `resolved`. */
export function resolveModelRolesMode(env: NodeJS.ProcessEnv): ModelRolesMode {
  return env.HOUGE_MODEL_ROLES?.trim().toLowerCase() === "static" ? "static" : "resolved";
}

export const selectorKey = (m: Pick<ModelString, "provider" | "model">): string => `${m.provider}/${m.model}`;

export interface ResolveInput { role: RoleName; seat?: number; catalog: readonly CatalogModel[] | null; override: string | null;
  refused: ReadonlySet<string>; mode: ModelRolesMode }

/**
 * The role's own selectors in `mode` (ROLE_LISTS resolved, STATIC_ROLE_LISTS static), parsed. A judge seat is its one
 * index; the judges role without a seat has none.
 */
export function roleSelectors(role: RoleName, seat?: number, mode: ModelRolesMode = "resolved"): ModelString[] {
  const lists = mode === "static" ? STATIC_ROLE_LISTS : ROLE_LISTS;
  if (role !== "judges") return lists[role].map(parseModelString);
  return seat === undefined ? [] : lists.judges.slice(seat, seat + 1).map(parseModelString);
}

/** Step 1 for one provider: on the allow-list, and not Codex on a chat seat. */
function eligible(role: RoleName, provider: string): boolean {
  return ALLOWED_PROVIDERS.includes(provider) && !(CHAT_ROLES.has(role) && provider === CODEX_PROVIDER);
}

/** Step 2's matcher: a case-insensitive substring over `provider/id` of the catalog AFTER the step-1 filters. */
export function matchOverride(pattern: string, role: RoleName, catalog: readonly CatalogModel[]): CatalogModel[] {
  const p = pattern.trim().toLowerCase();
  if (p.length === 0) return [];
  return catalog.filter((m) => eligible(role, m.provider) && `${m.provider}/${m.id}`.toLowerCase().includes(p));
}

/**
 * Step 2: the override's candidates. Each takes the effort the role's list gives that model, else the role's first
 * selector's effort (the clamp then fits it to the model). With no catalog (Decision 4) a pattern matches only an exact
 * `provider/id` of the role's own list.
 */
export function overrideCandidates(role: RoleName, seat: number | undefined, override: string | null, catalog: readonly CatalogModel[] | null): ModelString[] {
  const own = roleSelectors(role, seat);
  const p = override?.trim().toLowerCase() ?? "";
  if (p.length === 0) return [];
  if (catalog === null) return own.filter((m) => selectorKey(m).toLowerCase() === p);
  return matchOverride(p, role, catalog).map((c) => {
    const effort = own.find((m) => m.provider === c.provider && m.model === c.id)?.effort ?? own[0]?.effort;
    return effort ? { provider: c.provider, model: c.id, effort } : { provider: c.provider, model: c.id };
  });
}

function dedupe(list: readonly ModelString[]): ModelString[] {
  const seen = new Set<string>();
  return list.filter((m) => {
    const k = selectorKey(m);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Step 3's test: the catalog lists the selector's `provider/id` (its `:effort` is not part of the match). */
function catalogued(m: ModelString, catalog: readonly CatalogModel[]): boolean {
  return catalog.some((c) => c.provider === m.provider && c.id === m.model);
}

/**
 * Spec §4 steps 1–4, pure: the override's candidates, then the role's list kept where the catalog lists it, duplicates
 * dropped, the child's refused selectors skipped. Static mode is STATIC_ROLE_LISTS in order (no catalog, no override); a
 * null catalog in resolved mode keeps the whole ROLE_LISTS entry (Decision 4), so a catalog outage never empties a role.
 * A resolved role CAN come up empty against a catalog; RoleResolver owns that case (spec §4.1, plan F7).
 */
export function resolveRole(i: ResolveInput): ModelString[] {
  const fresh = (m: ModelString) => !i.refused.has(selectorKey(m));
  if (i.mode === "static") return dedupe(roleSelectors(i.role, i.seat, "static")).filter(fresh);
  const own = roleSelectors(i.role, i.seat);
  const listed = own.filter((m) => eligible(i.role, m.provider) && (i.catalog === null || catalogued(m, i.catalog)));
  return dedupe([...overrideCandidates(i.role, i.seat, i.override, i.catalog), ...listed]).filter(fresh);
}

const EFFORT_ORDER: readonly OmpEffort[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The supported level nearest `target`; a tie rounds up (Decision 2: `medium` on a low/high/max model is `high`). */
function nearestLevel(target: OmpEffort, levels: readonly OmpEffort[]): OmpEffort {
  const rank = (e: OmpEffort) => EFFORT_ORDER.indexOf(e);
  let best = levels[0] as OmpEffort;
  for (const l of levels) {
    const d = Math.abs(rank(l) - rank(target));
    const bd = Math.abs(rank(best) - rank(target));
    if (d < bd || (d === bd && rank(l) > rank(best))) best = l;
  }
  return best;
}

/**
 * Decision 2: the routed effort (or, when null, the selector's own) clamped to the model's catalogued `thinking` levels.
 * A model the catalog lists with no levels gets no effort (no `set_thinking_level`). Static mode, or no catalog, keeps
 * the selector exactly as listed (routed effort is ledgered, not applied).
 */
export function clampEffort(m: ModelString, effort: RoutedEffort | null, catalog: readonly CatalogModel[] | null, mode: ModelRolesMode): ModelString {
  if (mode === "static" || catalog === null) return m;
  const entry = catalog.find((c) => c.provider === m.provider && c.id === m.model);
  if (!entry) return m;
  const bare: ModelString = { provider: m.provider, model: m.model };
  const target = effort ?? m.effort;
  if (entry.thinking === null || entry.thinking.length === 0 || target === undefined) return bare;
  return { ...bare, effort: nearestLevel(target, entry.thinking) };
}

/** An exhausted planner role steps up (spec §4): Fast → Default → Thinking → none (`no_planner_leg`). */
export const STEP_UP: Readonly<Record<PlannerRole, PlannerRole | null>> = { fast: "default", default: "thinking", thinking: null };

/** The seven OmpConfig seat chains, as the roles fill them. */
export interface RoleChains { planner: ModelString[]; reader: ModelString[]; media: ModelString[]; ticks: ModelString[];
  judges: ModelString[]; chair: ModelString[]; reviewer: ModelString[] }

/**
 * The seven seat chains as STATIC_ROLE_LISTS: today's chains exactly. `HOUGE_MODEL_ROLES=static`, callers that hold no
 * resolver (the CLI, scripts), and resolveOmpConfig's default.
 */
export function staticRoleChains(): RoleChains {
  const s = (r: RoleName): ModelString[] => STATIC_ROLE_LISTS[r].map(parseModelString);
  return { planner: s("default"), reader: s("reader"), media: s("vision"), ticks: s("tiny"), judges: s("judges"), chair: s("chair"), reviewer: s("reviewer") };
}

const JUDGE_SEAT_KEY = /^judges:(0|[1-9]\d?)$/;

/** A `/models` override key (spec §4.2): a role name, or `judges:<n>` for one judge seat. */
export function isOverrideKey(k: string): k is RoleName | `judges:${number}` {
  return (ROLE_NAMES as readonly string[]).includes(k) || JUDGE_SEAT_KEY.test(k);
}
```

- [ ] **Step 5: Create `src/omp/model-catalog.ts`**

Create `src/omp/model-catalog.ts`:

```ts
import { execFileAsync } from "../run/exec-file-async.js";
import { daemonTmpRoot } from "../run/daemon-tmp.js";
import { buildChildEnv } from "./child-env.js";
import { parseModelString, type OmpEffort } from "./model-string.js";
import type { CatalogModel } from "./model-roles.js";
import type { OmpConfig } from "./omp-config.js";

/** The exec seam (tests inject a fake; production is the promisified execFile). */
export type ExecFileAsync = typeof execFileAsync;
/** One catalog read never holds boot or a tick longer than this (the child is SIGTERMed). */
export const CATALOG_TIMEOUT_MS = 15_000;
const CATALOG_MAX_BYTES = 8 * 1024 * 1024;
const EFFORTS: ReadonlySet<string> = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** One catalog entry, or null. An id the selector syntax cannot carry (e.g. ollama's `name:tag`) is never a candidate. */
function catalogEntry(raw: unknown): CatalogModel | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { provider, id, thinking } = raw as Record<string, unknown>;
  if (typeof provider !== "string" || typeof id !== "string") return null;
  try { parseModelString(`${provider}/${id}`); } catch { return null; }
  if (thinking === null || thinking === undefined) return { provider, id, thinking: null };
  if (!Array.isArray(thinking)) return null;
  const levels = thinking.filter((t): t is OmpEffort => typeof t === "string" && EFFORTS.has(t));
  return { provider, id, thinking: levels.length > 0 ? levels : null };
}

/** `omp models --json` output → validated entries; null when it is not `{models: [...]}` with at least one usable entry. */
export function parseOmpCatalog(json: string): CatalogModel[] | null {
  let doc: unknown;
  try { doc = JSON.parse(json); } catch { return null; }
  const models = typeof doc === "object" && doc !== null ? (doc as { models?: unknown }).models : undefined;
  if (!Array.isArray(models)) return null;
  const out = models.map(catalogEntry).filter((m): m is CatalogModel => m !== null);
  return out.length > 0 ? out : null;
}

/**
 * One session-less `omp --profile <p> models --json` (spec §4; Decision 1: the catalog is the authority). Bounded by
 * CATALOG_TIMEOUT_MS, run under the allowlisted child env like every omp spawn (ADR 0015). Never throws: any failure is
 * null, and the caller keeps its last good catalog and ledgers the miss.
 */
export async function readOmpCatalog(cfg: Pick<OmpConfig, "bin" | "profile" | "envPassthrough">, exec: ExecFileAsync = execFileAsync): Promise<CatalogModel[] | null> {
  try {
    const env = { ...buildChildEnv(cfg.envPassthrough), TMPDIR: daemonTmpRoot() };
    const { stdout } = await exec(cfg.bin, ["--profile", cfg.profile, "models", "--json"], { timeout: CATALOG_TIMEOUT_MS, maxBuffer: CATALOG_MAX_BYTES, env });
    return parseOmpCatalog(stdout);
  } catch (error) {
    const e = error as { code?: unknown; signal?: unknown };
    console.warn(`[model-catalog] omp models failed: ${String(e.code ?? e.signal ?? "error")}`);
    return null;
  }
}
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `npx vitest run tests/omp/model-roles.test.ts tests/omp/model-catalog.test.ts && npm run typecheck`
Expected: PASS (32 tests in the two files), typecheck clean. Nothing else imports the new modules yet.

- [ ] **Step 7: Commit**

```bash
git add src/omp/model-roles.ts src/omp/model-catalog.ts tests/fixtures/omp-models.json tests/helpers/model-roles.ts tests/omp/model-roles.test.ts tests/omp/model-catalog.test.ts
git commit -m "$(cat <<'EOF'
feat(omp): code-owned model role lists, pure resolution and the omp catalog read

Each role is an ordered list of exact selectors; resolution applies the provider
allow-list and chat-seat eligibility before any matching, an override pattern,
the catalog check and the refused set (spec 2026-10-06 §4). Routed effort is
clamped to the model's catalogued levels (Decision 2). Static mode runs
STATIC_ROLE_LISTS: today's seven HOUGE_OMP_* defaults, seat for seat (§4.3).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

---

### Task 7: RoleResolver, override rows, catalog lifecycle, seat consumers on resolved chains, D10 skip rule

**Assembly overrides (binding; orchestrator, 2026-10-07; this block wins where the task text disagrees):**
- Do **not** add ledger event types here. Task 9 lands before Task 6 and owns every stage A type: `model_role_override`
  `["key","pattern","actor"]`, `model_catalog_unavailable` `["reason"]` and, from Rev 2, `model_roles_fallback`
  `["role"]`. This task writes all three.
- The `CoreWorker` field is `this.roles` and the public accessor is `modelRoles()`. Tasks 8 and 11 use exactly these names.
- **(F14) This task is the one owner of the catalog-outage lifecycle**: the hourly retry, the incident and its
  resolution. Task 11's daily tick only calls `refreshCatalog()`.

**Contract deviation:**
1. `RoleResolver` is constructed by `CoreWorker`. By default its `readCatalog` is bound to
   `readOmpCatalog(resolveOmpConfig(process.env))`. Tests inject one through a new `OmpWorkerOptions.roles?: RoleResolver`,
   and it is exposed as `CoreWorker.modelRoles()`. The daemon awaits `worker.modelRoles().refreshCatalog()` once at boot,
   offers `retryFailedRead()` every poll cycle, and threads `worker.modelRoles()` into its ticks.
2. `latestModelRoleOverrides()` / `recordModelRoleOverride()` read and write through the existing run-less writer
   `RunStore.recordMemoryEvent` (`src/run/run-store.ts:6601`; actor `system`, correlation `model_roles`). It is the
   store's only run-less, sequence-validated writer.
3. `model_catalog_unavailable`'s `reason` is the fixed enum `"read_failed"`: `readOmpCatalog` returns `null` with no
   cause, and omp's error text never goes into a payload.
4. Extra exports and inputs:
   - `RETIRED_OMP_CHAIN_VARS` and `warnRetiredOmpChainVars(env, warn?)` from `omp-config.ts` (the one-time boot warning);
   - optional `chains?: RoleChains` on `ReviewDiffInput`, `reviewerDiversityWarning`, `MediaCallDeps`,
     `OmpPanelSeatsInput` and `collectHougeStatus`, plus a 5th `tickSeat` parameter. Every one defaults to
     `staticRoleChains()` (today's chains).
5. **(F7, F14)** `RoleResolver` gains:
   - `retryFailedRead()`, `requestRefresh()` and an optional `now` clock dependency;
   - the constants `CATALOG_RETRY_MS`, `CATALOG_INCIDENT_AFTER`, `NO_LEG_REFRESH_MS`;
   - the empty-role fallback (see Rev 2 Changes, F7).

**Files:**
- Create: `src/omp/role-resolver.ts`
- Modify: `src/run/run-store.ts`:
  - imports, next to `import type { LlmAttempt, LlmAuditSink }` (`:38`);
  - new methods after `recordMemoryEvent` (`:6600-6605`);
  - module helper `parseOverridePayload`, directly above `/** Per-scope active-row cap` (`:8350`).
- Modify: `src/omp/omp-config.ts:1-93`:
  - the chain keys leave `DEFAULTS`, `CHAIN_KEYS` and `ompConfigProblems`;
  - a `chains` parameter;
  - the boot warning.
- Modify: `src/llm/providers/omp.ts:104-141` (D10 skip rule, resolved mode only)
- Modify: `src/llm/registry.ts:149-161` (`tickSeat` chains)
- Modify: `src/core/core-worker.ts:137`, `:263-274`, `:399`, `:436`, `:1270`, `:1370-1375`, `:1496-1511`, `:1521`,
  `:2049-2052`, `:2169`, `:2246`, `:2862-2864`
- Modify: `src/telegram/telegram-daemon.ts`:
  - `:16`, `:183` (boot read);
  - the poll loop after `expireUndeliveredApprovalPrompts` (`:286`, hourly retry);
  - `:349-354`, `:486-502`, `:511-571`, `:595-597`.
- Modify: `src/media/media-ingest.ts`, `src/status/houge-status.ts`, `src/capabilities/idea-panel-seats.ts`,
  `src/capabilities/diff-reviewer.ts`, `src/media/media-config.ts:51` (comment only)
- Modify: `scripts/live-gate-memory-a1.mjs:59-66`, `:218-223`
- Modify: `tests/fixtures/fake-omp.mjs:27` (a `models --json` branch); `tests/helpers/omp-env.ts:5,11`;
  `tests/helpers/omp-worker.ts`; `tests/helpers/model-roles.ts` (append `pinnedRoles`)
- Test (new): `tests/omp/role-resolver.test.ts`, `tests/run/run-store-model-roles.test.ts`
- Test (modified):
  - `tests/omp/omp-config.test.ts`, `tests/llm/providers/omp.test.ts`, `tests/llm/seat-routing.test.ts`;
  - `tests/core/core-worker-reader-family.test.ts` (rewrite), `tests/core/core-worker-omp-turn.test.ts`,
    `tests/core/core-worker-runner-caps.test.ts`;
  - `tests/telegram/telegram-daemon.test.ts`, `tests/status/houge-status.test.ts`, `tests/media/media-call.test.ts`;
  - `tests/capabilities/idea-panel-seats.test.ts`, `tests/capabilities/diff-reviewer.test.ts`;
  - `tests/omp/planner-supervisor.test.ts` (harness `o.planner` and the four `HOUGE_OMP_PLANNER` call sites).

**Interfaces:**
- Consumes:
  - from Task 6: `resolveRole`, `clampEffort`, `overrideCandidates`, `isOverrideKey`, `selectorKey`, `ROLE_LISTS`,
    `STATIC_ROLE_LISTS`, `ROLE_NAMES`, `staticRoleChains`, `RoleChains`, `RoleName`, `CatalogModel`,
    `resolveModelRolesMode`, `readOmpCatalog`, `fixtureCatalog`;
  - `RunStore.recordMemoryEvent` (`src/run/run-store.ts:6601`);
  - `openAlertedIncident`, `resolveOpenIncidents` (`src/run/incident-alert.ts:28`, `:85`);
  - `familyOf` (`src/omp/model-string.ts:35`).
- Produces (contract):
  - `OverrideKey`, `ResolvedRole`, `class RoleResolver { refreshCatalog; catalog; candidates; chains; resolveAll }`;
  - `resolveOmpConfig(env, chains = staticRoleChains())`;
  - `RunStore.latestModelRoleOverrides(): Map<OverrideKey, string>`, `RunStore.recordModelRoleOverride(i)`.
- Produces (extra):
  - `RoleResolver.retryFailedRead()`, `RoleResolver.requestRefresh()`, `CATALOG_RETRY_MS`, `CATALOG_INCIDENT_AFTER`,
    `NO_LEG_REFRESH_MS`;
  - `CoreWorker.modelRoles(): RoleResolver`, `OmpWorkerOptions.roles`;
  - `RETIRED_OMP_CHAIN_VARS`, `warnRetiredOmpChainVars`;
  - `pinnedRoles(store, catalog, overrides?, env?)` (tests).

#### 7a — the resolver, its catalog lifecycle, and the override rows

- [ ] **Step 1: Append `pinnedRoles` to `tests/helpers/model-roles.ts`**

The file after this step (Task 6's content plus two imports and `pinnedRoles`):

```ts
import { readFileSync } from "node:fs";
import { parseOmpCatalog } from "../../src/omp/model-catalog.js";
import type { CatalogModel } from "../../src/omp/model-roles.js";
import { RoleResolver, type OverrideKey } from "../../src/omp/role-resolver.js";
import type { RunStore } from "../../src/run/run-store.js";

/** A neutral `omp --profile houge models --json` catalog (tests/fixtures/omp-models.json): every list id, both Antigravity generations, the twins. */
export const CATALOG_FIXTURE = new URL("../fixtures/omp-models.json", import.meta.url).pathname;

/** The fixture through the real parser, so a test sees exactly what the resolver would. */
export function fixtureCatalog(): CatalogModel[] {
  const c = parseOmpCatalog(readFileSync(CATALOG_FIXTURE, "utf8"));
  if (!c) throw new Error("the catalog fixture did not parse");
  return c;
}

/** A resolver over `catalog` with Paco's overrides already recorded (as `/models set` would), the catalog read once. */
export async function pinnedRoles(
  store: RunStore, catalog: CatalogModel[], overrides: Partial<Record<OverrideKey, string>> = {}, env: () => NodeJS.ProcessEnv = () => ({})
): Promise<RoleResolver> {
  for (const [key, pattern] of Object.entries(overrides)) store.recordModelRoleOverride({ key: key as OverrideKey, pattern: pattern ?? "", actor: "test" });
  const roles = new RoleResolver({ store, env, readCatalog: async () => catalog });
  await roles.refreshCatalog();
  return roles;
}
```

- [ ] **Step 2: Write the failing tests**

Create `tests/run/run-store-model-roles.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { RunStore } from "../../src/run/run-store.js";

// Spec §4.2: overrides are append-only ledger rows: the latest row per key wins and an empty pattern resets the key.
// They are read at every resolution, so a wrong read here silently routes every turn of a role to the wrong model.
describe("RunStore — model role overrides", () => {
  it("returns the latest pattern per key and drops a reset key", () => {
    const store = RunStore.openInMemory();
    store.recordModelRoleOverride({ key: "thinking", pattern: "opus", actor: "paco" });
    store.recordModelRoleOverride({ key: "judges:1", pattern: "gemini-3.1-pro", actor: "paco" });
    store.recordModelRoleOverride({ key: "thinking", pattern: "opus-4-6", actor: "paco" });
    store.recordModelRoleOverride({ key: "judges:1", pattern: "", actor: "paco" });
    expect([...store.latestModelRoleOverrides()]).toEqual([["thinking", "opus-4-6"]]);
    store.close();
  });

  it("writes one run-less model_role_override row carrying key, pattern and actor only", () => {
    const store = RunStore.openInMemory();
    store.recordModelRoleOverride({ key: "fast", pattern: "sonnet", actor: "paco" });
    const rows = store.getLedgerEvents().filter((e) => e.event_type === "model_role_override");
    expect(rows.map((e) => [e.run_id, e.payload])).toEqual([[undefined, { key: "fast", pattern: "sonnet", actor: "paco" }]]);
    store.close();
  });

  it("skips a row whose key is not a role or a judge seat (a hand-edited or future payload is never trusted)", () => {
    const store = RunStore.openInMemory();
    store.recordMemoryEvent("model_role_override", { key: "planner", pattern: "opus", actor: "x" }, "model_roles");
    store.recordMemoryEvent("model_role_override", { key: "judges:x", pattern: "opus", actor: "x" }, "model_roles");
    expect(store.latestModelRoleOverrides().size).toBe(0);
    store.close();
  });

  it("refuses a row without its required fields (the ledger validator)", () => {
    const store = RunStore.openInMemory();
    expect(() => store.recordMemoryEvent("model_role_override", { key: "fast", actor: "x" })).toThrow(/pattern/);
    expect(() => store.recordMemoryEvent("model_catalog_unavailable", {})).toThrow(/reason/);
    store.close();
  });
});
```

Create `tests/omp/role-resolver.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatModelString, parseModelString, type ModelString } from "../../src/omp/model-string.js";
import { ROLE_LISTS, STATIC_ROLE_LISTS, staticRoleChains, type CatalogModel, type RoleChains } from "../../src/omp/model-roles.js";
import { CATALOG_RETRY_MS, NO_LEG_REFRESH_MS, RoleResolver } from "../../src/omp/role-resolver.js";
import { RunStore } from "../../src/run/run-store.js";
import { fixtureCatalog, pinnedRoles } from "../helpers/model-roles.js";

const fmt = (l: ModelString[]) => l.map(formatModelString);
const notes = (store: RunStore, type: "model_catalog_unavailable" | "model_roles_fallback") =>
  store.getLedgerEvents().filter((e) => e.event_type === type).map((e) => e.payload);
const openCatalogIncidents = (store: RunStore) => store.listOpenIncidents().filter((i) => i.kind === "model_catalog_unavailable");
/** The seven chains as ROLE_LISTS (resolved mode before any catalog read: Decision 4 keeps every list whole). */
const listChains = (): RoleChains => {
  const s = (r: keyof typeof ROLE_LISTS) => ROLE_LISTS[r].map(parseModelString);
  return { planner: s("default"), reader: s("reader"), media: s("vision"), ticks: s("tiny"), judges: s("judges"), chair: s("chair"), reviewer: s("reviewer") };
};

// Spec 2026-10-06 §4 / §9: every seat now runs on this service. The tests pin what surrounds the pure resolution:
// the catalog lifecycle (Decision 4, F14), overrides read at each resolution, the rollback switch, the empty-role
// fallback (F7) and chains().
describe("RoleResolver", () => {
  it("before any catalog read, every chain is its resolved list, whole: a catalog outage never empties a role (Decision 4)", () => {
    const store = RunStore.openInMemory();
    const roles = new RoleResolver({ store, env: () => ({}), readCatalog: async () => null });
    expect(roles.catalog()).toBeNull();
    expect(roles.chains()).toEqual(listChains());
    store.close();
  });

  it("a good read replaces the catalog; a failed or throwing read keeps the last good one and leaves one note per read", async () => {
    const store = RunStore.openInMemory();
    let next: () => Promise<CatalogModel[] | null> = async () => fixtureCatalog();
    const roles = new RoleResolver({ store, env: () => ({}), readCatalog: () => next() });
    expect(await roles.refreshCatalog()).toBe(true);
    next = async () => null;
    expect(await roles.refreshCatalog()).toBe(false);
    next = async () => { throw new Error("spawn EAGAIN"); };
    expect(await roles.refreshCatalog()).toBe(false);
    expect(roles.catalog()).toEqual(fixtureCatalog());
    expect(notes(store, "model_catalog_unavailable")).toEqual([{ reason: "read_failed" }, { reason: "read_failed" }]);
    store.close();
  });

  // F14: a catalog outage used to be a ledger note only, left for a day. Paco must hear of a persistent one, and the
  // roles must recover within the hour, not at the next daily tick.
  it("two consecutive failed reads open one alerted model_catalog_unavailable incident; the next good read resolves it", async () => {
    const store = RunStore.openInMemory();
    let ok = false;
    const roles = new RoleResolver({ store, env: () => ({}), readCatalog: async () => (ok ? fixtureCatalog() : null) });
    await roles.refreshCatalog();
    expect(openCatalogIncidents(store)).toEqual([]); // one failure is a note, not a page
    await roles.refreshCatalog();
    await roles.refreshCatalog();
    expect(openCatalogIncidents(store).map((i) => i.subject)).toEqual(["omp"]); // opened once, not per failure
    ok = true;
    await roles.refreshCatalog();
    expect(openCatalogIncidents(store)).toEqual([]);
    store.close();
  });

  it("retries a failed read once it is an hour old, and never while the last read succeeded", async () => {
    const store = RunStore.openInMemory();
    let t = 0;
    let reads = 0;
    let ok = false;
    const roles = new RoleResolver({ store, env: () => ({}), now: () => t, readCatalog: async () => { reads++; return ok ? fixtureCatalog() : null; } });
    await roles.refreshCatalog();
    t = CATALOG_RETRY_MS - 1;
    expect(roles.retryFailedRead()).toBeNull();
    t = CATALOG_RETRY_MS;
    ok = true;
    expect(await roles.retryFailedRead()).toBe(true);
    t += 10 * CATALOG_RETRY_MS;
    expect(roles.retryFailedRead()).toBeNull(); // healthy: the daily tick owns the next read
    expect(reads).toBe(2);
    store.close();
  });

  it("requestRefresh (a no_planner_leg) re-reads at most once per 10 minutes", async () => {
    const store = RunStore.openInMemory();
    let t = 0;
    let reads = 0;
    const roles = new RoleResolver({ store, env: () => ({}), now: () => t, readCatalog: async () => { reads++; return fixtureCatalog(); } });
    roles.requestRefresh();
    await roles.refreshCatalog(); // joins the read in flight
    t = NO_LEG_REFRESH_MS - 1;
    roles.requestRefresh();
    t = NO_LEG_REFRESH_MS;
    roles.requestRefresh();
    await roles.refreshCatalog(); // joins the read requestRefresh started: one omp spawn, not two
    expect(reads).toBe(2); // the first read and the one at 10 min; never one at 10 min − 1 ms
    store.close();
  });

  it("reads Paco's override at every resolution: set, then reset, with no restart", async () => {
    const store = RunStore.openInMemory();
    const roles = await pinnedRoles(store, fixtureCatalog());
    expect(fmt(roles.candidates("thinking"))[0]).toBe("anthropic/claude-opus-5-5:high");
    store.recordModelRoleOverride({ key: "thinking", pattern: "opus-4-6", actor: "paco" });
    expect(fmt(roles.candidates("thinking"))[0]).toBe("google-antigravity/claude-opus-4-6:high");
    store.recordModelRoleOverride({ key: "thinking", pattern: "", actor: "paco" });
    expect(fmt(roles.candidates("thinking"))[0]).toBe("anthropic/claude-opus-5-5:high");
    store.close();
  });

  it("HOUGE_MODEL_ROLES=static runs today's chains, ignoring the catalog and the overrides, read per call (§4.3)", async () => {
    const store = RunStore.openInMemory();
    let env: NodeJS.ProcessEnv = { HOUGE_MODEL_ROLES: "static" };
    store.recordModelRoleOverride({ key: "default", pattern: "k3", actor: "paco" });
    const roles = new RoleResolver({ store, env: () => env, readCatalog: async () => fixtureCatalog().filter((m) => m.provider === "kimi-code") });
    await roles.refreshCatalog();
    expect(roles.chains()).toEqual(staticRoleChains());
    expect(fmt(roles.candidates("fast", { effort: "low" }))).toEqual([...STATIC_ROLE_LISTS.default]); // routed effort not applied
    expect(notes(store, "model_roles_fallback")).toEqual([]); // static never "falls back": it is the static list
    env = {};
    expect(fmt(roles.candidates("default"))).toEqual(["kimi-code/k3:low"]);
    store.close();
  });

  it("candidates() skips the child's refused selectors and clamps the turn's routed effort per model (Decision 2)", async () => {
    const store = RunStore.openInMemory();
    const roles = await pinnedRoles(store, fixtureCatalog());
    expect(fmt(roles.candidates("default", { refused: new Set(["anthropic/claude-opus-5-5"]), effort: "medium" })))
      .toEqual(["google-antigravity/claude-opus-5-5:medium", "google-antigravity/claude-opus-4-6:medium", "kimi-code/k3:high"]);
    store.close();
  });

  // F7: a catalog snapshot can drop every candidate of a role (Decision 3 saw the catalog move twice in a day, and a
  // provider whose auth lapses leaves `omp models`). Fast steps up; every other role must still have something to run.
  it("a catalog that empties Fast returns no candidate (the supervisor steps up); Default and Thinking fall back to their static list", async () => {
    const store = RunStore.openInMemory();
    // A catalog with one model no planner list names.
    const roles = await pinnedRoles(store, fixtureCatalog().filter((m) => m.provider === "google-antigravity" && m.id === "gemini-3.1-pro"));
    expect(roles.candidates("fast")).toEqual([]);
    expect(fmt(roles.candidates("default"))).toEqual([...STATIC_ROLE_LISTS.default]);
    expect(fmt(roles.candidates("thinking", { effort: "high" }))).toEqual([...STATIC_ROLE_LISTS.thinking]); // unfiltered, unclamped
    expect(fmt(roles.candidates("default", { refused: new Set(["anthropic/claude-opus-5-5"]) })))
      .toEqual(STATIC_ROLE_LISTS.default.slice(1)); // the spawn axis still walks past what the child refused
    store.close();
  });

  it("notes model_roles_fallback once per role per catalog read, however often the role is resolved", async () => {
    const store = RunStore.openInMemory();
    const roles = await pinnedRoles(store, fixtureCatalog().filter((m) => !/claude|k3/.test(m.id)));
    roles.candidates("default"); roles.candidates("default"); roles.chains();
    // No claude and no k3 in the catalog: Default, judge seat 0, Chair and Reviewer resolve empty (Fast and Tiny keep gemini-3.8-flash).
    expect(notes(store, "model_roles_fallback")).toEqual([{ role: "default" }, { role: "judges:0" }, { role: "chair" }, { role: "reviewer" }]);
    await roles.refreshCatalog();
    roles.candidates("default");
    expect(notes(store, "model_roles_fallback")).toHaveLength(5); // a new read, a new note
    store.close();
  });

  it("chains() keeps every judge on its own index; an emptied seat or role runs its static selector, never an empty chain", async () => {
    const store = RunStore.openInMemory();
    const trimmed = fixtureCatalog().filter((m) => m.provider !== "openai-codex" && !(m.provider === "google-antigravity" && m.id === "gemini-3.8-flash"));
    const roles = await pinnedRoles(store, trimmed, { "judges:0": "opus-4-6" });
    const c = roles.chains();
    expect(fmt(c.judges)).toEqual(["google-antigravity/claude-opus-4-6", "openai-codex/gpt-5.5", "google-antigravity/gemini-3.1-pro"]);
    expect(c.media).toEqual(staticRoleChains().media);
    expect(fmt(c.reader)).toEqual(["kimi-code/k3:low"]); // not empty: no fallback
    expect(notes(store, "model_roles_fallback")).toEqual([{ role: "vision" }, { role: "judges:1" }]);
    store.close();
  });

  it("resolveAll() lists every role and judge seat with its head, its candidates and its source; an emptied role shows head null", async () => {
    const store = RunStore.openInMemory();
    const roles = await pinnedRoles(store, fixtureCatalog(), { vision: "gemini-3.1-pro" });
    const all = roles.resolveAll();
    expect(all.map((r) => r.key)).toEqual(["fast", "default", "thinking", "reader", "vision", "tiny", "judges:0", "judges:1", "judges:2", "chair", "reviewer"]);
    expect(all.find((r) => r.key === "vision")).toEqual({ key: "vision", head: "google-antigravity/gemini-3.1-pro:low",
      candidates: ["google-antigravity/gemini-3.1-pro:low", "google-antigravity/gemini-3.8-flash:low"], source: "override" });
    expect(all.find((r) => r.key === "default")?.source).toBe("list");
    const bare = await pinnedRoles(store, fixtureCatalog().filter((m) => !/claude|k3/.test(m.id)));
    expect(bare.resolveAll().find((r) => r.key === "default")).toMatchObject({ head: null, candidates: [] }); // role_unresolved sees it (Task 11)
    store.close();
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run tests/run/run-store-model-roles.test.ts tests/omp/role-resolver.test.ts`
Expected: FAIL. `role-resolver.test.ts` and `tests/helpers/model-roles.ts` cannot resolve `../../src/omp/role-resolver.js`.
`run-store-model-roles.test.ts` fails with `store.recordModelRoleOverride is not a function`.

- [ ] **Step 4: Add the store methods**

`src/run/run-store.ts` hunk 1 (near line 38). Replace:

```ts
import type { LlmAttempt, LlmAuditSink } from "../llm/audit.js";
import { computeCostUsd, METERED_PROVIDERS } from "../llm/metered-pricing.js";
```

with:

```ts
import type { LlmAttempt, LlmAuditSink } from "../llm/audit.js";
import { isOverrideKey } from "../omp/model-roles.js";
import type { OverrideKey } from "../omp/role-resolver.js";
import { computeCostUsd, METERED_PROVIDERS } from "../llm/metered-pricing.js";
```

`src/run/run-store.ts` hunk 2 (near line 6648). Replace:

```ts

  private nextLedgerSequence(run_id?: string): number {
```

with:

```ts

  /** Paco's `/models` overrides (spec §4.2): the latest `model_role_override` row per key; an empty pattern is a reset. */
  latestModelRoleOverrides(): Map<OverrideKey, string> {
    const rows = this.db.prepare(`
      SELECT payload_json FROM ledger_events WHERE event_type = 'model_role_override'
      ORDER BY sequence ASC, occurred_at ASC, event_id ASC
    `).all<{ payload_json: string }>();
    const out = new Map<OverrideKey, string>();
    for (const row of rows) {
      const p = parseOverridePayload(row.payload_json);
      if (!p) continue;
      if (p.pattern === "") out.delete(p.key);
      else out.set(p.key, p.pattern);
    }
    return out;
  }

  /** One append-only override row (run-less, so its sequence is above every earlier row). The `/models` gateway command is the production writer. */
  recordModelRoleOverride(i: { key: OverrideKey; pattern: string; actor: string }): void {
    this.recordMemoryEvent("model_role_override", { key: i.key, pattern: i.pattern, actor: i.actor }, "model_roles");
  }

  private nextLedgerSequence(run_id?: string): number {
```

`src/run/run-store.ts` hunk 3 (near line 8402). Replace:

```ts

/** Per-scope active-row cap (⓪·3 S1): overflow prunes the lowest reuse_value rows. */
```

with:

```ts

/** A stored override row, or null when it is not one: a hand-edited or future-shaped payload is skipped, never trusted. */
function parseOverridePayload(json: string): { key: OverrideKey; pattern: string } | null {
  let p: unknown;
  try { p = JSON.parse(json); } catch { return null; }
  if (typeof p !== "object" || p === null) return null;
  const { key, pattern } = p as Record<string, unknown>;
  return typeof key === "string" && typeof pattern === "string" && isOverrideKey(key) ? { key, pattern } : null;
}

/** Per-scope active-row cap (⓪·3 S1): overflow prunes the lowest reuse_value rows. */
```

- [ ] **Step 5: Create `src/omp/role-resolver.ts`**

Create `src/omp/role-resolver.ts`:

```ts
import { formatModelString, type ModelString } from "./model-string.js";
import {
  clampEffort, overrideCandidates, resolveModelRolesMode, resolveRole, ROLE_LISTS, ROLE_NAMES, selectorKey,
  type CatalogModel, type ModelRolesMode, type RoleChains, type RoleName
} from "./model-roles.js";
import { openAlertedIncident, resolveOpenIncidents } from "../run/incident-alert.js";
import type { RunStore } from "../run/run-store.js";

/** A `/models` override key: a role, or one judge seat (spec §4.2). */
export type OverrideKey = RoleName | `judges:${number}`;
export interface ResolvedRole { key: OverrideKey; head: string | null; candidates: string[]; source: "list" | "override" }

/** A failed catalog read is retried this long after it (plan F14), never left for the next daily tick. */
export const CATALOG_RETRY_MS = 60 * 60_000;
/** Consecutive failed reads that open the alerted `model_catalog_unavailable` incident (plan F14). */
export const CATALOG_INCIDENT_AFTER = 2;
/** A `no_planner_leg` asks for a fresh catalog at most this often (plan F7 d). */
export const NO_LEG_REFRESH_MS = 10 * 60_000;
const CATALOG_INCIDENT: ReadonlySet<string> = new Set(["model_catalog_unavailable"]);

/** Structurally src/jev/tree-policy.ts `Effort`. */
type RoutedEffort = "low" | "medium" | "high";
interface CandidateOptions { refused?: ReadonlySet<string>; effort?: RoutedEffort | null; seat?: number }
/** One resolution's view: the mode and the overrides, read once so a chains() call is consistent across its seven roles. */
interface Snapshot { mode: ModelRolesMode; overrides: Map<OverrideKey, string> }
interface ResolverDeps {
  store: RunStore; env?: () => NodeJS.ProcessEnv; readCatalog: () => Promise<CatalogModel[] | null>;
  /** Injectable clock (ms) for the retry and refresh windows; default Date.now. */
  now?: () => number;
}

const NOTHING_REFUSED: ReadonlySet<string> = new Set();
const keyOf = (role: RoleName, seat?: number): OverrideKey => (role === "judges" && seat !== undefined ? `judges:${seat}` : role);
const seatOpt = (seat?: number): CandidateOptions => (seat === undefined ? {} : { seat });
const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The model-role service (spec 2026-10-06 §4), one per worker. It holds omp's catalog: read at boot, by the daily tick,
 * by `/models set`, hourly after a failed read (F14) and after a `no_planner_leg` (F7). It reads Paco's overrides from
 * the ledger at every resolution (no restart) and applies the pure resolution in model-roles.ts. `HOUGE_MODEL_ROLES`
 * is read per call. It is the one owner of the catalog-outage incident.
 */
export class RoleResolver {
  private cat: readonly CatalogModel[] | null = null;
  private failures = 0;
  private lastReadAt: number | undefined;
  private reading: Promise<boolean> | undefined;
  /** Roles that fell back to their static list since the last catalog read (one model_roles_fallback note each). */
  private fellBack = new Set<OverrideKey>();

  constructor(private readonly d: ResolverDeps) {}

  /** One catalog read (a read in flight is joined). A failed read keeps the last good catalog (none yet = Decision 4). Never throws. */
  refreshCatalog(): Promise<boolean> {
    if (!this.reading) this.reading = this.read().finally(() => { this.reading = undefined; });
    return this.reading;
  }

  /** F14: re-read when the last read failed and is at least CATALOG_RETRY_MS old; null = nothing due (the daemon asks every poll cycle). */
  retryFailedRead(): Promise<boolean> | null {
    if (this.failures === 0 || this.reading || !this.readOlderThan(CATALOG_RETRY_MS)) return null;
    return this.refreshCatalog();
  }

  /** F7 (d): the supervisor found no planner leg; re-read unless a read ran in the last NO_LEG_REFRESH_MS. Fire-and-forget. */
  requestRefresh(): void {
    if (this.reading || !this.readOlderThan(NO_LEG_REFRESH_MS)) return;
    void this.refreshCatalog();
  }

  catalog(): readonly CatalogModel[] | null { return this.cat; }

  /**
   * The role's ordered candidates, efforts clamped (Decision 2). `effort` is the turn's routed effort; absent or null =
   * the list's own. A role the catalog emptied (F7): Fast returns [] so the supervisor steps up; every other role runs
   * its static list.
   */
  candidates(role: RoleName, o: CandidateOptions = {}): ModelString[] {
    const got = this.resolveWith(this.snapshot(), role, o);
    if (got) return got;
    return role === "fast" ? [] : this.fallback(role, o);
  }

  /**
   * The seven OmpConfig chains. A role the catalog emptied runs its static list (F7, the same rule as candidates()).
   * A judge seat keeps its index: an unresolved seat runs its static selector and fails alone (panel quorum).
   */
  chains(): RoleChains {
    const s = this.snapshot();
    const or = (role: RoleName, seat?: number): ModelString[] => this.resolveWith(s, role, seatOpt(seat)) ?? this.fallback(role, seatOpt(seat));
    return {
      planner: or("default"), reader: or("reader"), media: or("vision"), ticks: or("tiny"),
      judges: ROLE_LISTS.judges.map((_, seat) => or("judges", seat)[0] as ModelString),
      chair: or("chair"), reviewer: or("reviewer")
    };
  }

  /** Every role and judge seat as `/models` and the daily tick show it: the resolution itself, so an emptied role shows head null. */
  resolveAll(): ResolvedRole[] {
    const s = this.snapshot();
    const slots = ROLE_NAMES.flatMap<{ role: RoleName; seat?: number }>((role) =>
      (role === "judges" ? ROLE_LISTS.judges.map((_, seat) => ({ role, seat })) : [{ role }]));
    return slots.map(({ role, seat }) => {
      const key = keyOf(role, seat);
      const c = this.resolveWith(s, role, seatOpt(seat)) ?? [];
      const override = s.mode === "resolved" ? s.overrides.get(key) ?? null : null;
      const source: ResolvedRole["source"] = overrideCandidates(role, seat, override, this.cat).length > 0 ? "override" : "list";
      return { key, head: c[0] ? formatModelString(c[0]) : null, candidates: c.map(formatModelString), source };
    });
  }

  private async read(): Promise<boolean> {
    let next: CatalogModel[] | null = null;
    try { next = await this.d.readCatalog(); } catch { next = null; }
    this.lastReadAt = this.clock();
    this.fellBack.clear();
    if (next !== null && next.length > 0) { this.cat = next; this.readOk(); return true; }
    this.readFailed();
    return false;
  }

  private readOk(): void {
    this.failures = 0;
    try { resolveOpenIncidents(this.d.store, CATALOG_INCIDENT, "omp"); } catch (e) { console.warn(`[model-roles] could not resolve model_catalog_unavailable: ${why(e)}`); }
  }

  /** Decision 4: one ledger note per failed read; F14: the second consecutive failure pages Paco once (alerted incident). */
  private readFailed(): void {
    this.failures += 1;
    try {
      this.d.store.recordMemoryEvent("model_catalog_unavailable", { reason: "read_failed" }, "model_roles");
      if (this.failures >= CATALOG_INCIDENT_AFTER) {
        openAlertedIncident(this.d.store, { kind: "model_catalog_unavailable", subject: "omp", detail: { consecutive_failures: this.failures }, env: this.env() });
      }
    } catch (e) {
      console.warn(`[model-roles] could not record model_catalog_unavailable: ${why(e)}`);
    }
  }

  private readOlderThan(ms: number): boolean { return this.lastReadAt === undefined || this.clock() - this.lastReadAt >= ms; }
  private clock(): number { return (this.d.now ?? Date.now)(); }
  private env(): NodeJS.ProcessEnv { return (this.d.env ?? (() => process.env))(); }

  private snapshot(): Snapshot {
    const mode = resolveModelRolesMode(this.env());
    if (mode === "static") return { mode, overrides: new Map() };
    try {
      return { mode, overrides: this.d.store.latestModelRoleOverrides() };
    } catch (error) {
      console.warn(`[model-roles] override read failed, resolving on the lists: ${why(error)}`);
      return { mode, overrides: new Map() };
    }
  }

  /** The role resolved, refused skipped, efforts clamped; null when it resolved EMPTY before the refused filter (F7). */
  private resolveWith(s: Snapshot, role: RoleName, o: CandidateOptions): ModelString[] | null {
    const override = s.mode === "resolved" ? s.overrides.get(keyOf(role, o.seat)) ?? null : null;
    const all = resolveRole({ role, ...seatOpt(o.seat), catalog: this.cat, override, refused: NOTHING_REFUSED, mode: s.mode });
    if (all.length === 0) return null;
    const refused = o.refused ?? NOTHING_REFUSED;
    return all.filter((m) => !refused.has(selectorKey(m))).map((m) => clampEffort(m, o.effort ?? null, this.cat, s.mode));
  }

  /** F7: the role's static list, unfiltered and unclamped (minus what the child refused), noted once per role per catalog read. */
  private fallback(role: RoleName, o: CandidateOptions): ModelString[] {
    const key = keyOf(role, o.seat);
    if (!this.fellBack.has(key)) {
      this.fellBack.add(key);
      try { this.d.store.recordMemoryEvent("model_roles_fallback", { role: key }, "model_roles"); } catch (e) { console.warn(`[model-roles] could not record model_roles_fallback: ${why(e)}`); }
    }
    return resolveRole({ role, ...seatOpt(o.seat), catalog: null, override: null, refused: o.refused ?? NOTHING_REFUSED, mode: "static" });
  }
}
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `npx vitest run tests/run/run-store-model-roles.test.ts tests/omp/role-resolver.test.ts tests/run/run-ledger.test.ts && npm run typecheck`
Expected: PASS (16 tests in the two new files), typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/omp/role-resolver.ts src/run/run-store.ts tests/helpers/model-roles.ts tests/omp/role-resolver.test.ts tests/run/run-store-model-roles.test.ts
git commit -m "$(cat <<'EOF'
feat(omp): RoleResolver over omp's catalog with append-only /models override rows

Holds the catalog: a failed read keeps the last good one and leaves one
model_catalog_unavailable note (Decision 4); two in a row page Paco once and the
next good read resolves it; a failed read is retried hourly. Reads the latest
model_role_override per key at every resolution, honours HOUGE_MODEL_ROLES per
call, and never hands out an empty role: Fast steps up, every other role runs
its static list (one model_roles_fallback note per role per read).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

#### 7b — config, seat consumers, D10 skip rule, boot read and hourly retry

- [ ] **Step 8: Write the failing tests (and update the tests this change breaks)**

Why each change:
- `omp-config`: the chains come from the caller, a retired variable is inert, and a stale `.env` line is named once.
- `omp.test`: the D10 skip rule in resolved mode, and static order (F2).
- `seat-routing`:
  - `tickSeat` reads its chains per call;
  - the existing D10 collapse test needs an all-Gemini reader, because a cross-family leg would now run first.
- `core-worker-reader-family`: rewritten over `pinnedRoles`.
- `core-worker-omp-turn`: the worker's resolver has read no catalog, so Default is the whole `ROLE_LISTS.default`
  (second leg `google-antigravity/claude-opus-5-5`). `HOUGE_OMP_PLANNER` / `HOUGE_OMP_READER` are inert, so the
  malformed-config tests use the lease TTL.
- `core-worker-runner-caps`: expected budgets read the worker's own resolver.
- `telegram-daemon`: the boot read, the retired-variable warning, and the per-cycle retry offer.
- `houge-status`, `media-call`, `idea-panel-seats`, `diff-reviewer`: each seat takes `chains`.
- `planner-supervisor`: the harness gets `o.planner` instead of `HOUGE_OMP_PLANNER`.
- Helpers:
  - `omp-env` pins `HOUGE_MODEL_ROLES` and the retired variables;
  - `omp-worker` passes `roles`;
  - `fake-omp` answers `models --json`.

Replace `tests/core/core-worker-reader-family.test.ts` with:

```ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoreWorker } from "../../src/core/core-worker.js";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import type { RoleResolver } from "../../src/omp/role-resolver.js";
import { RunStore } from "../../src/run/run-store.js";
import type { ToolAdapterResult } from "../../src/tools/tool-registry.js";
import { fixtureCatalog, pinnedRoles } from "../helpers/model-roles.js";
import { FAKE_OMP_BIN, pinEnabledFlags, pinOmpEnv, shortTmp, tmpOmpDist } from "../helpers/omp-env.js";
import { bridgeTurn } from "../helpers/omp-worker.js";

// Ruling 9 / D10, a skip rule since the Jev tree (spec 2026-10-06 §8). The quarantined reader is built with the calling
// turn's CURRENT planner family. The reader's candidates of another family run first. Only when every candidate shares
// the planner's family does the read proceed, audited as a collapse (family_collapse plus a wall_collapse event).
// Production seats: no injected LLM. The reader is a real spawnOneShot against tests/fixtures/fake-omp.mjs, on the
// chains the worker's RoleResolver hands it.
pinOmpEnv();
pinEnabledFlags();
let tmp: { dir: string; cleanup: () => void };
let store: RunStore;
beforeEach(() => { tmp = shortTmp("hrf-"); store = RunStore.openInMemory(); });
afterEach(() => { store.close(); tmp.cleanup(); });

const EXTRACTION = JSON.stringify({ summary: "ASML beat estimates", facts: [], time_claims: [], answer_to_objective: null, contains_instructions: false });

function useFake(): void {
  writeFileSync(join(tmp.dir, "s.json"), JSON.stringify({ "*": { text: EXTRACTION } }));
  process.env.HOUGE_OMP_BIN = FAKE_OMP_BIN;
  process.env.HOUGE_OMP_SANDBOX = "0";
  process.env.HOUGE_OMP_ENV_PASSTHROUGH = "FAKE_OMP_SCENARIO";
  process.env.FAKE_OMP_SCENARIO = join(tmp.dir, "s.json");
}

async function readOnce(roles?: RoleResolver): Promise<string> {
  const intake = new Gateway(store).intake(buildTypedTaskEvent({
    source: "telegram", type: "turn", program: "turn", goal: "ASML news", requested_by: { kind: "user", id: "paco" },
    notify: { kind: "telegram", chat_id: "555" }, idempotency_key: "t:rf", source_reference: "telegram:update:1:message:1"
  }));
  if (!intake.ok) throw new Error("intake failed");
  const web = async (): Promise<ToolAdapterResult> => ({ ok: true, output: { provider: "fake", results: [{ title: "t", url: "https://a.example/", snippet: "raw" }] } });
  const worker = new CoreWorker(store, join(tmp.dir, "project"), undefined, web, undefined, undefined, undefined, undefined, undefined, async () => null,
    undefined, undefined, { dataDir: tmp.dir, distDir: tmpOmpDist(tmp.dir), ...(roles ? { roles } : {}) });
  // The chat's supervisor exists once its first turn is submitted; create it without starting a child.
  (worker as unknown as { supervisorFor(chat: string): unknown }).supervisorFor("555");
  const r = await bridgeTurn(store, worker, intake.run_id, tmp.dir).call("web_search", { query: "ASML" });
  expect(r.content).toContain("ASML beat estimates");
  return intake.run_id;
}

const readerRow = (run_id: string) => store.getLedgerEvents(run_id).find((e) => e.event_type === "llm_attempt" && e.payload.role === "reader")?.payload;
const collapses = (run_id: string) => store.getLedgerEvents(run_id).filter((e) => e.event_type === "wall_collapse");

describe("the reader seat knows the planner's family (D10 skip rule, audited degradation)", () => {
  it("every reader candidate on the planner's family (claude): the read answers, recording family_collapse + wall_collapse", async () => {
    useFake();
    // A one-model catalog: Default resolves to Opus (planner family claude) and the reader override leaves only Opus.
    const roles = await pinnedRoles(store, fixtureCatalog().filter((m) => m.provider === "anthropic" && m.id === "claude-opus-5-5"), { reader: "claude-opus-5-5" });
    const run_id = await readOnce(roles);
    expect(readerRow(run_id)).toMatchObject({ family: "claude", family_collapse: true });
    expect(collapses(run_id)).toHaveLength(1);
  });

  it("a reader chain that starts on the planner's family runs its first cross-family candidate first: no collapse", async () => {
    useFake();
    // The full catalog: the override puts Opus first (claude, the planner's family), then the list (gemini, k3, gpt).
    const roles = await pinnedRoles(store, fixtureCatalog(), { reader: "anthropic/claude-opus-5-5" });
    expect(roles.chains().reader[0]?.model).toBe("claude-opus-5-5");
    const run_id = await readOnce(roles);
    expect(readerRow(run_id)).toMatchObject({ family: "gemini" });
    expect(readerRow(run_id)?.family_collapse).toBeUndefined();
    expect(collapses(run_id)).toEqual([]);
  });

  it("the default reader list (gemini first, no catalog read) records no collapse", async () => {
    useFake();
    const run_id = await readOnce();
    expect(readerRow(run_id)).toMatchObject({ family: "gemini" });
    expect(readerRow(run_id)?.family_collapse).toBeUndefined();
    expect(collapses(run_id)).toEqual([]);
  });
});
```

Apply these hunks (each old text is unique in its file at this point of the plan):

`tests/omp/omp-config.test.ts` hunk 1 (near line 1). Replace:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIN_LEASE_TTL_S, OMP_ENV_VARS, ompConfigProblems, PLANNER_HEARTBEAT_MS, resolveOmpConfig } from "../../src/omp/omp-config.js";

const saved: Record<string, string | undefined> = {};
beforeEach(() => { for (const k of OMP_ENV_VARS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of OMP_ENV_VARS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe("omp config — defaults are the decided seat chains (spec §8, D7, D10)", () => {
```

with:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MIN_LEASE_TTL_S, OMP_ENV_VARS, ompConfigProblems, PLANNER_HEARTBEAT_MS, RETIRED_OMP_CHAIN_VARS, resolveOmpConfig, warnRetiredOmpChainVars
} from "../../src/omp/omp-config.js";
import { staticRoleChains } from "../../src/omp/model-roles.js";
import { parseModelChain } from "../../src/omp/model-string.js";

const saved: Record<string, string | undefined> = {};
const PINNED = [...OMP_ENV_VARS, ...RETIRED_OMP_CHAIN_VARS];
beforeEach(() => { for (const k of PINNED) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of PINNED) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

// With no RoleResolver, the chains are the static role lists: today's HOUGE_OMP_* defaults (spec §4.3 rollback parity).
describe("omp config — defaults are the decided seat chains (spec §8, D7, D10)", () => {
```

`tests/omp/omp-config.test.ts` hunk 2 (near line 26). Replace:

```ts

  it("reads overrides and rejects a malformed chain at resolve time", () => {
    expect(resolveOmpConfig({ HOUGE_OMP_TICKS: "kimi-code/k3:high" }).ticks[0]?.effort).toBe("high");
    expect(resolveOmpConfig({ HOUGE_OMP_SANDBOX: "0" }).sandbox).toBe(false);
    expect(() => resolveOmpConfig({ HOUGE_OMP_PLANNER: "nonsense" })).toThrow();
  });
```

with:

```ts

  // Spec 2026-10-06 §4.2: the model roles own every seat chain. A stale HOUGE_OMP_* line in .env must neither steer a
  // seat nor fail the config check that refuses every turn (omp_config_invalid).
  it("takes its chains from the caller (the RoleResolver), never from a retired env variable", () => {
    const chains = { ...staticRoleChains(), ticks: parseModelChain("google-antigravity/gemini-3.8-flash:low") };
    expect(resolveOmpConfig({ HOUGE_OMP_TICKS: "kimi-code/k3:high" }, chains).ticks).toEqual(chains.ticks);
    expect(resolveOmpConfig({ HOUGE_OMP_PLANNER: "nonsense" }).planner).toEqual(staticRoleChains().planner);
    expect(ompConfigProblems({ HOUGE_OMP_PLANNER: "nonsense" })).toEqual([]);
    expect(OMP_ENV_VARS).not.toContain("HOUGE_OMP_PLANNER");
    expect(resolveOmpConfig({ HOUGE_OMP_SANDBOX: "0" }).sandbox).toBe(false);
  });

  it("names a still-set retired chain variable once per process, so a stale .env is visible but never fatal", () => {
    const lines: string[] = [];
    expect(warnRetiredOmpChainVars({ HOUGE_OMP_PLANNER: "kimi-code/k3", HOUGE_OMP_READER: " " }, (l) => lines.push(l))).toEqual(["HOUGE_OMP_PLANNER"]);
    expect(warnRetiredOmpChainVars({ HOUGE_OMP_PLANNER: "kimi-code/k3" }, (l) => lines.push(l))).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("HOUGE_OMP_PLANNER");
  });
```

`tests/llm/providers/omp.test.ts` hunk 1 (near line 15). Replace:

```ts
beforeEach(() => {
  for (const k of [...OMP_ENV_VARS, "FAKE_OMP_SCENARIO", "FAKE_OMP_ARGV_LOG"]) { saved[k] = process.env[k]; delete process.env[k]; }
  dir = mkdtempSync(join(tmpdir(), "houge-omp-oneshot-"));
```

with:

```ts
beforeEach(() => {
  for (const k of [...OMP_ENV_VARS, "FAKE_OMP_SCENARIO", "FAKE_OMP_ARGV_LOG", "HOUGE_MODEL_ROLES"]) { saved[k] = process.env[k]; delete process.env[k]; }
  dir = mkdtempSync(join(tmpdir(), "houge-omp-oneshot-"));
```

`tests/llm/providers/omp.test.ts` hunk 2 (near line 122). Replace:

```ts
    expect(audit.attempts[0]).toMatchObject({ outcome: "ok", family_collapse: true });
  });
```

with:

```ts
    expect(audit.attempts[0]).toMatchObject({ outcome: "ok", family_collapse: true });
  });

  // Spec 2026-10-06 §8: D10 becomes a skip rule in resolved mode (the default). The wall between planner and reader holds
  // when the reader's model is from another family, so a reader chain that starts on the planner's family must run its
  // cross-family candidates first.
  it("D10 skip rule: a reader chain that starts on the planner's family runs its cross-family candidates first", async () => {
    const cfg = setup({ "*": { text: "ok" } });
    const audit = recordingSink();
    await spawnOneShot(
      { seat: "reader", chain: parseModelChain("anthropic/claude-opus-5-5:low,google-antigravity/gemini-3.8-flash:low,kimi-code/k3:low"),
        prompt: "x", correlationId: "c", plannerFamily: "claude" },
      { cfg, audit, versionCheck: () => ({ ok: true, version: "18.4.4" }) }
    );
    expect(argvLog().map((c: { argv: string[] }) => c.argv[c.argv.indexOf("--model") + 1])).toEqual(["google-antigravity/gemini-3.8-flash"]);
    expect(audit.attempts[0]).toMatchObject({ outcome: "ok", family: "gemini" });
    expect(audit.attempts[0]?.family_collapse).toBeUndefined();
  });

  it("D10 skip rule: once every cross-family leg has failed, the same-family leg still answers, flagged family_collapse", async () => {
    const cfg = setup({
      "google-antigravity/gemini-3.8-flash": { text: "", stopReason: "error", errorMessage: "429 usage limit reached" },
      "kimi-code/k3": { text: "", stopReason: "error", errorMessage: "429 usage limit reached" },
      "anthropic/claude-opus-5-5": { text: "from claude" }
    });
    const audit = recordingSink();
    const r = await spawnOneShot(
      { seat: "reader", chain: parseModelChain("anthropic/claude-opus-5-5:low,google-antigravity/gemini-3.8-flash:low,kimi-code/k3:low"),
        prompt: "x", correlationId: "c", plannerFamily: "claude" },
      { cfg, audit, versionCheck: () => ({ ok: true, version: "18.4.4" }) }
    );
    expect(r).toMatchObject({ ok: true, answer: "from claude" });
    expect(audit.attempts.map((a) => [a.model, a.outcome, a.family_collapse]))
      .toEqual([["gemini-3.8-flash", "error", undefined], ["k3", "error", undefined], ["claude-opus-5-5", "ok", true]]);
  });

  it("D10 skip rule: when every candidate shares the planner's family, the order stands and every leg is flagged", async () => {
    const cfg = setup({ "kimi-code/k3": { text: "", stopReason: "error", errorMessage: "429 usage limit reached" }, "kimi-code/k3-256k": { text: "ok" } });
    const audit = recordingSink();
    await spawnOneShot(
      { seat: "reader", chain: parseModelChain("kimi-code/k3:low,kimi-code/k3-256k:low"), prompt: "x", correlationId: "c", plannerFamily: "kimi" },
      { cfg, audit, versionCheck: () => ({ ok: true, version: "18.4.4" }) }
    );
    expect(audit.attempts.map((a) => [a.model, a.family_collapse])).toEqual([["k3", true], ["k3-256k", true]]);
  });

  it("only the reader seat is reordered: any other seat runs its chain as listed", async () => {
    const cfg = setup({ "*": { text: "ok" } });
    await spawnOneShot(
      { seat: "chair", chain: parseModelChain("anthropic/claude-opus-5-5:low,google-antigravity/gemini-3.8-flash:low"), prompt: "x", correlationId: "c", plannerFamily: "claude" },
      { cfg, audit: recordingSink(), versionCheck: () => ({ ok: true, version: "18.4.4" }) }
    );
    expect(argvLog().map((c: { argv: string[] }) => c.argv[c.argv.indexOf("--model") + 1])).toEqual(["anthropic/claude-opus-5-5"]);
  });

  it("HOUGE_MODEL_ROLES=static keeps the reader chain's order exactly, flagging the same-family leg as before stage A (§4.3)", async () => {
    process.env.HOUGE_MODEL_ROLES = "static"; // restored by this file's afterEach
    const cfg = setup({ "*": { text: "ok" } });
    const audit = recordingSink();
    await spawnOneShot(
      { seat: "reader", chain: parseModelChain("anthropic/claude-opus-5-5:low,google-antigravity/gemini-3.8-flash:low"), prompt: "x", correlationId: "c", plannerFamily: "claude" },
      { cfg, audit, versionCheck: () => ({ ok: true, version: "18.4.4" }) }
    );
    expect(argvLog().map((c: { argv: string[] }) => c.argv[c.argv.indexOf("--model") + 1])).toEqual(["anthropic/claude-opus-5-5"]);
    expect(audit.attempts[0]).toMatchObject({ outcome: "ok", family: "claude", family_collapse: true });
  });
```

`tests/llm/seat-routing.test.ts` hunk 1 (near line 6). Replace:

```ts
import { resolveOmpConfig } from "../../src/omp/omp-config.js";
import { familyOf } from "../../src/omp/model-string.js";
import { judgeSeat, oneShotAdapter, seatBudgetMs, seatChain, tickSeat } from "../../src/llm/registry.js";
```

with:

```ts
import { resolveOmpConfig } from "../../src/omp/omp-config.js";
import { familyOf, parseModelChain } from "../../src/omp/model-string.js";
import { staticRoleChains } from "../../src/omp/model-roles.js";
import { judgeSeat, oneShotAdapter, seatBudgetMs, seatChain, tickSeat } from "../../src/llm/registry.js";
```

`tests/llm/seat-routing.test.ts` hunk 2 (near line 126). Replace:

```ts

  it("a tick call under the daemon's stop spawns nothing and records no attempt (a shutdown is not a failing leg)", async () => {
```

with:

```ts

  // A /models override must reach the daemon's ticks without a restart: tickSeat reads its chains at call time.
  it("a tick seat runs on the chains its resolver hands it at call time", async () => {
    fakeCfg({ "*": { text: "fine" } });
    Object.assign(process.env, { HOUGE_OMP_BIN: FAKE_OMP_BIN, HOUGE_OMP_SANDBOX: "0", HOUGE_OMP_ENV_PASSTHROUGH: "FAKE_OMP_SCENARIO,FAKE_OMP_ARGV_LOG" });
    let ticks = parseModelChain("kimi-code/k3:low");
    const seat = tickSeat(store, "episodic_distill", "distill", process.env, () => ({ ...staticRoleChains(), ticks }));
    await seat({ question: "q", system: "s" });
    ticks = parseModelChain("google-antigravity/gemini-3.8-flash:low");
    await seat({ question: "q", system: "s" });
    expect(argv().map((c) => c.argv[c.argv.indexOf("--model") + 1])).toEqual(["kimi-code/k3", "google-antigravity/gemini-3.8-flash"]);
  });

  it("a tick call under the daemon's stop spawns nothing and records no attempt (a shutdown is not a failing leg)", async () => {
```

`tests/llm/seat-routing.test.ts` hunk 3 (near line 145). Replace:

```ts

  it("a reader on the planner's family still answers and records family_collapse + a wall_collapse event (D10)", async () => {
    const cfg = fakeCfg({ "*": { text: "digest" } });
    const r = await oneShotAdapter(store, cfg, { correlation_id: "tick:w", role: "reader" }, "gemini").answer({ question: "q" });
```

with:

```ts

  // D10 skip rule (spec 2026-10-06 §8): a cross-family reader leg would run first, so the collapse needs a reader chain
  // whose every candidate shares the planner's family.
  it("a reader whose every candidate is on the planner's family still answers and records family_collapse + a wall_collapse event (D10)", async () => {
    const cfg = { ...fakeCfg({ "*": { text: "digest" } }), reader: parseModelChain("google-antigravity/gemini-3.8-flash:low") };
    const r = await oneShotAdapter(store, cfg, { correlation_id: "tick:w", role: "reader" }, "gemini").answer({ question: "q" });
```

`tests/core/core-worker-omp-turn.test.ts` hunk 1 (near line 13). Replace:

```ts
import { createQueuedTurnRun } from "../helpers/runs.js";
```

with:

```ts
import { createQueuedTurnRun } from "../helpers/runs.js";
import { fixtureCatalog, pinnedRoles } from "../helpers/model-roles.js";
```

`tests/core/core-worker-omp-turn.test.ts` hunk 2 (near line 103). Replace:

```ts
    expect(drainOutbox(store).get(`${run}:final_report`)?.text).toBe("from the second string");
    expect(events(run, "llm_attempt").map((e) => [e.payload.model, e.payload.error_kind])).toEqual([["claude-opus-5-5", "model_missing"], ["claude-opus-4-6", undefined]]);
    expect(events(run, "run_failed")).toEqual([]);
    const spawned = fakeLog(join(tmp.dir, "argv.log")).filter((l) => Array.isArray(l.argv) && (l.argv as string[]).includes("rpc"));
    expect(spawned.map((l) => (l.argv as string[])[(l.argv as string[]).indexOf("--model") + 1])).toEqual(["anthropic/claude-opus-5-5", "google-antigravity/claude-opus-4-6"]);
  });
```

with:

```ts
    expect(drainOutbox(store).get(`${run}:final_report`)?.text).toBe("from the second string");
    // The worker's resolver has read no catalog here, so Default is its whole resolved list (Decision 4): the second leg
    // is google-antigravity/claude-opus-5-5 (both legs are claude-opus-5-5, so the provider is asserted too).
    expect(events(run, "llm_attempt").map((e) => [e.payload.provider, e.payload.model, e.payload.error_kind]))
      .toEqual([["anthropic", "claude-opus-5-5", "model_missing"], ["google-antigravity", "claude-opus-5-5", undefined]]);
    expect(events(run, "run_failed")).toEqual([]);
    const spawned = fakeLog(join(tmp.dir, "argv.log")).filter((l) => Array.isArray(l.argv) && (l.argv as string[]).includes("rpc"));
    expect(spawned.map((l) => (l.argv as string[])[(l.argv as string[]).indexOf("--model") + 1])).toEqual(["anthropic/claude-opus-5-5", "google-antigravity/claude-opus-5-5"]);
  });
```

`tests/core/core-worker-omp-turn.test.ts` hunk 3 (near line 123). Replace:

```ts
    expect(pin).toBeLessThan(firstPrompt);
    expect(cmds[pin]).toMatchObject({ provider: "google-antigravity", modelId: "claude-opus-4-6" });
    expect(events(run, "llm_attempt").map((e) => [e.payload.provider, e.payload.model, e.payload.error_kind]))
      .toEqual([["anthropic", "claude-opus-5-5", "model_missing"], ["google-antigravity", "claude-opus-4-6", undefined]]);
  });

  it("a refused pin: the turn answers on the resumed model, and the planner family is that ACTUAL model's (D10)", async () => {
    process.env.HOUGE_OMP_PLANNER = "kimi-code/k3"; // restored by pinOmpEnv
    useFakeOmp({ rpcResumeModel: "anthropic/claude-opus-5-5", rpcSetModelError: "no such model", "*": { rpcText: "answered" } }, tmp.dir);
    worker = ompWorker(store, tmp.dir);
    const run = createQueuedTurnRun(store, "hello");
```

with:

```ts
    expect(pin).toBeLessThan(firstPrompt);
    expect(cmds[pin]).toMatchObject({ provider: "google-antigravity", modelId: "claude-opus-5-5" }); // same id, another provider: sameModel compares both
    expect(events(run, "llm_attempt").map((e) => [e.payload.provider, e.payload.model, e.payload.error_kind]))
      .toEqual([["anthropic", "claude-opus-5-5", "model_missing"], ["google-antigravity", "claude-opus-5-5", undefined]]);
  });

  it("a refused pin: the turn answers on the resumed model, and the planner family is that ACTUAL model's (D10)", async () => {
    useFakeOmp({ rpcResumeModel: "anthropic/claude-opus-5-5", rpcSetModelError: "no such model", "*": { rpcText: "answered" } }, tmp.dir);
    // Default resolves to k3 alone over a kimi-only catalog (the pre-roles HOUGE_OMP_PLANNER=kimi-code/k3).
    worker = ompWorker(store, tmp.dir, { roles: await pinnedRoles(store, fixtureCatalog().filter((m) => m.provider === "kimi-code")) });
    const run = createQueuedTurnRun(store, "hello");
```

`tests/core/core-worker-omp-turn.test.ts` hunk 4 (near line 176). Replace:

```ts

  it("a malformed HOUGE_OMP_* chain never makes submitTurn throw: the run fails with the unavailable reply and one alerted incident (B4)", () => {
    process.env.HOUGE_OMP_PLANNER = "anthropic/claude-opus-5-5:medium,kimi-code/k3:lo";
    process.env.HOUGE_TELEGRAM_CHAT_ID = "555";
```

with:

```ts

  it("a malformed omp config never makes submitTurn throw: the run fails with the unavailable reply and one alerted incident (B4)", () => {
    process.env.HOUGE_OMP_LEASE_TTL_S = "20"; // under 3x the heartbeat: the config value still validated (restored by pinOmpEnv)
    process.env.HOUGE_TELEGRAM_CHAT_ID = "555";
```

`tests/core/core-worker-omp-turn.test.ts` hunk 5 (near line 187). Replace:

```ts
      expect(out.get(`${a}:final_report`)?.text).toBe(TURN_UNAVAILABLE_TEXT);
      expect(store.listOpenIncidents().map((i) => [i.kind, JSON.parse(i.detail_json ?? "{}").invalid])).toEqual([["omp_config_invalid", ["HOUGE_OMP_PLANNER"]]]);
      expect([...out.keys()].filter((k) => k.startsWith("incident_opened:"))).toHaveLength(1); // paged once, not per message
```

with:

```ts
      expect(out.get(`${a}:final_report`)?.text).toBe(TURN_UNAVAILABLE_TEXT);
      expect(store.listOpenIncidents().map((i) => [i.kind, JSON.parse(i.detail_json ?? "{}").invalid])).toEqual([["omp_config_invalid", ["HOUGE_OMP_LEASE_TTL_S"]]]);
      expect([...out.keys()].filter((k) => k.startsWith("incident_opened:"))).toHaveLength(1); // paged once, not per message
```

`tests/core/core-worker-omp-turn.test.ts` hunk 6 (near line 213). Replace:

```ts

  it("the boot check pages a malformed chain once, and a valid config resolves it (B4)", () => {
    process.env.HOUGE_OMP_READER = "not a model string";
    worker = ompWorker(store, tmp.dir);
    expect(worker.validateOmpConfig()).toBe(false);
    expect(store.listOpenIncidents().map((i) => i.kind)).toEqual(["omp_config_invalid"]);
    delete process.env.HOUGE_OMP_READER;
    expect(worker.validateOmpConfig()).toBe(true);
```

with:

```ts

  it("the boot check pages a malformed omp config once, and a valid config resolves it (B4)", () => {
    process.env.HOUGE_OMP_LEASE_TTL_S = "20";
    worker = ompWorker(store, tmp.dir);
    expect(worker.validateOmpConfig()).toBe(false);
    expect(store.listOpenIncidents().map((i) => i.kind)).toEqual(["omp_config_invalid"]);
    delete process.env.HOUGE_OMP_LEASE_TTL_S;
    expect(worker.validateOmpConfig()).toBe(true);
```

`tests/core/core-worker-runner-caps.test.ts` hunk 1 (near line 6). Replace:

```ts
import { resolveOmpConfig } from "../../src/omp/omp-config.js";
import { RunStore, type LlmCallRole } from "../../src/run/run-store.js";
```

with:

```ts
import { resolveOmpConfig } from "../../src/omp/omp-config.js";
import { RoleResolver } from "../../src/omp/role-resolver.js";
import { RunStore, type LlmCallRole } from "../../src/run/run-store.js";
```

`tests/core/core-worker-runner-caps.test.ts` hunk 2 (near line 17). Replace:

```ts
let store: RunStore;
beforeEach(() => { tmp = shortTmp("hrc-"); store = RunStore.openInMemory(); });
afterEach(() => { store.close(); tmp.cleanup(); delete process.env.HOUGE_WIKI_VERIFY_PASSES; });
```

with:

```ts
let store: RunStore;
/** The worker's seats run on its RoleResolver's chains (model roles), so the expected budgets read the same chains. */
let roles: RoleResolver;
beforeEach(() => {
  tmp = shortTmp("hrc-"); store = RunStore.openInMemory();
  roles = new RoleResolver({ store, env: () => ({}), readCatalog: async () => null });
});
afterEach(() => { store.close(); tmp.cleanup(); delete process.env.HOUGE_WIKI_VERIFY_PASSES; });
```

`tests/core/core-worker-runner-caps.test.ts` hunk 3 (near line 26). Replace:

```ts
  if (!intake.ok) throw new Error("intake failed");
  const t = bridgeTurn(store, ompWorker(store, tmp.dir, { project: join(tmp.dir, "project") }), intake.run_id, tmp.dir);
  return (tool) => t.turn.registry.get(tool)?.timeout_ms;
}
const seat = (role: LlmCallRole) => seatBudgetMs(resolveOmpConfig(process.env), role) + RUNNER_TIMEOUT_BUFFER_MS;
```

with:

```ts
  if (!intake.ok) throw new Error("intake failed");
  const t = bridgeTurn(store, ompWorker(store, tmp.dir, { project: join(tmp.dir, "project"), roles }), intake.run_id, tmp.dir);
  return (tool) => t.turn.registry.get(tool)?.timeout_ms;
}
const seat = (role: LlmCallRole) => seatBudgetMs(resolveOmpConfig(process.env, roles.chains()), role) + RUNNER_TIMEOUT_BUFFER_MS;
```

`tests/telegram/telegram-daemon.test.ts` hunk 1 (near line 20). Replace:

```ts
import { PLANNER_EXIT_TEXT } from "../../src/omp/planner-supervisor.js";
import { pinOmpEnv, tmpOmpDist, useFakeOmp } from "../helpers/omp-env.js";
```

with:

```ts
import { PLANNER_EXIT_TEXT } from "../../src/omp/planner-supervisor.js";
import { RoleResolver } from "../../src/omp/role-resolver.js";
import { pinOmpEnv, tmpOmpDist, useFakeOmp } from "../helpers/omp-env.js";
```

`tests/telegram/telegram-daemon.test.ts` hunk 2 (near line 1142). Replace:

```ts

  it("boot validates the omp seat chains: a malformed chain opens omp_config_invalid before the first poll (B4)", async () => {
    const store = RunStore.openInMemory();
    const root = projectRoot();
    process.env.HOUGE_OMP_TICKS = "kimi-code/k3:lo";
    try {
```

with:

```ts

  it("boot validates the omp config: a malformed value opens omp_config_invalid before the first poll (B4)", async () => {
    const store = RunStore.openInMemory();
    const root = projectRoot();
    process.env.HOUGE_OMP_LEASE_TTL_S = "20";
    try {
```

`tests/telegram/telegram-daemon.test.ts` hunk 3 (near line 1150). Replace:

```ts
        telegramClient: { getUpdates: async () => [], sendMessage: async () => ({ message_id: 1 }) } as never });
      expect(store.listOpenIncidents().map((i) => [i.kind, JSON.parse(i.detail_json).invalid])).toEqual([["omp_config_invalid", ["HOUGE_OMP_TICKS"]]]);
    } finally {
```

with:

```ts
        telegramClient: { getUpdates: async () => [], sendMessage: async () => ({ message_id: 1 }) } as never });
      expect(store.listOpenIncidents().map((i) => [i.kind, JSON.parse(i.detail_json).invalid])).toEqual([["omp_config_invalid", ["HOUGE_OMP_LEASE_TTL_S"]]]);
    } finally {
      store.close();
    }
  });

  // Decision 4 / spec §4: the daemon reads omp's catalog once before the first turn. An unreadable catalog must be
  // visible (one ledger note) and must leave every role on its code list, never an empty chain.
  it("boot reads omp's model catalog once before the first poll; an unreadable catalog leaves one note", async () => {
    const store = RunStore.openInMemory();
    const root = projectRoot();
    try {
      const controller = new AbortController(); controller.abort();
      await runTelegramDaemon({ store, projectRoot: root, omp: fakeOmp(root, { modelsExit: 1 }), allowlist: ALLOWLIST, stopSignal: controller.signal,
        telegramClient: { getUpdates: async () => [], sendMessage: async () => ({ message_id: 1 }) } as never });
      expect(store.getLedgerEvents().filter((e) => e.event_type === "model_catalog_unavailable").map((e) => e.payload)).toEqual([{ reason: "read_failed" }]);
    } finally {
      store.close();
    }
  });

  it("a readable catalog at boot leaves no unavailable note", async () => {
    const store = RunStore.openInMemory();
    const root = projectRoot();
    try {
      const controller = new AbortController(); controller.abort();
      await runTelegramDaemon({ store, projectRoot: root, omp: fakeOmp(root), allowlist: ALLOWLIST, stopSignal: controller.signal,
        telegramClient: { getUpdates: async () => [], sendMessage: async () => ({ message_id: 1 }) } as never });
      expect(store.getLedgerEvents().filter((e) => e.event_type === "model_catalog_unavailable")).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("boot names a still-set retired HOUGE_OMP_* chain variable once (a stale .env is visible, never fatal)", async () => {
    const store = RunStore.openInMemory();
    const root = projectRoot();
    process.env.HOUGE_OMP_PLANNER = "kimi-code/k3"; // restored by pinOmpEnv
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const controller = new AbortController(); controller.abort();
      await runTelegramDaemon({ store, projectRoot: root, omp: fakeOmp(root), allowlist: ALLOWLIST, stopSignal: controller.signal,
        telegramClient: { getUpdates: async () => [], sendMessage: async () => ({ message_id: 1 }) } as never });
      expect(warn.mock.calls.flat().filter((l) => String(l).includes("HOUGE_OMP_PLANNER"))).toHaveLength(1);
    } finally {
      warn.mockRestore();
      store.close();
    }
  });

  // F14: one failed boot read must not leave the roles a day on stale lists. The poll loop offers the resolver its
  // hourly retry each cycle; the resolver owns the window (tests/omp/role-resolver.test.ts).
  it("each poll cycle offers the resolver its hourly retry of a failed catalog read", async () => {
    const store = RunStore.openInMemory();
    const root = projectRoot();
    const roles = new RoleResolver({ store, env: () => ({}), readCatalog: async () => null });
    let offered = 0;
    roles.retryFailedRead = () => { offered += 1; return null; };
    try {
      const controller = new AbortController();
      await runTelegramDaemon({ store, projectRoot: root, omp: { ...fakeOmp(root), roles }, allowlist: ALLOWLIST, stopSignal: controller.signal,
        telegramClient: { getUpdates: stopOnSecondPoll(controller), sendMessage: async () => ({ message_id: 1 }) } as never });
      expect(offered).toBeGreaterThanOrEqual(1);
    } finally {
```

`tests/status/houge-status.test.ts` hunk 1 (near line 6). Replace:

```ts
import { RunStore, type DaemonBootInput } from "../../src/run/run-store.js";
import { classifyBoot, collectHougeStatus, isBuildStale, readBootCode, renderHougeStatus, HOUGE_STATUS_MAX_CHARS, type StatusSupervisor } from "../../src/status/houge-status.js";
```

with:

```ts
import { RunStore, type DaemonBootInput } from "../../src/run/run-store.js";
import { staticRoleChains } from "../../src/omp/model-roles.js";
import { parseModelChain } from "../../src/omp/model-string.js";
import { classifyBoot, collectHougeStatus, isBuildStale, readBootCode, renderHougeStatus, HOUGE_STATUS_MAX_CHARS, type StatusSupervisor } from "../../src/status/houge-status.js";
```

`tests/status/houge-status.test.ts` hunk 2 (near line 54). Replace:

```ts
describe("houge_status rendering", () => {
  it("renders every field from the seeded store and the boot record", () => {
```

with:

```ts
describe("houge_status rendering", () => {
  // houge_status answers "which model am I on": once roles resolve, the head it reports must be the resolved one.
  it("reports the planner and reader heads the model roles resolve to, not a fixed chain", () => {
    const store = seeded();
    const chains = { ...staticRoleChains(), planner: parseModelChain("kimi-code/k3:low"), reader: parseModelChain("google-antigravity/gemini-3.8-flash:low") };
    const s = collectHougeStatus({ store, env, chatId: "555", pid: 4242, now: NOW, chains });
    expect([s.plannerTop, s.readerTop]).toEqual(["kimi-code/k3:low", "google-antigravity/gemini-3.8-flash:low"]);
    store.close();
  });

  it("renders every field from the seeded store and the boot record", () => {
```

`tests/media/media-call.test.ts` hunk 1 (near line 9). Replace:

```ts
import { FAKE_OMP_BIN, pinOmpEnv } from "../helpers/omp-env.js";
```

with:

```ts
import { FAKE_OMP_BIN, pinOmpEnv } from "../helpers/omp-env.js";
import { staticRoleChains } from "../../src/omp/model-roles.js";
import { parseModelChain } from "../../src/omp/model-string.js";
```

`tests/media/media-call.test.ts` hunk 2 (near line 41). Replace:

```ts
describe("buildMediaCall — which leg reads a photo and which hears a voice note", () => {
  it("a photo is ONE omp one-shot on cfg.media with the image as an @path argument, audited as reader", async () => {
```

with:

```ts
describe("buildMediaCall — which leg reads a photo and which hears a voice note", () => {
  // The photo seat is the Vision role: a /models vision override must change which model reads the image.
  it("a photo runs on the Vision role the resolver hands it (chains.media)", async () => {
    const file = path.join(mediaDir, "media.jpg");
    writeFileSync(file, "jpeg");
    const chains = { ...staticRoleChains(), media: parseModelChain("kimi-code/k3:low") };
    await buildMediaCall({ store, run_id: "run_vis", kind: "photo", env: process.env, chains })({ question: "describe", system: "reader", media: { path: file, mime: "image/jpeg" } });
    expect(ompSpawns()[0]?.argv).toContain("kimi-code/k3");
  });

  it("a photo is ONE omp one-shot on cfg.media with the image as an @path argument, audited as reader", async () => {
```

`tests/capabilities/idea-panel-seats.test.ts` hunk 1 (near line 6). Replace:

```ts
import { resolveOmpConfig } from "../../src/omp/omp-config.js";
import { formatModelString } from "../../src/omp/model-string.js";
import { RunStore } from "../../src/run/run-store.js";
```

with:

```ts
import { resolveOmpConfig } from "../../src/omp/omp-config.js";
import { formatModelString, parseModelChain } from "../../src/omp/model-string.js";
import { staticRoleChains } from "../../src/omp/model-roles.js";
import { RunStore } from "../../src/run/run-store.js";
```

`tests/capabilities/idea-panel-seats.test.ts` hunk 2 (near line 71). Replace:

```ts

  it("a judge index past the configured list is unavailable instead of borrowing another seat's model", async () => {
    const env = { ...fake({ "*": { text: "x" } }), HOUGE_OMP_JUDGES: "kimi-code/k3" };
    const seats = buildOmpPanelSeats({ store, correlation_id: "tick:idea_panel", env });
    expect(await seats.codexJudge({ digest: "d", system: "s" })).toEqual({ ok: false, unavailable: true });
    expect(spawns()).toEqual([]);
    expect(formatModelString(resolveOmpConfig(env).judges[0]!)).toBe("kimi-code/k3");
  });
```

with:

```ts

  it("a judge index past the resolved seats is unavailable instead of borrowing another seat's model", async () => {
    const env = fake({ "*": { text: "x" } });
    const chains = { ...staticRoleChains(), judges: parseModelChain("kimi-code/k3") };
    const seats = buildOmpPanelSeats({ store, correlation_id: "tick:idea_panel", env, chains });
    expect(await seats.codexJudge({ digest: "d", system: "s" })).toEqual({ ok: false, unavailable: true });
    expect(spawns()).toEqual([]);
    expect(formatModelString(resolveOmpConfig(env, chains).judges[0]!)).toBe("kimi-code/k3");
  });

  // A per-seat /models override (`judges:<n>`) must reach the weekly panel: the seats run on the resolver's chains.
  it("each judge seat runs on its index of the chains the resolver hands it", async () => {
    const env = fake({ "*": { text: '{"scores":[]}' } });
    const chains = { ...staticRoleChains(), judges: parseModelChain("kimi-code/k3,google-antigravity/gemini-3.1-pro,google-antigravity/gemini-3.8-flash") };
    const seats = buildOmpPanelSeats({ store, correlation_id: "tick:idea_panel", env, chains });
    await seats.codexJudge({ digest: "D", system: "lens" });
    expect(spawns().map((s) => modelOf(s.argv))).toEqual(["google-antigravity/gemini-3.1-pro"]);
  });
```

`tests/capabilities/diff-reviewer.test.ts` hunk 1 (near line 13). Replace:

```ts
import { FAKE_OMP_BIN, NO_OMP_BIN, pinOmpEnv } from "../helpers/omp-env.js";
```

with:

```ts
import { FAKE_OMP_BIN, NO_OMP_BIN, pinOmpEnv } from "../helpers/omp-env.js";
import { staticRoleChains } from "../../src/omp/model-roles.js";
import { parseModelChain } from "../../src/omp/model-string.js";
```

`tests/capabilities/diff-reviewer.test.ts` hunk 2 (near line 534). Replace:

```ts
describe("reviewerDiversityWarning — writer (codex, the gpt family) ≠ checker (M2)", () => {
  it("warns when any HOUGE_OMP_REVIEWER string is the gpt family, even a fallback leg", () => {
    expect(reviewerDiversityWarning("codex", { HOUGE_OMP_REVIEWER: "kimi-code/k3:high,openai-codex/gpt-5.5" })).toContain("openai-codex/gpt-5.5");
  });
```

with:

```ts
describe("reviewerDiversityWarning — writer (codex, the gpt family) ≠ checker (M2)", () => {
  it("warns when any Reviewer-role string is the gpt family, even a fallback leg", () => {
    const chains = { ...staticRoleChains(), reviewer: parseModelChain("kimi-code/k3:high,openai-codex/gpt-6.1-sol") };
    expect(reviewerDiversityWarning("codex", {}, chains)).toContain("openai-codex/gpt-6.1-sol");
  });
```

`tests/omp/planner-supervisor.test.ts` hunk 1 (near line 8). Replace:

```ts
import { resolveOmpConfig } from "../../src/omp/omp-config.js";
import { PlannerSupervisor, RETRY_NOTE, parseAttachments, type PlannerSessionLike, type SupervisorDeps, type SupervisorState, type TurnOutcomeSink } from "../../src/omp/planner-supervisor.js";
```

with:

```ts
import { resolveOmpConfig } from "../../src/omp/omp-config.js";
import { staticRoleChains } from "../../src/omp/model-roles.js";
import { parseModelChain } from "../../src/omp/model-string.js";
import { PlannerSupervisor, RETRY_NOTE, parseAttachments, type PlannerSessionLike, type SupervisorDeps, type SupervisorState, type TurnOutcomeSink } from "../../src/omp/planner-supervisor.js";
```

`tests/omp/planner-supervisor.test.ts` hunk 2 (near line 125). Replace:

```ts

function harness(session = fakeSession(), env: Record<string, string> = {}, extra: Partial<SupervisorDeps> = {}, o: { sessionState?: "current" | "none" } = {}) {
  const store = RunStore.openInMemory();
```

with:

```ts

/** `o.planner` replaces the planner chain (the retired HOUGE_OMP_PLANNER); default the static Default list, today's chain. */
function harness(session = fakeSession(), env: Record<string, string> = {}, extra: Partial<SupervisorDeps> = {}, o: { sessionState?: "current" | "none"; planner?: string } = {}) {
  const store = RunStore.openInMemory();
```

`tests/omp/planner-supervisor.test.ts` hunk 3 (near line 135). Replace:

```ts
  const sup = new PlannerSupervisor({
    chatId: "42", store, cfg: resolveOmpConfig({ HOUGE_OMP_SANDBOX: "0", ...env }), ctx: { home: data, repo: data, data }, distDir: data,
    decls: [], env: {}, turnEnvelopeActions: ["shell"],
```

with:

```ts
  const sup = new PlannerSupervisor({
    chatId: "42", store, cfg: resolveOmpConfig({ HOUGE_OMP_SANDBOX: "0", ...env }, { ...staticRoleChains(), ...(o.planner ? { planner: parseModelChain(o.planner) } : {}) }), ctx: { home: data, repo: data, data }, distDir: data,
    decls: [], env: {}, turnEnvelopeActions: ["shell"],
```

`tests/omp/planner-supervisor.test.ts` hunk 4 (near line 873). Replace:

```ts
    const session = fakeSession({ onPrompt: (_t, e) => { e({ type: "prompt_result", agentInvoked: false, status: "error", error: { message: "fetch failed", retryable: false } }); } });
    const { store, sup, outcome } = harness(session, { HOUGE_OMP_PLANNER: "anthropic/claude-opus-5-5:medium" }); const run_id = createQueuedTurnRun(store);
    const t0 = Date.now();
```

with:

```ts
    const session = fakeSession({ onPrompt: (_t, e) => { e({ type: "prompt_result", agentInvoked: false, status: "error", error: { message: "fetch failed", retryable: false } }); } });
    const { store, sup, outcome } = harness(session, {}, {}, { planner: "anthropic/claude-opus-5-5:medium" }); const run_id = createQueuedTurnRun(store);
    const t0 = Date.now();
```

`tests/omp/planner-supervisor.test.ts` hunk 5 (near line 1128). Replace:

```ts
    const session = fakeSession({ log, logSetModel: true, resumeModel: "anthropic/claude-opus-5-5" });
    const { store, sup, outcome } = harness(session, { HOUGE_OMP_PLANNER: "kimi-code/k3" });
    const run_id = createQueuedTurnRun(store);
```

with:

```ts
    const session = fakeSession({ log, logSetModel: true, resumeModel: "anthropic/claude-opus-5-5" });
    const { store, sup, outcome } = harness(session, {}, {}, { planner: "kimi-code/k3" });
    const run_id = createQueuedTurnRun(store);
```

`tests/omp/planner-supervisor.test.ts` hunk 6 (near line 1149). Replace:

```ts
    const session = fakeSession({ resumeModel: "anthropic/claude-opus-5-5", setModel: async () => { throw new Error("set_model refused"); } });
    const { store, sup, outcome } = harness(session, { HOUGE_OMP_PLANNER: "kimi-code/k3" });
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
```

with:

```ts
    const session = fakeSession({ resumeModel: "anthropic/claude-opus-5-5", setModel: async () => { throw new Error("set_model refused"); } });
    const { store, sup, outcome } = harness(session, {}, {}, { planner: "kimi-code/k3" });
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
```

`tests/omp/planner-supervisor.test.ts` hunk 7 (near line 1164). Replace:

```ts
    const session = fakeSession({ resumeModel: "anthropic/claude-opus-5-5" });
    const { store, sup } = harness(session, { HOUGE_OMP_PLANNER: "kimi-code/k3" });
    expect(sup.ompVersion()).toBeNull();
```

with:

```ts
    const session = fakeSession({ resumeModel: "anthropic/claude-opus-5-5" });
    const { store, sup } = harness(session, {}, {}, { planner: "kimi-code/k3" });
    expect(sup.ompVersion()).toBeNull();
```

`tests/helpers/omp-env.ts` hunk 1 (near line 4). Replace:

```ts
import { afterEach, beforeEach } from "vitest";
import { OMP_ENV_VARS } from "../../src/omp/omp-config.js";
```

with:

```ts
import { afterEach, beforeEach } from "vitest";
import { OMP_ENV_VARS, RETIRED_OMP_CHAIN_VARS } from "../../src/omp/omp-config.js";
```

`tests/helpers/omp-env.ts` hunk 2 (near line 11). Replace:

```ts
export const FAKE_OMP_BIN = new URL("../fixtures/fake-omp.mjs", import.meta.url).pathname;
const EXTRA = ["FAKE_OMP_SCENARIO", "FAKE_OMP_ARGV_LOG", "HOUGE_BRIDGE_SOCK", "HOUGE_BRIDGE_TOKEN", "FAKE_OMP_RESUMED"];
```

with:

```ts
export const FAKE_OMP_BIN = new URL("../fixtures/fake-omp.mjs", import.meta.url).pathname;
const EXTRA = ["FAKE_OMP_SCENARIO", "FAKE_OMP_ARGV_LOG", "HOUGE_BRIDGE_SOCK", "HOUGE_BRIDGE_TOKEN", "FAKE_OMP_RESUMED", "HOUGE_MODEL_ROLES", ...RETIRED_OMP_CHAIN_VARS];
```

`tests/helpers/omp-worker.ts` hunk 1 (near line 10). Replace:

```ts
import { chatWorkspace } from "../../src/omp/workspace.js";
import type { SecretBroker } from "../../src/config/secret-broker.js";
```

with:

```ts
import { chatWorkspace } from "../../src/omp/workspace.js";
import type { RoleResolver } from "../../src/omp/role-resolver.js";
import type { SecretBroker } from "../../src/config/secret-broker.js";
```

`tests/helpers/omp-worker.ts` hunk 2 (near line 25). Replace:

```ts
    embed?: (text: string) => Promise<Float32Array | null>; operator?: Identity;
    jevFetch?: typeof fetch; jevNow?: () => Date; broker?: SecretBroker;
  } = {}
```

with:

```ts
    embed?: (text: string) => Promise<Float32Array | null>; operator?: Identity;
    jevFetch?: typeof fetch; jevNow?: () => Date; broker?: SecretBroker; roles?: RoleResolver;
  } = {}
```

`tests/helpers/omp-worker.ts` hunk 3 (near line 33). Replace:

```ts
      dataDir: root, distDir: tmpOmpDist(root), ...(o.operator ? { operator: o.operator } : {}),
      ...(o.jevFetch ? { jevFetch: o.jevFetch } : {}), ...(o.jevNow ? { jevNow: o.jevNow } : {})
    }
```

with:

```ts
      dataDir: root, distDir: tmpOmpDist(root), ...(o.operator ? { operator: o.operator } : {}),
      ...(o.jevFetch ? { jevFetch: o.jevFetch } : {}), ...(o.jevNow ? { jevNow: o.jevNow } : {}), ...(o.roles ? { roles: o.roles } : {})
    }
```

`tests/fixtures/fake-omp.mjs` hunk 1 (near line 27). Replace:

```js
if (argv.includes("--version")) { process.stdout.write("omp/18.4.4\n"); process.exit(0); }
```

with:

```js
if (argv.includes("--version")) { process.stdout.write("omp/18.4.4\n"); process.exit(0); }
// `omp --profile <p> models --json` (the role resolver's catalog read, spec 2026-10-06 §4): the scenario's top-level
// `models` (any JSON), else tests/fixtures/omp-models.json; top-level `modelsExit: <n>` exits n with nothing on stdout.
if (argv.includes("models") && argv.includes("--json")) {
  const sc = process.env.FAKE_OMP_SCENARIO ? JSON.parse(readFileSync(process.env.FAKE_OMP_SCENARIO, "utf8")) : {};
  if (sc.modelsExit) process.exit(sc.modelsExit);
  process.stdout.write(sc.models !== undefined ? JSON.stringify(sc.models) : readFileSync(new URL("./omp-models.json", import.meta.url), "utf8"));
  process.exit(0);
}
```

- [ ] **Step 9: Run them to verify they fail**

Run: `npx vitest run tests/omp/omp-config.test.ts tests/llm/providers/omp.test.ts tests/llm/seat-routing.test.ts tests/core/core-worker-reader-family.test.ts tests/telegram/telegram-daemon.test.ts tests/status/houge-status.test.ts tests/media/media-call.test.ts tests/capabilities/idea-panel-seats.test.ts tests/capabilities/diff-reviewer.test.ts`
Expected: FAIL, in these places:
- `omp-config.test.ts` and `tests/helpers/omp-env.ts` import `RETIRED_OMP_CHAIN_VARS`, which is undefined.
- The D10 skip-rule tests expect `google-antigravity/gemini-3.8-flash` and receive `anthropic/claude-opus-5-5`.
- Reader-family test 2 receives family `claude`.
- The tick-chains test receives `kimi-code/k3` twice.
- The houge-status, media and panel tests run on the static chains, because the seats ignore `chains`.
- The boot-catalog tests find no `model_catalog_unavailable` row, no warning, and no retry offer
  (`worker.modelRoles` is not a function).

- [ ] **Step 10: `src/omp/omp-config.ts`: remove the chain variables, take chains from the caller**

`src/omp/omp-config.ts` hunk 1 (near line 1). Replace:

```ts
import { parseModelChain, type ModelString } from "./model-string.js";
```

with:

```ts
import type { ModelString } from "./model-string.js";
import { staticRoleChains, type RoleChains } from "./model-roles.js";
```

`src/omp/omp-config.ts` hunk 2 (near line 15). Replace:

```ts
  HOUGE_OMP_SANDBOX: "1",
  HOUGE_OMP_PLANNER: "anthropic/claude-opus-5-5:medium,google-antigravity/claude-opus-4-6:medium,kimi-code/k3:low",
  HOUGE_OMP_READER: "google-antigravity/gemini-3.8-flash:low,kimi-code/k3:low,openai-codex/gpt-5.5:low",
  HOUGE_OMP_MEDIA: "google-antigravity/gemini-3.8-flash:low",
  HOUGE_OMP_TICKS: "kimi-code/k3:low",
  HOUGE_OMP_JUDGES: "kimi-code/k3,openai-codex/gpt-5.5,google-antigravity/gemini-3.1-pro",
  HOUGE_OMP_CHAIR: "anthropic/claude-opus-5-5:low",
  HOUGE_OMP_REVIEWER: "kimi-code/k3:high,google-antigravity/claude-opus-4-6:medium",
  HOUGE_OMP_ENV_PASSTHROUGH: "KIMI_CODE_OAUTH_HOST,KIMI_CODE_BASE_URL",
```

with:

```ts
  HOUGE_OMP_SANDBOX: "1",
  HOUGE_OMP_ENV_PASSTHROUGH: "KIMI_CODE_OAUTH_HOST,KIMI_CODE_BASE_URL",
```

`src/omp/omp-config.ts` hunk 3 (near line 45). Replace:

```ts

const CHAIN_KEYS: readonly Key[] = [
  "HOUGE_OMP_PLANNER", "HOUGE_OMP_READER", "HOUGE_OMP_MEDIA", "HOUGE_OMP_TICKS", "HOUGE_OMP_JUDGES", "HOUGE_OMP_CHAIR", "HOUGE_OMP_REVIEWER"
];
```

with:

```ts

/** The seven seat-chain variables the model roles replaced (spec 2026-10-06 §4.2): a set one is ignored and named once at boot. */
export const RETIRED_OMP_CHAIN_VARS: readonly string[] = [
  "HOUGE_OMP_PLANNER", "HOUGE_OMP_READER", "HOUGE_OMP_MEDIA", "HOUGE_OMP_TICKS", "HOUGE_OMP_JUDGES", "HOUGE_OMP_CHAIR", "HOUGE_OMP_REVIEWER"
];
const warnedRetired = new Set<string>();

/** Names every retired chain variable still set, once per process per name (a stale .env is visible, never fatal). Returns the names warned. */
export function warnRetiredOmpChainVars(env: NodeJS.ProcessEnv, warn: (line: string) => void = console.warn): string[] {
  const set = RETIRED_OMP_CHAIN_VARS.filter((k) => (env[k]?.trim() ?? "").length > 0 && !warnedRetired.has(k));
  for (const k of set) warnedRetired.add(k);
  if (set.length > 0) warn(`[omp-config] ${set.join(", ")} no longer read: model roles replace the seat chains (src/omp/model-roles.ts, /models to override)`);
  return set;
}
```

`src/omp/omp-config.ts` hunk 4 (near line 59). Replace:

```ts
export function ompConfigProblems(env: NodeJS.ProcessEnv): string[] {
  const chains = CHAIN_KEYS.filter((k) => {
    try { parseModelChain(read(env, k)); return false; } catch { return true; }
  });
  return num(env, "HOUGE_OMP_LEASE_TTL_S") < MIN_LEASE_TTL_S ? [...chains, "HOUGE_OMP_LEASE_TTL_S"] : chains;
}
```

with:

```ts
export function ompConfigProblems(env: NodeJS.ProcessEnv): string[] {
  return num(env, "HOUGE_OMP_LEASE_TTL_S") < MIN_LEASE_TTL_S ? ["HOUGE_OMP_LEASE_TTL_S"] : [];
}
```

`src/omp/omp-config.ts` hunk 5 (near line 71). Replace:

```ts

export function resolveOmpConfig(env: NodeJS.ProcessEnv): OmpConfig {
  return {
```

with:

```ts

/** The omp config. Its seven seat chains come from the caller: a RoleResolver's `chains()`, else the static role lists (today's chains). */
export function resolveOmpConfig(env: NodeJS.ProcessEnv, chains: RoleChains = staticRoleChains()): OmpConfig {
  return {
```

`src/omp/omp-config.ts` hunk 6 (near line 76). Replace:

```ts
    sandbox: read(env, "HOUGE_OMP_SANDBOX") !== "0",
    planner: parseModelChain(read(env, "HOUGE_OMP_PLANNER")),
    reader: parseModelChain(read(env, "HOUGE_OMP_READER")),
    media: parseModelChain(read(env, "HOUGE_OMP_MEDIA")),
    ticks: parseModelChain(read(env, "HOUGE_OMP_TICKS")),
    judges: parseModelChain(read(env, "HOUGE_OMP_JUDGES")),
    chair: parseModelChain(read(env, "HOUGE_OMP_CHAIR")),
    reviewer: parseModelChain(read(env, "HOUGE_OMP_REVIEWER")),
    envPassthrough: list(read(env, "HOUGE_OMP_ENV_PASSTHROUGH")),
```

with:

```ts
    sandbox: read(env, "HOUGE_OMP_SANDBOX") !== "0",
    planner: chains.planner,
    reader: chains.reader,
    media: chains.media,
    ticks: chains.ticks,
    judges: chains.judges,
    chair: chains.chair,
    reviewer: chains.reviewer,
    envPassthrough: list(read(env, "HOUGE_OMP_ENV_PASSTHROUGH")),
```

- [ ] **Step 11: The D10 skip rule in `spawnOneShot`, resolved mode only (`src/llm/providers/omp.ts`)**

`src/llm/providers/omp.ts` hunk 1 (near line 9). Replace:

```ts
import { familyOf, formatModelString, type ModelFamily, type ModelString } from "../../omp/model-string.js";
```

with:

```ts
import { familyOf, formatModelString, type ModelFamily, type ModelString } from "../../omp/model-string.js";
import { resolveModelRolesMode } from "../../omp/model-roles.js";
```

`src/llm/providers/omp.ts` hunk 2 (near line 103). Replace:

```ts

export async function spawnOneShot(input: OneShotInput, deps: OneShotDeps): Promise<LlmResult> {
```

with:

```ts

/**
 * D10 as a skip rule (spec 2026-10-06 §8), resolved mode only. A reader call that knows the planner's family runs its
 * candidates of another family first, then the rest, each group in list order. When every candidate shares the family
 * the order stands, and every leg is flagged family_collapse below, as before. `HOUGE_MODEL_ROLES=static` (read per
 * call) keeps the list order exactly, as before stage A (spec §4.3).
 */
function readerOrder(input: OneShotInput): ModelString[] {
  if (input.seat !== "reader" || input.plannerFamily === undefined) return input.chain;
  if (resolveModelRolesMode(process.env) === "static") return input.chain;
  const cross = input.chain.filter((m) => familyOf(m) !== input.plannerFamily);
  return [...cross, ...input.chain.filter((m) => familyOf(m) === input.plannerFamily)];
}

export async function spawnOneShot(input: OneShotInput, deps: OneShotDeps): Promise<LlmResult> {
```

`src/llm/providers/omp.ts` hunk 3 (near line 111). Replace:

```ts
  const errors: string[] = [];
  for (const [i, m] of input.chain.entries()) {
    if (input.signal?.aborted) return ABORTED;
```

with:

```ts
  const errors: string[] = [];
  for (const [i, m] of readerOrder(input).entries()) {
    if (input.signal?.aborted) return ABORTED;
```

- [ ] **Step 12: `tickSeat` takes its chains (`src/llm/registry.ts`)**

`src/llm/registry.ts` hunk 1 (near line 5). Replace:

```ts
import type { ModelFamily, ModelString } from "../omp/model-string.js";
import type { LlmAuditScope, LlmCallRole, RunStore } from "../run/run-store.js";
```

with:

```ts
import type { ModelFamily, ModelString } from "../omp/model-string.js";
import { staticRoleChains, type RoleChains } from "../omp/model-roles.js";
import type { LlmAuditScope, LlmCallRole, RunStore } from "../run/run-store.js";
```

`src/llm/registry.ts` hunk 2 (near line 151). Replace:

```ts
 * correlation, so one tick run's legs group together and never mix with the next run's.
 * `signal` (the daemon's stop) aborts the in-flight call.
 */
export function tickSeat(
  store: RunStore, name: string, role: LlmCallRole, env: NodeJS.ProcessEnv = process.env
): (input: { question: string; system: string; signal?: AbortSignal }) => Promise<{ ok: true; answer: string } | { ok: false }> {
  return async (input) => {
    const r = await oneShotAdapter(store, resolveOmpConfig(env), { correlation_id: tickCorrelationId(name), role }).answer(input);
    return r.ok ? { ok: true, answer: r.answer } : { ok: false };
```

with:

```ts
 * correlation, so one tick run's legs group together and never mix with the next run's.
 * `signal` (the daemon's stop) aborts the in-flight call. `chains` is read per call (the daemon passes its
 * RoleResolver's, so a /models override reaches the next tick); default the static role lists.
 */
export function tickSeat(
  store: RunStore, name: string, role: LlmCallRole, env: NodeJS.ProcessEnv = process.env, chains: () => RoleChains = staticRoleChains
): (input: { question: string; system: string; signal?: AbortSignal }) => Promise<{ ok: true; answer: string } | { ok: false }> {
  return async (input) => {
    const r = await oneShotAdapter(store, resolveOmpConfig(env, chains()), { correlation_id: tickCorrelationId(name), role }).answer(input);
    return r.ok ? { ok: true, answer: r.answer } : { ok: false };
```

- [ ] **Step 13: Optional `chains` on the seat builders, and the comments that named the retired variables**

`src/media/media-ingest.ts` hunk 1 (near line 10). Replace:

```ts
import { resolveOmpConfig } from "../omp/omp-config.js";
import type { RunStore } from "../run/run-store.js";
```

with:

```ts
import { resolveOmpConfig } from "../omp/omp-config.js";
import type { RoleChains } from "../omp/model-roles.js";
import type { RunStore } from "../run/run-store.js";
```

`src/media/media-ingest.ts` hunk 2 (near line 258). Replace:

```ts
  env: NodeJS.ProcessEnv;
  /** Tests only: the voice leg (default: the agy-cli provider with the media timeout). */
```

with:

```ts
  env: NodeJS.ProcessEnv;
  /** The worker's resolved chains (`roles.chains()`); absent = the static role lists. */
  chains?: RoleChains;
  /** Tests only: the voice leg (default: the agy-cli provider with the media timeout). */
```

`src/media/media-ingest.ts` hunk 3 (near line 271). Replace:

```ts
  if (d.kind === "photo") {
    return llmToolAdapter(oneShotAdapter(d.store, resolveOmpConfig(d.env), { run_id: d.run_id, role: "reader" }));
  }
```

with:

```ts
  if (d.kind === "photo") {
    return llmToolAdapter(oneShotAdapter(d.store, resolveOmpConfig(d.env, d.chains), { run_id: d.run_id, role: "reader" }));
  }
```

`src/media/media-config.ts` hunk 1 (near line 50). Replace:

```ts
export const MEDIA_DIGEST_MAX_CHARS = 4_000;
/** Voice only (ruling 2): agy-cli is the one leg that hears audio. Photos ride omp `HOUGE_OMP_MEDIA`. */
export const DEFAULT_MEDIA_PROVIDERS = "agy-cli";
```

with:

```ts
export const MEDIA_DIGEST_MAX_CHARS = 4_000;
/** Voice only (ruling 2): agy-cli is the one leg that hears audio. Photos ride omp's Vision role. */
export const DEFAULT_MEDIA_PROVIDERS = "agy-cli";
```

`src/status/houge-status.ts` hunk 1 (near line 7). Replace:

```ts
import { resolveOmpConfig } from "../omp/omp-config.js";
import { resolveLocalTimeZone } from "../prompt/tz-convert.js";
```

with:

```ts
import { resolveOmpConfig } from "../omp/omp-config.js";
import type { RoleChains } from "../omp/model-roles.js";
import { resolveLocalTimeZone } from "../prompt/tz-convert.js";
```

`src/status/houge-status.ts` hunk 2 (near line 112). Replace:

```ts

function chainTops(env: NodeJS.ProcessEnv): { planner: string; reader: string } {
  try {
    const cfg = resolveOmpConfig(env);
    return { planner: formatModelString(cfg.planner[0]!), reader: formatModelString(cfg.reader[0]!) };
```

with:

```ts

function chainTops(env: NodeJS.ProcessEnv, chains?: RoleChains): { planner: string; reader: string } {
  try {
    const cfg = resolveOmpConfig(env, chains);
    return { planner: formatModelString(cfg.planner[0]!), reader: formatModelString(cfg.reader[0]!) };
```

`src/status/houge-status.ts` hunk 3 (near line 128). Replace:

```ts
export function collectHougeStatus(d: {
  store: RunStore; env: NodeJS.ProcessEnv; chatId: string; pid: number; now?: Date; supervisor?: StatusSupervisor;
}): HougeStatusInput {
  const now = (d.now ?? new Date()).toISOString();
  const tops = chainTops(d.env);
  const live = d.supervisor?.answeredModel();
```

with:

```ts
export function collectHougeStatus(d: {
  store: RunStore; env: NodeJS.ProcessEnv; chatId: string; pid: number; now?: Date; supervisor?: StatusSupervisor; chains?: RoleChains;
}): HougeStatusInput {
  const now = (d.now ?? new Date()).toISOString();
  const tops = chainTops(d.env, d.chains);
  const live = d.supervisor?.answeredModel();
```

`src/capabilities/idea-panel-seats.ts` hunk 1 (near line 2). Replace:

```ts
// chair are omp one-shot seats — tool-less, session-less, subscription legs under the `houge`
// profile. Each JUDGE is pinned to ONE model string by index (`HOUGE_OMP_JUDGES`), never a chain:
// a healthy-leg fallback would silently void model diversity and the quorum semantics. The CHAIR
// rides `HOUGE_OMP_CHAIR`. Both the daemon tick and `houge radar-panel` build their seats HERE, so
// the two sites cannot drift apart (the CLI site once kept firing metered APIs after the daemon moved).
import { judgeSeat, oneShotAdapter, seatChain, type OneShotAdapterOptions } from "../llm/registry.js";
import { resolveOmpConfig } from "../omp/omp-config.js";
import type { RunStore } from "../run/run-store.js";
```

with:

```ts
// chair are omp one-shot seats — tool-less, session-less, subscription legs under the `houge`
// profile. Each JUDGE is pinned to ONE model string by index (the Judges role), never a chain:
// a healthy-leg fallback would silently void model diversity and the quorum semantics. The CHAIR
// rides the Chair role. Both the daemon tick and `houge radar-panel` build their seats HERE, so
// the two sites cannot drift apart (the CLI site once kept firing metered APIs after the daemon moved).
import { judgeSeat, oneShotAdapter, seatChain, type OneShotAdapterOptions } from "../llm/registry.js";
import { resolveOmpConfig } from "../omp/omp-config.js";
import type { RoleChains } from "../omp/model-roles.js";
import type { RunStore } from "../run/run-store.js";
```

`src/capabilities/idea-panel-seats.ts` hunk 2 (near line 12). Replace:

```ts

/** Which `HOUGE_OMP_JUDGES` index serves which named judge (default kimi-code/k3, openai-codex/gpt-5.5, gemini-3.1-pro). */
export const PANEL_JUDGE_SEAT_INDEX = { kimi: 0, codex: 1, gemini: 2 } as const;
```

with:

```ts

/** Which Judges-role seat serves which named judge (kimi-code/k3, the openai-codex seat, gemini-3.1-pro; src/omp/model-roles.ts). */
export const PANEL_JUDGE_SEAT_INDEX = { kimi: 0, codex: 1, gemini: 2 } as const;
```

`src/capabilities/idea-panel-seats.ts` hunk 3 (near line 26). Replace:

```ts
  env: NodeJS.ProcessEnv;
  /** Tests only: bypass the `omp --version` spawn. */
```

with:

```ts
  env: NodeJS.ProcessEnv;
  /** The daemon's resolved chains (`roles.chains()`); absent = the static role lists (the CLI). */
  chains?: RoleChains;
  /** Tests only: bypass the `omp --version` spawn. */
```

`src/capabilities/idea-panel-seats.ts` hunk 4 (near line 34). Replace:

```ts
export function buildOmpPanelSeats(input: OmpPanelSeatsInput): PanelSeatBindings {
  const cfg = resolveOmpConfig(input.env);
  const opts = input.versionCheck ? { versionCheck: input.versionCheck } : {};
```

with:

```ts
export function buildOmpPanelSeats(input: OmpPanelSeatsInput): PanelSeatBindings {
  const cfg = resolveOmpConfig(input.env, input.chains);
  const opts = input.versionCheck ? { versionCheck: input.versionCheck } : {};
```

`src/capabilities/diff-reviewer.ts` hunk 1 (near line 9). Replace:

```ts
import { familyOf, formatModelString } from "../omp/model-string.js";
import { fenceRule, fenceUntrusted, newFenceNonce } from "../prompt/untrusted-fence.js";
```

with:

```ts
import { familyOf, formatModelString } from "../omp/model-string.js";
import type { RoleChains } from "../omp/model-roles.js";
import { fenceRule, fenceUntrusted, newFenceNonce } from "../prompt/untrusted-fence.js";
```

`src/capabilities/diff-reviewer.ts` hunk 2 (near line 18). Replace:

```ts
 * a DIFFERENT agent from the writer (Codex, the gpt family): by default the omp reviewer seat, a
 * tool-less one-shot (`--no-tools`) over `HOUGE_OMP_REVIEWER` (kimi, then claude via the
 * subscription profile). The Codex-session path is the fallback (independent fresh session + the
```

with:

```ts
 * a DIFFERENT agent from the writer (Codex, the gpt family): by default the omp reviewer seat, a
 * tool-less one-shot (`--no-tools`) over the Reviewer role (kimi, then claude via the
 * subscription profile). The Codex-session path is the fallback (independent fresh session + the
```

`src/capabilities/diff-reviewer.ts` hunk 3 (near line 26). Replace:

```ts

/** `omp` = the omp reviewer seat (`HOUGE_OMP_REVIEWER`, a chain off the writer's family); `codex` = an independent Codex session. */
export type ReviewerKind = "codex" | "omp";
```

with:

```ts

/** `omp` = the omp reviewer seat (the Reviewer role, a chain off the writer's family); `codex` = an independent Codex session. */
export type ReviewerKind = "codex" | "omp";
```

`src/capabilities/diff-reviewer.ts` hunk 4 (near line 52). Replace:

```ts
 * Phase 3.1 (W3) writer ≠ checker: the writer is codex (the gpt family). A NON-FATAL warning when the
 * reviewer shares that family — the codex reviewer, or any HOUGE_OMP_REVIEWER string whose family is
 * gpt (a fallback leg counts: it may be the one that verdicts). Null when diversity holds.
 */
export function reviewerDiversityWarning(writer: string, env: NodeJS.ProcessEnv): string | null {
  const reviewer = resolveSelfWriteReviewer(env);
```

with:

```ts
 * Phase 3.1 (W3) writer ≠ checker: the writer is codex (the gpt family). A NON-FATAL warning when the
 * reviewer shares that family — the codex reviewer, or any Reviewer-role string whose family is
 * gpt (a fallback leg counts: it may be the one that verdicts). Null when diversity holds.
 */
export function reviewerDiversityWarning(writer: string, env: NodeJS.ProcessEnv, chains?: RoleChains): string | null {
  const reviewer = resolveSelfWriteReviewer(env);
```

`src/capabilities/diff-reviewer.ts` hunk 5 (near line 61). Replace:

```ts
  if (reviewer !== "omp") return null;
  const gpt = resolveOmpConfig(env).reviewer.filter((m) => familyOf(m) === "gpt").map(formatModelString);
  return gpt.length === 0 ? null
    : `[self-write] writer and reviewer are BOTH the gpt family (HOUGE_OMP_REVIEWER: ${gpt.join(", ")}) — model diversity (writer ≠ checker) is lost.`;
}
```

with:

```ts
  if (reviewer !== "omp") return null;
  const gpt = resolveOmpConfig(env, chains).reviewer.filter((m) => familyOf(m) === "gpt").map(formatModelString);
  return gpt.length === 0 ? null
    : `[self-write] writer and reviewer are BOTH the gpt family (Reviewer role: ${gpt.join(", ")}) — model diversity (writer ≠ checker) is lost.`;
}
```

`src/capabilities/diff-reviewer.ts` hunk 6 (near line 167). Replace:

```ts
  onOmpCheck?: (check: OmpCheckResult) => void;
}
```

with:

```ts
  onOmpCheck?: (check: OmpCheckResult) => void;
  /** The worker's resolved chains (`roles.chains()`); absent = the static role lists. */
  chains?: RoleChains;
}
```

`src/capabilities/diff-reviewer.ts` hunk 7 (near line 312). Replace:

```ts
/**
 * The default reviewer backend: ONE omp one-shot over the reviewer seat's chain (`HOUGE_OMP_REVIEWER`,
 * kimi then claude — never the gpt family that writes). Tool-less by construction (`--no-tools`, no
```

with:

```ts
/**
 * The default reviewer backend: ONE omp one-shot over the reviewer seat's chain (the Reviewer role,
 * kimi then claude — never the gpt family that writes). Tool-less by construction (`--no-tools`, no
```

`src/capabilities/diff-reviewer.ts` hunk 8 (near line 319). Replace:

```ts
async function reviewViaOmp(input: ReviewDiffInput, env: NodeJS.ProcessEnv): Promise<ReviewResult> {
  const cfg = resolveOmpConfig(env);
  const r = await spawnOneShot(
```

with:

```ts
async function reviewViaOmp(input: ReviewDiffInput, env: NodeJS.ProcessEnv): Promise<ReviewResult> {
  const cfg = resolveOmpConfig(env, input.chains);
  const r = await spawnOneShot(
```

- [ ] **Step 14: `CoreWorker` holds the resolver and runs every seat on its chains**

`onOmpCheck`'s `resolveOmpConfig(process.env)` (`:1373`) stays: `reportOmpCheck` reads no chain (since `a49da40` it
reads no version either).

`src/core/core-worker.ts` hunk 1 (near line 136). Replace:

```ts
import type { ExternalReadResult } from "../omp/external-read.js";
import { ompConfigProblems, resolveOmpConfig } from "../omp/omp-config.js";
import { PlannerSupervisor, type SupervisorDeps, type TriageInput, type TriageOutcome, type TurnOutcomeSink } from "../omp/planner-supervisor.js";
```

with:

```ts
import type { ExternalReadResult } from "../omp/external-read.js";
import { ompConfigProblems, resolveOmpConfig, type OmpConfig } from "../omp/omp-config.js";
import { readOmpCatalog } from "../omp/model-catalog.js";
import { RoleResolver } from "../omp/role-resolver.js";
import { PlannerSupervisor, type SupervisorDeps, type TriageInput, type TriageOutcome, type TurnOutcomeSink } from "../omp/planner-supervisor.js";
```

`src/core/core-worker.ts` hunk 2 (near line 273). Replace:

```ts
  jevNow?: () => Date;
}
```

with:

```ts
  jevNow?: () => Date;
  /** The model-role service; default one over `omp models --json`. Tests inject a resolver over a fixture catalog. */
  roles?: RoleResolver;
}
```

`src/core/core-worker.ts` hunk 3 (near line 399). Replace:

```ts
  private readonly embedAdapter: (text: string) => Promise<Float32Array | null>;
```

with:

```ts
  private readonly embedAdapter: (text: string) => Promise<Float32Array | null>;
  /** Model roles (spec 2026-10-06 §4): every seat's chain resolves here, per call. */
  private readonly roles: RoleResolver;
```

`src/core/core-worker.ts` hunk 4 (near line 436). Replace:

```ts
    if (ompOptions.dataDir) setDaemonDataDir(ompOptions.dataDir);
    // When the DEFAULT llm adapter is in use (production), `llmAdapterFor` builds a run-scoped,
```

with:

```ts
    if (ompOptions.dataDir) setDaemonDataDir(ompOptions.dataDir);
    // One resolver per worker; the daemon reads its catalog at boot (resolveOmpConfig may throw on a bad lease TTL: refreshCatalog catches it).
    this.roles = ompOptions.roles ?? new RoleResolver({ store: runStore, readCatalog: () => readOmpCatalog(resolveOmpConfig(process.env)) });
    // When the DEFAULT llm adapter is in use (production), `llmAdapterFor` builds a run-scoped,
```

`src/core/core-worker.ts` hunk 5 (near line 1269). Replace:

```ts
    const reviewerProvider = resolveSelfWriteReviewer(process.env);
    const diversity = reviewerDiversityWarning(writerProvider, process.env);
    if (diversity) console.warn(diversity);
```

with:

```ts
    const reviewerProvider = resolveSelfWriteReviewer(process.env);
    const diversity = reviewerDiversityWarning(writerProvider, process.env, this.roles.chains());
    if (diversity) console.warn(diversity);
```

`src/core/core-worker.ts` hunk 6 (near line 1373). Replace:

```ts
          audit: this.runStore.llmAuditSink({ run_id: claim.run_id, role: "reviewer" }),
          onOmpCheck: (check) => reportOmpCheck(this.runStore, resolveOmpConfig(process.env), check)
```

with:

```ts
          audit: this.runStore.llmAuditSink({ run_id: claim.run_id, role: "reviewer" }),
          chains: this.roles.chains(),
          onOmpCheck: (check) => reportOmpCheck(this.runStore, resolveOmpConfig(process.env), check)
```

`src/core/core-worker.ts` hunk 7 (near line 1499). Replace:

```ts
   * `scope` (spec §8). Only the DEFAULT adapter is built this way; a test-injected adapter is
   * returned as-is (it brings its own fakes). The omp config is read per call (`/disarm`-style env
   * edits apply to the next call).
   */
  private seatAdapter(scope: LlmAuditScope, plannerFamily?: ModelFamily): (input: Record<string, unknown>) => Promise<ToolAdapterResult> {
    if (!this.llmAdapterIsDefault) return this.llmAdapter;
    return (input) => llmToolAdapter(oneShotAdapter(this.runStore, resolveOmpConfig(process.env), scope, plannerFamily))(input);
  }
```

with:

```ts
   * `scope` (spec §8). Only the DEFAULT adapter is built this way; a test-injected adapter is
   * returned as-is (it brings its own fakes). The config and the roles' chains are read per call
   * (an env edit or a /models override applies to the next call).
   */
  private seatAdapter(scope: LlmAuditScope, plannerFamily?: ModelFamily): (input: Record<string, unknown>) => Promise<ToolAdapterResult> {
    if (!this.llmAdapterIsDefault) return this.llmAdapter;
    return (input) => llmToolAdapter(oneShotAdapter(this.runStore, this.ompConfig(), scope, plannerFamily))(input);
  }
```

`src/core/core-worker.ts` hunk 8 (near line 1509). Replace:

```ts
  private llmTimeoutMs(role: LlmCallRole): number {
    return seatBudgetMs(resolveOmpConfig(process.env), role) + RUNNER_TIMEOUT_BUFFER_MS;
  }
```

with:

```ts
  private llmTimeoutMs(role: LlmCallRole): number {
    return seatBudgetMs(this.ompConfig(), role) + RUNNER_TIMEOUT_BUFFER_MS;
  }

  /** The worker's model-role service: the daemon's boot catalog read, ticks and (Task 11) `/models` use this one instance. */
  modelRoles(): RoleResolver { return this.roles; }

  /** The omp config with the seat chains as the roles resolve them now. */
  private ompConfig(): OmpConfig { return resolveOmpConfig(process.env, this.roles.chains()); }
```

`src/core/core-worker.ts` hunk 9 (near line 1520). Replace:

```ts
    if (!this.llmAdapterIsDefault) return null;
    return buildMediaCall({ store: this.runStore, run_id, kind, env: process.env });
  }
```

with:

```ts
    if (!this.llmAdapterIsDefault) return null;
    return buildMediaCall({ store: this.runStore, run_id, kind, env: process.env, chains: this.roles.chains() });
  }
```

`src/core/core-worker.ts` hunk 10 (near line 2050). Replace:

```ts
  /**
   * Boot and per-turn check of the HOUGE_OMP_* seat chains (B4): a malformed chain pages Paco once
   * (omp_config_invalid, the variable names only) instead of every turn throwing; a valid config resolves it.
```

with:

```ts
  /**
   * Boot and per-turn check of the omp config (B4): a malformed value (today the lease TTL) pages Paco once
   * (omp_config_invalid, the variable names only) instead of every turn throwing; a valid config resolves it.
```

`src/core/core-worker.ts` hunk 11 (near line 2168). Replace:

```ts
    return {
      chatId, store: this.runStore, cfg: resolveOmpConfig(process.env), ctx: this.ompPathContext(),
      distDir: this.ompOptions.distDir ?? join(this.projectRoot, "dist"), decls: this.ompDecls.ok ? this.ompDecls.decls : [],
```

with:

```ts
    return {
      chatId, store: this.runStore, cfg: this.ompConfig(), ctx: this.ompPathContext(),
      distDir: this.ompOptions.distDir ?? join(this.projectRoot, "dist"), decls: this.ompDecls.ok ? this.ompDecls.decls : [],
```

`src/core/core-worker.ts` hunk 12 (near line 2245). Replace:

```ts
    const registry = new ToolRegistry();
    const cfg = resolveOmpConfig(process.env);
    const shell = shellToolExecute({
```

with:

```ts
    const registry = new ToolRegistry();
    const cfg = this.ompConfig();
    const shell = shellToolExecute({
```

`src/core/core-worker.ts` hunk 13 (near line 2862). Replace:

```ts
    return renderHougeStatus(collectHougeStatus({
      store: this.runStore, env: process.env, chatId, pid: process.pid, ...(supervisor ? { supervisor } : {})
    }));
```

with:

```ts
    return renderHougeStatus(collectHougeStatus({
      store: this.runStore, env: process.env, chatId, pid: process.pid, chains: this.roles.chains(), ...(supervisor ? { supervisor } : {})
    }));
```

- [ ] **Step 15: The daemon reads the catalog at boot, offers the hourly retry each cycle, warns once, and runs ticks on the roles**

`src/telegram/telegram-daemon.ts` hunk 1 (near line 15). Replace:

```ts
import { CoreWorker, type OmpWorkerOptions } from "../core/core-worker.js";
import { resolveOmpConfig } from "../omp/omp-config.js";
import { errorCode } from "../domain/error-code.js";
```

with:

```ts
import { CoreWorker, type OmpWorkerOptions } from "../core/core-worker.js";
import { resolveOmpConfig, warnRetiredOmpChainVars } from "../omp/omp-config.js";
import type { RoleResolver } from "../omp/role-resolver.js";
import { errorCode } from "../domain/error-code.js";
```

`src/telegram/telegram-daemon.ts` hunk 2 (near line 182). Replace:

```ts
  );
  const recovery = bootPlanners(worker, options, now);
```

with:

```ts
  );
  // Model roles (spec 2026-10-06 §4): one catalog read before the first turn, bounded by CATALOG_TIMEOUT_MS. A failed
  // read leaves one ledger note and the roles on their lists (Decision 4); the poll loop retries it hourly (F14).
  await worker.modelRoles().refreshCatalog();
  const recovery = bootPlanners(worker, options, now);
```

`src/telegram/telegram-daemon.ts` hunk 3 (near line 286). Replace:

```ts
      options.store.expireUndeliveredApprovalPrompts(t);
      // ⓪·3 S2: the signal path rides the poll loop (before the outbox flush, so a
```

with:

```ts
      options.store.expireUndeliveredApprovalPrompts(t);
      // F14: a failed omp catalog read is retried hourly; the resolver owns the window and the incident. Never awaited.
      void worker.modelRoles().retryFailedRead();
      // ⓪·3 S2: the signal path rides the poll loop (before the outbox flush, so a
```

`src/telegram/telegram-daemon.ts` hunk 4 (near line 347). Replace:

```ts
/**
 * Boot-time planner checks, before the first poll: a malformed HOUGE_OMP_* chain pages Paco (B4); what a crash
 * stranded is failed now, its replies riding the boot flush (B1). Expired planner leases are then recovered on a timer
```

with:

```ts
/**
 * Boot-time planner checks, before the first poll: a malformed omp config pages Paco (B4) and a still-set retired
 * chain variable is named once; what a crash
 * stranded is failed now, its replies riding the boot flush (B1). Expired planner leases are then recovered on a timer
```

`src/telegram/telegram-daemon.ts` hunk 5 (near line 352). Replace:

```ts
function bootPlanners(worker: CoreWorker, options: RunTelegramDaemonOptions, now: () => string): ReturnType<typeof setInterval> {
  worker.validateOmpConfig();
```

with:

```ts
function bootPlanners(worker: CoreWorker, options: RunTelegramDaemonOptions, now: () => string): ReturnType<typeof setInterval> {
  warnRetiredOmpChainVars(process.env);
  worker.validateOmpConfig();
```

`src/telegram/telegram-daemon.ts` hunk 6 (near line 487). Replace:

```ts
 * omp leg a tick tries lands in the ledger under `tick:<name>:<uuid>` (spec §8: one-shot seats). The
 * role picks the chain (`seatChain`: memory ticks on HOUGE_OMP_TICKS). A test-injected
 * `options.llmAdapter` is used verbatim (it brings its own fakes, no omp). The daemon's stop
 * aborts the in-flight omp call, and every later call fails at once without spawning.
 */
function tickLlm(options: RunTelegramDaemonOptions, name: string, role: LlmCallRole): TickLlm {
  const injected = options.llmAdapter;
```

with:

```ts
 * omp leg a tick tries lands in the ledger under `tick:<name>:<uuid>` (spec §8: one-shot seats). The
 * role picks the chain (`seatChain`: memory ticks on the Tiny role) from the worker's RoleResolver, read per call.
 * A test-injected `options.llmAdapter` is used verbatim (it brings its own fakes, no omp). The daemon's stop
 * aborts the in-flight omp call, and every later call fails at once without spawning.
 */
function tickLlm(options: RunTelegramDaemonOptions, name: string, role: LlmCallRole, roles: Pick<RoleResolver, "chains">): TickLlm {
  const injected = options.llmAdapter;
```

`src/telegram/telegram-daemon.ts` hunk 7 (near line 500). Replace:

```ts
    }
    return tickSeat(options.store, name, role)({ ...input, signal: stop });
  };
```

with:

```ts
    }
    return tickSeat(options.store, name, role, process.env, () => roles.chains())({ ...input, signal: stop });
  };
```

`src/telegram/telegram-daemon.ts` hunk 8 (near line 514). Replace:

```ts
  const signal = options.stopSignal;
  await runMemoryTicks(options, now, signal);
  if (signal.aborted) return;
  await runIdeaTicks(options, now, chatId, signal);
  if (signal.aborted) return;
```

with:

```ts
  const signal = options.stopSignal;
  await runMemoryTicks(options, now, signal, worker.modelRoles());
  if (signal.aborted) return;
  await runIdeaTicks(options, now, chatId, signal, worker.modelRoles());
  if (signal.aborted) return;
```

`src/telegram/telegram-daemon.ts` hunk 9 (near line 530). Replace:

```ts
 */
async function runMemoryTicks(options: RunTelegramDaemonOptions, now: string, signal: AbortSignal): Promise<void> {
  const embed = (text: string) => embedText(text, resolveEmbedConfig(process.env));
  await maybeRunEpisodicDistill({
    store: options.store, llm: tickLlm(options, "episodic_distill", "distill"), embed,
    userName: options.allowlist.users[0]?.identity_id ?? "the user", now, signal
  });
  if (signal.aborted) return;
  await runEpisodicConsolidateTick({ store: options.store, llm: tickLlm(options, "episodic_consolidate", "consolidate"), embed, now, signal });
  if (signal.aborted) return;
  await runLessonConsolidateTick({
    store: options.store, llmAnswer: tickLlm(options, "lesson_consolidate", "consolidate"), env: process.env, now, signal
  });
```

with:

```ts
 */
async function runMemoryTicks(options: RunTelegramDaemonOptions, now: string, signal: AbortSignal, roles: Pick<RoleResolver, "chains">): Promise<void> {
  const embed = (text: string) => embedText(text, resolveEmbedConfig(process.env));
  await maybeRunEpisodicDistill({
    store: options.store, llm: tickLlm(options, "episodic_distill", "distill", roles), embed,
    userName: options.allowlist.users[0]?.identity_id ?? "the user", now, signal
  });
  if (signal.aborted) return;
  await runEpisodicConsolidateTick({ store: options.store, llm: tickLlm(options, "episodic_consolidate", "consolidate", roles), embed, now, signal });
  if (signal.aborted) return;
  await runLessonConsolidateTick({
    store: options.store, llmAnswer: tickLlm(options, "lesson_consolidate", "consolidate", roles), env: process.env, now, signal
  });
```

`src/telegram/telegram-daemon.ts` hunk 10 (near line 549). Replace:

```ts
 */
async function runIdeaTicks(options: RunTelegramDaemonOptions, now: string, chatId: string | null, signal: AbortSignal): Promise<void> {
  await runIdeaRadarTick({
    store: options.store, llmAnswer: tickLlm(options, "idea_radar", "extract"),
    ...(options.radarFetch ? { fetch: options.radarFetch } : {}), env: process.env, now, signal
```

with:

```ts
 */
async function runIdeaTicks(options: RunTelegramDaemonOptions, now: string, chatId: string | null, signal: AbortSignal, roles: Pick<RoleResolver, "chains">): Promise<void> {
  await runIdeaRadarTick({
    store: options.store, llmAnswer: tickLlm(options, "idea_radar", "extract", roles),
    ...(options.radarFetch ? { fetch: options.radarFetch } : {}), env: process.env, now, signal
```

`src/telegram/telegram-daemon.ts` hunk 11 (near line 556). Replace:

```ts
  await runIdeaPanelTick({
    store: options.store, ...(options.panelSeats ?? buildPanelSeatBindings(options)),
    env: process.env, now, chatId, projectRoot: options.projectRoot, signal
  });
  if (signal.aborted) return;
  const reverifyLlm = tickLlm(options, "skill_reverify", "verify");
  await runSkillReverifyTick({
```

with:

```ts
  await runIdeaPanelTick({
    store: options.store, ...(options.panelSeats ?? buildPanelSeatBindings(options, roles)),
    env: process.env, now, chatId, projectRoot: options.projectRoot, signal
  });
  if (signal.aborted) return;
  const reverifyLlm = tickLlm(options, "skill_reverify", "verify", roles);
  await runSkillReverifyTick({
```

`src/telegram/telegram-daemon.ts` hunk 12 (near line 593). Replace:

```ts

/** The panel's real seats: the omp judge/chair seats (idea-panel-seats), audited under one `tick:idea_panel:<uuid>` per panel run. */
function buildPanelSeatBindings(options: RunTelegramDaemonOptions): PanelSeatBindings {
  return buildOmpPanelSeats({ store: options.store, correlation_id: tickCorrelationId("idea_panel"), env: process.env, signal: options.stopSignal });
}
```

with:

```ts

/** The panel's real seats: the omp judge/chair seats (idea-panel-seats) on the roles' chains, audited under one `tick:idea_panel:<uuid>` per panel run. */
function buildPanelSeatBindings(options: RunTelegramDaemonOptions, roles: Pick<RoleResolver, "chains">): PanelSeatBindings {
  return buildOmpPanelSeats({ store: options.store, correlation_id: tickCorrelationId("idea_panel"), env: process.env, chains: roles.chains(), signal: options.stopSignal });
}
```

- [ ] **Step 16: The memory-a1 gate script**

`scripts/live-gate-memory-a1.mjs` hunk 1 (near line 59). Replace:

```js
async function loadModules() {
  const [env, mig, turn, render, ret, wiki, ev, ex, reg, cfg, ms, emb, rs, tmp, arm, dist] = await Promise.all([
    import("../dist/config/load-env.js"), import("../dist/run/memory-a1-migration.js"), import("../dist/omp/turn-context.js"),
```

with:

```js
async function loadModules() {
  const [env, mig, turn, render, ret, wiki, ev, ex, reg, cfg, ms, emb, rs, tmp, arm, dist, roles] = await Promise.all([
    import("../dist/config/load-env.js"), import("../dist/run/memory-a1-migration.js"), import("../dist/omp/turn-context.js"),
```

`scripts/live-gate-memory-a1.mjs` hunk 2 (near line 65). Replace:

```js
    import("../dist/llm/embeddings.js"), import("../dist/run/run-store.js"), import("../dist/run/daemon-tmp.js"),
    import("../dist/capabilities/wiki.js"), import("../dist/capabilities/distill.js")
  ]);
  return { env, mig, turn, render, ret, wiki, ev, ex, reg, cfg, ms, emb, rs, tmp, arm, dist };
}
```

with:

```js
    import("../dist/llm/embeddings.js"), import("../dist/run/run-store.js"), import("../dist/run/daemon-tmp.js"),
    import("../dist/capabilities/wiki.js"), import("../dist/capabilities/distill.js"), import("../dist/omp/model-roles.js")
  ]);
  return { env, mig, turn, render, ret, wiki, ev, ex, reg, cfg, ms, emb, rs, tmp, arm, dist, roles };
}
```

`scripts/live-gate-memory-a1.mjs` hunk 3 (near line 218). Replace:

```js
  const legs = m.cfg.resolveOmpConfig(process.env).ticks;
  if (legs.length === 0) throw new Error("no ticks legs configured (HOUGE_OMP_TICKS)");
  let facts = 0;
  for (const leg of legs) {
    const name = m.ms.formatModelString(leg);
    const llm = m.reg.tickSeat(store, "episodic_distill", "distill", { ...process.env, HOUGE_OMP_TICKS: name });
    facts += (await runLeg(m, store, name, llm, win, fails)).facts;
```

with:

```js
  const legs = m.cfg.resolveOmpConfig(process.env).ticks;
  if (legs.length === 0) throw new Error("no ticks legs configured (the Tiny role list)");
  let facts = 0;
  for (const leg of legs) {
    const name = m.ms.formatModelString(leg);
    const llm = m.reg.tickSeat(store, "episodic_distill", "distill", process.env, () => ({ ...m.roles.staticRoleChains(), ticks: [leg] }));
    facts += (await runLeg(m, store, name, llm, win, fails)).facts;
```

- [ ] **Step 17: Run the touched tests, then the full suite, typecheck and build**

Run: `npx vitest run tests/omp tests/llm tests/core/core-worker-reader-family.test.ts tests/core/core-worker-omp-turn.test.ts tests/core/core-worker-runner-caps.test.ts tests/telegram/telegram-daemon.test.ts tests/status tests/media tests/capabilities tests/run`
Expected: PASS.

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck clean; every test passes with none skipped (3502 on the verification copy); build succeeds.

Run: `grep -rnE "HOUGE_OMP_(PLANNER|READER|MEDIA|TICKS|JUDGES|CHAIR|REVIEWER)" src tests scripts`
Expected hits, and only these:
- `src/omp/omp-config.ts` (`RETIRED_OMP_CHAIN_VARS`);
- `tests/omp/omp-config.test.ts`;
- `tests/telegram/telegram-daemon.test.ts` (the warning test);
- comments: `tests/core/core-worker-omp-turn.test.ts` and `tests/omp/planner-supervisor.test.ts:1124`;
- wording only: `tests/capabilities/idea-panel-seats.test.ts:11,13,34` and `tests/capabilities/panel-judge-providers.test.ts:20`;
- `scripts/eval-replay.mjs` (help text) and `scripts/live-gate-omp.mjs` (see Drafter notes).

Any other hit in `src` is a missed consumer.

- [ ] **Step 18: Commit**

```bash
git add src/omp/omp-config.ts src/llm/providers/omp.ts src/llm/registry.ts src/core/core-worker.ts src/telegram/telegram-daemon.ts \
  src/media/media-ingest.ts src/media/media-config.ts src/status/houge-status.ts src/capabilities/idea-panel-seats.ts src/capabilities/diff-reviewer.ts \
  scripts/live-gate-memory-a1.mjs tests/fixtures/fake-omp.mjs tests/helpers/omp-env.ts tests/helpers/omp-worker.ts \
  tests/omp/omp-config.test.ts tests/llm/providers/omp.test.ts tests/llm/seat-routing.test.ts tests/core/core-worker-reader-family.test.ts \
  tests/core/core-worker-omp-turn.test.ts tests/core/core-worker-runner-caps.test.ts tests/telegram/telegram-daemon.test.ts \
  tests/status/houge-status.test.ts tests/media/media-call.test.ts tests/capabilities/idea-panel-seats.test.ts \
  tests/capabilities/diff-reviewer.test.ts tests/omp/planner-supervisor.test.ts
git commit -m "$(cat <<'EOF'
feat(omp): seats run on resolved model roles; HOUGE_OMP_* chains retired; D10 skip rule

resolveOmpConfig takes its chains from the caller (RoleResolver.chains(),
default the static lists, today's chains); the seven chain variables are no
longer read and a still-set one is named once at boot. CoreWorker owns the
resolver; the daemon reads omp's catalog before the first turn, offers the
hourly retry each poll cycle, and runs its ticks and the panel on the roles.
In resolved mode a reader call runs its cross-family candidates first; static
keeps today's order.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

---

### Task 8: The planner supervisor's two-axis chain (spec §4 step-up and retry rules, §5)

**Assembly overrides (binding; orchestrator, 2026-10-07; this block wins where the task text disagrees):**
- Do **not** add the `routed_escalation` event type: Task 9 owns it. This task only writes it.
- Step-up and the `other`-once retry apply only to a turn whose `TriageOutcome` carries a `route`. Task 10 attaches a
  route on every Telegram turn except when `HOUGE_JEV_TRIAGE_ENABLED` resolves to `off`. The rollback must reproduce
  today's chain semantics: no route, the Default list, no step-up, no `other` retry.
- **(F3)** The `tests/omp/planner-supervisor.test.ts` hunks below apply to the file as **Task 7** left it: `harness`
  with `o.planner`, and the four `harness(session, {}, {}, { planner: … })` call sites.

**Contract deviation (no renames):**
1. `src/core/core-worker.ts` changes in one place. `supervisorDeps` (`:2166-2179`), the one `SupervisorDeps`
   construction site, must pass the new required `roles`.
2. **(F7 d)** `SupervisorDeps.roles` is `Pick<RoleResolver, "candidates" | "requestRefresh">`; the contract says
   `Pick<…, "candidates">`. `noLeg()` asks the resolver to re-read omp's catalog, and the resolver rate-limits it.
3. **(F15)** `LlmAttempt` gains `effort?: OmpEffort` beside `routed_by`, and the `llm_attempt` payload carries it when set.

**Files:**
- Modify: `src/omp/planner-supervisor.ts`:
  - imports (`:4-31`); `TurnOutcomeSink` (`:42-52`) gains `routeEnd?`; `TurnRoute`, `QuoteRef`, `TriageOutcome`
    (`:53-54`); `SupervisorDeps` (`:57-78`) gains `roles`;
  - constants (`:100-103`): `NO_SPAWN_MODEL`, `UNRESOLVED_MODEL`, a `StartResult` with `missing: ModelString`,
    `PinResult`;
  - `SpawnRec` (`:108`); `Turn` (`:110-132`) gains the turn-axis fields; `isModelRefusal` and `quotedId`, after `rpcCode`
    (`:137`);
  - the field `sessionLeg` (`:203-204`) becomes `refused`; the constructor (`:217`); `top()` (`:287`) becomes
    `spawnChain()` / `turnChain()`;
  - `newTurn` (`:372-376`); `startTurn` (`:408-433`); new `routeTurn`; `finishLane` (`:455`);
  - `promptTop` (`:490-511`) with new `pinFirst`, `pinWalk`, `currentCandidate`, `stepUp`, `pin`, `noLeg`;
    `resetTop` (`:520-532`) is removed;
  - `retryNextLeg` (`:547-576`) with new `mayRetry` and `promptRetry`;
  - `ensureSession` (`:580-596`), `startSession` (`:598-619`), `afterWarm` (`:621-630`);
  - `recordStartMissing` (`:632-640`), plus new `recordPinMissing` and `audit`;
  - `spawn` (`:693-736`); `spawnFailed` (`:815-829`);
  - the three remaining direct sink calls go through `audit`: `onErrorFrame` (`:920-929`), `onAssistant` (`:946-964`),
    `recordAborted` (`:1046-1053`);
  - `finishSuccess` / `finishFailure` (`:1020-1040`) call the new `routeEnd`.
- Modify: `src/omp/planner-session.ts:24-33` (`PlannerRpcError.detail`), `:149-150` (keep omp's capped text on the error).
- Modify: `src/llm/audit.ts:68-69` (`LlmAttempt.routed_by?`, `LlmAttempt.effort?`).
- Modify: `src/run/run-store.ts`: `llmAuditSink` carries `routed_by` and `effort`. The anchor is the
  `if (attempt.request_key …)` line (`:1885` on main).
- Modify: `src/core/core-worker.ts:2177`: `roles: this.roles`.
- Test: `tests/omp/planner-supervisor.test.ts`:
  - the fake session records `pins`; the sink records `routeEnds`; new `fakeRoles` (with `refreshes`) and harness
    `roles`;
  - Task 7's four `o.planner` call sites move to `fakeRoles`, and `o.planner` is removed;
  - the respawn test (`:729-744`) is replaced; one assertion is added to the unrouted no-leg test; a new describe.
- Test: `tests/omp/planner-session.test.ts`, `tests/run/llm-audit-sink.test.ts`.

**Interfaces:**
- Consumes:
  - `TurnRole`, `Effort` (`src/jev/tree-policy.ts`, Task 5);
  - `selectorKey`, `STEP_UP` (`src/omp/model-roles.ts`, Task 6);
  - the `RoleResolver` type with `candidates(role, { refused, effort })` and `requestRefresh()`, and the instance Task 7
    holds on `CoreWorker` as `this.roles` (`src/omp/role-resolver.ts`, Task 7);
  - `QuoteRef.line` is `quotedLine(...)` output, passed as `TurnPromptInput.quoted`; `recordChatTurn({ quoted_turn_id })`
    (Task 4);
  - `classifyOmpError`, `RETRYABLE_ERROR_KINDS` (`omp-frames.ts:66-79`);
  - `PlannerSession.setModel`, which sends `set_model` then `set_thinking_level` when the candidate has an effort
    (`planner-session.ts:92-95`).
- Produces (contract):
  - `export interface TurnRoute { role: TurnRole; effort: Effort | null; verdict_id: string | null }`;
  - `export type TriageOutcome` with `route?` / `quote?`; `export interface QuoteRef { turn_id: string; line: string }`;
  - `SupervisorDeps.roles`;
  - `TurnOutcomeSink.routeEnd?(i: { run_id; verdict_id; handler_outcome: "planner_done" | "planner_failed";
    model: string | null; fast_used_tool: boolean; pin_failed: boolean })`;
  - `PlannerRpcError.detail?: string`;
  - `LlmAttempt.routed_by?: string` and `LlmAttempt.effort?: OmpEffort`, both carried on the `llm_attempt` payload;
  - writes ledger event `routed_escalation { from, to, kind }`.

Behaviour (a test below pins each rule):
- **Spawn axis.**
  - `ensureSession(fresh)` spawns `roles.candidates("default", { refused })[0]`.
  - `fresh = true` clears the child's refused set. That is the warm start, `afterWarm`, and the first attempt in
    `startSession`.
  - After a start refusal, `recordStartMissing` adds the refused selector and `ensureSession(false)` spawns the next
    candidate.
  - No candidate left → `planner_no_leg` incident + `no_planner_leg` / `model_missing` (as today) +
    `roles.requestRefresh()`.
  - The respawn rule `leg === 0 && sessionLeg > 0` and `sessionLeg` are gone: a child on a later Default candidate is kept.
  - With F7 the Default role never resolves empty: it falls back to its static list. The axis is spent only when the
    child refused every candidate.
- **Turn axis.**
  - `routeTurn` stores the triage verdict's `route` on the turn.
  - In `promptTop`, after the child is ready (so a spawn refusal is already excluded),
    `turn.chain = roles.candidates(route?.role ?? "default", { refused, effort: route?.effort ?? null })`.
  - `turn.chain[legIndex]` is pinned unless the child already holds exactly that selector and effort.
  - An emptied Fast (`[]`, F7) steps a routed turn up at once (`routed_escalation`, kind `model_missing`).
  - A pin rejected with `PlannerRpcError("command_failed:set_model", detail)`, where `detail` classifies
    `model_missing`, is one `model_missing` `llm_attempt` (key `<run>:pin:<k>`). The selector joins `refused` and the
    walk moves on, then steps up for a routed turn.
  - Any other pin failure answers on the held model, raises `planner_model_reset_failed`, marks the turn `pin_failed`,
    and that turn never steps up. This covers `timeout:set_model`, `not_running`, a refused `set_thinking_level`, and
    a plain Error.
- **Retry boundary.**
  - Retryable kinds (`quota`, `auth`, `transport`, `timeout`, `model_missing`) walk `turn.chain`.
  - A spent chain steps a **routed** turn up (`STEP_UP`, same effort, `routed_escalation { from: role, to: role, kind }`).
  - Thinking spent, or an unrouted turn's Default spent → `no_planner_leg` + `planner_no_leg` + `requestRefresh()`.
    This is today's semantics for schedule turns and turns without a route.
  - `other` is retried once, only on a routed turn and only while `!turn.usedTool`.
  - `RETRY_NOTE` is unchanged.
- **Audit and outcome.**
  - Every compose `llm_attempt` goes through `audit()`.
  - Each row carries the `effort` of the selector it ran on (F15): the spawn candidate for a start refusal, the pin
    target for a pin refusal, else the pinned model.
  - The first row of a routed turn carries `routed_by = verdict_id`, whichever comes first after triage: a start
    refusal, a pin refusal or a dispatch row.
  - `finishSuccess` / `finishFailure` call `outcome.routeEnd` when the route has a `verdict_id`.
  - `model` is what really answered (`message_end`), else the pinned selector if a prompt went out, else null.
  - `fast_used_tool = turn.role === "fast" && usedTool`, using the role the turn finished on.
- **Quote.** The user chat turn records `quoted_turn_id` on both the planner and lane paths. The planner prompt gets
  `quoted: quote.line`.

- [ ] **Step 1: Write the failing tests**

`tests/omp/planner-session.test.ts` hunk 1 (near line 113). Replace:

```ts
    expect(cmds).toEqual(["open_session", "set_model", "set_thinking_level"]);
  });
```

with:

```ts
    expect(cmds).toEqual(["open_session", "set_model", "set_thinking_level"]);
  });

  it("a refused set_model keeps omp's text as `detail` (≤ 200 chars) for the supervisor's classifier; `code` and `message` stay fixed", async () => {
    // spec §5: a pin omp answers `Model not found` is model_missing (walk on), anything else a failed pin — only the text tells them apart
    const { s } = make({ rpcSetModelError: "Model not found: anthropic/claude-sonnet-5-5" });
    await s.start();
    const err = await s.setModel(parseModelString("anthropic/claude-sonnet-5-5:low")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlannerRpcError);
    expect(err).toMatchObject({ code: "command_failed:set_model", message: "command_failed:set_model", detail: "Model not found: anthropic/claude-sonnet-5-5" });
    const long = make({ rpcSetModelError: "x".repeat(500) });
    await long.s.start();
    const capped = await long.s.setModel(parseModelString("kimi-code/k3")).catch((e: unknown) => e);
    expect((capped as PlannerRpcError).detail).toHaveLength(200);
  });
```

`tests/run/llm-audit-sink.test.ts` hunk 1 (near line 29). Replace:

```ts
describe("RunStore.llmAuditSink", () => {
  it("run-scoped: writes llm_attempt under the run, with the SCOPED role overriding the chain's", () => {
```

with:

```ts
describe("RunStore.llmAuditSink", () => {
  it("carries routed_by and effort when set (the verdict join, Jev tree spec §6; the pinned level, plan F15) and omits them otherwise", () => {
    const store = RunStore.openInMemory();
    try {
      const run_id = createRun(store);
      const sink = store.llmAuditSink({ run_id, role: "compose" });
      sink.record({ provider: "anthropic", role: "", outcome: "ok", model: "claude-sonnet-5-5", routed_by: "jv_1", effort: "high" });
      sink.record({ provider: "anthropic", role: "", outcome: "ok", model: "claude-sonnet-5-5" });
      expect(attemptsOf(store).map((e) => [e.payload.routed_by, e.payload.effort])).toEqual([["jv_1", "high"], [undefined, undefined]]);
    } finally {
      store.close();
    }
  });

  it("run-scoped: writes llm_attempt under the run, with the SCOPED role overriding the chain's", () => {
```

`tests/omp/planner-supervisor.test.ts` hunk 1 (near line 8). Replace:

```ts
import { resolveOmpConfig } from "../../src/omp/omp-config.js";
import { staticRoleChains } from "../../src/omp/model-roles.js";
import { parseModelChain } from "../../src/omp/model-string.js";
import { PlannerSupervisor, RETRY_NOTE, parseAttachments, type PlannerSessionLike, type SupervisorDeps, type SupervisorState, type TurnOutcomeSink } from "../../src/omp/planner-supervisor.js";
```

with:

```ts
import { resolveOmpConfig } from "../../src/omp/omp-config.js";
import { PlannerSupervisor, RETRY_NOTE, parseAttachments, type PlannerSessionLike, type SupervisorDeps, type SupervisorState, type TurnOutcomeSink } from "../../src/omp/planner-supervisor.js";
```

`tests/omp/planner-supervisor.test.ts` hunk 2 (near line 16). Replace:

```ts
import { chatWorkspace } from "../../src/omp/workspace.js";
import { openManifestClient } from "../helpers/bridge-manifest.js";
```

with:

```ts
import { chatWorkspace } from "../../src/omp/workspace.js";
import { formatModelString, parseModelString, type ModelString } from "../../src/omp/model-string.js";
import { selectorKey } from "../../src/omp/model-roles.js";
import type { Effort, TurnRole } from "../../src/jev/tree-policy.js";
import { openManifestClient } from "../helpers/bridge-manifest.js";
```

`tests/omp/planner-supervisor.test.ts` hunk 3 (near line 47). Replace:

```ts
  prompts: string[]; steers: string[]; models: string[]; options: PlannerSessionOptions[];
  exit: (c: number) => void; assistant: (text: string, extra?: object) => void; bind: (o: PlannerSessionOptions) => Fake;
```

with:

```ts
  prompts: string[]; steers: string[]; models: string[]; options: PlannerSessionOptions[];
  /** Every set_model with its effort (`provider/model[:effort]`): what set_thinking_level was asked for. */
  pins: string[];
  exit: (c: number) => void; assistant: (text: string, extra?: object) => void; bind: (o: PlannerSessionOptions) => Fake;
```

`tests/omp/planner-supervisor.test.ts` hunk 4 (near line 68). Replace:

```ts
  const s: Fake = {
    prompts: [], steers: [], models: [], options: [], resets: 0,
    bind: (o) => { s.options.push(o); return s; },
```

with:

```ts
  const s: Fake = {
    prompts: [], steers: [], models: [], pins: [], options: [], resets: 0,
    bind: (o) => { s.options.push(o); return s; },
```

`tests/omp/planner-supervisor.test.ts` hunk 5 (near line 93). Replace:

```ts
    abort: async () => { setTimeout(() => emit({ type: "agent_end", aborted: true }), 5); },
    setModel: async (m: { provider: string; model: string }) => {
      s.models.push(`${m.provider}/${m.model}`); if (script.logSetModel) script.log?.push(`setModel:${m.provider}/${m.model}`);
      await script.setModel?.(s.models.length);
```

with:

```ts
    abort: async () => { setTimeout(() => emit({ type: "agent_end", aborted: true }), 5); },
    setModel: async (m: ModelString) => {
      s.models.push(`${m.provider}/${m.model}`); s.pins.push(formatModelString(m)); if (script.logSetModel) script.log?.push(`setModel:${m.provider}/${m.model}`);
      await script.setModel?.(s.models.length);
```

`tests/omp/planner-supervisor.test.ts` hunk 6 (near line 115). Replace:

```ts

type Outcome = TurnOutcomeSink & { done: unknown[]; failed: unknown[]; incidents: unknown[]; resetOks: number };
function sink(store: RunStore): Outcome {
  const outcome: Outcome = {
    done: [], failed: [], incidents: [], resetOks: 0,
    sessionResetOk: () => { outcome.resetOks++; },
    complete: (i) => { outcome.done.push(i); store.finishRun({ run_id: i.run_id, expected_worker_id: i.worker_id, next: "completed", report_ref: "r", duration_ms: i.duration_ms, tool_calls: i.tool_calls }); },
```

with:

```ts

type Outcome = TurnOutcomeSink & { done: unknown[]; failed: unknown[]; incidents: unknown[]; resetOks: number; routeEnds: unknown[] };
function sink(store: RunStore): Outcome {
  const outcome: Outcome = {
    done: [], failed: [], incidents: [], resetOks: 0, routeEnds: [],
    sessionResetOk: () => { outcome.resetOks++; },
    routeEnd: (i) => { outcome.routeEnds.push(i); },
    complete: (i) => { outcome.done.push(i); store.finishRun({ run_id: i.run_id, expected_worker_id: i.worker_id, next: "completed", report_ref: "r", duration_ms: i.duration_ms, tool_calls: i.tool_calls }); },
```

`tests/omp/planner-supervisor.test.ts` hunk 7 (near line 127). Replace:

```ts

/** `o.planner` replaces the planner chain (the retired HOUGE_OMP_PLANNER); default the static Default list, today's chain. */
function harness(session = fakeSession(), env: Record<string, string> = {}, extra: Partial<SupervisorDeps> = {}, o: { sessionState?: "current" | "none"; planner?: string } = {}) {
  const store = RunStore.openInMemory();
```

with:

```ts

/** The role lists the supervisor tests run on: Default is today's planner chain (the pre-stage-A seat). */
const TEST_ROLES: Record<TurnRole, string[]> = {
  default: ["anthropic/claude-opus-5-5:medium", "google-antigravity/claude-opus-4-6:medium", "kimi-code/k3:low"],
  fast: ["anthropic/claude-sonnet-5-5:low", "google-antigravity/gemini-3.8-flash:low"],
  thinking: ["anthropic/claude-opus-5-5:high", "google-antigravity/claude-opus-4-6:high"]
};
type Roles = SupervisorDeps["roles"] & { calls: Array<{ role: string; effort: string | null; refused: string[] }>; refreshes: number };
/** A resolver stand-in: the role's list minus the refused set; a routed effort replaces the list's (resolved mode, no clamp). */
function fakeRoles(over: Partial<Record<TurnRole, string[]>> = {}): Roles {
  const lists: Record<string, string[]> = { ...TEST_ROLES, ...over };
  const roles: Roles = {
    calls: [], refreshes: 0,
    requestRefresh: () => { roles.refreshes++; },
    candidates: (role, o = {}) => {
      roles.calls.push({ role, effort: o.effort ?? null, refused: [...(o.refused ?? [])] });
      return (lists[role] ?? []).map(parseModelString)
        .filter((m) => !(o.refused?.has(selectorKey(m)) ?? false))
        .map((m) => (o.effort ? { ...m, effort: o.effort } : m));
    }
  };
  return roles;
}

function harness(session = fakeSession(), env: Record<string, string> = {}, extra: Partial<SupervisorDeps> = {}, o: { sessionState?: "current" | "none" } = {}) {
  const store = RunStore.openInMemory();
```

`tests/omp/planner-supervisor.test.ts` hunk 8 (near line 138). Replace:

```ts
  const sup = new PlannerSupervisor({
    chatId: "42", store, cfg: resolveOmpConfig({ HOUGE_OMP_SANDBOX: "0", ...env }, { ...staticRoleChains(), ...(o.planner ? { planner: parseModelChain(o.planner) } : {}) }), ctx: { home: data, repo: data, data }, distDir: data,
    decls: [], env: {}, turnEnvelopeActions: ["shell"],
```

with:

```ts
  const sup = new PlannerSupervisor({
    chatId: "42", store, cfg: resolveOmpConfig({ HOUGE_OMP_SANDBOX: "0", ...env }), ctx: { home: data, repo: data, data }, distDir: data,
    decls: [], env: {}, turnEnvelopeActions: ["shell"],
```

`tests/omp/planner-supervisor.test.ts` hunk 9 (near line 143). Replace:

```ts
    posture: () => null, outcome, sessionFactory: (o) => session.bind(o), versionCheck: () => ({ ok: true, version: "18.4.4" }),
    skipPreflightForTest: true, manifestWaitMs: 5_000, ...extra
  });
```

with:

```ts
    posture: () => null, outcome, sessionFactory: (o) => session.bind(o), versionCheck: () => ({ ok: true, version: "18.4.4" }),
    skipPreflightForTest: true, manifestWaitMs: 5_000, roles: fakeRoles(), ...extra
  });
```

`tests/omp/planner-supervisor.test.ts` hunk 10 (near line 302). Replace:

```ts
    expect(outcome.incidents).toContainEqual(expect.objectContaining({ k: "planner_no_leg" }));
  });
```

with:

```ts
    expect(outcome.incidents).toContainEqual(expect.objectContaining({ k: "planner_no_leg" }));
    expect(session.models).toHaveLength(3); // an unrouted turn never steps up past Default (today's chain semantics)
  });
```

`tests/omp/planner-supervisor.test.ts` hunk 11 (near line 731). Replace:

```ts

  it("the next turn retries the top string once (a respawn), and returns to it when it is back", async () => {
    const bad = [TOP];
```

with:

```ts

  it("a spawn-refused Default head is never respawned or pinned by a later turn on the same child; a restart clears it (spec §4-5)", async () => {
    // the removed respawn rule cost a cold start per turn; set_model moves the live child, and a selector omp refused
    // stays refused for the child's life (a model can stay catalogued while refusing)
    const bad = [TOP];
```

`tests/omp/planner-supervisor.test.ts` hunk 12 (near line 736). Replace:

```ts
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle(); // still bad: one retry of TOP, then SECOND again
    expect(spawnedModels(session)).toEqual([TOP, SECOND, TOP, SECOND]);
    bad.length = 0;
    const third = createQueuedTurnRun(store);
    sup.submit(req(third)); await sup.whenIdle();
    expect(spawnedModels(session)).toEqual([TOP, SECOND, TOP, SECOND, TOP]);
    expect(attempts(store, third).map((r) => r.error_kind)).toEqual([undefined]);
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle(); // on TOP now: the live child is kept
    expect(session.options).toHaveLength(5);
    expect(outcome.done).toHaveLength(4);
  });
```

with:

```ts
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    expect(spawnedModels(session)).toEqual([TOP, SECOND]);
    expect(session.models).toEqual([SECOND]); // the second turn kept the pinned SECOND: no respawn, no pin of TOP
    bad.length = 0;
    store.addLesson({ scope: "ask", text: "new lesson", source: "user_feedback" }); // the prompt changed: a fresh child
    const third = createQueuedTurnRun(store);
    sup.submit(req(third)); await sup.whenIdle();
    expect(spawnedModels(session)).toEqual([TOP, SECOND, TOP]);
    expect(session.models).toEqual([SECOND, TOP]);
    expect(attempts(store, third).map((r) => r.error_kind)).toEqual([undefined]);
    expect(outcome.done).toHaveLength(3);
  });
```

`tests/omp/planner-supervisor.test.ts` hunk 13 (near line 876). Replace:

```ts
    const session = fakeSession({ onPrompt: (_t, e) => { e({ type: "prompt_result", agentInvoked: false, status: "error", error: { message: "fetch failed", retryable: false } }); } });
    const { store, sup, outcome } = harness(session, {}, {}, { planner: "anthropic/claude-opus-5-5:medium" }); const run_id = createQueuedTurnRun(store);
    const t0 = Date.now();
```

with:

```ts
    const session = fakeSession({ onPrompt: (_t, e) => { e({ type: "prompt_result", agentInvoked: false, status: "error", error: { message: "fetch failed", retryable: false } }); } });
    const { store, sup, outcome } = harness(session, {}, { roles: fakeRoles({ default: ["anthropic/claude-opus-5-5:medium"] }) }); const run_id = createQueuedTurnRun(store);
    const t0 = Date.now();
```

`tests/omp/planner-supervisor.test.ts` hunk 14 (near line 1128). Replace:

```ts
describe("PlannerSupervisor — the planner runs the configured model after a session resume", () => {
  it("a fresh child is pinned to the leg it spawned on with set_model before the first prompt", async () => {
    const log: string[] = [];
    const session = fakeSession({ log, logSetModel: true, resumeModel: "anthropic/claude-opus-5-5" });
    const { store, sup, outcome } = harness(session, {}, {}, { planner: "kimi-code/k3" });
    const run_id = createQueuedTurnRun(store);
```

with:

```ts
describe("PlannerSupervisor — the planner runs the configured model after a session resume", () => {
  it("a fresh child is pinned to the turn's first candidate with set_model before the first prompt", async () => {
    const log: string[] = [];
    const session = fakeSession({ log, logSetModel: true, resumeModel: "anthropic/claude-opus-5-5" });
    const { store, sup, outcome } = harness(session, {}, { roles: fakeRoles({ default: ["kimi-code/k3"] }) });
    const run_id = createQueuedTurnRun(store);
```

`tests/omp/planner-supervisor.test.ts` hunk 15 (near line 1152). Replace:

```ts
    const session = fakeSession({ resumeModel: "anthropic/claude-opus-5-5", setModel: async () => { throw new Error("set_model refused"); } });
    const { store, sup, outcome } = harness(session, {}, {}, { planner: "kimi-code/k3" });
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
```

with:

```ts
    const session = fakeSession({ resumeModel: "anthropic/claude-opus-5-5", setModel: async () => { throw new Error("set_model refused"); } });
    const { store, sup, outcome } = harness(session, {}, { roles: fakeRoles({ default: ["kimi-code/k3"] }) });
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
```

`tests/omp/planner-supervisor.test.ts` hunk 16 (near line 1167). Replace:

```ts
    const session = fakeSession({ resumeModel: "anthropic/claude-opus-5-5" });
    const { store, sup } = harness(session, {}, {}, { planner: "kimi-code/k3" });
    expect(sup.ompVersion()).toBeNull();
```

with:

```ts
    const session = fakeSession({ resumeModel: "anthropic/claude-opus-5-5" });
    const { store, sup } = harness(session, {}, { roles: fakeRoles({ default: ["kimi-code/k3"] }) });
    expect(sup.ompVersion()).toBeNull();
```

`tests/omp/planner-supervisor.test.ts` hunk 17 (near line 1558). Replace:

```ts
    expect(outcome.failed).toHaveLength(0);
  });
});
```

with:

```ts
    expect(outcome.failed).toHaveLength(0);
  });
});

describe("PlannerSupervisor — the turn-owned chain (Jev tree spec §4-5)", () => {
  const attempts = (store: RunStore, run: string) =>
    store.getLedgerEvents(run).filter((e) => e.event_type === "llm_attempt").map((e) => e.payload as Record<string, unknown>);
  const escalations = (store: RunStore, run: string) =>
    store.getLedgerEvents(run).filter((e) => e.event_type === "routed_escalation").map((e) => e.payload);
  /** The decision point's verdict: the planner on `role` at `effort`, joined to verdict `verdict_id`. */
  const routed = (role: TurnRole, effort: Effort | null = null, verdict_id: string | null = "jv_1"): Partial<SupervisorDeps> =>
    ({ triage: async () => ({ kind: "fallthrough", route: { role, effort, verdict_id } }) });
  /** Every prompt fails with `errors[i]` (as an assistant error) until they run out, then answers "ok". */
  const failing = (errors: string[]) => {
    let calls = 0;
    const session: Fake = fakeSession({ onPrompt: (_t, e) => {
      e({ type: "turn_start" });
      const err = errors[calls++];
      if (err) session.assistant("", { stopReason: "error", errorMessage: err }); else session.assistant("ok");
      e({ type: "agent_end" });
    } });
    return session;
  };

  it("spawns on the Default role's head before triage and pins the routed role's head before the first prompt", async () => {
    // two axes: the child warms on Default (slot B), the turn's own role is applied with set_model, never by a respawn
    const log: string[] = [];
    const session = fakeSession({ log, logSetModel: true });
    const roles = fakeRoles();
    const { store, sup, outcome } = harness(session, {}, { roles, ...routed("fast", "low") });
    const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(session.options.map((o) => formatModelString(o.model))).toEqual(["anthropic/claude-opus-5-5:medium"]);
    expect(log.filter((l) => !l.startsWith("manifest"))).toEqual(["start:1", "setModel:anthropic/claude-sonnet-5-5", "prompt:1"]);
    expect(roles.calls.filter((c) => c.role === "fast")).toEqual([{ role: "fast", effort: "low", refused: [] }]);
    expect(outcome.routeEnds).toEqual([{
      run_id, verdict_id: "jv_1", handler_outcome: "planner_done", model: "anthropic/claude-sonnet-5-5", fast_used_tool: false, pin_failed: false
    }]);
  });

  it("the pin carries the routed effort, every row records it, and only the turn's FIRST llm_attempt carries routed_by", async () => {
    // set_model + set_thinking_level are one setModel call (planner-session.ts:92); the jev_verdicts join needs exactly one
    // row, and Default and Thinking share a head, so only the row's effort shows which role answered (plan F15, gate case 3)
    const session = failing(["429 usage limit reached"]);
    const { store, sup } = harness(session, {}, routed("default", "low"));
    const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(session.pins).toEqual(["anthropic/claude-opus-5-5:low", "google-antigravity/claude-opus-4-6:low"]);
    const rows = attempts(store, run_id);
    expect(rows.map((r) => [r.model, r.error_kind, r.routed_by, r.effort]))
      .toEqual([["claude-opus-5-5", "quota", "jv_1", "low"], ["claude-opus-4-6", undefined, undefined, "low"]]);
  });

  it("a routed role with no candidate (the catalog emptied Fast) steps up before the first prompt, ledgered", async () => {
    // plan F7 (b): RoleResolver returns [] for an emptied Fast; the turn must still answer, on Default, never fail
    const session = fakeSession();
    const { store, sup, outcome } = harness(session, {}, { roles: fakeRoles({ fast: [] }), ...routed("fast") });
    const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(session.pins).toEqual(["anthropic/claude-opus-5-5:medium"]);
    expect(escalations(store, run_id)).toEqual([{ from: "fast", to: "default", kind: "model_missing" }]);
    expect(outcome.routeEnds[0]).toMatchObject({ handler_outcome: "planner_done", model: "anthropic/claude-opus-5-5" });
  });

  it("every Default candidate refused at spawn: no_planner_leg, each row with its selector's effort, and one catalog refresh asked", async () => {
    // plan F7 (d): the catalog may have moved since the last read; the resolver rate-limits the re-read
    const session = fakeSession({ badModels: ["anthropic/claude-opus-5-5", "google-antigravity/claude-opus-4-6", "kimi-code/k3"] });
    const roles = fakeRoles();
    const { store, sup, outcome } = harness(session, {}, { roles });
    const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(failedOf(outcome, run_id)).toMatchObject({ error_type: "no_planner_leg", error_ref: "model_missing" });
    expect(attempts(store, run_id).map((r) => [r.model, r.effort])).toEqual([["claude-opus-5-5", "medium"], ["claude-opus-4-6", "medium"], ["k3", "low"]]);
    expect(roles.refreshes).toBe(1);
  });

  it("a pin omp refuses (`Model not found`) is one model_missing row and walks on: never pin_failed, no incident, never pinned again", async () => {
    // a Default[0] refused at spawn or pin must not become a per-turn failure; the refused set lasts the child's life
    const session = fakeSession({ setModel: async (n) => { if (n === 1) throw new PlannerRpcError("command_failed:set_model", "Model not found: anthropic/claude-sonnet-5-5"); } });
    const roles = fakeRoles();
    const { store, sup, outcome } = harness(session, {}, { roles, ...routed("fast") });
    const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(session.models).toEqual(["anthropic/claude-sonnet-5-5", "google-antigravity/gemini-3.8-flash"]);
    expect(attempts(store, run_id).map((r) => [r.model, r.error_kind, r.routed_by])).toEqual([
      ["claude-sonnet-5-5", "model_missing", "jv_1"], ["gemini-3.8-flash", undefined, undefined]
    ]);
    expect(outcome.incidents).toEqual([]);
    expect(outcome.routeEnds[0]).toMatchObject({ handler_outcome: "planner_done", pin_failed: false });
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle(); // same child, same route
    expect(session.models).toHaveLength(2); // already on gemini; the refused sonnet is never tried again
    expect(roles.calls.filter((c) => c.role === "fast").at(-1)?.refused).toEqual(["anthropic/claude-sonnet-5-5"]);
  });

  it("a pin that fails in transport answers on the held model: planner_model_reset_failed, pin_failed, no escalation", async () => {
    const session = fakeSession({ setModel: async () => { throw new PlannerRpcError("timeout:set_model"); } });
    const { store, sup, outcome } = harness(session, {}, routed("fast"));
    const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(outcome.done[0]).toMatchObject({ run_id, text: "answer" });
    expect(incidentKinds(outcome)).toEqual(["planner_model_reset_failed"]);
    expect(outcome.routeEnds[0]).toMatchObject({ model: "anthropic/claude-opus-5-5", pin_failed: true });
    expect(escalations(store, run_id)).toEqual([]);
  });

  it("a spent role steps up at the retry boundary (Fast → Default), ledgered as routed_escalation; RETRY_NOTE continues", async () => {
    const session = failing(["429 quota", "429 quota"]);
    const { store, sup, outcome } = harness(session, {}, routed("fast"));
    const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(session.models).toEqual(["anthropic/claude-sonnet-5-5", "google-antigravity/gemini-3.8-flash", "anthropic/claude-opus-5-5"]);
    expect(session.prompts).toEqual(["hi", RETRY_NOTE, RETRY_NOTE]);
    expect(escalations(store, run_id)).toEqual([{ from: "fast", to: "default", kind: "quota" }]);
    expect(outcome.done[0]).toMatchObject({ run_id, text: "ok" });
  });

  it("`other` is retried once on a routed turn while no tool ran; a second `other` is final", async () => {
    // spec §4: a deterministic failure is re-spent once on the next model, never in a loop
    const session = failing(["something odd", "something odd"]);
    const { store, sup, outcome } = harness(session, {}, routed("default"));
    const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(session.models).toEqual(["anthropic/claude-opus-5-5", "google-antigravity/claude-opus-4-6"]);
    expect(failedOf(outcome, run_id)).toMatchObject({ error_type: "model_error", error_ref: "other" });
    expect(outcome.routeEnds[0]).toMatchObject({ handler_outcome: "planner_failed" });
  });

  it("`other` after a tool ran is final at once: a failure after a side effect is never re-spent on another model", async () => {
    const session: Fake = fakeSession({ onPrompt: (_t, e) => {
      e({ type: "turn_start" }); e({ type: "tool_execution_start" });
      session.assistant("", { stopReason: "error", errorMessage: "something odd" }); e({ type: "agent_end" });
    } });
    const { store, sup, outcome } = harness(session, {}, routed("fast"));
    const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(session.prompts).toEqual(["hi"]);
    expect(failedOf(outcome, run_id)).toMatchObject({ error_type: "model_error", error_ref: "other" });
    expect(outcome.routeEnds[0]).toMatchObject({ handler_outcome: "planner_failed", fast_used_tool: true });
  });

  it("a Fast turn that ran a tool finishes on Fast, marked fast_used_tool; a route without a verdict id writes no routeEnd", async () => {
    // no mid-prompt escalation (spec §5): the calibration signal is the mark, not a second model
    const session: Fake = fakeSession({ onPrompt: (_t, e) => {
      e({ type: "turn_start" }); e({ type: "tool_execution_start" }); session.assistant("done"); e({ type: "agent_end" });
    } });
    const h = harness(session, {}, routed("fast"));
    h.sup.submit(req(createQueuedTurnRun(h.store))); await h.sup.whenIdle();
    expect(session.models).toEqual(["anthropic/claude-sonnet-5-5"]);
    expect(h.outcome.routeEnds[0]).toMatchObject({ handler_outcome: "planner_done", fast_used_tool: true });
    const bare = harness(fakeSession(), {}, routed("fast", null, null));
    const run_id = createQueuedTurnRun(bare.store);
    bare.sup.submit(req(run_id)); await bare.sup.whenIdle();
    expect(bare.outcome.routeEnds).toEqual([]);
    expect(attempts(bare.store, run_id)[0]).not.toHaveProperty("routed_by");
  });

  it("a quote: the user turn records quoted_turn_id and the prompt carries the quoted line just before the message (spec §2.2.1)", async () => {
    const quote = { turn_id: "turn_q", line: "[replying to houge, 3600 s ago: 要不要我查一下？]\n" };
    const session = fakeSession();
    const { store, sup } = harness(session, {}, { triage: async () => ({ kind: "fallthrough", quote }) });
    sup.submit(req(createQueuedTurnRun(store, "好"), "好")); await sup.whenIdle();
    expect(session.prompts).toEqual([`${quote.line}好`]);
    expect(store.getRecentChatTurns("42", 10).find((t) => t.role === "user")?.quoted_turn_id).toBe("turn_q");
    const lane = harness(fakeSession(), {}, { triage: async () => ({ kind: "lane_reply", text: "📒 Saved", buttons: [], quote }) });
    lane.sup.submit(req(createQueuedTurnRun(lane.store, "好"), "好")); await lane.sup.whenIdle();
    expect(lane.store.getRecentChatTurns("42", 10).find((t) => t.role === "user")?.quoted_turn_id).toBe("turn_q");
  });
});
```

Existing tests that keep passing unchanged, checked one by one against the new rules:
- The quota fallback (`:276-292`) and "returns to the top planner string" (`:374-381`): the fake Default list is today's
  chain, and an unrouted turn walks it as before.
- "a bad first string respawns on the second" (`:698-709`): the refused TOP is excluded from the turn chain, so the pin
  is SECOND.
- "every string rejected at spawn" (`:711-718`) and "never count toward the crash latch" (`:720-727`, 12 spawns): each
  turn's first `ensureSession(true)` clears the refused set.
- The request-key test (`:761-772`): `recordStartMissing` keeps `<run>:0:<k>`, with `k` per turn.
- "a failed reset to the top string" (`:591-605`): a plain `Error` from the pin is a failed pin (incident, answer on the
  held model), and the next turn re-pins.
- The `/kill` during a hung `set_model` (`:461-471`) and the restart-note test (`:1192-1208`): the first pin still runs
  `setModel` before dispatch.

- [ ] **Step 2: Run them to see them fail**

```bash
npx vitest run tests/omp/planner-supervisor.test.ts tests/omp/planner-session.test.ts tests/run/llm-audit-sink.test.ts
```

Expected: FAIL.
- The new describe fails: spawn and pin assertions, `routeEnds` empty, no `routed_by` / `effort`, no
  `routed_escalation`, `refreshes` 0, and `other` final at once on a routed turn.
- The replaced respawn test fails: today it spawns `[TOP, SECOND, TOP, SECOND]`.
- The `detail` test fails (`detail` undefined), and so does the audit-sink test (`routed_by` and `effort` dropped).
- The `fakeRoles`-based harness tests still pass on the old supervisor, but only where `cfg.planner` (the static
  Default, today's chain) happens to equal the fake list.

- [ ] **Step 3: Keep omp's text on a refused RPC (`detail`)**

`src/omp/planner-session.ts` hunk 1 (near line 28). Replace:

```ts
 * model mention is `exited:model_unconfirmed`), `frame_too_large` — and is all that may reach an
 * error_ref or an incident. omp's own error text never rides it (it is logged to stderr, capped).
 */
export class PlannerRpcError extends Error {
  constructor(readonly code: string) { super(code); this.name = "PlannerRpcError"; }
}
```

with:

```ts
 * model mention is `exited:model_unconfirmed`), `frame_too_large` — and is all that may reach an
 * error_ref or an incident. `detail` is omp's own text for a refused command (≤ 200 chars), kept only so the supervisor
 * can classify a refused pin (`Model not found` → model_missing); it never reaches a ref, an incident or the ledger.
 */
export class PlannerRpcError extends Error {
  constructor(readonly code: string, readonly detail?: string) { super(code); this.name = "PlannerRpcError"; }
}
```

`src/omp/planner-session.ts` hunk 2 (near line 148). Replace:

```ts
      if (f.success !== false) { w.resolve(f.data); return; }
      console.error(`planner ${w.type} failed: ${String(f.error ?? "").slice(0, OMP_ERROR_LOG_CAP)}`);
      w.reject(new PlannerRpcError(`command_failed:${w.type}`));
      return;
```

with:

```ts
      if (f.success !== false) { w.resolve(f.data); return; }
      const detail = String(f.error ?? "").slice(0, OMP_ERROR_LOG_CAP);
      console.error(`planner ${w.type} failed: ${detail}`);
      w.reject(new PlannerRpcError(`command_failed:${w.type}`, detail));
      return;
```

- [ ] **Step 4: `routed_by` and `effort` on the attempt and the payload**

`src/llm/audit.ts` hunk 1 (near line 63). Replace:

```ts
  request_key?: string;
}
```

with:

```ts
  request_key?: string;
  /** Jev tree spec §6: the `jev_verdicts` id on the FIRST attempt of a routed planner turn (the verdict → model call join). */
  routed_by?: string;
  /** Planner compose rows: the thinking level of the selector the attempt ran on, after the clamp (plan F15). */
  effort?: import("../omp/model-string.js").OmpEffort;
}
```

`src/run/run-store.ts` hunk 1 (near line 1930). Replace:

```ts
          if (attempt.request_key !== undefined) payload.request_key = attempt.request_key;
          if ("run_id" in scope) {
```

with:

```ts
          if (attempt.request_key !== undefined) payload.request_key = attempt.request_key;
          if (attempt.routed_by !== undefined) payload.routed_by = attempt.routed_by;
          if (attempt.effort !== undefined) payload.effort = attempt.effort;
          if ("run_id" in scope) {
```

- [ ] **Step 5: The supervisor**

`src/omp/planner-supervisor.ts` hunk 1 (near line 6). Replace:

```ts
import type { Identity } from "../domain/types.js";
import type { LlmAttempt } from "../llm/audit.js";
import type { TurnModality } from "../media/media-config.js";
```

with:

```ts
import type { Identity } from "../domain/types.js";
import type { Effort, TurnRole } from "../jev/tree-policy.js";
import type { LlmAttempt, LlmErrorKind } from "../llm/audit.js";
import type { TurnModality } from "../media/media-config.js";
```

`src/omp/planner-supervisor.ts` hunk 2 (near line 15). Replace:

```ts
import { createBridgeHandler, flushUnreported, type ActiveTurn } from "./bridge-handler.js";
import { familyOf, type ModelFamily, type ModelString } from "./model-string.js";
```

with:

```ts
import { createBridgeHandler, flushUnreported, type ActiveTurn } from "./bridge-handler.js";
import { selectorKey, STEP_UP } from "./model-roles.js";
import { familyOf, type ModelFamily, type ModelString } from "./model-string.js";
```

`src/omp/planner-supervisor.ts` hunk 3 (near line 21). Replace:

```ts
import { realpathOrSelf, type PathContext } from "./protected-paths.js";
import { writeSeatbeltProfiles } from "./seatbelt.js";
```

with:

```ts
import { realpathOrSelf, type PathContext } from "./protected-paths.js";
import type { RoleResolver } from "./role-resolver.js";
import { writeSeatbeltProfiles } from "./seatbelt.js";
```

`src/omp/planner-supervisor.ts` hunk 4 (near line 51). Replace:

```ts
  sessionResetOk?(): void;
}
/** Lane 1 (ADR 0029 §5.1): what the daemon decided before the planner. Anything but lane_reply/inform is today's path. */
export type TriageOutcome = { kind: "fallthrough" } | { kind: "inform"; note: string } | { kind: "lane_reply"; text: string; buttons: NotificationButton[] };
/** The lane gets the supervisor's own posture reading and the turn's abort signal; it never looks posture up itself. */
```

with:

```ts
  sessionResetOk?(): void;
  /** The tree's planner leaf ended (Jev tree spec §6): the verdict row's handler outcome, for a turn routed with a verdict id. */
  routeEnd?(i: {
    run_id: string; verdict_id: string; handler_outcome: "planner_done" | "planner_failed"; model: string | null;
    fast_used_tool: boolean; pin_failed: boolean;
  }): void;
}
/** The tree's route for a planner turn (Jev tree spec §5): the role its own chain resolves from, the effort, the verdict row. */
export interface TurnRoute { role: TurnRole; effort: Effort | null; verdict_id: string | null }
/** A Telegram quote resolved to a stored turn (spec §2.2.1): its id for the new chat turn, its rendered prompt line. */
export interface QuoteRef { turn_id: string; line: string }
/** The decision point's outcome (ADR 0029 §5.1, Jev tree spec §2): a lane reply, or the planner with an optional route. */
export type TriageOutcome =
  | { kind: "fallthrough"; route?: TurnRoute; quote?: QuoteRef }
  | { kind: "inform"; note: string; route?: TurnRoute; quote?: QuoteRef }
  | { kind: "lane_reply"; text: string; buttons: NotificationButton[]; quote?: QuoteRef };
/** The lane gets the supervisor's own posture reading and the turn's abort signal; it never looks posture up itself. */
```

`src/omp/planner-supervisor.ts` hunk 5 (near line 61). Replace:

```ts
  posture: () => string | null; outcome: TurnOutcomeSink;
  /**
```

with:

```ts
  posture: () => string | null; outcome: TurnOutcomeSink;
  /**
   * Model roles (Jev tree spec §4-5): the child spawns on "default"'s candidates; each turn pins its own routed role's.
   * `requestRefresh` re-reads omp's catalog after a no_planner_leg (the resolver rate-limits it, plan F7).
   */
  roles: Pick<RoleResolver, "candidates" | "requestRefresh">;
  /**
```

`src/omp/planner-supervisor.ts` hunk 6 (near line 99). Replace:

```ts
export const RESET_DEGRADE_AFTER = 3;
/** A start whose child omp rejected for its --model (live, 18.4.4: exits before ready): the next planner string is tried. */
const START_MODEL_MISSING = "exited:model_missing";
/** null = a ready child; string = the start failure ref; missingLeg = omp rejected planner[missingLeg] at spawn. */
type StartResult = string | null | { missingLeg: number };
const exitRef = (i: ExitInfo) => (i.code !== null ? `exit ${i.code}` : `signal ${i.signal ?? "unknown"}`);
```

with:

```ts
export const RESET_DEGRADE_AFTER = 3;
/** A start whose child omp rejected for its --model (live, 18.4.4: exits before ready): Default's next candidate is tried. */
const START_MODEL_MISSING = "exited:model_missing";
/** The Default role has no candidate this child sequence has not refused: the spawn axis is spent (spec §4). */
const NO_SPAWN_MODEL = "no_spawn_model";
/** Before any child: the Default role resolved nothing, so the intended model is unknown (audit rows say so). */
const UNRESOLVED_MODEL: ModelString = { provider: "unresolved", model: "unresolved" };
/** null = a ready child; string = the start failure ref; missing = omp rejected that selector at spawn. */
type StartResult = string | null | { missing: ModelString };
/** One pin: done, refused by omp (walk on), the turn ended, or any other failure (transport, timeout, set_thinking_level). */
type PinResult = "ok" | "refused" | typeof ENDED | { error: unknown };
const exitRef = (i: ExitInfo) => (i.code !== null ? `exit ${i.code}` : `signal ${i.signal ?? "unknown"}`);
```

`src/omp/planner-supervisor.ts` hunk 7 (near line 107). Replace:

```ts

interface SpawnRec { gen: number; leg: number; exit?: string; started?: Promise<unknown>; bridgeLost?: boolean }
```

with:

```ts

interface SpawnRec { gen: number; model: ModelString; exit?: string; started?: Promise<unknown>; bridgeLost?: boolean }
```

`src/omp/planner-supervisor.ts` hunk 8 (near line 129). Replace:

```ts
  laneButtons?: NotificationButton[];
  /** The lane owns this turn's terminal: a late start result may no longer fail or re-enter it. */
```

with:

```ts
  laneButtons?: NotificationButton[];
  /** Spec §5 turn axis: the tree's route (null = unrouted: no step-up, no `other` retry), the role and effort its chain resolves from. */
  route: TurnRoute | null; role: TurnRole; effort: Effort | null;
  /** The turn's candidates (legIndex indexes it), resolved after the child is ready so a spawn refusal is excluded. */
  chain: ModelString[];
  /** The verdict id the turn's FIRST llm_attempt carries as routed_by (spec §6); cleared once written. */
  routedBy: string | undefined;
  /** Spawn refusals (keys `<run>:0:<k>`) and candidates tried (planner_no_leg's legs_tried) in this turn. */
  startMissing: number; legsTried: number;
  /** `other` was retried once (spec §4); the first pin failed in transport (pin_failed: no step-up on this child). */
  retriedOther: boolean; pinFailed: boolean;
  /** The lane owns this turn's terminal: a late start result may no longer fail or re-enter it. */
```

`src/omp/planner-supervisor.ts` hunk 9 (near line 137). Replace:

```ts
const rpcCode = (e: unknown) => (e instanceof PlannerRpcError ? e.code : errorCode(e));
const sameModel = (a: ModelString, b: ModelString) => a.provider === b.provider && a.model === b.model && a.effort === b.effort;
```

with:

```ts
const rpcCode = (e: unknown) => (e instanceof PlannerRpcError ? e.code : errorCode(e));
/** omp refused the pinned model (`Model not found: …`, spec §5): omp's text is read here, classified, and dropped. */
const isModelRefusal = (e: unknown) =>
  e instanceof PlannerRpcError && e.code === "command_failed:set_model" && classifyOmpError(e.detail ?? "") === "model_missing";
const quotedId = (q: QuoteRef | undefined) => (q ? { quoted_turn_id: q.turn_id } : {});
const sameModel = (a: ModelString, b: ModelString) => a.provider === b.provider && a.model === b.model && a.effort === b.effort;
```

`src/omp/planner-supervisor.ts` hunk 10 (near line 202). Replace:

```ts
  private spawning: SpawnRec | undefined;
  /** Planner-string index the live child was spawned on; > 0 means a start-time fallback, so the next turn respawns on planner[0] once. */
  private sessionLeg = 0;
  /** Resolves the current child's pending start/manifest waits when that child is replaced or stopped. */
  private supersede: () => void = () => undefined;
  /** A setModel failed or was cut off: the applied model is unknown, so the next turn resets to the top string. */
  private modelUnknown = false;
  private idleExit: ReturnType<typeof setTimeout> | undefined;
  /** The model the supervisor intends the child to run (the spawn leg, the top string, or a fallback leg). */
  private model: ModelString;
```

with:

```ts
  private spawning: SpawnRec | undefined;
  /** Selectors this child refused at spawn or at a pin (spec §4 step 4): skipped for its life; cleared when a fresh spawn starts. */
  private refused = new Set<string>();
  /** Resolves the current child's pending start/manifest waits when that child is replaced or stopped. */
  private supersede: () => void = () => undefined;
  /** A setModel failed or was cut off: the applied model is unknown, so the next turn re-pins its own first candidate. */
  private modelUnknown = false;
  private idleExit: ReturnType<typeof setTimeout> | undefined;
  /** The model the supervisor intends the child to run (the spawn candidate, then each turn's pinned candidate). */
  private model: ModelString;
```

`src/omp/planner-supervisor.ts` hunk 11 (near line 216). Replace:

```ts

  constructor(private readonly d: SupervisorDeps) { this.model = this.top(); }
```

with:

```ts

  constructor(private readonly d: SupervisorDeps) { this.model = this.spawnChain()[0] ?? UNRESOLVED_MODEL; }
```

`src/omp/planner-supervisor.ts` hunk 12 (near line 286). Replace:

```ts

  private top(): ModelString { return this.d.cfg.planner[0] as ModelString; }
  private workspace(): string { return chatWorkspace(this.d.ctx.data, this.d.chatId); }
```

with:

```ts

  /** The spawn axis (spec §5): the Default role's candidates, minus what this child sequence refused. */
  private spawnChain(): ModelString[] { return this.d.roles.candidates("default", { refused: this.refused }); }
  /** The turn axis (spec §5): the routed role's candidates at the routed effort, minus what this child refused. */
  private turnChain(role: TurnRole, effort: Effort | null): ModelString[] {
    return this.d.roles.candidates(role, { refused: this.refused, effort });
  }
  private workspace(): string { return chatWorkspace(this.d.ctx.data, this.d.chatId); }
```

`src/omp/planner-supervisor.ts` hunk 13 (near line 374). Replace:

```ts
      usedTool: false, legIndex: 0, live: false, finished: false, laneEnded: false, aborting: false, dispatched: false, childGen: -1, approvals: 0, ...newDeferred(),
      deadlineLeft: cfg.turnTimeoutMs, deadlineAt: Date.now()
```

with:

```ts
      usedTool: false, legIndex: 0, live: false, finished: false, laneEnded: false, aborting: false, dispatched: false, childGen: -1, approvals: 0, ...newDeferred(),
      route: null, role: "default", effort: null, chain: [], routedBy: undefined, startMissing: 0, legsTried: 0, retriedOther: false, pinFailed: false,
      deadlineLeft: cfg.turnTimeoutMs, deadlineAt: Date.now()
```

`src/omp/planner-supervisor.ts` hunk 14 (near line 415). Replace:

```ts
      // is the spawn's own incident (or a string result), never this turn's.
      const warm: Promise<StartResult> = this.ensureSession(0).catch((e): StartResult => `spawn_failed: ${message(e)}`);
      const verdict = await this.triage(turn, { claim: turn.claim, text, userText, modality, posture: this.d.posture(), signal: turn.abort.signal });
      if (verdict === ENDED || turn.failure) return;
      if (verdict.kind === "lane_reply") { await this.finishLane(turn, userText, verdict, warm); return; }
      const promptMessage = verdict.kind === "inform" ? `${verdict.note}\n\n${text}` : text;
      if (!(await this.ensureReady(turn, warm))) return;
      store.recordChatTurn({ chat_id: chatId, run_id: turn.req.run_id, role: "user", text: userText });
      const prompt = await this.step(turn, buildTurnPrompt(turnContext, {
        run_id: turn.req.run_id, chat_id: chatId, message: promptMessage, source: turn.req.source, applied: this.applied,
        ...(turn.req.goal !== undefined ? { goal: turn.req.goal } : {})
      }));
```

with:

```ts
      // is the spawn's own incident (or a string result), never this turn's.
      const warm: Promise<StartResult> = this.ensureSession(true).catch((e): StartResult => `spawn_failed: ${message(e)}`);
      const verdict = await this.triage(turn, { claim: turn.claim, text, userText, modality, posture: this.d.posture(), signal: turn.abort.signal });
      if (verdict === ENDED || turn.failure) return;
      if (verdict.kind === "lane_reply") { await this.finishLane(turn, userText, verdict, warm); return; }
      this.routeTurn(turn, verdict.route);
      const promptMessage = verdict.kind === "inform" ? `${verdict.note}\n\n${text}` : text;
      if (!(await this.ensureReady(turn, warm))) return;
      store.recordChatTurn({ chat_id: chatId, run_id: turn.req.run_id, role: "user", text: userText, ...quotedId(verdict.quote) });
      const prompt = await this.step(turn, buildTurnPrompt(turnContext, {
        run_id: turn.req.run_id, chat_id: chatId, message: promptMessage, source: turn.req.source, applied: this.applied,
        ...(turn.req.goal !== undefined ? { goal: turn.req.goal } : {}), ...(verdict.quote ? { quoted: verdict.quote.line } : {})
      }));
```

`src/omp/planner-supervisor.ts` hunk 15 (near line 431). Replace:

```ts
      this.failTurn(turn, "planner_exit", `start_failed: ${message(e)}`);
    }
  }
```

with:

```ts
      this.failTurn(turn, "planner_exit", `start_failed: ${message(e)}`);
    }
  }

  /** The tree's route for this turn (spec §5); an unrouted turn (no triage, a schedule fire, a throw) runs on Default. */
  private routeTurn(turn: Turn, route: TurnRoute | undefined): void {
    turn.route = route ?? null;
    turn.role = route?.role ?? "default";
    turn.effort = route?.effort ?? null;
    turn.routedBy = route?.verdict_id ?? undefined;
  }
```

`src/omp/planner-supervisor.ts` hunk 16 (near line 454). Replace:

```ts
    // guaranteed by the finally. A throw before laneEnded reaches startTurn's catch → failTurn.
    this.d.store.recordChatTurn({ chat_id: this.d.chatId, run_id: turn.req.run_id, role: "user", text: userText });
    if ((await bounded(warm, ABORT_GRACE_MS)) === TIMED_OUT) { await this.stopSession(); await this.settleStart(); } // supersede a start that will not settle (gen bump)
```

with:

```ts
    // guaranteed by the finally. A throw before laneEnded reaches startTurn's catch → failTurn.
    this.d.store.recordChatTurn({ chat_id: this.d.chatId, run_id: turn.req.run_id, role: "user", text: userText, ...quotedId(v.quote) });
    if ((await bounded(warm, ABORT_GRACE_MS)) === TIMED_OUT) { await this.stopSession(); await this.settleStart(); } // supersede a start that will not settle (gen bump)
```

`src/omp/planner-supervisor.ts` hunk 17 (near line 489). Replace:

```ts

  /** A later turn retries the top planner string once after a fallback (spec §8). */
  private async promptTop(turn: Turn, prompt: TurnPrompt): Promise<void> {
```

with:

```ts

  /** Spec §5: before the first prompt the child is pinned to the turn's OWN first candidate, never to the spawn leg. */
  private async promptTop(turn: Turn, prompt: TurnPrompt): Promise<void> {
```

`src/omp/planner-supervisor.ts` hunk 18 (near line 496). Replace:

```ts
    this.armFrameIdle(turn);
    // pinned to the leg the child spawned on (the top string at leg 0): a child on a later string is moved back to the
    // top by respawning at the next turn (ensureSession(0)), never by set_model to a string omp refused at spawn
    const target = this.d.cfg.planner[this.sessionLeg] as ModelString;
    const reset = this.modelUnknown || !sameModel(this.model, target);
    if (reset && (await this.resetTop(turn, s, target)) === ENDED) return;
    if (turn.failure) return;
    try {
```

with:

```ts
    this.armFrameIdle(turn);
    turn.legIndex = 0;
    turn.chain = this.turnChain(turn.role, turn.effort);
    if ((await this.pinFirst(turn, s)) === ENDED || turn.failure) return;
    try {
```

`src/omp/planner-supervisor.ts` hunk 19 (near line 512). Replace:

```ts

  /** The prompt RPC succeeded on the child that made the pending reset: its transcript now holds a turn, so commit it. */
```

with:

```ts

  /**
   * A refused pin already walked on inside pinWalk; no candidate left is no_planner_leg. Any other pin failure is not
   * fatal: incident, answer on the model the child holds, row marked pin_failed, no step-up (spec §5).
   */
  private async pinFirst(turn: Turn, s: PlannerSessionLike): Promise<void | typeof ENDED> {
    const r = await this.pinWalk(turn, s, "model_missing");
    if (r === ENDED) return ENDED;
    if (r === "exhausted") { this.noLeg(turn, "model_missing", turn.legsTried); this.failTurn(turn, "no_planner_leg", "model_missing"); return; }
    if (r === "ok") return;
    turn.pinFailed = true;
    console.error(`planner supervisor: pinning the turn's model failed: ${rpcCode(r.error)}`);
    this.incident("planner_model_reset_failed", { run_id: turn.req.run_id, reason: rpcCode(r.error) });
  }

  /** The turn's current candidate on the child; a pin omp refuses is one model_missing row and the walk moves on (spec §5). */
  private async pinWalk(turn: Turn, s: PlannerSessionLike, kind: LlmErrorKind): Promise<Exclude<PinResult, "refused"> | "exhausted"> {
    for (let why = kind; ; why = "model_missing") {
      const target = this.currentCandidate(turn, why);
      if (!target) return "exhausted";
      turn.legsTried++;
      if (!this.modelUnknown && sameModel(this.model, target)) return "ok";
      const r = await this.pin(turn, s, target);
      if (r !== "refused") return r;
      turn.legIndex++;
    }
  }

  /** chain[legIndex]; a spent chain steps a routed turn up a role (spec §4: Fast → Default → Thinking), ledgered. */
  private currentCandidate(turn: Turn, kind: LlmErrorKind): ModelString | undefined {
    for (;;) {
      const m = turn.chain[turn.legIndex];
      if (m) return m;
      if (!this.stepUp(turn, kind)) return undefined;
    }
  }

  /** Only a routed turn steps up, and never one whose first pin failed (the child's model is unknown). */
  private stepUp(turn: Turn, kind: LlmErrorKind): boolean {
    const to = turn.route && !turn.pinFailed ? STEP_UP[turn.role] : null;
    if (!to) return false;
    this.d.store.appendRunLedgerEvent(turn.req.run_id, "routed_escalation", "core", { from: turn.role, to, kind });
    turn.role = to;
    turn.legIndex = 0;
    turn.chain = this.turnChain(to, turn.effort);
    return true;
  }

  /** set_model then set_thinking_level (planner-session.ts setModel); `model` moves only when both succeeded. */
  private async pin(turn: Turn, s: PlannerSessionLike, target: ModelString): Promise<PinResult> {
    this.modelUnknown = true; // until set_model AND set_thinking_level both succeeded
    try {
      if ((await this.step(turn, s.setModel(target))) === ENDED) return ENDED;
    } catch (e) {
      if (!isModelRefusal(e)) return { error: e };
      this.refused.add(selectorKey(target)); // a model can stay catalogued while refusing: never pinned again on this child
      this.recordPinMissing(turn, target);
      return "refused";
    }
    this.model = target;
    this.modelUnknown = false;
    this.actual = undefined; // the next message_end reports what the pin really produced
    return "ok";
  }

  /** planner_no_leg (spec §4: Thinking spent, or an unrouted Default spent), as today. */
  private noLeg(turn: Turn, kind: LlmErrorKind, tried: number): void {
    this.incident("planner_no_leg", { run_id: turn.req.run_id, error_kind: kind, legs_tried: tried });
    this.d.roles.requestRefresh(); // the catalog may have moved since the last read (plan F7 d; at most once per 10 min)
  }

  /** The prompt RPC succeeded on the child that made the pending reset: its transcript now holds a turn, so commit it. */
```

`src/omp/planner-supervisor.ts` hunk 20 (near line 517). Replace:

```ts
    this.resetGen = 0;
  }

  /** A failed reset is not fatal: log, raise an incident, answer on the current model; the next turn retries it. */
  private async resetTop(turn: Turn, s: PlannerSessionLike, target: ModelString): Promise<void | typeof ENDED> {
    this.modelUnknown = true; // until set_model AND set_thinking_level both succeeded
    try {
      if ((await this.step(turn, s.setModel(target))) === ENDED) return ENDED;
      this.model = target;
      this.modelUnknown = false;
      this.actual = undefined; // the next message_end reports what the pin really produced
    } catch (e) {
      console.error(`planner supervisor: reset to the top planner string failed: ${rpcCode(e)}`);
      this.incident("planner_model_reset_failed", { run_id: turn.req.run_id, reason: rpcCode(e) });
    }
  }
```

with:

```ts
    this.resetGen = 0;
  }
```

`src/omp/planner-supervisor.ts` hunk 21 (near line 546). Replace:

```ts

  /** quota|auth|transport|timeout|model_missing → next planner string over live set_model; else final. */
  private async retryNextLeg(turn: Turn, error: string): Promise<boolean> {
    const kind = classifyOmpError(error);
    const planner = this.d.cfg.planner;
    if (!RETRYABLE_ERROR_KINDS.has(kind)) { turn.failure = { type: "model_error", ref: kind }; return false; }
    if (turn.legIndex + 1 >= planner.length) {
      turn.failure = { type: "no_planner_leg", ref: kind };
      this.incident("planner_no_leg", { run_id: turn.req.run_id, error_kind: kind, legs_tried: turn.legIndex + 1 });
      return false;
    }
    const s = this.session;
    if (!s) { turn.failure = { type: "planner_exit", ref: "planner not running" }; return false; }
    turn.legIndex++;
    const next = planner[turn.legIndex] as ModelString;
    turn.lastError = undefined;
    Object.assign(turn, newDeferred());
    try {
      this.modelUnknown = true;
      if ((await this.step(turn, s.setModel(next))) === ENDED) return true;
      this.model = next;
      this.modelUnknown = false;
      this.actual = undefined;
      if (turn.failure) { turn.done("abort"); return true; }
```

with:

```ts

  /**
   * Spec §4: a retryable kind — or `other` once, on a routed turn, while no tool has run (a failure after a side effect
   * is never re-spent on another model) — walks the turn's chain, then steps a routed turn up; else final.
   */
  private async retryNextLeg(turn: Turn, error: string): Promise<boolean> {
    const kind = classifyOmpError(error);
    if (!this.mayRetry(turn, kind)) { turn.failure = { type: "model_error", ref: kind }; return false; }
    const s = this.session;
    if (!s) { turn.failure = { type: "planner_exit", ref: "planner not running" }; return false; }
    if (kind === "other") turn.retriedOther = true;
    turn.legIndex++;
    turn.lastError = undefined;
    Object.assign(turn, newDeferred());
    return this.promptRetry(turn, s, kind);
  }

  private mayRetry(turn: Turn, kind: LlmErrorKind): boolean {
    if (RETRYABLE_ERROR_KINDS.has(kind)) return true;
    return kind === "other" && turn.route !== null && !turn.usedTool && !turn.retriedOther;
  }

  /** Pin the next candidate and tell it to continue (RETRY_NOTE); the transcript already holds every executed tool's result. */
  private async promptRetry(turn: Turn, s: PlannerSessionLike, kind: LlmErrorKind): Promise<boolean> {
    try {
      const r = await this.pinWalk(turn, s, kind);
      if (r === ENDED) return true;
      if (r === "exhausted") {
        turn.failure = { type: "no_planner_leg", ref: kind };
        this.noLeg(turn, kind, turn.legsTried);
        return false;
      }
      if (r !== "ok") throw r.error;
      if (turn.failure) { turn.done("abort"); return true; }
```

`src/omp/planner-supervisor.ts` hunk 22 (near line 579). Replace:

```ts

  /** null when a live, current child is ready; else the failure ref for the run. */
  /** `leg` = the planner string a spawn uses. At leg 0 a child running on a start-time fallback is replaced (the top string's one retry per turn). */
  private async ensureSession(leg: number): Promise<StartResult> {
    const { turnContext, chatId } = this.d;
    // never two spawns: join the start in flight; if it did not produce a ready child, this turn makes its own attempt
    while (this.startInFlight) if ((await this.startInFlight) === null && this.session) return null;
    // compared only at turn start: a new lesson, identity edit, skill change or UTC day restarts the child here
    const refresh = this.stale || systemPromptFingerprint(turnContext, chatId) !== this.fingerprint || (leg === 0 && this.sessionLeg > 0);
    if (this.session && refresh) await this.stopSession();
```

with:

```ts

  /**
   * null when a live, current child is ready; else the failure ref for the run. `fresh` = a new spawn sequence: the last
   * child's refused set is no evidence for this one (spec §4 step 4), so it clears; false after a start refusal.
   */
  private async ensureSession(fresh: boolean): Promise<StartResult> {
    const { turnContext, chatId } = this.d;
    // never two spawns: join the start in flight; if it did not produce a ready child, this turn makes its own attempt
    while (this.startInFlight) if ((await this.startInFlight) === null && this.session) return null;
    // compared only at turn start: a new lesson, identity edit, skill change or UTC day restarts the child here.
    // A child on a later Default candidate is kept (spec §5): set_model moves it to any turn's candidate.
    const refresh = this.stale || systemPromptFingerprint(turnContext, chatId) !== this.fingerprint;
    if (this.session && refresh) await this.stopSession();
```

`src/omp/planner-supervisor.ts` hunk 23 (near line 592). Replace:

```ts
    if (pre) return pre;
    const p: Promise<StartResult> = this.spawn(leg).finally(() => { if (this.startInFlight === p) this.startInFlight = undefined; });
    this.startInFlight = p;
```

with:

```ts
    if (pre) return pre;
    if (fresh) this.refused.clear();
    const head = this.spawnChain()[0];
    if (!head) return NO_SPAWN_MODEL;
    const p: Promise<StartResult> = this.spawn(head).finally(() => { if (this.startInFlight === p) this.startInFlight = undefined; });
    this.startInFlight = p;
```

`src/omp/planner-supervisor.ts` hunk 24 (near line 598). Replace:

```ts
  /**
   * The turn's child: omp rejects an unknown --model at process start (live, 18.4.4), so live set_model can never
   * rescue a bad planner[0]. Each rejected string gets one error{model_missing} row and the next string is spawned;
   * all rejected → no_planner_leg + incident. Not a crash-latch count.
   */
  private async startSession(turn: Turn, warm?: Promise<StartResult>): Promise<string | null | typeof ENDED> {
    const planner = this.d.cfg.planner;
    for (let leg = 0; ; leg++, warm = undefined) {
      const r = await this.step(turn, warm ? this.afterWarm(warm) : this.ensureSession(leg));
      if (r === ENDED || r === null || typeof r === "string") {
        if (r === null) turn.legIndex = this.sessionLeg;
        return r;
      }
      this.recordStartMissing(turn, r.missingLeg);
      leg = r.missingLeg;
      if (leg + 1 >= planner.length) {
        this.incident("planner_no_leg", { run_id: turn.req.run_id, error_kind: "model_missing", legs_tried: planner.length });
        this.failTurn(turn, "no_planner_leg", "model_missing");
        return ENDED;
      }
    }
```

with:

```ts
  /**
   * The turn's child on the spawn axis (spec §5): omp rejects an unknown --model at process start (live, 18.4.4), so
   * live set_model can never rescue it. Each rejected selector gets one error{model_missing} row, joins the child's
   * refused set, and Default's next candidate is spawned; none left → no_planner_leg + incident. Not a crash-latch count.
   */
  private async startSession(turn: Turn, warm?: Promise<StartResult>): Promise<string | null | typeof ENDED> {
    for (let fresh = true; ; fresh = false, warm = undefined) {
      const r = await this.step(turn, warm ? this.afterWarm(warm) : this.ensureSession(fresh));
      if (r === NO_SPAWN_MODEL) {
        this.noLeg(turn, "model_missing", turn.startMissing);
        this.failTurn(turn, "no_planner_leg", "model_missing");
        return ENDED;
      }
      if (r === ENDED || r === null || typeof r === "string") return r;
      this.recordStartMissing(turn, r.missing);
    }
```

`src/omp/planner-supervisor.ts` hunk 25 (near line 621). Replace:

```ts
  /**
   * Leg 0 after slot B's warm start: its failure (a start_failed ref, or omp refusing planner[0]) IS this turn's leg-0
   * result, never a second spawn (one start, one incident, one crash count, as before the lane). The warm call was this
   * turn's start-time fingerprint compare; a ready child is replaced only if it exited or went stale while the lane ran.
   */
```

with:

```ts
  /**
   * The first spawn after slot B's warm start: its failure (a start_failed ref, or omp refusing Default's head) IS this
   * turn's result, never a second spawn (one start, one incident, one crash count, as before the lane). The warm call
   * was this turn's start-time fingerprint compare; a ready child is replaced only if it exited or went stale meanwhile.
   */
```

`src/omp/planner-supervisor.ts` hunk 26 (near line 628). Replace:

```ts
    if (r !== null) return r;
    return this.session && !this.stale ? null : this.ensureSession(0);
  }

  /** One llm_attempt per string omp refused at spawn, keyed `<run>:0:<leg>` (never `<run>:0`, the n = 0 dispatch row's key). */
  private recordStartMissing(turn: Turn, leg: number): void {
    const m = this.d.cfg.planner[leg] as ModelString;
    const run = turn.req.run_id;
    this.d.store.llmAuditSink({ run_id: run, role: "compose" }).record({
      provider: m.provider, role: "", outcome: "error", model: m.model, family: familyOf(m),
      request_key: `${run}:0:${leg}`, error_kind: "model_missing"
    });
```

with:

```ts
    if (r !== null) return r;
    return this.session && !this.stale ? null : this.ensureSession(true);
  }

  /** One llm_attempt per selector omp refused at spawn, keyed `<run>:0:<k>` (never `<run>:0`, the n = 0 dispatch row's key). */
  private recordStartMissing(turn: Turn, m: ModelString): void {
    this.refused.add(selectorKey(m));
    this.audit(turn, {
      provider: m.provider, role: "", outcome: "error", model: m.model, family: familyOf(m),
      request_key: `${turn.req.run_id}:0:${turn.startMissing++}`, error_kind: "model_missing"
    }, m);
  }

  /** One llm_attempt per pin omp refused, keyed `<run>:pin:<k>` (distinct from `<run>:<n>` and `<run>:0:<k>`). */
  private recordPinMissing(turn: Turn, m: ModelString): void {
    this.audit(turn, {
      provider: m.provider, role: "", outcome: "error", model: m.model, family: familyOf(m),
      request_key: `${turn.req.run_id}:pin:${turn.legsTried}`, error_kind: "model_missing"
    }, m);
  }

  /**
   * Every compose llm_attempt goes through here. Each carries the effort of the selector it was made on (`m`: the spawn
   * or pin candidate, default the model the child was pinned to; plan F15), and the first one of a routed turn carries
   * routed_by = its verdict id (spec §6).
   */
  private audit(t: Turn, a: LlmAttempt, m: ModelString = this.model): void {
    const routedBy = t.routedBy;
    t.routedBy = undefined;
    this.d.store.llmAuditSink({ run_id: t.req.run_id, role: "compose" }).record({
      ...a, ...(m.effort ? { effort: m.effort } : {}), ...(routedBy ? { routed_by: routedBy } : {})
    });
```

`src/omp/planner-supervisor.ts` hunk 27 (near line 692). Replace:

```ts

  private async spawn(leg: number): Promise<StartResult> {
    const { ctx, chatId, distDir, cfg } = this.d;
```

with:

```ts

  private async spawn(model: ModelString): Promise<StartResult> {
    const { ctx, chatId, distDir, cfg } = this.d;
```

`src/omp/planner-supervisor.ts` hunk 28 (near line 700). Replace:

```ts
    const gen = this.bumpGen();
    const rec: SpawnRec = { gen, leg };
    this.spawning = rec;
    const superseded = new Promise<void>((r) => { this.supersede = r; });
    this.model = this.d.cfg.planner[leg] as ModelString; // top string, or the next one after a start-time rejection
    // omp's open_session restores the model a resumed session last used, over --model (live gate 2026-10-01): the
```

with:

```ts
    const gen = this.bumpGen();
    const rec: SpawnRec = { gen, model };
    this.spawning = rec;
    const superseded = new Promise<void>((r) => { this.supersede = r; });
    this.model = model; // Default's head, or its next candidate after a start-time rejection
    // omp's open_session restores the model a resumed session last used, over --model (live gate 2026-10-01): the
```

`src/omp/planner-supervisor.ts` hunk 29 (near line 731). Replace:

```ts
    if (refused) return refused;
    this.sessionLeg = leg;
    if (!this.turn?.live) this.st = "IDLE";
```

with:

```ts
    if (refused) return refused;
    if (!this.turn?.live) this.st = "IDLE";
```

`src/omp/planner-supervisor.ts` hunk 30 (near line 816). Replace:

```ts
   * A child that exited during start (its start() rejection carries the classified code; omp refusing the model is
   * model_missing → next string, no crash count, no incident), one we stopped (superseded), or any other failure.
   */
```

with:

```ts
   * A child that exited during start (its start() rejection carries the classified code; omp refusing the model is
   * model_missing → Default's next candidate, no crash count, no incident), one we stopped (superseded), or any other failure.
   */
```

`src/omp/planner-supervisor.ts` hunk 31 (near line 825). Replace:

```ts
    const code = err instanceof PlannerRpcError ? err.code : undefined;
    if (code === START_MODEL_MISSING) return { missingLeg: rec.leg };
    this.exits.push(Date.now()); // any other failed start (exit, timeout, no manifest, spawn error) is a crash exit
```

with:

```ts
    const code = err instanceof PlannerRpcError ? err.code : undefined;
    if (code === START_MODEL_MISSING) return { missing: rec.model };
    this.exits.push(Date.now()); // any other failed start (exit, timeout, no manifest, spawn error) is a crash exit
```

`src/omp/planner-supervisor.ts` hunk 32 (near line 922). Replace:

```ts
    if (t.n > 0 && t.recorded === t.n) return;
    const model = this.model.model;
    this.d.store.llmAuditSink({ run_id: t.req.run_id, role: "compose" }).record({
      provider: this.model.provider, role: "", outcome: "error", model, family: familyOf({ model }),
      request_key: `${t.req.run_id}:${t.n}`, error_kind: classifyOmpError(text)
```

with:

```ts
    if (t.n > 0 && t.recorded === t.n) return;
    const model = this.model.model;
    this.audit(t, {
      provider: this.model.provider, role: "", outcome: "error", model, family: familyOf({ model }),
      request_key: `${t.req.run_id}:${t.n}`, error_kind: classifyOmpError(text)
```

`src/omp/planner-supervisor.ts` hunk 33 (near line 959). Replace:

```ts
    };
    this.d.store.llmAuditSink({ run_id: t.req.run_id, role: "compose" }).record(attempt);
    t.recorded = t.n;
```

with:

```ts
    };
    this.audit(t, attempt);
    t.recorded = t.n;
```

`src/omp/planner-supervisor.ts` hunk 34 (near line 1028). Replace:

```ts
    store.recordChatTurn({ chat_id: chatId, run_id: t.req.run_id, role: "assistant", text, intent: assistantIntentFor(text, t.usedTool) });
  }
```

with:

```ts
    store.recordChatTurn({ chat_id: chatId, run_id: t.req.run_id, role: "assistant", text, intent: assistantIntentFor(text, t.usedTool) });
    this.routeEnd(t, "planner_done");
  }
```

`src/omp/planner-supervisor.ts` hunk 35 (near line 1039). Replace:

```ts
    for (const m of t.merged) outcome.fail({ ...base, run_id: m, error_type: "merged_parent_failed" });
  }
```

with:

```ts
    for (const m of t.merged) outcome.fail({ ...base, run_id: m, error_type: "merged_parent_failed" });
    this.routeEnd(t, "planner_failed");
  }

  /** The verdict row's handler outcome (spec §6) for a turn the tree routed with a verdict id; a lane turn has no route. */
  private routeEnd(t: Turn, handler_outcome: "planner_done" | "planner_failed"): void {
    const verdict_id = t.route?.verdict_id;
    if (!verdict_id || !this.d.outcome.routeEnd) return;
    const model = this.actual ? `${this.actual.provider}/${this.actual.model}` : t.dispatched ? selectorKey(this.model) : null;
    this.d.outcome.routeEnd({
      run_id: t.req.run_id, verdict_id, handler_outcome, model, fast_used_tool: t.role === "fast" && t.usedTool, pin_failed: t.pinFailed
    });
  }
```

`src/omp/planner-supervisor.ts` hunk 36 (near line 1046). Replace:

```ts
  private recordAborted(t: Turn, kind: "aborted" | "shutdown"): void {
    const model = this.model.model;
    this.d.store.llmAuditSink({ run_id: t.req.run_id, role: "compose" }).record({
      provider: this.model.provider, role: "", outcome: "error", model, family: familyOf({ model }),
      request_key: `${t.req.run_id}:${t.n}`, error_kind: kind
```

with:

```ts
  private recordAborted(t: Turn, kind: "aborted" | "shutdown"): void {
    const model = this.model.model;
    this.audit(t, {
      provider: this.model.provider, role: "", outcome: "error", model, family: familyOf({ model }),
      request_key: `${t.req.run_id}:${t.n}`, error_kind: kind
```

After this step, `grep -nE "cfg\.planner|sessionLeg|missingLeg|resetTop|this\.top\(\)" src/omp/planner-supervisor.ts`
prints nothing.

- [ ] **Step 6: Pass the resolver at the one construction site**

`src/core/core-worker.ts` hunk 1 (near line 2191). Replace:

```ts
      resolveMessage: (claim) => this.resolveOmpMessage(claim),
      triage: (i) => this.triageTurn(i)
    };
```

with:

```ts
      resolveMessage: (claim) => this.resolveOmpMessage(claim),
      triage: (i) => this.triageTurn(i),
      roles: this.roles
    };
```

`routeEnd` is not wired into `ompOutcomeSink` here. The sink writes `jev_verdicts`, which Task 9 creates and Task 10
connects (with F12's terminal-owner rule). Until then `triageTurn` returns no `route`, so no turn has a verdict id and
`routeEnd` is never called.

- [ ] **Step 7: Run the tests, the typecheck and the full suite**

```bash
npx vitest run tests/omp/planner-supervisor.test.ts tests/omp/planner-session.test.ts tests/run/llm-audit-sink.test.ts tests/run/run-ledger.test.ts tests/llm/audit-coverage.test.ts
npm run typecheck && npm test
```

Expected: PASS. On the verification copy: 172/172 for the five files, and 3515/3515 for the full suite (257 files);
typecheck is clean. `tests/llm/audit-coverage.test.ts:84-88` still holds, because the supervisor builds its sink with
`llmAuditSink(` (now once, inside `audit`).

- [ ] **Step 8: Commit**

```bash
git add src/omp/planner-supervisor.ts src/omp/planner-session.ts src/llm/audit.ts src/run/run-store.ts \
  src/core/core-worker.ts tests/omp/planner-supervisor.test.ts tests/omp/planner-session.test.ts tests/run/llm-audit-sink.test.ts
git commit -m "$(cat <<'EOF'
feat(omp): two-axis planner chain — spawn on Default, pin each turn to its routed role

Spec §5: the child spawns on the Default role's candidates; each turn pins its
own routed candidates with set_model + set_thinking_level. A pin omp refuses
(Model not found, classified from PlannerRpcError.detail) is model_missing and
walks on; a transport failure answers on the held model (pin_failed). A spent or
empty role steps a routed turn up (routed_escalation); 'other' retries once
while no tool ran; no_planner_leg asks the resolver for a fresh catalog. The
respawn rule and sessionLeg are gone; refused selectors are skipped for the
child's life. Every compose row records its selector's effort; the first
carries routed_by.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

---

### Task 9: Store — `jev_verdicts` and the stage A ledger event types

**Assembly overrides (Rev 2; binding — folded into the text below, kept here as the summary):**
- **Order:** Task 9 lands after Task 5 and **before Task 6**. It is the single owner of every new stage A ledger type,
  so it lands before any writer (Tasks 7, 8, 10, 11). Final order: 1 → 2 → 3 → 4 → 5 → 9 → 6 → 7 → 8 → 10 → 11 → 12 → 13 → 14.
- **Six event types, all here:** `routed_escalation` `["from","to","kind"]` (writer: Task 8), `model_roles_resolved`
  `["resolved_at","catalog_ok","roles"]` (writer: Task 11's tick; `resolved_at` because `occurred_at` is the real clock),
  `model_catalog_unavailable` `["reason"]` (writer: Task 7), `model_role_override` `["key","pattern","actor"]` (writer:
  Task 7), `quote_unresolved` `["reason"]` (writer: Task 10), `model_roles_fallback` `["role"]` (writer: Task 7, review
  fix F7: one note per role per catalog read when a resolved role falls back to its static list). No other task adds a
  `LedgerEventType` member.
- **Incidents need no entry here.** `RunStore.openIncident` takes `kind: string` (`src/run/run-store.ts:4577-4582`) and
  `openAlertedIncident` passes it through (`src/run/incident-alert.ts:28`), so the `model_catalog_unavailable` incident
  (review fix F14, owned by Stream A's Task 7) and `role_unresolved` (Task 11) are written by their owners with no
  Task 9 change. The incident and the ledger note share a name but not a namespace.
- Migration count in `tests/run/run-store-approvals.test.ts`: Task 4 takes it 29 → 30; this task 30 → 31.

**Contract deviations:**
1. **The `triage` required-field change moves to Task 10.** This task adds the six new event types and the table.
   Changing `triage`'s required fields here would make every triage write from today's
   `core-worker.ts:2514-2521` fail validation until Task 10 rewrites the writer, so this commit would go red. Task 10
   changes the list together with its only writer.
2. **Task 9 depends on Tasks 3 and 5** for type-only imports (`Category`, `Lane`, `TurnRole`, `Effort`, `RouteReason`),
   which the binding order satisfies.
3. **`latestJevVerdictForChat` compares `created_at <= beforeIso`, not `<`.** Two turns stamped in the same
   millisecond (tests, and back-to-back Telegram updates) would otherwise miss each other. Callers exclude their own
   run.
4. **`cascade` is `"tiny" | null`, as the contract says** (Rev 4, plan Decision 14: the cascade call is live, so Rev 2's
   `"deferred"` value is gone from the type and the CHECK; Rev 5 names the value after the role, `tiny`). `tiny` marks a turn whose cascade call was made, whatever
   its outcome (`reason` says `cascade` or `cascade_failed`); the two candidates ride on the `triage` event (Task 10).
5. **`closePendingJevVerdict(run_id, handler_outcome): number`** is added (review fix F12): the run's terminal paths
   (Task 10: `ompComplete`, `ompFail`, `recoverPlannerLeases`) close a verdict still `pending`, guarded
   `WHERE handler_outcome = 'pending'`, so no terminal path leaves a verdict open and none overwrites another's outcome.

**Files:**
- Modify: `src/run/run-store.ts`:
  - Types next to `JevDecisionRow` (`:907-916`).
  - Helpers after `listJevDecisions` (`:4282-4284`).
  - New migration after `applyJevDecisionInstantsMigration` (`:6768-6777`).
  - Its call at the end of `migrate()` (`:6692`).
- Modify: `src/run/run-ledger.ts`: `LedgerEventType` (`:11-16`) and `requiredPayloadFields` (`:296-307`).
- Modify: `tests/run/run-store-approvals.test.ts:584-591`, the migration count (30 → 31).
- Test: `tests/run/jev-verdicts-store.test.ts` (new) and `tests/run/run-ledger.test.ts` (one case added after `:201-208`).

**Interfaces:**
- Consumes: `type SkipReason` (`src/jev/decide.ts:14`); `type Category` (Task 3); `type Lane`, `type TurnRole`,
  `type Effort`, `type RouteReason` (Task 5).
- Produces (contract "Ledger (Task 9)"):
  ```ts
  export interface JevVerdictInsert { … exactly as the contract … }
  export type VerdictCorrection = "ask_anyway" | "think_harder" | "escalation" | "low_rating";
  export interface JevVerdictRow { verdict_id: string; run_id: string; category: Category | null; breadth: number | null; reasoning: number | null;
    actions: number | null; sets_rule: number | null; rule_scope: "ask" | "research" | null; lane: Lane; role: TurnRole; effort: Effort | null;
    model: string | null; cascade: "tiny" | null; save_outcome: JevVerdictInsert["save_outcome"]; route_outcome: "act" | "fallback" | "pin_failed";
    handler_outcome: string; reason: RouteReason; skip_reason: string | null; fast_used_tool: number; paco_correction: VerdictCorrection | null;
    quoted_turn_id: string | null; created_at: string; updated_at: string }
  insertJevVerdict(i: JevVerdictInsert): string;   // "jv_<uuid>", handler_outcome 'pending'
  closePendingJevVerdict(run_id: string, handler_outcome: "planner_done" | "planner_failed"): number; // rows moved (0 or 1)
  updateJevVerdict(verdict_id: string, p: Partial<{ handler_outcome: string; model: string | null; route_outcome: "pin_failed";
    fast_used_tool: boolean; paco_correction: VerdictCorrection }>): void;
  getJevVerdictForRun(run_id: string): JevVerdictRow | undefined;          // latest for the run
  latestJevVerdictForChat(chat_id: string, beforeIso: string): JevVerdictRow | undefined; // joins runs.notify_json.chat_id
  // ledger types: routed_escalation {from,to,kind}, model_roles_resolved {resolved_at,catalog_ok,roles},
  // model_catalog_unavailable {reason}, model_role_override {key,pattern,actor}, quote_unresolved {reason}, model_roles_fallback {role}
  ```
  **Corrections are a column update only, with no ledger event.** The verdict row is the record of the turn.
  "Ask Houge anyway" already writes `triage_override`, and an extra event per correction would duplicate the column
  with nothing that reads it.

- [ ] **Step 1: Write the failing tests**

`tests/run/jev-verdicts-store.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore, type JevVerdictInsert } from "../../src/run/run-store.js";

// Spec §6: one per-turn verdict row joins Jev's routing to the model that answered and to Paco's corrections. Without
// it the stage A PASS criterion (every routed turn's first planner attempt, keyed by routed_by, joins a verdict) cannot be checked, and the
// correction labels (ask anyway, think harder, escalation, low rating) have nowhere to land.
const V: Omit<JevVerdictInsert, "run_id"> = { category: "lookup", breadth: 1, reasoning: 0.9, actions: 1, sets_rule: 0.05, rule_scope: null,
  lane: "planner", role: "fast", effort: "low", cascade: null, save_outcome: "none", route_outcome: "act", reason: "routed", skip_reason: null,
  quoted_turn_id: null };
let seq = 0;
/** A real run notifying `chat`: the chat lookup joins on runs.notify_json, so a bare run id would prove nothing. */
function runIn(store: RunStore, chat: string): string {
  seq += 1;
  const r = new Gateway(store).intake(buildTypedTaskEvent({ source: "telegram", type: "turn", program: "turn", goal: `m${seq}`,
    requested_by: { kind: "user", id: "paco" }, notify: { kind: "telegram", chat_id: chat }, idempotency_key: `jv:${seq}`,
    source_reference: `telegram:update:${seq}:message:${seq}` }));
  if (!r.ok) throw new Error("intake failed");
  return r.run_id;
}

describe("jev_verdicts", () => {
  it("inserts one row per decision point call with handler_outcome pending and no correction", () => {
    const store = RunStore.openInMemory();
    const run_id = runIn(store, "555");
    const id = store.insertJevVerdict({ ...V, run_id, created_at: "2026-10-07T10:00:00.000Z" });
    expect(id).toMatch(/^jv_/);
    expect(store.getJevVerdictForRun(run_id)).toMatchObject({ verdict_id: id, category: "lookup", lane: "planner", role: "fast", effort: "low",
      handler_outcome: "pending", fast_used_tool: 0, paco_correction: null, model: null, created_at: "2026-10-07T10:00:00.000Z",
      updated_at: "2026-10-07T10:00:00.000Z" });
    store.close();
  });
  it("updates only the given fields; a boolean lands as 0/1; updated_at moves", () => {
    const store = RunStore.openInMemory();
    const run_id = runIn(store, "555");
    const id = store.insertJevVerdict({ ...V, run_id, created_at: "2026-01-01T00:00:00.000Z" }); // before any real clock the suite runs on
    store.updateJevVerdict(id, { handler_outcome: "planner_done", model: "anthropic/claude-sonnet-5-5", fast_used_tool: true });
    store.updateJevVerdict(id, { route_outcome: "pin_failed" });
    store.updateJevVerdict(id, {}); // nothing to set: a no-op, not an SQL error
    const row = store.getJevVerdictForRun(run_id)!;
    expect(row).toMatchObject({ handler_outcome: "planner_done", model: "anthropic/claude-sonnet-5-5", fast_used_tool: 1, route_outcome: "pin_failed",
      category: "lookup", paco_correction: null });
    expect(row.updated_at > row.created_at).toBe(true);
    store.close();
  });
  it("the CHECKs reject values outside the enums; a fallthrough reason is accepted", () => {
    const store = RunStore.openInMemory();
    const run_id = runIn(store, "555");
    expect(() => store.insertJevVerdict({ ...V, run_id, save_outcome: "maybe" as never })).toThrow();
    expect(() => store.insertJevVerdict({ ...V, run_id, lane: "answer" as never })).toThrow();
    const id = store.insertJevVerdict({ ...V, run_id });
    expect(() => store.updateJevVerdict(id, { handler_outcome: "done" })).toThrow();
    expect(() => store.updateJevVerdict(id, { paco_correction: "nope" as never })).toThrow();
    store.updateJevVerdict(id, { handler_outcome: "fallthrough:not_durable" });
    expect(store.getJevVerdictForRun(run_id)?.handler_outcome).toBe("fallthrough:not_durable");
    // Decision 14 (Rev 4): `tiny` marks a turn whose cascade call ran; Rev 2's `deferred` (no call) is retired, so a writer
    // that still sends it, or anything else, is a bug the CHECK must catch
    expect(() => store.insertJevVerdict({ ...V, run_id, cascade: "maybe" as never })).toThrow();
    expect(() => store.insertJevVerdict({ ...V, run_id, cascade: "deferred" as never })).toThrow();
    store.insertJevVerdict({ ...V, run_id, category: null, cascade: "tiny", reason: "cascade_failed", route_outcome: "fallback" });
    expect(store.getJevVerdictForRun(run_id)?.cascade).toBe("tiny");
    store.close();
  });
  // F12: a verdict that stays 'pending' skews the §7/§9 evidence and the lane_fallthrough_rate sweep forever, so every
  // terminal path closes it; the guard keeps a second terminal (or a lane's own outcome) from rewriting the first.
  it("closePendingJevVerdict moves only a pending row, once", () => {
    const store = RunStore.openInMemory();
    const run_id = runIn(store, "555");
    store.insertJevVerdict({ ...V, run_id });
    expect(store.closePendingJevVerdict(run_id, "planner_failed")).toBe(1);
    expect(store.closePendingJevVerdict(run_id, "planner_done")).toBe(0);
    expect(store.getJevVerdictForRun(run_id)?.handler_outcome).toBe("planner_failed");
    const lane = runIn(store, "555");
    const lid = store.insertJevVerdict({ ...V, run_id: lane, lane: "memory" });
    store.updateJevVerdict(lid, { handler_outcome: "fallthrough:not_durable" });
    expect(store.closePendingJevVerdict(lane, "planner_done")).toBe(0);
    expect(store.getJevVerdictForRun(lane)?.handler_outcome).toBe("fallthrough:not_durable");
    expect(store.closePendingJevVerdict("run_without_verdict", "planner_done")).toBe(0);
    store.close();
  });
  it("latestJevVerdictForChat: this chat only, at or before the instant, newest first", () => {
    const store = RunStore.openInMemory();
    const a = runIn(store, "555"); const b = runIn(store, "555"); const other = runIn(store, "777");
    store.insertJevVerdict({ ...V, run_id: a, created_at: "2026-10-07T10:00:00.000Z" });
    const second = store.insertJevVerdict({ ...V, run_id: b, created_at: "2026-10-07T10:05:00.000Z" });
    store.insertJevVerdict({ ...V, run_id: other, created_at: "2026-10-07T10:06:00.000Z" });
    expect(store.latestJevVerdictForChat("555", "2026-10-07T10:10:00.000Z")?.verdict_id).toBe(second);
    expect(store.latestJevVerdictForChat("555", "2026-10-07T10:05:00.000Z")?.verdict_id).toBe(second); // same instant counts
    expect(store.latestJevVerdictForChat("555", "2026-10-07T10:04:59.999Z")?.run_id).toBe(a);
    expect(store.latestJevVerdictForChat("888", "2026-10-07T11:00:00.000Z")).toBeUndefined();
    store.close();
  });
  it("the migration is idempotent across reopen (one schema_migrations row)", () => {
    const path = join(mkdtempSync(join(tmpdir(), "hjv-")), "h.sqlite");
    RunStore.open(path).close();
    const store = RunStore.open(path);
    const db = (store as unknown as { db: { prepare(s: string): { get<T>(...v: unknown[]): T | undefined } } }).db;
    expect(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = ?").get<{ n: number }>("2026-10-07-jev-verdicts")?.n).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'jev_verdicts_run_idx'").get<{ n: number }>()?.n).toBe(1);
    store.close();
  });
});
```

Append to `tests/run/run-ledger.test.ts`, inside its last `describe` block after the ADR 0029 case (`:201-208`):

```ts
  // Stage A ledger types (spec §4–§6): ids, enums and numbers only. A missing field must fail the write, or a later
  // reader (the change notice, the sweep) silently miscounts.
  it("stage A events require their fields", () => {
    type StageA = "routed_escalation" | "model_roles_resolved" | "model_catalog_unavailable" | "model_role_override" | "quote_unresolved"
      | "model_roles_fallback";
    const ev = (event_type: StageA, payload: Record<string, unknown>) =>
      validateLedgerEvent(createLedgerEvent({ correlation_id: "r", event_type, actor: "core", sequence: 1, payload }));
    expect(ev("routed_escalation", { from: "fast", to: "default", kind: "quota" }).ok).toBe(true);
    expect(ev("routed_escalation", { from: "fast", to: "default" }).ok).toBe(false);
    expect(ev("model_roles_resolved", { resolved_at: "2026-10-07T00:00:00.000Z", catalog_ok: true, roles: [] }).ok).toBe(true);
    // the tick's 24 h latch reads resolved_at, and an outage row must say so, or it becomes the diff baseline
    expect(ev("model_roles_resolved", { roles: [] }).ok).toBe(false);
    expect(ev("model_catalog_unavailable", { reason: "read_failed" }).ok).toBe(true);
    expect(ev("model_catalog_unavailable", {}).ok).toBe(false);
    expect(ev("model_role_override", { key: "thinking", pattern: "opus", actor: "paco" }).ok).toBe(true);
    expect(ev("model_role_override", { key: "thinking", pattern: "opus" }).ok).toBe(false);
    expect(ev("quote_unresolved", { reason: "no_mapping" }).ok).toBe(true);
    expect(ev("quote_unresolved", {}).ok).toBe(false);
    expect(ev("model_roles_fallback", { role: "default" }).ok).toBe(true);
    expect(ev("model_roles_fallback", {}).ok).toBe(false);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/run/jev-verdicts-store.test.ts tests/run/run-ledger.test.ts`
Expected: FAIL. `store.insertJevVerdict is not a function` / `store.closePendingJevVerdict is not a function`; the
ledger case fails because `validateLedgerEvent` finds no required-field entry for the six types (vitest does not
typecheck, so the union error shows only under `npm run typecheck`).

- [ ] **Step 3: Implement**

`src/run/run-ledger.ts`: add the six types after `| "triage_override"` (`:16`):

```ts
  | "triage_override"
  | "routed_escalation"
  | "model_roles_resolved"
  | "model_catalog_unavailable"
  | "model_role_override"
  | "quote_unresolved"
  | "model_roles_fallback"
```

and in `requiredPayloadFields`, after `triage_override: ["run_id", "new_run_id", "change_id"]` (`:306`; add a comma to
that line):

```ts
  triage_override: ["run_id", "new_run_id", "change_id"],
  // Jev decision tree, stage A (spec §4–§6). Ids, enums and numbers only — never message text, never omp's error text.
  // A routed turn stepped up a role at the retry boundary (written by the supervisor, Task 8).
  routed_escalation: ["from", "to", "kind"],
  // The daily tick's resolution of every role key (heads and candidate selectors), diffed for the change notice (Task 11).
  // `resolved_at` is the tick's instant (the 24 h latch; occurred_at is the real clock); `catalog_ok` false marks an outage,
  // which is never a diff baseline.
  model_roles_resolved: ["resolved_at", "catalog_ok", "roles"],
  // `omp --profile houge models --json` failed or returned no parseable list (a fixed reason code; Task 7).
  model_catalog_unavailable: ["reason"],
  // Paco's /models set or reset: an append-only override row ("" pattern = reset; Task 7 writes, Task 11 validates).
  model_role_override: ["key", "pattern", "actor"],
  // A Telegram reply whose quoted message did not resolve to one stored turn (QuoteResolution reason; Task 10).
  quote_unresolved: ["reason"],
  // Resolved mode: a role that resolved empty ran on its static list instead (review fix F7; once per role per catalog read).
  model_roles_fallback: ["role"]
```

`src/run/run-store.ts`, imports (with the other `import type` lines at the top):

```ts
import type { SkipReason } from "../jev/decide.js";
import type { Category } from "../jev/questions/tree.js";
import type { Effort, Lane, RouteReason, TurnRole } from "../jev/tree-policy.js";
```

Types, after `JevDecisionRow` (`:916`):

```ts
/** One decision point call (spec §6): what the tree routed, what saved, what the handler did, and Paco's correction. Never text. */
export interface JevVerdictInsert { run_id: string; category: Category | null; breadth: number | null; reasoning: number | null;
  actions: number | null; sets_rule: number | null; rule_scope: "ask" | "research" | null; lane: Lane; role: TurnRole;
  effort: Effort | null; cascade: VerdictCascade; save_outcome: "saved" | "not_durable" | "capped" | "none";
  route_outcome: "act" | "fallback"; reason: RouteReason; skip_reason: SkipReason | null; quoted_turn_id: string | null; created_at?: string }
/** "tiny": the cascade call ran (plan Decision 14; Tiny role), whatever it returned — `reason` says cascade / cascade_failed. */
export type VerdictCascade = "tiny" | null;
export type VerdictCorrection = "ask_anyway" | "think_harder" | "escalation" | "low_rating";
export interface JevVerdictRow {
  verdict_id: string; run_id: string; category: Category | null; breadth: number | null; reasoning: number | null; actions: number | null;
  sets_rule: number | null; rule_scope: "ask" | "research" | null; lane: Lane; role: TurnRole; effort: Effort | null; model: string | null;
  cascade: VerdictCascade; save_outcome: JevVerdictInsert["save_outcome"]; route_outcome: "act" | "fallback" | "pin_failed";
  /** 'pending' | 'lane_reply' | 'fallthrough:<reason>' | 'planner_done' | 'planner_failed' */
  handler_outcome: string; reason: RouteReason; skip_reason: string | null; fast_used_tool: number; paco_correction: VerdictCorrection | null;
  quoted_turn_id: string | null; created_at: string; updated_at: string;
}
type JevVerdictPatch = Partial<{ handler_outcome: string; model: string | null; route_outcome: "pin_failed"; fast_used_tool: boolean; paco_correction: VerdictCorrection }>;
/** The only columns an update may set: a fixed list, so the SET clause never takes a name from input. */
const VERDICT_PATCH_COLUMNS = ["handler_outcome", "model", "route_outcome", "fast_used_tool", "paco_correction"] as const;
```

Helpers, after `listJevDecisions` (`:4280`):

```ts
  // ── Jev verdicts: one row per decision point call (spec §6) ──────────────

  insertJevVerdict(i: JevVerdictInsert): string {
    const verdict_id = `jv_${randomUUID()}`;
    const at = i.created_at ?? new Date().toISOString();
    this.db.prepare(`
      INSERT INTO jev_verdicts (verdict_id, run_id, category, breadth, reasoning, actions, sets_rule, rule_scope, lane, role, effort, cascade,
        save_outcome, route_outcome, handler_outcome, reason, skip_reason, quoted_turn_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
    `).run(verdict_id, i.run_id, i.category, i.breadth, i.reasoning, i.actions, i.sets_rule, i.rule_scope, i.lane, i.role, i.effort, i.cascade,
      i.save_outcome, i.route_outcome, i.reason, i.skip_reason, i.quoted_turn_id, at, at);
    return verdict_id;
  }

  updateJevVerdict(verdict_id: string, p: JevVerdictPatch): void {
    const sets: string[] = []; const values: Array<string | number | null> = [];
    for (const column of VERDICT_PATCH_COLUMNS) {
      const v = p[column];
      if (v === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(typeof v === "boolean" ? (v ? 1 : 0) : v);
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE jev_verdicts SET ${sets.join(", ")}, updated_at = ? WHERE verdict_id = ?`).run(...values, new Date().toISOString(), verdict_id);
  }

  /**
   * The run's terminal closes a verdict still 'pending' (review F12: every terminal path, one guarded write). The guard
   * means a lane reply, a lane fall-through or an earlier close is never overwritten. Returns the rows moved (0 or 1).
   */
  closePendingJevVerdict(run_id: string, handler_outcome: "planner_done" | "planner_failed"): number {
    const r = this.db.prepare(`UPDATE jev_verdicts SET handler_outcome = ?, updated_at = ? WHERE run_id = ? AND handler_outcome = 'pending'`)
      .run(handler_outcome, new Date().toISOString(), run_id);
    return Number(r.changes);
  }

  getJevVerdictForRun(run_id: string): JevVerdictRow | undefined {
    return this.db.prepare(`SELECT * FROM jev_verdicts WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get<JevVerdictRow>(run_id);
  }

  /** The chat's latest verdict at or before `beforeIso` (same-millisecond turns must still see each other); the run's notify target is the chat. */
  latestJevVerdictForChat(chat_id: string, beforeIso: string): JevVerdictRow | undefined {
    return this.db.prepare(`
      SELECT v.* FROM jev_verdicts v JOIN runs r ON r.run_id = v.run_id
      WHERE json_extract(r.notify_json, '$.chat_id') = ? AND v.created_at <= ?
      ORDER BY v.created_at DESC, v.rowid DESC LIMIT 1
    `).get<JevVerdictRow>(chat_id, beforeIso);
  }
```

Migration, after `applyJevDecisionInstantsMigration` (`:6773`):

```ts
  /** Jev decision tree (spec §6): one row per decision point call, joined to its first model call. Ids, enums, numbers; no text. */
  private applyJevVerdictsMigration(): void {
    const version = "2026-10-07-jev-verdicts";
    this.inTransaction(() => {
      const applied = this.db.prepare(`SELECT version FROM schema_migrations WHERE version = ?`).get<{ version: string }>(version);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS jev_verdicts (
          verdict_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          category TEXT,
          breadth REAL,
          reasoning REAL,
          actions REAL,
          sets_rule REAL,
          rule_scope TEXT CHECK (rule_scope IS NULL OR rule_scope IN ('ask', 'research')),
          lane TEXT NOT NULL CHECK (lane IN ('memory', 'status', 'planner')),
          role TEXT NOT NULL CHECK (role IN ('fast', 'default', 'thinking')),
          effort TEXT CHECK (effort IS NULL OR effort IN ('low', 'medium', 'high')),
          model TEXT,
          cascade TEXT CHECK (cascade IS NULL OR cascade = 'tiny'),
          save_outcome TEXT NOT NULL CHECK (save_outcome IN ('saved', 'not_durable', 'capped', 'none')),
          route_outcome TEXT NOT NULL CHECK (route_outcome IN ('act', 'fallback', 'pin_failed')),
          handler_outcome TEXT NOT NULL CHECK (handler_outcome IN ('pending', 'lane_reply', 'planner_done', 'planner_failed') OR handler_outcome LIKE 'fallthrough:%'),
          reason TEXT NOT NULL,
          skip_reason TEXT,
          fast_used_tool INTEGER NOT NULL DEFAULT 0,
          paco_correction TEXT CHECK (paco_correction IS NULL OR paco_correction IN ('ask_anyway', 'think_harder', 'escalation', 'low_rating')),
          quoted_turn_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS jev_verdicts_run_idx ON jev_verdicts(run_id);
        CREATE INDEX IF NOT EXISTS jev_verdicts_created_idx ON jev_verdicts(created_at);
      `);
      if (!applied) this.db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`).run(version, new Date().toISOString());
    });
  }
```

and as the last line of `migrate()` (after `this.applyJevDecisionInstantsMigration();` at `:6688`, and after Task 4's
`chat-turns-quoted` call if that landed first):

```ts
    this.applyJevVerdictsMigration();
```

`tests/run/run-store-approvals.test.ts:584-591`: Task 4 already raised both `toBe(29)` counts to 30 and appended
`+ chat-turns-quoted` to the comment. Raise both to `toBe(31)` and append `+ jev-verdicts`. If the file still reads 29,
Task 4 has not landed: stop, the binding order is broken.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/run/jev-verdicts-store.test.ts tests/run/run-ledger.test.ts tests/run/run-store-approvals.test.ts && npm run typecheck`
Expected: PASS. Typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/run/run-store.ts src/run/run-ledger.ts tests/run/jev-verdicts-store.test.ts tests/run/run-ledger.test.ts tests/run/run-store-approvals.test.ts
git commit -m "feat(store): jev_verdicts per-turn ledger, pending-verdict close, stage A event types

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

---

### Task 10: `CoreWorker.triageTurn` becomes the tree's decision point; corrections; lane 1 orphans

**Assembly overrides (Rev 2; binding — every item is folded into the text and code below):**
- **Quoted turn:** no private `quotedTurnOf`; the state's and the prompt's quoted turn come from
  `quotedTurnFromRow(q.turn, nowMs)` (`src/jev/questions/tree.ts`, Task 3). One builder for live and replay.
- **The `off` exit (review fix F13):** exactly one skipped row (`disabled`), one verdict row (`category` null, `lane`
  planner, `role` default, `effort` null, `reason` `jev_skipped`, `skip_reason` `disabled`, `route_outcome` fallback) and
  one `triage` event whose `verdict_id` is that row's id, and **no `route`** on the `TriageOutcome` (so no `routed_by`, no
  pin, no step-up: with `HOUGE_MODEL_ROLES=static` the model path is the pre-stage-A one, spec §4.3). `think harder` is
  ignored on `off`. Every other skip (override, posture, modality, state_too_large, Jev failures) returns the Default
  fallback route with its verdict and honours `think harder`.
- **The cascade call is live (Rev 4, plan Decision 14; reverses Rev 2's F10 deferral):** a `cascade` plan makes one
  one-shot under `LlmCallRole` `"cascade"` (the Tiny chain), bounded at `CASCADE_TIMEOUT_MS` (20 000 ms) and raced
  against the turn's signal, with an 18 s chain deadline on the omp legs. Its pick goes through `applyCascade`; a
  failure, a timeout or an answer outside the two is `applyCascade(plan, null)` (`cascade_failed`, Default, nothing
  saved, Task 5 F5). A valid pick with a rule saves first, through the same `saveThenRoute` as any routed rule. The
  verdict's `cascade` column reads `tiny` and the `triage` event carries `cascade_between: [a, b]` on every turn that
  made the call. The cascade's `llm_attempt` rows precede the planner's on the run; they carry no `routed_by`.
- **Rule arming (review fix F6, Task 5):** with the `sets_rule` / `rule_scope` rows unarmed, nothing saves and neither
  lane acts; the turn routes by category with the planner. `UNARMED` carries `rule: false`.
- **A verdict never stays `pending` (review fix F12):** `ompComplete` (`planner_done`), `ompFail` (`planner_failed`) and
  `recoverPlannerLeases` (`planner_failed`) close a still-pending verdict through `closePendingJevVerdict` (Task 9),
  guarded on `pending`. Every supervisor terminal funnels into the first two: `finishSuccess` / `finishFailure`
  (`planner-supervisor.ts:1020-1040`), `failQueued` (`:279-285`, the path `abortAll` and `shutdown` take), a steer failure
  (`:328`), a turn-setup failure (`:352-357`), and `failStrandedTurns` at boot (`core-worker.ts:2089-2098`). A turn that
  crashes inside `drain()` (`planner-supervisor.ts:296-300`) only raises `planner_turn_crashed`; its run keeps its lease
  until `recoverPlannerLeases` (`core-worker.ts:2104-2115`) fails it, which closes the verdict. `ompRouteEnd` moves
  `handler_outcome` through the same guarded write.
- A lane turn that falls through keeps its `lane` (`memory` / `status`) on the verdict row and changes only
  `handler_outcome`; Task 11's `lane_fallthrough_rate` depends on it.
- **The memory lane sees the quote (spec §2.2.1 "In the handlers").** In `runLessonWrite`'s adapter inputs
  (`src/core/core-worker.ts:2420-2435`): when `state.quote` resolved to a **Houge** turn, `priorAnswer` is the quoted
  turn's text (the reply being corrected), not the latest assistant turn; when it resolved to a **user** turn of a
  non-schedule run, its text leads `threadUserTexts` (most recent first, deduplicated by `turn_id` against
  `recentTurns`). Both callers (the lane and the `lesson_write` loop tool) get it: one pipeline (ADR 0029 §5.5).

**Contract deviations:**
1. **The `triage` event's required fields change here, not in Task 9** (see Task 9). The new list:
   `status, category, route_lane, role, verdict_id, confidence, top_prob, margin, lang, decision, verdict`.
   - `verdict` is now the route reason.
   - `lane`, `complete` and `scope` are dropped: they were lane 1 answers.
   - Nothing reads them from the payload. `triageShadowStats` reads `decision`, and the replay reads `occurred_at`.
   - Optional (not required) fields: `skip_reason` on a skipped row, `cascade_between` on a turn that made the
     cascade call.
2. **`SkipReason` gains `"ack_rule"`** (`src/jev/decide.ts:14`) and `JEV_NOT_ATTEMPT_REASONS` gains it too
   (`src/run/invariant-sweep.ts:214`).
   - The ack rule settles a turn with no Jev call, yet the turn still needs its one `triage` event and one skipped
     row: lane 1's denominator rule, as for `disabled` and `posture`.
   - It is not an attempt, so it cannot inflate `jev_skip_rate`.
3. **`LlmCallRole` gains `"cascade"`, and the one-shot gains a chain deadline** (Rev 4, Decision 14). `seatChain`'s
   `default` branch (`src/llm/registry.ts:140`) already maps an unlisted role to `cfg.ticks` (the Tiny role after
   Task 7), so the registry needs no new case, only a comment. `oneShotAdapter` forwards a new
   `OneShotAdapterOptions.deadlineMs` as `OneShotInput.deadlineAt`; `spawnOneShot` gives each leg what the deadline
   leaves and starts no leg once it has passed. Without it the Tiny chain's per-leg timeout
   (`HOUGE_OMP_ONESHOT_TIMEOUT_MS`) applies to each of its two legs, and the 20 s race would cut an in-flight leg,
   which `spawnOneShot` audits as `shutdown` (`src/llm/providers/omp.ts:121-124`): the one kind the `llm_leg_failing`
   sweep ignores, so a slow Kimi would hide. The cascade call does not use `llmToolAdapter`, which drops the request's
   `signal` (`registry.ts:267`): it calls `oneShotAdapter(...).answer(...)` directly, or, when the LLM adapter is
   test-injected, that adapter with `{ question, system, signal }`.
4. **A throw after Jev answered** settles one answered row with decision `fallback` and route reason `jev_skipped`.
   The contract's `RouteReason` has no `error`, and "Jev's answer was not used" is what `jev_skipped` means on the
   verdict.
5. **The escalation correction has one owner: `CoreWorker.ompRouteEnd`.** It reads the run's `routed_escalation`
   events, which the supervisor writes (Task 8). The supervisor does not touch the verdict.
6. **`triageTurn` on `off` returns `{ kind: "fallthrough" }` plus `quote` when the reply resolved.** The quote is the
   prompt slot of Task 4, not part of the model path, so the rollback keeps it.

**Files:**
- Modify: `src/core/core-worker.ts`:
  - Imports `:138-147`.
  - `OmpTurnState` `:217-231`.
  - The settle types `:233-239`.
  - `recoverPlannerLeases` `:2104-2115`.
  - `ompTurnState` `:2211-2225`.
  - `ompOutcomeSink` `:2312-2321`.
  - `ompComplete` `:2352-2373` and `ompFail` `:2375-2388`.
  - `runLessonWrite`'s adapter inputs `:2420-2435`.
  - The Jev block from `/** The denominator` `:2513` through the end of `runTriageLane` `:2635`.
  - New module helpers next to `loopToolTimeoutMs` `:3623`.
- Modify: `src/jev/decide.ts:14-16` (`SkipReason`).
- Modify: `src/run/invariant-sweep.ts:214`.
- Modify: `src/run/run-ledger.ts:299-301` (`triage` fields).
- Modify: `src/run/run-store.ts:68-70` (`LlmCallRole` gains `"cascade"`, Rev 4).
- Modify: `src/llm/registry.ts:140` (`seatChain` default-branch comment), `:174-179` (`OneShotAdapterOptions.deadlineMs`),
  `:194-199` (`oneShotAdapter` forwards it).
- Modify: `src/llm/providers/omp.ts:11-16` (`OneShotInput.deadlineAt`), `:110-112` (the leg loop, as Task 7 left it),
  one helper after `legFailure` (`:87-93`).
- Modify: `src/jev/calibration.ts`: header comment `:1-6`, `CalibrationRow` doc `:11-15`, `EVIDENCE` and
  `CALIBRATED_ROWS` `:18-28`.
- Modify: `src/gateway/memlane-commands.ts:55-58` (`recordTriageOverride`).
- Modify: `src/gateway/gateway.ts:328-336`: the rating capture, plus one private method.
- Test, rewritten: `tests/core/core-worker-triage.test.ts`.
- Test, modified:
  - `tests/run/run-ledger.test.ts:201-208`.
  - `tests/run/invariant-sweep-jev.test.ts:53-57`.
  - `tests/jev/thresholds.test.ts:50-62`.
  - `tests/jev/triage-parity.test.ts:29-67`: the first case is removed; Task 12 re-adds it against the tree replay.
  - `tests/gateway/memlane-commands.test.ts`.
  - `tests/gateway/rating-capture.test.ts`.
  - `tests/llm/seat-routing.test.ts` (the cascade seat's chain, and the chain deadline).

**Interfaces:**
- Consumes:
  - `preJudge`, `thinkHarderIn`, `routeTree`, `applyCascade`, `fallbackRoute`, `treeArmed`, `ACK_ROUTE`,
    `TREE_BAR_DEFAULTS`, `TREE_THRESHOLD_VERSION`, `type Route`, `type RoutePlan`, `type RouteReason`, `type Armed`
    (Task 5, with `Armed.rule` and the cascade plan's `ruleScope`).
  - `buildTreeState`, `lastHougeTurnOf`, `quotedTurnFromRow`, `TREE_QUESTIONS`, `TREE_CATEGORY`, `type Category` (Task 3).
  - `CoreWorker.ompConfig()` (Task 7: `resolveOmpConfig(process.env, this.roles.chains())`, so `cfg.ticks` is the
    resolved Tiny role) and `oneShotAdapter` (already imported, `core-worker.ts:70`).
  - `decide`, `persistDecisionRows`, `recordSkip`, `marginOf`, `topProbOf`, `type Decision` (Tasks 1–2,
    `src/jev/decide.ts`).
  - `type JevAnswer` (Task 1).
  - `resolveQuotedTurn` and `quotedLine` (Task 4).
  - `type TriageOutcome`, `type TurnRoute`, `type QuoteRef`, and `TurnOutcomeSink.routeEnd` (Task 8).
  - `insertJevVerdict`, `updateJevVerdict`, `closePendingJevVerdict`, `getJevVerdictForRun`, `latestJevVerdictForChat`,
    `type JevVerdictInsert` (with `cascade: "tiny" | null`), and the `quote_unresolved` event (Task 9).
  - From today's code:
    - `runLessonWrite` (`core-worker.ts:2389`).
    - `memoryInformNote` (`memory-lane-card.ts:28`).
    - `hougeStatusText` (`:2854`).
    - `isBareAck` (`src/omp/bare-ack.ts:11`).
    - `RunStore.inTransaction` (`run-store.ts:4133`), `RunStore.runSource`, `safeReason` (`core-worker.ts:80`).
    - `getRunMetadata` (`run-store.ts:6183`).
    - `calibrationRows` (`calibration.ts:36`).
- Produces:
  - `CoreWorker.triageTurn(i: TriageInput): Promise<TriageOutcome>`.
    - `fallthrough` and `inform` carry `route: TurnRoute`, with `verdict_id` null only for a lost turn, except the
      `off` exit, which carries no `route` at all (F13).
    - Every outcome carries `quote` when the turn's Telegram reply resolved.
  - `TurnOutcomeSink.routeEnd`, implemented as `ompRouteEnd`.
  - `CASCADE_TIMEOUT_MS` (20 000) and `parseCascadePick(answer, between)`, exported from `src/core/core-worker.ts`
    (the tests and Task 13's gate read the bound from there).
  - `LlmCallRole` `"cascade"`; `OneShotAdapterOptions.deadlineMs`; `OneShotInput.deadlineAt`.
  - **Finalisation rule (lane 1's, extended).** Every eligible exit that is still active passes through
    `settleTriage` exactly once. That one transaction writes three things: the decision rows (or the skipped row),
    the verdict row, and the `triage` event. When a rule saved, the transaction is the lesson's save transaction,
    reached through `inTx`. A lost turn (aborted, or its state replaced) writes none of the three.
  - **Terminal rule (F12).** A verdict written `pending` is closed by `routeEnd` or, failing that, by the run's
    terminal (`ompComplete`, `ompFail`, `recoverPlannerLeases`), whichever comes first; the guarded write makes the
    order irrelevant.
- **Task 12 must remove what this task leaves.** Each item below still has a consumer outside `core-worker.ts`:
  - `src/jev/questions/triage.ts`, the whole file. Used by `triage-replay.ts`, `triage-report.ts`,
    `tests/jev/questions.test.ts`, `tests/jev/thresholds.test.ts`, `tests/jev/triage-replay.test.ts`,
    `tests/jev/triage-report.test.ts`, `tests/jev/decide.test.ts:4` (unless Task 2 moved it) and
    `scripts/live-gate-jev-triage.mjs`.
  - `src/jev/thresholds.ts`, the whole file: `triageVerdict`, `TRIAGE_BAR_DEFAULTS`, `resolveTriageBars`,
    `THRESHOLD_VERSION`, `TRIAGE_STATUS_ARM_ID`. Used by `triage-replay.ts`, `triage-report.ts`, `src/cli.ts:344`,
    `tests/jev/thresholds.test.ts` and `tests/jev/triage-report.test.ts`.
  - `tests/jev/thresholds.test.ts` keeps its `calibratedLang` / `calibrationRows` cases. Move those into a
    `tests/jev/calibration.test.ts` when `thresholds.ts` goes.
  - The first `tests/jev/triage-parity.test.ts` case, re-added against the tree's state.
  - The `HOUGE_JEV_TRIAGE_MIN_CONF` / `_MIN_PURE` / `_MIN_STATUS` env vars. The decision point no longer reads them,
    and Task 14 removes them from `configuration.md`.

- [ ] **Step 1: Write the failing tests**

`tests/core/core-worker-triage.test.ts`. Replace the whole file:

```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SecretBroker } from "../../src/config/secret-broker.js";
import { CASCADE_TIMEOUT_MS, parseCascadePick, type CoreWorker } from "../../src/core/core-worker.js";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { JEV_INCIDENT_SUBJECT } from "../../src/jev/jev-incidents.js";
import { CATEGORIES, TREE_CATEGORY, TREE_QUESTIONS, type Category } from "../../src/jev/questions/tree.js";
import { criteriaHash } from "../../src/jev/questions/types.js";
import { TREE_STATUS_ARM_ID } from "../../src/jev/tree-policy.js";
import type { TurnOutcomeSink } from "../../src/omp/planner-supervisor.js";
import { RunStore } from "../../src/run/run-store.js";
import type { ToolAdapterResult } from "../../src/tools/tool-registry.js";
import { createQueuedTurnRun } from "../helpers/runs.js";
import { drainOutbox, ompWorker } from "../helpers/omp-worker.js";

// Spec §2 / §6: ONE decision point per Telegram text turn. Every eligible, still-active exit writes exactly one `triage`
// event, one verdict row and its decision rows, in one transaction (inside the lesson's save transaction when a rule
// saved). A turn that ended writes nothing late. The route it returns is what the planner pins: a wrong role here is
// the user-visible change of stage A, so each case asserts the role, not just "fell through". And every verdict ends:
// one left `pending` skews the §7/§9 evidence and the lane sweep forever (F12).
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** The versioned id Jev reports; the gate file's rows key on it (the request names the alias `jev-latest`, which never arms). */
const REPORTED = "jev-1.13.0";
const n = CATEGORIES.length;
/** A category answer: the given probabilities, the rest split evenly (sums to 1, as Jev's do). */
function cat(p: Partial<Record<Category, number>>) {
  const used = Object.values(p).reduce((a, b) => a + (b ?? 0), 0);
  const rest = CATEGORIES.filter((c) => p[c] === undefined);
  const probabilities = Object.fromEntries(CATEGORIES.map((c) => [c, p[c] ?? (1 - used) / rest.length]));
  const [choice, pMax] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]!;
  return { type: "choice", choice, probabilities, confidence: (pMax - 1 / n) / (1 - 1 / n) };
}
const only = (p: Partial<Record<Category, number>>) => cat(Object.fromEntries(CATEGORIES.map((c) => [c, p[c] ?? 0])));
const scope = (ask: number) => ({ type: "choice", choice: ask >= 0.5 ? "ask" : "research", probabilities: { ask, research: 1 - ask }, confidence: Math.abs(2 * ask - 1) });
const level = (probs: number[]) => ({ type: "score", score: probs.reduce((s, p, k) => s + k * p, 0),
  probabilities: Object.fromEntries(probs.map((p, k) => [String(k), p])), confidence: 0.8 });
const LIGHT = [0.1, 0.9, 0, 0];   // expected 0.9 → Fast, effort low
const HEAVY = [0, 0, 0.2, 0.8];   // expected 2.8 → Thinking, effort high
type Says = { category?: ReturnType<typeof cat>; sets_rule?: number; ask?: number; gear?: number[]; model?: string };
const treeSays = (o: Says = {}) => vi.fn(async (_url?: unknown, _init?: unknown) => json(200, {
  model: o.model ?? REPORTED, usage: { input_tokens: 900, output_tokens: 0 }, answers: {
    category: o.category ?? cat({ other: 0.9 }), sets_rule: { type: "noul", noul: o.sets_rule ?? 0.05 }, rule_scope: scope(o.ask ?? 0.9),
    breadth: level(o.gear ?? LIGHT), reasoning: level(o.gear ?? LIGHT), actions: level(o.gear ?? LIGHT) } }));
const RULE: Says = { category: cat({ memory: 0.9 }), sets_rule: 0.95 };

type Llm = (input: Record<string, unknown>) => Promise<ToolAdapterResult>;
const isDistill = (input: Record<string, unknown>) => /durable/i.test(String(input.system ?? ""));
const isCascade = (input: Record<string, unknown>) => /exactly one of these two words/.test(String(input.system ?? ""));
/**
 * The test-injected seat: the lesson-write service's two calls and the cascade's one (Decision 14), told apart by their
 * system prompt. With no `cascade` fake a cascade call fails, which must read as cascade_failed, never as a pick.
 */
const lessonLlm = (h: { distill?: () => void; reconcile?: () => void; cascade?: Llm } = {}): Llm => async (input) => {
  if (isCascade(input)) return h.cascade ? h.cascade(input) : { ok: false, error: "no cascade fake" };
  if (isDistill(input)) { h.distill?.(); return { ok: true, output: { answer: JSON.stringify({ durable: true, lesson: "Keep replies short." }) } }; }
  h.reconcile?.();
  return { ok: true, output: { answer: JSON.stringify({ verdict: "ADD", theme: "format" }) } };
};
/** A cascade that answers `answer`, recording what it was asked. */
const picks = (answer: string, seen: Record<string, unknown>[] = []): Llm => async (input) => { seen.push(input); return { ok: true, output: { answer } }; };

/**
 * Arming needs calibration rows (none ship, plan Decision 6): the gate-only file names the six questions plus the status
 * row, minus any id in `omit` (a partial row commit, the case F6 guards).
 */
function calibrationFile(omit: readonly string[] = []): string {
  const f = join(mkdtempSync(join(tmpdir(), "htri-cal-")), "rows.json");
  const ids = [...TREE_QUESTIONS.map((q) => [q.id, criteriaHash(q)] as const), [TREE_STATUS_ARM_ID, criteriaHash(TREE_CATEGORY)] as const]
    .filter(([id]) => !omit.includes(id));
  writeFileSync(f, JSON.stringify(ids.flatMap(([question_id, criteria_hash]) => (["zh", "en"] as const).map((lang) =>
    ({ question_id, criteria_hash, model: REPORTED, lang, approved: "test", evidence: "test" })))));
  return f;
}
const ARM = { HOUGE_JEV_ENABLED: "1", HOUGE_JEV_TRIAGE_ENABLED: "arm" };
const SHADOW = { HOUGE_JEV_ENABLED: "1", HOUGE_JEV_TRIAGE_ENABLED: "shadow" };

function setup(fetchImpl: unknown, env: Record<string, string> = ARM, o: { llm?: Llm; jevNow?: () => Date; omit?: string[] } = {}) {
  vi.stubEnv("HOUGE_JEV_CALIBRATION_FILE", calibrationFile(o.omit)); vi.stubEnv("HOUGE_JEV_GATE", "1");
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.stubEnv("TYPESAFE_API_KEY", "test-key");
  const store = RunStore.openInMemory();
  const worker = ompWorker(store, mkdtempSync(join(tmpdir(), "htri-")), { llm: o.llm ?? lessonLlm(), jevFetch: fetchImpl as typeof fetch, ...(o.jevNow ? { jevNow: o.jevNow } : {}) });
  const claimed = (run_id: string, text: string, w: CoreWorker = worker) => {
    const claim = store.claimRun(run_id, "w", 120)!;
    w.buildOmpTools(claim, "555");
    return { run_id, claim, input: { claim, text, userText: text, modality: "text" as const, posture: null, signal: new AbortController().signal } };
  };
  const turn = (text: string) => claimed(createQueuedTurnRun(store, text), text);
  return { store, worker, turn, claimed };
}
const triageRows = (store: RunStore, run_id: string) => store.getLedgerEvents(run_id).filter((e) => e.event_type === "triage").map((e) => e.payload);
const decisions = (store: RunStore, run_id: string) => store.listJevDecisions(run_id);
const verdictOf = (store: RunStore, run_id: string) => store.getJevVerdictForRun(run_id);
const sinkOf = (w: CoreWorker) => (w as unknown as { ompOutcomeSink: (chat: string) => TurnOutcomeSink }).ompOutcomeSink("555");
/** A pending verdict on a run that never reached triageTurn in this test (the terminal-path cases need only the row). */
const pendingVerdict = (store: RunStore, run_id: string) => store.insertJevVerdict({ run_id, category: "answer", breadth: 0.9, reasoning: 0.9,
  actions: 0.9, sets_rule: 0.05, rule_scope: null, lane: "planner", role: "fast", effort: "low", cascade: null, save_outcome: "none",
  route_outcome: "act", reason: "routed", skip_reason: null, quoted_turn_id: null });

/** A delivered Houge reply: its run, its one assistant turn, its final_report delivered as Telegram message `mid`. */
function deliveredReply(store: RunStore, text: string, mid: number): string {
  const run = createQueuedTurnRun(store, "明天天气怎么样");
  store.recordChatTurn({ chat_id: "555", run_id: run, role: "assistant", text });
  store.enqueueFinalReportNotification(run, { text, report_path: "/tmp/houge-test-report.md" });
  const sent = store.claimNextNotification("test", 30)!;
  store.markNotificationDelivered(sent.notification_id, `telegram:${mid}`);
  return run;
}
/** A turn born from a Telegram reply to message `replyTo` (the adapter puts reply_to_message_id in the event metadata). */
function quotingRun(store: RunStore, text: string, replyTo: number): string {
  const r = new Gateway(store).intake(buildTypedTaskEvent({ source: "telegram", type: "turn", program: "turn", goal: text, requested_by: { kind: "user", id: "paco" },
    notify: { kind: "telegram", chat_id: "555" }, idempotency_key: `q:${replyTo}:${text}`, source_reference: `telegram:update:9:message:${replyTo + 1}`,
    metadata: { telegram_update_id: 9, telegram_message_id: replyTo + 1, reply_to_message_id: replyTo } }));
  if (!r.ok) throw new Error("intake failed");
  return r.run_id;
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("triageTurn — the code-owned exits (one triage row, one verdict row, the Default route)", () => {
  // F13 / spec §4.3: off is the rollback. It still leaves the §6 row and the denominator event, but attaches NO route, so
  // the supervisor pins nothing and (with HOUGE_MODEL_ROLES=static) the model path is the pre-stage-A one.
  it("flag off: skipped{disabled}, no fetch, one verdict and one triage event, and NO route", async () => {
    const fetchImpl = vi.fn();
    const { store, worker, turn } = setup(fetchImpl, { HOUGE_JEV_ENABLED: "0" });
    const t = turn("以后回复短一点");
    const out = await worker.triageTurn(t.input);
    expect(out).toEqual({ kind: "fallthrough" });
    expect(fetchImpl).not.toHaveBeenCalled();
    const v = verdictOf(store, t.run_id)!;
    expect(v).toMatchObject({ category: null, lane: "planner", role: "default", route_outcome: "fallback", reason: "jev_skipped", skip_reason: "disabled",
      save_outcome: "none", handler_outcome: "pending" });
    expect(triageRows(store, t.run_id)).toMatchObject([{ status: "skipped", skip_reason: "disabled", decision: "fallback", category: null,
      route_lane: "planner", role: "default", verdict_id: v.verdict_id, verdict: "jev_skipped", margin: null }]);
    expect(decisions(store, t.run_id)).toMatchObject([{ status: "skipped", skip_reason: "disabled" }]);
    store.close();
  });
  it("photo turn: skipped{modality}; killed posture: skipped{posture}; neither asks Jev", async () => {
    const fetchImpl = treeSays(RULE);
    const { store, worker, turn } = setup(fetchImpl);
    const photo = turn("caption");
    expect(await worker.triageTurn({ ...photo.input, modality: "photo" })).toMatchObject({ kind: "fallthrough", route: { role: "default" } });
    expect(triageRows(store, photo.run_id)).toMatchObject([{ skip_reason: "modality" }]);
    const killed = turn("以后回复短一点");
    await worker.triageTurn({ ...killed.input, posture: "killed" });
    expect(triageRows(store, killed.run_id)).toMatchObject([{ skip_reason: "posture" }]);
    expect(fetchImpl).not.toHaveBeenCalled();
    store.close();
  });
  it("think harder on a skipped turn still routes Thinking (Paco's word is code, not a judgment)", async () => {
    const { store, worker, turn } = setup(vi.fn());
    const t = turn("认真想一下这个方案");
    expect(await worker.triageTurn({ ...t.input, modality: "photo" })).toMatchObject({ route: { role: "thinking", effort: null } });
    expect(verdictOf(store, t.run_id)).toMatchObject({ role: "thinking", skip_reason: "modality" });
    store.close();
  });
  it("think harder with the flag off: still no route, and the verdict says Default (the rollback ignores it)", async () => {
    const { store, worker, turn } = setup(vi.fn(), { HOUGE_JEV_ENABLED: "0" });
    const t = turn("认真想一下这个方案");
    expect(await worker.triageTurn(t.input)).toEqual({ kind: "fallthrough" });
    expect(verdictOf(store, t.run_id)).toMatchObject({ role: "default", reason: "jev_skipped", skip_reason: "disabled" });
    store.close();
  });
  it("an ack of a plain answer is answer on Fast with no Jev call; still one triage row and one skipped row", async () => {
    const fetchImpl = treeSays();
    const { store, worker, turn } = setup(fetchImpl);
    store.recordChatTurn({ chat_id: "555", run_id: "prev", role: "assistant", text: "明天晴，最高 25 度。" });
    const t = turn("谢谢");
    expect(await worker.triageTurn(t.input)).toMatchObject({ kind: "fallthrough", route: { role: "fast", effort: "low" } });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(verdictOf(store, t.run_id)).toMatchObject({ category: "answer", role: "fast", reason: "ack_rule", skip_reason: "ack_rule", route_outcome: "act" });
    expect(decisions(store, t.run_id)).toMatchObject([{ status: "skipped", skip_reason: "ack_rule" }]);
    expect(triageRows(store, t.run_id)).toMatchObject([{ status: "skipped", decision: "act", verdict: "ack_rule" }]);
    store.close();
  });
  it("the same ack after a proposal is judged by Jev (the ack ambiguity)", async () => {
    const fetchImpl = treeSays();
    const { store, worker, turn } = setup(fetchImpl);
    store.recordChatTurn({ chat_id: "555", run_id: "prev", role: "assistant", text: "要不要我帮你订明天的票？" });
    await worker.triageTurn(turn("好").input);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    store.close();
  });
  it("an override run (Ask Houge anyway) is never triaged again", async () => {
    const fetchImpl = treeSays(RULE);
    const { store, worker, turn } = setup(fetchImpl);
    const t = turn("以后回复短一点");
    store.recordMemoryEvent("triage_override", { run_id: "run_old", new_run_id: t.run_id, change_id: null });
    expect(await worker.triageTurn(t.input)).toMatchObject({ kind: "fallthrough" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(triageRows(store, t.run_id)).toMatchObject([{ skip_reason: "override" }]);
    store.close();
  });
});

describe("triageTurn — routed planner turns (the role the planner pins)", () => {
  it.each([
    ["self_change on a light gear is floored to Default", cat({ self_change: 0.9 }), LIGHT, { role: "default", effort: "low" }],
    ["research on a light gear is floored to Thinking", cat({ research: 0.9 }), LIGHT, { role: "thinking", effort: "low" }],
    ["answer on a light gear runs Fast", cat({ answer: 0.9 }), LIGHT, { role: "fast", effort: "low" }],
    ["answer on a heavy gear runs Thinking, effort high", cat({ answer: 0.9 }), HEAVY, { role: "thinking", effort: "high" }]
  ] as const)("%s", async (_name, category, gear, route) => {
    const { store, worker, turn } = setup(treeSays({ category, gear: [...gear] }));
    const t = turn("明天天气怎么样");
    expect(await worker.triageTurn(t.input)).toMatchObject({ kind: "fallthrough", route });
    expect(verdictOf(store, t.run_id)).toMatchObject({ lane: "planner", ...route, reason: "routed", route_outcome: "act", handler_outcome: "pending" });
    expect(decisions(store, t.run_id)).toHaveLength(6);
    expect(decisions(store, t.run_id).every((r) => r.decision === "act" && r.threshold_used === "2026-10-07.1:routed")).toBe(true);
    expect(triageRows(store, t.run_id)).toMatchObject([{ status: "answered", route_lane: "planner", role: route.role, decision: "act" }]);
    store.close();
  });
  it("the verdict records the three expected levels and p(sets_rule)", async () => {
    const { store, worker, turn } = setup(treeSays({ category: cat({ lookup: 0.9 }), sets_rule: 0.1 }));
    const t = turn("明天天气怎么样");
    await worker.triageTurn(t.input);
    const v = verdictOf(store, t.run_id)!;
    expect(v.breadth).toBeCloseTo(0.9); expect(v.reasoning).toBeCloseTo(0.9); expect(v.actions).toBeCloseTo(0.9); expect(v.sets_rule).toBeCloseTo(0.1);
    store.close();
  });
  it("think harder: Thinking, and the chat's previous verdict gets the think_harder correction", async () => {
    const { store, worker, turn } = setup(treeSays({ category: cat({ answer: 0.9 }) }));
    const first = turn("明天天气怎么样");
    await worker.triageTurn(first.input);
    const second = turn("认真想一下，明天要不要带伞");
    expect(await worker.triageTurn(second.input)).toMatchObject({ route: { role: "thinking" } });
    expect(verdictOf(store, first.run_id)?.paco_correction).toBe("think_harder");
    expect(verdictOf(store, second.run_id)?.paco_correction).toBeNull();
    store.close();
  });
  it("memory with sets_rule no is a correction: the planner on Default, nothing saved, no seat call", async () => {
    const llm = vi.fn(lessonLlm());
    const { store, worker, turn } = setup(treeSays({ category: cat({ memory: 0.9 }), sets_rule: 0.1 }), ARM, { llm });
    const t = turn("上次记错了，我不住在北京");
    expect(await worker.triageTurn(t.input)).toMatchObject({ kind: "fallthrough", route: { role: "default", effort: null } });
    expect(verdictOf(store, t.run_id)).toMatchObject({ category: "memory", lane: "planner", reason: "correction", save_outcome: "none" });
    expect(llm).not.toHaveBeenCalled();
    expect(store.getActiveLessons("ask")).toHaveLength(0);
    store.close();
  });
  it("bare-ack guard: a 好 Jev calls status goes to the planner, not the status lane", async () => {
    const { store, worker, turn } = setup(treeSays({ category: cat({ status: 0.9 }) }));
    const t = turn("好");
    expect(await worker.triageTurn(t.input)).toMatchObject({ kind: "fallthrough", route: { role: "default" } });
    expect(verdictOf(store, t.run_id)).toMatchObject({ category: "status", lane: "planner", reason: "bare_ack_guard" });
    store.close();
  });
});

describe("triageTurn — below the choice bar: the live cascade (Decision 14, Tiny role, 20 s)", () => {
  // Spec §2.4: an unsure category is settled by one cheap model pick between Jev's top two, never by guessing; a failure
  // anywhere is the Default planner with nothing saved. The 20 s bound is Paco's: the user waits at most that long.
  const BELOW = { category: cat({ lookup: 0.5, research: 0.3 }) };
  it("a pick routes as that category: its floor, reason cascade, cascade tiny, the pair on the triage event", async () => {
    const seen: Record<string, unknown>[] = [];
    const { store, worker, turn } = setup(treeSays(BELOW), ARM, { llm: lessonLlm({ cascade: picks("research", seen) }) });
    const t = turn("比较一下这三个城市的冬天");
    expect(await worker.triageTurn(t.input)).toMatchObject({ kind: "fallthrough", route: { role: "thinking" } }); // research floors at Thinking
    expect(verdictOf(store, t.run_id)).toMatchObject({ category: "research", cascade: "tiny", reason: "cascade", route_outcome: "act", save_outcome: "none" });
    expect(triageRows(store, t.run_id)).toMatchObject([{ status: "answered", verdict: "cascade", decision: "act", category: "research",
      cascade_between: ["lookup", "research"] }]);
    expect(seen).toHaveLength(1); // exactly one call per below-bar turn
    expect(String(seen[0]!.system)).toMatch(/lookup, research/);
    expect(String(seen[0]!.question)).toContain("比较一下这三个城市的冬天");
    expect(seen[0]!.signal).toBeInstanceOf(AbortSignal); // the turn's abort and the bound both reach the seat
    store.close();
  });
  it("a pick with a stated rule saves first under the pick's scope, then the planner runs on the pick's role", async () => {
    const { store, worker, turn } = setup(treeSays({ ...BELOW, sets_rule: 0.95 }), ARM, { llm: lessonLlm({ cascade: picks("lookup") }) });
    const t = turn("以后短一点，比较一下这三个城市的冬天");
    expect(await worker.triageTurn(t.input)).toMatchObject({ kind: "inform", note: expect.stringMatching(/^\[memory\] Lesson #\d+/), route: { role: "fast" } });
    expect(verdictOf(store, t.run_id)).toMatchObject({ category: "lookup", cascade: "tiny", reason: "cascade", save_outcome: "saved", rule_scope: "ask" });
    expect(store.getActiveLessons("ask")).toHaveLength(1);
    store.close();
  });
  it.each([
    ["an answer outside the two", picks("lookup or research")],
    ["a no-pick answer", picks("memory")],
    ["a failed seat call", (async () => ({ ok: false, error: "all cascade legs failed" })) as Llm],
    ["a thrown seat call", (async () => { throw new Error("boom"); }) as Llm]
  ])("%s: cascade_failed on Default, and despite sets_rule yes nothing saves (a failure anywhere saves nothing)", async (_name, cascade) => {
    const distill = vi.fn();
    const { store, worker, turn } = setup(treeSays({ ...BELOW, sets_rule: 0.95 }), ARM, { llm: lessonLlm({ cascade, distill }) });
    const t = turn("比较一下这三个城市的冬天");
    expect(await worker.triageTurn(t.input)).toMatchObject({ kind: "fallthrough", route: { role: "default", effort: null } });
    expect(distill).not.toHaveBeenCalled();
    expect(verdictOf(store, t.run_id)).toMatchObject({ category: null, cascade: "tiny", reason: "cascade_failed", route_outcome: "fallback", save_outcome: "none" });
    expect(triageRows(store, t.run_id)).toMatchObject([{ verdict: "cascade_failed", decision: "fallback", cascade_between: ["lookup", "research"] }]);
    expect(decisions(store, t.run_id).every((r) => r.decision === "fallback")).toBe(true);
    expect(store.getActiveLessons("ask")).toHaveLength(0);
    store.close();
  });
  it("a cascade that hangs is cut at CASCADE_TIMEOUT_MS: the in-flight call is aborted and the turn takes Default", async () => {
    let abortedAtBound: boolean | undefined;
    const hang: Llm = (input) => {
      vi.advanceTimersByTime(CASCADE_TIMEOUT_MS); // the bound passes while the call is in flight (its timer is armed first)
      abortedAtBound = (input.signal as AbortSignal).aborted;
      return new Promise<ToolAdapterResult>(() => {}); // never answers: only the bound ends the user's wait
    };
    const { store, worker, turn } = setup(treeSays(BELOW), ARM, { llm: lessonLlm({ cascade: hang }) });
    const t = turn("比较一下这三个城市的冬天");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    expect(await worker.triageTurn(t.input)).toMatchObject({ route: { role: "default" } });
    expect(abortedAtBound).toBe(true); // omp kills the leg on abort; a hung leg never outlives the turn's wait
    expect(verdictOf(store, t.run_id)).toMatchObject({ cascade: "tiny", reason: "cascade_failed" });
    expect(CASCADE_TIMEOUT_MS).toBe(20_000); // Paco's bound (2026-10-07); a change is his call, not a refactor's
    store.close();
  });
  it("think harder still routes Thinking when the cascade fails", async () => {
    const { store, worker, turn } = setup(treeSays(BELOW));
    expect(await worker.triageTurn(turn("认真想一下，比较这三个城市").input)).toMatchObject({ route: { role: "thinking" } });
    store.close();
  });
  it("memory and status are removed: with one candidate left it is taken, with no call", async () => {
    const cascade = vi.fn(picks("lookup"));
    const { store, worker, turn } = setup(treeSays({ category: only({ memory: 0.5, status: 0.3, lookup: 0.2 }) }), ARM, { llm: lessonLlm({ cascade }) });
    const t = turn("记一下明天的天气");
    expect(await worker.triageTurn(t.input)).toMatchObject({ route: { role: "fast" } });
    expect(cascade).not.toHaveBeenCalled();
    expect(verdictOf(store, t.run_id)).toMatchObject({ category: "lookup", cascade: null, reason: "cascade" });
    expect(triageRows(store, t.run_id)[0]).not.toHaveProperty("cascade_between");
    store.close();
  });
  it("shadow arms nothing, so a below-bar answer never reaches the cascade (shadow never changes behaviour)", async () => {
    const cascade = vi.fn(picks("research"));
    const { store, worker, turn } = setup(treeSays(BELOW), SHADOW, { llm: lessonLlm({ cascade }) });
    await worker.triageTurn(turn("比较一下这三个城市的冬天").input);
    expect(cascade).not.toHaveBeenCalled();
    store.close();
  });
  // Exact token (Decision 14): wrappers a model adds around one word are stripped; anything with more words is no pick.
  it("parseCascadePick takes exactly one of the two names", () => {
    const pair = ["lookup", "research"] as const;
    expect(["research", " Research. ", "`lookup`", "**lookup**", "\"research\""].map((a) => parseCascadePick(a, pair)))
      .toEqual(["research", "research", "lookup", "lookup", "research"]);
    expect(["lookup or research", "answer", "", "research\nbecause"].map((a) => parseCascadePick(a, pair))).toEqual([null, null, null, null]);
  });
});

describe("triageTurn — the memory lane and save-then-route (spec §3)", () => {
  it("memory + sets_rule yes: saves, replies with the card, decisions act, verdict lane_reply", async () => {
    const { store, worker, turn } = setup(treeSays(RULE));
    const t = turn("以后回复短一点");
    const out = await worker.triageTurn(t.input);
    expect(out.kind).toBe("lane_reply");
    if (out.kind !== "lane_reply") return;
    expect(out.text).toMatch(/^📒 Saved lesson #\d+ · format/);
    expect(out.buttons.map((b) => b.data.split(":")[1])).toEqual(["undo", "ask"]);
    expect(triageRows(store, t.run_id)).toMatchObject([{ status: "answered", category: "memory", route_lane: "memory", decision: "act", lang: "zh" }]);
    expect(decisions(store, t.run_id)).toHaveLength(6);
    expect(decisions(store, t.run_id).every((r) => r.decision === "act")).toBe(true);
    expect(verdictOf(store, t.run_id)).toMatchObject({ lane: "memory", save_outcome: "saved", handler_outcome: "lane_reply", rule_scope: "ask", route_outcome: "act" });
    expect(store.getActiveLessons("ask")).toHaveLength(1);
    store.close();
  });
  it("rule_scope research at p 0.6 saves under research", async () => {
    const { store, worker, turn } = setup(treeSays({ ...RULE, ask: 0.4 }));
    await worker.triageTurn(turn("以后查资料优先用官方来源").input);
    expect(store.getActiveLessons("research")).toHaveLength(1);
    expect(store.getActiveLessons("ask")).toHaveLength(0);
    store.close();
  });
  it("the card names the saved row's theme: an UPDATE onto a themed lesson shows that theme, not the verdict's", async () => {
    const llm: Llm = async (input) => isDistill(input)
      ? { ok: true, output: { answer: JSON.stringify({ durable: true, lesson: "Keep replies short and lead with the result." }) } }
      : { ok: true, output: { answer: JSON.stringify({ verdict: "UPDATE", id: 1, text: "Be concise; lead with the result.", theme: "nonsense" }) } };
    const { store, worker, turn } = setup(treeSays(RULE), ARM, { llm });
    store.addLesson({ scope: "ask", text: "Be concise.", theme: "format", source: "loop", created_at: new Date().toISOString() });
    const out = await worker.triageTurn(turn("以后回复先说结论").input);
    expect(out.kind).toBe("lane_reply");
    if (out.kind === "lane_reply") expect(out.text).toMatch(/· format/);
    store.close();
  });
  it("a rule on a lookup saves first, then the planner runs on the lookup's role with the [memory] note", async () => {
    const { store, worker, turn } = setup(treeSays({ category: cat({ lookup: 0.9 }), sets_rule: 0.95 }));
    const t = turn("以后短一点，另外明天天气怎么样？");
    const out = await worker.triageTurn(t.input);
    expect(out).toMatchObject({ kind: "inform", note: expect.stringMatching(/^\[memory\] Lesson #\d+ \(format\)/), route: { role: "fast", effort: "low" } });
    expect(verdictOf(store, t.run_id)).toMatchObject({ category: "lookup", lane: "planner", save_outcome: "saved", handler_outcome: "pending" });
    expect(store.getActiveLessons("ask")).toHaveLength(1);
    store.close();
  });
  it("memory lane, nothing durable: no card, the planner on Default, decision fallback, verdict fallthrough:not_durable", async () => {
    const notDurable: Llm = async () => ({ ok: true, output: { answer: JSON.stringify({ durable: false }) } });
    const { store, worker, turn } = setup(treeSays(RULE), ARM, { llm: notDurable });
    const t = turn("谢谢你");
    expect(await worker.triageTurn(t.input)).toMatchObject({ kind: "fallthrough", route: { role: "default" } });
    expect(triageRows(store, t.run_id)).toMatchObject([{ route_lane: "memory", decision: "fallback" }]);
    expect(decisions(store, t.run_id).every((r) => r.decision === "fallback")).toBe(true);
    expect(verdictOf(store, t.run_id)).toMatchObject({ lane: "memory", save_outcome: "not_durable", handler_outcome: "fallthrough:not_durable" });
    store.close();
  });
});

describe("triageTurn — the status lane", () => {
  it("code-rendered houge_status text, no planner, no LLM; verdict lane_reply", async () => {
    const llm = vi.fn(lessonLlm());
    const { store, worker, turn } = setup(treeSays({ category: cat({ status: 0.85 }) }), ARM, { llm });
    const t = turn("did you restart?");
    const out = await worker.triageTurn(t.input);
    expect(out.kind).toBe("lane_reply");
    if (out.kind === "lane_reply") { expect(out.buttons).toEqual([]); expect(out.text.length).toBeGreaterThan(10); }
    expect(triageRows(store, t.run_id)).toMatchObject([{ route_lane: "status", decision: "act", lang: "en" }]);
    expect(verdictOf(store, t.run_id)).toMatchObject({ lane: "status", handler_outcome: "lane_reply" });
    expect(llm).not.toHaveBeenCalled();
    store.close();
  });
  // An `act` row on a turn the planner then answered corrupts the status precision evidence the arm decision reads.
  it("a render throw settles one answered fallback row (never act) and falls through to the planner on Default", async () => {
    const { store, worker, turn } = setup(treeSays({ category: cat({ status: 0.85 }) }));
    vi.spyOn(worker as unknown as { hougeStatusText: () => string }, "hougeStatusText").mockImplementation(() => { throw new Error("render"); });
    const t = turn("did you restart?");
    expect(await worker.triageTurn(t.input)).toMatchObject({ kind: "fallthrough", route: { role: "default" } });
    expect(triageRows(store, t.run_id)).toMatchObject([{ status: "answered", decision: "fallback", verdict: "jev_skipped" }]);
    expect(decisions(store, t.run_id).every((r) => r.decision === "fallback")).toBe(true);
    store.close();
  });
});

describe("triageTurn — a partial row commit (F6: each decision arms on its own rows)", () => {
  // Paco may commit rows question by question. Without the rule rows a stated rule cannot be read, so it must not be
  // swallowed by the status lane's code reply, and the memory lane (which exists to save rules) must not act either.
  it("status armed, rule rows not: the status lane does not act; the planner answers on Default", async () => {
    const llm = vi.fn(lessonLlm());
    const { store, worker, turn } = setup(treeSays({ category: cat({ status: 0.9 }), sets_rule: 0.95 }), ARM, { llm, omit: ["sets_rule", "rule_scope"] });
    const t = turn("did you restart? and from now on reply in English");
    expect(await worker.triageTurn(t.input)).toMatchObject({ kind: "fallthrough", route: { role: "default", effort: null } });
    expect(verdictOf(store, t.run_id)).toMatchObject({ category: "status", lane: "planner", reason: "uncalibrated", save_outcome: "none" });
    expect(llm).not.toHaveBeenCalled();
    store.close();
  });
  it("category armed, rule rows not: a memory turn is uncalibrated and nothing saves", async () => {
    const { store, worker, turn } = setup(treeSays(RULE), ARM, { omit: ["sets_rule", "rule_scope"] });
    const t = turn("以后回复短一点");
    expect(await worker.triageTurn(t.input)).toMatchObject({ kind: "fallthrough", route: { role: "default" } });
    expect(verdictOf(store, t.run_id)).toMatchObject({ category: "memory", lane: "planner", reason: "uncalibrated" });
    expect(store.getActiveLessons("ask")).toHaveLength(0);
    store.close();
  });
});

describe("triageTurn — arming, shadow and outages", () => {
  it("shadow: rows say shadow, the route is Default, nothing acts", async () => {
    const { store, worker, turn } = setup(treeSays(RULE), SHADOW);
    const t = turn("以后回复短一点");
    expect(await worker.triageTurn(t.input)).toMatchObject({ kind: "fallthrough", route: { role: "default", effort: null } });
    expect(triageRows(store, t.run_id)).toMatchObject([{ status: "answered", decision: "shadow" }]);
    expect(decisions(store, t.run_id).every((r) => r.decision === "shadow")).toBe(true);
    expect(verdictOf(store, t.run_id)).toMatchObject({ reason: "uncalibrated", route_outcome: "fallback" });
    expect(store.getLedgerEvents().filter((e) => e.event_type === "lesson_saved")).toHaveLength(0);
    store.close();
  });
  it("armed with no gate file: the committed rows are empty (Decision 6), so the turn is uncalibrated and nothing saves", async () => {
    const { store, worker, turn } = setup(treeSays(RULE));
    vi.stubEnv("HOUGE_JEV_CALIBRATION_FILE", ""); vi.stubEnv("HOUGE_JEV_GATE", "");
    const t = turn("以后回复短一点");
    expect(await worker.triageTurn(t.input)).toMatchObject({ kind: "fallthrough", route: { role: "default" } });
    expect(verdictOf(store, t.run_id)).toMatchObject({ reason: "uncalibrated", category: null });
    expect(store.getActiveLessons("ask")).toHaveLength(0);
    store.close();
  });
  it("a model the rows do not name: answered, uncalibrated, decision fallback", async () => {
    const { store, worker, turn } = setup(treeSays({ ...RULE, model: "jev-1.14.0" }));
    const t = turn("以后回复短一点");
    await worker.triageTurn(t.input);
    expect(triageRows(store, t.run_id)).toMatchObject([{ status: "answered", decision: "fallback", verdict: "uncalibrated" }]);
    expect(store.getActiveLessons("ask")).toHaveLength(0);
    store.close();
  });
  // The request names `jev-latest`; calibration keys on the REPORTED id (shipped 2026-10-07, c026e5c). An alias move leaves
  // every tree decision unarmed, which is safe but silent, so the answered call pages Paco once per model. The incident
  // resolves only once rows name that model, never because a calibrated id answered in between (a canary would re-page).
  const uncalibrated = (store: RunStore) => store.listOpenIncidents().filter((i) => i.kind === "jev_model_uncalibrated");
  it("an alias move (arm): one jev_model_uncalibrated incident for the new id; a calibrated id answering leaves it open", async () => {
    const m = { model: "jev-1.14.0" };
    const { store, worker, turn } = setup(vi.fn(async (u?: unknown, i?: unknown) => treeSays({ model: m.model })(u, i)));
    await worker.triageTurn(turn("明天天气怎么样").input);
    await worker.triageTurn(turn("后天呢").input);
    expect(uncalibrated(store)).toMatchObject([{ subject: "jev-1.14.0" }]);
    m.model = REPORTED;
    await worker.triageTurn(turn("大后天呢").input);
    expect(uncalibrated(store)).toMatchObject([{ subject: "jev-1.14.0" }]);
    store.close();
  });
  it("no page in shadow, and none when no live tree row exists (nothing armed, nothing lost)", async () => {
    const shadow = setup(treeSays({ model: "jev-1.14.0" }), SHADOW);
    await shadow.worker.triageTurn(shadow.turn("明天天气怎么样").input);
    expect(uncalibrated(shadow.store)).toHaveLength(0);
    shadow.store.close();
    const ids = [...TREE_QUESTIONS.map((q) => q.id), TREE_STATUS_ARM_ID];
    const bare = setup(treeSays({ model: "jev-1.14.0" }), ARM, { omit: ids });
    await bare.worker.triageTurn(bare.turn("明天天气怎么样").input);
    expect(uncalibrated(bare.store)).toHaveLength(0);
    bare.store.close();
  });
  it("Jev 429: skipped{rate_limited}, incident jev_rate_limited, Default", async () => {
    const { store, worker, turn } = setup(vi.fn(async () => json(429, {})));
    const t = turn("以后回复短一点");
    expect(await worker.triageTurn(t.input)).toMatchObject({ kind: "fallthrough", route: { role: "default" } });
    expect(triageRows(store, t.run_id)).toMatchObject([{ status: "skipped", skip_reason: "rate_limited" }]);
    expect(verdictOf(store, t.run_id)).toMatchObject({ skip_reason: "rate_limited", reason: "jev_skipped", category: null });
    expect(store.listOpenIncidents().some((i) => i.kind === "jev_rate_limited")).toBe(true);
    store.close();
  });
  it("triage_overrides resolves on the next turn once the disarm marker is gone, and stays open while it exists", async () => {
    const { store, worker, turn } = setup(treeSays());
    const marker = join(mkdtempSync(join(tmpdir(), "htri-mk-")), "houge.jev-disarmed");
    vi.stubEnv("HOUGE_JEV_DISARM_PATH", marker);
    writeFileSync(marker, JSON.stringify({ reason: "triage_overrides", at: "x" }));
    store.openIncident({ kind: "triage_overrides", subject: JEV_INCIDENT_SUBJECT, detail: {} });
    await worker.triageTurn(turn("hello").input);
    expect(store.listOpenIncidents().map((i) => i.kind)).toEqual(["triage_overrides"]);
    rmSync(marker);
    await worker.triageTurn(turn("hello again").input);
    expect(store.listOpenIncidents()).toHaveLength(0);
    store.close();
  });
  it("the triage state carries the code-observed keys and no quoted_turn on a plain message", async () => {
    const fetchImpl = treeSays();
    const { store, worker, turn } = setup(fetchImpl, SHADOW);
    await worker.triageTurn(turn("明天天气怎么样").input);
    const body = JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body)) as { state: Record<string, unknown>; questions: Record<string, unknown> };
    expect(Object.keys(body.state)).toEqual(expect.arrayContaining(["last_houge_turn", "latest_message", "modality", "recent_turns"]));
    expect(body.state.quoted_turn ?? null).toBeNull();
    expect(Object.keys(body.questions)).toEqual(["category", "sets_rule", "rule_scope", "breadth", "reasoning", "actions"]);
    store.close();
  });
  it("the broker's key wins over the environment and reaches the Authorization header", async () => {
    let seenAuth = "";
    const body = treeSays();
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => { seenAuth = String((init.headers as Record<string, string>).authorization); return body(url, init); });
    vi.stubEnv("HOUGE_JEV_ENABLED", "1"); vi.stubEnv("HOUGE_JEV_TRIAGE_ENABLED", "shadow"); vi.stubEnv("TYPESAFE_API_KEY", "env-key");
    const store = RunStore.openInMemory();
    const worker = ompWorker(store, mkdtempSync(join(tmpdir(), "htri-")), { llm: lessonLlm(), jevFetch: fetchImpl as unknown as typeof fetch,
      broker: { typesafeKey: () => "test-key", redact: (s: string) => s } as unknown as SecretBroker });
    const run_id = createQueuedTurnRun(store, "以后回复短一点"); const claim = store.claimRun(run_id, "w", 120)!; worker.buildOmpTools(claim, "555");
    await worker.triageTurn({ claim, text: "以后回复短一点", userText: "以后回复短一点", modality: "text", posture: null, signal: new AbortController().signal });
    expect(seenAuth).toBe("Bearer test-key");
    store.close();
  });
});

describe("triageTurn — a Telegram quote anchors the turn (spec §2.2.1)", () => {
  it("a reply to a delivered Houge proposal: quoted_turn reaches Jev, the outcome carries the quote, the ack rule does not settle it", async () => {
    const fetchImpl = treeSays();
    const { store, worker, claimed } = setup(fetchImpl);
    deliveredReply(store, "要不要我帮你订一张明天的票？", 42);
    store.recordChatTurn({ chat_id: "555", run_id: "later", role: "assistant", text: "明天晴，最高 25 度。" }); // the latest Houge turn is a plain answer
    const resolved = store.resolveQuotedTurn("555", 42);
    if (!resolved.ok) throw new Error("fixture did not resolve");
    const t = claimed(quotingRun(store, "好", 42), "好");
    const out = await worker.triageTurn(t.input);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // without the quote this "好" after an answer would be the ack rule
    const body = JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body)) as { state: Record<string, unknown> };
    expect(body.state.quoted_turn).toMatchObject({ role: "houge", kind: "proposal", text: "要不要我帮你订一张明天的票？" });
    expect(out).toMatchObject({ quote: { turn_id: resolved.turn.turn_id, line: expect.stringMatching(/^\[replying to houge/) } });
    expect(verdictOf(store, t.run_id)?.quoted_turn_id).toBe(resolved.turn.turn_id);
    store.close();
  });
  // Spec §2.2.1 "In the handlers": the reply being corrected is the quoted one, not whatever Houge said last.
  it("a rule quoting an older Houge reply hands THAT reply to the distill as the prior answer", async () => {
    const questions: string[] = [];
    const base = lessonLlm();
    const llm: Llm = async (input) => { if (isDistill(input)) questions.push(String(input.question)); return base(input); };
    const { store, worker, claimed } = setup(treeSays(RULE), ARM, { llm });
    deliveredReply(store, "明天的行程我列了十二条，每条都附了说明。", 42);
    store.recordChatTurn({ chat_id: "555", run_id: "later", role: "assistant", text: "明天晴，最高 25 度。" });
    const t = claimed(quotingRun(store, "以后这种回复短一点", 42), "以后这种回复短一点");
    expect((await worker.triageTurn(t.input)).kind).toBe("lane_reply");
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain("明天的行程我列了十二条");
    expect(questions[0]).not.toContain("最高 25 度");
    store.close();
  });
  it("a quote that does not resolve: one quote_unresolved note, no quoted_turn, a plain message", async () => {
    const fetchImpl = treeSays();
    const { store, worker, claimed } = setup(fetchImpl);
    const t = claimed(quotingRun(store, "好的，就这样", 99), "好的，就这样");
    const out = await worker.triageTurn(t.input);
    expect(store.getLedgerEvents(t.run_id).filter((e) => e.event_type === "quote_unresolved").map((e) => e.payload)).toEqual([{ reason: "no_mapping" }]);
    expect(out).not.toHaveProperty("quote");
    const body = JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body)) as { state: Record<string, unknown> };
    expect(body.state.quoted_turn ?? null).toBeNull();
    store.close();
  });
});

describe("triageTurn — one finalisation per turn, atomic with the lane's save", () => {
  it("a throw after the save (card builder) yields inform, decisions act, one triage row, verdict still pending", async () => {
    const { store, worker, turn } = setup(treeSays(RULE));
    worker.breakMemoryLaneCardForTest();
    const t = turn("以后回复短一点");
    expect(await worker.triageTurn(t.input)).toMatchObject({ kind: "inform", note: expect.stringMatching(/^\[memory\] Lesson #\d+/), route: { role: "default" } });
    expect(triageRows(store, t.run_id)).toHaveLength(1);
    expect(triageRows(store, t.run_id)[0]).toMatchObject({ decision: "act", route_lane: "memory" });
    expect(decisions(store, t.run_id).every((r) => r.decision === "act")).toBe(true);
    expect(verdictOf(store, t.run_id)).toMatchObject({ save_outcome: "saved", handler_outcome: "pending" }); // the planner answers; routeEnd closes it
    expect(store.getActiveLessons("ask")).toHaveLength(1);
    store.close();
  });
  it("a rolled-back inTx hook leaves no lesson, no guard, exactly one fallback triage row and one verdict", async () => {
    const { store, worker, turn } = setup(treeSays(RULE));
    const t = turn("以后回复短一点");
    worker.breakLaneFinalizeOnceForTest();
    expect(await worker.triageTurn(t.input)).toMatchObject({ kind: "fallthrough" });
    expect(store.getActiveLessons("ask")).toHaveLength(0);
    expect(store.getLedgerEvents(t.run_id).filter((e) => e.event_type === "lesson_saved")).toHaveLength(0);
    expect(triageRows(store, t.run_id)).toMatchObject([{ status: "answered", decision: "fallback" }]);
    expect(decisions(store, t.run_id).filter((r) => r.decision === "fallback")).toHaveLength(6);
    expect(verdictOf(store, t.run_id)).toMatchObject({ save_outcome: "not_durable", handler_outcome: "fallthrough:not_durable" });
    const again = await worker.runLessonWrite(t.claim, "555", { scope: "ask" }, { source: "loop" });
    expect(again.committed).toBe(true);
    store.close();
  });
  it("decision rows, verdict and triage event share the lesson's transaction (a failing event write rolls all back)", async () => {
    const { store, worker, turn } = setup(treeSays(RULE));
    const t = turn("以后回复短一点");
    const original = store.appendRunLedgerEvent.bind(store);
    const spy = vi.spyOn(store, "appendRunLedgerEvent").mockImplementation((run_id, type, actor, payload) => {
      if (type === "triage") throw new Error("disk");
      return original(run_id, type, actor, payload);
    });
    await worker.triageTurn(t.input).catch(() => undefined);
    spy.mockRestore();
    expect(store.getActiveLessons("ask")).toHaveLength(0);
    expect(decisions(store, t.run_id).filter((r) => r.status === "answered")).toHaveLength(0);
    expect(verdictOf(store, t.run_id)).toBeUndefined();
    store.close();
  });
  it("an aborted turn writes nothing after Jev: no rows, no verdict, no event, no lesson", async () => {
    const { store, worker, turn } = setup(treeSays(RULE));
    const t = turn("以后回复短一点"); const ac = new AbortController();
    const p = worker.triageTurn({ ...t.input, signal: ac.signal }); ac.abort();
    expect(await p).toMatchObject({ kind: "fallthrough", route: { verdict_id: null } });
    expect(triageRows(store, t.run_id)).toHaveLength(0); expect(decisions(store, t.run_id)).toHaveLength(0);
    expect(verdictOf(store, t.run_id)).toBeUndefined();
    expect(store.getActiveLessons("ask")).toHaveLength(0);
    store.close();
  });
});

describe("triageTurn — per-stage failures (exactly one triage row each, or none for a lost turn)", () => {
  it("Jev transport failure: skipped{transport}, one row", async () => {
    const { store, worker, turn } = setup(vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const t = turn("以后回复短一点");
    expect(await worker.triageTurn(t.input)).toMatchObject({ kind: "fallthrough" });
    expect(triageRows(store, t.run_id)).toMatchObject([{ status: "skipped", skip_reason: "transport", decision: "fallback" }]);
    expect(decisions(store, t.run_id)).toMatchObject([{ status: "skipped", skip_reason: "transport" }]);
    store.close();
  });
  it("a throw before Jev answered (the clock seam): skipped{error}, one row", async () => {
    const { store, worker, turn } = setup(treeSays(RULE), ARM, { jevNow: () => { throw new Error("clock"); } });
    const t = turn("以后回复短一点");
    expect(await worker.triageTurn(t.input)).toMatchObject({ kind: "fallthrough", route: { role: "default" } });
    expect(triageRows(store, t.run_id)).toMatchObject([{ status: "skipped", skip_reason: "error" }]);
    store.close();
  });
  it("distill throws: answered fallback, six fallback rows, no lesson", async () => {
    const { store, worker, turn } = setup(treeSays(RULE), ARM, { llm: lessonLlm({ distill: () => { throw new Error("seat down"); } }) });
    const t = turn("以后回复短一点");
    expect(await worker.triageTurn(t.input)).toMatchObject({ kind: "fallthrough" });
    expect(triageRows(store, t.run_id)).toMatchObject([{ status: "answered", route_lane: "memory", decision: "fallback" }]);
    expect(decisions(store, t.run_id).map((r) => r.decision)).toEqual(Array(6).fill("fallback"));
    expect(store.getActiveLessons("ask")).toHaveLength(0);
    store.close();
  });
  it("reconcile seat throws: the service's own fallback (ADD) still saves, so the lane acts once", async () => {
    const { store, worker, turn } = setup(treeSays(RULE), ARM, { llm: lessonLlm({ reconcile: () => { throw new Error("seat down"); } }) });
    const t = turn("以后回复短一点");
    expect((await worker.triageTurn(t.input)).kind).toBe("lane_reply");
    expect(triageRows(store, t.run_id)).toMatchObject([{ status: "answered", decision: "act" }]);
    expect(store.getActiveLessons("ask")).toHaveLength(1);
    store.close();
  });
  it("the save itself throws (store error): rolled back, answered fallback, one row, no lesson", async () => {
    const { store, worker, turn } = setup(treeSays(RULE));
    vi.spyOn(store, "saveReconciledLesson").mockImplementation(() => { throw new Error("disk"); });
    const t = turn("以后回复短一点");
    expect(await worker.triageTurn(t.input)).toMatchObject({ kind: "fallthrough" });
    expect(triageRows(store, t.run_id)).toMatchObject([{ status: "answered", decision: "fallback" }]);
    expect(decisions(store, t.run_id).map((r) => r.decision)).toEqual(Array(6).fill("fallback"));
    expect(store.getActiveLessons("ask")).toHaveLength(0);
    store.close();
  });
  it.each(["distill", "reconcile"] as const)("a turn aborted during %s writes nothing", async (stage) => {
    const ac = new AbortController();
    const { store, worker, turn } = setup(treeSays(RULE), ARM, { llm: lessonLlm({ [stage]: () => ac.abort() }) });
    const t = turn("以后回复短一点");
    expect(await worker.triageTurn({ ...t.input, signal: ac.signal })).toMatchObject({ kind: "fallthrough" });
    expect(triageRows(store, t.run_id)).toHaveLength(0); expect(decisions(store, t.run_id)).toHaveLength(0);
    expect(verdictOf(store, t.run_id)).toBeUndefined();
    expect(store.getActiveLessons("ask")).toHaveLength(0);
    store.close();
  });
  it("a turn whose state was replaced mid-lane (identity changed) writes nothing", async () => {
    let replace = () => undefined as void;
    const { store, worker, turn } = setup(treeSays(RULE), ARM, { llm: lessonLlm({ distill: () => replace() }) });
    const t = turn("以后回复短一点");
    replace = () => { worker.buildOmpTools(t.claim, "555"); };
    expect(await worker.triageTurn(t.input)).toMatchObject({ kind: "fallthrough" });
    expect(triageRows(store, t.run_id)).toHaveLength(0); expect(decisions(store, t.run_id)).toHaveLength(0);
    expect(store.getActiveLessons("ask")).toHaveLength(0);
    store.close();
  });
  it("a turn aborted while a skip is pending (Jev 429) writes nothing", async () => {
    const ac = new AbortController();
    const { store, worker, turn } = setup(vi.fn(async () => { ac.abort(); return json(429, {}); }));
    const t = turn("以后回复短一点");
    expect(await worker.triageTurn({ ...t.input, signal: ac.signal })).toMatchObject({ kind: "fallthrough" });
    expect(triageRows(store, t.run_id)).toHaveLength(0); expect(decisions(store, t.run_id)).toHaveLength(0);
    store.close();
  });
});

describe("the outcome sink: buttons, the saved-lesson failure line, and routeEnd on the verdict", () => {
  it("ompComplete hands the card's buttons to the final-report notification", () => {
    const { store, worker, turn } = setup(treeSays(RULE));
    const t = turn("以后回复短一点");
    const buttons = [{ text: "↩️ Undo", data: "memlane:undo:lc_x" }];
    sinkOf(worker).complete({ run_id: t.run_id, worker_id: "w", text: "📒 Saved lesson #1 · format", attachments: [], duration_ms: 1, tool_calls: 0, buttons });
    const sent = [...drainOutbox(store).values()];
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ buttons });
    store.close();
  });
  it("ompFail after a committed save appends the saved lesson's id; without one the text is unchanged", async () => {
    const { store, worker, turn } = setup(treeSays({ category: cat({ lookup: 0.9 }), sets_rule: 0.95 }));
    const t = turn("以后短一点，另外明天天气？");
    const out = await worker.triageTurn(t.input);
    const id = Number(/Lesson #(\d+)/.exec(out.kind === "inform" ? out.note : "")?.[1]);
    expect(id).toBeGreaterThan(0);
    sinkOf(worker).fail({ run_id: t.run_id, worker_id: "w", error_type: "planner_exit", error_ref: "x" });
    const plain = turn("hello");
    sinkOf(worker).fail({ run_id: plain.run_id, worker_id: "w", error_type: "planner_exit", error_ref: "x" });
    const texts = [...drainOutbox(store).values()].map((p) => String(p.text));
    expect(texts).toHaveLength(2);
    expect(texts[0]!.endsWith(`\n\n📒 Lesson #${id} was saved before the failure.`)).toBe(true);
    expect(texts[1]).not.toContain("📒");
    store.close();
  });
  // Spec §6: the handler's end closes the verdict. A lane fall-through keeps its reason (the lane_fallthrough_rate sweep
  // counts it), a failed pin is marked, and an escalation the supervisor ledgered becomes the turn's correction.
  const routed = async () => {
    const s = setup(treeSays({ category: cat({ answer: 0.9 }) }));
    const t = s.turn("明天天气怎么样");
    const out = await s.worker.triageTurn(t.input);
    const verdict_id = out.kind === "fallthrough" ? out.route!.verdict_id! : "";
    return { ...s, t, verdict_id };
  };
  it("routeEnd writes the answering model, fast_used_tool and the handler outcome", async () => {
    const { store, worker, t, verdict_id } = await routed();
    sinkOf(worker).routeEnd!({ run_id: t.run_id, verdict_id, handler_outcome: "planner_done", model: "anthropic/claude-sonnet-5-5", fast_used_tool: true, pin_failed: false });
    expect(verdictOf(store, t.run_id)).toMatchObject({ handler_outcome: "planner_done", model: "anthropic/claude-sonnet-5-5", fast_used_tool: 1,
      route_outcome: "act", paco_correction: null });
    store.close();
  });
  it("routeEnd marks a failed pin and copies a ledgered escalation onto the verdict", async () => {
    const { store, worker, t, verdict_id } = await routed();
    store.appendRunLedgerEvent(t.run_id, "routed_escalation", "core", { from: "fast", to: "default", kind: "quota" });
    sinkOf(worker).routeEnd!({ run_id: t.run_id, verdict_id, handler_outcome: "planner_failed", model: null, fast_used_tool: false, pin_failed: true });
    expect(verdictOf(store, t.run_id)).toMatchObject({ handler_outcome: "planner_failed", route_outcome: "pin_failed", paco_correction: "escalation" });
    store.close();
  });
  it("routeEnd after the terminal already closed the verdict: the model lands, the outcome is not rewritten", async () => {
    const { store, worker, t, verdict_id } = await routed();
    sinkOf(worker).complete({ run_id: t.run_id, worker_id: "w", text: "明天晴", attachments: [], duration_ms: 1, tool_calls: 0 });
    sinkOf(worker).routeEnd!({ run_id: t.run_id, verdict_id, handler_outcome: "planner_failed", model: "anthropic/claude-sonnet-5-5", fast_used_tool: false, pin_failed: false });
    expect(verdictOf(store, t.run_id)).toMatchObject({ handler_outcome: "planner_done", model: "anthropic/claude-sonnet-5-5" });
    store.close();
  });
  it("routeEnd never overwrites a lane fall-through, and ignores a verdict id that is not the run's", async () => {
    const notDurable: Llm = async () => ({ ok: true, output: { answer: JSON.stringify({ durable: false }) } });
    const { store, worker, turn } = setup(treeSays(RULE), ARM, { llm: notDurable });
    const t = turn("以后回复短一点");
    const out = await worker.triageTurn(t.input);
    const verdict_id = out.kind === "fallthrough" ? out.route!.verdict_id! : "";
    sinkOf(worker).routeEnd!({ run_id: t.run_id, verdict_id: "jv_other", handler_outcome: "planner_done", model: "x/y", fast_used_tool: false, pin_failed: false });
    expect(verdictOf(store, t.run_id)?.model).toBeNull();
    sinkOf(worker).routeEnd!({ run_id: t.run_id, verdict_id, handler_outcome: "planner_done", model: "kimi-code/k3", fast_used_tool: false, pin_failed: false });
    expect(verdictOf(store, t.run_id)).toMatchObject({ handler_outcome: "fallthrough:not_durable", model: "kimi-code/k3" });
    store.close();
  });
});

describe("every terminal path closes a pending verdict (F12)", () => {
  it("ompComplete closes a routed turn's verdict planner_done", async () => {
    const { store, worker, turn } = setup(treeSays({ category: cat({ answer: 0.9 }) }));
    const t = turn("明天天气怎么样");
    await worker.triageTurn(t.input);
    sinkOf(worker).complete({ run_id: t.run_id, worker_id: "w", text: "明天晴", attachments: [], duration_ms: 1, tool_calls: 0 });
    expect(verdictOf(store, t.run_id)).toMatchObject({ handler_outcome: "planner_done", model: null });
    store.close();
  });
  it("ompComplete leaves a lane reply's outcome alone (the guard, not the caller, protects it)", async () => {
    const { store, worker, turn } = setup(treeSays(RULE));
    const t = turn("以后回复短一点");
    expect((await worker.triageTurn(t.input)).kind).toBe("lane_reply");
    sinkOf(worker).complete({ run_id: t.run_id, worker_id: "w", text: "📒 Saved lesson #1 · format", attachments: [], duration_ms: 1, tool_calls: 0 });
    expect(verdictOf(store, t.run_id)?.handler_outcome).toBe("lane_reply");
    store.close();
  });
  it("a run failed the way abortAll / shutdown fail a queued run (planner owner, outcome.fail killed) closes planner_failed", () => {
    const { store, worker } = setup(treeSays());
    const run_id = createQueuedTurnRun(store, "明天天气怎么样");
    pendingVerdict(store, run_id);
    expect(store.claimRun(run_id, "planner:555:q", 120)).toBeTruthy();
    sinkOf(worker).fail({ run_id, worker_id: "planner:555:q", error_type: "killed", error_ref: "killed" });
    expect(verdictOf(store, run_id)?.handler_outcome).toBe("planner_failed");
    store.close();
  });
  it("restart: failStrandedTurns closes the verdict of a turn queued before boot", () => {
    const { store, worker } = setup(treeSays());
    const run_id = createQueuedTurnRun(store, "明天天气怎么样");
    pendingVerdict(store, run_id);
    expect(worker.failStrandedTurns(new Date(Date.now() + 60_000).toISOString())).toBe(1);
    expect(verdictOf(store, run_id)?.handler_outcome).toBe("planner_failed");
    store.close();
  });
  it("a crashed turn's expired lease: recoverPlannerLeases closes the verdict", () => {
    const { store, worker } = setup(treeSays());
    const run_id = createQueuedTurnRun(store, "明天天气怎么样");
    pendingVerdict(store, run_id);
    expect(store.claimRun(run_id, "planner:555:crashed", 1)).toBeTruthy();
    expect(worker.recoverPlannerLeases(new Date(Date.now() + 60_000).toISOString())).toBe(1);
    expect(verdictOf(store, run_id)?.handler_outcome).toBe("planner_failed");
    store.close();
  });
});
```

`tests/run/run-ledger.test.ts:201-208`: replace the ADR 0029 case's triage payload:

```ts
  it("ADR 0029 events require their enum/number fields and accept null for a skipped triage (never text)", () => {
    const ok = validateLedgerEvent(createLedgerEvent({ correlation_id: "r", event_type: "triage", actor: "core", sequence: 1,
      payload: { status: "skipped", category: null, route_lane: "planner", role: "default", verdict_id: "jv_x", confidence: null, top_prob: null, margin: null,
        lang: "zh", decision: "fallback", verdict: "jev_skipped", skip_reason: "no_key" } }));
    expect(ok.ok).toBe(true);
    // the tree's denominator row must name its verdict: the §9 join reads it
    const noVerdict = validateLedgerEvent(createLedgerEvent({ correlation_id: "r", event_type: "triage", actor: "core", sequence: 2,
      payload: { status: "skipped", category: null, route_lane: "planner", role: "default", confidence: null, top_prob: null, margin: null, lang: "zh",
        decision: "fallback", verdict: "jev_skipped" } }));
    expect(noVerdict.ok).toBe(false);
    const missing = validateLedgerEvent(createLedgerEvent({ correlation_id: "r", event_type: "lesson_saved", actor: "core", sequence: 3, payload: { lesson_id: 51 } }));
    expect(missing.ok).toBe(false);
  });
```

`tests/run/invariant-sweep-jev.test.ts:55`: an ack the code settled is not a Jev attempt.

```ts
    for (const r of ["disabled", "posture", "modality", "override", "state_too_large", "ack_rule"] as const) skipped(30, r);
```

`tests/jev/thresholds.test.ts:50-62`: replace the "committed rows arm memory and status" case. Every other case in
that file passes explicit `rows`, so it does not depend on the constant:

```ts
  // Stage A (plan Decision 6): the lane 1 rows named retired hashes, and the tree's rows come on Paco's word after the
  // Task 12 replay. Until then the committed constant arms nothing, so no production turn can act on old evidence.
  it("ships with no committed rows: the default arming source arms nothing", () => {
    expect(CALIBRATED_ROWS).toEqual([]);
    expect(triageVerdict(memoryAnswers(), bars, "zh", REPORTED)).toEqual({ kind: "fallthrough", reason: "uncalibrated" });
    expect(triageVerdict(statusAnswers(), bars, "en", REPORTED)).toEqual({ kind: "fallthrough", reason: "uncalibrated" });
  });
```

`tests/jev/triage-parity.test.ts`: delete the first `it(...)` (`:29-67`, "replays to the live state_hash …"). It
compares the tree's live state with lane 1's replay, which are now different states by design, so it cannot pass
until Task 12 rewrites the replay. Task 12 re-adds it against the tree replay. Also delete the module-level
`ANSWERS`, `liveFetch`'s answer body use, `replayJev` and `at`, and the now-unused imports `JevRequest`,
`JevResult` and `runTriageReplay`. The second case keeps
`const liveFetch = vi.fn(async () => json(200, {}))` (it never fetches: the flag is off) and its assertion. Above
the `describe`, add: `// The live ↔ replay state-hash case moves to Task 12 (replay over the tree's state).`

`tests/gateway/memlane-commands.test.ts`: add inside `describe("memlane callbacks")`:

```ts
  // Spec §6: "Ask Houge anyway" is the strongest correction label; it lands on the original turn's verdict row.
  it("ask: the tap marks the original turn's verdict ask_anyway", () => {
    const store = RunStore.openInMemory(); const dir = mkdtempSync(join(tmpdir(), "mla-"));
    const original = seedRun(store, "以后回复短一点");
    const vid = store.insertJevVerdict({ run_id: original, category: "memory", breadth: 1, reasoning: 1, actions: 0, sets_rule: 0.95, rule_scope: "ask",
      lane: "memory", role: "default", effort: null, cascade: null, save_outcome: "saved", route_outcome: "act", reason: "routed", skip_reason: null, quoted_turn_id: null });
    store.updateJevVerdict(vid, { paco_correction: "think_harder" }); // an earlier, weaker label is overwritten by the tap
    const gateway = new Gateway(store, undefined, undefined, undefined, undefined, { dataDir: dir });
    expect(gateway.intake(tap("memlane_ask", { run_id: original })).ok).toBe(true);
    expect(store.getJevVerdictForRun(original)).toMatchObject({ verdict_id: vid, paco_correction: "ask_anyway" });
    store.close();
  });
```

`tests/gateway/rating-capture.test.ts`: add inside `describe("Gateway rating capture (⓪·3 S2a)")`:

```ts
  // Spec §6: a session rated 0–1 is a correction on the chat's latest routed turn; a fair rating is not.
  it.each([[1, "low_rating"], [2, null]] as const)("a rating of %s marks the latest verdict %s", (rating, expected) => {
    const store = RunStore.openInMemory();
    try {
      const gw = new Gateway(store);
      const turn = gw.intake(turnEvent("今天天气怎么样", `lr${rating}`), minutesAgo(50));
      if (!turn.ok) throw new Error("intake failed");
      store.insertJevVerdict({ run_id: turn.run_id, category: "lookup", breadth: 1, reasoning: 1, actions: 1, sets_rule: 0.05, rule_scope: null, lane: "planner",
        role: "fast", effort: "low", cascade: null, save_outcome: "none", route_outcome: "act", reason: "routed", skip_reason: null, quoted_turn_id: null,
        created_at: minutesAgo(50) });
      store.writePendingRating({ chat_id: CHAT, asked_at: minutesAgo(10), window_start: minutesAgo(120) });
      expect(gw.intake(turnEvent(String(rating), `lr${rating}:r`), NOW)).toMatchObject({ ok: true, status: "rating_captured" });
      expect(store.getJevVerdictForRun(turn.run_id)?.paco_correction).toBe(expected);
    } finally {
      store.close();
    }
  });
```

`tests/llm/seat-routing.test.ts` (as Task 7 left it: its hunk 1 already imports `parseModelChain`). Add
`LEG_EXIT_GRACE_MS` to the `providers/omp.js` import:

```ts
import { LEG_EXIT_GRACE_MS, OMP_AUDIO_REFUSED, spawnOneShot } from "../../src/llm/providers/omp.js";
```

Inside the first `describe("seat routing — …")`, after the chair/media case:

```ts
  // Decision 14 (Rev 4): the cascade runs on the Tiny role, the cheap chain, never the planner's
  it("runs the cascade on the Tiny chain (cfg.ticks)", () => {
    expect(seatChain(cfg, "cascade")).toEqual(cfg.ticks);
  });
```

Inside `describe("oneShotAdapter — …")`, after the first case:

```ts
  // Decision 14: the cascade's 20 s is a bound on the whole Tiny chain. A per-leg timeout alone would let a hung first
  // leg hand the user a second full leg, and cutting the leg from outside would audit it as `shutdown`, which the
  // llm_leg_failing sweep ignores. The chain deadline times the leg out honestly and starts no later leg.
  it("deadlineMs bounds the whole chain: the hung leg is audited timeout at the deadline and no later leg starts", { timeout: 20_000 }, async () => {
    const cfg = fakeCfg({ "kimi-code/k3": { sleepMs: 30_000, text: "late" }, "google-antigravity/gemini-3.8-flash": { text: "never asked" } });
    const tiny = { ...cfg, oneshotTimeoutMs: 5_000, ticks: parseModelChain("kimi-code/k3:low,google-antigravity/gemini-3.8-flash:low") };
    const t0 = Date.now();
    const r = await oneShotAdapter(store, tiny, { correlation_id: "cli:cascade", role: "cascade" }, undefined, { deadlineMs: 1_500 })
      .answer({ question: "Q", system: "S" });
    expect(Date.now() - t0).toBeLessThan(1_500 + LEG_EXIT_GRACE_MS + 2_000);
    expect(r.ok).toBe(false);
    expect(argv()).toHaveLength(1);
    const rows = store.getLedgerEventsByCorrelation("cli:cascade").filter((e) => e.event_type === "llm_attempt");
    expect(rows.map((e) => e.payload)).toEqual([expect.objectContaining({ role: "cascade", outcome: "error", error_kind: "timeout", model: "k3" })]);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/core/core-worker-triage.test.ts tests/run/run-ledger.test.ts tests/run/invariant-sweep-jev.test.ts tests/jev/thresholds.test.ts tests/gateway/memlane-commands.test.ts tests/gateway/rating-capture.test.ts tests/llm/seat-routing.test.ts`
Expected: FAIL.
- The cascade cases fail first: `CASCADE_TIMEOUT_MS` and `parseCascadePick` are not exported from `core-worker.ts`
  yet (both read `undefined`), and no cascade call is made.
- In `tests/llm/seat-routing.test.ts` (vitest does not typecheck, so the not-yet-legal `"cascade"` role runs): the
  chain case already passes through `seatChain`'s default branch and pins it; the deadline case fails on the elapsed
  time, because `deadlineMs` is ignored and the hung first leg runs to the 5 s per-leg timeout the test sets.
- The triage file fails first: today's `triageTurn` posts lane 1's three questions (the body test expects six),
  returns `{ kind: "fallthrough" }` with no `route`, and writes no verdict
  (`store.getJevVerdictForRun(...)` is `undefined`). The F12 terminal cases fail on `handler_outcome` staying
  `pending` (today's `ompComplete` / `ompFail` / `recoverPlannerLeases` never touch `jev_verdicts`).
- The ledger case fails on `noVerdict.ok` being `true`.
- The thresholds case fails on `CALIBRATED_ROWS` having 8 rows.
- The memlane and rating cases fail with `paco_correction` `think_harder` / `null`.

- [ ] **Step 3: Implement**

`src/jev/decide.ts:14-16`: add the code-settled ack to the skip reasons.

```ts
export type SkipReason =
  | "no_key" | "fused" | "auth" | "rate_limited" | "overloaded" | "malformed_question" | "timeout" | "parse" | "transport"
  | "state_too_large" | "disabled" | "posture" | "modality" | "override" | "error"
  // the §2.1 ack rule settled the turn in code: no Jev call, but the turn still has its one triage row
  | "ack_rule";
```

`src/run/invariant-sweep.ts:214`:

```ts
export const JEV_NOT_ATTEMPT_REASONS: readonly SkipReason[] = ["disabled", "posture", "modality", "override", "state_too_large", "ack_rule"];
```

`src/run/run-ledger.ts:299-301`:

```ts
  // `triage` is the per-turn denominator: written once per eligible Telegram turn after the outcome is known, in the same
  // transaction as the turn's jev_verdicts row (spec §6); a skipped call carries nulls for the answer numbers and a skip_reason.
  // `verdict` is the route reason; `category` / `route_lane` / `role` are what the tree routed; a turn that made the
  // cascade call adds `cascade_between` (two category enums, optional).
  triage: ["status", "category", "route_lane", "role", "verdict_id", "confidence", "top_prob", "margin", "lang", "decision", "verdict"],
```

`src/run/run-store.ts:68-70` (`LlmCallRole`). Replace:

```ts
  | "media_transcribe"
  // Jev decision points (ADR 0029): one role per point so the per-point rate is readable in llm_attempt
  | "triage";
```

with:

```ts
  | "media_transcribe"
  // Jev decision points (ADR 0029): one role per point so the per-point rate is readable in llm_attempt
  | "triage"
  // the tree's cascade pick between two categories (plan 2026-10-07 Decision 14): a Tiny-role one-shot on the turn's run
  | "cascade";
```

`src/llm/registry.ts:140` (`seatChain`'s default branch; behaviour unchanged, the comment names the new role):

```ts
    default: return cfg.ticks; // distill, consolidate, extract, attribution, frame, verify, classify*, cascade (the Tiny role)
```

`src/llm/registry.ts:174-179`. Replace `OneShotAdapterOptions`:

```ts
export interface OneShotAdapterOptions {
  /** A seat-specific chain (a judge's single string); default {@link seatChain} for the scope's role. */
  chain?: ModelString[];
  /** A bound on the whole chain, from the call's start (the tree's cascade, Decision 14): no leg outlives it, none starts after it. */
  deadlineMs?: number;
  /** Tests only: bypass the `omp --version` spawn. */
  versionCheck?: OneShotDeps["versionCheck"];
}
```

In `oneShotAdapter` (`:194-199`), replace:

```ts
          ...(plannerFamily !== undefined ? { plannerFamily } : {}), ...(req.signal ? { signal: req.signal } : {})
```

with:

```ts
          ...(plannerFamily !== undefined ? { plannerFamily } : {}), ...(req.signal ? { signal: req.signal } : {}),
          ...(opts.deadlineMs !== undefined ? { deadlineAt: Date.now() + opts.deadlineMs } : {})
```

`src/llm/providers/omp.ts:11-16`. Replace `OneShotInput`:

```ts
export interface OneShotInput {
  seat: string; chain: ModelString[]; prompt: string; files?: string[];
  correlationId: string; timeoutMs?: number; plannerFamily?: ModelFamily;
  /** The daemon's stop: aborting kills the in-flight leg's process group and ends the call (no later leg; the leg is audited error{shutdown}). */
  signal?: AbortSignal;
  /** Epoch ms bounding the whole chain: each leg's timeout is what it leaves (audited `timeout`), and no leg starts after it. */
  deadlineAt?: number;
}
```

In `spawnOneShot`'s leg loop (`:110-112` today; Task 7 Step 11 has already changed its first line to iterate
`readerOrder(input)`), replace:

```ts
  for (const [i, m] of readerOrder(input).entries()) {
    if (input.signal?.aborted) return ABORTED;
    const o = await runLeg(deps.cfg, m, input);
```

with:

```ts
  for (const [i, m] of readerOrder(input).entries()) {
    if (input.signal?.aborted) return ABORTED;
    const leg = legUnderDeadline(input, deps.cfg);
    if (leg === null) { errors.push(`${formatModelString(m)}: deadline`); break; } // never ran, so never audited
    const o = await runLeg(deps.cfg, m, leg);
```

and add after `legFailure` (`:87-93`):

```ts
/** The leg's input under the chain's deadline: its timeout is what the deadline leaves; null once nothing is left. */
function legUnderDeadline(input: OneShotInput, cfg: OmpConfig): OneShotInput | null {
  if (input.deadlineAt === undefined) return input;
  const left = input.deadlineAt - Date.now();
  return left <= 0 ? null : { ...input, timeoutMs: Math.min(input.timeoutMs ?? cfg.oneshotTimeoutMs, left) };
}
```

`src/jev/calibration.ts`. Replace `:1-6` (header):

```ts
/**
 * Calibration rows (ADR 0029 §3.5). A question is armed for a language ONLY when a row names its exact criteria hash
 * and the reported model, so a criteria or model change disarms it. The decision tree's questions (spec 2026-10-06 §7)
 * arm on Paco's word after the replay; evidence then accrues while armed, and the per-turn bars (tree-policy.ts) still
 * send every unsure turn to the planner on the Default role.
 */
```

Replace the `CalibrationRow` doc `:11-15` (it names lane 1's `lane:status` / `TRIAGE_STATUS_ARM_ID`):

```ts
/**
 * One arming row. `question_id` is a tree question id (`category`, `sets_rule`, `rule_scope`, `breadth`, `reasoning`,
 * `actions`) or the pseudo-id `category:status` (tree-policy.ts TREE_STATUS_ARM_ID, criteria hash = TREE_CATEGORY's),
 * which arms the status lane: memory and status clear different bars, so neither row implies the other. Both lanes
 * also need the `sets_rule` + `rule_scope` rows (tree-policy.ts treeArmed `rule`), so a stated rule is never swallowed.
 */
```

Replace `:18-28` (`EVIDENCE` and the rows). `EVIDENCE` becomes an orphan and is removed:

```ts
/**
 * Empty on purpose (plan 2026-10-07 Decision 6): the lane 1 rows named the retired lane 1 hashes. The tree's rows are
 * committed here on Paco's word after the Task 12 replay (`houge jev replay triage`); until then every turn routes
 * `uncalibrated` → the planner on Default, and the memory and status lanes do not act.
 */
export const CALIBRATED_ROWS: readonly CalibrationRow[] = [];
```

`src/gateway/memlane-commands.ts:55-58`. In `recordTriageOverride`, after the `recordJevOutcome` loop:

```ts
  for (const d of store.listJevDecisions(original_run_id)) store.recordJevOutcome(d.decision_id, "paco_correction", "override");
  // Spec §6: the tap is Paco's explicit correction, so it outranks any earlier label on the original turn's verdict.
  const verdict = store.getJevVerdictForRun(original_run_id);
  if (verdict) store.updateJevVerdict(verdict.verdict_id, { paco_correction: "ask_anyway" });
```

`src/gateway/gateway.ts:328-336`. After `this.runStore.applyRatingToLessons(applied, parsed.rating, now);` add:

```ts
    this.runStore.applyRatingToLessons(applied, parsed.rating, now);
    if (parsed.rating <= LOW_RATING_MAX) this.markLowRating(chat_id, now);
```

Add a module constant near the gateway's other constants:

```ts
/** Spec §6: a session rated at or below this is a correction on the chat's latest routed turn. */
const LOW_RATING_MAX = 1;
```

Add a private method next to `admitMemLaneAsk` (`gateway.ts:1135`):

```ts
  /** Spec §6: a low session rating labels the chat's latest verdict (first correction wins: a tap or think-harder stays). */
  private markLowRating(chat_id: string, now: string): void {
    const v = this.runStore.latestJevVerdictForChat(chat_id, now);
    if (v && v.paco_correction === null) this.runStore.updateJevVerdict(v.verdict_id, { paco_correction: "low_rating" });
  }
```

`src/core/core-worker.ts`. **Imports.** Replace `:138-147`:

```ts
import { PlannerSupervisor, type QuoteRef, type SupervisorDeps, type TriageInput, type TriageOutcome, type TurnOutcomeSink, type TurnRoute } from "../omp/planner-supervisor.js";
import { calibrationRows, type CalibrationRow } from "../jev/calibration.js";
import { decide, marginOf, persistDecisionRows, recordSkip, topProbOf, type Decision, type JevDecisionInsert, type SkipReason } from "../jev/decide.js";
import { createJevClient, type JevAnswer, type JevRequest, type JevResult } from "../jev/jev-client.js";
import { jevDisarmMarkerPath, resolveJevTriageMode, type JevTriageMode } from "../jev/jev-flags.js";
import { checkJevModelCalibrated, resolveTriageOverridesIfRearmed } from "../jev/jev-incidents.js";
import { langOf, type Lang } from "../jev/intent-question.js";
import { buildTreeState, lastHougeTurnOf, quotedTurnFromRow, TREE_CATEGORY, TREE_QUESTIONS, type Category } from "../jev/questions/tree.js";
import {
  ACK_ROUTE, applyCascade, fallbackRoute, preJudge, routeTree, thinkHarderIn, TREE_BAR_DEFAULTS, TREE_THRESHOLD_VERSION, treeArmed,
  treeArmingRows, type Armed, type Route, type RoutePlan, type RouteReason
} from "../jev/tree-policy.js";
import { isBareAck } from "../omp/bare-ack.js";
import { memoryInformNote, memoryLaneCard } from "./memory-lane-card.js";
```

Change `import type { TurnContextDeps, TurnRetrieval } from "../omp/turn-context.js";` (`:151`) to:

```ts
import { quotedLine, type TurnContextDeps, type TurnRetrieval } from "../omp/turn-context.js";
```

and add `JevVerdictInsert` to the type import from `../run/run-store.js` (`:125`):

```ts
import type { ChatTurnRow, ClaimedRun, EpisodicFactRow, JevVerdictInsert, LessonRow, LessonSaveResult, LessonSource, WikiPageRow } from "../run/run-store.js";
```

**`OmpTurnState`.** After `triageFinalized?: boolean;` (`:230`) add:

```ts
  /** The stored turn this message quotes (spec §2.2.1), resolved at claim; absent when not a reply or unresolved. */
  quote?: { role: "houge" | "user"; turn: ChatTurnRow };
```

**Settle types.** Replace `:233-239` (lane 1's `TriageSettle`, `TriageNumbers`, `verdictLabel`):

```ts
/** What one tree finalisation writes (spec §6): decision rows (or the skipped row), the verdict row, the triage event. Never text. */
type SaveOutcome = JevVerdictInsert["save_outcome"];
type VerdictHandler = "lane_reply" | `fallthrough:${string}`;
type VerdictScores = Pick<JevVerdictInsert, "breadth" | "reasoning" | "actions" | "sets_rule">;
type TriageNumbers = { confidence: number | null; top_prob: number; margin: number };
/** `between`: the two candidates of a turn that made the cascade call (Decision 14), ledgered on its triage event. */
type TriageSettle =
  | { kind: "skipped"; reason: SkipReason; route: Route; handler?: VerdictHandler }
  | { kind: "answered"; rows: JevDecisionInsert[]; decision: "act" | "fallback" | "shadow"; numbers: TriageNumbers; scores: VerdictScores;
      route: Route; save: SaveOutcome; handler?: VerdictHandler; between?: readonly [Category, Category] };
type AnsweredSettle = Extract<TriageSettle, { kind: "answered" }>;
type SettleFor = (route: Route, save: SaveOutcome, handler?: VerdictHandler) => AnsweredSettle;
/** What triageTurn's catch needs: the turn's think-harder reading, its quote, and the answered rows once Jev answered. */
interface TriageHeld { thinkHarder: boolean; quote: QuoteRef | null; answered?: AnsweredSettle }
/** Reasons whose route the tree took on Jev's (or the code's) word; every other reason is a fallback to Default. */
const ACTED: ReadonlySet<RouteReason> = new Set(["routed", "cascade", "correction", "ack_rule"]);
const UNARMED: Armed = { category: false, status: false, memory: false, gear: false, rule: false };
const NO_SCORES: VerdictScores = { breadth: null, reasoning: null, actions: null, sets_rule: null };
```

**Lease recovery closes the verdict (F12).** In `recoverPlannerLeases` (`:2104-2115`), replace:

```ts
    for (const r of recovered) {
      this.ompTurns.delete(r.run_id);
      if (replied.has(r.worker_id)) continue;
```

with:

```ts
    for (const r of recovered) {
      this.ompTurns.delete(r.run_id);
      this.closeVerdict(r.run_id, "planner_failed"); // a turn that crashed in drain() ends here, not in ompFail
      if (replied.has(r.worker_id)) continue;
```

**Quote at claim.** In `ompTurnState` (`:2211-2225`), add the quote to the state literal:

```ts
  private ompTurnState(claim: ClaimedRun, chatId: string): OmpTurnState {
    const threadCutAt = new Date();
    const recentTurns = this.runStore.getRecentChatTurns(chatId, resolveChatContextTurns(process.env), chatContextSince(process.env, threadCutAt));
    const quote = this.resolveClaimQuote(claim.run_id, chatId);
    const state: OmpTurnState = {
      threadCutAt: threadCutAt.toISOString(),
      turnCtx: {
        recentTurns, turnChars: resolveChatContextTurnChars(process.env), ranOnce: new Set<string>(), evolutionNotices: [],
        externalReads: [], sourceUrls: [], memory: newMemoryTurnState()
      },
      anchor: { priorAnswer: [...recentTurns].reverse().find((t) => t.role === "assistant")?.text ?? "", defaultScope: "ask" },
      ...(quote ? { quote } : {})
    };
    this.ompTurns.set(claim.run_id, state);
    return state;
  }

  /**
   * Spec §2.2.1: the Telegram reply this turn quotes, resolved to the stored turn at claim (code only; the text Telegram
   * sends inside reply_to_message is never used). Unresolved → one `quote_unresolved` note and a plain message.
   */
  private resolveClaimQuote(run_id: string, chatId: string): OmpTurnState["quote"] {
    let replyTo: unknown;
    try { replyTo = this.runStore.getRunMetadata(run_id).reply_to_message_id; } catch { return undefined; } // no run row: nothing to resolve
    if (typeof replyTo !== "number" || !Number.isInteger(replyTo)) return undefined;
    const r = this.runStore.resolveQuotedTurn(chatId, replyTo);
    if (r.ok) return { role: r.role, turn: r.turn };
    this.runStore.appendRunLedgerEvent(run_id, "quote_unresolved", "core", { reason: r.reason });
    return undefined;
  }
```

**Outcome sink.** In `ompOutcomeSink` (`:2312-2321`), add after `fail: (i) => this.ompFail(i),`:

```ts
      routeEnd: (i) => this.ompRouteEnd(i),
```

and add the two methods after `ompOutcomeSink` (before `supervisorIncident`, `:2323`):

```ts
  /**
   * The planner's end on a routed turn (spec §6): the answering model, fast_used_tool and a failed pin. handler_outcome
   * moves only from 'pending' (the guarded close), so a lane fall-through or an earlier terminal close keeps its value.
   * This is the ONE owner of the `escalation` correction: it copies a `routed_escalation` the supervisor ledgered for
   * the run. Never fails the turn.
   */
  private ompRouteEnd(i: Parameters<NonNullable<TurnOutcomeSink["routeEnd"]>>[0]): void {
    try {
      const v = this.runStore.getJevVerdictForRun(i.run_id);
      if (!v || v.verdict_id !== i.verdict_id) return;
      const escalated = this.runStore.getLedgerEvents(i.run_id).some((e) => e.event_type === "routed_escalation");
      this.runStore.inTransaction(() => {
        this.runStore.closePendingJevVerdict(i.run_id, i.handler_outcome);
        this.runStore.updateJevVerdict(i.verdict_id, {
          model: i.model, fast_used_tool: i.fast_used_tool,
          ...(i.pin_failed ? { route_outcome: "pin_failed" as const } : {}),
          ...(escalated && v.paco_correction === null ? { paco_correction: "escalation" as const } : {})
        });
      });
    } catch (e) {
      console.error(`triage: verdict end write failed: ${safeReason(e)}`); // the reply is already decided; the ledger gap is logged
    }
  }

  /** F12: the run's terminal closes a verdict routeEnd has not (guarded on 'pending'). Never fails the terminal write. */
  private closeVerdict(run_id: string, outcome: "planner_done" | "planner_failed"): void {
    try {
      this.runStore.closePendingJevVerdict(run_id, outcome);
    } catch (e) {
      console.error(`triage: verdict close failed: ${safeReason(e)}`);
    }
  }
```

**Terminals close the verdict (F12).** In `ompComplete` (`:2352-2373`), replace:

```ts
    if (!won) { report.discard(); return; }
    this.commitReport(i.run_id, report, false);
```

with:

```ts
    if (!won) { report.discard(); return; }
    this.closeVerdict(i.run_id, "planner_done");
    this.commitReport(i.run_id, report, false);
```

In `ompFail` (`:2375-2388`), replace:

```ts
      partial?.discard();
      return;
    }
    if (partial) this.commitReport(i.run_id, partial, true);
```

with:

```ts
      partial?.discard();
      return;
    }
    this.closeVerdict(i.run_id, "planner_failed");
    if (partial) this.commitReport(i.run_id, partial, true);
```

Both closes sit after the run's terminal write is won, so a losing second terminal never touches the verdict.

**The lesson write sees the quote.** In `runLessonWrite` (`:2420-2435`), replace:

```ts
      priorAnswer: state.anchor.priorAnswer,
```

with:

```ts
      // spec §2.2.1: a quoted Houge reply is the answer being corrected, not whatever Houge said last
      priorAnswer: state.quote?.role === "houge" ? state.quote.turn.text : state.anchor.priorAnswer,
```

and replace:

```ts
      // ⓪·3f F1: the recent USER turns too, most recent first. Assistant turns are EXCLUDED (Houge's replies carry
      // code-owned strings legitimately); a schedule-born user turn is the stored goal, not Paco: excluded by source.
      threadUserTexts: [...state.turnCtx.recentTurns].reverse()
        .filter((t) => t.role === "user" && this.runStore.runSource(t.run_id) !== "schedule").map((t) => t.text),
```

with:

```ts
      threadUserTexts: this.lessonThreadUserTexts(state),
```

and add the helper directly after `runLessonWrite`:

```ts
  /**
   * ⓪·3f F1: the recent USER turns, most recent first. Assistant turns are EXCLUDED (Houge's replies carry code-owned
   * strings legitimately); a schedule-born user turn is the stored goal, not Paco: excluded by source. Spec §2.2.1: a
   * quoted user turn leads the list (once, by turn_id), because it is the message this one continues.
   */
  private lessonThreadUserTexts(state: OmpTurnState): string[] {
    const fromPaco = (t: ChatTurnRow): boolean => t.role === "user" && this.runStore.runSource(t.run_id) !== "schedule";
    const q = state.quote?.role === "user" && fromPaco(state.quote.turn) ? state.quote.turn : null;
    const recent = [...state.turnCtx.recentTurns].reverse().filter((t) => fromPaco(t) && t.turn_id !== q?.turn_id);
    return [...(q ? [q] : []), ...recent].map((t) => t.text);
  }
```

**The decision point.** Replace everything from `/** The denominator (spec §3.2): one \`triage\` event …`
(`:2513`) through the closing brace of `runTriageLane` (`:2635`). Keep `memoryLaneCardFor` (`:2637-2642`) and
everything above `:2513` (`memoryLaneCard`, the fault hooks, `jevClient`) unchanged. New block:

```ts
  /** The denominator (spec §6): one `triage` event per eligible turn, naming its verdict row. */
  private triageEvent(run_id: string, lang: Lang, f: TriageSettle, verdict_id: string): void {
    const n: Partial<TriageNumbers> = f.kind === "answered" ? f.numbers : {};
    const decision = f.kind === "answered" ? f.decision : f.route.reason === "ack_rule" ? "act" : "fallback";
    this.runStore.appendRunLedgerEvent(run_id, "triage", "core", {
      status: f.kind, category: f.route.category, route_lane: f.route.lane, role: f.route.role, verdict_id,
      confidence: n.confidence ?? null, top_prob: n.top_prob ?? null, margin: n.margin ?? null, lang, decision, verdict: f.route.reason,
      ...(f.kind === "skipped" ? { skip_reason: f.reason } : {}),
      ...(f.kind === "answered" && f.between ? { cascade_between: [...f.between] } : {})
    });
  }

  private verdictInsert(run_id: string, f: TriageSettle, state: OmpTurnState | undefined): JevVerdictInsert {
    const r = f.route;
    return {
      run_id, category: r.category, ...(f.kind === "answered" ? f.scores : NO_SCORES), rule_scope: r.save?.scope ?? null, lane: r.lane, role: r.role,
      // `tiny` whenever the cascade call was made (Decision 14), even when a later throw settled the turn as a fallback
      effort: r.effort, cascade: f.kind === "answered" && f.between ? "tiny" : r.cascade, save_outcome: f.kind === "answered" ? f.save : "none",
      route_outcome: ACTED.has(r.reason) ? "act" : "fallback",
      reason: r.reason, skip_reason: f.kind === "skipped" ? f.reason : null, quoted_turn_id: state?.quote?.turn.turn_id ?? null
    };
  }

  /** Spec §6: `think harder` now labels the chat's previous turn as routed too light (first correction wins). */
  private markThinkHarder(run_id: string): void {
    const prev = this.runStore.latestJevVerdictForChat(this.chatOf(run_id), new Date().toISOString());
    if (prev && prev.run_id !== run_id && prev.paco_correction === null) this.runStore.updateJevVerdict(prev.verdict_id, { paco_correction: "think_harder" });
  }

  /**
   * THE finaliser: every eligible, still-active exit of triageTurn passes through here exactly once and writes the
   * decision rows (or the skipped row), the verdict row and the triage event together. A lost turn writes nothing.
   * `inTx`: already inside the lane's save transaction, so the caller flips `triageFinalized` after that commit.
   * Returns the verdict id, or null when nothing was written.
   */
  private settleTriage(i: TriageInput, state: OmpTurnState | undefined, lang: Lang, f: TriageSettle, o: { inTx?: boolean } = {}): string | null {
    if (state?.triageFinalized || this.laneLost(i, state)) return null;
    const run_id = i.claim.run_id;
    let verdict_id: string | null = null;
    const write = (): void => {
      if (f.kind === "skipped") recordSkip(this.runStore, "triage", run_id, lang, f.reason);
      else persistDecisionRows(this.runStore, f.rows, f.decision, `${TREE_THRESHOLD_VERSION}:${f.route.reason}`);
      if (o.inTx && this.laneFinalizeFault) { this.laneFinalizeFault = false; throw new Error("lane finalize fault (test)"); }
      if (f.route.thinkHarder) this.markThinkHarder(run_id);
      const id = this.runStore.insertJevVerdict(this.verdictInsert(run_id, f, state));
      if (f.handler) this.runStore.updateJevVerdict(id, { handler_outcome: f.handler });
      this.triageEvent(run_id, lang, f, id);
      verdict_id = id;
    };
    if (o.inTx) { write(); return verdict_id; }
    this.runStore.inTransaction(write);
    if (state) state.triageFinalized = true;
    return verdict_id;
  }

  /** True once the turn is gone: aborted signal, or its state replaced/deleted (ompComplete/ompFail delete it). */
  private laneLost(i: TriageInput, state: OmpTurnState | undefined): boolean {
    return i.signal.aborted || (state !== undefined && this.ompTurns.get(i.claim.run_id) !== state);
  }

  /**
   * Flag off (spec §4.3 rollback, F13): one skipped{disabled} row, one verdict (Default, jev_skipped) and one triage
   * event, but NO route, so the supervisor pins nothing. `think harder` is ignored here for the same reason.
   */
  private triageOff(i: TriageInput, state: OmpTurnState | undefined, lang: Lang, held: TriageHeld): TriageOutcome {
    this.settleTriage(i, state, lang, { kind: "skipped", reason: "disabled", route: fallbackRoute("jev_skipped", false) });
    return { kind: "fallthrough", ...quoteField(held.quote) };
  }

  /** A turn the tree did not judge: the Default fallback (or the ack route), one skipped row, one verdict. */
  private triageSkip(i: TriageInput, state: OmpTurnState | undefined, lang: Lang, reason: SkipReason, held: TriageHeld,
    route: Route = fallbackRoute("jev_skipped", held.thinkHarder)): TriageOutcome {
    const id = this.settleTriage(i, state, lang, { kind: "skipped", reason, route });
    return { kind: "fallthrough", route: turnRoute(route, id), ...quoteField(held.quote) };
  }

  /** The quote line every handler gets (spec §2.2.1); its age is read now, the state's at the state build. */
  private quoteRef(state: OmpTurnState | undefined): QuoteRef | null {
    if (!state?.quote) return null;
    return { turn_id: state.quote.turn.turn_id, line: quotedLine(quotedTurnFromRow(state.quote.turn, Date.now()), state.turnCtx.turnChars) };
  }

  /**
   * The decision point (spec §2): flag → override → posture → modality → state → ack rule → Jev → policy → (below the
   * bar, the cascade's Tiny pick, Decision 14) → handler. Any throw still finalises once: answered `fallback` once Jev
   * had answered, skipped `error` before that.
   */
  async triageTurn(i: TriageInput): Promise<TriageOutcome> {
    const lang = langOf(i.userText);
    const state = this.ompTurns.get(i.claim.run_id);
    const held: TriageHeld = { thinkHarder: thinkHarderIn(i.userText), quote: this.quoteRef(state) };
    try {
      return await this.triageTurnInner(i, state, lang, held);
    } catch (e) {
      console.error(`triage: threw: ${safeReason(e)}`);
      const route = fallbackRoute("jev_skipped", held.thinkHarder);
      const id = this.settleTriage(i, state, lang, held.answered ? { ...held.answered, route, decision: "fallback" } : { kind: "skipped", reason: "error", route });
      const saved = state?.lessonSavedThisTurn;
      const base = { route: turnRoute(route, id), ...quoteField(held.quote) };
      return saved ? { kind: "inform", note: memoryInformNote(saved.id, saved.theme), ...base } : { kind: "fallthrough", ...base };
    }
  }

  private async triageTurnInner(i: TriageInput, state: OmpTurnState | undefined, lang: Lang, held: TriageHeld): Promise<TriageOutcome> {
    const run_id = i.claim.run_id;
    resolveTriageOverridesIfRearmed(this.runStore, jevDisarmMarkerPath(process.env, this.ompDataDir()));
    const mode = resolveJevTriageMode(process.env, this.ompDataDir());
    if (mode === "off") return this.triageOff(i, state, lang, held);
    if (this.runStore.triageOverrideFor(run_id)) return this.triageSkip(i, state, lang, "override", held);
    if (i.posture !== null) return this.triageSkip(i, state, lang, "posture", held);
    if (i.modality !== "text") return this.triageSkip(i, state, lang, "modality", held);
    if (!state) return this.triageSkip(i, state, lang, "error", held);
    const now = this.ompOptions.jevNow ?? (() => new Date());
    const builtAt = now();
    const lastHougeTurn = lastHougeTurnOf(state.turnCtx.recentTurns, builtAt.getTime());
    const quotedTurn = state.quote ? quotedTurnFromRow(state.quote.turn, builtAt.getTime()) : null;
    // shadow never changes behaviour, so the ack rule (which changes the role) acts only when armed
    if (mode === "arm" && preJudge({ text: i.userText, lastHougeTurn, quoted: quotedTurn !== null }).kind === "ack_answer") {
      return this.triageSkip(i, state, lang, "ack_rule", held, ACK_ROUTE);
    }
    const built = buildTreeState({ userText: i.userText, recentTurns: state.turnCtx.recentTurns, turnChars: state.turnCtx.turnChars, modality: i.modality,
      lastHougeTurn, quotedTurn }, this.broker ? (s) => this.broker!.redact(s) : undefined);
    if (!built.ok) return this.triageSkip(i, state, lang, built.skip, held);
    const d = await decide({ point: "triage", run_id, state: built.state, questions: TREE_QUESTIONS, lang, client: this.jevClient(run_id),
      store: this.runStore, thresholdVersion: TREE_THRESHOLD_VERSION, now, instants: { thread_cut_at: state.threadCutAt, state_built_at: builtAt.toISOString() } });
    if (d.status === "skipped") return this.triageSkip(i, state, lang, d.reason, held); // settleTriage checks laneLost first
    return this.routeAnswered(i, state, lang, d, mode, held);
  }

  /** Jev answered: policy (shadow arms nothing), then the route's handler; below the bar, the cascade picks first. */
  private async routeAnswered(i: TriageInput, state: OmpTurnState, lang: Lang, d: Extract<Decision, { status: "answered" }>, mode: JevTriageMode,
    held: TriageHeld): Promise<TriageOutcome> {
    const rows = calibrationRows(process.env);
    const armed = mode === "arm" ? treeArmed(lang, d.model, rows) : UNARMED; // d.model: the REPORTED id, never the alias
    const plan = routeTree(d.answers, { bars: TREE_BAR_DEFAULTS, armed, thinkHarder: held.thinkHarder, bareAck: isBareAck(i.userText) });
    const settleFor: SettleFor = (route, save, handler) => ({ kind: "answered", rows: d.rows, decision: decisionFor(mode, route, save),
      numbers: numbersOf(d.answers.category!), scores: scoresOf(d.answers), route, save, ...(handler ? { handler } : {}) });
    held.answered = settleFor(fallbackRoute("jev_skipped", held.thinkHarder), "none"); // from here a throw settles as answered fallback
    if (mode === "arm") this.checkJevModel(d.model, rows); // shadow arms nothing, so an alias move loses nothing there
    if (plan.kind === "cascade") return this.cascadeRoute(i, state, lang, plan, settleFor, held);
    const route = plan.route;
    if (route.lane === "status") return this.statusLane(i, state, lang, route, settleFor, held);
    if (route.save) return this.saveThenRoute(i, state, lang, route, settleFor, held);
    const id = this.settleTriage(i, state, lang, settleFor(route, "none"));
    return { kind: "fallthrough", route: turnRoute(route, id), ...quoteField(held.quote) };
  }

  /** An alias move pages once (jev-incidents.ts), counting only the tree's live rows. Never fails the turn: the answer is held. */
  private checkJevModel(model: string, rows: readonly CalibrationRow[]): void {
    try { checkJevModelCalibrated(this.runStore, model, treeArmingRows(rows)); } catch (e) { console.error(`jev: model calibration check failed: ${safeReason(e)}`); }
  }

  /** The status lane: code renders first, so a render throw settles one answered fallback (triageTurn's catch), never act. */
  private statusLane(i: TriageInput, state: OmpTurnState, lang: Lang, route: Route, settleFor: SettleFor, held: TriageHeld): TriageOutcome {
    const text = this.hougeStatusText(this.chatOf(i.claim.run_id));
    this.settleTriage(i, state, lang, settleFor(route, "none", "lane_reply"));
    return { kind: "lane_reply", text, buttons: [], ...quoteField(held.quote) };
  }

  /**
   * Spec §3: a rule saves first (the shared lesson-write service, its rows + verdict + event inside the save transaction),
   * then the route's handler runs. Memory + rule ends at the card; any other category is the planner with the [memory]
   * note. Nothing durable / capped / rolled back: the turn proceeds as if sets_rule were no (a memory turn falls through).
   */
  private async saveThenRoute(i: TriageInput, state: OmpTurnState, lang: Lang, route: Route, settleFor: SettleFor, held: TriageHeld): Promise<TriageOutcome> {
    const v: { id: string | null } = { id: null };
    const w = await this.runLessonWrite(i.claim, this.chatOf(i.claim.run_id), { scope: route.save?.scope ?? "ask" }, { source: "lane", signal: i.signal,
      inTx: () => { v.id = this.settleTriage(i, state, lang, settleFor(route, "saved"), { inTx: true }); } });
    if (w.committed) state.triageFinalized = true;
    const q = quoteField(held.quote);
    if (!w.committed || !w.saved || !w.change_id || !w.theme) {
      const save = saveOutcomeOf(w);
      const id = this.settleTriage(i, state, lang, settleFor(route, save, route.lane === "memory" ? `fallthrough:${save}` : undefined));
      return { kind: "fallthrough", route: turnRoute(route, id), ...q };
    }
    const note = memoryInformNote(w.saved.id, w.theme);
    if (route.lane !== "memory") return { kind: "inform", note, route: turnRoute(route, v.id), ...q };
    try {
      const card = this.memoryLaneCardFor(i.claim.run_id, w as Required<LessonWriteOutcome>);
      if (v.id) this.runStore.updateJevVerdict(v.id, { handler_outcome: "lane_reply" });
      return { kind: "lane_reply", ...card, ...q };
    } catch (e) {
      // The save is committed and finalised as "act"; the planner answers and the note names the lesson (spec §5.1).
      console.error(`memory lane: card failed after save: ${safeReason(e)}`);
      return { kind: "inform", note, route: turnRoute(route, v.id), ...q };
    }
  }

  /**
   * Below the choice bar with two candidates (spec §2.4; plan Decision 14: live in stage A). One Tiny pick, then the
   * pick's route through the same handlers as a confident answer: a rule saves first (`saveThenRoute`), else the planner
   * on the pick's role. No pick (failure, timeout, an answer outside the two) is `applyCascade(plan, null)`: Default,
   * nothing saved. Every settle of this turn carries the pair for its triage event.
   */
  private async cascadeRoute(i: TriageInput, state: OmpTurnState, lang: Lang, plan: Extract<RoutePlan, { kind: "cascade" }>, settleFor: SettleFor,
    held: TriageHeld): Promise<TriageOutcome> {
    const route = applyCascade(plan, await this.cascadePick(i, plan.between, held.quote));
    const withPair: SettleFor = (r, save, handler) => ({ ...settleFor(r, save, handler), between: plan.between });
    held.answered = withPair(fallbackRoute("jev_skipped", held.thinkHarder), "none"); // a throw from here still names the pair
    if (route.save) return this.saveThenRoute(i, state, lang, route, withPair, held);
    const id = this.settleTriage(i, state, lang, withPair(route, "none"));
    return { kind: "fallthrough", route: turnRoute(route, id), ...quoteField(held.quote) };
  }

  /**
   * The cascade's one call (Decision 14): the Tiny chain under LlmCallRole "cascade", audited per leg on the turn's run,
   * bounded at CASCADE_TIMEOUT_MS and by the turn's own signal. Null on any failure, timeout or answer outside the two.
   */
  private async cascadePick(i: TriageInput, between: readonly [Category, Category], quote: QuoteRef | null): Promise<Category | null> {
    const ctl = new AbortController();
    const signal = AbortSignal.any([i.signal, ctl.signal]);
    try {
      const answer = await withinMs(CASCADE_TIMEOUT_MS, () => this.cascadeCall(i.claim.run_id, cascadePrompt(between, i.userText, quote), signal), () => ctl.abort());
      if (answer === null) console.warn(`triage: cascade gave no answer within ${CASCADE_TIMEOUT_MS} ms or failed`);
      return answer === null ? null : parseCascadePick(answer, between);
    } catch (e) {
      console.error(`triage: cascade call threw: ${safeReason(e)}`);
      return null;
    }
  }

  /** The seat call itself: the production one-shot with its chain deadline, or the test-injected adapter (its own fakes). */
  private async cascadeCall(run_id: string, p: { question: string; system: string }, signal: AbortSignal): Promise<string | null> {
    if (!this.llmAdapterIsDefault) {
      const r = await this.llmAdapter({ ...p, signal });
      return r.ok && typeof r.output.answer === "string" ? r.output.answer : null;
    }
    const seat = oneShotAdapter(this.runStore, this.ompConfig(), { run_id, role: "cascade" }, undefined, { deadlineMs: CASCADE_LEG_DEADLINE_MS });
    const r = await seat.answer({ ...p, signal });
    return r.ok ? r.answer : null;
  }
```

**Module helpers.** Add next to `loopToolTimeoutMs` (`:3623`):

```ts
/** The tree's route as the supervisor pins it (Task 8). */
function turnRoute(r: Route, verdict_id: string | null): TurnRoute {
  return { role: r.role, effort: r.effort, verdict_id };
}

function quoteField(q: QuoteRef | null): { quote?: QuoteRef } {
  return q ? { quote: q } : {};
}

/** Lane 1's rule kept: rows say `act` only when the route the tree chose ran; a memory lane that saved nothing is a fallback. */
function decisionFor(mode: JevTriageMode, r: Route, save: SaveOutcome): "act" | "fallback" | "shadow" {
  if (mode === "shadow") return "shadow";
  return ACTED.has(r.reason) && !(r.lane === "memory" && save !== "saved") ? "act" : "fallback";
}

function numbersOf(a: JevAnswer): TriageNumbers {
  return { confidence: a.type === "noul" ? null : a.confidence, top_prob: topProbOf(a), margin: marginOf(a) };
}

function scoresOf(a: Record<string, JevAnswer>): VerdictScores {
  const score = (x: JevAnswer | undefined): number | null => (x?.type === "score" ? x.score : null);
  return { breadth: score(a.breadth), reasoning: score(a.reasoning), actions: score(a.actions), sets_rule: a.sets_rule?.type === "noul" ? a.sets_rule.noul : null };
}

/** The lesson-write adapter's own reason for a cap refusal (lesson-write.ts:171); every other non-save is "not durable". */
function saveOutcomeOf(w: LessonWriteOutcome): "not_durable" | "capped" {
  return w.result.ok && w.result.output.reason === "too-large" ? "capped" : "not_durable";
}

/** The cascade's bound on the user's path (Paco, 2026-10-07; plan Decision 14): the whole pick, every leg included. */
export const CASCADE_TIMEOUT_MS = 20_000;
/**
 * The omp legs' own chain deadline, inside the bound: a slow leg times out (audited `timeout`, plus the
 * LEG_EXIT_GRACE_MS kill grace) before the race would cut it as a `shutdown` the llm_leg_failing sweep ignores.
 */
const CASCADE_LEG_DEADLINE_MS = CASCADE_TIMEOUT_MS - 2_000;

/** The cascade's prompt (spec §2.4): the two category names with their criteria, and the message (its quote line first). */
function cascadePrompt(between: readonly [Category, Category], userText: string, quote: QuoteRef | null): { question: string; system: string } {
  const rows = between.map((c) => `- ${c}: ${TREE_CATEGORY.criteria.find(([k]) => k === c)?.[1] ?? ""}`);
  return {
    system: `You sort one message sent to a personal assistant. Reply with exactly one of these two words and nothing else: ${between.join(", ")}.`,
    question: ["Categories:", ...rows, "", "Message:", `${quote?.line ?? ""}${userText}`].join("\n")
  };
}

/** Exact token: one of the two names after stripping quotes, backticks, asterisks and a final full stop; else no pick. */
export function parseCascadePick(answer: string, between: readonly [Category, Category]): Category | null {
  const token = answer.trim().replace(/^["'`*]+|["'`*.。]+$/g, "").toLowerCase();
  return between.find((c) => c === token) ?? null;
}

/** `run()` raced against `ms`: null on expiry, after `onExpire` (which aborts the call). The timer is armed before `run` starts. */
function withinMs<T>(ms: number, run: () => Promise<T>, onExpire: () => void): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>((resolve) => { timer = setTimeout(() => { onExpire(); resolve(null); }, ms); });
  return Promise.race([run(), expired]).finally(() => clearTimeout(timer));
}
```

**Orphans removed in `core-worker.ts`:**
- The imports of `buildTriageState`, `TRIAGE_QUESTIONS` (`../jev/questions/triage.js`), `resolveTriageBars`,
  `THRESHOLD_VERSION`, `triageVerdict` and `type TriageDecision` (`../jev/thresholds.js`), done by the import
  replacement above.
- `verdictLabel` and the lane 1 `TriageNumbers`, done by the type replacement.
- `runTriageLane`, done by the block replacement.
- Nothing of lane 1 is reused for the cascade: `cascadeRoute`, `cascadePick`, `cascadeCall`, `cascadePrompt`,
  `parseCascadePick`, `withinMs` and the two `CASCADE_*` constants are new (Decision 14).

Then confirm nothing else in `src/` still names them:

Run: `grep -rn "runTriageLane\|verdictLabel\|from \"../jev/thresholds.js\"\|from \"../jev/questions/triage.js\"" src/core`
Expected: no output.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/core/core-worker-triage.test.ts tests/run/run-ledger.test.ts tests/run/invariant-sweep-jev.test.ts tests/jev/thresholds.test.ts tests/jev/triage-parity.test.ts tests/gateway/memlane-commands.test.ts tests/gateway/rating-capture.test.ts tests/llm/seat-routing.test.ts tests/llm/providers/omp.test.ts`
Expected: PASS, none skipped (`omp.test.ts` unchanged: a call without `deadlineAt` keeps today's per-leg timeout).

Run: `npm run typecheck && npm test && npm run build`
Expected: all green. The full suite matters here because every omp-path test (`tests/omp/*`,
`tests/core/core-worker-omp-*`) now passes through a verdict-writing `triageTurn` on the flag-off path. A failure
there means `TriageOutcome`'s new `route` field broke a supervisor consumer, and that consumer is Task 8's to fix,
not this task's.

- [ ] **Step 5: Commit**

```bash
git add src/core/core-worker.ts src/jev/decide.ts src/jev/calibration.ts src/run/invariant-sweep.ts src/run/run-ledger.ts \
  src/run/run-store.ts src/llm/registry.ts src/llm/providers/omp.ts \
  src/gateway/memlane-commands.ts src/gateway/gateway.ts tests/core/core-worker-triage.test.ts tests/run/run-ledger.test.ts \
  tests/run/invariant-sweep-jev.test.ts tests/jev/thresholds.test.ts tests/jev/triage-parity.test.ts tests/gateway/memlane-commands.test.ts \
  tests/gateway/rating-capture.test.ts tests/llm/seat-routing.test.ts
git commit -m "feat(core): the Jev decision tree at the turn's front — routes, quote anchor, verdicts, corrections

triageTurn asks the six tree questions, routes through tree-policy, re-attaches
the memory and status lanes, carries the quoted turn into the state and the
lesson write, and writes one jev_verdicts row per turn with its decision rows
and triage event. Below the choice bar one Tiny-role one-shot (LlmCallRole
cascade, bounded at 20 s, chain deadline on the omp legs) picks between Jev's
top two; a failure takes the Default planner and saves nothing. Every
run terminal closes a pending verdict. Corrections (ask anyway, think harder,
escalation, low rating) land on the verdict. Lane 1's calibration rows are
emptied (Decision 6).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

---

### Task 11: `/models`, the daily roles tick (change notice + `role_unresolved`), the `lane_fallthrough_rate` sweep invariant

**Assembly overrides (Rev 2; binding — folded into the text and code below):**
- The resolver comes from Task 7's accessor `worker.modelRoles()` (field `this.roles`). This task adds **no**
  `CoreWorker` accessor and does not touch `src/core/core-worker.ts`.
- **No ledger event type is added here.** Task 9 owns `model_roles_resolved` `["resolved_at","catalog_ok","roles"]`
  (written by this task's tick), and `model_role_override` / `model_catalog_unavailable` / `model_roles_fallback`
  (written by Task 7). This task does not touch `src/run/run-ledger.ts`.
- **Catalog outage retry and its incident are not this task's (review fix F14; assumed owner Task 7, Stream A).** The
  resolver's `refreshCatalog()` retries a failed read hourly and opens / resolves the `model_catalog_unavailable`
  incident; the tick stays a 24 h latch that calls `refreshCatalog()` once and records `catalog_ok`. Rev 1's "a failed
  tick read is not retried for 24 h" (Q10) is superseded. If Stream A placed F14 in this task instead, the orchestrator
  moves it here as one helper in `model-roles-tick.ts`; nothing below depends on where it lives.
- **`role_unresolved` under F7 (Stream A):** in resolved mode a role that resolves empty falls back to its static list
  for `candidates()` / `chains()`, but `resolveAll()` still reports the resolution itself (`head: null`, `candidates:
  []`). The tick reads `resolveAll()`, so it opens `role_unresolved` exactly as below. If Task 7's `resolveAll()` were
  to report the fallback instead, the tick test "a role with no candidate opens role_unresolved" goes red and Task 7 is
  what changes.

**Contract deviations:**
1. **`roles` parameter types are narrowed to what each function reads.** `handleModels(store, roles, event)` takes
   `roles: Pick<RoleResolver, "resolveAll" | "catalog">` (exported as `ModelsRoles`) and `runModelRolesTick` takes
   `roles: Pick<RoleResolver, "refreshCatalog" | "resolveAll">`. A `RoleResolver` satisfies both, so every contract
   caller compiles unchanged; the narrowing lets the gateway tests use a two-method stub instead of a live catalog.
2. **The Gateway reaches the resolver through `worker.modelRoles()`** (Task 7). The daemon and the one-shot poll runner
   construct the `Gateway` **after** the worker so they can pass it. `src/cli.ts:60` and the eval runner keep a
   resolver-less `Gateway`: `/models` there replies "not available here" (a handled denial).
3. **`model_roles_resolved` carries `resolved_at` and `catalog_ok`** besides `roles` (Task 9's required list):
   `createLedgerEvent` stamps `occurred_at` from the real clock, so the 24 h latch reads `resolved_at` (the tick's
   injected `now`), and `catalog_ok` keeps a catalog outage from becoming the diff baseline.
4. **Judge seats are 0-based**, the same index as `ResolveInput.seat` and `ROLE_LISTS.judges`, so `/models set judges 1 …`
   writes key `judges:1`, the key `resolveAll()` lists for that seat.

**Files:**
- Modify: `src/domain/types.ts:4` (`TaskEventType` gains `"models"`)
- Modify: `tests/domain/types.test.ts:29-32` (the type-equality guard lists `"models"`)
- Modify: `src/triggers/telegram-command-parser.ts:3-25` (union), `:66-67` (dispatch branch), `:197-209` (new `parseModels` after `parseForgetMemory`)
- Modify: `src/triggers/telegram-trigger-adapter.ts:448-453` (`buildTelegramEvent` case)
- Create: `src/gateway/models-commands.ts`
- Modify: `src/gateway/gateway.ts:47-48` (imports), `:71-72` (`GatewayIntakeResult`), `:128-135` (constructor options), `:236-238` (dispatch), `:1486-1487` (`HELP_TEXT`)
- Modify: `src/telegram/telegram-poll-runner.ts:44-59` (`HANDLED_INTAKE_DENIAL_CODES`), `:127-149` (gateway after worker)
- Create: `src/omp/model-roles-tick.ts`
- Modify: `src/run/run-store.ts:4852-4856` (four readers/writers after `hasAnsweredJevCallSince`)
- Modify: `src/telegram/telegram-daemon.ts:1-41` (imports), `:151-181` (gateway after worker), `:511-524` (`runModelTicks`, as Task 7 left it), new `runRolesTick` helper after it
- Modify: `src/run/invariant-sweep.ts:85-91` (`SWEEP_INCIDENT_KINDS`), `:209-232` (new check beside `checkJevSkipRate`), `:235-243` (`detectViolations`)
- Test: `tests/gateway/models-commands.test.ts` (new), `tests/omp/model-roles-tick.test.ts` (new),
  `tests/run/invariant-sweep-lanes.test.ts` (new), `tests/telegram/telegram-daemon-model-roles.test.ts` (new)

**Interfaces:**
- Consumes: `RoleName`, `ROLE_NAMES`, `ROLE_LISTS`, `ALLOWED_PROVIDERS`, `CatalogModel`, `matchOverride`, `selectorKey`,
  `resolveModelRolesMode` (Task 6, `src/omp/model-roles.ts`); `RoleResolver`, `ResolvedRole`, `OverrideKey` (Task 7,
  `src/omp/role-resolver.ts`); `CoreWorker.modelRoles()` (Task 7); `store.latestModelRoleOverrides()`,
  `store.recordModelRoleOverride()` (Task 7); the `model_roles_resolved` event type (Task 9);
  `jev_verdicts` table, `store.insertJevVerdict()`, `store.updateJevVerdict()` (Task 9); `oncePerTrigger`, `replyTo`
  (`src/gateway/memory-commands.ts:19,31`); `openAlertedIncident`, `resolveOpenIncidents`
  (`src/run/incident-alert.ts:29,99`); `escapeForTelegram` (`src/capabilities/text-hygiene.ts:26`);
  `parseModelString` (`src/omp/model-string.ts:9`); `stableHash` (`src/domain/canonical.ts:33`).
- Produces (contract names exact):
  ```ts
  // src/triggers/telegram-command-parser.ts — TelegramCommand gains
  | { type: "models"; action: "list" }
  | { type: "models"; action: "set"; role: RoleName; seat?: number; pattern: string }
  | { type: "models"; action: "reset"; role: RoleName; seat?: number }
  // src/gateway/models-commands.ts
  export type ModelsRoles = Pick<RoleResolver, "resolveAll" | "catalog">;
  export const MODELS_REFUSED = "MODELS_REFUSED";
  export type ModelsRefusal = "role_judges" | "no_seat" | "catalog_unavailable" | "no_match" | "outside_allow_list" | "static_mode"
    | "bad_command" | "unavailable";
  export function modelsRefusalText(r: ModelsRefusal): string;
  export function handleModels(store: RunStore, roles: ModelsRoles, event: TypedTaskEvent): GatewayIntakeResult;
  export function modelsUnavailable(store: RunStore, event: TypedTaskEvent): GatewayIntakeResult;
  export function modelsListText(store: RunStore, roles: ModelsRoles): string;
  // src/omp/model-roles-tick.ts
  export const MODEL_ROLES_TICK_INTERVAL_MS: number; // 24 h
  export function runModelRolesTick(i: { store: RunStore; roles: Pick<RoleResolver, "refreshCatalog" | "resolveAll">; now: string;
    signal?: AbortSignal; notify: (text: string) => void }): Promise<{ ran: boolean; changed: string[]; unresolved: string[] }>;
  export function changeLine(key: string, from: string | null, to: string | null): string;
  // src/run/run-store.ts
  export interface ModelRolesResolvedRow { resolved_at: string; catalog_ok: boolean;
    roles: Array<{ key: string; head: string | null; candidates: string[]; source: "list" | "override" }> }
  recordModelRolesResolved(r: ModelRolesResolvedRow): void;
  latestModelRolesResolved(o?: { catalogOk?: boolean }): ModelRolesResolvedRow | undefined;
  countLaneTurns(since: string, until: string): Array<{ lane: string; turns: number; fallthroughs: number }>;
  hasLaneReplySince(lane: string, since: string): boolean;
  // src/run/invariant-sweep.ts
  export const LANE_FALLTHROUGH_WINDOW_MS: number; export const LANE_FALLTHROUGH_MIN_TURNS = 3; export const LANE_FALLTHROUGH_MAX = 0.5;
  export function checkLaneFallthrough(store: RunStore, now: string, windowMs?: number):
    Array<{ lane: string; open: boolean; turns: number; fallthroughs: number }>;
  // ledger: "model_roles_resolved" {resolved_at, catalog_ok, roles}; incident "role_unresolved" (subject = override key, opened
  // and resolved by the tick only — NOT a sweep kind, or the sweep would resolve it as "not seen"); sweep kind "lane_fallthrough_rate".
  ```

- [ ] **Step 1: Write the failing tests — `/models` parser, adapter, gateway, handler**

Create `tests/gateway/models-commands.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TypedTaskEvent } from "../../src/domain/types.js";
import { Gateway, HELP_TEXT } from "../../src/gateway/gateway.js";
import { MODELS_REFUSED, modelsRefusalText, type ModelsRefusal, type ModelsRoles } from "../../src/gateway/models-commands.js";
import { ALLOWED_PROVIDERS, ROLE_LISTS, type CatalogModel } from "../../src/omp/model-roles.js";
import type { ResolvedRole } from "../../src/omp/role-resolver.js";
import { RunStore } from "../../src/run/run-store.js";
import { isHandledIntakeDenial } from "../../src/telegram/telegram-poll-runner.js";
import { parseTelegramCommand } from "../../src/triggers/telegram-command-parser.js";
import { normalizeTelegramUpdate } from "../../src/triggers/telegram-trigger-adapter.js";
import { drainOutbox } from "../helpers/omp-worker.js";

// Spec §4.2: /models is Paco's only lever over which model answers, with no restart and no settings table. Each override is
// an append-only ledger row validated against the filtered catalog at set time: a pattern that would match a metered `google/`
// twin, a Codex model on a chat seat, or nothing at all must be refused with its reason, never saved silently, and a
// role-level judges override must be refused so the council seats never collapse onto one model.
const ALLOWLIST = {
  users: [{ telegram_user_id: 111, identity_id: "paco" }],
  chats: [{ telegram_chat_id: 222, label: "private", allowed_identity_ids: ["paco"] }]
};
let store: RunStore;
let n = 0;
beforeEach(() => { store = RunStore.openInMemory(); vi.stubEnv("HOUGE_MODEL_ROLES", "resolved"); });
afterEach(() => { store.close(); vi.unstubAllEnvs(); });

function command(text: string, from = 111): TypedTaskEvent {
  n += 1;
  const r = normalizeTelegramUpdate({ update_id: n, message: { message_id: n, text, from: { id: from }, chat: { id: 222 } } }, ALLOWLIST);
  if (!r.ok) throw new Error(`expected an event: ${r.error.code}`);
  return r.event as TypedTaskEvent;
}
const replies = () => [...drainOutbox(store).values()].map((p) => String(p.text));

// A catalog with the cases that matter: an allowed Anthropic model, the metered `google/` twin of an Antigravity id, a Codex
// model (allowed on reader/council seats, never on a chat seat) and an allowed Antigravity model.
const CATALOG: CatalogModel[] = [
  { provider: "anthropic", id: "claude-opus-5-5", thinking: ["low", "medium", "high"] },
  { provider: "google", id: "gemini-3.8-flash", thinking: null },
  { provider: "openai-codex", id: "gpt-6.1-sol", thinking: ["low", "medium", "high"] },
  { provider: "google-antigravity", id: "gemini-3.1-pro", thinking: ["low", "high"] }
];
const RESOLVED: ResolvedRole[] = [
  { key: "default", head: "anthropic/claude-opus-5-5:medium", candidates: ["anthropic/claude-opus-5-5:medium", "kimi-code/k3:low"], source: "list" },
  { key: "thinking", head: "anthropic/claude-opus-5-5:high", candidates: ["anthropic/claude-opus-5-5:high"], source: "override" },
  { key: "vision", head: null, candidates: [], source: "list" },
  { key: "judges:1", head: "openai-codex/gpt-6.1-sol", candidates: ["openai-codex/gpt-6.1-sol"], source: "list" }
];
const stub = (catalog: CatalogModel[] | null = CATALOG, resolved: ResolvedRole[] = RESOLVED): ModelsRoles =>
  ({ catalog: () => catalog, resolveAll: () => resolved });
const gateway = (roles: ModelsRoles = stub()) => new Gateway(store, undefined, undefined, undefined, undefined, { roles });
// The CLI's shape: no resolver at all (an explicit `undefined` argument would take the default above, hence a separate helper).
const bareGateway = () => new Gateway(store);
const overrides = () => store.getLedgerEvents().filter((e) => e.event_type === "model_role_override");

describe("parsing", () => {
  it("bare lists; set takes a role and one pattern; judges take a 0-based seat; reset takes a role and an optional seat", () => {
    expect(parseTelegramCommand("/models")).toEqual({ ok: true, command: { type: "models", action: "list" } });
    expect(parseTelegramCommand("/models set thinking opus")).toEqual({ ok: true, command: { type: "models", action: "set", role: "thinking", pattern: "opus" } });
    expect(parseTelegramCommand("/models set judges 1 gemini-3.1-pro"))
      .toEqual({ ok: true, command: { type: "models", action: "set", role: "judges", seat: 1, pattern: "gemini-3.1-pro" } });
    // A role-level judges set parses (so the handler can refuse it WITH the reason) rather than reading as a typo.
    expect(parseTelegramCommand("/models set judges opus")).toEqual({ ok: true, command: { type: "models", action: "set", role: "judges", pattern: "opus" } });
    expect(parseTelegramCommand("/models reset default")).toEqual({ ok: true, command: { type: "models", action: "reset", role: "default" } });
    expect(parseTelegramCommand("/models reset judges")).toEqual({ ok: true, command: { type: "models", action: "reset", role: "judges" } });
    expect(parseTelegramCommand("/models reset judges 2")).toEqual({ ok: true, command: { type: "models", action: "reset", role: "judges", seat: 2 } });
  });

  it("refuses unknown verbs, unknown roles (the retired `planner` chain name), missing or extra words, and a seat on a non-judge role", () => {
    for (const bad of ["/models frobnicate", "/models set", "/models set planner opus", "/models set default", "/models set default a b",
      "/models reset default 1", "/models set default 1 opus", `/models set default ${"x".repeat(65)}`]) {
      expect(parseTelegramCommand(bad).ok, bad).toBe(false);
    }
  });

  it("the adapter carries action in `program` and role/seat/pattern in metadata; a stranger's /models never becomes an event", () => {
    const e = command("/models set judges 1 gemini-3.1-pro");
    expect(e).toMatchObject({ type: "models", program: "set", metadata: { role: "judges", seat: 1, pattern: "gemini-3.1-pro" } });
    expect(command("/models")).toMatchObject({ type: "models", program: "list" });
    expect(normalizeTelegramUpdate({ update_id: 9000, message: { message_id: 1, text: "/models", from: { id: 999 }, chat: { id: 222 } } }, ALLOWLIST).ok).toBe(false);
  });
});

describe("/models list", () => {
  it("shows role → head, effort, list or override (with its pattern), and the candidates; a role with no candidate says so", () => {
    store.recordModelRoleOverride({ key: "thinking", pattern: "opus", actor: "paco" });
    expect(gateway().intake(command("/models"))).toMatchObject({ ok: true, status: "models_returned" });
    const text = replies()[0]!;
    expect(text).toContain("catalog: 4 models");
    expect(text).toContain("**default** → `anthropic/claude-opus-5-5:medium` · effort medium · list");
    expect(text).toContain("candidates: `anthropic/claude-opus-5-5:medium`, `kimi-code/k3:low`");
    expect(text).toContain("**thinking** → `anthropic/claude-opus-5-5:high` · effort high · override `opus`");
    expect(text).toContain("**vision** → (no candidate)");
    expect(text).toContain("**judges:1** → `openai-codex/gpt-6.1-sol`");
  });

  it("says when the catalog is unavailable or the switch is static, because then the lists run as written", () => {
    gateway(stub(null)).intake(command("/models"));
    expect(replies()[0]).toContain("catalog unavailable");
    vi.stubEnv("HOUGE_MODEL_ROLES", "static");
    gateway().intake(command("/models"));
    expect(replies()[0]).toContain("static");
  });
});

describe("/models set", () => {
  it("saves a pattern that matches an allowed model for the role, as one model_role_override row keyed by the role", () => {
    expect(gateway().intake(command("/models set thinking opus"))).toMatchObject({ ok: true, status: "models_returned" });
    expect(store.latestModelRoleOverrides().get("thinking")).toBe("opus");
    expect(overrides().map((e) => e.payload)).toEqual([{ key: "thinking", pattern: "opus", actor: "paco" }]);
    expect(replies()[0]).toContain("thinking → override `opus`");
  });

  it("a judge seat is its own key; Codex is allowed on reader and council seats", () => {
    gateway().intake(command("/models set judges 1 gemini-3.1-pro"));
    gateway().intake(command("/models set reader gpt-6.1"));
    expect(store.latestModelRoleOverrides().get("judges:1")).toBe("gemini-3.1-pro");
    expect(store.latestModelRoleOverrides().get("reader")).toBe("gpt-6.1");
  });

  const refusals: Array<[string, ModelsRoles, ModelsRefusal]> = [
    // the only match is the metered google/ twin: the allow-list runs before matching
    ["/models set fast gemini-3.8-flash", stub(), "outside_allow_list"],
    // the only match is Codex, and no chat turn is ever routed to Codex
    ["/models set default gpt-6.1", stub(), "outside_allow_list"],
    ["/models set default nonexistent-model", stub(), "no_match"],
    ["/models set judges opus", stub(), "role_judges"],
    [`/models set judges ${ROLE_LISTS.judges.length} opus`, stub(), "no_seat"],
    ["/models set thinking opus", stub(null), "catalog_unavailable"]
  ];
  for (const [text, roles, reason] of refusals) {
    it(`refuses ${JSON.stringify(text)} with ${reason}, saves nothing, and is a handled denial`, () => {
      const r = gateway(roles).intake(command(text));
      if (r.ok) throw new Error("expected a refusal");
      expect(r.error.code).toBe(MODELS_REFUSED);
      expect(isHandledIntakeDenial(r.error.code)).toBe(true);
      expect(replies()).toEqual([modelsRefusalText(reason)]);
      expect(overrides()).toHaveLength(0);
    });
  }

  it("the allow-list refusal names the allowed providers, so Paco knows why", () => {
    expect(modelsRefusalText("outside_allow_list")).toContain(ALLOWED_PROVIDERS.join(", "));
  });

  it("static mode refuses: an override it would never apply must not look saved", () => {
    vi.stubEnv("HOUGE_MODEL_ROLES", "static");
    const r = gateway().intake(command("/models set thinking opus"));
    expect(r.ok).toBe(false);
    expect(replies()).toEqual([modelsRefusalText("static_mode")]);
  });

  it("a redelivered set saves once and replies once", () => {
    const e = command("/models set thinking opus");
    gateway().intake(e);
    gateway().intake(e);
    expect(overrides()).toHaveLength(1);
    expect(replies()).toHaveLength(1);
  });
});

describe("/models reset", () => {
  it("reset <role> appends an empty-pattern row, so the role goes back to its code list", () => {
    store.recordModelRoleOverride({ key: "thinking", pattern: "opus", actor: "paco" });
    gateway().intake(command("/models reset thinking"));
    expect(store.latestModelRoleOverrides().has("thinking")).toBe(false);
    expect(replies()[0]).toContain("thinking");
  });

  it("reset with no override changes nothing and says so (no ledger row)", () => {
    gateway().intake(command("/models reset default"));
    expect(overrides()).toHaveLength(0);
    expect(replies()).toEqual(["No override on default; nothing changed."]);
  });

  it("reset judges clears every judge seat; reset judges <n> clears that seat only", () => {
    store.recordModelRoleOverride({ key: "judges:0", pattern: "opus", actor: "paco" });
    store.recordModelRoleOverride({ key: "judges:2", pattern: "gemini-3.1-pro", actor: "paco" });
    gateway().intake(command("/models reset judges 2"));
    expect([...store.latestModelRoleOverrides().keys()]).toEqual(["judges:0"]);
    store.recordModelRoleOverride({ key: "judges:2", pattern: "gemini-3.1-pro", actor: "paco" });
    gateway().intake(command("/models reset judges"));
    expect([...store.latestModelRoleOverrides().keys()]).toEqual([]);
  });
});

describe("gating and help", () => {
  it("a gateway without a resolver (the CLI) replies 'not available here' as a handled denial", () => {
    const r = bareGateway().intake(command("/models"));
    if (r.ok) throw new Error("expected a refusal");
    expect(isHandledIntakeDenial(r.error.code)).toBe(true);
    expect(replies()).toEqual([modelsRefusalText("unavailable")]);
  });

  it("/help lists /models", () => {
    expect(HELP_TEXT).toContain("/models");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/gateway/models-commands.test.ts`
Expected: FAIL — `Cannot find module '../../src/gateway/models-commands.js'`.

- [ ] **Step 3: Implement the event type, parser and adapter mapping**

`src/domain/types.ts:4` — append `"models"` to the union (end of the line, after `"memlane_ask"`):

```ts
export type TaskEventType = "ask" | "run" | "turn" | "approve" | "deny" | "status" | "usage" | "help" | "unknown_command" | "lessons" | "forget" | "skills" | "schedule_admin" | "kill" | "disarm" | "rearm" | "radar" | "idea" | "approvals" | "memory_undo" | "memories" | "forget_memory" | "memlane_undo" | "memlane_ask" | "models";
```

`tests/domain/types.test.ts:29-32` — the same edit inside `TaskEventTypeMatchesPlan` (the second line becomes
`... | "memlane_undo" | "memlane_ask" | "models"`).

`src/triggers/telegram-command-parser.ts` — import (line 1 becomes two lines):

```ts
import type { TaskEventType } from "../domain/types.js";
import { ROLE_NAMES, type RoleName } from "../omp/model-roles.js";
```

Union (replace line 25 `  | { type: "forget_memory"; id: number };`):

```ts
  | { type: "forget_memory"; id: number }
  | { type: "models"; action: "list" }
  | { type: "models"; action: "set"; role: RoleName; seat?: number; pattern: string }
  | { type: "models"; action: "reset"; role: RoleName; seat?: number };
```

Dispatch (after line 67 `if (command === "/forget_memory" || command === "/forget-memory") return parseForgetMemory(rest);`):

```ts
  // Model roles (spec §4.2): list, set one role's (or one judge seat's) override pattern, reset. Gated by the allowlist upstream.
  if (command === "/models") return parseModels(rest);
```

New function after `parseForgetMemory` (after line 202):

```ts
const MODELS_USAGE = "/models usage: /models · /models set <role> <pattern> · /models set judges <n> <pattern> · /models reset <role> [n]";
const MODELS_PATTERN_MAX = 64;

/**
 * `/models` (spec §4.2). The role must be one of ROLE_NAMES; only judges take a seat (0-based, the ROLE_LISTS.judges index). A
 * role-level `set judges <pattern>` parses so the handler can refuse it with its reason. The parser never echoes the words back.
 */
function parseModels(words: string[]): TelegramCommandParseResult {
  if (words.length === 0) return { ok: true, command: { type: "models", action: "list" } };
  const [verb, roleWord, ...rest] = words;
  if ((verb !== "set" && verb !== "reset") || !roleWord) return invalid(MODELS_USAGE);
  const role = ROLE_NAMES.find((r) => r === roleWord.toLowerCase());
  if (!role) return invalid(`/models: unknown role; roles are ${ROLE_NAMES.join(", ")}`);
  const seated = role === "judges" && /^[0-9]{1,2}$/.test(rest[0] ?? "") && (verb === "reset" || rest.length === 2);
  const seat = seated ? Number(rest[0]) : undefined;
  const args = seated ? rest.slice(1) : rest;
  const at = seat !== undefined ? { seat } : {};
  if (verb === "reset") return args.length === 0 ? { ok: true, command: { type: "models", action: "reset", role, ...at } } : invalid(MODELS_USAGE);
  const [pattern] = args;
  if (args.length !== 1 || !pattern) return invalid(MODELS_USAGE);
  if (pattern.length > MODELS_PATTERN_MAX) return invalid(`/models set: a pattern is at most ${MODELS_PATTERN_MAX} characters`);
  return { ok: true, command: { type: "models", action: "set", role, ...at, pattern } };
}
```

`src/triggers/telegram-trigger-adapter.ts` — replace lines 451-452 (the `forget_memory` case) with:

```ts
    case "forget_memory":
      return buildTypedTaskEvent({ ...base, type: "forget_memory", program: String(command.id) });
    case "models":
      // action rides `program` (the /schedule precedent); role, seat and pattern ride metadata.
      return buildTypedTaskEvent({ ...base, type: "models", program: command.action, ...(command.action === "list" ? {} : {
        metadata: { ...base.metadata, role: command.role, ...(command.seat !== undefined ? { seat: command.seat } : {}),
          ...(command.action === "set" ? { pattern: command.pattern } : {}) }
      }) });
```

- [ ] **Step 4: Create `src/gateway/models-commands.ts`**

```ts
import { escapeForTelegram } from "../capabilities/text-hygiene.js";
import type { TypedTaskEvent } from "../domain/types.js";
import { ALLOWED_PROVIDERS, matchOverride, resolveModelRolesMode, ROLE_LISTS, ROLE_NAMES, selectorKey, type CatalogModel, type RoleName }
  from "../omp/model-roles.js";
import { parseModelString } from "../omp/model-string.js";
import type { OverrideKey, ResolvedRole, RoleResolver } from "../omp/role-resolver.js";
import type { RunStore } from "../run/run-store.js";
import type { GatewayIntakeResult } from "./gateway.js";
import { oncePerTrigger, replyTo } from "./memory-commands.js";

/**
 * `/models` (spec §4.2): Paco's override over the code-owned role lists. A control command (no run, no budget), idempotent on
 * the trigger key, every reply code-owned; the only stored text echoed is Paco's own pattern, rendered markdown-inert.
 * Overrides are append-only `model_role_override` rows read at each resolution (Task 7), so no restart.
 */

export type ModelsRoles = Pick<RoleResolver, "resolveAll" | "catalog">;
export const MODELS_REFUSED = "MODELS_REFUSED";
export type ModelsRefusal = "role_judges" | "no_seat" | "catalog_unavailable" | "no_match" | "outside_allow_list" | "static_mode"
  | "bad_command" | "unavailable";

const REFUSAL_TEXT: Readonly<Record<Exclude<ModelsRefusal, "outside_allow_list">, string>> = {
  role_judges: "Not saved: judges are overridden one seat at a time (/models set judges <n> <pattern>), so the seats never collapse onto one model.",
  no_seat: "Not saved: there is no such judge seat. /models lists the seats.",
  catalog_unavailable: "Not saved: omp's model catalog is unavailable right now, so the pattern cannot be checked. Try again after the next catalog read.",
  no_match: "Not saved: the pattern matches no catalogued model.",
  static_mode: "Not saved: HOUGE_MODEL_ROLES=static runs the code lists as written and applies no override.",
  bad_command: "That /models command was not understood. /help lists the forms.",
  unavailable: "Model roles are not available in this process."
};

export function modelsRefusalText(r: ModelsRefusal): string {
  if (r !== "outside_allow_list") return REFUSAL_TEXT[r];
  return `Not saved: the pattern matches only models outside this role's providers (allowed: ${ALLOWED_PROVIDERS.join(", ")}; chat roles never use openai-codex).`;
}

const ok = (): GatewayIntakeResult => ({ ok: true, status: "models_returned", run_id: "" });

function refuse(store: RunStore, event: TypedTaskEvent, r: ModelsRefusal): GatewayIntakeResult {
  replyTo(store, event, "models_refused", modelsRefusalText(r));
  return { ok: false, error: { code: MODELS_REFUSED, message: `/models refused: ${r}` } };
}

/** A gateway built without a resolver (the CLI, the eval runner): the command is understood and declined. */
export function modelsUnavailable(store: RunStore, event: TypedTaskEvent): GatewayIntakeResult {
  return oncePerTrigger(store, event, () => refuse(store, event, "unavailable"));
}

export function handleModels(store: RunStore, roles: ModelsRoles, event: TypedTaskEvent): GatewayIntakeResult {
  return oncePerTrigger(store, event, () => {
    const action = event.program ?? "list";
    if (action === "list") {
      replyTo(store, event, "models", modelsListText(store, roles));
      return ok();
    }
    const t = targetOf(event);
    if (!t) return refuse(store, event, "bad_command");
    if (action === "set") return setOverride(store, roles, event, t);
    return action === "reset" ? resetOverride(store, event, t) : refuse(store, event, "bad_command");
  });
}

interface Target { role: RoleName; seat: number | undefined; pattern: string }

/** Re-validates what the adapter put on the event (the event is the trust boundary into the gateway). */
function targetOf(event: TypedTaskEvent): Target | null {
  const m = event.metadata ?? {};
  const role = ROLE_NAMES.find((r) => r === m.role);
  if (!role) return null;
  const rawSeat = m.seat;
  if (rawSeat !== undefined && (typeof rawSeat !== "number" || !Number.isSafeInteger(rawSeat) || rawSeat < 0 || role !== "judges")) return null;
  return { role, seat: rawSeat, pattern: typeof m.pattern === "string" ? m.pattern.trim() : "" };
}

const keyOf = (t: Pick<Target, "role" | "seat">): OverrideKey => (t.seat !== undefined ? `judges:${t.seat}` : t.role);

/** Spec §4.2 refusal order: static switch, seat shape, catalog, then the filtered match (the allow-list runs before matching). */
function setRefusal(roles: ModelsRoles, t: Target): ModelsRefusal | null {
  if (!t.pattern) return "bad_command";
  if (resolveModelRolesMode(process.env) === "static") return "static_mode";
  if (t.role === "judges" && t.seat === undefined) return "role_judges";
  if (t.seat !== undefined && t.seat >= ROLE_LISTS.judges.length) return "no_seat";
  const catalog = roles.catalog();
  if (!catalog) return "catalog_unavailable";
  if (matchOverride(t.pattern, t.role, catalog).length > 0) return null;
  return matchesUnfiltered(t.pattern, catalog) ? "outside_allow_list" : "no_match";
}

/** Only for the refusal's reason: does the pattern hit anything in the raw catalog (a filtered-out provider or seat)? */
function matchesUnfiltered(pattern: string, catalog: readonly CatalogModel[]): boolean {
  const p = pattern.toLowerCase();
  return catalog.some((m) => selectorKey({ provider: m.provider, model: m.id }).toLowerCase().includes(p));
}

function setOverride(store: RunStore, roles: ModelsRoles, event: TypedTaskEvent, t: Target): GatewayIntakeResult {
  const refusal = setRefusal(roles, t);
  if (refusal) return refuse(store, event, refusal);
  const key = keyOf(t);
  store.recordModelRoleOverride({ key, pattern: t.pattern, actor: event.requested_by.id });
  const head = roles.resolveAll().find((r) => r.key === key)?.head ?? null;
  replyTo(store, event, "models_set", `✅ ${key} → override \`${escapeForTelegram(t.pattern)}\`; now resolves to ${modelCode(head)}.`);
  return ok();
}

/** `reset judges` (no seat) clears every seat that holds an override; any other reset clears one key. No override → no row. */
function resetOverride(store: RunStore, event: TypedTaskEvent, t: Target): GatewayIntakeResult {
  const active = store.latestModelRoleOverrides();
  const keys = t.role === "judges" && t.seat === undefined
    ? [...active.keys()].filter((k) => k.startsWith("judges:"))
    : [keyOf(t)].filter((k) => active.has(k));
  if (keys.length === 0) {
    replyTo(store, event, "models_reset", `No override on ${keyOf(t)}; nothing changed.`);
    return ok();
  }
  store.inTransaction(() => { for (const key of keys) store.recordModelRoleOverride({ key, pattern: "", actor: event.requested_by.id }); });
  replyTo(store, event, "models_reset", `↩️ Reset ${keys.join(", ")}: back to the code list.`);
  return ok();
}

const MODELS_FOOTER = "· /models set <role> <pattern> · /models set judges <n> <pattern> · /models reset <role> [n]";

function modelCode(selector: string | null): string {
  return selector === null ? "(no candidate)" : `\`${escapeForTelegram(selector)}\``;
}

function effortOf(selector: string | null): string {
  if (selector === null) return "—";
  try { return parseModelString(selector).effort ?? "default"; } catch { return "—"; }
}

function headerLine(catalog: readonly CatalogModel[] | null): string {
  if (resolveModelRolesMode(process.env) === "static") return "🧭 **Model roles** · static: code lists as written, no catalog check, no override";
  return catalog ? `🧭 **Model roles** · catalog: ${catalog.length} models` : "🧭 **Model roles** · catalog unavailable: code lists as written";
}

function roleLines(r: ResolvedRole, pattern: string | undefined): string[] {
  const source = r.source === "override" ? `override \`${escapeForTelegram(pattern ?? "")}\`` : "list";
  const head = r.head === null ? `**${r.key}** → ${modelCode(null)}` : `**${r.key}** → ${modelCode(r.head)} · effort ${effortOf(r.head)} · ${source}`;
  return r.candidates.length > 0 ? [head, `  candidates: ${r.candidates.map(modelCode).join(", ")}`] : [head];
}

/** Role → head model, effort, list or override (with Paco's pattern), and the candidate list (spec §4.2). */
export function modelsListText(store: RunStore, roles: ModelsRoles): string {
  const overrides = store.latestModelRoleOverrides();
  const lines = [headerLine(roles.catalog())];
  for (const r of roles.resolveAll()) lines.push(...roleLines(r, overrides.get(r.key)));
  return [...lines, MODELS_FOOTER].join("\n");
}
```

- [ ] **Step 5: Wire the gateway and the handled denial**

`src/gateway/gateway.ts` — after line 48 (`import { handleForgetMemory, handleMemories, handleMemoryUndo } from "./memory-commands.js";`):

```ts
import { handleModels, modelsUnavailable, type ModelsRoles } from "./models-commands.js";
```

Union — after line 72 (`  | { ok: true; status: "memory_forgotten"; run_id: string }`):

```ts
  | { ok: true; status: "models_returned"; run_id: string }
```

Constructor — replace line 134 (`    private readonly options: { dataDir?: string } = {}`) with:

```ts
    private readonly options: { dataDir?: string; roles?: ModelsRoles } = {}
```

Dispatch — after lines 236-238 (the `forget_memory` branch):

```ts
    if (event.type === "models") {
      // Gated like /memories: the allowlist in the adapter, then this branch. A gateway without a resolver declines.
      const roles = this.options.roles;
      return this.accepted(event, now, roles ? handleModels(this.runStore, roles, event) : modelsUnavailable(this.runStore, event));
    }
```

`HELP_TEXT` — after line 1487 (`  "/forget_memory <id> — 忘掉一条记忆（附撤销按钮）",`):

```ts
  "/models — 模型角色（/models set <role> <pattern> · /models set judges <n> <pattern> · /models reset <role>）",
```

`src/telegram/telegram-poll-runner.ts` — import (after line 2):

```ts
import { MODELS_REFUSED } from "../gateway/models-commands.js";
```

and in `HANDLED_INTAKE_DENIAL_CODES`, after line 56 (`  MEMLANE_ASK_NOT_FOUND,`):

```ts
  // /models refusals (no match, outside the allow-list, a role-level judges set, no catalog, no resolver): replied to, never a poll failure.
  MODELS_REFUSED,
```

and move the gateway below the worker: delete line 127 and insert after line 149 (the `);` closing `new CoreWorker(`):

```ts
  const gateway = new Gateway(options.store, undefined, options.projectRoot, undefined, undefined, {
    dataDir: options.omp?.dataDir ?? options.projectRoot, roles: worker.modelRoles()
  });
```

(`worker.modelRoles()` is Task 7's accessor: one process, one resolver, one catalog cache.)

- [ ] **Step 6: Run the gateway tests**

Run: `npx vitest run tests/gateway/models-commands.test.ts tests/gateway/memory-commands.test.ts tests/gateway/gateway-telegram.test.ts tests/telegram/handled-intake-denials.test.ts && npm run typecheck`
Expected: PASS, typecheck exit 0 (the type-equality guard in `tests/domain/types.test.ts` is checked by typecheck).

- [ ] **Step 7: Write the failing tests — the tick and its store rows**

Create `tests/omp/model-roles-tick.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changeLine, runModelRolesTick } from "../../src/omp/model-roles-tick.js";
import { ROLE_LISTS, selectorKey, type CatalogModel } from "../../src/omp/model-roles.js";
import { parseModelString } from "../../src/omp/model-string.js";
import { RoleResolver, type OverrideKey, type ResolvedRole } from "../../src/omp/role-resolver.js";
import { RunStore } from "../../src/run/run-store.js";

// Spec §4.1: model resolution changes silently when a provider retires a model (Opus 4 → 5.5 happened in months). The daily
// tick turns that into one Telegram line per changed role, and a role left with no candidate into a `role_unresolved` incident
// that clears when it resolves again. It must spawn `omp models` at most once a day, never notify on a catalog outage (the
// lists then run as written, which is not a change), and never commit half a tick when the daemon stops mid-read.
let store: RunStore;
beforeEach(() => { store = RunStore.openInMemory(); vi.stubEnv("HOUGE_MODEL_ROLES", "resolved"); vi.stubEnv("HOUGE_TELEGRAM_CHAT_ID", ""); });
afterEach(() => { store.close(); vi.unstubAllEnvs(); });

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-10-07T09:00:00.000Z");
const at = (days: number, minutes = 0) => new Date(T0 + days * DAY + minutes * 60_000).toISOString();

function fakeRoles(initial: Record<string, string | null>) {
  let heads = initial; let catalogOk = true; let refreshes = 0;
  let onRefresh: () => void = () => {};
  const roles = {
    refreshCatalog: async () => { refreshes += 1; onRefresh(); return catalogOk; },
    resolveAll: (): ResolvedRole[] => Object.entries(heads).map(([key, head]) =>
      ({ key: key as OverrideKey, head, candidates: head ? [head] : [], source: "list" as const }))
  };
  return {
    roles, refreshes: () => refreshes,
    set(h: Record<string, string | null>, ok = true) { heads = h; catalogOk = ok; },
    onRefresh(f: () => void) { onRefresh = f; }
  };
}
const HEADS = { default: "anthropic/claude-opus-5-5:medium", thinking: "anthropic/claude-opus-5-5:high", vision: "google-antigravity/gemini-3.8-flash:low" };
const tick = (f: ReturnType<typeof fakeRoles>, now: string, notices: string[] = [], signal?: AbortSignal) =>
  runModelRolesTick({ store, roles: f.roles, now, notify: (t) => notices.push(t), ...(signal ? { signal } : {}) });
const resolvedRows = () => store.getLedgerEvents().filter((e) => e.event_type === "model_roles_resolved");
const unresolvedIncidents = () => store.listOpenIncidents().filter((i) => i.kind === "role_unresolved");

describe("runModelRolesTick", () => {
  it("the first run records the baseline and notifies nothing (nothing changed yet)", async () => {
    const f = fakeRoles(HEADS); const notices: string[] = [];
    expect(await tick(f, at(0), notices)).toEqual({ ran: true, changed: [], unresolved: [] });
    expect(notices).toEqual([]);
    expect(resolvedRows()).toHaveLength(1);
    expect(store.latestModelRolesResolved()).toMatchObject({ resolved_at: at(0), catalog_ok: true });
  });

  it("runs once per 24 h: inside the window it does not even read the catalog (no omp spawn per poll cycle)", async () => {
    const f = fakeRoles(HEADS);
    await tick(f, at(0));
    expect(await tick(f, at(0, 23 * 60 + 59))).toEqual({ ran: false, changed: [], unresolved: [] });
    expect(f.refreshes()).toBe(1);
    expect((await tick(f, at(1))).ran).toBe(true);
    expect(f.refreshes()).toBe(2);
  });

  it("one line per changed role, naming the new and the old head; unchanged roles stay silent", async () => {
    const f = fakeRoles(HEADS); const notices: string[] = [];
    await tick(f, at(0));
    f.set({ ...HEADS, thinking: "google-antigravity/claude-opus-5-5:high" });
    expect(await tick(f, at(1), notices)).toMatchObject({ ran: true, changed: ["thinking"] });
    expect(notices).toEqual([changeLine("thinking", HEADS.thinking, "google-antigravity/claude-opus-5-5:high")]);
    expect(notices[0]).toBe("🔁 Thinking now resolves to `google-antigravity/claude-opus-5-5:high`, was `anthropic/claude-opus-5-5:high`.");
  });

  it("a role with no candidate opens role_unresolved (subject = the role key) once, and resolving again clears it", async () => {
    const f = fakeRoles(HEADS);
    await tick(f, at(0));
    f.set({ ...HEADS, vision: null });
    expect((await tick(f, at(1))).unresolved).toEqual(["vision"]);
    expect(unresolvedIncidents().map((i) => i.subject)).toEqual(["vision"]);
    await tick(f, at(2));
    expect(unresolvedIncidents()).toHaveLength(1); // still unresolved: still one incident, not a second
    f.set(HEADS);
    expect((await tick(f, at(3))).unresolved).toEqual([]);
    expect(unresolvedIncidents()).toHaveLength(0);
  });

  it("a catalog outage advances the latch but notifies nothing and touches no incident; the next good read diffs against the last good one", async () => {
    const f = fakeRoles(HEADS); const notices: string[] = [];
    await tick(f, at(0));
    f.set({ ...HEADS, thinking: "kimi-code/k3:high", vision: null }, false);
    expect(await tick(f, at(1), notices)).toEqual({ ran: true, changed: [], unresolved: [] });
    expect(notices).toEqual([]);
    expect(unresolvedIncidents()).toHaveLength(0);
    expect(store.latestModelRolesResolved()).toMatchObject({ resolved_at: at(1), catalog_ok: false });
    f.set({ ...HEADS, thinking: "kimi-code/k3:high" });
    expect((await tick(f, at(2), notices)).changed).toEqual(["thinking"]);
    expect(notices).toHaveLength(1);
  });

  it("a stop during the catalog read commits nothing, so the next boot's tick runs the whole unit", async () => {
    const f = fakeRoles(HEADS); const ctl = new AbortController();
    f.onRefresh(() => ctl.abort());
    expect((await tick(f, at(0), [], ctl.signal)).ran).toBe(false);
    expect(resolvedRows()).toHaveLength(0);
  });

  it("static mode has no tick (spec §4.3): no catalog read, no row", async () => {
    vi.stubEnv("HOUGE_MODEL_ROLES", "static");
    const f = fakeRoles(HEADS);
    expect((await tick(f, at(0))).ran).toBe(false);
    expect(f.refreshes()).toBe(0);
    expect(resolvedRows()).toHaveLength(0);
  });

  it("against the real resolver: a retired Thinking head produces the Thinking notice naming the next catalogued selector", async () => {
    // Every list selector catalogued, so each head is its list's first entry; then the Thinking head's provider/id disappears.
    const all = new Map<string, CatalogModel>();
    for (const list of Object.values(ROLE_LISTS)) for (const s of list) {
      const m = parseModelString(s);
      all.set(selectorKey(m), { provider: m.provider, id: m.model, thinking: ["low", "medium", "high"] });
    }
    let catalog = [...all.values()];
    const roles = new RoleResolver({ store, env: () => ({ HOUGE_MODEL_ROLES: "resolved" }), readCatalog: async () => catalog });
    const notices: string[] = [];
    await runModelRolesTick({ store, roles, now: at(0), notify: (t) => notices.push(t) });
    const retired = selectorKey(parseModelString(ROLE_LISTS.thinking[0]!));
    catalog = catalog.filter((m) => selectorKey({ provider: m.provider, model: m.id }) !== retired);
    const r = await runModelRolesTick({ store, roles, now: at(1), notify: (t) => notices.push(t) });
    expect(r.changed).toContain("thinking");
    const line = notices.find((t) => t.startsWith("🔁 Thinking "));
    expect(line).toContain(parseModelString(ROLE_LISTS.thinking[1]!).model);
  });
});
```

- [ ] **Step 8: Run to verify it fails**

Run: `npx vitest run tests/omp/model-roles-tick.test.ts`
Expected: FAIL — `Cannot find module '../../src/omp/model-roles-tick.js'`.

- [ ] **Step 9: Implement the store rows and the tick**

(The `model_roles_resolved` ledger type and its required fields `["resolved_at","catalog_ok","roles"]` already exist:
Task 9.)

`src/run/run-store.ts` — near the other exported row types (beside `ChatTurnRow`), add:

```ts
/** One `model_roles_resolved` ledger row (spec §4.1): the daily tick's resolution of every role key. */
export interface ModelRolesResolvedRow {
  resolved_at: string;
  catalog_ok: boolean;
  roles: Array<{ key: string; head: string | null; candidates: string[]; source: "list" | "override" }>;
}
```

and after `hasAnsweredJevCallSince` (after line 4852):

```ts
  /** The daily roles tick's record (spec §4.1). Run-less, like the decay ticks. */
  recordModelRolesResolved(r: ModelRolesResolvedRow): void {
    this.appendLedgerEvent(createLedgerEvent({
      correlation_id: "model-roles", event_type: "model_roles_resolved", actor: "system", sequence: this.nextLedgerSequence(),
      payload: { resolved_at: r.resolved_at, catalog_ok: r.catalog_ok, roles: r.roles }
    }));
  }

  /** The latest tick record by its own instant; `catalogOk` keeps only reads that saw the catalog (the diff baseline). */
  latestModelRolesResolved(o: { catalogOk?: boolean } = {}): ModelRolesResolvedRow | undefined {
    const row = this.db.prepare(`
      SELECT payload_json FROM ledger_events
      WHERE event_type = 'model_roles_resolved' ${o.catalogOk ? "AND json_extract(payload_json, '$.catalog_ok') = 1" : ""}
      ORDER BY json_extract(payload_json, '$.resolved_at') DESC, sequence DESC LIMIT 1
    `).get<{ payload_json: string }>();
    if (!row) return undefined;
    const p = JSON.parse(row.payload_json) as Partial<ModelRolesResolvedRow>;
    return typeof p.resolved_at === "string" && Array.isArray(p.roles)
      ? { resolved_at: p.resolved_at, catalog_ok: p.catalog_ok === true, roles: p.roles }
      : undefined;
  }

  /**
   * `lane_fallthrough_rate` input (spec §8): per no-planner lane, the SETTLED lane turns created in (since, until] and how many
   * fell through to the planner. A pending row (the handler has not finished) is neither a success nor a fall-through.
   */
  countLaneTurns(since: string, until: string): Array<{ lane: string; turns: number; fallthroughs: number }> {
    return this.db.prepare(`
      SELECT lane, COUNT(*) AS turns,
        COALESCE(SUM(CASE WHEN handler_outcome LIKE 'fallthrough:%' THEN 1 ELSE 0 END), 0) AS fallthroughs
      FROM jev_verdicts
      WHERE lane <> 'planner' AND handler_outcome <> 'pending' AND created_at > ? AND created_at <= ?
      GROUP BY lane ORDER BY lane
    `).all<{ lane: string; turns: number; fallthroughs: number }>(since, until);
  }

  /** Whether a turn of `lane` was answered by the lane after `since` (what clears a sticky `lane_fallthrough_rate`). */
  hasLaneReplySince(lane: string, since: string): boolean {
    return this.db.prepare(`SELECT 1 AS hit FROM jev_verdicts WHERE lane = ? AND handler_outcome = 'lane_reply' AND created_at > ? LIMIT 1`)
      .get<{ hit: number }>(lane, since) !== undefined;
  }
```

Create `src/omp/model-roles-tick.ts`:

```ts
import { openAlertedIncident, resolveOpenIncidents } from "../run/incident-alert.js";
import type { ModelRolesResolvedRow, RunStore } from "../run/run-store.js";
import { resolveModelRolesMode } from "./model-roles.js";
import type { ResolvedRole, RoleResolver } from "./role-resolver.js";

/**
 * The daily model-roles tick (spec §4.1): re-read omp's catalog, resolve every role key, and tell Paco in one line per role
 * whose head moved. A role with no candidate is the `role_unresolved` incident (its turns step up meanwhile, Task 8); the
 * tick alone opens and clears it (it is not a sweep kind). A changed resolution is a notice, never an incident.
 */
export const MODEL_ROLES_TICK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const ROLE_UNRESOLVED: ReadonlySet<string> = new Set(["role_unresolved"]);

export interface ModelRolesTickInput {
  store: RunStore;
  roles: Pick<RoleResolver, "refreshCatalog" | "resolveAll">;
  now: string;
  signal?: AbortSignal;
  notify: (text: string) => void;
}
export interface ModelRolesTickResult { ran: boolean; changed: string[]; unresolved: string[] }

const IDLE: ModelRolesTickResult = { ran: false, changed: [], unresolved: [] };

export async function runModelRolesTick(i: ModelRolesTickInput): Promise<ModelRolesTickResult> {
  if (resolveModelRolesMode(process.env) === "static" || i.signal?.aborted) return { ...IDLE };
  const last = i.store.latestModelRolesResolved();
  if (last && Date.parse(i.now) - Date.parse(last.resolved_at) < MODEL_ROLES_TICK_INTERVAL_MS) return { ...IDLE };
  const catalogOk = await i.roles.refreshCatalog();
  // The only await: a stop during the read commits nothing, and the next boot's tick runs the whole unit.
  if (i.signal?.aborted) return { ...IDLE };
  const roles = i.roles.resolveAll();
  return i.store.inTransaction(() => settle(i, roles, catalogOk));
}

/** Record, notify and sync incidents in one transaction: a notice is never lost after its row, nor sent without it. */
function settle(i: ModelRolesTickInput, roles: ResolvedRole[], catalogOk: boolean): ModelRolesTickResult {
  const baseline = catalogOk ? i.store.latestModelRolesResolved({ catalogOk: true }) : undefined;
  i.store.recordModelRolesResolved({ resolved_at: i.now, catalog_ok: catalogOk, roles: roles.map(jsonSafe) });
  // A catalog outage runs the lists as written (Decision 4): that is not a change and proves nothing about a role being empty.
  if (!catalogOk) return { ran: true, changed: [], unresolved: [] };
  const changed = baseline ? changedRoles(baseline.roles, roles) : [];
  for (const c of changed) i.notify(changeLine(c.key, c.from, c.to));
  return { ran: true, changed: changed.map((c) => c.key), unresolved: syncUnresolved(i.store, roles, i.now) };
}

const jsonSafe = (r: ResolvedRole): ModelRolesResolvedRow["roles"][number] =>
  ({ key: r.key, head: r.head, candidates: [...r.candidates], source: r.source });

function changedRoles(prev: ModelRolesResolvedRow["roles"], next: ResolvedRole[]): Array<{ key: string; from: string | null; to: string | null }> {
  const before = new Map(prev.map((r) => [r.key, r.head]));
  return next.filter((r) => before.has(r.key) && before.get(r.key) !== r.head).map((r) => ({ key: r.key, from: before.get(r.key) ?? null, to: r.head }));
}

const shown = (s: string | null): string => (s === null ? "nothing" : `\`${s}\``);

/** "Thinking now resolves to X, was Y" (spec §4.1); selector ids are code-owned list or catalog strings. */
export function changeLine(key: string, from: string | null, to: string | null): string {
  return `🔁 ${key.charAt(0).toUpperCase()}${key.slice(1)} now resolves to ${shown(to)}, was ${shown(from)}.`;
}

/** Open `role_unresolved` per empty role key (alerted once while open), clear it for every key that resolves. */
function syncUnresolved(store: RunStore, roles: ResolvedRole[], now: string): string[] {
  const unresolved: string[] = [];
  for (const r of roles) {
    if (r.head === null) {
      unresolved.push(r.key);
      openAlertedIncident(store, { kind: "role_unresolved", subject: r.key, detail: { role: r.key }, now });
    } else {
      resolveOpenIncidents(store, ROLE_UNRESOLVED, r.key, now);
    }
  }
  return unresolved;
}
```

- [ ] **Step 10: Run the tick tests**

Run: `npx vitest run tests/omp/model-roles-tick.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 11: Write the failing test — the daemon wiring (gateway resolver + tick)**

A wiring bug once survived 225 green tests: this proves the daemon's gateway holds the worker's resolver (a `/models` through
the real poll loop gets the list, not "not available") and that the tick rides the signal path exactly once a day.

Create `tests/telegram/telegram-daemon-model-roles.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { modelsRefusalText } from "../../src/gateway/models-commands.js";
import { RunStore } from "../../src/run/run-store.js";
import { runTelegramDaemon } from "../../src/telegram/telegram-daemon.js";
import { pinEnabledFlags, pinOmpEnv } from "../helpers/omp-env.js";

// PINNED_ENV: no omp variable from the real .env; HOUGE_OMP_BIN is a non-executable path, so the catalog read fails (null)
// without spawning anything real, and the tick takes its catalog-unavailable branch.
pinOmpEnv();
pinEnabledFlags();

const ALLOWLIST = {
  users: [{ telegram_user_id: 111, identity_id: "paco" }],
  chats: [{ telegram_chat_id: 222, label: "private", allowed_identity_ids: ["paco"] }]
};
let dirs: string[] = [];
beforeEach(() => { vi.stubEnv("HOUGE_MODEL_ROLES", "resolved"); });
afterEach(() => { vi.unstubAllEnvs(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

async function cycle(store: RunStore, updates: unknown[] = []): Promise<string[]> {
  const root = mkdtempSync(join(tmpdir(), "houge-daemon-roles-")); dirs.push(root);
  const controller = new AbortController(); const sent: string[] = []; let calls = 0;
  await runTelegramDaemon({
    store, projectRoot: root, allowlist: ALLOWLIST, stopSignal: controller.signal, longPollTimeoutSeconds: 0,
    llmAdapter: async (input) => ({ ok: true as const, output: { question: input.question, answer: "A", model: "fake" } }),
    telegramClient: {
      getUpdates: async () => { calls += 1; if (calls === 1) return updates as never[]; controller.abort(); return []; },
      sendMessage: async ({ text }) => { sent.push(text); return { message_id: sent.length }; }
    }
  });
  return sent;
}
const rows = (store: RunStore) => store.getLedgerEvents().filter((e) => e.event_type === "model_roles_resolved");

describe("daemon: model roles", () => {
  it("/models through the real poll loop answers with the role list from the worker's resolver", async () => {
    const store = RunStore.openInMemory();
    try {
      const sent = await cycle(store, [{ update_id: 70, message: { message_id: 70, text: "/models", from: { id: 111 }, chat: { id: 222 } } }]);
      const reply = sent.find((t) => t.includes("Model roles"));
      expect(reply).toBeDefined();
      expect(reply).toContain("default");
      expect(sent).not.toContain(modelsRefusalText("unavailable"));
    } finally { store.close(); }
  });

  it("the tick runs on the first cycle and not again within the day", async () => {
    const store = RunStore.openInMemory();
    try {
      await cycle(store);
      expect(rows(store)).toHaveLength(1);
      expect(rows(store)[0]!.payload.catalog_ok).toBe(false); // NO_OMP_BIN: the catalog read failed, the latch still advanced
      await cycle(store);
      expect(rows(store)).toHaveLength(1);
    } finally { store.close(); }
  });

  it("static mode: no tick", async () => {
    vi.stubEnv("HOUGE_MODEL_ROLES", "static");
    const store = RunStore.openInMemory();
    try {
      await cycle(store);
      expect(rows(store)).toHaveLength(0);
    } finally { store.close(); }
  });
});
```

- [ ] **Step 12: Run to verify it fails**

Run: `npx vitest run tests/telegram/telegram-daemon-model-roles.test.ts`
Expected: FAIL — the first test finds the "not available" reply (the daemon's gateway has no resolver yet), the second finds
zero `model_roles_resolved` rows.

- [ ] **Step 13: Wire the daemon**

`src/telegram/telegram-daemon.ts` — imports: after line 16 (`import { resolveOmpConfig } from "../omp/omp-config.js";`):

```ts
import { runModelRolesTick } from "../omp/model-roles-tick.js";
import { stableHash } from "../domain/canonical.js";
```

Move the gateway below the worker: delete lines 151-158 (`const gateway = new Gateway(` … `);`) and insert after line 181 (the
`);` closing `new CoreWorker(`, directly above Task 7's `await worker.modelRoles().refreshCatalog();`):

```ts
  // After the worker: the gateway's /models reads the worker's RoleResolver (one catalog cache per process).
  const gateway = new Gateway(
    options.store,
    undefined,
    options.projectRoot,
    undefined,
    options.requestShutdown ? { requestShutdown: options.requestShutdown } : {},
    { dataDir: options.omp?.dataDir ?? options.projectRoot, roles: worker.modelRoles() }
  );
```

`runModelTicks` (`:511-524`; this hunk is written against Task 7's result, which added the `roles` argument) — replace:

```ts
  const signal = options.stopSignal;
  await runMemoryTicks(options, now, signal, worker.modelRoles());
```

with:

```ts
  const signal = options.stopSignal;
  // First: the memory and council ticks below then resolve their seats against today's catalog.
  await runRolesTick(options, worker, now, chatId, signal);
  if (signal.aborted) return;
  await runMemoryTicks(options, now, signal, worker.modelRoles());
```

and add after `runModelTicks` (after its closing brace, `:524`):

```ts
/**
 * The daily model-roles tick (spec §4.1): change notices go to the operator chat (the rating ask's chat), through the outbox
 * and the rich renderer; `role_unresolved` pages through openAlertedIncident. Its own catch: a failed tick never skips the
 * memory, idea and schedule ticks after it.
 */
async function runRolesTick(
  options: RunTelegramDaemonOptions, worker: CoreWorker, now: string, chatId: string | null, signal: AbortSignal
): Promise<void> {
  const notify = (text: string): void => {
    if (!chatId) return;
    options.store.enqueueNotification({
      target: { kind: "telegram", chat_id: chatId }, intent_type: "progress",
      idempotency_key: `model_roles:notice:${now}:${stableHash(text)}`, correlation_id: "model-roles", payload: { text }
    });
  };
  try {
    await runModelRolesTick({ store: options.store, roles: worker.modelRoles(), now, signal, notify });
  } catch (error) {
    console.error(`[telegram-daemon] model roles tick failed: ${errorCode(error)}`);
  }
}
```

- [ ] **Step 14: Run the daemon tests (the new one and every existing daemon suite, which now run the tick each first cycle)**

Run: `npx vitest run tests/telegram/`
Expected: PASS. If an existing daemon test counts all ledger rows or all notifications exactly, it now sees one
`model_roles_resolved` row (no notification: the first run never notifies) — adjust that assertion to filter by its own
event type and say so in the task report.

- [ ] **Step 15: Write the failing test — `lane_fallthrough_rate`**

Create `tests/run/invariant-sweep-lanes.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkLaneFallthrough, runInvariantSweep, SWEEP_INCIDENT_KINDS } from "../../src/run/invariant-sweep.js";
import { RunStore } from "../../src/run/run-store.js";

// Spec §8: a lane that falls through to the planner still gets Paco an answer (the planner takes every fall-through), so a
// broken memory or status lane looks exactly like a working Houge. Half or more of ≥ 3 settled lane turns in 24 h falling
// through is broken, not quiet; once open it stays open until that lane answers a turn itself, since rows ageing out prove nothing.
let store: RunStore;
beforeEach(() => { store = RunStore.openInMemory(); });
afterEach(() => { store.close(); });

const ARMED: NodeJS.ProcessEnv = { HOUGE_INVARIANT_SWEEP_ENABLED: "1", HOUGE_INVARIANT_SWEEP_INTERVAL_MINUTES: "5" };
const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const iso = (minutesFromNow: number) => new Date(NOW + minutesFromNow * 60_000).toISOString();
const open = () => store.listOpenIncidents().filter((i) => i.kind === "lane_fallthrough_rate");
const sweep = (plusMin = 0) => runInvariantSweep({ store, now: iso(plusMin), env: ARMED, chat_id: "555" });
let seq = 0;

/** One routed lane turn as Task 10 writes it: inserted pending by the triage finaliser, then settled by the handler's end. */
function laneTurn(lane: "memory" | "status" | "planner", minutesFromNow: number, outcome: string): void {
  seq += 1;
  const id = store.insertJevVerdict({
    run_id: `run-${seq}`, category: lane === "planner" ? "research" : lane, breadth: 0, reasoning: 0, actions: 0,
    sets_rule: lane === "memory" ? 0.95 : 0.05, rule_scope: lane === "memory" ? "ask" : null, lane, role: "default", effort: null,
    cascade: null, save_outcome: "none", route_outcome: "act", reason: "routed", skip_reason: null, quoted_turn_id: null,
    created_at: iso(minutesFromNow)
  });
  if (outcome !== "pending") store.updateJevVerdict(id, { handler_outcome: outcome });
}

describe("lane_fallthrough_rate", () => {
  it("is one of the sweep's own kinds, so the sweep may resolve it", () => {
    expect(SWEEP_INCIDENT_KINDS).toContain("lane_fallthrough_rate");
  });

  it("opens per lane (subject = lane name) when half or more of ≥ 3 settled turns fell through; another lane is untouched", () => {
    laneTurn("memory", -60, "lane_reply"); laneTurn("memory", -50, "fallthrough:compose_failed"); laneTurn("memory", -40, "fallthrough:capped");
    laneTurn("status", -30, "lane_reply"); laneTurn("status", -20, "lane_reply"); laneTurn("status", -10, "fallthrough:error");
    expect(checkLaneFallthrough(store, iso(0))).toEqual([
      { lane: "memory", open: true, turns: 3, fallthroughs: 2 }, { lane: "status", open: false, turns: 3, fallthroughs: 1 }
    ]);
    sweep();
    expect(open().map((i) => i.subject)).toEqual(["memory"]);
  });

  it("needs the floor: two fall-throughs on a quiet day are noise", () => {
    laneTurn("memory", -20, "fallthrough:error"); laneTurn("memory", -10, "fallthrough:error");
    expect(checkLaneFallthrough(store, iso(0))[0]).toMatchObject({ open: false, turns: 2, fallthroughs: 2 });
  });

  it("exactly half opens (the bar is inclusive)", () => {
    laneTurn("status", -40, "lane_reply"); laneTurn("status", -30, "lane_reply");
    laneTurn("status", -20, "fallthrough:error"); laneTurn("status", -10, "fallthrough:error");
    expect(checkLaneFallthrough(store, iso(0))[0]).toMatchObject({ lane: "status", open: true, turns: 4, fallthroughs: 2 });
  });

  it("ignores planner rows and pending rows, and a row exactly one window old is out", () => {
    for (let k = 0; k < 4; k++) laneTurn("planner", -10 - k, "planner_failed");
    laneTurn("memory", -5, "pending"); laneTurn("memory", -4, "pending");
    laneTurn("memory", -24 * 60, "fallthrough:error");
    laneTurn("memory", -3, "fallthrough:error"); laneTurn("memory", -2, "fallthrough:error");
    expect(checkLaneFallthrough(store, iso(0))).toEqual([{ lane: "memory", open: false, turns: 2, fallthroughs: 2 }]);
  });

  it("is sticky: rows ageing out keep it open; only a lane reply after it opened clears it", () => {
    laneTurn("memory", -30, "fallthrough:error"); laneTurn("memory", -20, "fallthrough:error"); laneTurn("memory", -10, "lane_reply");
    sweep();
    expect(open()).toHaveLength(1);
    sweep(25 * 60); // every row is now outside the window
    expect(open()).toHaveLength(1);
    laneTurn("memory", 25 * 60 + 1, "lane_reply");
    sweep(26 * 60);
    expect(open()).toHaveLength(0);
  });

  it("a lane reply from BEFORE the incident opened does not clear it", () => {
    laneTurn("memory", -40, "lane_reply"); laneTurn("memory", -30, "fallthrough:error"); laneTurn("memory", -20, "fallthrough:error");
    sweep();
    sweep(25 * 60);
    expect(open()).toHaveLength(1);
  });
});
```

- [ ] **Step 16: Run to verify it fails**

Run: `npx vitest run tests/run/invariant-sweep-lanes.test.ts`
Expected: FAIL — `checkLaneFallthrough` is not exported.

- [ ] **Step 17: Implement the invariant**

`src/run/invariant-sweep.ts` — replace lines 87-90 (`SWEEP_INCIDENT_KINDS`):

```ts
export const SWEEP_INCIDENT_KINDS = [
  "duplicate_schedule", "stuck_run", "undelivered_notification", "overdue_schedule", "failed_schedule",
  "heartbeat_gap", "llm_leg_failing", "disk_free_low", "wall_collapsed", "lesson_dropped", "embeddings_unavailable", "core_overflow",
  "jev_skip_rate", "lane_fallthrough_rate"
] as const;
```

After `jevViolations` (after line 232):

```ts
/** Window, floor and rate for `lane_fallthrough_rate` (spec §8): settled lane turns in the last 24 h. */
export const LANE_FALLTHROUGH_WINDOW_MS = 24 * 60 * 60 * 1000;
export const LANE_FALLTHROUGH_MIN_TURNS = 3;
export const LANE_FALLTHROUGH_MAX = 0.5;

/**
 * A broken lane, not a quiet one: at least {@link LANE_FALLTHROUGH_MIN_TURNS} settled turns of one lane in the window, at
 * least half of them fell through to the planner. Sticky like jev_skip_rate: an open lane stays open until that lane answers
 * a turn itself after the incident opened. Lanes come from the rows and the open incidents, so stage B's lanes need no edit here.
 */
export function checkLaneFallthrough(
  store: RunStore, now: string, windowMs = LANE_FALLTHROUGH_WINDOW_MS
): Array<{ lane: string; open: boolean; turns: number; fallthroughs: number }> {
  const since = new Date(Date.parse(now) - windowMs).toISOString();
  const counts = new Map(store.countLaneTurns(since, now).map((r) => [r.lane, r] as const));
  const sticky = store.listOpenIncidents().filter((i) => i.kind === "lane_fallthrough_rate").map((i) => i.subject);
  return [...new Set([...counts.keys(), ...sticky])].sort().map((lane) => {
    const { turns, fallthroughs } = counts.get(lane) ?? { turns: 0, fallthroughs: 0 };
    if (turns >= LANE_FALLTHROUGH_MIN_TURNS && fallthroughs / turns >= LANE_FALLTHROUGH_MAX) return { lane, open: true, turns, fallthroughs };
    const opened = store.findOpenIncident(store.incidentFingerprint("lane_fallthrough_rate", lane));
    return { lane, open: opened !== undefined && !store.hasLaneReplySince(lane, opened.first_seen_at), turns, fallthroughs };
  });
}

function laneViolations(store: RunStore, now: string): InvariantViolation[] {
  return checkLaneFallthrough(store, now).filter((r) => r.open)
    .map((r) => ({ kind: "lane_fallthrough_rate" as const, subject: r.lane, detail: { turns: r.turns, fallthroughs: r.fallthroughs } }));
}
```

`detectViolations` — replace lines 241-243:

```ts
  const violations: InvariantViolation[] = [
    ...detectOmpViolations(store, probe), ...memoryViolations(store, env), ...embeddingsViolations(store, now), ...jevViolations(store, now),
    ...laneViolations(store, now)
  ];
```

- [ ] **Step 18: Run everything touched, then the whole suite**

Run: `npx vitest run tests/run/invariant-sweep-lanes.test.ts tests/run/ tests/omp/model-roles-tick.test.ts tests/gateway/ tests/telegram/ && npm run typecheck && npm test && npm run build`
Expected: PASS, every command exit 0, none skipped (read `$status` after each; no pipes).

- [ ] **Step 19: Commit (three concerns, three commits)**

```bash
git add src/domain/types.ts tests/domain/types.test.ts src/triggers/telegram-command-parser.ts src/triggers/telegram-trigger-adapter.ts src/gateway/models-commands.ts src/gateway/gateway.ts src/telegram/telegram-poll-runner.ts tests/gateway/models-commands.test.ts
git commit -m "$(cat <<'EOF'
feat(gateway): /models lists roles and sets or resets per-role and per-seat override patterns

Patterns are checked against the allow-listed catalog at set time; a role-level judges
override, a catalog outage and static mode are refused with their reason.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
git add src/omp/model-roles-tick.ts src/run/run-store.ts src/telegram/telegram-daemon.ts tests/omp/model-roles-tick.test.ts tests/telegram/telegram-daemon-model-roles.test.ts
git commit -m "$(cat <<'EOF'
feat(omp): daily model-roles tick with change notices and role_unresolved incidents

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
git add src/run/invariant-sweep.ts tests/run/invariant-sweep-lanes.test.ts
git commit -m "$(cat <<'EOF'
feat(run): lane_fallthrough_rate sweep invariant over jev_verdicts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

(`src/run/run-store.ts` carries both the tick's rows and the two lane counters. Files are staged by name, so it goes in the
tick commit whole; the sweep commit adds the invariant that reads `countLaneTurns` / `hasLaneReplySince`. Run the full suite
before the second commit too: the tree at that commit must be green on its own.)

---

---

### Task 12: Replay over the tree — six questions at the live instant, quote rebuilt, §7 proxy labels, tree report

**Assembly overrides (binding; orchestrator, 2026-10-07 — where this block and the task text below disagree, this block wins):**
- Do **not** define `quotedTurnFromRow` here: import it from `src/jev/questions/tree.ts` (Task 3). Remove the local definition and its export from `triage-replay.ts`; tests import it from `tree.js`.


**Contract deviation:** none in the binding names. Three additions the contract does not name, created here: the store
reads `runLoopCapabilityCounts(run_id)` and `getChatTurnById(turn_id)` (the proxy needs per-tool step counts, and the
replay needs the quoted row by id). The quoted turn is built with Task 3's `quotedTurnFromRow` from
`src/jev/questions/tree.ts`, the same builder the live decision point uses (Task 10): live and replay **must** share one
builder or `state_hash` parity breaks (see the parity test, step 1d). The lane 1 file names stay (`triage-replay.ts`,
`triage-report.ts`, `triage-label.ts`; the File map names them); the exported symbols are renamed `Tree*`, because every
row field changes and a stale `TriageReplayRow` import must fail typecheck rather than compile against the wrong shape.

**Files:**
- Modify (rewrite): `src/jev/triage-replay.ts` (all 167 lines), `src/jev/triage-report.ts` (all 220 lines),
  `src/jev/triage-label.ts` (all 64 lines)
- Modify: `src/cli.ts:311-376` (the `jev` branch)
- Modify: `src/run/run-store.ts` — `:42` (drop the `TriageShadowStats` import), `:362-373` (`ReplayTurnRow` gains
  `quoted_turn_id`), `:1184-1210` (`listReplayTurns` selects it), after `:1222` (add `runLoopCapabilityCounts`,
  `getChatTurnById`), `:1249-1283` (delete `triageShadowStats`)
- Delete: `tests/run/triage-shadow-stats-store.test.ts` (tests the deleted lane 1 shadow read)
- Delete (Rev 5, Step 3f): `src/jev/questions/triage.ts`, `src/jev/thresholds.ts`, `tests/jev/thresholds.test.ts`
- Create (Step 3f): `tests/jev/calibration.test.ts`; Modify: `tests/jev/questions.test.ts`, `tests/jev/decide.test.ts`
- Create: `tests/helpers/jev-tree-answers.ts`
- Test (rewrite): `tests/jev/triage-replay.test.ts`, `tests/jev/triage-report.test.ts`, `tests/jev/triage-label.test.ts`,
  `tests/jev/triage-parity.test.ts`; Test (extend): `tests/run/replay-reads.test.ts`
- Untouched on purpose: `src/jev/replay.ts`, `src/jev/replay-report.ts` (the 2026-09-25 intent-shadow replay behind
  `houge jev-shadow`; neither imports a lane 1 module: `grep -n "^import" src/jev/replay.ts src/jev/replay-report.ts`),
  `src/jev/replay-core.ts`, `src/jev/wilson.ts` (reused as they are).

**Interfaces:**
- Consumes (contract): `TREE_QUESTIONS`, `TREE_CATEGORY`, `CATEGORIES`, `Category`, `HougeTurnKind`, `QuotedTurn`,
  `isProposal`, `lastHougeTurnOf`, `buildTreeState` (Task 3); `criteriaHash`, `toJevQuestion`, `ChoiceQuestion`,
  `Question` (Task 1); `JevAnswer`, `JevRequest`, `JevResult` with `answers: Record<string, JevAnswer>` (Task 1);
  `stateHash` (`src/jev/decide.ts`, today); `preJudge`, `routeTree`, `applyCascade` (Rev 4: a below-bar plan replays as a failed live cascade), `ACK_ROUTE`, `Armed`, `Route`, `TreeBars`,
  `TREE_BAR_DEFAULTS` (Task 5); `ChatTurnRow.quoted_turn_id` and `recordChatTurn({ quoted_turn_id })` (Task 4).
  Code today: `runReplayCore`, `readDone` (`src/jev/replay-core.ts:47,58`); `wilsonLower` (`src/jev/wilson.ts:2`);
  `isBareAck` (`src/omp/bare-ack.ts:11`); `langOf`, `Lang` (`src/jev/intent-question.ts:50`); `chatContextSince`,
  `resolveChatContextTurns`, `resolveChatContextTurnChars` (`src/capabilities/intent.ts`); `computeCostUsd`,
  `JEV_PROVIDER` (`src/llm/metered-pricing.js`); `RunStore.listReplayTurns` (`run-store.ts:1184`),
  `getChatTurnsBefore` (`:1170`), `runSource` (`:1224`), `listJevDecisions`, `getLedgerEvents`, `userTurnTextForRun`
  (`:4347`), `recordLoopStep`.
- Assumes after Task 10: the live path no longer imports `src/jev/questions/triage.ts` or `src/jev/thresholds.ts`
  (`triageVerdict`, `TRIAGE_STATUS_ARM_ID`, `TriageBars`, `resolveTriageBars`, `armingRows`); this task's Steps 3b–3e drop
  the last importers and Step 3f deletes both files (Rev 5); the live decision point still writes `jev_decisions` rows with `point: "triage"`
  and the `thread_cut_at` / `state_built_at` instants (`src/core/core-worker.ts:2586` today).
- Produces:
  ```ts
  // src/jev/triage-replay.ts
  export const TREE_REPLAY_OUT = ".houge/jev-tree/replay.jsonl";
  export const TREE_PERMUTED_OUT = ".houge/jev-tree/replay-permuted.jsonl";
  export const TREE_LABELS_PATH = ".houge/jev-tree/labels.jsonl";
  export const TREE_LABEL_SINCE = "2026-07-02T00:00:00.000Z";
  export const TREE_DONE: ReadonlySet<string>;
  export type ProxyRule = "houge_status" | "memory_correct_write" | "lesson_write" | "self_change" | "wiki" | "schedule_task"
    | "mail_calendar" | "machine_task" | "research" | "lookup" | "no_tool" | "ack_after_proposal" | "unmatched_tools";
  export interface ProxyLabel { category: Category | null; rule: ProxyRule }
  export function proxyLabel(tools: Readonly<Record<string, number>>, prevKind: HougeTurnKind | null): ProxyLabel;
  export interface TreeLabel { category: Category; by: "paco"; at: string }
  export interface TreeReplayRow { key; turn_id; run_id; lang: Lang; status: "ok" | "dry_run" | "skipped_state_too_large" | "jev_failed";
    est_usd; attempt?; usd?; stop?: "auth" | "fused"; error?: string; state_hash: string; tools: Record<string, number>;
    proxy: Category | null; proxy_rule: ProxyRule; pre_judge: "ack_answer" | "judge"; think_harder: boolean; bare_ack: boolean;
    quoted: boolean; model?: string; criteria_hashes?: Record<string, string>; answers?: Record<string, JevAnswer> }
  export const TREE_CATEGORY_PERMUTED: ChoiceQuestion;
  export function treeQuestions(permute: boolean): readonly Question[];
  // quotedTurnFromRow is imported from src/jev/questions/tree.ts (Task 3), never redefined here
  export function loadLabels(path: string): Map<string, TreeLabel>;
  export function readReplayFile(path: string): TreeReplayRow[];
  export function treeUniverse(store: RunStore): number;
  export async function runTreeReplay(d: TreeReplayDeps): Promise<ReplayCoreOutcome<TreeReplayRow>>;
  // src/jev/triage-report.ts
  export interface TreeReportOutcome { spentUsd; estimatedUsd; stopped?; universe?; wouldDispatch?; alreadyDone?; skipped?; limited? }
  export function replayRoute(r: TreeReplayRow, bars: TreeBars, armed?: Armed): { route: Route; cascade: boolean } | null; // armed defaults to all
  export const ARMING_COMBOS: ReadonlyArray<{ name: string; armed: Armed }>;
  export function formatTreeReport(rows: TreeReplayRow[], labels: Map<string, TreeLabel>, outcome: TreeReportOutcome, bars: TreeBars,
    permuted?: TreeReplayRow[]): string;
  // src/jev/triage-label.ts
  export function selectForLabelling(rows: TreeReplayRow[], existing: Map<string, TreeLabel>, sample: number, rng?: () => number): TreeReplayRow[];
  export function parseLabelAnswer(line: string): Category | null;
  export function parseJevCliFlags(argv: string[]): { sample?: number; permute: boolean; rest: string[] };   // unchanged
  export async function labelInteractively(i: {...as today, rows: TreeReplayRow[]}): Promise<number>;
  // src/run/run-store.ts
  runLoopCapabilityCounts(run_id: string): Record<string, number>;
  getChatTurnById(turn_id: string): ChatTurnRow | undefined;
  // ReplayTurnRow gains `quoted_turn_id?: string | null` (optional: tests/jev/replay.test.ts builds literals without it)
  ```

**Proxy interpretation (stated here so the reviewer can rule on it):** spec §7's "steps" are the run's `loop_step`
rows of the two web tools: `research` = `web_search` present and `web_search + http_fetch` rows ≥ 3, or `http_fetch`
rows ≥ 2; `lookup` = 1–2 such rows. A run whose tools match no rule (live DB since 2026-07-02: `to_local_time`,
`memory_correct`, `llm_answer`, `bounty_scan`, `project_list`, `external_work`, `shell_destructive`) is
**unlabelled** (`unmatched_tools`), not `answer`: the spec's `answer` is "no tool". The ack ambiguity reads the
previous Houge turn **or** the quoted turn (§2.2.1: the offer clause reads the quoted turn first).

- [ ] **Step 1a: Write the failing store test** — append to `tests/run/replay-reads.test.ts`, inside the existing
  `describe("replay reads", …)` after the `runLoopCapabilities` case:

```ts
  // Spec §7: the proxy tells research (≥ 3 web steps or ≥ 2 fetches) from lookup (≤ 2) by COUNT; a distinct-name
  // read would label a ten-search investigation as a one-search lookup.
  it("runLoopCapabilityCounts counts loop_step rows per capability and drops unnamed steps", () => {
    const store = RunStore.openInMemory();
    try {
      const run = createRun(store, "k4");
      for (const capability of ["web_search", "web_search", "web_search", "http_fetch", ""]) {
        store.recordLoopStep(run, { step: 1, action: "tool", capability, ok: true, result_digest: "" });
      }
      expect(store.runLoopCapabilityCounts(run)).toEqual({ web_search: 3, http_fetch: 1 });
      expect(store.runLoopCapabilityCounts("nope")).toEqual({});
    } finally {
      store.close();
    }
  });

  // Spec §2.2.1 / §7: the replay rebuilds `quoted_turn` from the stored id, so the user row must carry it and the
  // quoted row must be readable by id; without both the replay's state differs from live on every quoted turn.
  it("listReplayTurns carries quoted_turn_id and getChatTurnById reads the quoted row", () => {
    const store = RunStore.openInMemory();
    try {
      const a = createRun(store, "k5"); const b = createRun(store, "k6");
      store.recordChatTurn({ chat_id: "c", run_id: a, role: "user", text: "q1", created_at: "2026-09-10T00:00:00.000Z" });
      store.recordChatTurn({ chat_id: "c", run_id: a, role: "assistant", text: "要不要我查一下？", intent: "answer", created_at: "2026-09-10T00:00:01.000Z" });
      const offer = store.getRecentChatTurns("c", 10).find((t) => t.role === "assistant")!;
      store.recordChatTurn({ chat_id: "c", run_id: b, role: "user", text: "好", created_at: "2026-09-10T01:00:00.000Z", quoted_turn_id: offer.turn_id });
      store.recordChatTurn({ chat_id: "c", run_id: b, role: "assistant", text: "ok", intent: "answer", created_at: "2026-09-10T01:00:01.000Z" });
      const rows = store.listReplayTurns({});
      expect(rows.find((r) => r.run_id === b)?.quoted_turn_id).toBe(offer.turn_id);
      expect(rows.find((r) => r.run_id === a)?.quoted_turn_id).toBeNull();
      expect(store.getChatTurnById(offer.turn_id)).toMatchObject({ run_id: a, role: "assistant", text: "要不要我查一下？" });
      expect(store.getChatTurnById("turn_missing")).toBeUndefined();
    } finally {
      store.close();
    }
  });
```

- [ ] **Step 1b: Create the shared answer builders** — `tests/helpers/jev-tree-answers.ts`:

```ts
import type { JevAnswer, JevChoiceAnswer, JevNoulAnswer, JevScoreAnswer } from "../../src/jev/jev-client.js";
import { CATEGORIES } from "../../src/jev/questions/tree.js";

/** A choice answer: `top` carries p, the rest share 1 − p evenly; confidence as TypeSafe computes it. Tests only. */
export function choiceAns(options: readonly string[], top: string, p: number): JevChoiceAnswer {
  const rest = (1 - p) / (options.length - 1);
  const probabilities = Object.fromEntries(options.map((o) => [o, o === top ? p : rest]));
  const n = options.length;
  return { type: "choice", choice: top, probabilities, confidence: (p - 1 / n) / (1 - 1 / n) };
}

/** A score answer certain of one level (keys "0".."n-1"). */
export function scoreAns(level: number, n = 4): JevScoreAnswer {
  const probabilities = Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i), i === level ? 1 : 0]));
  return { type: "score", score: level, probabilities, confidence: 1 };
}

export const noulAns = (p: number): JevNoulAnswer => ({ type: "noul", noul: p });

/** The six tree answers; defaults are a plain light `answer` turn that states no rule. */
export function treeAnswers(o: { category: string; p?: number; setsRule?: number; scope?: "ask" | "research"; breadth?: number;
  reasoning?: number; actions?: number }): Record<string, JevAnswer> {
  return {
    category: choiceAns(CATEGORIES, o.category, o.p ?? 0.9), sets_rule: noulAns(o.setsRule ?? 0.05),
    rule_scope: choiceAns(["ask", "research"], o.scope ?? "ask", 0.9),
    breadth: scoreAns(o.breadth ?? 1), reasoning: scoreAns(o.reasoning ?? 1), actions: scoreAns(o.actions ?? 1)
  };
}
```

- [ ] **Step 1c: Write the failing replay tests** — replace `tests/jev/triage-replay.test.ts` entirely:

```ts
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatContextSince, resolveChatContextTurnChars, resolveChatContextTurns } from "../../src/capabilities/intent.js";
import { stateHash } from "../../src/jev/decide.js";
import type { JevRequest, JevResult } from "../../src/jev/jev-client.js";
import { buildTreeState, lastHougeTurnOf, quotedTurnFromRow, TREE_CATEGORY, TREE_QUESTIONS } from "../../src/jev/questions/tree.js";
import { criteriaHash } from "../../src/jev/questions/types.js";
import { loadLabels, proxyLabel, runTreeReplay, TREE_CATEGORY_PERMUTED, TREE_LABEL_SINCE, TREE_REPLAY_OUT } from "../../src/jev/triage-replay.js";
import { RunStore } from "../../src/run/run-store.js";
import { treeAnswers } from "../helpers/jev-tree-answers.js";
import { createQueuedTurnRun } from "../helpers/runs.js";

/** The versioned id Jev reports (the request names the alias `jev-latest`; rows and calibration key on the reported id). */
const REPORTED = "jev-1.13.0";
const fakeJev = async (req: JevRequest): Promise<JevResult> => {
  const msg = String((req.state as { latest_message: string }).latest_message);
  const answers = /以后/.test(msg) ? treeAnswers({ category: "memory", setsRule: 0.95 })
    : /天气/.test(msg) ? treeAnswers({ category: "lookup", breadth: 1, actions: 1 }) : treeAnswers({ category: "answer" });
  return { ok: true, model: REPORTED, input_tokens: 500, latency_ms: 200, answers };
};
const step = (n: number, capability: string) => ({ step: n, action: "tool", capability, ok: true, result_digest: "d" });

/** One Telegram run born at `at` (its first ledger event = the replay anchor), with its user + assistant turns. */
function seedRun(store: RunStore, text: string, at: string, caps: string[], reply = "好的", quoted_turn_id?: string): string {
  vi.setSystemTime(new Date(at));
  const run = createQueuedTurnRun(store, text);
  const done = new Date(Date.parse(at) + 20_000).toISOString(); // chat_turns are written at completion
  store.recordChatTurn({ chat_id: "555", run_id: run, role: "user", text, created_at: done, ...(quoted_turn_id ? { quoted_turn_id } : {}) });
  store.recordChatTurn({ chat_id: "555", run_id: run, role: "assistant", text: reply, intent: "answer", created_at: done });
  caps.forEach((c, i) => store.appendRunLedgerEvent(run, "loop_step", "core", step(i + 1, c)));
  return run;
}
function seed(store: RunStore) {
  vi.useFakeTimers({ toFake: ["Date"] });
  const a = seedRun(store, "以后回复短一点", "2026-08-01T00:00:00.000Z", ["lesson_write"]);
  const b = seedRun(store, "明天天气怎么样", "2026-08-01T00:10:00.000Z", ["web_search"]);
  const c = seedRun(store, "old", "2026-06-20T00:00:00.000Z", []); // before the label epoch
  vi.useRealTimers();
  return { a, b, c };
}
const tmp = (name: string) => join(mkdtempSync(join(tmpdir(), "tr-")), name);

afterEach(() => vi.useRealTimers());

// Spec §7: the label is the FIRST matching rule. A turn that checked status and also wrote a lesson must count as
// status; a correction must never be read as a new rule; three searches are research, one is a lookup.
describe("proxyLabel (spec §7 precedence)", () => {
  const cases: Array<[string, Record<string, number>, string | null, string | null, string]> = [
    ["status beats a lesson", { houge_status: 1, lesson_write: 1 }, null, "status", "houge_status"],
    ["a correction beats a rule", { memory_correct_write: 1, lesson_write: 1 }, null, "memory", "memory_correct_write"],
    ["a rule beats a search", { lesson_write: 1, web_search: 4 }, null, "memory", "lesson_write"],
    ["self-write beats shell", { self_write_propose: 1, shell: 2 }, null, "self_change", "self_change"],
    ["skill_author is self_change", { skill_author: 1 }, null, "self_change", "self_change"],
    ["wiki beats schedule", { wiki_refine: 1, schedule_task: 1 }, null, "wiki", "wiki"],
    ["schedule beats mail", { schedule_task: 1, gmail_read: 1 }, null, "schedule", "schedule_task"],
    ["gmail_* is mail_calendar", { gmail_read: 1, web_search: 1 }, null, "mail_calendar", "mail_calendar"],
    ["shell beats search", { shell: 1, web_search: 3 }, null, "machine_task", "machine_task"],
    ["fs_* is machine_task", { fs_read: 1 }, null, "machine_task", "machine_task"],
    ["three web steps with a search is research", { web_search: 2, http_fetch: 1 }, null, "research", "research"],
    ["two fetches are research", { http_fetch: 2 }, null, "research", "research"],
    ["one search and one fetch is a lookup", { web_search: 1, http_fetch: 1 }, null, "lookup", "lookup"],
    ["a helper tool beside a lookup is ignored", { web_search: 1, to_local_time: 1 }, null, "lookup", "lookup"],
    ["only unmatched tools: unlabelled, not answer", { to_local_time: 1 }, null, null, "unmatched_tools"],
    ["no tool after an answer is answer", {}, "answer", "answer", "no_tool"],
    ["no tool after a proposal is unlabelled (the ack ambiguity)", {}, "proposal", null, "ack_after_proposal"]
  ];
  it.each(cases)("%s", (_name, tools, prev, category, rule) => {
    expect(proxyLabel(tools, prev as "answer" | "proposal" | null)).toEqual({ category, rule });
  });
});

describe("runTreeReplay", () => {
  // Spec §7: universe = Telegram turns since 2026-07-02; every row carries the proxy, the tools and Jev's per-question
  // answers (ids, enums and numbers only: the file is never allowed to hold message text).
  it("replays the universe with all six questions and records proxy, tools and answers, never text", async () => {
    const store = RunStore.openInMemory(); const { a, b } = seed(store);
    const sent: JevRequest[] = [];
    const out = tmp("replay.jsonl");
    const r = await runTreeReplay({ store, env: {}, jev: async (q) => { sent.push(q); return fakeJev(q); }, outPath: out, maxUsd: 1, dryRun: false });
    expect(r.rows.map((x) => x.status)).toEqual(["ok", "ok"]); // "old" is before TREE_LABEL_SINCE
    expect(Object.keys(sent[0]!.questions)).toEqual(TREE_QUESTIONS.map((q) => q.id));
    const mem = r.rows.find((x) => x.run_id === a)!;
    expect(mem).toMatchObject({ proxy: "memory", proxy_rule: "lesson_write", tools: { lesson_write: 1 }, lang: "zh", pre_judge: "judge", quoted: false });
    expect(mem.criteria_hashes).toEqual(Object.fromEntries(TREE_QUESTIONS.map((q) => [q.id, criteriaHash(q)])));
    expect(mem.answers?.category).toMatchObject({ type: "choice", choice: "memory" });
    expect(mem.answers?.sets_rule).toEqual({ type: "noul", noul: 0.95 });
    expect(r.rows.find((x) => x.run_id === b)).toMatchObject({ proxy: "lookup", proxy_rule: "lookup" });
    const file = readFileSync(out, "utf8");
    expect(file).not.toContain("以后回复短一点");
    expect(file).not.toContain("明天天气");
    expect(TREE_LABEL_SINCE).toBe("2026-07-02T00:00:00.000Z");
    store.close();
  });

  // Spec §2.2.1 / §7: a quoted "好" must replay with the quoted proposal in its state (as live saw it), is never settled
  // by the ack rule, and its tool proxy is unlabelled, because with no tool the proxy cannot tell agreement from chat.
  it("rebuilds quoted_turn from chat_turns.quoted_turn_id; the state hash equals the live builder's", async () => {
    const store = RunStore.openInMemory();
    vi.useFakeTimers({ toFake: ["Date"] });
    const a = seedRun(store, "明天天气怎么样", "2026-08-01T00:00:00.000Z", [], "要不要我帮你查一下明天的天气？");
    const offer = store.getRecentChatTurns("555", 10).find((t) => t.run_id === a && t.role === "assistant")!;
    const b = seedRun(store, "好", "2026-08-01T01:00:00.000Z", [], "好的", offer.turn_id);
    vi.useRealTimers();
    const sent: JevRequest[] = [];
    const r = await runTreeReplay({ store, env: {}, jev: async (q) => { sent.push(q); return fakeJev(q); }, outPath: tmp("q.jsonl"), maxUsd: 1, dryRun: false });
    const row = r.rows.find((x) => x.run_id === b)!;
    expect(row).toMatchObject({ quoted: true, pre_judge: "judge", proxy: null, proxy_rule: "ack_after_proposal", bare_ack: true });
    const anchor = "2026-08-01T01:00:00.000Z";
    const recent = store.getChatTurnsBefore("555", resolveChatContextTurns({}), chatContextSince({}, new Date(anchor)), anchor, b);
    const quotedTurn = quotedTurnFromRow(store.getChatTurnById(offer.turn_id)!, Date.parse(anchor));
    expect(quotedTurn).toMatchObject({ role: "houge", kind: "proposal", age_s: 3580 });
    const built = buildTreeState({ userText: "好", recentTurns: recent, turnChars: resolveChatContextTurnChars({}), modality: "text",
      lastHougeTurn: lastHougeTurnOf(recent, Date.parse(anchor)), quotedTurn });
    if (!built.ok) throw new Error("state");
    expect(row.state_hash).toBe(stateHash(built.state));
    const sentState = sent.find((q) => (q.state as { latest_message: string }).latest_message === "好")!.state as Record<string, unknown>;
    expect(sentState.quoted_turn).toMatchObject({ role: "houge", kind: "proposal" });
    store.close();
  });

  // Lane 1 review fix, kept: live built the state at its decision instant, not at the anchor; a replay cut at the
  // anchor would never join jev_decisions.state_hash for a turn decided live.
  it("a turn the live path decided is rebuilt at the live instant: thread cut and last_houge_turn age both", async () => {
    const store = RunStore.openInMemory(); const { a, b } = seed(store);
    const live = "2026-08-01T00:10:03.000Z";
    store.recordChatTurn({ chat_id: "555", run_id: a, role: "assistant", text: "补充一句", intent: "answer", created_at: "2026-08-01T00:10:01.000Z" });
    store.insertJevDecision({ run_id: b, point: "triage", question_id: "category", criteria_hash: "c", model_reported: REPORTED, state_hash: "s", lang: "zh",
      answers_json: "{}", confidence: 0.9, top_prob: 0.9, margin: 0.8, threshold_version: "v", threshold_used: null, decision: "fallback", latency_ms: 1,
      input_tokens: 1, status: "answered", skip_reason: null, created_at: live });
    const r = await runTreeReplay({ store, env: {}, jev: fakeJev, outPath: tmp("r.jsonl"), maxUsd: 1, dryRun: false });
    const build = (at: string) => {
      const recent = store.getChatTurnsBefore("555", resolveChatContextTurns({}), chatContextSince({}, new Date(at)), at, b);
      const built = buildTreeState({ userText: "明天天气怎么样", recentTurns: recent, turnChars: resolveChatContextTurnChars({}), modality: "text",
        lastHougeTurn: lastHougeTurnOf(recent, Date.parse(at)), quotedTurn: null });
      if (!built.ok) throw new Error("state");
      return built.state;
    };
    const liveState = build(live);
    expect((liveState.recent_turns as unknown[]).length).toBe(3); // the turn written after the anchor is in the live thread
    const row = r.rows.find((x) => x.run_id === b)!;
    expect(row.state_hash).toBe(stateHash(liveState));
    expect(row.state_hash).not.toBe(stateHash(build("2026-08-01T00:10:00.000Z")));
    store.close();
  });

  it("resumes: a second run over the same file dispatches nothing new", async () => {
    const store = RunStore.openInMemory(); seed(store);
    const out = tmp("replay.jsonl");
    let calls = 0; const counting = async (q: JevRequest) => { calls++; return fakeJev(q); };
    await runTreeReplay({ store, env: {}, jev: counting, outPath: out, maxUsd: 1, dryRun: false });
    const again = await runTreeReplay({ store, env: {}, jev: counting, outPath: out, maxUsd: 1, dryRun: false });
    expect(calls).toBe(2);
    expect(again).toMatchObject({ universe: 2, alreadyDone: 2 });
    store.close();
  });

  // Rev 5 (c026e5c): the request names the alias, so a reported model that changes mid-run, or across a resume, is the
  // alias moving. Warn once per new model (the report refuses the mixed file); a run wholly on one model warns nothing.
  it("warns when the reported model changes mid-run or across a resume, never on a run wholly on one model", async () => {
    const warnings = (log: ReturnType<typeof vi.fn>) => log.mock.calls.map(([l]) => String(l)).filter((l) => l.includes("warning"));
    const newer = async (q: JevRequest): Promise<JevResult> => ({ ...(await fakeJev(q)), model: "jev-1.14.0" } as JevResult);
    const store = RunStore.openInMemory(); seed(store);
    let n = 0; const mid = vi.fn();
    const moving = async (q: JevRequest): Promise<JevResult> => (n++ === 0 ? fakeJev(q) : newer(q));
    await runTreeReplay({ store, env: {}, jev: moving, outPath: tmp("m.jsonl"), maxUsd: 1, dryRun: false, log: mid });
    expect(warnings(mid)).toHaveLength(1);
    expect(warnings(mid)[0]).toContain(REPORTED); expect(warnings(mid)[0]).toContain("jev-1.14.0");
    const quiet = vi.fn();
    await runTreeReplay({ store, env: {}, jev: newer, outPath: tmp("q2.jsonl"), maxUsd: 1, dryRun: false, log: quiet });
    expect(warnings(quiet)).toHaveLength(0);
    const out = tmp("resume.jsonl");
    await runTreeReplay({ store, env: {}, jev: fakeJev, outPath: out, maxUsd: 1, dryRun: false, limit: 1 }); // one turn on REPORTED
    const resumed = vi.fn();
    await runTreeReplay({ store, env: {}, jev: newer, outPath: out, maxUsd: 1, dryRun: false, log: resumed });
    expect(warnings(resumed)).toHaveLength(1);
    store.close();
  });

  // A partial run must never read as evidence (lessons, "a verdict over a partial run is not a verdict").
  it("stops on auth; a dry run spends nothing, writes nothing and keeps the state out of the outcome", async () => {
    const store = RunStore.openInMemory(); seed(store);
    const out = tmp("replay.jsonl");
    const dry = await runTreeReplay({ store, env: {}, jev: fakeJev, outPath: out, maxUsd: 1, dryRun: true });
    expect(dry.rows.every((x) => x.status === "dry_run")).toBe(true); expect(dry.spentUsd).toBe(0);
    expect(dry).toMatchObject({ universe: 2, wouldDispatch: 2 });
    expect(JSON.stringify(dry.rows)).not.toContain("以后回复短一点");
    expect(dry.rows.every((x) => !("state" in x) && !("chars" in x))).toBe(true);
    expect(() => readFileSync(out)).toThrow();
    const auth = async (): Promise<JevResult> => ({ ok: false, reason: "auth", detail: "HTTP 401", error_kind: "auth" });
    const r = await runTreeReplay({ store, env: {}, jev: auth, outPath: tmp("r.jsonl"), maxUsd: 1, dryRun: false });
    expect(r.stopped).toBe("auth");
    expect(r.rows[0]).toMatchObject({ status: "jev_failed", error: "auth" });
    expect(JSON.stringify(r.rows[0])).not.toContain("HTTP 401"); // the reason enum only, never the client's detail
    store.close();
  });

  // Spec §7 "permutation agreement": jev leans to the first option; `category` is asked reversed into its own file.
  it("permute: asks `category` with its options reversed, keys rows apart, and refuses the canonical file", async () => {
    const store = RunStore.openInMemory(); seed(store);
    const sent: JevRequest[] = [];
    const out = tmp("replay-permuted.jsonl");
    const r = await runTreeReplay({ store, env: {}, jev: async (q) => { sent.push(q); return fakeJev(q); }, outPath: out, maxUsd: 1, dryRun: false, permute: true });
    expect(Object.keys(sent[0]!.questions.category!.criteria as Record<string, string>)).toEqual(TREE_CATEGORY.criteria.map(([k]) => k).reverse());
    expect(Object.keys(sent[0]!.questions.rule_scope!.criteria as Record<string, string>)).toEqual(["ask", "research"]); // only `category` is permuted
    expect(r.rows.every((x) => x.key.endsWith(":perm"))).toBe(true);
    expect(r.rows[0]!.criteria_hashes?.category).toBe(criteriaHash(TREE_CATEGORY_PERMUTED));
    expect(r.rows[0]!.criteria_hashes?.category).not.toBe(criteriaHash(TREE_CATEGORY));
    await expect(runTreeReplay({ store, env: {}, jev: fakeJev, outPath: TREE_REPLAY_OUT, maxUsd: 1, dryRun: true, permute: true })).rejects.toThrow(/permuted/);
    store.close();
  });

  it("loadLabels reads Paco's category labels keyed by turn_id, and refuses a malformed line rather than drop it", () => {
    const p = tmp("labels.jsonl");
    writeFileSync(p, `${JSON.stringify({ turn_id: "t1", category: "lookup", by: "paco", at: "2026-10-08T00:00:00.000Z" })}\n`);
    expect(loadLabels(p).get("t1")).toEqual({ category: "lookup", by: "paco", at: "2026-10-08T00:00:00.000Z" });
    expect(loadLabels(tmp("absent.jsonl")).size).toBe(0);
    writeFileSync(p, `${JSON.stringify({ turn_id: "t1", category: "weather", by: "paco", at: "" })}\n`);
    expect(() => loadLabels(p)).toThrow(/line 1/);
  });
});
```

- [ ] **Step 1d: Rewrite the live ↔ replay parity test** — replace `tests/jev/triage-parity.test.ts` entirely (the
  second case is today's, unchanged; the first now runs the tree's live decision point from Task 10):

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JevRequest, JevResult } from "../../src/jev/jev-client.js";
import { runTreeReplay } from "../../src/jev/triage-replay.js";
import { RunStore } from "../../src/run/run-store.js";
import { treeAnswers } from "../helpers/jev-tree-answers.js";
import { ompWorker } from "../helpers/omp-worker.js";
import { createQueuedTurnRun } from "../helpers/runs.js";

// The replay is evidence for arming only if a turn with no real difference replays to the SAME state_hash as its live
// decision row: live cuts the thread at the claim and computes ages when it builds the state, and the replay must use
// those two recorded instants. Otherwise the report compares Jev on a state live never sent.
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ANSWERS = treeAnswers({ category: "lookup" });
/** The versioned id Jev reports (the request names the alias `jev-latest`; rows and calibration key on the reported id). */
const REPORTED = "jev-1.13.0";
const liveFetch = vi.fn(async () => json(200, { model: REPORTED, usage: { input_tokens: 800, output_tokens: 0 }, answers: ANSWERS }));
const replayJev = async (_r: JevRequest): Promise<JevResult> => ({ ok: true, model: REPORTED, input_tokens: 800, latency_ms: 300, answers: ANSWERS });
const ENV = { HOUGE_JEV_ENABLED: "1", HOUGE_JEV_TRIAGE_ENABLED: "arm", HOUGE_CHAT_CONTEXT_WINDOW_MINUTES: "60" };
const at = (iso: string) => new Date(iso);

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("tree state parity: live decision ↔ replay", () => {
  it("replays to the live state_hash despite age rounding, a message mid-decision, a turn on the window edge and one in the cut's millisecond", async () => {
    for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.useFakeTimers({ toFake: ["Date"] });
    const store = RunStore.openInMemory();
    const claimAt = "2026-10-06T10:00:00.000Z";
    store.recordChatTurn({ chat_id: "555", run_id: "old", role: "user", text: "edge turn", created_at: "2026-10-06T09:00:00.100Z" });
    store.recordChatTurn({ chat_id: "555", run_id: "prev", role: "assistant", text: "earlier answer", intent: "answer", created_at: "2026-10-06T09:59:50.000Z" });
    store.recordChatTurn({ chat_id: "555", run_id: "same-ms", role: "user", text: "same ms turn", created_at: claimAt });
    const ticks = [at("2026-10-06T10:00:00.400Z"), at("2026-10-06T10:00:00.700Z")];
    const worker = ompWorker(store, mkdtempSync(join(tmpdir(), "hpar-")), { jevFetch: liveFetch as unknown as typeof fetch,
      jevNow: () => ticks.length > 1 ? ticks.shift()! : ticks[0]! });
    vi.setSystemTime(at(claimAt));
    const run_id = createQueuedTurnRun(store, "how is the weather");
    const claim = store.claimRun(run_id, "w", 120)!;
    worker.buildOmpTools(claim, "555"); // the live thread is cut here, at the claim
    store.recordChatTurn({ chat_id: "555", run_id: "next", role: "user", text: "also this", created_at: "2026-10-06T10:00:00.200Z" });
    // No tree calibration row exists, so the live route is `uncalibrated` → planner; the state is what matters here.
    expect(await worker.triageTurn({ claim, text: "how is the weather", userText: "how is the weather", modality: "text", posture: null,
      signal: new AbortController().signal })).toMatchObject({ kind: "fallthrough" });
    const sent = JSON.parse(String((liveFetch.mock.calls.at(-1) as unknown as [unknown, RequestInit])[1].body)) as { state: { recent_turns: Array<{ text: string }> } };
    expect(sent.state.recent_turns.map((t) => t.text)).toEqual(["edge turn", "earlier answer", "same ms turn"]); // not "also this"
    const live = store.listJevDecisions(run_id).find((r) => r.question_id === "category")!;
    expect(live).toMatchObject({ thread_cut_at: claimAt, state_built_at: "2026-10-06T10:00:00.400Z" });
    store.recordChatTurn({ chat_id: "555", run_id, role: "user", text: "how is the weather", created_at: "2026-10-06T10:00:20.000Z" });
    store.recordChatTurn({ chat_id: "555", run_id, role: "assistant", text: "sunny", intent: "answer", created_at: "2026-10-06T10:00:21.000Z" });
    vi.useRealTimers();
    const r = await runTreeReplay({ store, env: { HOUGE_CHAT_CONTEXT_WINDOW_MINUTES: "60" }, jev: replayJev,
      outPath: join(mkdtempSync(join(tmpdir(), "hpar-")), "r.jsonl"), maxUsd: 1, dryRun: false });
    expect(r.rows.find((x) => x.run_id === run_id)!.state_hash).toBe(live.state_hash);
    store.close();
  });

  it("skipped rows carry no instants (they have no state)", async () => {
    vi.stubEnv("HOUGE_JEV_ENABLED", "0");
    const store = RunStore.openInMemory();
    const worker = ompWorker(store, mkdtempSync(join(tmpdir(), "hpar-")), { jevFetch: liveFetch as unknown as typeof fetch });
    const run_id = createQueuedTurnRun(store, "hi");
    const claim = store.claimRun(run_id, "w", 120)!;
    worker.buildOmpTools(claim, "555");
    await worker.triageTurn({ claim, text: "hi", userText: "hi", modality: "text", posture: null, signal: new AbortController().signal });
    expect(store.listJevDecisions(run_id)).toMatchObject([{ status: "skipped", thread_cut_at: null, state_built_at: null }]);
    store.close();
  });
});
```

- [ ] **Step 1e: Write the failing report tests** — replace `tests/jev/triage-report.test.ts` entirely:

```ts
import { describe, expect, it } from "vitest";
import { TREE_QUESTIONS } from "../../src/jev/questions/tree.js";
import { criteriaHash } from "../../src/jev/questions/types.js";
import { TREE_BAR_DEFAULTS } from "../../src/jev/tree-policy.js";
import { ARMING_COMBOS, formatTreeReport, replayRoute } from "../../src/jev/triage-report.js";
import { TREE_CATEGORY_PERMUTED, type TreeLabel, type TreeReplayRow } from "../../src/jev/triage-replay.js";
import { treeAnswers } from "../helpers/jev-tree-answers.js";

/** The versioned id Jev reports (the request names the alias `jev-latest`; rows and calibration key on the reported id). */
const REPORTED = "jev-1.13.0";
const HASHES = Object.fromEntries(TREE_QUESTIONS.map((q) => [q.id, criteriaHash(q)]));
const row = (turn_id: string, o: Partial<TreeReplayRow> = {}): TreeReplayRow => ({ key: turn_id, turn_id, run_id: `r${turn_id}`, lang: "zh", status: "ok",
  est_usd: 0, state_hash: "h", tools: {}, proxy: "answer", proxy_rule: "no_tool", pre_judge: "judge", think_harder: false, bare_ack: false, quoted: false,
  model: REPORTED, criteria_hashes: HASHES, answers: treeAnswers({ category: "answer" }), ...o });
const perm = (rows: TreeReplayRow[]) => rows.map((r) => ({ ...r, key: `${r.key}:perm`, criteria_hashes: { ...HASHES, category: criteriaHash(TREE_CATEGORY_PERMUTED) } }));
const label = (category: TreeLabel["category"]): TreeLabel => ({ category, by: "paco", at: "2026-10-08T00:00:00.000Z" });

/** One turn per costly cell plus two clean ones (spec §7's three costly cells). */
function fixture(): TreeReplayRow[] {
  return [
    row("a", { tools: { lesson_write: 1 }, proxy: "memory", proxy_rule: "lesson_write", answers: treeAnswers({ category: "memory", setsRule: 0.95 }) }), // clean: memory lane
    row("b", { tools: { web_search: 1 }, proxy: "lookup", proxy_rule: "lookup", answers: treeAnswers({ category: "memory", setsRule: 0.95 }) }), // swallowed
    row("c", { tools: { shell: 2 }, proxy: "machine_task", proxy_rule: "machine_task",
      answers: treeAnswers({ category: "machine_task", breadth: 0, reasoning: 0, actions: 0 }) }), // under-powered (rated light)
    row("d"), // lane-shaped `answer` sent to the planner (stage A has no answer lane): cost only
    row("e", { proxy: null, proxy_rule: "ack_after_proposal", answers: treeAnswers({ category: "status" }) }), // status on an unlabelled turn
    row("f", { tools: { web_search: 4 }, proxy: "research", proxy_rule: "research",
      answers: treeAnswers({ category: "research", breadth: 3, reasoning: 3, actions: 2 }) }) // clean: planner, heavy
  ];
}
const complete = (rows: TreeReplayRow[]) => ({ spentUsd: 0.01, estimatedUsd: 0.01, universe: rows.length });

describe("replayRoute", () => {
  // The report's costly cells are only as true as the route: it must be the live policy's (routeTree), as if armed.
  it("routes through the live policy as if armed; an ack-rule turn is answer/Fast without the judge", () => {
    expect(replayRoute(row("a", { answers: treeAnswers({ category: "memory", setsRule: 0.95 }) }), TREE_BAR_DEFAULTS)?.route.lane).toBe("memory");
    expect(replayRoute(row("x", { pre_judge: "ack_answer" }), TREE_BAR_DEFAULTS)?.route).toMatchObject({ category: "answer", role: "fast", reason: "ack_rule" });
    expect(replayRoute(row("y", { answers: undefined }), TREE_BAR_DEFAULTS)).toBeNull();
  });
  // Decision 14: live, a below-bar turn asks the Tiny role; the replay makes no model call, so it shows the live failure
  // semantics (Default, nothing saved) and flags the turn, never a guessed pick that would flatter the report.
  it("a below-bar plan replays as a failed live cascade: cascade_failed on Default, nothing saved, flagged", () => {
    expect(replayRoute(row("c", { answers: treeAnswers({ category: "lookup", p: 0.5, setsRule: 0.95 }) }), TREE_BAR_DEFAULTS))
      .toMatchObject({ cascade: true, route: { reason: "cascade_failed", lane: "planner", role: "default", save: null } });
  });
});

describe("formatTreeReport", () => {
  it("prints the category confusion matrix against the tool proxy, with agreement over labelled turns", () => {
    const rows = fixture();
    const text = formatTreeReport(rows, new Map(), complete(rows), TREE_BAR_DEFAULTS, perm(rows));
    expect(text).toMatch(/lookup\s+\(n=1\): memory 1/);
    expect(text).toMatch(/unlabelled\s+\(n=1\): status 1/);
    expect(text).toMatch(/agreement on labelled turns: 4\/5/); // a, c, d, f agree; b does not; e has no truth
  });

  it("prints score distributions per proxy category", () => {
    const rows = fixture();
    const text = formatTreeReport(rows, new Map(), complete(rows), TREE_BAR_DEFAULTS, perm(rows));
    expect(text).toMatch(/research\s+\(n=1\): breadth 3\.00 \[0\/0\/0\/1\]; reasoning 3\.00 \[0\/0\/0\/1\]; actions 2\.00 \[0\/0\/1\/0\]; gear 0\/0\/1/);
    expect(text).toMatch(/machine_task\s+\(n=1\): breadth 0\.00 \[1\/0\/0\/0\]/);
  });

  // Spec §7: the three costly cells decide whether a wrong route costs Paco a turn, power, or only money.
  it("counts the three costly cells and names the turns of the first two", () => {
    const rows = fixture();
    const text = formatTreeReport(rows, new Map(), complete(rows), TREE_BAR_DEFAULTS, perm(rows));
    expect(text).toMatch(/COSTLY 1 — wrongly into memory\/status \(a swallowed turn\): 1 \[b\]/);
    expect(text).toMatch(/COSTLY 2 — self_change \/ machine_task rated light \(under-powered\): 1 \[c\]/);
    expect(text).toMatch(/COSTLY 3 — lane-shaped turns sent to the planner \(cost only\): 1 \(answer 1\)/);
    expect(text).toMatch(/memory\/status routes on unlabelled turns \(cannot judge; label them\): 1/);
  });

  // Paco commits calibration rows per question; arming `category` alone already moves turns off Default. The report must
  // show each partial commit's effect before he chooses (Codex round 2, blocker 2).
  it("prints one line per arming combination, naming the turns that leave planner/default", () => {
    const rows = fixture();
    const text = formatTreeReport(rows, new Map(), complete(rows), TREE_BAR_DEFAULTS, perm(rows));
    expect(text).toMatch(/arming combinations \(turns whose route changes from the nothing-armed path; from→to \[first ids\]\):/);
    for (const c of ARMING_COMBOS) expect(text).toMatch(new RegExp(`^  ${c.name.replace(/\+/g, "\\+")}: `, "m"));
    // memory needs category + rule: the category-only line can never route a turn into the memory lane
    expect(text).not.toMatch(/^  category: .*→memory\//m);
    // turn b is the fixture's swallowed turn (COSTLY 1): fully armed, it leaves Default for a no-planner lane, named by id
    expect(text).toMatch(/^  all: .*planner\/default→(memory|status)\/\w+ \d+ \[[^\]]*\bb\b/m);
  });

  // The labelling CLI exists to correct the proxy: Paco's label wins over the tool proxy.
  it("a human label overrides the proxy as the truth", () => {
    const rows = fixture();
    const text = formatTreeReport(rows, new Map([["b", label("memory")]]), complete(rows), TREE_BAR_DEFAULTS, perm(rows));
    expect(text).toMatch(/COSTLY 1 — wrongly into memory\/status \(a swallowed turn\): 0/);
    expect(text).toMatch(/1 carry Paco's label/);
  });

  it("prints permutation agreement over the category choice, with n and the Wilson bound", () => {
    const rows = fixture();
    const p = perm(rows); p[0] = { ...p[0]!, answers: treeAnswers({ category: "answer" }) };
    expect(formatTreeReport(rows, new Map(), complete(rows), TREE_BAR_DEFAULTS, p)).toMatch(/permutation: category agreement 5\/6 = 83\.3% \(LB \d/);
    expect(formatTreeReport(rows, new Map(), complete(rows), TREE_BAR_DEFAULTS)).toMatch(/permutation: NOT RUN/);
  });

  // Lessons: a partial run is never evidence. Each blocker alone suppresses the candidate rows.
  it("is INCOMPLETE without the permuted run, on a stop, a failed row, a short universe, stale wording or another model", () => {
    const rows = fixture();
    const blocked = (text: string) => { expect(text).toMatch(/^INCOMPLETE/); expect(text).not.toMatch(/CANDIDATE ROWS/); };
    blocked(formatTreeReport(rows, new Map(), complete(rows), TREE_BAR_DEFAULTS));
    blocked(formatTreeReport(rows, new Map(), { ...complete(rows), stopped: "budget" }, TREE_BAR_DEFAULTS, perm(rows)));
    blocked(formatTreeReport([...rows, row("z", { status: "jev_failed", answers: undefined })], new Map(), { ...complete(rows), universe: 7 }, TREE_BAR_DEFAULTS, perm(rows)));
    blocked(formatTreeReport(rows, new Map(), { ...complete(rows), universe: 9 }, TREE_BAR_DEFAULTS, perm(rows)));
    const stale = rows.map((r, i) => (i === 0 ? { ...r, criteria_hashes: { ...HASHES, breadth: "old" } } : r));
    blocked(formatTreeReport(stale, new Map(), complete(rows), TREE_BAR_DEFAULTS, perm(rows)));
    const other = rows.map((r, i) => (i === 0 ? { ...r, model: "jev-0.9" } : r));
    blocked(formatTreeReport(other, new Map(), complete(rows), TREE_BAR_DEFAULTS, perm(rows)));
    // the alias moved between the canonical and the permuted run: two models' evidence never combine
    blocked(formatTreeReport(rows, new Map(), complete(rows), TREE_BAR_DEFAULTS, perm(rows).map((r) => ({ ...r, model: "jev-1.14.0" }))));
  });

  it("a complete run prints candidate calibration rows for the six questions and the status pseudo-row, approved left empty", () => {
    const rows = fixture();
    const text = formatTreeReport(rows, new Map(), complete(rows), TREE_BAR_DEFAULTS, perm(rows));
    expect(text).not.toMatch(/INCOMPLETE/);
    expect(text).toMatch(/CANDIDATE ROWS — evidence for Paco's decision, not a verdict/);
    for (const q of TREE_QUESTIONS) expect(text).toContain(`"question_id":"${q.id}","criteria_hash":"${criteriaHash(q)}"`);
    expect(text).toContain(`"question_id":"category:status","criteria_hash":"${HASHES.category}"`);
    expect(text).toContain(`"approved":""`);
    // keyed by the model the rows REPORTED, never the request alias (which calibratedLang refuses to arm)
    expect(text).toContain(`"model":"${REPORTED}"`); expect(text).not.toContain(`"model":"jev-latest"`);
    expect(text).not.toContain(`"lang":"en"`); // no en turn in the fixture → no en rows
  });

  it("a dry run has its own headline and no evidence", () => {
    expect(formatTreeReport([row("a", { status: "dry_run" })], new Map(), { spentUsd: 0, estimatedUsd: 0.02, universe: 3, wouldDispatch: 1, alreadyDone: 2, skipped: 0 },
      TREE_BAR_DEFAULTS)).toMatch(/^DRY RUN — universe 3, would dispatch 1, already done 2, skipped 0/);
  });
});
```

- [ ] **Step 1f: Write the failing label tests** — replace `tests/jev/triage-label.test.ts` entirely:

```ts
import { describe, expect, it } from "vitest";
import { parseJevCliFlags, parseLabelAnswer, selectForLabelling } from "../../src/jev/triage-label.js";
import type { TreeReplayRow } from "../../src/jev/triage-replay.js";
import { treeAnswers } from "../helpers/jev-tree-answers.js";

const row = (turn_id: string, o: Partial<TreeReplayRow> = {}): TreeReplayRow => ({ key: turn_id, turn_id, run_id: `r${turn_id}`, lang: "zh", status: "ok",
  est_usd: 0, state_hash: "", tools: {}, proxy: "answer", proxy_rule: "no_tool", pre_judge: "judge", think_harder: false, bare_ack: false, quoted: false,
  answers: treeAnswers({ category: "answer" }), ...o });

// The proxy cannot judge unlabelled turns, and a wrong memory/status route swallows a turn: Paco labels all of those,
// then a random sample of the rest; never a turn he already labelled.
describe("selectForLabelling", () => {
  it("takes every unlabelled-proxy and memory/status turn once, plus the sample, skipping already-labelled", () => {
    const rows = [row("a", { proxy: null, proxy_rule: "ack_after_proposal" }), row("b", { answers: treeAnswers({ category: "memory" }) }),
      row("c", { proxy: "status", proxy_rule: "houge_status" }), row("d", { proxy: "memory", proxy_rule: "lesson_write", answers: treeAnswers({ category: "status" }) }),
      ...Array.from({ length: 50 }, (_, i) => row(`n${i}`))];
    const picked = selectForLabelling(rows, new Map([["a", { category: "answer", by: "paco", at: "" }]]), 5, () => 0.5);
    const ids = picked.map((r) => r.turn_id);
    expect(ids).toEqual(expect.arrayContaining(["b", "c", "d"])); expect(ids).not.toContain("a");
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((x) => x.startsWith("n"))).toHaveLength(5);
  });
});

describe("parseLabelAnswer", () => {
  // A mistyped label must be no label, never the nearest category: a wrong truth corrupts the costly cells.
  it("accepts a category or an unambiguous prefix, and rejects ambiguity and noise", () => {
    expect(parseLabelAnswer("lookup")).toBe("lookup");
    expect(parseLabelAnswer(" Res ")).toBe("research");
    expect(parseLabelAnswer("mach")).toBe("machine_task");
    expect(parseLabelAnswer("m")).toBeNull(); // memory, machine_task, mail_calendar
    expect(parseLabelAnswer("weather")).toBeNull();
    expect(parseLabelAnswer("")).toBeNull();
  });
});

// parseReplayArgs rejects unknown tokens, so --sample / --permute must be stripped before it sees them.
describe("parseJevCliFlags", () => {
  it("strips --sample=N and --permute, leaving the rest for parseReplayArgs", () => {
    expect(parseJevCliFlags(["--sample=40", "--dry-run"])).toEqual({ sample: 40, permute: false, rest: ["--dry-run"] });
    expect(parseJevCliFlags(["--permute", "--limit", "5"])).toEqual({ permute: true, rest: ["--limit", "5"] });
  });
  it("rejects the space form and a non-numeric count", () => {
    expect(() => parseJevCliFlags(["--sample", "40"])).toThrow(/--sample=N/);
    expect(() => parseJevCliFlags(["--sample=abc"])).toThrow(/--sample=N/);
  });
  it("rejects --since in both forms (the replay universe has a fixed epoch)", () => {
    expect(() => parseJevCliFlags(["--since", "2026-10-01T00:00:00Z"])).toThrow(/--since is not supported/);
    expect(() => parseJevCliFlags(["--since=2026-10-01T00:00:00Z"])).toThrow(/--since is not supported/);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/run/replay-reads.test.ts tests/jev/triage-replay.test.ts tests/jev/triage-report.test.ts tests/jev/triage-label.test.ts tests/jev/triage-parity.test.ts`
Expected: FAIL — `store.runLoopCapabilityCounts is not a function`, `getChatTurnById is not a function`; the jev files
fail to import `runTreeReplay` / `proxyLabel` / `formatTreeReport` / `TREE_CATEGORY_PERMUTED` (not exported).

- [ ] **Step 3a: Store** — `src/run/run-store.ts`.

Delete line 42 (`import type { TriageShadowStats } from "../jev/triage-report.js";`).

In `ReplayTurnRow` (`:362-373`), after `recorded_intent: string;` add:

```ts
  /** The stored turn this message quoted (Telegram reply, spec §2.2.1); absent on rows read before the column. */
  quoted_turn_id?: string | null;
```

In `listReplayTurns` (`:1196`), replace

```ts
      SELECT u.turn_id, u.chat_id, u.run_id, u.text, u.created_at,
```

with

```ts
      SELECT u.turn_id, u.chat_id, u.run_id, u.text, u.created_at, u.quoted_turn_id,
```

After `runLoopCapabilities` (ends `:1222`), add:

```ts
  /**
   * `loop_step` rows per capability for a run (unnamed steps dropped). The tree replay's proxy (spec §7) separates
   * research from lookup by how many web steps ran, which the distinct-name read above cannot tell.
   */
  runLoopCapabilityCounts(run_id: string): Record<string, number> {
    const rows = this.db.prepare(`
      SELECT json_extract(payload_json, '$.capability') AS capability, COUNT(*) AS n
      FROM ledger_events WHERE run_id = ? AND event_type = 'loop_step'
      GROUP BY capability
    `).all<{ capability: string | null; n: number }>(run_id);
    const out: Record<string, number> = {};
    for (const r of rows) if (typeof r.capability === "string" && r.capability.length > 0) out[r.capability] = Number(r.n);
    return out;
  }

  /** One chat turn by id (the replay rebuilds a quoted turn from `chat_turns.quoted_turn_id`); undefined if absent. */
  getChatTurnById(turn_id: string): ChatTurnRow | undefined {
    return this.db.prepare(`
      SELECT turn_id, chat_id, run_id, role, text, intent, created_at, quoted_turn_id
      FROM chat_turns WHERE turn_id = ?
    `).get<ChatTurnRow>(turn_id);
  }
```

Delete the whole `triageShadowStats` method with its doc comment (`:1249-1283`, from `/**\n   * The lane 1 live shadow as
the §5.9 step 4 bar reads it` through the closing `}` after `return stats;`). Delete
`tests/run/triage-shadow-stats-store.test.ts` (`git rm`).

- [ ] **Step 3b: Replace `src/jev/triage-replay.ts` entirely:**

```ts
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chatContextSince, resolveChatContextTurnChars, resolveChatContextTurns } from "../capabilities/intent.js";
import { computeCostUsd, JEV_PROVIDER } from "../llm/metered-pricing.js";
import { isBareAck } from "../omp/bare-ack.js";
import type { ReplayTurnRow, RunStore } from "../run/run-store.js";
import { stateHash } from "./decide.js";
import { langOf, type Lang } from "./intent-question.js";
import { JEV_REQUEST_MODEL, type JevAnswer, type JevRequest, type JevResult } from "./jev-client.js";
import { buildTreeState, CATEGORIES, lastHougeTurnOf, quotedTurnFromRow, TREE_CATEGORY, TREE_QUESTIONS, type Category,
  type HougeTurnKind } from "./questions/tree.js";
import { criteriaHash, toJevQuestion, type ChoiceQuestion, type Question } from "./questions/types.js";
import { readDone, runReplayCore, type ReplayCoreOutcome } from "./replay-core.js";
import { preJudge } from "./tree-policy.js";

/**
 * `houge jev replay triage` engine for the decision tree (spec 2026-10-06 §7). Every Telegram turn since the comparator
 * epoch is replayed against the six frozen tree questions on the state the LIVE path would have built (same
 * buildTreeState, lastHougeTurnOf and quoted-turn rebuild; only the broker pass is absent in the CLI), so `state_hash`
 * joins to `jev_decisions.state_hash`. The proxy label comes from the tools the planner actually ran. Rows carry ids,
 * enums and numbers only — never message text.
 *
 * State parity: the thread cut and every `age_s` use the instants the live path recorded on its answered row
 * (`thread_cut_at`, the claim; `state_built_at`, just before the Jev call); a row without them falls back to its write
 * time, else the `triage` event, else the anchor. Known gap: no broker in the CLI.
 */
export const TREE_REPLAY_OUT = ".houge/jev-tree/replay.jsonl";
export const TREE_PERMUTED_OUT = ".houge/jev-tree/replay-permuted.jsonl";
export const TREE_LABELS_PATH = ".houge/jev-tree/labels.jsonl";
/** loop_step.capability exists since 2026-07-02: the proxy label's epoch. */
export const TREE_LABEL_SINCE = "2026-07-02T00:00:00.000Z";
export const TREE_DONE: ReadonlySet<string> = new Set(["ok", "skipped_state_too_large"]);
/** CJK text tokenises ~1.8× worse than chars/3 suggests (2026-09-26 lesson): reserve high, never under. */
const CJK_UNDERCOUNT = 1.8;

export type ProxyRule = "houge_status" | "memory_correct_write" | "lesson_write" | "self_change" | "wiki" | "schedule_task"
  | "mail_calendar" | "machine_task" | "research" | "lookup" | "no_tool" | "ack_after_proposal" | "unmatched_tools";
export interface ProxyLabel { category: Category | null; rule: ProxyRule }
export interface TreeLabel { category: Category; by: "paco"; at: string }
export interface TreeReplayRow {
  key: string; turn_id: string; run_id: string; lang: Lang; status: "ok" | "dry_run" | "skipped_state_too_large" | "jev_failed"; est_usd: number;
  attempt?: number; usd?: number; stop?: "auth" | "fused"; error?: string;
  state_hash: string; tools: Record<string, number>; proxy: Category | null; proxy_rule: ProxyRule;
  pre_judge: "ack_answer" | "judge"; think_harder: boolean; bare_ack: boolean; quoted: boolean;
  model?: string; criteria_hashes?: Record<string, string>; answers?: Record<string, JevAnswer>;
}
type Prepared = TreeReplayRow & { state: Record<string, unknown>; chars: number };
type Tools = Readonly<Record<string, number>>;

const count = (t: Tools, name: string): number => t[name] ?? 0;
const anyTool = (t: Tools, re: RegExp): boolean => Object.keys(t).some((k) => re.test(k));
const webSteps = (t: Tools): number => count(t, "web_search") + count(t, "http_fetch");

/** Spec §7, first match wins: the order IS the precedence (a status check beats the lesson the same turn wrote). */
const PROXY_RULES: ReadonlyArray<readonly [ProxyRule, Category, (t: Tools) => boolean]> = [
  ["houge_status", "status", (t) => count(t, "houge_status") > 0],
  ["memory_correct_write", "memory", (t) => count(t, "memory_correct_write") > 0],
  ["lesson_write", "memory", (t) => count(t, "lesson_write") > 0],
  ["self_change", "self_change", (t) => anyTool(t, /^(self_write_.+|self_diagnose|skill_author)$/)],
  ["wiki", "wiki", (t) => anyTool(t, /^wiki_(build|refine)$/)],
  ["schedule_task", "schedule", (t) => count(t, "schedule_task") > 0],
  ["mail_calendar", "mail_calendar", (t) => anyTool(t, /^(gmail_.+|google_api)$/)],
  ["machine_task", "machine_task", (t) => anyTool(t, /^(shell|shell_external|fs_.+)$/)],
  ["research", "research", (t) => (count(t, "web_search") > 0 && webSteps(t) >= 3) || count(t, "http_fetch") >= 2],
  ["lookup", "lookup", (t) => webSteps(t) > 0 && webSteps(t) <= 2]
];

/**
 * The tool proxy for one run. No rule and no tool → `answer`, unless the previous (or quoted) Houge turn was a proposal:
 * a tool-less "好" there may be agreement whose work never ran, so it is unlabelled. Tools that match no rule are
 * unlabelled too: the spec's `answer` means "no tool".
 */
export function proxyLabel(tools: Tools, prevKind: HougeTurnKind | null): ProxyLabel {
  const hit = PROXY_RULES.find(([, , matches]) => matches(tools));
  if (hit) return { category: hit[1], rule: hit[0] };
  if (Object.keys(tools).length > 0) return { category: null, rule: "unmatched_tools" };
  return prevKind === "proposal" ? { category: null, rule: "ack_after_proposal" } : { category: "answer", rule: "no_tool" };
}

/** `category` asked with its options reversed: the order-bias probe (spec §7 permutation agreement). */
export const TREE_CATEGORY_PERMUTED: ChoiceQuestion = { ...TREE_CATEGORY, criteria: [...TREE_CATEGORY.criteria].reverse() };
export function treeQuestions(permute: boolean): readonly Question[] {
  return permute ? TREE_QUESTIONS.map((q) => (q.id === TREE_CATEGORY.id ? TREE_CATEGORY_PERMUTED : q)) : TREE_QUESTIONS;
}

const CATEGORY_SET: ReadonlySet<string> = new Set(CATEGORIES);
function isLabel(r: Record<string, unknown>): r is Record<string, unknown> & TreeLabel & { turn_id: string } {
  return typeof r.turn_id === "string" && typeof r.category === "string" && CATEGORY_SET.has(r.category) && r.by === "paco" && typeof r.at === "string";
}

/** Paco's labels, keyed by turn_id (a later line overrides an earlier one). A malformed line throws: a dropped label is a silent bias. */
export function loadLabels(path: string): Map<string, TreeLabel> {
  const m = new Map<string, TreeLabel>();
  if (!existsSync(path)) return m;
  readFileSync(path, "utf8").split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    let r: Record<string, unknown>;
    try { r = JSON.parse(line) as Record<string, unknown>; } catch { throw new Error(`labels: line ${i + 1} is not JSON`); }
    if (!isLabel(r)) throw new Error(`labels: line ${i + 1} is not {turn_id, category (one of the 11), by:"paco", at}`);
    m.set(r.turn_id, { category: r.category, by: r.by, at: r.at });
  });
  return m;
}

/** One row per key, latest wins: what the report and the labeller read. */
export function readReplayFile(path: string): TreeReplayRow[] {
  return [...readDone(path, TREE_DONE).values()] as unknown as TreeReplayRow[];
}

export interface TreeReplayDeps {
  store: RunStore; env: NodeJS.ProcessEnv; jev: (req: JevRequest) => Promise<JevResult>; outPath: string; maxUsd: number; dryRun: boolean;
  limit?: number; log?: (l: string) => void; permute?: boolean;
}

function telegramTurns(store: RunStore, limit?: number): ReplayTurnRow[] {
  return store.listReplayTurns({ sinceIso: TREE_LABEL_SINCE, ...(limit !== undefined ? { limit } : {}) })
    .filter((t) => store.runSource(t.run_id) === "telegram");
}

/** The real replay universe, ignoring `--limit` (the report's denominator, not rows.length). */
export function treeUniverse(store: RunStore): number {
  return telegramTurns(store).length;
}

export async function runTreeReplay(d: TreeReplayDeps): Promise<ReplayCoreOutcome<TreeReplayRow>> {
  guardOutPath(d);
  const questions = treeQuestions(d.permute === true);
  const suffix = d.permute ? ":perm" : "";
  const byKey = new Map(telegramTurns(d.store, d.limit).map((t) => [`${t.turn_id}${suffix}`, t]));
  // Reported models seen in this run's evidence, seeded from rows already in the file (a move across a resume still warns).
  const models = new Set<string>(d.dryRun ? [] : [...readDone(d.outPath, TREE_DONE).values()].flatMap((r) => (typeof r.model === "string" ? [r.model] : [])));
  return runReplayCore<TreeReplayRow>({
    source: () => [...byKey.keys()].map((key) => ({ key })),
    doneStatuses: TREE_DONE, outPath: d.outPath, maxUsd: d.maxUsd, dryRun: d.dryRun, ...(d.log ? { log: d.log } : {}),
    estimateUsd: (row) => jevUsd(Math.ceil(((row as Prepared).chars / 3) * CJK_UNDERCOUNT), d.env),
    prepare: async ({ key }) => prepareTurn(d, key, byKey.get(key)!),
    publicRow: (row) => { const { state: _s, chars: _c, ...rest } = row as Prepared; return rest; }, // no text in the outcome
    dispatch: async (row) => dispatchTurn(d, row as Prepared, questions, models)
  });
}

/** A wiring slip must not mix the permuted rows into the canonical file (or back): the report reads each file whole. */
function guardOutPath(d: TreeReplayDeps): void {
  const out = resolve(d.outPath);
  if (d.permute && out === resolve(TREE_REPLAY_OUT)) throw new Error(`a permuted run must not write to the canonical ${TREE_REPLAY_OUT}`);
  if (!d.permute && out === resolve(TREE_PERMUTED_OUT)) throw new Error(`a canonical run must not write to the permuted ${TREE_PERMUTED_OUT}`);
}

/** When the live path cut the thread and built the state: the recorded instants, else the row's write time, else its `triage` event. */
function liveInstantsOf(store: RunStore, run_id: string): { cut: string; before: string; built: string } | undefined {
  const row = store.listJevDecisions(run_id).find((r) => r.point === "triage" && r.status === "answered");
  // Live read with no upper bound right at the cut, so a turn stamped in the cut's own millisecond is in its thread.
  if (row?.thread_cut_at && row.state_built_at) {
    return { cut: row.thread_cut_at, before: new Date(Date.parse(row.thread_cut_at) + 1).toISOString(), built: row.state_built_at };
  }
  const at = row?.created_at ?? store.getLedgerEvents(run_id).find((e) => e.event_type === "triage")?.occurred_at;
  return at ? { cut: at, before: at, built: at } : undefined;
}

function prepareTurn(d: TreeReplayDeps, key: string, t: ReplayTurnRow): Prepared | { skip: TreeReplayRow } {
  const anchor = t.anchor ?? t.created_at;
  const { cut, before, built: builtAt } = liveInstantsOf(d.store, t.run_id) ?? { cut: anchor, before: anchor, built: anchor };
  const recent = d.store.getChatTurnsBefore(t.chat_id, resolveChatContextTurns(d.env), chatContextSince(d.env, new Date(cut)), before, t.run_id);
  const nowMs = Date.parse(builtAt);
  const lastHougeTurn = lastHougeTurnOf(recent, nowMs);
  const quotedRow = t.quoted_turn_id ? d.store.getChatTurnById(t.quoted_turn_id) : undefined;
  const quotedTurn = quotedRow ? quotedTurnFromRow(quotedRow, nowMs) : null;
  const built = buildTreeState({ userText: t.text, recentTurns: recent, turnChars: resolveChatContextTurnChars(d.env), modality: "text",
    lastHougeTurn, quotedTurn });
  const tools = d.store.runLoopCapabilityCounts(t.run_id);
  const proxy = proxyLabel(tools, quotedTurn?.kind === "proposal" ? "proposal" : lastHougeTurn?.kind ?? null);
  const pre = preJudge({ text: t.text, lastHougeTurn, quoted: quotedTurn !== null });
  const base: TreeReplayRow = { key, turn_id: t.turn_id, run_id: t.run_id, lang: langOf(t.text), status: "ok", est_usd: 0,
    state_hash: built.ok ? stateHash(built.state) : "", tools, proxy: proxy.category, proxy_rule: proxy.rule, pre_judge: pre.kind,
    think_harder: pre.kind === "judge" && pre.thinkHarder, bare_ack: isBareAck(t.text), quoted: quotedTurn !== null };
  if (!built.ok) return { skip: { ...base, status: "skipped_state_too_large" } };
  return { ...base, state: built.state, chars: built.chars };
}

/** One request with all six questions (spec §2.3); the answers are stored whole (numbers and option keys only). */
async function dispatchTurn(d: TreeReplayDeps, row: Prepared, questions: readonly Question[], models: Set<string>): Promise<TreeReplayRow> {
  const { state, chars: _chars, ...rest } = row;
  const wire: JevRequest["questions"] = {};
  for (const q of questions) wire[q.id] = toJevQuestion(q);
  const r = await d.jev({ state, questions: wire });
  if (!r.ok) {
    // The reason enum only — never the client's detail string (rows carry ids, enums, numbers).
    const stop = r.reason === "fused" ? "fused" : r.reason === "auth" || r.reason === "no_key" ? "auth" : undefined;
    return { ...rest, status: "jev_failed", error: r.reason, ...(stop ? { stop } : {}) };
  }
  if (models.size > 0 && !models.has(r.model)) {
    d.log?.(`warning: Jev reported model "${r.model}" mid-run, earlier rows reported ${[...models].join(", ")} — the report refuses mixed models`);
  }
  models.add(r.model);
  return { ...rest, status: "ok", usd: jevUsd(r.input_tokens, d.env), model: r.model,
    criteria_hashes: Object.fromEntries(questions.map((q) => [q.id, criteriaHash(q)])), answers: r.answers };
}

/** Priced by the "jev-" prefix row in metered-pricing, which matches the alias and every versioned id alike. */
function jevUsd(tokens: number, env: NodeJS.ProcessEnv): number {
  return computeCostUsd(JEV_PROVIDER, JEV_REQUEST_MODEL, { input_tokens: tokens, output_tokens: 0, cached_input_tokens: 0 }, env) ?? 0;
}
```

- [ ] **Step 3c: Replace `src/jev/triage-report.ts` entirely:**

```ts
import type { CalibrationRow } from "./calibration.js";
import { CATEGORIES, TREE_CATEGORY, TREE_QUESTIONS, type Category } from "./questions/tree.js";
import { criteriaHash } from "./questions/types.js";
import { ACK_ROUTE, applyCascade, routeTree, type Armed, type Route, type TreeBars } from "./tree-policy.js";
import { treeQuestions, type TreeLabel, type TreeReplayRow } from "./triage-replay.js";
import { wilsonLower } from "./wilson.js";

/**
 * The decision-tree replay report (spec 2026-10-06 §7): evidence for Paco's arm decision, never a verdict. Truth per
 * turn is Paco's label when he gave one, else the tool proxy; unlabelled acks and unmatched-tool turns have no truth and
 * are counted apart. Routes are recomputed from the stored answers through the live policy (`routeTree`) as if every
 * decision were armed, so the bars printed are the bars used. Partial evidence is INCOMPLETE and prints no rows.
 */
export interface TreeReportOutcome {
  spentUsd: number; estimatedUsd: number; stopped?: string;
  universe?: number; wouldDispatch?: number; alreadyDone?: number; skipped?: number; limited?: boolean;
}

const ALL_ARMED: Armed = { category: true, status: true, memory: true, gear: true, rule: true };
/** The status lane's own arming pseudo-row (contract: `treeArmed`), hashed as the `category` question it reads. */
const STATUS_ARM_ID = "category:status";
const SCORE_IDS = ["breadth", "reasoning", "actions"] as const;
/** Categories with a lane in the spec's end state (§3): sending them to the planner costs money, not a turn. */
const LANE_SHAPED: ReadonlySet<Category> = new Set(["answer", "lookup", "memory", "schedule", "wiki", "status"]);
/** §2.1: a bare ack after a plain answer is settled by code, before the judge. */
const TRUTHS: ReadonlyArray<Category | null> = [...CATEGORIES, null];

const pct = (a: number, n: number): string => (n === 0 ? "n/a" : `${((100 * a) / n).toFixed(1)}%`);
const lb = (a: number, n: number): string => { const w = wilsonLower(a, n); return w === null ? "LB n/a" : `LB ${(100 * w).toFixed(1)}%`; };
const truthOf = (r: TreeReplayRow, labels: Map<string, TreeLabel>): Category | null => labels.get(r.turn_id)?.category ?? r.proxy;
const truthName = (t: Category | null): string => (t ?? "unlabelled").padEnd(13);
const choiceOf = (r: TreeReplayRow): string | null => { const a = r.answers?.category; return a?.type === "choice" ? a.choice : null; };
const scoreOf = (r: TreeReplayRow, id: string): number | null => { const a = r.answers?.[id]; return a?.type === "score" ? a.score : null; };
/** The replay row is a correction only by its proxy (a human label says `memory`, not which kind). */
const isCorrection = (r: TreeReplayRow, labels: Map<string, TreeLabel>): boolean => !labels.has(r.turn_id) && r.proxy_rule === "memory_correct_write";
const tally = (m: Map<string, number>, k: string): void => { m.set(k, (m.get(k) ?? 0) + 1); };
const fmt = (m: Map<string, number>): string => [...m].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ") || "none";

/** Gear from the highest of the three scores at the given bars (spec §2.4); null when a score is missing. */
function gearOf(r: TreeReplayRow, bars: TreeBars): "light" | "standard" | "heavy" | null {
  const s = SCORE_IDS.map((id) => scoreOf(r, id));
  if (s.some((x) => x === null)) return null;
  const m = Math.max(...(s as number[]));
  return m <= bars.gearLight ? "light" : m < bars.gearHeavy ? "standard" : "heavy";
}

/**
 * The route the live policy would take on these answers once armed. The replay makes no model call, so a below-bar plan
 * settles as a FAILED live cascade (Decision 14): `applyCascade(plan, null)`, Default, nothing saved, flagged `cascade`
 * so the report counts the turns a live Tiny call would decide.
 */
export function replayRoute(r: TreeReplayRow, bars: TreeBars, armed: Armed = ALL_ARMED): { route: Route; cascade: boolean } | null {
  if (!r.answers) return null;
  if (r.pre_judge === "ack_answer") return { route: ACK_ROUTE, cascade: false };
  const plan = routeTree(r.answers, { bars, armed, thinkHarder: r.think_harder, bareAck: r.bare_ack });
  return plan.kind === "final" ? { route: plan.route, cascade: false } : { route: applyCascade(plan, null), cascade: true };
}

/** Truth → Jev's `category` choice, one line per truth, and the diagonal over turns that have a truth. */
function confusionLines(ok: TreeReplayRow[], labels: Map<string, TreeLabel>): string[] {
  const out = ["confusion (truth → Jev category; truth = Paco's label, else the tool proxy):"];
  let agree = 0; let n = 0;
  for (const truth of TRUTHS) {
    const L = ok.filter((r) => truthOf(r, labels) === truth);
    if (L.length === 0) continue;
    const cells = new Map<string, number>();
    for (const r of L) tally(cells, choiceOf(r) ?? "?");
    if (truth !== null) { n += L.length; agree += cells.get(truth) ?? 0; }
    out.push(`  ${truthName(truth)} (n=${L.length}): ${fmt(cells)}`);
  }
  out.push(`  agreement on labelled turns: ${agree}/${n} = ${pct(agree, n)} (${lb(agree, n)})`);
  return out;
}

function scoreSummary(id: string, xs: number[]): string {
  if (xs.length === 0) return `${id} n/a`;
  const h = [0, 0, 0, 0];
  for (const x of xs) h[Math.min(3, Math.max(0, Math.round(x)))]! += 1;
  return `${id} ${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2)} [${h.join("/")}]`;
}

/** Per truth: each score's mean and its level histogram, then the gear split it produces. */
function scoreLines(ok: TreeReplayRow[], labels: Map<string, TreeLabel>, bars: TreeBars): string[] {
  const out = ["scores per truth (mean [levels 0/1/2/3]; gear light/standard/heavy):"];
  for (const truth of TRUTHS) {
    const L = ok.filter((r) => truthOf(r, labels) === truth);
    if (L.length === 0) continue;
    const parts = SCORE_IDS.map((id) => scoreSummary(id, L.map((r) => scoreOf(r, id)).filter((x): x is number => x !== null)));
    const g = { light: 0, standard: 0, heavy: 0 };
    for (const r of L) { const k = gearOf(r, bars); if (k) g[k] += 1; }
    out.push(`  ${truthName(truth)} (n=${L.length}): ${parts.join("; ")}; gear ${g.light}/${g.standard}/${g.heavy}`);
  }
  return out;
}

function routeLines(ok: TreeReplayRow[], bars: TreeBars): string[] {
  const lanes = new Map<string, number>(); const reasons = new Map<string, number>(); let cascades = 0;
  for (const r of ok) {
    const x = replayRoute(r, bars);
    if (!x) continue;
    tally(lanes, `${x.route.lane}/${x.route.role}`); tally(reasons, x.route.reason);
    if (x.cascade) cascades += 1;
  }
  return [`routes as if armed (lane/role): ${fmt(lanes)}`,
    `route reasons: ${fmt(reasons)}; below-bar turns a live cascade would ask the Tiny role about (replayed as cascade_failed, no model call): ${cascades}`];
}

/**
 * Arming is coupled (Decision: arming couplings): `memory` needs `category` + `rule`, and `category` alone already moves
 * turns off Default. Paco commits rows per question, so the report shows what each partial commit would change.
 */
const NONE_ARMED: Armed = { category: false, status: false, memory: false, gear: false, rule: false };
export const ARMING_COMBOS: ReadonlyArray<{ name: string; armed: Armed }> = [
  { name: "category", armed: { ...NONE_ARMED, category: true } },
  { name: "category+gear", armed: { ...NONE_ARMED, category: true, gear: true } },
  { name: "category+rule", armed: { ...NONE_ARMED, category: true, rule: true, memory: true } },
  { name: "category+rule+status", armed: { ...NONE_ARMED, category: true, rule: true, memory: true, status: true } },
  { name: "all", armed: ALL_ARMED }
];
const ARMING_IDS_SHOWN = 10;

/**
 * Per combination: turns whose lane/role differs from that turn's own route with nothing armed (the path stage A runs
 * until Paco commits rows: Default, except the ack rule and `think harder`), keyed `from→to`, with their turn ids.
 */
function armingLines(ok: TreeReplayRow[], bars: TreeBars): string[] {
  const out = ["arming combinations (turns whose route changes from the nothing-armed path; from→to [first ids]):"];
  const at = (x: { route: Route } | null): string => (x ? `${x.route.lane}/${x.route.role}` : "none");
  for (const c of ARMING_COMBOS) {
    const moved = new Map<string, string[]>();
    for (const r of ok) {
      const before = at(replayRoute(r, bars, NONE_ARMED)); const after = at(replayRoute(r, bars, c.armed));
      if (before === after) continue;
      const k = `${before}→${after}`;
      moved.set(k, [...(moved.get(k) ?? []), r.turn_id]);
    }
    const parts = [...moved].sort((a, b) => b[1].length - a[1].length)
      .map(([k, ids]) => `${k} ${ids.length} [${ids.slice(0, ARMING_IDS_SHOWN).join(", ")}]`);
    out.push(`  ${c.name}: ${parts.join("; ") || "none"}`);
  }
  return out;
}

interface Costly { swallowed: string[]; underPowered: string[]; laneToPlanner: Map<string, number>; unjudged: number }
/** Spec §7's three costly cells: a swallowed turn, an under-powered one, and a lane-shaped turn sent to the planner. */
function costlyCells(ok: TreeReplayRow[], labels: Map<string, TreeLabel>, bars: TreeBars): Costly {
  const c: Costly = { swallowed: [], underPowered: [], laneToPlanner: new Map(), unjudged: 0 };
  for (const r of ok) {
    const routed = replayRoute(r, bars); const truth = truthOf(r, labels);
    if (!routed) continue;
    const lane = routed.route.lane;
    if (truth === null) { if (lane !== "planner") c.unjudged += 1; continue; }
    const wrongMemory = lane === "memory" && (truth !== "memory" || isCorrection(r, labels));
    if (wrongMemory || (lane === "status" && truth !== "status")) c.swallowed.push(r.turn_id);
    if ((truth === "self_change" || truth === "machine_task") && gearOf(r, bars) === "light") c.underPowered.push(r.turn_id);
    if (lane === "planner" && LANE_SHAPED.has(truth) && !isCorrection(r, labels)) tally(c.laneToPlanner, truth);
  }
  return c;
}

function costlyLines(c: Costly): string[] {
  const ids = (xs: string[]) => (xs.length === 0 ? "" : ` [${xs.slice(0, 20).join(", ")}${xs.length > 20 ? ", …" : ""}]`);
  const toPlanner = [...c.laneToPlanner.values()].reduce((a, b) => a + b, 0);
  return [
    `COSTLY 1 — wrongly into memory/status (a swallowed turn): ${c.swallowed.length}${ids(c.swallowed)}`,
    `COSTLY 2 — self_change / machine_task rated light (under-powered): ${c.underPowered.length}${ids(c.underPowered)}`,
    `COSTLY 3 — lane-shaped turns sent to the planner (cost only): ${toPlanner} (${fmt(c.laneToPlanner)})`,
    `  memory/status routes on unlabelled turns (cannot judge; label them): ${c.unjudged}`
  ];
}

/** Order bias: the same turns with `category` reversed; agreement of the category choice. */
function permutationLine(ok: TreeReplayRow[], permuted: TreeReplayRow[] | undefined): string {
  if (!permuted) return "permutation: NOT RUN (houge jev replay triage --permute)";
  const perm = new Map(permuted.filter((r) => r.status === "ok").map((r) => [r.turn_id, r]));
  const pairs = ok.filter((r) => perm.has(r.turn_id)).map((r) => [r, perm.get(r.turn_id)!] as const);
  const same = pairs.filter(([a, b]) => choiceOf(a) === choiceOf(b)).length;
  return `permutation: category agreement ${same}/${pairs.length} = ${pct(same, pairs.length)} (${lb(same, pairs.length)})`;
}

const hashesOf = (permute: boolean): Record<string, string> => Object.fromEntries(treeQuestions(permute).map((q) => [q.id, criteriaHash(q)]));
const stale = (r: TreeReplayRow, want: Record<string, string>): boolean => Object.entries(want).some(([id, h]) => r.criteria_hashes?.[id] !== h);

/** Everything that makes the evidence partial: any one → INCOMPLETE, no rows. */
function blockersOf(rows: TreeReplayRow[], ok: TreeReplayRow[], o: TreeReportOutcome, permuted?: TreeReplayRow[]): string[] {
  const b: string[] = [];
  if (o.stopped) b.push(`stopped: ${o.stopped}`);
  if (o.limited) b.push("--limit set: not the full universe");
  const finished = rows.filter((r) => r.status === "ok" || r.status === "skipped_state_too_large").length;
  if (o.universe === undefined) b.push("universe size unknown");
  else if (finished < o.universe) b.push(`${finished} of ${o.universe} turns finished`);
  const failed = rows.filter((r) => r.status === "jev_failed").length;
  if (failed > 0) b.push(`${failed} jev_failed row(s): re-run to retry them`);
  const permOk = (permuted ?? []).filter((r) => r.status === "ok");
  const models = reportedModels([...ok, ...permOk]);
  if (models.length > 1) b.push(`more than one reported model (${models.join(", ")}): re-run into a fresh file`);
  if (ok.some((r) => stale(r, hashesOf(false))) || permOk.some((r) => stale(r, hashesOf(true)))) b.push("rows asked with stale criteria wording: re-run into a fresh file");
  const covered = new Set(permOk.map((r) => r.turn_id));
  if (!permuted) b.push("permuted run missing");
  else if (ok.some((r) => !covered.has(r.turn_id))) b.push("permuted run does not cover every replayed turn");
  return b;
}

/** Every model the ok rows REPORTED, sorted. The request names the alias `jev-latest`, so the rows, not a constant, say
 *  which model the evidence is for; more than one means the alias moved mid-replay (a blocker). */
const reportedModels = (rows: TreeReplayRow[]): string[] =>
  [...new Set(rows.filter((r) => r.status === "ok" && r.model !== undefined).map((r) => r.model!))].sort();

/** Candidate rows for the six questions and the status pseudo-row, per language present, keyed by the one reported model
 *  (no blocker means exactly one); Paco fills `approved`. */
function candidateRows(ok: TreeReplayRow[]): string[] {
  const model = reportedModels(ok)[0]!;
  const ids = [...TREE_QUESTIONS.map((q) => [q.id, criteriaHash(q)] as const), [STATUS_ARM_ID, criteriaHash(TREE_CATEGORY)] as const];
  const out = ["CANDIDATE ROWS — evidence for Paco's decision, not a verdict; he fills `approved` and commits them into CALIBRATED_ROWS (src/jev/calibration.ts):"];
  for (const lang of ["zh", "en"] as const) {
    const n = ok.filter((r) => (r.lang === "en" ? "en" : "zh") === lang).length; // `mixed` inherits zh (calibratedLang)
    if (n === 0) continue;
    for (const [question_id, criteria_hash] of ids) {
      const row: CalibrationRow = { question_id, criteria_hash, model, lang, approved: "", evidence: `tree replay ${n} ${lang} turns` };
      out.push(JSON.stringify(row));
    }
  }
  return out;
}

function headLine(ok: TreeReplayRow[], labels: Map<string, TreeLabel>): string {
  const en = ok.filter((r) => r.lang === "en").length;
  const human = ok.filter((r) => labels.has(r.turn_id)).length;
  const none = ok.filter((r) => truthOf(r, labels) === null).length;
  return `turns: ${ok.length} replayed (zh incl. mixed ${ok.length - en}, en ${en}); ${human} carry Paco's label; ${none} without a truth (ack after a proposal, unmatched tools)`;
}

export function formatTreeReport(rows: TreeReplayRow[], labels: Map<string, TreeLabel>, outcome: TreeReportOutcome, bars: TreeBars,
  permuted?: TreeReplayRow[]): string {
  if (rows.some((r) => r.status === "dry_run")) {
    return `DRY RUN — universe ${outcome.universe ?? "?"}, would dispatch ${outcome.wouldDispatch ?? "?"}, already done ${outcome.alreadyDone ?? "?"}, ` +
      `skipped ${outcome.skipped ?? "?"}; est. $${outcome.estimatedUsd.toFixed(3)}; nothing dispatched, no evidence.`;
  }
  const ok = rows.filter((r) => r.status === "ok");
  const blockers = blockersOf(rows, ok, outcome, permuted);
  const out = blockers.length > 0 ? [`INCOMPLETE — ${blockers.join("; ")}. The numbers below are NOT evidence for arming.`] : [];
  out.push(headLine(ok, labels), ...confusionLines(ok, labels), ...scoreLines(ok, labels, bars), ...routeLines(ok, bars), ...armingLines(ok, bars),
    ...costlyLines(costlyCells(ok, labels, bars)), permutationLine(ok, permuted));
  out.push(`bars: choice ≥ ${bars.choice}, memory ≥ ${bars.memory}, status ≥ ${bars.status}, conf ≥ ${bars.minConf}, gap ≥ ${bars.minGap}, ` +
    `rule yes ≥ ${bars.nounYes} / no ≤ ${bars.nounNo}, rule_scope ≥ ${bars.ruleScope}, gear light ≤ ${bars.gearLight} / heavy ≥ ${bars.gearHeavy}`);
  out.push(`spent $${outcome.spentUsd.toFixed(3)} of est. $${outcome.estimatedUsd.toFixed(3)}`);
  out.push(...(blockers.length === 0 ? candidateRows(ok) : [`NO ROWS — ${blockers.join("; ")}`]));
  return out.join("\n");
}
```

- [ ] **Step 3d: Replace `src/jev/triage-label.ts` entirely:**

```ts
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import type { RunStore } from "../run/run-store.js";
import { CATEGORIES, type Category } from "./questions/tree.js";
import { TREE_LABEL_SINCE, type TreeLabel, type TreeReplayRow } from "./triage-replay.js";

const jevChoice = (r: TreeReplayRow): string | null => { const a = r.answers?.category; return a?.type === "choice" ? a.choice : null; };

/**
 * Paco's labelling sitting (spec §7: "the labelling CLI stays for tuning the bars"). Must-label: every turn the tool
 * proxy cannot judge, and every turn the proxy or Jev puts in a no-planner lane (a wrong one swallows a turn); then a
 * random sample of the rest. Already-labelled turns are never asked again.
 */
export function selectForLabelling(rows: TreeReplayRow[], existing: Map<string, TreeLabel>, sample: number, rng: () => number = Math.random): TreeReplayRow[] {
  const fresh = rows.filter((r) => r.status === "ok" && !existing.has(r.turn_id));
  const lane = (c: string | null) => c === "memory" || c === "status";
  const must = fresh.filter((r) => r.proxy === null || lane(r.proxy) || lane(jevChoice(r)));
  const rest = fresh.filter((r) => !must.includes(r));
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [rest[i], rest[j]] = [rest[j]!, rest[i]!]; }
  return [...must, ...rest.slice(0, sample)];
}

/** A category name or an unambiguous prefix of one ("mach" → machine_task); anything else is no label, never a guess. */
export function parseLabelAnswer(line: string): Category | null {
  const t = line.trim().toLowerCase();
  if (!t) return null;
  const exact = CATEGORIES.find((c) => c === t);
  if (exact) return exact;
  const hits = CATEGORIES.filter((c) => c.startsWith(t));
  return hits.length === 1 ? hits[0]! : null;
}

/**
 * The `jev` flags parseReplayArgs does not know (it rejects unknown tokens): `--sample=N` (the `=` form only) and
 * `--permute` are taken out here, the rest passes through. Throws on a malformed `--sample`.
 */
export function parseJevCliFlags(argv: string[]): { sample?: number; permute: boolean; rest: string[] } {
  let sample: number | undefined; let permute = false; const rest: string[] = [];
  for (const a of argv) {
    if (a === "--permute") { permute = true; continue; }
    if (a === "--since" || a.startsWith("--since=")) {
      throw new Error(`--since is not supported for jev … triage: the universe is every Telegram turn since ${TREE_LABEL_SINCE}`);
    }
    if (a === "--sample" || a.startsWith("--sample=")) {
      const v = a.slice("--sample=".length);
      if (!a.startsWith("--sample=") || !/^\d+$/.test(v)) throw new Error(`bad argument "${a}": use --sample=N (with "=", N a whole number)`);
      sample = Number(v); continue;
    }
    rest.push(a);
  }
  return { ...(sample !== undefined ? { sample } : {}), permute, rest };
}

/** Terminal only: prints the stored turn text (local DB, never egress) and reads one category per turn. Enter skips. */
export async function labelInteractively(i: { rows: TreeReplayRow[]; store: RunStore; labelsPath: string; input: NodeJS.ReadableStream; output: NodeJS.WritableStream; now?: () => Date }): Promise<number> {
  mkdirSync(dirname(i.labelsPath), { recursive: true });
  const rl = createInterface({ input: i.input, output: i.output });
  const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));
  let n = 0;
  try {
    i.output.write(`Answer per turn with a category (or an unambiguous prefix): ${CATEGORIES.join(", ")}. Enter = skip.\n`);
    for (const [idx, r] of i.rows.entries()) {
      const text = i.store.userTurnTextForRun(r.run_id) ?? "(text missing)";
      i.output.write(`\n[${idx + 1}/${i.rows.length}] jev=${jevChoice(r) ?? "-"} proxy=${r.proxy ?? "unlabelled"} (${r.proxy_rule})\n${text}\n`);
      const category = parseLabelAnswer(await ask("> "));
      if (!category) continue;
      appendFileSync(i.labelsPath, `${JSON.stringify({ turn_id: r.turn_id, category, by: "paco", at: (i.now?.() ?? new Date()).toISOString() })}\n`);
      n++;
    }
  } finally { rl.close(); }
  return n;
}
```

- [ ] **Step 3e: CLI** — in `src/cli.ts`, replace the whole `jev` branch, from
  `} else if (command === \`jev\`) { // backticks: panel-judge-providers.test greps src …` (`:311`) through the
  `} finally {\n    store.close();\n  }` that precedes `} else if (command === "jev-shadow") {` (`:374-376`), with:

```ts
} else if (command === `jev`) { // backticks: panel-judge-providers.test greps src for the double-quoted provider name; this is the subcommand, not a provider
  // Decision-tree calibration (spec 2026-10-06 §7): replay the six tree questions over history, label by hand, report the evidence.
  const sub = rest[0];
  if (rest[1] !== "triage" || !["replay", "label", "report"].includes(sub ?? "")) {
    console.error("Usage: houge jev replay triage [--dry-run] [--max-usd N] [--limit N] [--permute] | houge jev label triage [--sample=N] | houge jev report triage");
    process.exit(1);
  }
  if (readTombstone()) {
    console.error(formatTombstoneParkedMessage(resolveTombstonePath(process.env)));
    process.exit(1);
  }
  const { parseJevCliFlags } = await import("./jev/triage-label.js");
  const { parseReplayArgs } = await import("./jev/replay.js");
  let flags: ReturnType<typeof parseJevCliFlags>;
  try { flags = parseJevCliFlags(rest.slice(2)); } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }
  const args = parseReplayArgs(flags.rest);
  if (!args.ok) {
    console.error(args.error);
    process.exit(1);
  }
  const T = await import("./jev/triage-replay.js");
  const store = RunStore.open("houge.sqlite", storeOptions);
  try {
    if (sub === "label") {
      const { labelInteractively, selectForLabelling } = await import("./jev/triage-label.js");
      const picked = selectForLabelling(T.readReplayFile(T.TREE_REPLAY_OUT), T.loadLabels(T.TREE_LABELS_PATH), flags.sample ?? 40);
      const n = await labelInteractively({ rows: picked, store, labelsPath: T.TREE_LABELS_PATH, input: process.stdin, output: process.stdout });
      console.error(`labelled ${n} of ${picked.length}`);
    } else {
      const { formatTreeReport } = await import("./jev/triage-report.js");
      const { TREE_BAR_DEFAULTS } = await import("./jev/tree-policy.js");
      const universe = T.treeUniverse(store);
      console.error(`replay universe: ${universe} Telegram turns since ${T.TREE_LABEL_SINCE} (the spec counted 305 runs on 2026-10-06; a different number is information, not an error)`);
      let outcome: import("./jev/triage-report.js").TreeReportOutcome = { spentUsd: 0, estimatedUsd: 0, universe, ...(args.limit !== undefined ? { limited: true } : {}) };
      let rows: import("./jev/triage-replay.js").TreeReplayRow[];
      if (sub === "replay") {
        const { createJevClient } = await import("./jev/jev-client.js");
        const jev = createJevClient({
          apiKey: broker ? broker.typesafeKey() : process.env.TYPESAFE_API_KEY,
          audit: store.llmAuditSink({ correlation_id: "cli:jev-tree-replay", role: "triage" }),
          meteredBreached: () => store.meteredFuseLatched(),
          retries: 3,
          timeoutMs: 15_000
        });
        const run = await T.runTreeReplay({ store, env: process.env, jev, outPath: flags.permute ? T.TREE_PERMUTED_OUT : T.TREE_REPLAY_OUT, maxUsd: args.maxUsd,
          dryRun: args.dryRun, permute: flags.permute, ...(args.limit !== undefined ? { limit: args.limit } : {}), log: (l) => console.error(l) });
        // One row per key, latest wins (the file), never this run's raw rows; a dry run writes nothing, so its own rows speak.
        rows = args.dryRun ? run.rows : T.readReplayFile(T.TREE_REPLAY_OUT);
        outcome = { ...outcome, spentUsd: run.spentUsd, estimatedUsd: run.estimatedUsd, wouldDispatch: run.wouldDispatch, alreadyDone: run.alreadyDone, skipped: run.skipped,
          ...(run.stopped ? { stopped: run.stopped } : {}) };
        process.exitCode = run.stopped ? 1 : 0;
      } else {
        rows = T.readReplayFile(T.TREE_REPLAY_OUT);
      }
      const permuted = T.readReplayFile(T.TREE_PERMUTED_OUT); // no file = "NOT RUN", not "covers nothing"
      console.log(formatTreeReport(rows, T.loadLabels(T.TREE_LABELS_PATH), outcome, TREE_BAR_DEFAULTS, permuted.length > 0 ? permuted : undefined));
    }
  } finally {
    store.close();
  }
```

  Check no other caller is left: `grep -rn "triageShadowStats\|TriageShadowStats\|TriageReplayRow\|runTriageReplay\|formatTriageReport\|TRIAGE_LANE_PERMUTED\|TRIAGE_REPLAY_OUT\|replayVerdict" src tests scripts`
  → expected: no hit in `src/` or `tests/`. A hit in `scripts/live-gate-jev-triage.mjs` is that retired gate's (Task 13
  replaces it with `live-gate-jev-tree.mjs`; if Task 13 keeps the old script, it must not import these).

- [ ] **Step 3f: Remove the lane 1 orphans (Rev 5; Task 10's hand-off, which no task carried out before)**

After Steps 3b–3e nothing in `src/` imports `src/jev/questions/triage.ts` or `src/jev/thresholds.ts` (Task 10 removed
`core-worker.ts`'s imports, Step 3e the CLI's, Steps 3b/3c the replay's and report's). `thresholds.ts` also holds lane 1's
`armingRows`, which Task 5's `treeArmingRows` replaced. Delete both files and move the test cases that still guard live
code:

1. Create `tests/jev/calibration.test.ts` (the `calibratedLang` / `calibrationRows` / alias cases of
   `tests/jev/thresholds.test.ts`, re-keyed on the tree's `category` question):

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CALIBRATED_ROWS, calibratedLang, calibrationRows, type CalibrationRow } from "../../src/jev/calibration.js";
import { JEV_REQUEST_MODEL } from "../../src/jev/jev-client.js";
import { TREE_CATEGORY } from "../../src/jev/questions/tree.js";
import { criteriaHash } from "../../src/jev/questions/types.js";

/** The versioned id Jev REPORTS (the request sends the moving alias `jev-latest`); calibration rows key on it. */
const REPORTED = "jev-1.13.0";
const H = criteriaHash(TREE_CATEGORY);
const row = (o: Partial<CalibrationRow> = {}): CalibrationRow =>
  ({ question_id: "category", criteria_hash: H, model: REPORTED, lang: "zh", approved: "test", evidence: "test", ...o });

// A row arms one (question, wording hash, reported model, language). Any other key must not arm: a wrong arm lets Jev
// act on evidence gathered for a different question, wording or model.
describe("calibratedLang", () => {
  it("a row for another model or another hash does not calibrate; mixed inherits zh", () => {
    const rows = [row()];
    expect(calibratedLang("category", H, "jev-1.14.0", "zh", rows)).toBeUndefined();
    expect(calibratedLang("category", "deadbeef", REPORTED, "zh", rows)).toBeUndefined();
    expect(calibratedLang("category", H, REPORTED, "mixed", rows)).toBe("zh");
    expect(calibratedLang("category", H, REPORTED, "en", rows)).toBeUndefined();
  });
  // A row naming the moving alias would keep arming after TypeSafe moves it: exactly the silent change rows must catch.
  it("never arms on the request alias, even when a row names it and Jev reports it", () => {
    expect(calibratedLang("category", H, JEV_REQUEST_MODEL, "zh", [row({ model: JEV_REQUEST_MODEL })])).toBeUndefined();
  });
});

describe("calibrationRows", () => {
  afterEach(() => vi.restoreAllMocks());
  it("returns the committed constant without an override, the file rows with one", () => {
    expect(calibrationRows({})).toBe(CALIBRATED_ROWS);
    const f = join(mkdtempSync(join(tmpdir(), "jev-cal-")), "rows.json");
    writeFileSync(f, JSON.stringify([row(), row({ lang: "en" })]));
    expect(calibrationRows({ HOUGE_JEV_CALIBRATION_FILE: f })).toHaveLength(2);
  });
  // An arming file of the wrong shape must arm nothing and must not fail silently; the stderr line names the path only.
  it.each([
    ["not an array", { rows: [] }],
    ["a row with a non-string field", [{ question_id: "category", criteria_hash: 7, model: "m", lang: "zh", approved: "a", evidence: "e" }]],
    ["a row with a lang outside zh|en", [{ question_id: "category", criteria_hash: "h", model: "m", lang: "mixed", approved: "a", evidence: "e" }]],
    ["a null row", [null]]
  ])("a file that is %s → [] and one stderr line naming the path, never the contents", (_label, body) => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = join(mkdtempSync(join(tmpdir(), "jev-cal-")), "bad-SECRETMARK.json");
    writeFileSync(f, JSON.stringify(body));
    expect(calibrationRows({ HOUGE_JEV_CALIBRATION_FILE: f })).toEqual([]);
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0]![0])).toContain(f);
    expect(String(err.mock.calls[0]![0])).not.toContain("question_id");
  });
  it("an unreadable file → [] and one stderr line naming the path", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = join(mkdtempSync(join(tmpdir(), "jev-cal-")), "missing.json");
    expect(calibrationRows({ HOUGE_JEV_CALIBRATION_FILE: f })).toEqual([]);
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0]![0])).toContain(f);
  });
});
```

2. `tests/jev/questions.test.ts`: delete the `lastHougeTurnOf` and `buildTriageState` describes (Task 3's
   `tests/jev/tree-questions.test.ts` covers `lastHougeTurnOf` and `buildTreeState`, the one builder live and replay now
   share), delete the four `TRIAGE_*` lines of the "renders the criteria object in listed order" case (its first
   `expect` stays; the tree's option order is pinned by `tree-questions.test.ts`) and rename that case "renders the
   criteria object in listed order", and drop the `questions/triage.js` import line. Every other case stays.
3. `tests/jev/decide.test.ts`: `decide()` is question-agnostic, so the three lane 1 questions become fixture data. Replace
   the import `import { TRIAGE_QUESTIONS } from "../../src/jev/questions/triage.js";` with a local
   `const TRIAGE_QUESTIONS: readonly Question[] = [ … ];` holding the three objects copied verbatim from
   `src/jev/questions/triage.ts` (`TRIAGE_LANE`, `TRIAGE_COMPLETE`, `TRIAGE_SCOPE`, after Task 1's `ChoiceQuestion`
   typing) under a one-line comment saying so; `Question` is already imported from `questions/types.js` (Task 2's line 5).
4. `git rm src/jev/questions/triage.ts src/jev/thresholds.ts tests/jev/thresholds.test.ts`.

Run: `grep -rn "questions/triage\|jev/thresholds\|armingRows\|TRIAGE_STATUS_ARM_ID\|triageVerdict" src tests`
Expected: no hit (`scripts/live-gate-jev-triage.mjs` still imports them until Task 13 Step 4 removes it; `npm run build`
does not compile `scripts/`).

- [ ] **Step 4: Run tests, typecheck, build**

Run: `npx vitest run tests/run/replay-reads.test.ts tests/jev/triage-replay.test.ts tests/jev/triage-report.test.ts tests/jev/triage-label.test.ts tests/jev/triage-parity.test.ts tests/jev/replay-core.test.ts tests/jev/replay.test.ts tests/jev/replay-report.test.ts`
Expected: PASS, none skipped (the last three are unchanged files: proof the shared core and the jev-shadow replay still work).

Run: `npm run typecheck && npm test && npm run build` — read the exit status directly (`echo $status` in fish), not
through a pipe. Expected: exit 0.

Smoke the CLI on a DB copy, dry run only (no Jev spend): `cp houge.sqlite /tmp/hg-replay.sqlite` is NOT how the CLI
opens its DB (it opens `houge.sqlite` in the cwd), so run from a scratch dir holding a `VACUUM INTO` copy:
`mkdir -p $SCRATCH/replay && sqlite3 houge.sqlite "VACUUM INTO '$SCRATCH/replay/houge.sqlite'" && cd $SCRATCH/replay && HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node /Users/xiaochuan/Projects/adventure/dist/cli.js jev replay triage --dry-run`
Expected: `replay universe: N Telegram turns since 2026-07-02…` on stderr and a `DRY RUN — universe N, would dispatch N…`
line; paste both into the task report. (The paid replay, `--permute` and the labelling sitting are Paco's run on a
DB copy before arming — plan Decision 6 — not part of this task.)

- [ ] **Step 5: Commit**

```bash
git add src/jev/triage-replay.ts src/jev/triage-report.ts src/jev/triage-label.ts src/cli.ts src/run/run-store.ts \
  tests/helpers/jev-tree-answers.ts tests/jev/triage-replay.test.ts tests/jev/triage-report.test.ts tests/jev/triage-label.test.ts \
  tests/jev/triage-parity.test.ts tests/run/replay-reads.test.ts tests/jev/calibration.test.ts tests/jev/questions.test.ts \
  tests/jev/decide.test.ts
git rm tests/run/triage-shadow-stats-store.test.ts src/jev/questions/triage.ts src/jev/thresholds.ts tests/jev/thresholds.test.ts
git commit -m "feat(jev): replay the decision tree — six questions at the live instant, quote rebuilt, §7 tool proxy, tree report

The lane 1 replay, report and labeller move onto the tree: every Telegram turn since 2026-07-02 is
rebuilt with buildTreeState at its live instant (quoted turn from chat_turns.quoted_turn_id), asked
the six questions once, and labelled by the first matching tool rule of spec §7 (unlabelled acks
after a proposal, unmatched tools apart). The report prints the category confusion matrix, score
distributions per proxy, permutation agreement and the three costly cells, recomputing routes
through routeTree as if armed; partial evidence is INCOMPLETE. The lane 1 shadow-stats read goes.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---


---

---

### Task 13: Live gate — `scripts/live-gate-jev-tree.mjs`

**Assembly overrides (Rev 2; binding — folded into the steps below):**
- **Retired chain variables in other scripts (this task owns them):** `scripts/live-gate-omp.mjs` case 6 (`BAD_PLANNER`
  via `HOUGE_OMP_PLANNER`, `:49`, `:120-129`, `:794-807`), case 11 (`:150-158`) and the case 22 PASS text (`:219`);
  `scripts/eval-replay.mjs:2-3,68-69`. Step 5 rewrites each onto the roles API. `scripts/live-gate-memory-a1.mjs:218-223`
  is **Task 7's** (its Step 17 already rewrites it onto `tickSeat`'s `chains` argument); this task only verifies it with
  the grep. `grep -rnE 'HOUGE_OMP_(PLANNER|READER|MEDIA|TICKS|JUDGES|CHAIR|REVIEWER)' scripts` must be empty at the end of
  this task (Task 7's grep covers `src` and `tests`).
- **The PASS join keys on `routed_by`:** the first `compose` attempt of each routed turn carries `routed_by = verdict_id`
  (Task 8). On a below-bar turn the cascade's `llm_attempt` rows (role `cascade`, Tiny role, no `routed_by`) precede the
  planner's (Decision 14), so the join reads `compose` attempts only and never "the run's first attempt".
- **Case 12, the live cascade (Rev 4, Decision 14):** 12a forces a below-bar category through a stubbed Jev answer (the
  path is deterministic; the stub's rows sit outside the skip-rate window) and asserts one real `cascade` call whose first
  leg is on the Tiny head, an answered pick (reason `cascade`, `cascade = 'tiny'`), the pair on the `triage` event, and
  latency ≤ `CASCADE_TIMEOUT_MS` (20 s); it runs last, after case 11, so the stub's answered rows enter neither skip-rate
  window. 12b checks every real-Jev gate turn that went below the bar on its own (cascade
  attempts before the planner's, no `routed_by`) and is INCONCLUSIVE when none did.
- **Case 9 (review fix F8):** each role's head must equal the first **catalogued** selector of its list, on an allowed
  provider, and not `openai-codex` on a chat role. Uncatalogued list entries (Decision 3 keeps older ids as resilience)
  are printed as INFO, never a FAIL.
- **Skip rate (review fix F11):** an absolute bar: at most 1 silent skip in at least 8 real Jev calls during the gate,
  and no `jev_skip_rate` incident open at the end. The 7-day baseline is gone (the live DB holds 4 `triage` events ever).
  Two triage-only real-Jev probes bring the gate to 9 real calls.
- **Effort (review fix F15):** the answering `compose` attempt carries the routed, clamped `effort`; the joins and the
  Thinking case (8) assert it, so a Thinking pin is no longer indistinguishable from a Default one.
- **A verdict never stays pending (review fix F12):** after the planners stop, no gate verdict on the planner path is
  still `pending`.
- **The catalog read uses the production child environment (Codex plan review 4):** both `readOmpCatalog` calls pass
  the whole `resolveOmpConfig(process.env)` (its `envPassthrough` included), never a hand-built `{ bin, profile }`.
- **Merge gate (review fix F9):** under `--real-calibration` the gate first checks that `treeArmed(CALIBRATED_ROWS)`
  arms `category`, `rule`, `status` and `memory` in zh and en, and cases 1 and 2 must ACT: INCONCLUSIVE there is a FAIL.
  Step 6 is the pre-merge run with Paco's committed rows; Task 14's merge checklist names it.
- **omp startup precondition (senior review BLOCKER 1, closed by `a49da40`; Decision 13):** there is no version pin.
  The gate's setup still runs `checkOmpVersion` and exits 2 when omp will not run or prints no version (every planner
  spawn would refuse with `omp_unavailable`), naming the reason.

**Contract deviations:**
1. `scripts/live-gate-memory-a1.mjs` stays with Task 7 (see the override above), against the Rev 1 override that gave it
   to this task: two tasks editing the same hunk would conflict.
2. `scripts/eval-replay.mjs` keeps reading `resolveOmpConfig(process.env).planner` / `.judges[0]` (the static chains,
   which F1 makes today's exact chains) instead of `ROLE_LISTS.default` / `ROLE_LISTS.judges[0]`: `live-gate-omp.mjs`
   `driveReplay` (`:532-539`) requires exactly 3 labelled planners, which today's 3-leg chain gives and the 4-leg
   resolved Default list would not. Only its help text changes.
3. `live-gate-omp.mjs` case 11 changes meaning. With the D10 skip rule (Task 7) a reader call runs every cross-family
   candidate first and flags `family_collapse` only when **every** candidate shares the planner's family, and a
   `/models` override keeps the role's list behind it (Q7). So a `reader` override `k3` can no longer collapse the
   reader; the case now proves the skip rule (the first reader attempt is off the planner's family, no
   `wall_collapse`). Its `driveCollapse` driver and `openView`'s `incidentOpen` become orphans of this change and go.

Two readings the contract leaves open, as in Rev 1: Two readings the contract leaves open, taken here and stated so the Task 10/12
implementers can object: (1) "routed turn" = a turn whose `jev_verdicts.lane = 'planner'` (the planner's first
`compose` attempt carries `routed_by`, Task 8); a memory/status lane turn joins through its `triage` event's
`verdict_id` instead, since its first model call is the lane's own distill leg, not the supervisor's. (2) The parity
case calls Task 12's `runTreeReplay` from `dist/jev/triage-replay.js` (Task 12 keeps the file name and renames the
export) in dry-run mode; its rows carry `{ run_id, state_hash }`. A missing export is a setup error (exit 2), never a
silent skip.

**Files:**
- Create: `scripts/live-gate-jev-tree.mjs` (modelled on `scripts/live-gate-jev-triage.mjs:1-383`: same `envFilePath`,
  `parseArgs`, `copyDb` (`VACUUM INTO` through a read-only connection), `gateEnv`, `harness`, `check`, INCONCLUSIVE
  list, exit codes 0 PASS / 1 FAIL / 2 setup error)
- Modify: `scripts/live-gate-omp.mjs`: `:49` (`BAD_PLANNER`), `:70` (`incidentOpen`), `:120-129` (case 6), `:150-158`
  (case 11), `:219` (case 22 PASS text), `:524-530` (`driveCollapse`), `:734` (live runner: case 6 is smoke-only),
  `:783` (smoke case deps), `:794-807` (`runSmokeCase`), plus a new `case6Worker` after it
- Modify: `scripts/eval-replay.mjs:2-3`, `:68-69` (help text only)
- Delete: `scripts/live-gate-jev-triage.mjs`

**Interfaces:**
- Consumes (all from `../dist/`, built from the branch):
  - existing today: `loadHougeEnv` (`config/load-env.js`), `DISARM_FLAGS` (`config/disarm-posture.js`), `CoreWorker`
    (`core/core-worker.js:400`, thirteenth arg `ompOptions { dataDir, distDir, jevFetch }`; `submitTurn` :2037,
    `triageTurn` :2557, `buildOmpTools`, `shutdownPlanners` :2122), `buildTypedTaskEvent` (`domain/types.js:123`),
    `Gateway`, `RunStore` (`getRunState`, `getLedgerEvents(run_id)` run-store.ts:1083, `recordChatTurn` :1115,
    `listJevDecisions` :4282, `countJevCalls` :4838, `claimRun`, `listOpenIncidents`), `createJevClient`
    (`jev/jev-client.js`; the probe of the reported model, as `probeReportedModel` in `live-gate-jev-triage.mjs`), `toJevQuestion`, `CALIBRATED_ROWS`, `criteriaHash` (`jev/questions/types.js`), `JEV_INCIDENT_SUBJECT` (`jev/jev-incidents.js:9`),
    `detectViolations`, `checkJevSkipRate`, `JEV_NOT_ATTEMPT_REASONS`, `JEV_SILENT_SKIP_REASONS`
    (`run/invariant-sweep.js:210-237`), `resolveOmpConfig` (`omp/omp-config.js:72`), `checkOmpVersion`
    (`omp/omp-version.js:15`), `calibrationRows` (`jev/calibration.js:36`).
  - from the contract: `TREE_QUESTIONS`, `isProposal` (Task 3, `jev/questions/tree.js`); `resolveQuotedTurn`,
    `getJevVerdictForRun`, `latestModelRoleOverrides`, `recordModelRoleOverride` (Tasks 4, 9, 7, `RunStore`);
    `ROLE_LISTS`, `ALLOWED_PROVIDERS`, `CHAT_ROLES`, `matchOverride`, `clampEffort`, `STEP_UP` (Task 6,
    `omp/model-roles.js`); `readOmpCatalog` (Task 6, `omp/model-catalog.js`, called with the full `OmpConfig`);
    `RoleResolver`, `OmpWorkerOptions.roles` (Task 7); `runModelRolesTick` (Task 11, `omp/model-roles-tick.js`);
    `runTreeReplay` (Task 12, `jev/triage-replay.js`); `treeArmed` (with `rule`) and the `"category:status"`
    pseudo-row (Task 5, `jev/tree-policy.js`); the `llm_attempt` payload's `routed_by` and `effort` (Task 8, F15);
    `CATEGORIES` (Task 3, `jev/questions/tree.js`) and `CASCADE_TIMEOUT_MS` plus the `cascade` attempt role (Task 10,
    `core/core-worker.js`; Rev 4, case 12).
- Produces: exit 0 PASS / 1 FAIL / 2 setup error. Every case asserts ledger rows (`jev_verdicts`, `triage`,
  `llm_attempt`, `lesson_saved`), never only the reply.

Facts probed for this task (2026-10-07):
- Live DB: 467 `notification_outbox` rows with `intent_type = 'final_report'`, `state = 'delivered'`,
  `provider_message_id LIKE 'telegram:%'`, `run_id` set and no `:evolution_report:` key; the five newest each have
  exactly one non-`evolution_report` assistant `chat_turns` row (e.g. `telegram:1288`, run `run_6a14d1f9…`,
  2026-10-07T00:40Z). The quote case picks from these at run time in the copy.
- `omp --profile houge models --json` (allow-listed providers): heads the gate expects from the plan's lists —
  fast `anthropic/claude-sonnet-5-5`, default `anthropic/claude-opus-5-5`, thinking `anthropic/claude-opus-5-5`,
  reader `google-antigravity/gemini-3.8-flash`, vision `google-antigravity/gemini-3.8-flash`, tiny `kimi-code/k3`,
  judges `kimi-code/k3` · `openai-codex/gpt-6.1-sol` · `google-antigravity/gemini-3.1-pro`, chair
  `anthropic/claude-opus-5-5`, reviewer `kimi-code/k3`. `kimi-code/k3` thinking = `low/high/max`.
  **Not catalogued:** `google-antigravity/claude-opus-4-6` (Decision 3 keeps it behind the 5-5 id in Default, Thinking
  and Reviewer as resilience). Case 9 prints it as INFO; it never FAILs the gate (F8). Rev 1's note about
  `google-antigravity/claude-opus-5-5-high` is superseded: Decision 3's lists no longer name split ids.
- `llm_attempt` payloads: planner rows `role = "compose"`, `provider` + `model` split (`anthropic` /
  `claude-opus-5-5`); memory-lane legs `role = "distill"` / `"consolidate"` on `kimi-code` / `k3`; Jev rows
  `provider = "jev"`, `role = "triage"`.
- `jev_skip_rate` reads `jev_decisions` per point via `countJevCalls` (answered counted per run, skips per row).

- [ ] **Step 1: Write the gate**

Create `scripts/live-gate-jev-tree.mjs`:

```js
#!/usr/bin/env node
// Live gate — Jev decision tree, stage A (spec §9 "Live gate per stage" + "Stage A PASS criterion"; plan Task 13).
// Runs the REAL Jev, the real memory-lane legs and the real omp planner (profile houge) against a TEMP COPY of the
// live DB (VACUUM INTO under /tmp). The live DB is only read; the daemon is never touched.
//
//   npm run build && HOUGE_ENV_FILE=/abs/.env node scripts/live-gate-jev-tree.mjs [--db <path>] [--keep] [--real-calibration]
//
// --real-calibration: no temp file and no HOUGE_JEV_GATE; the tree arms on the committed CALIBRATED_ROWS, as the daemon
// will. This is the MERGE gate (F9): it first checks that the committed rows arm category, rule, status and memory in zh
// and en, and cases 1 and 2 must ACT (INCONCLUSIVE there is a FAIL). Before Paco's commit it therefore FAILs by design.
//
// Model (Rev 5, as live-gate-jev-triage.mjs since c026e5c): the request names TypeSafe's moving alias `jev-latest`;
// calibration rows key on the model Jev REPORTS. So setup first sends ONE probe call (the real client, the six tree
// questions, a trivial state) and uses the reported id. With --real-calibration that id must be one CALIBRATED_ROWS names.
//
// Arming (default): a temp calibration file names the six tree questions plus the `category:status` pseudo-row, zh + en
// (so `rule` arms too), model = the probe's reported id, hashes from dist/ — and HOUGE_JEV_GATE=1. The bars
// (TREE_BAR_DEFAULTS) still apply: Jev's real probabilities must clear them.
//
// Cases (each asserts ledger rows):
//   1  memory rule → lane memory, lane_reply, save_outcome saved, zero planner requests, distill/consolidate on the Tiny role
//   2  status question → lane status, lane_reply, zero planner requests
//   3  bare thanks after a plain answer → ack rule (no Jev call), category answer, Fast; planner answers on the Fast head
//   4  bare "好" after a proposal → the ack rule does NOT fire, Jev is asked
//   5  "好" quoting an older delivered Houge reply (real outbox id in the copy) → quoted_turn_id on the verdict and the
//      user chat turn; never the ack rule
//   6  a lookup that carries a rule (sets_rule) → saved first, then the planner answers
//   7  a correction of a stored rule → planner, nothing saved by the lane
//   8  a request beyond a lookup lane's limits (broad research) → planner on the routed role (Thinking for research)
//   9  roles against the real `omp --profile houge models --json`: every role's head = its list's first CATALOGUED
//      selector on an allowed provider (never openai-codex on a chat role); uncatalogued entries are INFO; Tiny =
//      kimi-code/k3, allow-list before matching, effort clamp, the daily tick
//   10 state parity: a dry-run replay over the copy rebuilds the live `state_hash` of each answered gate turn
//   11 Jev transport down × N → skipped{transport}, one verdict row per turn (category null, fallback, Default), the
//      sweep reports jev_skip_rate
//   12 the live cascade (Decision 14): (a) a stubbed below-bar Jev answer → one real cascade call on the Tiny head,
//      answered and routed (reason cascade) within CASCADE_TIMEOUT_MS; (b) any real-Jev gate turn that went below the
//      bar on its own: cascade attempts precede the planner's, no routed_by (INCONCLUSIVE when none did)
//   probes: two triage-only real-Jev turns, so the skip-rate bar sees ≥ 8 real calls
//   PASS criterion over every gate turn: each planner-lane verdict's first `compose` attempt carries routed_by =
//   verdict_id and answers on the head of its routed candidates with the routed, clamped effort (a silent pin that left
//   the child on the spawn leg, or on the spawn leg's effort, FAILs here); pin_failed = 0; no planner-path verdict left
//   pending after shutdown; ≤ 1 silent Jev skip in ≥ 8 real calls and no jev_skip_rate incident open at the end.
//
// Cannot exercise (hermetic instead): a quote of Paco's own message (resolution through source_reference: Task 4
// tests), a refused pin (`Model not found`: Task 8 fake omp), the broker-supplied Jev key (Task 9 of lane 1), a cascade
// that times out (Task 10's fake-timer test; the live 20 s bound is measured in case 12a).
//
// Budget: Jev calls are metered but tiny; cases 3-8 each run one real planner turn (case 8 may run several tools);
// cases 1 and 6 run the distill + reconcile legs; case 12a runs one Tiny one-shot. Exit: 0 PASS · 1 FAIL · 2 setup error.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const DIST = resolve(new URL("../dist", import.meta.url).pathname);
const failures = [];
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); if (!ok) failures.push(name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Jev's probabilities vary run to run: a message can land under a bar and rightly take another path. That case is
// INCONCLUSIVE for the path it meant to exercise (listed, never a PASS of it); the path the recorded verdict names is
// checked instead, so a code fault still FAILs.
const inconclusive = [];
const noEffort = (s) => (s ?? "").split(":")[0];
const key = (provider, model) => `${provider}/${model}`;

function envFilePath() {
  return process.env.HOUGE_ENV_FILE ?? join(process.cwd(), ".env");
}

function parseArgs(argv) {
  const a = { db: null, keep: false, realCalibration: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--keep") a.keep = true;
    else if (argv[i] === "--real-calibration") a.realCalibration = true;
    else if (argv[i] === "--db") a.db = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return a;
}

async function loadModules() {
  const mods = await Promise.all([
    "config/load-env.js", "config/disarm-posture.js", "core/core-worker.js", "domain/types.js", "gateway/gateway.js",
    "run/run-store.js", "jev/jev-client.js", "jev/questions/tree.js", "jev/questions/types.js", "jev/jev-incidents.js",
    "jev/triage-replay.js", "run/invariant-sweep.js", "omp/model-roles.js", "omp/model-catalog.js", "omp/role-resolver.js",
    "omp/omp-config.js", "omp/model-roles-tick.js", "jev/tree-policy.js", "jev/calibration.js", "omp/omp-version.js"
  ].map((p) => import(`../dist/${p}`)));
  const m = Object.assign({}, ...mods);
  const need = ["loadHougeEnv", "DISARM_FLAGS", "CoreWorker", "buildTypedTaskEvent", "Gateway", "RunStore", "createJevClient", "toJevQuestion", "CALIBRATED_ROWS", "TREE_QUESTIONS",
    "isProposal", "criteriaHash", "JEV_INCIDENT_SUBJECT", "runTreeReplay", "detectViolations", "checkJevSkipRate", "JEV_NOT_ATTEMPT_REASONS",
    "JEV_SILENT_SKIP_REASONS", "ROLE_LISTS", "ALLOWED_PROVIDERS", "CHAT_ROLES", "matchOverride", "clampEffort", "STEP_UP", "readOmpCatalog",
    "RoleResolver", "resolveOmpConfig", "runModelRolesTick", "treeArmed", "calibrationRows", "checkOmpVersion", "CASCADE_TIMEOUT_MS", "CATEGORIES"];
  const missing = need.filter((n) => m[n] === undefined);
  if (missing.length > 0) throw new Error(`dist/ lacks ${missing.join(", ")} (build the branch first)`);
  return m;
}

/** One real Jev call (the six tree questions, a trivial state) for the model id the alias currently reports. Audit: in memory. */
async function probeReportedModel(m) {
  const mem = m.RunStore.openInMemory();
  try {
    const jev = m.createJevClient({ apiKey: process.env.TYPESAFE_API_KEY, audit: mem.llmAuditSink({ correlation_id: "gate:jev-probe", role: "" }),
      meteredBreached: () => false, retries: 1, timeoutMs: 15_000 });
    const questions = Object.fromEntries(m.TREE_QUESTIONS.map((q) => [q.id, m.toJevQuestion(q)]));
    const r = await jev({ state: { latest_message: "hello" }, questions });
    if (!r.ok) throw new Error(`model probe failed: ${r.reason}`);
    return r.model;
  } finally { mem.close(); }
}

/** Gate-only calibration: the six tree questions and the status pseudo-row (treeArmed), zh + en, hashes from dist/, model = m.model. */
function writeCalibration(m, root) {
  const category = m.TREE_QUESTIONS.find((q) => q.id === "category");
  const ids = [...m.TREE_QUESTIONS.map((q) => [q.id, m.criteriaHash(q)]), ["category:status", m.criteriaHash(category)]];
  const rows = ids.flatMap(([question_id, criteria_hash]) => ["zh", "en"].map((lang) =>
    ({ question_id, criteria_hash, model: m.model, lang, approved: "live-gate", evidence: "live-gate (temp file, never committed)" })));
  const file = join(root, "calibration.json");
  writeFileSync(file, JSON.stringify(rows));
  return file;
}

/** No Telegram, every disarm flag off, markers inside the temp root, resolved roles, the tree armed for the gate only. */
function gateEnv(m, root, realCalibration) {
  for (const k of ["HOUGE_TELEGRAM_BOT_TOKEN", "HOUGE_TELEGRAM_CHAT_ID", "HOUGE_TELEGRAM_USER_ID"]) delete process.env[k];
  for (const f of m.DISARM_FLAGS) process.env[f] = "false";
  Object.assign(process.env, {
    HOUGE_EPISODIC_ENABLED: "false", HOUGE_TOMBSTONE_PATH: join(root, "houge.kill"), HOUGE_PARK_MARKER_PATH: join(root, "houge.parked"),
    HOUGE_DISARM_PATH: join(root, "houge.disarm"), HOUGE_JEV_ENABLED: "1", HOUGE_JEV_TRIAGE_ENABLED: "arm",
    HOUGE_JEV_DISARM_PATH: join(root, "houge.jev-disarmed"), HOUGE_MODEL_ROLES: "resolved"
  });
  if (realCalibration) { delete process.env.HOUGE_JEV_GATE; delete process.env.HOUGE_JEV_CALIBRATION_FILE; }
  else Object.assign(process.env, { HOUGE_JEV_GATE: "1", HOUGE_JEV_CALIBRATION_FILE: writeCalibration(m, root) });
}

/** A consistent snapshot of the live DB through a read-only connection (WAL-safe; the daemon keeps running). */
function copyDb(from, to) {
  const src = new DatabaseSync(from, { readOnly: true });
  try { src.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`); } finally { src.close(); }
}

/**
 * Intake (optionally as a Telegram reply), settle, ledger reads over the COPY. Every worker gets the gate's own
 * RoleResolver (OmpWorkerOptions.roles, Task 7), already refreshed against the real catalog: a worker that built its
 * own would route on an unread catalog (no clamp), and the join checks would compare two different resolutions.
 */
function harness(m, store, repo, root, roles) {
  const makeWorker = (jevFetch) => new m.CoreWorker(store, repo, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, { dataDir: root, distDir: DIST, roles, ...(jevFetch ? { jevFetch } : {}) });
  const intake = (chat, text, replyTo) => {
    const msg = 9_000_000 + Math.floor(Math.random() * 1_000_000); const upd = 8_000_000_000 + msg;
    const r = new m.Gateway(store, undefined, undefined, undefined, undefined, { dataDir: root }).intake(m.buildTypedTaskEvent({
      source: "telegram", type: "turn", program: "turn", goal: text, requested_by: { kind: "user", id: "gate" },
      notify: { kind: "telegram", chat_id: chat }, idempotency_key: `telegram:${upd}:${msg}`, source_reference: `telegram:update:${upd}:message:${msg}`,
      metadata: { telegram_update_id: upd, telegram_message_id: msg, ...(replyTo !== undefined ? { reply_to_message_id: replyTo } : {}) } }));
    if (!r.ok || !r.run_id) throw new Error(`intake failed: ${JSON.stringify(r)}`);
    return r.run_id;
  };
  const settle = async (run_id, ms = 600_000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const s = store.getRunState(run_id);
      if (s === "completed" || s === "failed" || s === "waiting_for_approval") return s;
      await sleep(500);
    }
    return "timeout";
  };
  const events = (run_id, type) => store.getLedgerEvents(run_id).filter((e) => e.event_type === type);
  const attempts = (run_id, role) => events(run_id, "llm_attempt").filter((e) => role === undefined || e.payload.role === role);
  return { makeWorker, intake, settle, events, attempts, verdict: (run_id) => store.getJevVerdictForRun(run_id) };
}

const show = (label, v) => console.log(`  verdict[${label}] ${JSON.stringify(v ? { category: v.category, lane: v.lane, role: v.role, effort: v.effort,
  reason: v.reason, save: v.save_outcome, route: v.route_outcome, handler: v.handler_outcome, model: v.model, sets_rule: v.sets_rule,
  quoted: v.quoted_turn_id, skip: v.skip_reason } : null)}`);

// Neutral test messages (the repo is public).
const MSG = {
  rule: "从现在起，回复请控制在三句话以内。",
  status: "你刚才重启过吗？现在跑的是哪个版本？",
  plainAnswer: "明天悉尼晴，最高 22 度。",
  thanks: "谢谢",
  proposal: "要不要我帮你把明天悉尼的天气每天早上推送一次？",
  ok: "好",
  ruleLookup: "以后温度都用摄氏度。明天悉尼天气怎么样？",
  correction: "我之前让你回复控制在三句话以内，那条规则不对，删掉它。",
  research: "帮我比较三款适合家用的 NAS，从价格、功耗和软件生态三方面给出推荐。",
  probes: ["明天悉尼天气怎么样？", "今天有什么值得关注的新闻？"]
};

/** A fresh chat whose last Houge turn is `assistantText` (seeded rows: chat_turns holds no FK to runs). */
function seedChat(store, assistantText) {
  const chat = `-4${Date.now() % 1_000_000}${Math.floor(Math.random() * 100)}`;
  const run_id = `run_gateseed_${randomUUID()}`; const t = Date.now();
  store.recordChatTurn({ chat_id: chat, run_id, role: "user", text: "明天悉尼天气怎么样？", created_at: new Date(t - 90_000).toISOString() });
  store.recordChatTurn({ chat_id: chat, run_id, role: "assistant", text: assistantText, intent: "loop", created_at: new Date(t - 60_000).toISOString() });
  return chat;
}

/** Runs one Telegram turn to its end and returns its verdict (shown). */
async function turn(g, label, chat, text, replyTo) {
  const run_id = g.h.intake(chat, text, replyTo); g.worker.submitTurn(run_id);
  const s = await g.h.settle(run_id);
  check(`${label}: turn ended`, s === "completed" || s === "failed" || s === "waiting_for_approval", s);
  const v = g.h.verdict(run_id); show(label, v);
  check(`${label}: exactly one jev_verdicts row`, v !== undefined);
  return { run_id, v, state: s };
}

const laneSaves = (g, run_id) => g.h.events(run_id, "lesson_saved").filter((e) => e.payload.source === "lane").length;
const jevAsked = (g, run_id) => g.store.listJevDecisions(run_id).length > 0;

/**
 * The lane took another path than the case meant: INCONCLUSIVE, then the recorded path is checked for consistency.
 * `mustAct` (cases 1, 2): under --real-calibration the merge needs the lanes to act on Paco's rows, so it FAILs (F9).
 */
function otherPath(g, label, run_id, v, o = {}) {
  inconclusive.push(`${label}: Jev's call gave ${v?.category ?? "none"}/${v?.lane ?? "none"} (${v?.reason ?? "no verdict"}); this case's path was not exercised`);
  console.log(`INCONCLUSIVE ${label} — ${v?.category ?? "none"}/${v?.lane ?? "none"}; checking that path instead`);
  const compose = g.h.attempts(run_id, "compose").length;
  if (v?.lane === "planner") check(`${label} [as planner]: the planner answered`, compose > 0, `compose=${compose}`);
  else check(`${label} [as ${v?.lane}]: lane reply, zero planner requests`, v?.handler_outcome === "lane_reply" && compose === 0, `handler=${v?.handler_outcome} compose=${compose}`);
  check(`${label}: lane saves match save_outcome`, (v?.save_outcome === "saved") === (laneSaves(g, run_id) === 1), `save=${v?.save_outcome} saves=${laneSaves(g, run_id)}`);
  if (o.mustAct && g.strict) {
    check(`${label}: the lane acted under --real-calibration (INCONCLUSIVE is a FAIL for the merge)`, false, `${v?.category ?? "none"}/${v?.lane ?? "none"} (${v?.reason ?? "no verdict"})`);
  }
}

/** 1: the memory lane saves the rule on K3 with no planner request. */
async function caseMemory(g) {
  const { run_id, v } = await turn(g, "1 memory", g.chat, MSG.rule);
  if (v?.lane !== "memory") { otherPath(g, "1 memory", run_id, v, { mustAct: true }); return; }
  check("1 memory: lane_reply, saved, act", v.handler_outcome === "lane_reply" && v.save_outcome === "saved" && v.route_outcome === "act");
  check("1 memory: zero planner requests", g.h.attempts(run_id, "compose").length === 0);
  const legs = [...g.h.attempts(run_id, "distill"), ...g.h.attempts(run_id, "consolidate")];
  // Rev 4: Tiny is k3 then gemini-3.8-flash, so a leg that fell through to the second candidate is still the memory lane's
  const tiny = new Set(g.roles.candidates("tiny").map((c) => key(c.provider, c.model)));
  const off = legs.filter((e) => !tiny.has(key(e.payload.provider, e.payload.model)));
  check("1 memory: distill + reconcile ran, all on the Tiny role's candidates", legs.some((e) => e.payload.role === "distill") && off.length === 0,
    legs.map((e) => `${e.payload.role}:${key(e.payload.provider, e.payload.model)}`).join(" "));
  check("1 memory: exactly one lane lesson_saved", laneSaves(g, run_id) === 1);
}

/** 2: the status lane answers from code. */
async function caseStatus(g) {
  const { run_id, v } = await turn(g, "2 status", g.chat, MSG.status);
  if (v?.lane !== "status") { otherPath(g, "2 status", run_id, v, { mustAct: true }); return; }
  check("2 status: lane_reply, act, zero planner requests", v.handler_outcome === "lane_reply" && v.route_outcome === "act" && g.h.attempts(run_id, "compose").length === 0);
}

/** 3: thanks after a plain answer is settled in code (spec §2.1): no Jev call, Fast. Deterministic: a miss is a FAIL. */
async function caseAck(g) {
  const { run_id, v } = await turn(g, "3 ack", seedChat(g.store, MSG.plainAnswer), MSG.thanks);
  check("3 ack: reason ack_rule, category answer, role fast, lane planner", v?.reason === "ack_rule" && v.category === "answer" && v.role === "fast" && v.lane === "planner");
  check("3 ack: no Jev call", !jevAsked(g, run_id), `jev_decisions=${g.store.listJevDecisions(run_id).length}`);
}

/** 4: "好" after a proposal is never the ack rule; Jev classifies it. Deterministic gate on the code path. */
async function caseOkAfterProposal(g) {
  const { run_id, v } = await turn(g, "4 好 after proposal", seedChat(g.store, MSG.proposal), MSG.ok);
  check("4 好: the ack rule did not fire, Jev was asked", v?.reason !== "ack_rule" && jevAsked(g, run_id), `reason=${v?.reason}`);
}

/** The quote target: a delivered final_report outbox row in the copy that resolves to one Houge turn (a proposal if any). */
function pickQuote(g) {
  const db = new DatabaseSync(g.dbPath, { readOnly: true });
  let rows;
  try {
    rows = db.prepare(`SELECT o.target_json, o.provider_message_id, o.created_at FROM notification_outbox o
      WHERE o.intent_type = 'final_report' AND o.state = 'delivered' AND o.provider_message_id LIKE 'telegram:%'
        AND o.run_id IS NOT NULL AND o.idempotency_key NOT LIKE '%:evolution_report:%' ORDER BY o.created_at DESC LIMIT 200`).all();
  } finally { db.close(); }
  const hits = [];
  for (const r of rows) {
    const chat = String(JSON.parse(r.target_json).chat_id); const id = Number(r.provider_message_id.slice("telegram:".length));
    const q = Number.isInteger(id) ? g.store.resolveQuotedTurn(chat, id) : { ok: false };
    if (q.ok && q.role === "houge") hits.push({ chat, id, turn: q.turn });
  }
  // Older than the newest Houge reply in its chat, so the anchor is not just "the last turn"; a proposal first.
  const older = hits.slice(1);
  return older.find((h) => g.m.isProposal(h.turn.text)) ?? older[0] ?? hits[0];
}

/** 5: a quote of an older delivered Houge reply anchors the turn through the real outbox ids in the copy. */
async function caseQuote(g) {
  const target = pickQuote(g);
  if (!target) { check("5 quote: a resolvable delivered final_report exists in the copy", false); return; }
  console.log(`  quote target: telegram:${target.id} → ${target.turn.turn_id} (proposal=${g.m.isProposal(target.turn.text)}, ${target.turn.created_at})`);
  const { run_id, v } = await turn(g, "5 quote", target.chat, MSG.ok, target.id);
  check("5 quote: verdict.quoted_turn_id = the resolved Houge turn", v?.quoted_turn_id === target.turn.turn_id, `got ${v?.quoted_turn_id}`);
  const user = userTurnOf(g, target.chat, run_id);
  check("5 quote: the user chat turn records quoted_turn_id", user?.quoted_turn_id === target.turn.turn_id, `got ${user?.quoted_turn_id}`);
  check("5 quote: a quote is never settled by the ack rule; Jev was asked", v?.reason !== "ack_rule" && jevAsked(g, run_id), `reason=${v?.reason}`);
}

function userTurnOf(g, chat, run_id) {
  return g.store.getRecentChatTurns(chat, 20).find((t) => t.run_id === run_id && t.role === "user");
}

/** 6: a rule riding on a lookup is saved first, then the planner answers (spec §3 "sets_rule = yes with any category"). */
async function caseRuleOnLookup(g) {
  const { run_id, v } = await turn(g, "6 rule+lookup", g.chat, MSG.ruleLookup);
  if (!(v?.save_outcome === "saved" && v.lane === "planner")) { otherPath(g, "6 rule+lookup", run_id, v); return; }
  check("6 rule+lookup: exactly one lane save, then the planner answered", laneSaves(g, run_id) === 1 && g.h.attempts(run_id, "compose").length > 0);
}

/** 7: a correction is not a rule: memory with sets_rule below yes goes to the planner and the lane saves nothing. */
async function caseCorrection(g) {
  const { run_id, v } = await turn(g, "7 correction", g.chat, MSG.correction);
  if (v?.category === "memory" && (v.sets_rule ?? 0) < 0.8) {
    check("7 correction: memory without a rule → planner, nothing saved by the lane", v.lane === "planner" && v.save_outcome === "none" && laneSaves(g, run_id) === 0);
  } else otherPath(g, "7 correction", run_id, v);
}

/** 8: beyond a lookup's limits → the planner on the routed role; research floors at Thinking (ROLE_FLOOR). */
async function caseOverflow(g) {
  const { run_id, v } = await turn(g, "8 overflow", g.chat, MSG.research);
  if (v?.category !== "research") { otherPath(g, "8 overflow", run_id, v); return; }
  check("8 overflow: research → planner on Thinking", v.lane === "planner" && v.role === "thinking", `${v.lane}/${v.role}`);
  // F15: Thinking shares Default's head; only the pinned effort shows the Thinking pin applied
  const ok = g.h.attempts(run_id, "compose").find((e) => e.payload.outcome === "ok");
  const want = ok && g.roles.candidates("thinking", { effort: v.effort }).find((c) => key(c.provider, c.model) === key(ok.payload.provider, ok.payload.model));
  check("8 overflow: the answering attempt carries Thinking's routed, clamped effort", want !== undefined && ok.payload.effort === want.effort,
    `effort=${ok?.payload.effort} want=${want?.effort ?? "(answered off the Thinking list)"}`);
}

/** Probes: triage-only real-Jev turns (no planner) so the skip-rate bar sees ≥ 8 real calls (F11). */
async function caseJevProbes(g) {
  for (const [k, text] of MSG.probes.entries()) {
    const run_id = g.h.intake(`-6${k}0${Date.now() % 100000}`, text); // one chat each: the gateway rate-limits per chat
    g.triageOnly.add(run_id);
    const claim = g.store.claimRun(run_id, `planner:gate:${run_id}`, 300);
    if (!claim) { check(`probe ${k}: claim`, false); continue; }
    g.worker.buildOmpTools(claim);
    const out = await g.worker.triageTurn({ claim, text, userText: text, modality: "text", posture: null, signal: new AbortController().signal });
    const v = g.h.verdict(run_id); show(`probe ${k}`, v);
    check(`probe ${k}: one verdict row, and the route names it`, v !== undefined && out.route?.verdict_id === v.verdict_id);
  }
}
```

```js
// (continued, same file)

/** Every model id named by every role list, by role (judges per seat). */
function listSelectors(m) {
  return Object.entries(m.ROLE_LISTS).flatMap(([role, list]) => list.map((s, i) => ({ role: role === "judges" ? `judges:${i}` : role, s: noEffort(s) })));
}

/** The list's first selector the catalog carries (spec §4 step 3 drops the rest); undefined when none is catalogued. */
const firstCatalogued = (list, listed) => (list ?? []).find((sel) => listed.has(noEffort(sel)));

/**
 * 9a (F8): each role's head is the first CATALOGUED selector of its list, on an allowed provider, never openai-codex on a
 * chat role; Tiny stays K3 (the memory lane's model). Uncatalogued list entries are INFO: Decision 3 keeps older ids as
 * resilience and the catalog moves within hours, so their absence is not a fault.
 */
function caseRoleHeads(g, catalog) {
  const listed = new Set(catalog.map((c) => key(c.provider, c.id)));
  const missing = listSelectors(g.m).filter((x) => !listed.has(x.s));
  console.log(`  INFO uncatalogued list entries (resolution drops them): ${missing.map((x) => `${x.role}:${x.s}`).join(", ") || "none"}`);
  const overrides = g.store.latestModelRoleOverrides();
  for (const r of g.roles.resolveAll()) {
    const [role, seat] = String(r.key).split(":");
    if (overrides.has(r.key)) { console.log(`  role ${r.key}: override ${overrides.get(r.key)} in the copy → head ${r.head} (not compared)`); continue; }
    const list = seat !== undefined ? [g.m.ROLE_LISTS[role]?.[Number(seat)]].filter(Boolean) : g.m.ROLE_LISTS[role];
    const want = firstCatalogued(list, listed);
    check(`9 roles: ${r.key} head = its list's first catalogued selector`, want !== undefined && r.source === "list" && noEffort(r.head) === noEffort(want),
      `head=${r.head} want=${want ?? "(none catalogued)"} candidates=${r.candidates.join(",")}`);
    const provider = noEffort(r.head).split("/")[0];
    const chat = g.m.CHAT_ROLES.has(role);
    check(`9 roles: ${r.key} head on an allowed provider${chat ? ", not openai-codex" : ""}`,
      g.m.ALLOWED_PROVIDERS.includes(provider) && !(chat && provider === "openai-codex"), `provider=${provider || "(none)"}`);
  }
  const tiny = g.roles.resolveAll().find((r) => r.key === "tiny");
  check("9 roles: tiny resolves to kimi-code/k3 (memory lane unchanged)", noEffort(tiny?.head) === "kimi-code/k3", String(tiny?.head));
}

/** 9b: allow-list before matching, seat eligibility and the effort clamp, on the real catalog. */
function caseRoleRules(g, catalog) {
  const flash = g.m.matchOverride("gemini-3.8-flash", "fast", catalog);
  check("9 roles: a gemini pattern never matches google/ (allow-list before matching)", flash.length > 0 && flash.every((c) => c.provider === "google-antigravity"),
    flash.map((c) => key(c.provider, c.id)).join(","));
  const chat = ["fast", "default", "thinking", "vision", "tiny"].flatMap((role) => g.roles.candidates(role));
  check("9 roles: no chat seat candidate is openai-codex", chat.length > 0 && chat.every((c) => c.provider !== "openai-codex"));
  const k3 = g.m.clampEffort({ provider: "kimi-code", model: "k3" }, "medium", catalog, "resolved");
  check("9 roles: medium on kimi-code/k3 clamps to high (catalog low/high/max)", k3.effort === "high", JSON.stringify(k3));
}

/** 9c: the daily tick on the copy: resolves, reports no unresolved role, then latches for 24 h. */
async function caseRolesTick(g) {
  const notes = []; const now = new Date().toISOString();
  const first = await g.m.runModelRolesTick({ store: g.store, roles: g.roles, now, notify: (t) => notes.push(t) });
  check("9 tick: ran, no role unresolved", first.ran && first.unresolved.length === 0, JSON.stringify({ ...first, notes }));
  const again = await g.m.runModelRolesTick({ store: g.store, roles: g.roles, now: new Date(Date.parse(now) + 60_000).toISOString(), notify: (t) => notes.push(t) });
  check("9 tick: latched within 24 h", again.ran === false, JSON.stringify(again));
}

/** 10: the replay rebuilds the live state of each answered gate turn exactly (Task 12, dry run, no Jev call). */
async function caseParity(g) {
  const live = g.runIds.flatMap((run_id) => g.store.listJevDecisions(run_id).filter((r) => r.status === "answered" && r.question_id === "category"));
  check("10 parity: answered rows carry thread_cut_at + state_built_at", live.length > 0 && live.every((r) => r.thread_cut_at && r.state_built_at), `answered=${live.length}`);
  const r = await g.m.runTreeReplay({ store: g.store, env: process.env, jev: async () => ({ ok: false, reason: "error" }), outPath: join(g.root, "parity.jsonl"),
    maxUsd: 1, dryRun: true, log: () => {} });
  const byRun = new Map(r.rows.map((x) => [x.run_id, x.state_hash]));
  const comparable = live.filter((l) => byRun.has(l.run_id));
  const miss = comparable.filter((l) => byRun.get(l.run_id) !== l.state_hash);
  check("10 parity: replay state_hash = live state_hash for every comparable gate turn (≥ 1)", comparable.length > 0 && miss.length === 0,
    `comparable=${comparable.length} of ${live.length}; mismatched=${miss.map((l) => l.run_id).join(",") || "none"}`);
}

/** 11: Jev transport down: every turn still leaves one verdict row (the §6 join through an outage); the sweep sees it. */
async function caseSkipRate(g) {
  const worker = g.h.makeWorker(async () => { throw new TypeError("fetch failed"); });
  const started = Date.now() - 1000;
  const before = g.m.checkJevSkipRate(g.store, new Date().toISOString()).attempts;
  const n = Math.max(8, before + 2); let ok = 0;
  try {
    for (let k = 0; k < n; k += 1) {
      const run_id = g.h.intake(`-5${k}0${Date.now() % 100000}`, MSG.rule); // one chat each: the gateway rate-limits per chat
      g.triageOnly.add(run_id);
      const claim = g.store.claimRun(run_id, `planner:gate:${run_id}`, 300);
      if (!claim) { check("11 skip rate: claim", false); return; }
      worker.buildOmpTools(claim);
      const out = await worker.triageTurn({ claim, text: MSG.rule, userText: MSG.rule, modality: "text", posture: null, signal: new AbortController().signal });
      const v = g.h.verdict(run_id);
      if (out.kind === "fallthrough" && out.route?.role === "default" && v?.category === null && v.route_outcome === "fallback" && v.skip_reason === "transport" && v.role === "default") ok += 1;
      else show(`11 skip #${k}`, v);
    }
  } finally { await worker.shutdownPlanners(); }
  check(`11 skip rate: ${n} turns → fallthrough on Default, each with one verdict row {category null, fallback, transport}`, ok === n, `ok=${ok}`);
  const now = new Date().toISOString();
  const rate = g.m.checkJevSkipRate(g.store, now, Date.now() - started);
  check(`11 skip rate: ${n} of ${n} attempts failed silently → open`, rate.open && rate.attempts === n && rate.failed === n, JSON.stringify(rate));
  const viol = g.m.detectViolations(g.store, now, process.env).filter((x) => x.kind === "jev_skip_rate");
  check("11 skip rate: the sweep detector reports jev_skip_rate", viol.length === 1 && viol[0].subject === g.m.JEV_INCIDENT_SUBJECT);
}

/** 12a's stubbed Jev: category under the choice bar (lookup 0.5, research 0.3), no rule, a light gear; it reports the probed model so it arms. */
function belowBarJev(m) {
  const rest = 0.2 / (m.CATEGORIES.length - 2);
  const probabilities = Object.fromEntries(m.CATEGORIES.map((c) => [c, c === "lookup" ? 0.5 : c === "research" ? 0.3 : rest]));
  const n = m.CATEGORIES.length;
  const level = { type: "score", score: 0.9, probabilities: { 0: 0.1, 1: 0.9, 2: 0, 3: 0 }, confidence: 0.8 };
  const body = { model: m.model, usage: { input_tokens: 900, output_tokens: 0 }, answers: {
    category: { type: "choice", choice: "lookup", probabilities, confidence: (0.5 - 1 / n) / (1 - 1 / n) },
    sets_rule: { type: "noul", noul: 0.05 }, rule_scope: { type: "choice", choice: "ask", probabilities: { ask: 0.9, research: 0.1 }, confidence: 0.8 },
    breadth: level, reasoning: level, actions: level } };
  return async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/**
 * 12a (Decision 14): a forced below-bar turn makes ONE real cascade call (one attempt_group) whose first leg is the Tiny
 * head, answers within CASCADE_TIMEOUT_MS and routes on the pick. Triage only (no planner); it runs last, after case 11,
 * because the stub's answered rows are not real Jev calls. A failed or timed-out pick FAILs: that is the silent
 * degradation this case exists to catch (the turn would still answer, on Default).
 */
async function caseCascade(g) {
  const worker = g.h.makeWorker(belowBarJev(g.m));
  try {
    const run_id = g.h.intake(`-7${Date.now() % 100000}`, MSG.research); g.triageOnly.add(run_id);
    const claim = g.store.claimRun(run_id, `planner:gate:${run_id}`, 300);
    if (!claim) { check("12 cascade: claim", false); return; }
    worker.buildOmpTools(claim);
    const t0 = Date.now();
    const out = await worker.triageTurn({ claim, text: MSG.research, userText: MSG.research, modality: "text", posture: null, signal: new AbortController().signal });
    const elapsed = Date.now() - t0; const v = g.h.verdict(run_id); show("12 cascade", v);
    const legs = g.h.attempts(run_id, "cascade").map((e) => e.payload); const head = g.roles.candidates("tiny")[0];
    const desc = legs.map((l) => `${key(l.provider, l.model)}:${l.outcome}:${l.latency_ms}ms`).join(" ") || "none";
    check("12 cascade: exactly one cascade call, its first leg on the Tiny head", legs.length > 0 && new Set(legs.map((l) => l.attempt_group)).size === 1
      && head !== undefined && key(legs[0].provider, legs[0].model) === key(head.provider, head.model), `legs=${desc} head=${head ? key(head.provider, head.model) : "(none)"}`);
    check("12 cascade: the Tiny leg answered and the pick routed (reason cascade, cascade tiny, one of the pair)",
      legs.some((l) => l.outcome === "ok") && v?.reason === "cascade" && v.cascade === "tiny" && ["lookup", "research"].includes(v.category),
      `reason=${v?.reason} category=${v?.category} cascade=${v?.cascade}`);
    const legMs = legs.reduce((a, l) => a + (l.latency_ms ?? 0), 0);
    check(`12 cascade: answered within CASCADE_TIMEOUT_MS (${g.m.CASCADE_TIMEOUT_MS} ms)`, elapsed <= g.m.CASCADE_TIMEOUT_MS && legMs <= g.m.CASCADE_TIMEOUT_MS,
      `triageTurn ${elapsed} ms, legs ${legMs} ms`);
    check("12 cascade: the triage event names the pair", g.h.events(run_id, "triage")[0]?.payload.cascade_between?.join(",") === "lookup,research");
    check("12 cascade: the returned route names the verdict", out.route?.verdict_id === v?.verdict_id);
  } finally { await worker.shutdownPlanners(); }
}

/** 12b: a real-Jev gate turn that went below the bar on its own: its cascade attempts precede the planner's, no routed_by. */
function checkNaturalCascades(g) {
  const hits = g.runIds.filter((id) => !g.triageOnly.has(id)).filter((id) => g.h.verdict(id)?.cascade === "tiny");
  if (hits.length === 0) {
    inconclusive.push("12b natural cascade: no real-Jev gate turn went below the choice bar (12a forced the path)");
    console.log("INCONCLUSIVE 12b natural cascade — no real-Jev turn went below the bar");
    return;
  }
  for (const id of hits) {
    const all = g.h.attempts(id).map((e) => e.payload); const firstCompose = all.findIndex((a) => a.role === "compose");
    const casc = all.map((a, k) => ({ a, k })).filter((x) => x.a.role === "cascade");
    check(`12b ${id}: cascade attempts precede the planner's and carry no routed_by`,
      casc.length > 0 && casc.every((x) => (firstCompose < 0 || x.k < firstCompose) && x.a.routed_by === undefined), `cascade=${casc.length} firstCompose=${firstCompose}`);
  }
}
```

```js
// (continued, same file)

/** The candidates a role may legitimately answer on: its own list, then each stepped-up role's (spec §4 step-up). */
function allowedModels(g, role, effort) {
  const out = []; let r = role;
  while (r) { out.push(...g.roles.candidates(r, { effort })); r = g.m.STEP_UP[r]; }
  return out;
}

/**
 * PASS criterion, per planner-lane gate turn: the first compose attempt carries routed_by = verdict_id, and the first
 * answering model is the routed head unless an earlier attempt failed (then it must be a legitimate walk/step-up).
 * This is the silent-degradation check: a pin that never applied leaves the answer on the spawn leg (Default's head).
 */
function checkRoutedJoins(g) {
  let planner = 0;
  for (const run_id of g.runIds) {
    const v = g.h.verdict(run_id);
    if (!v) { check(`join ${run_id}: has a jev_verdicts row`, false); continue; }
    if (v.lane !== "planner") continue;
    const compose = g.h.attempts(run_id, "compose");
    if (compose.length === 0) continue; // a turn that ended in the triage harness only (case 11) has no planner call
    planner += 1;
    const first = compose[0].payload; const okAt = compose.findIndex((e) => e.payload.outcome === "ok");
    check(`join ${run_id}: first compose attempt routed_by = verdict_id`, first.routed_by === v.verdict_id, `routed_by=${first.routed_by} verdict=${v.verdict_id}`);
    if (okAt < 0) { check(`join ${run_id}: the planner answered`, false, "no ok compose attempt"); continue; }
    const answered = key(compose[okAt].payload.provider, compose[okAt].payload.model);
    const allowed = allowedModels(g, v.role, v.effort); const head = allowed[0];
    const headKey = head ? key(head.provider, head.model) : "(none)";
    const ok = okAt === 0 ? answered === headKey : allowed.some((c) => key(c.provider, c.model) === answered);
    check(`join ${run_id}: answered on the routed ${v.role} head (or a logged walk)`, ok, `answered=${answered} head=${headKey} failedBefore=${okAt}`);
    // F15: Default and Thinking share a head, so the pinned effort is what proves the routed pin applied
    if (okAt === 0) check(`join ${run_id}: the answering attempt carries the routed, clamped effort`, compose[0].payload.effort === head?.effort,
      `effort=${compose[0].payload.effort} want=${head?.effort}`);
    check(`join ${run_id}: verdict.model records the answering model`, noEffort(v.model) === answered, `verdict.model=${v.model}`);
  }
  check("join: at least 3 planner turns were checked", planner >= 3, `planner turns=${planner}`);
  const pinFailed = g.runIds.map((id) => g.h.verdict(id)).filter((v) => v?.route_outcome === "pin_failed");
  check("pin_failed = 0 across every gate turn", pinFailed.length === 0, pinFailed.map((v) => v.run_id).join(","));
}

/**
 * F11: an absolute bar (the live DB holds 4 triage events ever, so a 7-day baseline means nothing): at most one silent
 * skip in at least 8 real Jev calls, and the sweep's window over those calls is closed.
 */
function checkSkipAbsolute(g, from, to) {
  const cur = g.store.countJevCalls("triage", from, to, g.m.JEV_NOT_ATTEMPT_REASONS, g.m.JEV_SILENT_SKIP_REASONS);
  check("skip rate: ≥ 8 real Jev calls during the gate, at most 1 failed silently", cur.attempts >= 8 && cur.failed <= 1, `gate ${cur.failed}/${cur.attempts}`);
  check("skip rate: the sweep's window over the real-Jev calls is closed", !g.m.checkJevSkipRate(g.store, to, Date.parse(to) - Date.parse(from)).open);
}

/** F12: once the planners stop, no gate turn that reached the planner keeps a `pending` verdict (every terminal closes it). */
function checkNoPending(g) {
  const open = g.runIds.filter((id) => !g.triageOnly.has(id)).map((id) => g.h.verdict(id)).filter((v) => v?.handler_outcome === "pending");
  check("no planner-path verdict left pending after shutdown", open.length === 0, open.map((v) => v.run_id).join(",") || "none");
}

/** F9: the merge run needs Paco's committed rows to arm category, rule, status and memory in both languages. */
function checkCommittedArming(g) {
  const rows = g.m.calibrationRows(process.env);
  check(`arming: reported model ${g.m.model} has committed calibration rows (else the alias moved: every decision falls through)`,
    g.m.CALIBRATED_ROWS.some((r) => r.model === g.m.model));
  for (const lang of ["zh", "en"]) {
    const a = g.m.treeArmed(lang, g.m.model, rows);
    check(`arming (${lang}): committed CALIBRATED_ROWS arm category, rule, status and memory`, a.category && a.rule && a.status && a.memory, JSON.stringify(a));
  }
}

async function setup(args) {
  const m = await loadModules();
  m.loadHougeEnv();
  if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is not set (HOUGE_ENV_FILE?)");
  const repo = dirname(resolve(envFilePath())); // the LIVE repo: read for lessons/src scans; its DB is only copied
  const live = resolve(args.db ?? join(repo, "houge.sqlite"));
  if (!existsSync(live)) throw new Error(`no DB at ${live} (pass --db)`);
  m.model = await probeReportedModel(m); // before gateEnv: the temp calibration rows key on it
  const root = mkdtempSync("/tmp/hg-tree-"); // short: bridge sockets must fit sun_path (104 bytes)
  gateEnv(m, root, args.realCalibration);
  const dbPath = join(root, "houge.sqlite");
  copyDb(live, dbPath);
  const store = m.RunStore.open(dbPath);
  const cfg = m.resolveOmpConfig(process.env);
  const version = m.checkOmpVersion(cfg); // an unrunnable or silent omp refuses every planner spawn (no pin: Decision 13)
  if (!version.ok) throw new Error(`omp startup check failed (${version.kind}): ${version.reason}`);
  // Codex plan review 4: the whole config, so the read runs under the production child env (envPassthrough included)
  const catalog = await m.readOmpCatalog(cfg);
  if (!catalog || catalog.length === 0) throw new Error(`omp --profile ${cfg.profile} models --json returned no catalog`);
  const roles = new m.RoleResolver({ store, readCatalog: () => m.readOmpCatalog(cfg) });
  if (!(await roles.refreshCatalog())) throw new Error("RoleResolver.refreshCatalog failed against the real omp");
  const h = harness(m, store, repo, root, roles);
  const g = { m, store, h, root, dbPath, roles, chat: `-1000${Date.now() % 100000}`, worker: h.makeWorker(), runIds: [], triageOnly: new Set(),
    strict: args.realCalibration };
  const intake = h.intake; h.intake = (chat, text, replyTo) => { const id = intake(chat, text, replyTo); g.runIds.push(id); return id; };
  return { g, catalog };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { g, catalog } = await setup(args);
  const now = () => new Date().toISOString();
  console.log(`jev tree live gate — copy ${g.dbPath}, reported model ${g.m.model}, calibration ${args.realCalibration ? "committed CALIBRATED_ROWS (merge gate)" : "temp file"}, catalog ${catalog.length} models\n`);
  try {
    if (g.strict) checkCommittedArming(g);
    caseRoleHeads(g, catalog); caseRoleRules(g, catalog); await caseRolesTick(g);
    const from = now();
    for (const c of [caseMemory, caseStatus, caseAck, caseOkAfterProposal, caseQuote, caseRuleOnLookup, caseCorrection, caseOverflow, caseJevProbes]) await c(g);
    await g.worker.shutdownPlanners();
    const to = now();
    checkRoutedJoins(g);
    checkNaturalCascades(g);
    checkNoPending(g);
    checkSkipAbsolute(g, from, to);
    await caseParity(g);
    await caseSkipRate(g);
    await caseCascade(g); // last: its stubbed Jev rows are not real calls, so they stay out of both skip-rate windows
    check("skip rate: no jev_skip_rate incident open at the end", !g.store.listOpenIncidents().some((i) => i.kind === "jev_skip_rate"));
  } finally { await g.worker.shutdownPlanners(); g.store.close(); }
  if (inconclusive.length > 0) console.log(`\nINCONCLUSIVE (Jev's call, not a code fault):\n  - ${inconclusive.join("\n  - ")}`);
  console.log(failures.length === 0 ? "\nLIVE GATE: PASS" : `\nLIVE GATE: FAIL\n  - ${failures.join("\n  - ")}`);
  if (args.keep || failures.length > 0) console.log(`temp dir kept: ${g.root}`); else rmSync(g.root, { recursive: true, force: true });
  return failures.length === 0 ? 0 : 1;
}

main().then((c) => process.exit(c), (e) => { console.error(`live gate setup error: ${e instanceof Error ? e.stack ?? e.message : String(e)}`); process.exit(2); });
```

Notes the implementer must keep while writing the file (they are why the checks look the way they do):
- Note 4 of Rev 1 ("how the worker gets its RoleResolver") is settled: the gate injects its own through
  `OmpWorkerOptions.roles`, so the worker and the checks read one resolution.
- `userTurnOf` reads `getRecentChatTurns` (run-store.ts:1143), whose `ChatTurnRow` carries `quoted_turn_id` after
  Task 4 (its SELECT list must include the new column; Task 4 owns that).
- Cases 3, 4 and the "never the ack rule" half of 5 are code paths (`preJudge`), so a miss FAILs; cases 1, 2, 6, 7, 8
  depend on Jev's probabilities and go INCONCLUSIVE on another path (with the path's own consistency checked).
- `checkRoutedJoins` runs after the eight turn cases and the probes, and before case 11 (the probes' and case 11's
  turns run only `triageTurn` and have no planner call, so they are skipped there and in `checkNoPending`). It is the
  stage A PASS criterion; it fails when a turn routed Fast answers on Default's head with no failed attempt before it
  (the omp resume override from the 2026-10-01 live gate, reintroduced), and when a Thinking turn answers on
  Default's effort (F15).
- `checkSkipAbsolute` counts the window `from`..`to`, which holds cases 1–8 and the probes and excludes case 11's
  deliberate transport failures. `detectViolations` (`src/run/invariant-sweep.ts:239`) is pure, so case 11 opens no
  incident, and the end-of-run `jev_skip_rate` incident check stays meaningful.
- The quote case runs in the real chat of the picked outbox row (`target_json.chat_id`), inside the copy, with
  Telegram credentials deleted: nothing is sent. Its thread is Paco's real thread, sent to Jev and the planner exactly
  as the daemon would.
- Case 7 may stop at `waiting_for_approval` (the planner opens `memory_correct_write`'s card); `settle` treats that as
  ended, and the verdict's route fields are already final. `shutdownPlanners` cuts the child.
- Each `check` name is unique per run id where it repeats, so the FAIL list names the turn.
- Case 12a stubs Jev only; the cascade call itself is real (the gate's worker has the default LLM adapter, so
  `cascadeCall` takes the production `oneShotAdapter` path on the resolved Tiny chain). It runs after case 11, so its
  answered `jev_decisions` rows enter neither `checkSkipAbsolute`'s window nor case 11's rate window. 12b's INCONCLUSIVE
  is never a FAIL, also under `--real-calibration`: whether real Jev goes below the bar is not a code path.

- [ ] **Step 2: Build and run**

Run (in the repo or a worktree; a worktree has no `.env`):

```bash
npm run build && HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node scripts/live-gate-jev-tree.mjs
```

Precondition: omp runs and reports a version (see the override; otherwise setup exits 2 with the reason).

Expected: `LIVE GATE: PASS`, exit 0 (fish: `echo $status`; never through a pipe). Paste the full output into the task
report, including every `verdict[…]` line, the quote target line, the case 9 INFO line (today it names
`google-antigravity/claude-opus-4-6` in default, thinking and reviewer), case 12a's latency line and the INCONCLUSIVE
list. Any FAIL is a
finding: fix the code (or the gate's semantics if the gate is wrong — say which) and re-run. The merge run with
`--real-calibration` is Step 6.

- [ ] **Step 3: Commit**

```bash
git add scripts/live-gate-jev-tree.mjs
git commit -m "test(live): Jev decision tree stage A live gate against a copy of the live DB

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Retire the lane 1 gate (an orphan of Task 10)**

`scripts/live-gate-jev-triage.mjs` computes calibration hashes from `dist/jev/questions/triage.js` and asserts lane 1
`triage` fields (`lane`, `complete`, `scope`); after Task 10 removes those, it fails at setup on every run. Confirm nothing
but docs references it (`grep -rn "live-gate-jev-triage" src scripts tests package.json` prints nothing), then:

```bash
git rm scripts/live-gate-jev-triage.mjs
git commit -m "chore(live): remove the lane 1 triage gate, superseded by live-gate-jev-tree

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Doc mentions of the old gate are Task 14's (docs sync).

- [ ] **Step 5: Move `live-gate-omp.mjs` and `eval-replay.mjs` off the retired chain variables**

These scripts are JavaScript (no typecheck), so each rewrite is proven by running it (Step 5f).

**5a.** `scripts/live-gate-omp.mjs:49`. Replace:

```js
const BAD_PLANNER = "anthropic/no-such-model:medium,google-antigravity/claude-opus-4-6:medium,kimi-code/k3:low";
```

with:

```js
/** Case 6: an uncatalogued model the smoke injects at the head of Default (stage A: a /models pattern must match the catalog). */
const NO_SUCH_MODEL = { provider: "anthropic", id: "no-such-model", thinking: null };
```

**5b.** Case 6 (`:120-129`). Replace the whole entry, from `{ n: 6, title: "planner fallback: first string invalid"`
through its closing `] },`, with:

```js
  { n: 6, title: "planner fallback: Default head refused at spawn", send: () => "What is 17×23?",
    pass: "llm_attempt{error_kind:model_missing} for anthropic/no-such-model, then an ok compose row on the next Default candidate; reply arrives",
    check: (v, [r], c) => [
      [attempts(v, r, "compose").some((p) => p.error_kind === "model_missing"), "compose llm_attempt error_kind=model_missing"],
      // f2f1627: the ok row must FOLLOW the first model_missing (the fallback order, not any success); `fallbackAfterMissing` stays
      [fallbackAfterMissing(attempts(v, r, "compose")), "an ok compose row after the model_missing"],
      [attempts(v, r, "compose").some((p) => p.outcome === "ok" && `${p.provider}/${p.model}` === c.case6Next), `ok compose row on ${c.case6Next}`],
      [replyText(v, r).length > 0, "a reply was queued"]
    ] },
```

In `runLiveCase`, after `:734` (`if (cs.n === 14 && !c.d12Url) …`), add:

```js
  // Stage A: the daemon cannot be handed an uncatalogued Default head (a /models pattern must match the catalog).
  if (cs.n === 6) return { n: cs.n, title: cs.title, status: "SKIP", detail: "smoke only since stage A: --smoke --cases 6" };
```

**5c.** `runSmoke` (`:783`): hand the smoke case what case 6 needs to build its own worker. Replace:

```js
      results.push(await guardedCase(cs, () => runSmokeCase({ cs, store, worker, view, intake, seen, timeoutMs: args.timeoutS * 1000 })));
```

with:

```js
      results.push(await guardedCase(cs, () => runSmokeCase({ cs, store, worker, view, intake, seen, timeoutMs: args.timeoutS * 1000, CoreWorker, repo, root })));
```

Replace `runSmokeCase` (`:794-807`) with these two functions:

```js
async function runSmokeCase(d) {
  const { cs, store, view, seen } = d;
  if (cs.smoke) return verdict(cs, cs.check(view, [], await cs.smoke({ store })));
  const c6 = cs.n === 6 ? await case6Worker(d) : null; // its own worker: a Default role headed by an uncatalogued model
  const run = c6 ? { ...d, worker: c6.worker } : d;
  try {
    // numeric chat ids (turn-context requires it); a fresh chat = a fresh supervisor, and a retry gets its own (no refusal in its history)
    const got = await withRefusalRetry(cs, view, (attempt) => smokeTurn(run, `-1000${cs.n}${attempt > 0 ? attempt : ""}`));
    return caseResult(cs, got, seen, (runs) => verdict(cs, cs.check(view, runs, c6 ? { case6Next: c6.next } : {})));
  } finally {
    if (c6) await c6.close();
  }
}

/**
 * Case 6 on the TEMP copy: a RoleResolver over the real catalog plus one uncatalogued model, which a `default` override
 * heads. omp refuses it at spawn (`Model "…" not found` → model_missing) and the spawn axis walks to the next Default
 * candidate, the model the check expects. The override is reset afterwards (the copy is discarded anyway).
 */
async function case6Worker(d) {
  const [{ RoleResolver }, { readOmpCatalog }, { resolveOmpConfig }] = await Promise.all([
    import("../dist/omp/role-resolver.js"), import("../dist/omp/model-catalog.js"), import("../dist/omp/omp-config.js")
  ]);
  process.env.HOUGE_MODEL_ROLES = "resolved"; // overrides apply in resolved mode only (spec §4.3)
  const cfg = resolveOmpConfig(process.env);
  const roles = new RoleResolver({ store: d.store, readCatalog: async () => [...((await readOmpCatalog(cfg)) ?? []), NO_SUCH_MODEL] });
  d.store.recordModelRoleOverride({ key: "default", pattern: NO_SUCH_MODEL.id, actor: "live-gate" });
  if (!(await roles.refreshCatalog())) throw new Error("case 6: omp models --json returned no catalog");
  const [head, next] = roles.candidates("default");
  if (`${head?.provider}/${head?.model}` !== `${NO_SUCH_MODEL.provider}/${NO_SUCH_MODEL.id}` || !next) throw new Error("case 6: the override did not head Default");
  const worker = new d.CoreWorker(d.store, d.repo, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { dataDir: d.root, distDir: DIST, roles });
  return {
    worker, next: `${next.provider}/${next.model}`,
    close: async () => { await worker.shutdownPlanners(); d.store.recordModelRoleOverride({ key: "default", pattern: "", actor: "live-gate" }); }
  };
}
```

**5d.** Case 11 (`:150-158`). Replace the whole entry with (Contract deviation 3):

```js
  { n: 11, title: "D10: the reader skips the planner's family", send: () => "What's the weather in Sydney tomorrow?",
    prep: ["From the operator chat: /models set fast k3 · /models set default k3 · /models set thinking k3 · /models set reader k3 (no kickstart: an override applies on the next turn).",
      "After this case: /models reset fast · /models reset default · /models reset thinking · /models reset reader."],
    pass: "the read answers; its first reader llm_attempt is off the planner's family (kimi) although the reader override heads k3; no wall_collapse event",
    check: (v, [r]) => [
      [v.run(r)?.state === "completed", "run completed (the read proceeded)"],
      [(attempts(v, r, "reader")[0]?.family ?? "kimi") !== "kimi", `first reader attempt off the kimi family (${attempts(v, r, "reader").map((p) => p.family).join(",") || "no reader call"})`],
      [pay(v, r, "wall_collapse").length === 0, "no wall_collapse event (a cross-family candidate existed)"]
    ] },
```

Delete `driveCollapse` (`:524-530`) and the `incidentOpen` line of `openView` (`:70`): both are orphans of this
rewrite (`grep -n "driveCollapse\|incidentOpen\|collapseIncident" scripts/live-gate-omp.mjs` prints nothing after).

**5e.** Case 22's PASS text (`:219`): replace `on the HOUGE_OMP_TICKS top provider` with `on the Tiny role's top
provider`. `scripts/eval-replay.mjs`: replace `:2-4`

```js
// ≥ 2 through each HOUGE_OMP_PLANNER string as an ANSWER-ONLY one-shot (no tools, no session, no system
// prompt, no thread), then scores every answer 0–3 with the first HOUGE_OMP_JUDGES string. SP4 wires it
// into the self-write test gate; today it is a manual comparison of the planner strings.
```

with

```js
// ≥ 2 through each string of the planner chain (resolveOmpConfig: the Default role's static list) as an
// ANSWER-ONLY one-shot (no tools, no session, no system prompt, no thread), then scores every answer 0–3 with
// judge seat 0 of the same static lists. SP4 wires it into the self-write test gate; today it is a manual comparison.
```

and `:68-69`

```js
  console.log("  planners   : each HOUGE_OMP_PLANNER string alone, as a one-shot (no tools, no session, no system prompt)");
  console.log("  judge      : the first HOUGE_OMP_JUDGES string, rubric below");
```

with

```js
  console.log("  planners   : each string of the Default role's static list alone, as a one-shot (no tools, no session, no system prompt)");
  console.log("  judge      : judge seat 0 of the static lists, rubric below");
```

**5f.** Run:

```bash
grep -rnE 'HOUGE_OMP_(PLANNER|READER|MEDIA|TICKS|JUDGES|CHAIR|REVIEWER)' scripts
node scripts/live-gate-omp.mjs --dry
npm run build && HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node scripts/live-gate-omp.mjs --smoke --cases 6
node scripts/eval-replay.mjs --dry
```

Expected: the grep prints nothing; `--dry` prints the table with case 6 `[smoke]` and the new case 11 title; the smoke
prints `PASS` for case 6 (a `model_missing` row, then an ok row on the next Default candidate) and exits 0; the eval
plan prints the new wording. Case 11 runs only in the full gate against the daemon (Paco's session): it is not re-run
here, and the task report says so.

```bash
git add scripts/live-gate-omp.mjs scripts/eval-replay.mjs
git commit -m "chore(live): omp gate and eval replay on model roles, off the retired chain variables

Case 6 injects an uncatalogued Default head through a RoleResolver on the temp
copy (smoke only); case 11 now proves the D10 skip rule; eval-replay's help
text names the static role lists.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Pre-merge armed run (F9; after Paco commits the tree's `CALIBRATED_ROWS`)**

This is the merge gate, not a unit test: the rows do not exist until Paco commits them after the Task 12 replay.

```bash
npm run build && HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node scripts/live-gate-jev-tree.mjs --real-calibration
```

Expected: `LIVE GATE: PASS`, exit 0, with both `arming (zh|en): committed CALIBRATED_ROWS arm category, rule, status and
memory` checks PASS and cases 1 and 2 on their own lanes (memory saved with zero planner requests; status answered from
code). An INCONCLUSIVE on case 1 or 2 is a FAIL here: re-run once (Jev's probabilities vary); a second miss means the
committed rows or bars do not arm that lane in practice, which is Paco's call before merge, never a gate edit. Paste the
full output into the task report; Task 14's merge checklist cites it.

---

---

### Task 14: Docs sync and ship

No test seam (documentation); the gate is the reviewers' read plus `npm run typecheck && npm test && npm run build`
staying green. Placement rules: `CONTRIBUTING.md`.

**Files:**
- Modify: `docs/decisions/0029-jev-system-one.md` (amendment), `docs/decisions/0028-omp-runtime.md` (amendment),
  `docs/decisions/README.md` (index rows)
- Modify: `docs/reference/configuration.md`, `docs/reference/jev-decision-layer.md`, `CONTEXT.md`, `README.md`
- Modify: `docs/ROADMAP.md`, `tasks/todo.md`, `tasks/lessons.md`, `sessions.md`
- Modify: `docs/superpowers/specs/2026-10-06-jev-decision-tree-design.md` (Rev 9, Step 1b)

**Interfaces:** Consumes the shipped names of Tasks 1–13 verbatim (event types, incident kinds, env vars, commands).

- [ ] **Step 0: Pre-merge gate (all must hold before the branch merges; record each fact in the PR / session entry)**
  1. omp's startup check passes (`checkOmpVersion`: omp runs and reports a version; no pin since `a49da40`, Decision 13);
     record `omp --version` in the session entry.
  2. Task 12's replay ran on a DB copy; Paco read its arming-combination lines and committed `CALIBRATED_ROWS` for the
     questions he chose (his commit, not Claude's).
  3. Task 13 Step 6 (the armed run under `--real-calibration`) PASSES with the memory and status lanes **acting**
     (INCONCLUSIVE on cases 1 or 2 is a FAIL here).
  4. `npm run typecheck && npm test && npm run build` green on the branch, none skipped.
  5. Paco's cascade ruling is recorded (Decision 14: cascade live, 20 s, Tiny role); Step 1b reflects it, and Task 13
     case 12a PASSES (one Tiny call, answered and routed within 20 s).

- [ ] **Step 1: ADR 0029 amendment** (Paco's hand: `docs/decisions/` is protected; Claude drafts, Paco approves before
  commit). Append a dated "Amendment 2026-10-07 — one decision tree" section: the front of Houge is one decision point
  (six questions, three answer types); lanes are the leaf type (a workflow whose control flow is code), the planner is
  the floor; memory and status re-attached as categories; `jev_verdicts` as the per-turn row; arming on new
  `CALIBRATED_ROWS` after the replay; the routing policy stays under `src/jev/` (not gate machinery); below the choice
  bar, the cascade's one Tiny-role call, bounded at 20 s (plan Decision 14). Link the spec.
- [ ] **Step 1b: Spec amendment (Rev 9).** In `docs/superpowers/specs/2026-10-06-jev-decision-tree-design.md`:
  §4.3 — `off` + `static` is a **model-list rollback** (today's seven chains, no catalog, no override) with three stated
  supervisor differences (the per-child refused set, the removed respawn rule, step-up / `other` retry while Jev is on),
  not "exactly today's chain semantics"; restoring lane 1 is a code revert (Step 3's procedure). §9 stage A PASS — the
  `jev_skip_rate` criterion becomes the absolute bar Task 13 implements (≤ 1 silent skip in ≥ 8 real calls, incident
  closed), since the 7-day baseline held 4 triage events. §2.4 / §10 — per Paco's ruling (Decision 14): the cascade is
  live in stage A on the Tiny role (`LlmCallRole` `cascade`), bounded at 20 s; failure, timeout or an answer outside
  the two → Default, nothing saved; `cascade_between` on the `triage` event. The verdict's cascade value is `tiny` (the role), not
  `kimi` (§2.4's `cascade: kimi`; Kimi is not renewed next year, Paco 2026-10-07). §4 — the Tiny and Fast lists of Decision 3
  (Rev 4) and the Kimi-exit rule (every list keeps a non-Kimi leg). §2.2 — the stored intent enum sentence
  reads `clarify | loop | evolution_report` (the spec names two). Add a §12 row for the plan reviews.
- [ ] **Step 2: ADR 0028 amendment.** "Amendment 2026-10-07 — model roles": the seven `HOUGE_OMP_*` chains move to
  code-owned role lists (`src/omp/model-roles.ts`), resolved against `omp --profile houge models --json` with the
  provider allow-list before matching; the catalog is the authority (Paco 2026-10-07), so `openai-codex/gpt-5.5` became
  `openai-codex/gpt-6.1-sol`; effort clamped to catalogued thinking levels; `/models` overrides as ledger rows;
  `HOUGE_MODEL_ROLES=static|resolved` as a **model-list rollback** (with the three supervisor differences named in Step 1b);
  the planner's two-axis chain; D10 becomes a skip rule (resolved mode only). Add both index rows
  to `docs/decisions/README.md`.
- [ ] **Step 3: `configuration.md`.** In "LLM runtime — omp (ADR 0028)" (table at :66-85) delete the seven chain rows
  (`HOUGE_OMP_PLANNER`, `_READER`, `_MEDIA`, `_TICKS`, `_JUDGES`, `_CHAIR`, `_REVIEWER`) and add: `HOUGE_MODEL_ROLES`
  (`resolved` | `static`, default `resolved`, kickstart to change), a "Model roles" subsection listing each role's code
  list (copy `ROLE_LISTS` exactly), the `/models` commands, the daily change notice, incident `role_unresolved`, ledger
  rows `model_role_override`, `model_roles_resolved`, `model_catalog_unavailable`, `routed_escalation`. In "Jev System
  One (ADR 0029)" (:865) describe the tree flags (unchanged `HOUGE_JEV_TRIAGE_ENABLED`), the `jev_verdicts` table, the
  sweep kind `lane_fallthrough_rate`, the quote anchor (`chat_turns.quoted_turn_id`, `quote_unresolved`), and the replay
  command from Task 12 with its measured cost.
- [ ] **Step 4: `jev-decision-layer.md` rewritten around the tree**: decision point → state → questions → policy →
  lane / planner role; bars table; the cascade **live, 20 s, Tiny role** (Decision 14: one call between Jev's top two,
  exact-token pick, any failure → Default with nothing saved); corrections;
  arming sequence and couplings (memory needs `category` + `rule`; `category` alone moves turns off Default); the disarm
  marker caps the tree at shadow (= nothing armed, Default route) exactly as it capped lane 1; failure = Default as
  resolved. Add a **"Rolling back"** section: (a) `HOUGE_JEV_TRIAGE_ENABLED=off` + `HOUGE_MODEL_ROLES=static` in `.env`,
  kickstart — the model-list rollback, with its three differences; (b) restoring lane 1 itself: `git revert` the stage A
  merge commit(s) on `main`, `npm run build`, kickstart; the `jev_verdicts` table and `chat_turns.quoted_turn_id` column
  stay (additive, unread by the old code), and lane 1's `CALIBRATED_ROWS` come back with the revert.
- [ ] **Step 5: `CONTEXT.md`.** Under Core Terms add *category* (what kind of work a turn asks for; 11 values),
  *lane* (a handler whose control flow is code; one one-shot compose; falls through to the planner), *role* (a named
  model seat resolved from a code list against the catalog: Fast, Default, Thinking, Reader, Vision, Tiny, Judges,
  Chair, Reviewer), *quoted turn*. Keep the existing `research` scope/theme note consistent with spec §1.5.
- [ ] **Step 6: README** — one paragraph in the runtime section pointing at `configuration.md` § Model roles and
  `/models`; no duplicated variable list.
- [ ] **Step 7: ROADMAP delta, `tasks/todo.md` state block** (new top block: stage A merged, built and live; the
  Step 0 facts as completed (omp version ruling, rows Paco committed and which questions they arm, the armed gate PASS
  with both lanes acting); whether a kickstart is still owed), **`tasks/lessons.md`** (only lessons this
  build actually produced), **`sessions.md`** (one arc entry, newest last, with test counts and gate result).
- [ ] **Step 8: Verify and commit per concern**

```bash
npm run typecheck && npm test && npm run build
git add docs/superpowers/specs/2026-10-06-jev-decision-tree-design.md
git commit -m "docs(spec): Jev decision tree Rev 9 — rollback wording, absolute skip bar, live cascade, Rev 4 lists

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git add docs/decisions/0029-jev-system-one.md docs/decisions/0028-omp-runtime.md docs/decisions/README.md
git commit -m "docs(adr): ADR 0029/0028 amendments — decision tree and model roles

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git add docs/reference/configuration.md docs/reference/jev-decision-layer.md CONTEXT.md README.md
git commit -m "docs: model roles, /models and the Jev decision tree

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git add docs/ROADMAP.md tasks/todo.md tasks/lessons.md sessions.md
git commit -m "docs: stage A state, lessons and session entry

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Then rebuild `dist/` on `main` after merge, and tell Paco plainly whether a kickstart is needed (yes: new migrations,
new resolver at boot) and whether a run is in flight (check `houge.parked` / `houge.kill`, non-terminal runs and the
evolution lane first, per `tasks/lessons.md`).


---

## Drafter notes (raw, per stream — triaged in "Open questions for review" above)

### From tasks-01-03.md

1. **Verified in a scratch copy:** all three tasks were applied, in order, to a copy of `src/` and `tests/` from
   `main@94e3b4c`, with the repo's `node_modules` symlinked in. After each task, `tsc -p tsconfig.json --noEmit` exited 0.
   After Task 3, the full `vitest run` showed 3458 passed and 6 failed. All six failures are environment-only in the scratch
   copy: `tests/smoke.test.ts` needs `dist/`, `tests/eval/eval-runner.test.ts` needs the eval goldens, and
   `tests/omp/runtime-dirs-gitignored.test.ts` needs `.gitignore`. None of them touches `src/jev`. The code blocks above
   are copied from those files, not retyped.
2. **Spec gap: the offered-work clause on the score questions** (see the Task 3 wording note). This is a judgment call that
   changes three criteria hashes. Paco should confirm it, or drop it and accept that an agreeing ack after a heavy proposal
   runs at its category's floor role with `low` effort.
3. **`rule_scope` has no escape option**, which breaks mu's rule "an escape option on every choice". The contract fixes the
   two options. Code provides the escape: the question is read only when `sets_rule` is yes, at p ≥ 0.6.
4. **`isProposal` covers exactly the spec's four markers.** English offers ("want me to", "shall I") are not matched. In an
   English thread they are caught only when they end a `loop` reply as a question. Widening the regex is a one-line change
   if the replay shows misses on English proposals.
5. **A `loop` intent does not strictly mean a tool ran:** `assistantIntentFor` also stores `loop` for a tool-less reply of
   600 chars or more. Such a reply that ends in a question reads as a proposal. This errs toward Jev classifying instead of
   the ack rule settling, which is the safe side.
6. **Score answer consistency is not validated.** The client checks that `score` is in [0, n−1] and that the probabilities
   are a distribution over `"0".."n-1"`. It does not check that `score ≈ Σ i·p_i`. The vendor documents `score` as the
   expected level, but no live score answer has been probed yet. Recommend the Task 13 live gate log one raw score answer
   to confirm the meaning before Task 5's gear bar relies on it.
7. **Task 4 coupling:** Task 4 adds `quoted_turn_id: string | null` to `ChatTurnRow`. The `turn()` builder in
   `tests/jev/tree-questions.test.ts` is the only `ChatTurnRow` literal this plan's Tasks 1–3 add, so Task 4 must add
   `quoted_turn_id: null` there. The same is true of the existing builder in `tests/jev/questions.test.ts:7`, and of any other
   `ChatTurnRow` literal Task 4 finds by grepping `chat_id: "c", run_id:`.
8. **Tree hashes are not pinned in a test.** Their pin is the `CALIBRATED_ROWS` that Paco commits after the replay (Decision
   6). A test pin before then would need re-pinning on every wording review edit.
9. **`choiceAnswer` miss paths are unreachable** through the real client. `replay.ts` emits `jev_failed/parse`,
   `triage-replay.ts` emits `jev_failed/error`, and `core-worker` returns `skipped{parse}`. They exist so that a client
   which skipped validation fails loud instead of throwing on `undefined.choice`. They are not tested separately.
   `decide()`'s type check, which is tested, covers the live path.

### From tasks-04-08.md

1. **Task 7 → Task 8 seam: the resolver's name on `CoreWorker`.** Task 8's core-worker hunk passes `roles: this.roles`.
   The contract does not name the `CoreWorker` field; if Task 7 named it differently, use that field (the type must be
   the `RoleResolver` instance, `Pick<RoleResolver, "candidates">` is all the supervisor needs).
2. **`HOUGE_OMP_PLANNER` in tests.** Task 8 moves the four supervisor-test uses to `fakeRoles`, so these tests no longer
   depend on the env var Task 7 removes. `tests/core/core-worker-omp-turn.test.ts:130` and `:178` still set it; they are
   Task 7's (`:178` asserts `omp_config_invalid` names `HOUGE_OMP_PLANNER`, which stops being true once the variable is
   ignored). If Task 7's drafter also rewrote the four supervisor tests, keep Task 8's version.
3. **Migration count.** Task 4 bumps `tests/run/run-store-approvals.test.ts` 29 → 30. Task 9's `jev_verdicts` migration
   must bump it to 31 and extend the comment; whichever of 4/9 lands second edits the number its predecessor left.
4. **Zero rows resolve as `no_mapping`, not `ambiguous`.** The brief said "exactly one → ok, else ambiguous". The spec
   says "none or several → unresolved", and the contract's reason union has both values; I used `no_mapping` for zero
   (nothing stored to point at, e.g. a command message's run with no chat turn) and `ambiguous` only for several. Both
   are unresolved; only the ledger note's reason differs.
5. **Step-up and the `other` retry apply only to routed turns (`turn.route !== null`).** An unrouted turn — a schedule
   fire, Jev triage absent, or a triage throw (`triage_threw` → `{ kind: "fallthrough" }`) — keeps today's semantics
   exactly (Default walked, then `no_planner_leg`; `other` final), which is what spec §4.3 promises for static mode.
   Open question for Task 10 / Paco: the Jev-failure fallback ("planner on the Default role as resolved", spec §2.4)
   writes a `jev_verdicts` row, so Task 10 will likely pass a `route` with a `verdict_id` — and that turn then steps up
   to Thinking and retries `other` once. If the fallback should behave exactly like today, Task 10 should pass the
   route with a marker or the supervisor should key step-up on `route.verdict_id && reason === "routed"`; the contract
   has no field for that today.
6. **`routed_escalation` is written on a role step-up only** (from/to are role names, `kind` the error kind that spent
   the chain, `model_missing` after pin refusals). Each walk within a role is already one `llm_attempt` row per leg; a
   per-leg escalation event would duplicate it. Spec §4 is ambiguous ("Ledgered `routed_escalation {from, to, kind}`"
   follows both sentences).
7. **A failed first pin disables step-up for that turn but not the list walk.** Spec §5: "no escalation on a child that
   just refused a pin". A later retryable error still walks `turn.chain` with `set_model` (today's behaviour after a
   failed reset); if that `set_model` also fails the turn fails `retry_failed` as today.
8. **`fast_used_tool` uses the role the turn finished on** (`turn.role`), not the routed role: a Fast turn that stepped up
   to Default before running a tool is not a Fast-ran-a-tool signal.
9. **`llmAuditSink` (run-store.ts) was already 66 lines** (over the 50-line rule before this task); Task 8 adds one line
   to it. Splitting it is unrelated refactoring and was left alone.
10. **Quotes the resolver cannot see:** attachments sent as separate Telegram messages (their ids are not stored), and
    any message Houge sent outside the outbox. Both resolve `no_mapping` → one ledger note (Task 10), plain message.
11. **Nothing in Tasks 4/8 calls `resolveQuotedTurn` or builds a `QuoteRef`.** Task 10 owns that: read
    `reply_to_message_id` from the claimed event's metadata (telegram-trigger-adapter.ts:367-376), call
    `resolveQuotedTurn`, build `QuotedTurn` (age from the stored row's `created_at`, which is completion time; `kind` by
    the same rule as `lastHougeTurnOf`), and pass `quote: { turn_id, line: quotedLine(q, resolveChatContextTurnChars(env)) }`
    in every `TriageOutcome` it returns (the ack rule must not fire for a quoted message, spec §2.1).
12. **`UNRESOLVED_MODEL`.** If the Default role resolves to nothing at construction, the supervisor's intended model is
    `unresolved/unresolved` (family `other`) until a spawn; the first turn then fails `no_planner_leg` with
    `planner_no_leg`. Task 11's `role_unresolved` incident is the page for that condition; the supervisor does not raise it.

### From tasks-05-09-10.md

1. **Status lane floors.** The global constraint says both lanes "keep lane 1's floors". Lane 1 applied
   `minConf` / `minGap` to memory only (`thresholds.ts:53-54`); status needed p(status) alone. Task 5 applies the
   floors to both lanes, which is stricter, so the change is toward the planner. With probabilities summing to 1 the
   gap floor can never bind at p ≥ 0.8. The confidence floor can bind for status: p = 0.8 over 11 options gives
   confidence 0.78, which clears. Paco should confirm.
2. **A rule inside a status question goes to the planner, not the status lane** (Task 5). Spec §3 says "sets_rule yes
   with any category: save, then that category's handler". The status lane is a code reply that would never mention
   the saved lesson, and the lane is defined as "nothing else". Saving and then running the planner with the
   `[memory]` note is the faithful reading. Flag it for the spec.
3. **The cascade's save scope** defaults from Jev's first non-lane candidate, not from the cascade's pick: the
   contract's `RoutePlan` has no place for the `rule_scope` answer after the plan. The two differ only when the
   pick is `research`, the first candidate is not, and `rule_scope` is under its bar. Rare, and the lesson then lands
   under `ask`.
4. **Shadow arms nothing.** In shadow mode the tree is evaluated with every question unarmed. Every verdict then reads
   `uncalibrated` / `fallback` with `category` null; Jev's answers stay in `jev_decisions` with decision `shadow`.
   That keeps "shadow never changes behaviour" literal (no cascade call, no ack rule, no save). The cost: a shadow
   verdict does not record the category the tree would have taken. Since stage A arms on Paco's word (Decision 6),
   shadow is mostly a legacy flag value; consider retiring `shadow` in Task 14's docs.
5. **`think harder` on a skipped turn.** Task 10 honours it on every path, including flag off (`HOUGE_JEV_TRIAGE_ENABLED=off`,
   half of the rollback). If the rollback must reproduce the pre-stage-A model path exactly, gate `held.thinkHarder` on
   `mode !== "off"`. That is a one-line change, but Paco should decide.
6. **The cascade's `llm_attempt` precedes the planner's.** The §9 PASS criterion "every routed turn's first
   `llm_attempt` joins a verdict" must mean the first attempt carrying `routed_by` (Task 8), or the gate's query must
   skip `role = 'cascade'`. Task 13's gate should say which.
7. **`CASCADE_TIMEOUT_MS = 10 000`** is mine; the spec gives no bound. The cascade blocks the turn. Jev's own call is
   1.5 s, so a Kimi one-shot through omp could add up to 10 s on a below-bar turn. Consider 5 s after the live gate
   measures it.
8. **`user` quoted turns get `kind: "answer"`.** The contract's `QuotedTurn.kind` is required, and a user turn has no
   Houge kind. Task 3's `buildTreeState` could omit `kind` for `role: "user"` so Jev never reads a meaningless field.
9. **Task order.** Task 9 type-imports from Tasks 3 and 5, and Tasks 7 and 8 write the event types Task 9 adds. The
   plan's order line ("9 may run beside either") should become 1–5 → 9 → 6–8 (or 9 right after 5).
10. **Ack rule's skipped row.** `jev_decisions` gets a `skipped` row with `skip_reason = 'ack_rule'`, excluded from
    `jev_skip_rate` attempts. Task 12's replay universe should label these turns `answer` (the proxy table has no
    entry for them).
11. **Correction precedence.** First correction wins, except "Ask Houge anyway", which overwrites. The spec names
    four corrections but not their order. One column cannot hold two; a later reader wanting all of them would need
    the `triage_override` events, the ratings table and the `routed_escalation` events, which already exist.
12. **`HOUGE_JEV_TRIAGE_MIN_*` env bars** are no longer read by the decision point; the tree uses
    `TREE_BAR_DEFAULTS` with no env override, because the contract defines none. Task 14 must update
    `configuration.md`. If Paco wants `.env`-tunable tree bars like lane 1's, add a `resolveTreeBars(env)` in Task 5.

### From tasks-06-07.md

1. **Override semantics are a reading of spec §4, not a quote.** §4 lists "override, then list" as resolution steps
   and calls the result "an ordered candidate list". Tasks 6–7 implement the override's matches **first, then the
   catalogued list** as a fallback, so an override whose model is later retired degrades to the list rather than
   emptying the role. `ResolvedRole.source` is `"override"` when the override matched at least one model. If Paco
   means the override to *replace* the list, `resolveRole` drops `...listed` when `overrideCandidates` is non-empty,
   and two tests change. Raise this in the plan review.
2. **Effort on override candidates** is not specified anywhere. Implemented: the effort the role's list gives the same
   `provider/id`, else the role's first selector's effort, then clamped. For planner roles Task 8's routed effort
   replaces it anyway.
3. **Decision 4 effort ambiguity.** "Static semantics for filtering (no catalog check, no clamp)" could mean the routed
   effort is still applied, unclamped. Implemented: with no catalog, `clampEffort` returns the selector unchanged, so
   routed effort is ledgered and not applied. An unclamped `medium` on `kimi-code/k3` (levels low/high/max) could be
   refused by omp.
4. **The refused set applies in static mode too.** Today's static semantics would re-pin a refused selector. Skipping
   a selector the running child already refused can only avoid a known failure. If static must reproduce today
   exactly, `resolveRole`'s static branch drops `.filter(fresh)`.
5. **D10 is implemented as a stable partition** (all cross-family candidates first, then same-family, each in list
   order). Spec §8 says "the first reader candidate whose family differs runs first". The partition satisfies that
   sentence and also keeps a later cross-family leg ahead of a same-family one after the first fails. A literal
   "move one candidate" would let a collapse happen while a cross-family leg was still unused.
6. **`chains()` never returns an empty chain.** A non-judge role that resolves empty falls back to its code list
   (walked past on `model_missing`, as before stage A). Judges keep their index: an unresolved seat keeps its listed
   selector and fails alone. Task 11's `role_unresolved` incident must read `resolveAll()` (which shows `head: null`),
   not `chains()`.
7. **The planner's chain is captured once per chat.** `supervisorDeps` builds `cfg` when the chat's supervisor is
   created, so until Task 8 moves the supervisor onto `roles.candidates()` per turn, a Default override reaches a chat
   only after its supervisor is recreated (daemon restart). Every one-shot seat (reader, ticks, panel, reviewer, media,
   status) reads `roles.chains()` per call from this task on.
8. **CLI seats stay on the static lists.** `src/cli.ts:405, 438, 490` (`houge jev replay`, `lessons consolidate`,
   `radar-panel`) build `resolveOmpConfig(process.env)` with no resolver, so `/models` overrides do not reach CLI
   one-shots. Making them resolve would mean an `omp models` spawn per CLI command. Flag if wanted.
9. **The Default list is one leg longer than the pre-stage-A planner chain** (orchestrator update, 2026-10-07: both
   Antigravity generations are kept). Effects: static mode walks `google-antigravity/claude-opus-5-5` before
   `claude-opus-4-6`; the planner seat's `seatBudgetMs` (`answer` / `compose`) grows from 3 to 4 one-shot timeouts.
   `tests/core/core-worker-runner-caps.test.ts:30` computes the same value from the config, so it stays consistent.
   The supervisor tests pin the old three-leg chain through `WALK_CHAIN`, because they test the walk, not the list.
   `scripts/live-gate-omp.mjs` case 6 expects an "ok compose row on claude-opus-4-6" after an Opus 5.5 refusal. With
   the new list the fallback is Antigravity Opus 5.5, so that check would FAIL even apart from item 10.
10. **`scripts/live-gate-omp.mjs` cases 6 and 11** set `HOUGE_OMP_PLANNER` / `HOUGE_OMP_READER` (prep text and, for case
   6, in-process at `:787-794`). After this task those variables are ignored, so case 6 would stop exercising the
   spawn fallback: no `model_missing` row would appear (the silent-degradation class), and its opus-4-6 check fails
   for the reason in item 9. The SP1 gate needs either retiring those cases or rewriting them over a
   `model_role_override` row plus a catalog the fixture controls; Task 13 or 14 should own that. `scripts/eval-replay.mjs`
   help text (`:2-3, 68-69`) also names `HOUGE_OMP_PLANNER` / `HOUGE_OMP_JUDGES`. It reads `resolveOmpConfig(process.env)`,
   so it still works on the static lists; only its text is stale. Task 14 docs sync also owns `.env.example:42-48` and
   `docs/reference/configuration.md:71-77` and their cross-references.
11. **Task 11 must not re-add** the `model_role_override` / `model_catalog_unavailable` ledger types (added here). Its
    daily tick and `/models set` should call `worker.modelRoles().refreshCatalog()`, which already writes the
    unavailable note.
12. **Boot latency.** The boot catalog read is awaited before the first poll and bounded at 15 s
    (`CATALOG_TIMEOUT_MS`). Under launchd a hung `omp models` delays the first poll by that much once. The
    alternative, reading in the background after the first poll, would let the first turns resolve without a catalog
    (Decision 4 semantics). The spec says "before the first turn", so it is awaited.
13. **Probe still owed before the live gate:** that `omp --profile houge models --json` returns the same catalog under
    the allowlisted child env (`buildChildEnv(cfg.envPassthrough)`, i.e. without the operator's full shell env) as in
    the 2026-10-07 probe, which ran from a full shell. If omp needs a variable outside the allowlist to list a
    provider, that provider's selectors would silently drop from every role.
14. **Test-run risk to check in Step 18:** daemon tests that use `fakeOmp` now spawn the fake once more at boot (the
    `models --json` branch exits before writing `FAKE_OMP_ARGV_LOG`, so spawn-count assertions are unaffected). Daemon
    tests that use only `pinOmpEnv` (non-executable `HOUGE_OMP_BIN`) gain one run-less `model_catalog_unavailable`
    ledger row. A test that asserts the full run-less ledger would see it.

### From tasks-11-13.md

#### Task 11

1. **Task 9/10 shape the invariant depends on.** `lane_fallthrough_rate` assumes a lane turn's `jev_verdicts` row keeps
   `lane = 'memory' | 'status'` when it falls through (only `handler_outcome` becomes `fallthrough:<reason>`), and stays
   `pending` until the handler settles it. If Task 10 rewrites `lane` to `planner` on a fall-through, the invariant can never
   fire. The tests insert rows with string run ids (as `tests/run/invariant-sweep-jev.test.ts` does for `jev_decisions`);
   if Task 9 gives `jev_verdicts.run_id` a foreign key, seed runs with a direct insert (not `createQueuedTurnRun`, which
   hits the 5-per-minute Telegram rate limit after five runs).
2. **`role_unresolved` is not a sweep kind.** Spec §8 lists it beside the sweep invariants, but the tick opens and clears it
   (`openAlertedIncident` / `resolveOpenIncidents`). Adding it to `SWEEP_INCIDENT_KINDS` would make every sweep resolve it as
   "not seen". The trade-off: it is checked once a day, at the tick.
3. **Task 7 coupling.** The accessor `CoreWorker.roleResolver()` returns Task 7's resolver field (assumed `roles`). The list
   rendering and the judge-seat keys assume `resolveAll()` returns judge seats as `judges:<i>` (0-based, the
   `ROLE_LISTS.judges` index) and heads/candidates as `formatModelString` output (with `:effort`). If Task 7 renders
   differently, `effortOf` shows "default" and the seat numbering in `/models` changes. Check both when Task 7 lands.
4. **The refusal reason uses its own substring match.** `outside_allow_list` versus `no_match` comes from a case-insensitive
   `provider/id` substring check over the raw catalog. If Task 6's `matchOverride` matches case-sensitively, a mixed-case
   pattern could get the wrong reason. Whether the pattern is saved is decided by `matchOverride` alone.
5. **The catalog read cannot be aborted.** `readCatalog` takes no signal, so a kickstart during `omp models` (about 1–3 s)
   waits for it, well under launchd's 40 s `ExitTimeOut`. Task 7's `readOmpCatalog` needs its own exec timeout.
6. **Catalog outage policy.** The tick advances its 24 h latch on a failed read (`catalog_ok: false`), so it spawns the CLI
   at most once a day. The cost: one failed read means a day without a fresh catalog, even if omp recovers an hour later.
   The alternative (retry hourly while the last row is `catalog_ok: false`) is a two-line change. Paco to choose.
7. **`/models set` validates against the cached catalog**, which can be up to 24 h old (boot or tick). Gateway intake is
   synchronous, so it cannot refresh the catalog first. A model catalogued since the last read is refused as `no_match`
   until the next tick.
8. **Effort column.** `/models` shows each head selector's own effort. For the chat roles the applied effort is routed per
   turn and clamped (Decision 2), so for fast, default and thinking the column shows the list's effort, not what every turn
   runs at.
9. **Static mode refuses `/models set`** rather than saving an override that is never applied (spec §4.3: static means no
   override). Paco to confirm. `reset` stays allowed in static mode.
10. **`/models reset judges`** appends a reset row only for seats that hold an override, so there are no no-op rows. The spec
    says it "resets every judge seat"; the effect is the same.
11. **Daemon suites.** Every existing daemon test now runs the roles tick on its first cycle. With `pinOmpEnv` the read fails
    fast (`NO_OMP_BIN`): one `model_roles_resolved` row, no notification, no incident. A suite that asserts exact ledger
    counts needs a filter (Step 14 says so). A suite without `pinOmpEnv` spawns the PATH stub `omp` once
    (`tests/helpers/setup-no-real-omp.ts`), which fails, so no real quota is spent.

### Orchestrator edits to the forked drafts (Tasks 12 and 13)

- Task 13 called Task 12's replay `runTriageReplay`. Task 12 renames the export to `runTreeReplay` (file name kept), so
  every reference in Task 13 is changed to match, along with its deviation paragraph.
- Task 13 gains Step 4: `git rm scripts/live-gate-jev-triage.mjs`. That gate becomes an orphan of Task 10, and Task 12's
  note 9 hands it to Task 13. `grep` shows no reference from `src`, `scripts`, `tests` or `package.json`.
- Task 13 note 1 and the plan's Decision 3 disagree with the live catalog: `google-antigravity/claude-opus-4-6` and
  `google-antigravity/claude-opus-5-5-high` are not catalogued (probed 2026-10-07). That needs a ruling in Task 6's lists
  before the gate can pass.
- Task 12 note 1 (one shared quoted-turn builder for live and replay) affects Task 3/4/10. Without it, every quoted turn's
  replay `state_hash` misses its live row.

#### Task 12


1. **Quoted-turn builder must be shared with the live path.** The contract names `QuotedTurn` but no
   `ChatTurnRow → QuotedTurn` builder; this task creates `quotedTurnFromRow` in `triage-replay.ts`. Task 10's live
   decision point builds the same value from `resolveQuotedTurn(...).turn`; if it computes `kind` or `age_s` any
   differently (e.g. a `kind` for a quoted *user* turn other than `"answer"`, or age from a different instant), every
   quoted turn breaks state parity. Recommend the plan move this helper into `src/jev/questions/tree.ts` (Task 3) and
   have Task 10 and Task 12 both import it. The parity test (step 1d) covers only an unquoted turn.
2. **Spec §7 "steps" is ambiguous.** Interpreted as the run's `web_search` + `http_fetch` `loop_step` rows (stated in the
   task). Alternative reading (all tool steps in the run) changes research/lookup for turns that mix a helper such as
   `to_local_time`. Paco or the plan review should rule.
3. **Unmatched tools.** Live DB since 2026-07-02 has capabilities no §7 rule names: `to_local_time` (57 rows),
   `memory_correct` (17), `llm_answer`, `bounty_scan`, `project_list`, `external_work`, `shell_destructive`. A run using
   only these is `unmatched_tools` (unlabelled), not `answer`. `shell_destructive` arguably belongs to `machine_task`
   and `memory_correct` (the non-write proposal) to `memory`; the spec's lists are followed literally.
4. **Ack ambiguity also reads the quoted turn.** The spec says "the previous Houge turn was a proposal"; the task also
   treats a tool-less turn quoting a proposal as unlabelled (§2.2.1's precedence). Flag for the reviewer.
5. **Memory arming key unknown.** The candidate-rows block emits the six question ids plus `category:status` (the only
   pseudo-row the contract names). If Task 5's `treeArmed` arms memory or gear on another pseudo-id, add it to
   `candidateRows` (`triage-report.ts`) so Paco's commit arms what the report claims.
6. **No tree-bar env overrides.** Lane 1 read `HOUGE_JEV_TRIAGE_MIN_*` through `resolveTriageBars`; the contract has
   only `TREE_BAR_DEFAULTS`, so the report uses the defaults. If Task 5/10 adds an env resolver, the CLI should pass it.
7. **Parity test assumptions about Task 10:** the live `triageTurn` still takes `{ claim, text, userText, modality,
   posture, signal }`, still asks Jev when nothing is calibrated (routes `uncalibrated` afterwards), still writes the
   `category` decision row with `thread_cut_at` / `state_built_at`, still accepts `HOUGE_JEV_TRIAGE_ENABLED=arm`, and
   `buildTreeState` still renders `recent_turns[].text`. If Task 10 skips the Jev call when unarmed, the replay loses its
   live comparison rows and the first parity case needs a test calibration file.
8. **Report has no GO bars by design** (spec §1 ruling 4: arm on Paco's word); it prints candidate rows whenever the run is
   complete. The lane 1 report's shadow requirement and per-class Wilson bars are dropped with `triageShadowStats`.
9. **`scripts/live-gate-jev-triage.mjs`** imports `dist/jev/questions/triage.js` indirectly via the calibration hashes and
   reads lane 1 `triage` fields; it is dead after Task 10 and is Task 13's to delete or replace.

#### Task 13


1. **Plan Decision 3 / Task 6 lists name two ids the catalog does not carry** (probed `omp --profile houge models
   --json`, 2026-10-07): `google-antigravity/claude-opus-4-6` (today's planner leg 2 and reviewer leg 2, and Thinking[2])
   and `google-antigravity/claude-opus-5-5-high` (Thinking[1]). Decision 3's "every id catalogued on 2026-10-07" is
   false for both. In resolved mode they are dropped silently, so Default would be `[anthropic/claude-opus-5-5,
   kimi-code/k3]` and Reviewer `[kimi-code/k3]`. Note the live DB shows a `compose` answered on
   `google-antigravity/claude-opus-4-6` after 2026-10-04, so the account could still use it while the catalog has
   stopped listing it; per Decision 1 the catalog wins. Suggest replacing both with `google-antigravity/claude-opus-5-5`
   (`:medium` / `:high`), which is catalogued. The gate FAILs until the lists match the catalog.
2. **Thinking's head equals Default's head** (`anthropic/claude-opus-5-5`); only the effort differs, and `llm_attempt`
   does not record effort. So the routed-join check cannot tell a Thinking pin from a Default one by model. The Fast
   case (case 3, Fast head `anthropic/claude-sonnet-5-5`) is the one that catches a pin that never applied. Recording
   the applied effort on the attempt row (or on `jev_verdicts`) would close the gap; not in the contract today.
3. **Who reads `reply_to_message_id`.** The gate sends it in the event `metadata` exactly as
   `telegram-trigger-adapter.ts:359-376` does. Task 4/10 must read it from there (the adapter keeps no other copy);
   if they read it elsewhere, case 5 FAILs on `quoted_turn_id`.
4. **How the worker gets its `RoleResolver`** is Task 7's call; the gate builds its own resolver over the same copy
   and catalog to compute the expected candidates. If the worker's resolver were built with a different env or a stale
   catalog, the join check would FAIL (correctly) rather than pass vacuously.
5. **Lane limits in stage A:** only memory and status are lanes and neither has limits (spec §3), so "one turn that
   overflows its lane" is exercised as a lookup-shaped request beyond lookup's limits (`research`), which in stage A
   proves the planner-on-routed-role path and the research → Thinking floor. A true lane overflow arrives in stage B.
6. **Routed turn definition** for "every routed turn's first `llm_attempt` joins": the gate applies it to planner-lane
   verdicts (the supervisor stamps `routed_by`, contract Task 8). Lane turns join via the `triage` event's
   `verdict_id`; if Paco wants the memory lane's distill leg stamped too, Task 10 must add it.

---

## Review record

### Round 1 (Rev 1 → Rev 2)

Reviews: Codex plan pass (NOT READY: 5 blockers, 3 risks) and senior live-probe review (NOT READY: 4 blockers, 7 warnings, 7 suggestions). All findings verified by the orchestrator; none rejected. Senior blocker 1 (omp upgraded to 18.7.0 today vs the 18.4.4 pin) is outside the plan: Paco's call; the gate's setup now refuses to run on a version mismatch.

#### Stream A changes


- **F1: static is today's model path, seat for seat.** `src/omp/model-roles.ts` gains `STATIC_ROLE_LISTS`. These are the
  pre-stage-A `HOUGE_OMP_*` DEFAULTS (`src/omp/omp-config.ts:18-24` at main@94e3b4c), copied string for string: planner
  as `default` (and as `fast` and `thinking`, so static adds no model), reader, media as `vision`, ticks as `tiny`,
  judges, chair, reviewer. `staticRoleChains()` and `resolveRole(..., mode: "static")` read it. `ROLE_LISTS` (Decision 3)
  serves `resolved` only. `roleSelectors(role, seat?, mode = "resolved")` picks the table. Task 6 tests all seven seats
  against today's strings. Two consequences:
  - `resolveOmpConfig(env)` without a resolver (the CLI, scripts, most tests) returns today's chains exactly. Rev 1's
    test rewrites that only existed because of the longer Default list are gone: the `omp-config` test is two hunks,
    not a rewrite, and the supervisor tests drop `WALK_CHAIN`.
  - The static residual differences are the per-child refused set (Q9, Task 6 test comment), the removed
    respawn-on-planner[0] rule (Task 8), and, while Jev is on, step-up and the `other` retry on routed turns. They are
    stated in the proposed Decision 1 text below and in a Task 6 test comment.
- **F2: D10 reorder is resolved-mode only.** `readerOrder` (`src/llm/providers/omp.ts`) reads
  `resolveModelRolesMode(process.env)` per call. Static keeps the list order and flags `family_collapse` per same-family
  leg, as today. There is a new static test. Rev 1 broke a test it did not list, `tests/llm/seat-routing.test.ts`
  "a reader on the planner's family … (D10)": the default reader starts on Gemini, so with planner family `gemini` the
  skip rule ran k3 first. Rev 2 fixes that test.
- **F3: Task 8's supervisor-test hunks now apply after Task 7.** Rev 2 generated them mechanically from the Task 7 result
  (see Verification). Task 7 gives `harness` an `o.planner` option and changes the four call sites to
  `harness(session, {}, {}, { planner: … })`. Task 8 then:
  - replaces those four with `harness(session, {}, { roles: fakeRoles({ default: [ … ] }) })`;
  - removes `o.planner` and Task 7's chain override from `cfg`, since the supervisor no longer reads `cfg.planner`;
  - drops the two imports that become orphans.
- **F7: an empty resolved role.** One rule in `RoleResolver`, used by both `candidates()` and `chains()`. It applies when
  a role resolves empty before the refused filter, which can only happen in resolved mode against a catalog:
  - `fast` returns `[]` and the supervisor steps up;
  - every other role runs its `STATIC_ROLE_LISTS` entry, unfiltered and unclamped, minus the child's refused set. That
    covers `default` (both axes), `thinking`, every non-turn seat, and each judge seat by index.
  - One `model_roles_fallback {role}` note is written per role key per catalog read.
  - `resolveAll()` does not fall back: an emptied role shows `head: null`, which is what Task 11's `role_unresolved` reads.

  **Why `default` falls back on the turn axis too, not `[]` + step-up.** F7's wording distinguishes the spawn axis.
  One rule is correct on both axes. If resolved Default is empty, every static Default selector is also uncatalogued
  (static Default ⊂ `ROLE_LISTS.default`). If the catalog is right, the spawn fails anyway (`no_planner_leg`). If the
  catalog is wrong, the child spawned on a static selector and the turn axis holds that same selector, so no pin is
  needed. `candidates()` has no axis parameter, and adding one would buy nothing.

  On `no_planner_leg` the supervisor calls `roles.requestRefresh()`, which the resolver rate-limits to once per
  `NO_LEG_REFRESH_MS` (10 min). `SupervisorDeps.roles` becomes `Pick<RoleResolver, "candidates" | "requestRefresh">`.
  **Task 9 must add `model_roles_fallback: ["role"]`** (Stream B).
- **F14 (owner: Task 7, `RoleResolver`).** `refreshCatalog()` counts consecutive failed reads. Every failure keeps
  Decision 4's ledger note. The 2nd consecutive failure opens the alerted incident `model_catalog_unavailable`
  (subject `omp`, detail `{consecutive_failures}`) through `openAlertedIncident`, once while it is open. The next good
  read resolves it through `resolveOpenIncidents`.

  The hourly retry is `RoleResolver.retryFailedRead()`. It re-reads only when the last read failed and is at least
  `CATALOG_RETRY_MS` (1 h) old, and returns `null` otherwise. The daemon poll loop calls it once per cycle (`void`, never
  awaited). A read in flight is joined, never doubled.

  **Task 11 must not add** catalog retry or catalog-incident logic. Its daily tick calls `refreshCatalog()`, which feeds
  the same counter. Q10's "a failed tick read is not retried for 24 h" is superseded.
- **F15: `LlmAttempt.effort?: OmpEffort`.** `RunStore.llmAuditSink` carries it on the payload. The supervisor's single
  `audit()` adds the effort of the selector each row ran on: the spawn candidate for a start refusal, the pin target for
  a pin refusal, and the pinned `this.model` for dispatch, error and abort rows. That covers every compose attempt.
  Tests cover routed rows, start-refusal rows and the sink. Q12 is closed. Task 13's Thinking case can assert `effort`.
- **Smaller corrections found by running the plan on a scratch copy:**
  - `tests/core/core-worker-runner-caps.test.ts` computed the expected budget from `resolveOmpConfig(process.env)`,
    while the worker's seats run on its resolver's chains. With no catalog these are the whole `ROLE_LISTS`, so the
    planner has 4 legs, not 3. Task 7 injects one resolver and reads both from it.
  - `RoleResolver.resolveAll` needed `flatMap<…>` typing to pass `tsc`.
  - The `run-store-model-roles` test keeps its validator case for `model_role_override` / `model_catalog_unavailable`.
    Those types come from Task 9; this task adds no ledger type.

#### Stream A verification


A scratch copy is `git archive main@94e3b4c` with the repo's `node_modules` linked. Stand-ins were applied for earlier
tasks:
- Task 4: its run-store / turn-context / test changes, from the previous drafter's verified probe;
- Task 3: `QuotedTurn`;
- Task 5: `TurnRole` / `Effort` type stubs;
- Task 9: the six ledger types, with `model_roles_fallback`.

Tasks 6 → 7 → 8 were implemented one commit each and all checks passed:

| Stage | Command | Result |
|---|---|---|
| Task 6 | `npx vitest run tests/omp/model-roles.test.ts tests/omp/model-catalog.test.ts` | 32/32 |
| Task 7a | `npx vitest run tests/omp/role-resolver.test.ts tests/run/run-store-model-roles.test.ts` | 16/16 |
| Task 7 | `npm run typecheck`, then the full suite | clean; 3502/3502 in 257 files |
| Task 8 | `npm run typecheck` | clean |
| Task 8 | `npx vitest run tests/omp/planner-supervisor.test.ts tests/omp/planner-session.test.ts tests/run/llm-audit-sink.test.ts tests/run/run-ledger.test.ts tests/llm/audit-coverage.test.ts` | 172/172 |
| Task 8 | full suite | 3515/3515 in 257 files |
| Task 8 | `npm run build` | OK |

Every hunk in Tasks 7 and 8 below was generated by diffing consecutive commits of that copy, with the minimal context
that makes the old text unique in its file. They were then re-applied from this document to a fresh copy at the
stand-in commit; that check is reported at the end of this file.

---

#### Stream B changes


**Task 5 (routing policy)**
- F5: `applyCascade` with no pick, or a pick outside the two → `cascade_failed`, Default, **`save: null`**. A valid pick
  fixes the rule's scope from the **picked** category; a confident `rule_scope` (p ≥ 0.6) still overrides. Contract
  addition: the `cascade` variant of `RoutePlan` gains `ruleScope: "ask" | "research" | null`. Tests for both.
- F6: `Armed` gains `rule` (sets_rule + rule_scope rows, independent of `category`); `memory = category && rule`. The
  status lane acts only when `status` **and** `rule` are armed; with `rule` unarmed nothing saves and neither lane acts
  (planner, Default, `uncalibrated`). Tests for each.
- F10 note: `cascadePlan` / `applyCascade` are kept (replay, stage B); Task 10 no longer calls `applyCascade`.
- `lane_limits` comment (senior suggestion); `isBareAck` cite corrected to `bare-ack.ts:11`.

**Task 9 (store)**
- Assembly overrides folded in: six event types, all owned here: `routed_escalation`, `model_roles_resolved`
  `["resolved_at","catalog_ok","roles"]`, `model_catalog_unavailable`, `model_role_override`, `quote_unresolved`, and
  **`model_roles_fallback` `["role"]`** (Stream A's F7). The ledger test covers all six.
- F10: `jev_verdicts.cascade` CHECK accepts `'deferred'`; type `VerdictCascade = "kimi" | "deferred" | null`.
- F12: new `closePendingJevVerdict(run_id, handler_outcome): number`, guarded `WHERE handler_outcome = 'pending'`. Test.
- Incident kinds are free strings (`openIncident({ kind: string })`, `run-store.ts:4573`), so the F14
  `model_catalog_unavailable` incident needs nothing from Task 9 (stated in the overrides).
- Migration count set to 31 (Task 4 → 30 first).

**Task 10 (decision point)**
- Overrides folded in: `quotedTurnFromRow` (no private `quotedTurnOf`); lane fall-through keeps its lane; the memory
  lane sees the quote (code + test: a quoted Houge reply becomes `priorAnswer`; a quoted user turn leads
  `threadUserTexts`), applied in `runLessonWrite` for both callers.
- F13: `off` = exactly one skipped{disabled} row, one verdict (category null, Default, `jev_skipped`, skip `disabled`),
  one `triage` event naming it, **no route**; `think harder` ignored on `off`. Tests rewritten; the think-harder-on-skip
  test moved to a photo turn.
- F10: no cascade call. A `cascade` plan settles as `fallbackRoute("below_bar")`, nothing saved, verdict `cascade =
  'deferred'`, `triage` event gains optional `cascade_between: [a, b]`. Removed: `cascadePick`, `withinMs`,
  `parseCascadePick`, `CASCADE_*`, `LlmCallRole "cascade"` (and the `run-store.ts` hunk). Tests rewritten (including a
  confident `sets_rule` below the bar → nothing saved).
- F12: `ompComplete` / `ompFail` / `recoverPlannerLeases` close a pending verdict via `closeVerdict` (after the run's
  terminal write is won); `ompRouteEnd` moves `handler_outcome` through the same guarded write. Every supervisor
  terminal path is traced to one of these (cited). Tests: complete → `planner_done`; lane reply untouched; a run failed
  the way `abortAll`/`shutdown` fail a queued run → `planner_failed`; `failStrandedTurns` (restart) → closed;
  `recoverPlannerLeases` (crashed turn) → closed; routeEnd after a terminal close keeps the outcome, writes the model.
- F6: `UNARMED` gains `rule: false`; partial-row-commit tests (status armed without rule rows → no status lane;
  category without rule rows → memory uncalibrated). `calibrationFile(omit)` test helper.

**Task 11 (/models, tick, sweep)**
- Overrides folded in: `worker.modelRoles()` (Task 7) everywhere; no `roleResolver()` accessor; no `run-ledger.ts`
  hunk; `core-worker.ts` and `run-ledger.ts` leave the Files list and the commits.
- The `runModelTicks` hunk is rewritten against Task 7's result (`runMemoryTicks(options, now, signal,
  worker.modelRoles())`), and its line refs corrected to the real `:511-524`; the gateway insert point is `:181`.
- F14 assumption stated (Stream A owns the hourly retry + incident in Task 7; the tick stays a 24 h latch). F7
  assumption stated (`resolveAll()` reports the pre-fallback resolution, so `role_unresolved` still fires).

**Task 13 (live gate)**
- Overrides folded in, with two justified deviations: `live-gate-memory-a1.mjs` stays Task 7's (its Step 17 already
  rewrites it); `eval-replay.mjs` keeps `resolveOmpConfig` (static = today's 3-leg chain, which `driveReplay`'s
  3-planner check needs), help text only. New Step 5 rewrites `live-gate-omp.mjs` case 6 (smoke-only, RoleResolver
  with an injected uncatalogued Default head on the copy) and case 11 (now proves the D10 skip rule: a reader override
  can no longer collapse under the Task 7 rule; `driveCollapse` / `incidentOpen` orphans removed), with run commands.
- F8: case 9 = head is the first **catalogued** list selector, on an allowed provider, not openai-codex on a chat role;
  uncatalogued entries INFO. Stale opus-5-5-high note removed.
- F9: under `--real-calibration`, `checkCommittedArming` (treeArmed arms category, rule, status, memory in zh + en) and
  cases 1/2 INCONCLUSIVE → FAIL. New Step 6 = the pre-merge armed run.
- F11: absolute skip bar (≤ 1 silent skip in ≥ 8 real Jev calls; window closed; no `jev_skip_rate` incident at the
  end); two triage-only real-Jev probes added so the gate reaches 9 real calls; 7-day baseline removed.
- F12: `checkNoPending` after shutdown. F15: joins and case 8 assert the answering attempt's routed, clamped `effort`.
- Codex 4 (not listed in FIXES, but Task 13's): both `readOmpCatalog` calls take the full `cfg` (production child env).
- Senior BLOCKER 1: setup runs `checkOmpVersion` and exits 2 on the 18.7.0-vs-18.4.4 mismatch; Paco chooses first.
- The gate's workers get the gate's own refreshed `RoleResolver` (`OmpWorkerOptions.roles`): otherwise the worker routes
  on an unread catalog (no clamp) and the joins compare two resolutions (a latent Rev 1 bug the F15 check would hit).

### Cross-stream assumptions (Stream A / other tasks must match, or the orchestrator reconciles)
1. **Task 12** (not mine): its `ALL_ARMED: Armed` literal (plan Rev 1 `:10634`) needs `rule: true` or typecheck fails;
   its `replayRoute` calls `applyCascade(plan, null)` for a cascade plan, which now saves nothing but reads
   `cascade_failed`; to mirror live stage A it should return `fallbackRoute("below_bar", plan.base.thinkHarder)`.
2. **Task 7**: writes `model_roles_fallback {role}` and `model_catalog_unavailable {reason}` through `recordMemoryEvent`
   (types from Task 9); owns F14's hourly retry and the `model_catalog_unavailable` incident (subject "omp"); its timers
   must be `unref()`'d (daemon tests construct workers whose boot read fails); `resolveAll()` reports the pre-fallback
   head (`null` for an empty role); `OmpWorkerOptions.roles` exists (Task 13 gate and `live-gate-omp.mjs` case 6 use it).
3. **Task 8**: `LlmAttempt.effort` is the pinned candidate's effort after the clamp, equal to what
   `RoleResolver.candidates(role, { effort })` returns for that candidate (Task 13 compares the two). `routeEnd` may run
   before or after `outcome.complete/fail`: Task 10's guarded writes make the order irrelevant.
4. **Task 14**: the merge checklist names Task 13 Step 6; `configuration.md` drops any cascade timeout; Q5/Q10/Q12 rows
   updated as below; the ADR amendment states the `off` exit (verdict, no route) and the cascade deferral.

### Round 2 (Rev 2 → Rev 3, Codex confirmation pass)

Codex confirmed all eight round-1 Codex findings and senior blockers 2–4 CLOSED; senior blocker 1 (omp 18.7.0 vs the
18.4.4 pin) stays open as Paco's call and is now pre-merge condition 1 (Task 14 Step 0). New findings, all verified and
fixed by the orchestrator:

| # | Finding | Fix |
|---|---|---|
| 1 | BLOCKER — Task 12 still defined and imported its own `quotedTurnFromRow` against the binding override | Local definition, export, contract paragraph and test import removed; `triage-replay.ts` and its test import Task 3's builder from `questions/tree.js` |
| 2 | BLOCKER — no evidence of what each partial arming commit changes before Paco commits rows | Task 12: `replayRoute(r, bars, armed?)`, `ARMING_COMBOS` (category · category+gear · category+rule · category+rule+status · all) and `armingLines` in the report, naming the turns that leave planner/default; one report test |
| 3 | BLOCKER — "full rollback" overstated what `off` + static restores | Decision 1 text, Task 14 Steps 1b/2/4: a *model-list rollback* with three named supervisor differences; lane 1 restore = revert + build + kickstart, documented |
| 4 | RISK — no explicit merge checklist; state block listed row commits as a post-gate action | Task 14 Step 0 (omp version, replay read + Paco's rows, armed gate PASS with both lanes acting, green suite, cascade ruling); Step 7 records them as completed facts |
| 5 | RISK — a score a rounding ulp past an endpoint voided the whole call | Task 1: 1e-9 endpoint tolerance, clamp onto [0, n−1], one test |
| 6 | RISK — spec §9 baseline and the cascade deferral disagree with the plan | Task 14 Step 1b: spec Rev 9 amends §4.3, §9 (absolute skip bar), §2.4/§10 per Paco's cascade ruling, §2.2 intent enum |

Senior suggestions left open, with reasons: historical quotes cannot be backfilled (the mapping did not exist before
Task 4; the replay reports quoted turns only from new rows, which Task 12 already does); cached-token cost per role is
reporting the ledger already holds (`cached_input_tokens` on every `llm_attempt`) and belongs to the post-arming review,
not this build.

### Round 3 (narrow Codex confirmation of the round 2 fixes)

Findings 3, 5 and 6 CLOSED. Finding 1: the leftover unused `ChatTurnRow` import in `triage-replay.ts` removed. Finding
2: `armingLines` now compares each turn's route under a combination with **that turn's own nothing-armed route** (the
ack rule and `think harder` route off Default even unarmed), keyed `from→to`, and the test asserts the swallowed fixture
turn `b` is named on the `all` line. Finding 4 **rejected**: `HOUGE_OMP_VERSION_ALLOW` is the configured mechanism the
version check itself honours (`src/omp/omp-version.ts:28`) and one of the remedies offered to Paco for the 18.7.0
upgrade; the pre-merge condition is that the running check passes, by pin or by allow-list, on Paco's ruling.

### Round 4 (Paco's rulings, 2026-10-07 → Rev 4)

| # | Ruling | Where it landed |
|---|---|---|
| A | **The cascade stays live in stage A, 20 s bound** (reverses Rev 2's Decision 8 / Q5 / F10) | New Decision 14 (Rev 4 rulings block, with contract deltas); Decision 8 struck through and pointed at 14; Q5 closed. **Task 5:** the "does not call" paragraph and `applyCascade`'s doc now name Task 10's live call (code unchanged; F5 fixes kept). **Task 9:** `VerdictCascade = "kimi" \| null`, CHECK `cascade IS NULL OR cascade = 'kimi'`, deviation 4 rewritten, the store test now rejects `deferred` and accepts `kimi` on a `cascade_failed` row. **Task 10:** override bullet and deviations 1/3 rewritten; `LlmCallRole` `"cascade"` (`run-store.ts:68-70`; `seatChain`'s default branch already maps it to `cfg.ticks` = Tiny, comment only); `OneShotAdapterOptions.deadlineMs` → `OneShotInput.deadlineAt` + `legUnderDeadline` in `spawnOneShot` (on top of Task 7's `readerOrder` loop), so the 18 s chain deadline audits a slow leg `timeout`, never `shutdown`; `cascadeRoute` / `cascadePick` / `cascadeCall` (production `oneShotAdapter` with the deadline, or the injected adapter with `signal`, bypassing `llmToolAdapter`, which drops `signal`) and module helpers `CASCADE_TIMEOUT_MS = 20_000` (exported), `CASCADE_LEG_DEADLINE_MS`, `cascadePrompt`, `parseCascadePick` (exported; exact token after stripping quotes/backticks/asterisks/final stop), `withinMs` (timer armed before the call; expiry aborts it through `AbortSignal.any` with the turn's signal); failure/timeout/invalid → `applyCascade(plan, null)`; a valid pick with a rule goes through `saveThenRoute`; `TriageSettle.deferred` → `between`, which writes `cascade_between` on the `triage` event (kept: it names what the call chose between) and `cascade = 'kimi'` on the verdict even if a later throw settles the turn. Tests: the below-bar describe rewritten (pick routes with its floor; pick + rule saves under the pick's scope; four failure shapes → `cascade_failed`, nothing saved; a hung call cut at the bound under fake timers with the in-flight call aborted; think harder; one candidate → no call; shadow → no call; `parseCascadePick` table); `tests/llm/seat-routing.test.ts` gains the cascade-chain case and the chain-deadline case. Files list, Interfaces, Step 2/4 commands and the commit (files + message) updated. **Task 12:** `replayRoute` settles a cascade plan as `applyCascade(plan, null)` (live failure semantics; `fallbackRoute` import → `applyCascade`), the report line reads "below-bar turns a live cascade would ask the Tiny role about (replayed as cascade_failed, no model call)", plus one `replayRoute` test. **Task 13:** PASS-join override says the cascade attempts precede the planner's and the join reads `compose` only; new case 12a (stubbed below-bar Jev, one real Tiny call on the head, answered, reason `cascade`, pair on the event, ≤ `CASCADE_TIMEOUT_MS`; runs last so its stub rows stay out of both skip-rate windows) and 12b (natural below-bar turns: cascade attempts before the planner's, no `routed_by`; INCONCLUSIVE when none, never a FAIL); header comment, module `need` list (`CASCADE_TIMEOUT_MS`, `CATEGORIES`) and Interfaces updated. **Task 14:** Step 0 item 5, Step 1 (ADR 0029), Step 1b (spec §2.4/§10, §4 lists), Step 4 wording and the spec commit subject. |
| B | **Lists** (resolved `ROLE_LISTS` only; `STATIC_ROLE_LISTS` unchanged): Tiny = `kimi-code/k3:low`, `google-antigravity/gemini-3.8-flash:low`; Fast = the two sonnet-5-5 legs + `gemini-3.8-flash:low` (k3 removed) | Decision 3 list text + the Kimi-exit paragraph (every list keeps a non-Kimi leg; judge seat 1 = override key `judges:0` needs a replacement then). **Task 6:** `ROLE_LISTS` code and its doc comment; the Decision 3 list test now pins Fast, Thinking and Tiny; new test "every role list except the per-seat judges keeps a non-Kimi leg". **Task 7:** the `model_roles_fallback` note test (no claude, no k3) now expects Default, judges:0, Chair, Reviewer (Tiny keeps gemini-3.8-flash), 4 notes then 5 after a re-read. **Task 13:** case 1's leg check accepts the Tiny role's candidates instead of k3 only (a fall-through to gemini-3.8-flash is still the memory lane's model); case 9's "Tiny head = kimi-code/k3" still holds. |
| C | **omp version pin → contract probe, separate slice** | New Decision 13. Decision 11's last sentence, Task 13's version override, the gate's setup error text and Step 2's precondition, Task 14 Step 0 item 1 and Step 3 (`configuration.md` note) now say: no pin bump in code; `HOUGE_OMP_VERSION_ALLOW` in `.env` carries the installed version until the probe ships. |

Superseded by this round (kept above as history): Rev 2 Decision 8, the F10 items in the Round 1 Stream B list,
cross-stream assumption 1's `fallbackRoute("below_bar")` suggestion and assumption 4's "cascade deferral" wording, and
raw drafter notes 6 (resolved: the join reads `compose` attempts keyed on `routed_by`) and 7 (the bound is 20 s, Paco's).

Open after this round, for the implementer to confirm against the code:
1. `AbortSignal.any` (Node ≥ 20.3; `@types/node` ^25 declares it) is new to `src/`; Task 10's typecheck step proves it.
2. The hung-cascade test relies on `vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })` installed after
   `setup()` and on nothing in `triageTurn` awaiting a faked timer before the cascade. Probed: the Jev client arms one
   `setTimeout` per call (`jev-client.ts:93`) that the stubbed 200 clears, and sleeps only on a retry
   (`jev-client.ts:79`), which a 200 never takes; the advance inside the fake would at most fire that already-cleared
   timer. If a later change adds an awaited timer on that path, the test hangs rather than passes falsely.
3. The verdict column value stays `kimi` (the spec's name) although the Tiny role's second leg is gemini-3.8-flash and
   Kimi exits next year; renaming it (e.g. `tiny`) is a spec + migration change, left to Paco.

### Round 5 (rebase onto `main@80e23bb`, 2026-10-08 → Rev 5)

Seven commits landed after the plan's base (`a49da40` omp unpin + agy voice resolver, `f2f1627` omp gate cases 3/6,
`cf12402` roadmap, `c026e5c` + `a35568c` Jev alias and reported-model calibration, `de914ef` self-write test-gate env,
`80e23bb` Houge's own schedule `#N` fix). What changed in the plan:

| # | Change | Where |
|---|---|---|
| A | **No omp version text.** The pin is gone on main (`checkOmpVersion` refuses only `not_runnable` / `no_version` → `omp_unavailable`). Decision 13 records it as shipped; Decision 11, the gate's setup error, Task 13's precondition, Task 14 Step 0 item 1 and Step 3 drop `HOUGE_OMP_VERSION(_ALLOW)`; Task 7's `omp-config.ts` hunks 2 and 6 now anchor on `HOUGE_OMP_SANDBOX` (the lines the removed version keys used to sit beside). | Decisions 11/13, Tasks 7, 13, 14 |
| B | **The Jev model is the REPORTED id.** `JEV_MODEL` is now `JEV_REQUEST_MODEL = "jev-latest"`, and `calibratedLang` refuses it. Every test that armed on `JEV_MODEL` keys a local `REPORTED = "jev-1.13.0"`; Task 5 adds `treeArmingRows` (lane 1's `armingRows` for the tree) plus an alias-never-arms case; Task 10's `routeAnswered` keeps the shipped alias-move page (`checkJevModel` → `checkJevModelCalibrated(…, treeArmingRows(rows))`, arm mode only, after `held.answered`) with two tests; Task 12's replay warns on a model move mid-run or across a resume (seeded from the file), the report blocks on more than one reported model (canonical + permuted) and keys candidate rows on the reported id; Task 13's gate probes the reported id once before writing its temp rows, its 12a stub reports it, and `--real-calibration` checks the committed rows name it. | Tasks 1, 2, 5, 10, 12, 13 |
| C | **Cascade verdict value `kimi` → `tiny`** (Paco 2026-10-07: Kimi is not renewed). `jev_verdicts` is new in stage A, so no migration; Task 14 Step 1b amends spec §2.4. Round 4 open item 3 is closed by this. | Decision 14, Q5, contract, Tasks 5, 9, 10, 13, 14 |
| D | **Lane 1 orphans get a deleting step.** Task 10 handed `questions/triage.ts` and `thresholds.ts` to Task 12, and Task 12 assumed Task 10 had removed them, so no task did. New Task 12 Step 3f deletes both plus `tests/jev/thresholds.test.ts`, moves its `calibratedLang` / `calibrationRows` / alias cases to a new `tests/jev/calibration.test.ts`, trims `questions.test.ts`, and makes `decide.test.ts` carry the three lane 1 questions as fixture data. | Task 12 (Files, Step 3f, commit) |
| E | **Case 6 of `live-gate-omp.mjs`** keeps `f2f1627`'s ordering check (`fallbackAfterMissing`: the ok row must follow the first `model_missing`) beside the resolved `case6Next` check. | Task 13 Step 5b |
| F | **Line anchors remapped** by `git diff -U0 94e3b4c 80e23bb` hunk offsets (143 anchors; anchors inside a changed hunk checked by hand against the live file). Contract drift fixed on the way: the interface contract's `Armed` lacked `rule`. | all tasks |

Not changed, checked: Houge's `80e23bb` touches `schedule_task` handling only (`resolveScheduleId`), outside every Task
10 hunk. `de914ef` gives the self-write gate a minimal env; no task depends on the gate's env. The Review record above
keeps its pre-rebase anchors as history (`jev-client.ts:93` / `:79` in Round 4 item 2 are now `:98` / `:84`).

Codex confirmation of Rev 5: READY, 18 anchors sampled, no blocker. Two NITs fixed: Task 12's "Assumes after Task 10"
now points at Step 3f for the deletion, and Task 10's `CalibrationRow` doc anchor is `:11-15` (the lane 1 wording it replaces).
