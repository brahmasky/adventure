# mu (qybaihe/mu) decision points, as mu documents them (2026-10-12)

Read: 2026-10-12 via raw.githubusercontent.com / GitHub API. main HEAD = `faed8c364323c477399b1dc2ef1d2fa36ce51267` (committed 2026-10-10T02:42:57Z, "fix(desktop): recover startup after reinstalling mu"). Note decision-points.md is auto-generated from `packages/kyrn-judge/manifest.json`.

Sources (base https://raw.githubusercontent.com/qybaihe/mu/main/):
- README.md; docs/reference/decision-points.md (canonical list, "38 in all"); docs/reference/features.md; docs/judges.md; docs/architecture.md; docs/adding-a-decision-point.md
- packages/kyrn-judge/manifest.json (ids, groups, feature switches, option defaults)
- packages/kyrn-judge/src/decisions/*.ts (question types, `latency`, `cacheImpact`)
- kyrn/docs/04-injection-points.md (Chinese, dated 2026-09-21, pre-rename; hook position, safeguards); kyrn/docs/08-jev-retrospective.md (Chinese, 2026-09-21)

## 1. Count: 38 decision points
Input 3, Context 13, Tools and safety 9, Turn 8, Teamwork 5. Group names are mu's own (manifest groups: input, context, tools, turn, team). I counted the rows myself: 3+13+9+8+5 = 38, matching mu's claim.

Conventions in the table:
- "Fires" = pi hook/timing from kyrn/docs/04 (older doc; may have drifted) or README loop diagram. "not stated" where neither says.
- "Verdict kind" = question types in `src/decisions/*.ts` (bool = yes/no, choice, score). mu's docs speak of yes/no, choice, score generally.
- "Effect" = mu's own wording. mu does NOT use a hint/steer/gate/record-only taxonomy except as noted: README says "the answer changes what the model does next, never whether it asks you"; `shadow` mode = record-only. Where I write steer/followUp etc. that is mu's own word in doc 04.
- "Latency/cache" = source `latency` (inline = blocks loop, parallel = races other work, background = never blocks) and `cacheImpact` (none / append-only / prefix-mutating).
- Mode: docs/reference says every point is `active` unless set otherwise (built-in default `"modes": {"default": "active"}`). Exception: kyrn/docs/04 (2026-09-21) says "default all shadow"; that is superseded by the later docs. A point whose feature is off by default is not asked at all; flagged below.
- Feature = switch under `features` in ~/.mu/agent/mu.json. All features default on EXCEPT: `compaction`, `ttsr`; `admission.testLog` default `off`; `board.defaultOn` false.
- waitMs = per-feature max wait before the turn proceeds without a verdict (from manifest).

## 2. Table

### Input
| id | Fires | Decides | Verdict kind | Effect (mu's words) | Latency/cache | Feature (default) / waitMs | Numbers |
|---|---|---|---|---|---|---|---|
| `input.preflight` | before model (hooks `input` -> `before_agent_start`) | Message type and how much thinking it needs | choice + 6 bool + 3 score | One-line hint to model; optionally sets turn thinking level (option `thinking`, default false; "a switch loses the cache"); thinking restored at agent_end | inline / append-only | `preflight` (on) / 4000 ms | Doc 04: 804 ms chat verdict, 741 ms heavy task (Jev direct); 85 ms with Laya on 4 of 10 questions |
| `task.frame` | before model (on input) | Per message: new task, new hard constraint, correction, new subgoal, or no change | choice | Only a change has a model rewrite the task frame (goal, constraints word for word, acceptance criteria) | inline / append-only | `frame` (on) / 3000 ms (writerTimeoutMs 20000) | not stated |
| `input.interjection` | while agent runs (hook `input`, streaming) | Mid-run message: interrupt now vs after current step (doc 04: correction / append / side-branch / other) | choice | Re-sends as steer or followUp if it differs from the user's key choice; unsure keeps user's choice | inline / append-only | `interjection` (on) / 1500 ms | not stated |

### Context
| id | Fires | Decides | Verdict kind | Effect | Latency/cache | Feature / waitMs | Numbers |
|---|---|---|---|---|---|---|---|
| `skills.disclosure` | before model (first turn; sticks for session) | Which skills are relevant | bool per skill | Only relevant skills enter the prompt; hidden ones findable via `/skill:name` / `find_skill`; hide only on high-confidence "no" | inline / prefix-mutating (first turn only) | `skills` (on), minSkills 4 / 4000 ms | Retro: 511 hidden skill-description instances over 13 sessions, median ~40/session; 55 ledger verdicts |
| `capability.disclosure` | before model (not stated precisely) | Does the task need an installed pack/MCP server | bool | Opened, and process started, only then | inline / prefix-mutating | `catalog` (on) / 4000 ms | not stated |
| `tool.admission` | after tools (`tool_result`; after tool.injection) | Per ~1200-char chunk of long output: error/result/progress/warning/passing/other; does it matter | choice | What matters enters context; noise archived to temp file with a one-line pointer; first/last chunks, errors, source reads, short output always pass | inline / none | `admission` (on): minChars 4000, chunkChars 1200, maxChunks 48, batchChunks 16, passThrough read/edit/write / 4000 ms | README: 16 chunks in one request 0.44 s. Retro (194 batches, 2,412 blocks): 0 dropped; ~54% of recorded Jev input tokens; batch p50 1,351 ms, p95 3,807 ms |
| `tool.admission.test-log` | after tools (test output) | Exact repeats kept once (rules, no model); optionally judge selects what the goal needs | bool per block (Jev mode) | Repeats folded losslessly with pointer; judge drops a block only if "not needed" p >= 0.9 | inline / none (same admission path) | `admission.testLog`: **off by default**; `rules` or `jev` | README (replay 2026-09-21): repeats fold saved 51.0% of 139,820 chars (7 real Vitest logs; 86/44/44/47/16% on 5 largest); Jev selection 40.2% cut, 0/72 required lines lost (29 tuned goals), 46.4% cut 0/19 lost on 9 held-out; perfect judge 52.5%/46.5%; failures-only 61.9% (9 lost)/59.4% (6 lost); 282 live requests ~$0.017; median 345 ms |
| `context.forget` | before each request when context use crosses 50/70/85% (hook `context`) | Will this old result's full output be needed again (judge sees call+length only) | bool | Outgoing request replaces with head/tail (600 chars) tombstone; session file untouched | inline / prefix-mutating | `forgetting` (on): thresholds 50/70/85, minChars 6000, minAgeTurns 2, maxPerBatch 12 / 4000 ms | Retro: 3 of 11 Jev candidates shrunk; ~27,654 chars saved in one projection; 156,744 chars saved by deterministic rule (not Jev) |
| `context.compact` | at compaction (`session_before_compact`) | Per old tool call: output type, full text still needed, call still matters | choice + 2 bool | No summary; user/assistant text verbatim; stale tool output pruned (head 300 chars + archive path); rules first, then lexical relevance, then judge score; falls back to pi summary if over budget | background / prefix-mutating (only at compaction boundary) | `compaction`: **off by default** (beta) | not stated |
| `memory.recall` | before model (`before_agent_start`; also per sub-agent task) | Which lessons apply to the task | bool per lesson | Up to 5 matching lessons injected, one line each | inline / append-only (none for sub-agent variant) | `memory` (on): maxCandidates 24, maxInjected 5 / 4000 ms | not stated |
| `memory.capture` | on input (background) | Does the message correct the agent or set a standing rule | 2 bool | Becomes a lesson (via memory.merge) | background / none | `memory` | Retro: 6 verdicts, all skip, no measurable benefit |
| `memory.outcome` | turn end / goal met (background) | After going in circles/off course and ending with passing check or goal met, was the way out a different approach | bool | Writer records "trap + way around" as workaround lesson; at most once per turn | background / none | `memory.outcome` (true) | not stated |
| `memory.worth` | in `remember` tool; `Lesson:` lines of sub-agent reports | reusable / one-off / already known / unclear | choice | Only "reusable" kept | inline / none | `memory` | not stated |
| `memory.merge` | before a lesson is stored | Vs ~6 most similar kept lessons: same / refines / contradicts / unrelated / unclear | choice | Same: not stored twice; refines: replaces old; contradicts: user's latest word wins | inline / none | `memory` (mergeNeighbours 6) | not stated |
| `memory.applied` | turn end (background) | Were the injected lessons followed | bool | Counts as applied; recalled >= 8 times and never followed (confident "no") -> retired | background / none | `memory.applied` (true; retireAfter 8) | not stated |
| `cache.warming` | idle (hook `cache_warming_decision`) | Will you be back before the prompt cache expires (user's last message ends conversation? assistant's last asks a question?) | 2 bool | Refresh cache or let it expire; otherwise pi default | background / none | `warming` (on); `warmup` intervalMs 50000, idleMs 900000 | not stated |

### Tools and safety
| id | Fires | Decides | Verdict kind | Effect | Latency/cache | Feature / waitMs | Numbers |
|---|---|---|---|---|---|---|---|
| `tool.risk` | after model, before tools (`tool_call`) | Rules flag dangerous command first; judge asks only whether the user asked for it (doc 04 also: irreversible?) | bool (incl. `requested`) | No voucher -> ask user; no UI -> block. Judge can only add a gate, never open one; no answer = ask | inline / none | `guard` (on) | not stated |
| `tool.approval` | before tools (permissions mode "Jev approves") | Does the task clearly need this command / outside-project change / outside action / sub-agent | choice | Only what Jev is sure of runs; else asks user in status bar | inline / none | `permissions` (on, mode `jev`) | not stated |
| `tool.constraint` | before a state-changing call | Does the call cross a stated hard constraint | bool per constraint | Confident violation stopped, explained in user's words | inline / none | `constraints` (on): maxConstraints 6 / 5000 ms | not stated |
| `tool.injection` | after tools, before model reads (`tool_result`, runs before admission); web_fetch, web_search, browse, mcp__* | Per ~900-char passage: instructions aimed at an AI? | bool | Passage with p > 0.5 withheld, replaced by one-line note; rule-hit passages judged in their own request; no Jev answer (outage/timeout/>96 passages) -> only plain injection phrases withheld; fail-safe | inline / none | `injection` (on) / 6000 ms | not stated |
| `files.locate` | in `locate` tool | Per candidate path: likely to contain the query | bool | Lexical prefilter 40 -> judge ranks -> 12 returned; no answer -> lexical order | inline / none | `locate` (on): candidates 40, results 12 | Retro: used, accuracy not quantified |
| `judge.items` | in `judge_items` tool (model-invoked) | Model's own yes/no question per item (up to ~16 per request, state billed once) | bool per item | Probability per item returned; answers in shadow too; `off` makes tool error | inline / none | `judgeItems` (on): maxItems 500 | README: 16 items in one request in 0.44 s |
| `browser.step` | in `browse` tool, every step | Next operation (click/type/select/scroll/wait/done/other) and target element | choice (op) + choice (target) | Code performs it; text typed generated by writer model; 3 no-change actions -> blocked; irreversible clicks need human; 40-step budget | inline / none | `browser` (on): maxSteps 40 | Retro (18 real browses): 2 done, 10 blocked, 2 errors; 42 verdicts p50 288 ms, p95 938 ms. Doc 04: Jev tens-of-ms-to-hundreds vs LLM ~4 s per judgment |
| `review.triage` | after /review reports | Per finding: changes behaviour? about this change? | 2 bool per finding | With reviewer severity orders P0-P3; none dropped; P3 collapsed; reviewer-insisted never P3 | inline / none | `packs` (on) | not stated |
| `diagnostics.delivery` | after edits (LSP) | Tell now / when model pauses / never | bool-based (+abstain) | Style warnings withheld; errors still present at turn end always told | inline / append-only | `lsp` (on) / 4000 ms | not stated |

### Turn
| id | Fires | Decides | Verdict kind | Effect | Latency/cache | Feature | Numbers |
|---|---|---|---|---|---|---|---|
| `turn.drift` | after tools, every N=6 calls (background) | Still serving goal: on-track / detour / drift / loop | choice | One-line steer; loops caught by rules (same call+result 3x) | background / append-only | `monitor` (on): every 6, repeats 3, window 8 | Retro: 252 verdicts: 195 on_track, 51 unknown, 3 loop, 3 drift; 6 correction candidates, unvalidated |
| `turn.rewind` | turn (when monitor sees circles/repeated failure) | Is the approach a dead end | bool (+progress bool) | Only confident dead end with no progress proposes going back to checkpoint; never rewinds by itself | inline / append-only | `checkpoint` (on; propose true, confirmSeconds 120) | not stated |
| `turn.completion` | turn end (`agent_end`) | Claims done? edited files and verified nothing? | bool x2 | One nudge to verify (max once per user turn) | inline / append-only | `completion` (on) / 3000 ms | not stated |
| `turn.continue` | turn end (after completion/LSP) | Promised-then-stopped, asked go-ahead for requested work; hard-to-undo/external step never pushed | 4 bool | Sent back to work, max 2 per message; yields in goal mode | inline / append-only | `continuation` (on): maxNudges 2 / 3000 ms | doc 04: split questions because combined question scored 0.79 vs 0.29 |
| `output.drift` | during model output, every few hundred chars (experiment) | Does output tail cross constraints/rules | bool | Confident violation cuts output, names rule, model resumes | parallel / append-only | `ttsr`: **off by default** | not stated |
| `goal.met` | turn end in /goal mode (fallback) | Is goal condition met / user needed | bool | Fallback when checker is not model or model gives no answer; open acceptance item or unverified edit = not yet | inline / append-only | `goal` (on; checker `model` default) | not stated |
| `board.read` | turn end / mid-run (after message, check, every ~5 tool calls, stop) (background) | Phase, current acceptance item, waiting on user; news vs routine | choice + bool mix | Only news makes a plain-speaking model rewrite the board | background / none | `board` (feature on, `defaultOn` false, everyTools 5, minIntervalMs 20000) | not stated |
| `notify.routing` | `turn_end` / event sources | Tell model now / next turn / never (first sources: context 70%, 85%) | choice | steer / nextTurn / drop; default next turn | background / append-only | `notify` (on): thresholds 70, 85 | not stated |

### Teamwork
| id | Fires | Decides | Verdict kind | Effect | Latency/cache | Feature | Numbers |
|---|---|---|---|---|---|---|---|
| `swarm.routing` | in `delegate` tool | Role per task; model tier and thinking by difficulty | choice + score | Picks sub-agent; unresolved -> default `worker`; pinned role fields win | inline / none | `swarm` (on) | not stated |
| `swarm.patch` | when isolated sub-agent returns patch | Within task scope? which files unrelated | bool (+ per-file bool) | One line advice; never blocks | inline / append-only | `swarm` (patchPreviewLines 30) | not stated |
| `hive.publish` | in bee process, `turn_end` (background) | Worth putting on board for others (new vs not routine; finding/dead end/decision/blocker/progress) | bool + choice | Published to append-only board (max 12/bee); failure = not published | background / none | `hive` (on) | Retro (6 real hives): 662 candidates, 89 pass (13.4%). README: 3 bees, 9 min, 117 candidates judged, 27 on board, 16 delivered |
| `hive.deliver` | bee `turn_end` (background) | Does a board note matter to this bee's focus | bool | Delivered as steer marked "finding, not instruction" (max 10/bee); `decision` notes delivered by rule | background / append-only | `hive` | Retro: 140 pairs, 64 pass (16 forced by rule, so not Jev), 63 actually injected; board-to-receipt median 27.2 s, p95 76.2 s |
| `hive.relate` | bee `turn_end` (background), per new note vs <=6 older notes sharing words | supersedes / contradicts / supports / none | choice | Superseded goes down and holders get CORRECTION; contradiction keeps both, CONFLICT; verify bee after 60 s; cross-bee supersedes needs p >= 0.9 (same-bee 0.6) | background / none | `hive` (verifyConflicts 1, verifyAfterSeconds 60) | Doc 04: calibrated on 11 real hives / 153 labelled pairs (2026-09-24) |

## 3. Loop diagram (README "A turn", verbatim structure)
```
 you --> input.preflight . task.frame . input.interjection
           |
           v
         model --> tool call --> tool.risk . tool.constraint . tool.approval --> runs
           ^
           |    tool.injection   web pages and MCP output: instructions aimed at the AI are withheld
           |    tool.admission   chunk by chunk: into the context, or archived behind a pointer
           |    context.forget . context.compact   when the context grows
           +-------------------------------------------------------------------+

 turn ends --> turn.completion . turn.continue . turn.drift . turn.rewind . memory.applied . board.read . cache.warming
```
README: "Every name is a decision point... the answer changes what the model does next, never whether it asks you. Rules are the floor: a dangerous-looking command is caught by rules first, and the judge only vouches that you asked for it."
Ordering notes from doc 04 (2026-09-21): tool.injection runs before tool.admission on `tool_result`; turn.drift runs on `tool_result` every 6 calls in background; turn.continue runs after turn.completion and the LSP wrap-up report; memory.recall and skills.disclosure at `before_agent_start`; cache.warming on idle.

## 4. Design rules (mu's wording)
Source docs/architecture.md "Principles every decision point follows":
- Small state, bounded question: judge reads summaries/metadata; answers yes/no, closed choice (always with an escape answer like `unclear`), or score.
- Safe fallback: without a verdict, mu does what it would do without a judge.
- Verdicts change what the model does, never whether it asks the user.
- Shadow first: a point earns `active` with numbers from real sessions.
docs/adding-a-decision-point.md criteria: asked often; small state (judge has 32K window); answer changes what mu does; doing nothing is safe. `defineDecision` requires id, version (bump on wording/policy change), questions, buildState, policy, fallback, `cacheImpact`, `latency`.

kyrn/docs/04 section 4, "six rules threaded through every injection point" (translated):
1. Rules first: whatever deterministic rules can decide is not asked of a model (loop detection, superseded reads, dangerous-command screening, first message cannot be a side branch).
2. Three zones plus escape: boolean counts only at <=0.2 / >=0.8; choice questions must include `other` (throws at definition time otherwise).
3. Fail-open: failure/timeout/abstain falls back to pi's native behavior; every handler wrapped (pi treats a thrown tool_call handler as a block). Safety gates are the exception: they fail closed to "ask the user".
4. Admission over forgetting, append over rewrite: each decision labelled with cache impact; prefix-mutating ones only at cache boundaries and sticky.
5. Errors must be cheap and reversible: dropped output has archive path, hidden skills retrievable, shortened results intact in session file.
6. Everything ledgered.
Extra from doc 04: capability profiles (classify/relate/rate/meta); a judge declares what it is bad at; questions it cannot answer skip to the next tier and, with no trusted tier, the answer is forced neutral. Config read only from the user's home mu.json, never project config.

## 5. Ledger
docs/architecture.md: every decision becomes a ledger record (`src/ledger.ts`): outcome, whether from judge or fallback and why, answers with probabilities, latency, usage; saved in the session file as `kyrn.decision` entries; read by `mu ledger [n]` (`--json` for all records), `/ledger`, `/status`, and the desktop judgments tab. `"recordState": true` also stores judged state (off by default; for distilling a judge). Doc 04: batch decisions merge into one record; record includes question version, judge, per-tier answered count, latency, warnings; ledger is the future training set.

## 6. Latency per question (stated numbers)
- README/judges.md: hosted Jev one warm question ~0.3 s over HTTP/2; 16 chunks in one request 0.44 s, state billed once.
- Test-log study: 282 live Jev requests, median 345 ms with default wording, ~$0.017 total at list price.
- Retro (2026-09-21): browser.step p50 288 ms / p95 938 ms; tool.admission batch p50 1,351 ms / p95 3,807 ms (batches overlap, not additive).
- Doc 04: preflight chat 804 ms, heavy 741 ms (Jev direct); Laya 85 ms; admission 14.8K chars in 14 chunks 749 ms (Laya, mis-classified some git-log blocks as "passing", which motivated shadow-first then).
- No per-decision-point latency table exists. The source-level `latency` field (inline/parallel/background) is the only per-point latency declaration. waitMs caps per feature (see section 2).

## 7. "No fast path bypass" stance
NOT FOUND in any doc I read (README, docs/*, kyrn/docs 01-04, 06, 08, 09, 11, features/, AGENTS.md, CONTRIBUTING.md). Closest documented behavior: rules run first and are the floor (README; doc 04 rule 1); some points are decided by plain code with no model call (exact-repeat folding, superseded-read tombstones, same-bee hive self-contradiction counts as update, decision-type notes delivered to all bees, chat greeting rule in preflight, board step lines, lexical locate fallback); tool.risk judge can only add a gate. No statement that all turns must pass through a judge.

## 8. Retrospective, 2026-09-21 (kyrn/docs/08-jev-retrospective.md, Chinese, written pre-rename; cutoff 2026-09-21T11:17:39Z; read-only, no new model calls)
Headline: Jev shows local positive effect, but records do not prove large or net-positive overall value; evaluate per decision point, not "all active verdicts = benefit".
- Sample: 32 history files + 30 sub-agent transcripts; 943 deduped ledger records (911 direct Jev), 3,665 decision items, 3,640,249 recorded Jev input tokens; recorded output tokens (81,632) incomplete (decideMany logs outputTokens as 0). Coverage ~2026-09-20..21, mostly dev tasks.
- tool.admission: no savings realized (0 drops in 2,412 blocks) yet ~54% of Jev input tokens; fix triggers/prefilter, do not loosen thresholds.
- skills.disclosure: clear direct exposure savings (511 hidden instances); correctness/missed-skill rate unlabeled.
- hive: publish 13.4% pass; deliver 64/140 (16 by rule); 63 injected; task-level gain unproven; lexical reuse is a clue only.
- browser: fast (p50 288 ms) but weak closure (2 done / 10 blocked / 2 errors of 14 Jev runs); "done" self-judged by same judge, no independent validator.
- context.forget: small gain (27,654 chars one projection); rule-based forgetting (156,744 chars) is not Jev's.
- preflight: 25 verdicts; 13 with shown effect (4 thinking changes: 2 down, 2 up; 9 hints). drift 252 verdicts; memory.capture 6/6 skip.
- Caveats listed: valid answer != correct answer; active != applied; fewer chars != less cost (cache loss, rereads, retries); filter rate != accuracy; no no-Jev control; judge vs main-model token prices differ so no direct ROI.
- Recommendations: keep/calibrate skills + hive publish/deliver; rules-first prefilter for admission; add independent goal verification for browser; link verdict -> action -> outcome for preflight/drift/memory; compare rules-only vs Jev shadow vs Jev active on a fixed task set. "No basis to claim any % cost or success-rate improvement."
- README also notes: replay numbers measured 2026-09-21; no end-to-end comparison vs pi/Claude Code/Codex yet.

## 9. Judges (docs/judges.md)
`jev` (hosted: TypeSafe, OpenRouter, Vercel AI Gateway, OpenCode Zen, Cloudflare; free Jev 1.13 on OpenCode Zen when no key), `laya` (322M local, reliable on simple predicates, weak on relations/meta; run in shadow first), `classifier:<provider>/<model>`, `llm:<provider>/<model>`, `clm`, custom types typesafe/http/llm/classifier/local/clm. `tiers` cascade (later judges see only questions earlier ones left uncertain); `routes` per point; `/mu judge`, `/mu route`, `/mu mode`; env `MU_JUDGE`. No judge in time -> point falls back, ledger records why.

## 10. Gaps / caveats
- Verdict-kind column is from `src/decisions/*.ts` greps (type declarations), not full source reads; mixed rows (e.g. diagnostics.delivery, board.read, capability.disclosure) may be imprecise.
- "Fires" for several points (capability.disclosure, task.frame, review.triage, goal.met, swarm.patch, turn.rewind, diagnostics.delivery, output.drift, board.read) is from README/manifest summaries; doc 04 predates them (not listed there).
- No documented per-point accuracy figures except the test-log study and hive.relate calibration; no per-point latency table.
- Doc 04 and doc 08 are pre-rename (kyrn) and say defaults were shadow; docs/reference now says active. Treat 04 as historical.
- "No fast path bypass" not found.
