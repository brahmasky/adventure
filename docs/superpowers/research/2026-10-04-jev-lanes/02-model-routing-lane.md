# Lane 02 — Jev as the planner's model router

Date 2026-10-04. Read-only over `main@6f52dea`, the live `houge.sqlite`, and the installed omp 18.4.4 source (`~/.bun/install/global/node_modules/@oh-my-pi/`). Numbers are from the DB unless marked.

## 1. How a planner is bound to a model today

- One omp RPC child per chat, spawned with `--model provider/model [--thinking effort]` (`src/omp/planner-session.ts:13-17`); `open_session` resumes the newest transcript (`:70`). A resumed session restores *its* last model over `--model` (ADR 0028 l.263), so `promptTop` re-pins with `set_model` + `set_thinking_level` before the first prompt (`planner-supervisor.ts:434-437, 456-466`; `planner-session.ts:81-84`).
- **Mid-session switching already exists and runs live**: `retryNextLeg` sends `set_model` on the running session and continues with `RETRY_NOTE` (`planner-supervisor.ts:483-510`). omp's handler only swaps the session model (`modes/rpc/rpc-mode.ts:1433-1451`); transcript, tool state and bridge stay; `set_thinking_level` is a setter (`:1472-1474`). Per-turn routing is two RPC frames, no respawn.
- **Switch cost = provider prompt cache.** Every request ships the whole transcript. Live rows: a turn's first request writes ~45-60K `input_tokens` and reads only ~9K cached (omp's system prompt); later requests in the same turn read 47-55K (`llm_attempt` run `29fa54dc…:1-3`). At ~1.7 Telegram turns/day the Anthropic 5-minute cache is cold at nearly every turn start, so a switch *between* turns costs nothing extra; a switch *inside* a multi-request turn costs one ~50K re-write. Kimi receives the full transcript uncached: "cheap" means it lands on Kimi's bucket, not Anthropic's.
- **Alternatives.** (a) Two sessions per chat: omp has no shared transcript; rejected. (b) One-shot for trivial turns (`registry.ts:187`): loses the thread "好" / "melbourne呢？" depend on (§2); rejected. (c) Thinking level only: live output is 100-900 tokens/turn, so `:low` saves ~0 quota; a latency win only. (d) **omp has this natively**: `--thinking auto` runs a per-prompt difficulty classifier (`src/auto-thinking/classifier.ts`: `trivial|moderate|hard` → `low|high|xhigh`) through the `judge` role, whose default chain starts `typesafe/jev-latest` (`src/priority.json:99-104`; `judgment/index.ts:174-209`, "native System One"). It routes thinking level only, its criteria are coding-shaped, and it would put `TYPESAFE_API_KEY` in the sandboxed child's env (ADR 0015 keeps it in the broker). Prior art, not the recommendation.

## 2. Quota facts (live DB)

- **Volume.** 171 user turns in 60 days: Aug 43, Sep 65, Oct 1-3 63 (49 on 10-01 = live gate). Telegram ≈ 1.7/day; 67 schedule fires. Median message 60 chars; ≤30 chars 55/171 (32%); >200 chars 6.
- **omp era (since 10-01, role `compose`, Telegram, Opus 5.5): 54 runs**, 2.6 model requests/run, 1.9 tool steps/run, mean 77K uncached + 187K cached input, 899 output, 16.2 s/turn. Three-day Anthropic planner total: 4.6M uncached + 11.6M cached input, 67K output. Schedule runs: 4.4 requests, 11.6 steps, 90K/341K, 48 s.
- **Trivial proxy = zero tool steps**: 15/54 Telegram runs (28%) = 16% of uncached input (668K of 4.16M), 1.5% of cached. Over 60 days: 29/104 Telegram turns (28%).
- **Length is a bad proxy.** Of 54 short turns (≤30 chars, 60 d) only 21 used no tool. `好` (1 char) was a go-ahead to a repo fix: 2 requests, 189K uncached, 15 s; `点头`, `搞定了？`, `好，修复一下` likewise. Cost is decided by the *task the turn commits to*, carried by the previous assistant turn.
- Errors since 10-01: 161 ok, 1 `other`, 1 `model_missing` (gate probe). No `quota` row yet.
- `session_ratings`: 11 rows, last 2026-09-25, mean 2.7. Not a label source.

## 3. The Jev question and routing table

Houge's client has `JevChoiceQuestion {type, instructions, criteria}` only (`src/jev/jev-client.ts:18-22`), no `score`; start with one `choice`. Intent-replay evidence: 91.7% agreement at confidence ≥ 0.7, 57% coverage on Paco's messages, 11% of `research` calls overruled (spec §Replay result). Expect the same shape: good precision above 0.7, ~40% of turns below it.

**State** (same egress envelope as the approved intent shadow: ≤ 8K-char message, ≤ 24K request): `latest_message`, `recent_turns` (last 3-5, role + 300 chars), `last_houge_turn_used_tools` (from the previous run's `loop_step`, code-owned), `last_houge_turn_asked_or_proposed` (previous assistant text ends in `?`/`？`/`吗`/"要不要"/"approve", code regex), `modality`.

**Question `complexity` (choice).** Instructions: "Judge how much thinking and tool work Houge needs to answer `latest_message` well. If `latest_message` is a short reply (agreement, 好, ok, go ahead, 继续, a number, a choice) to a question or proposal in the last Houge turn, judge the task that reply commits Houge to, not the reply itself. Volume of text never raises the level. If torn, pick the higher one." Criteria:
- `trivial`: "Houge can answer from the conversation or general knowledge in one short reply with no file, shell, memory or web tool: greetings, thanks, acknowledgements that commit to nothing, a fact everyone knows, a one-line rewrite, a short poem, a time conversion."
- `routine`: "One clear task with an obvious method: look something up, read or summarise, run a known command, save or retire a memory, a weather or reminder request, a factual question that needs a search."
- `hard`: "Several steps or open choices: diagnose or fix code, change Houge's behaviour or lessons, multi-part research, a plan or comparison with trade-offs, anything about money, security or deleting data, or `latest_message` approves or continues such a task."

**Routing table** (code; two env-tunable thresholds):

| Jev answer | confidence | planner string |
|---|---|---|
| trivial | ≥ 0.80 | `kimi-code/k3:low` (or `anthropic/claude-opus-5-5:low` while Kimi is unproven) |
| routine | ≥ 0.70 | `anthropic/claude-opus-5-5:medium` (today's default) |
| hard | ≥ 0.70 | `anthropic/claude-opus-5-5:high` |
| else, or Jev error/timeout/fused | — | default chain unchanged |

Only the *first* string changes; the failure chain behind it stays `omp-config.ts:18`. One function `routeTurn(answer): ModelString | undefined`, called in `startTurn` between `resolveText` and `promptTop` (`planner-supervisor.ts:385-400`); `promptTop` pins `routed ?? cfg.planner[sessionLeg]` (`:435`). The `set_model` path, `modelUnknown` bookkeeping and `noteActualModel` audit (`:862-866`) carry it unchanged. Add `routed_by` and the Jev label to the n=0 `llm_attempt` payload as the §5 join key.

**Wrong-trivial risk, mitigations** (code, few branches): (1) self-escalation: a `trivial` turn that emits any tool call (`turn.usedTool`, already tracked) is re-pinned to the default string before its next model request — the same frame `retryNextLeg` sends; cost one ~50K write. (2) Paco's override: `think harder` / `认真想` / `ultrathink` routes `hard` by regex before Jev (omp honours a standalone `ultrathink`, `modes/magic-keywords.ts:70`). (3) Every turn is re-judged; a wrong label lasts one reply. (4) Kimi's verbosity (525 tokens for "OK", ADR 0028 l.259) is already bounded by `:low`.

## 4. Invariants and the quota signal

- "Claude only as a subscription model through omp" holds: every routed string is an omp subscription leg; Jev is already a metered provider under ADR 0019 (`metered-pricing.ts:23`, $0.042/M input; one call ≈ 3.6K tokens ≈ $0.00015). Routing is a decision, not a seat; thresholds and table are code (ADR 0013).
- **A quota signal exists and omp already fetches it.** pi-ai reads Anthropic's OAuth usage endpoint (`five_hour`, `seven_day`, `limits[] kind: weekly_scoped` with `utilization`, `resets_at`; `pi-ai/src/usage/claude.ts:60-130`), caches it 5 min in the profile's `agent.db` (`sqlite-credential-store.ts:43`) and exposes it as `omp --profile houge usage --json --provider anthropic` (probed `--help` only; the DB path is secret under ADR 0015, so read via CLI, never the file). v1 does not read it per turn. v2: a daily tick stores `anthropic_7d_utilization`; at ≥ 0.8 the `routine` row flips to Kimi. That is the SP3 "flat-rate quota invariant" (ROADMAP l.192) with its first consumer; this lane only reserves the field.

## 5. Labels and offline replay

No ground truth. Code-owned proxy per historical run: `hard` if ≥ 3 `loop_step` rows, or any `self_write_*`/`lesson_write`/`memory_correct_write` capability, or output > 1,500 tokens; `trivial` if 0 steps, output < 400 and 1 request; else `routine`. Replay = `houge jev-route replay --since 2026-08-01` over `chat_turns`, thread rebuilt as in the intent replay (`getChatTurnsBefore`, anchor = run start). Report: agreement and coverage at 0.6/0.7/0.8/0.9, the confusion matrix, and the two costly cells — proxy `hard` judged `trivial` at ≥ 0.8 (the only one that hurts) and `trivial` judged `hard` (wasted quota). Bar before arming: hard→trivial ≤ 3% of confident calls, coverage ≥ 50%. Cost: 171 turns ≈ $0.03. After arming, each routed turn logs label + observed proxy, so the same report runs weekly on live data. Ratings are reported, never used.

## 6. External research (applied)

- **RouteLLM** (arxiv 2406.18665; lm-sys/RouteLLM): the threshold is calibrated to a target strong-share on your own queries (`calibrate_threshold --strong-model-pct`), never learned; `mf` recovers 50% of the quality gap at 13% strong calls, 80% at 31% (MT-Bench); out-of-distribution routers "perform poorly" (MMLU). Applied: calibrate the `trivial` cut to ~30% cheap share on the §5 replay; re-calibrate when the turn mix drifts (the omp cutover already did).
- **FrugalGPT** (arxiv 2305.05176): cheap answer + scorer + escalate; 59-98% cost cuts at equal accuracy, at the price of a second visible latency. Applied: pre-route Telegram turns; §3's tool-call escalation is the cascade without a scorer.
- **Hybrid LLM** (2404.14618) / **Shnitzer** (2309.15789): up to 40% fewer strong calls in-distribution, but per-query correctness prediction ≈ 0.59 under shift. Applied: the low-confidence fallthrough is the primary safety; expect ~40% fallthrough (the intent replay's 57% coverage).
- **Anthropic docs** (choosing-a-model, effort, prompt-caching): "tuning effort is often a better lever than switching models"; caches are model-specific and a top-level effort change invalidates the messages cache; 5-min TTL, write 1.25x, read 0.1x. Applied: cold cache between turns makes this free *between* turns; a mid-turn `set_model`/`set_thinking_level` (§3 escalation) pays one write, as `retryNextLeg` does today. Opus `:low/:medium/:high` is the sanctioned shape; Kimi-for-trivial is the only shape that moves load off the Opus weekly cap.
- **Not Diamond / OpenRouter auto**: no public accuracy or failure rates; auto ranks by community spend share, not correctness. Applied: confirms classifier → table over a learned router.
- **Claude Max** (AnthropicAI 2025-07-28; code.claude.com legal page): weekly caps since Aug 2025 with a separate Opus weekly cap; the legal page bars third-party routing through Max credentials. The router protects the Opus weekly cap, not dollars; the D7 terms risk stays as accepted in ADR 0028.

## 7. Failure modes

- **Jev down/slow/fused**: 5 s timeout as the shadow (`shadow.ts:15`); no answer → default chain, one ledger row; 429/auth pages Paco (todo.md l.51).
- **Oscillation**: none by construction — per-turn, stateless; a flip costs a cache write that is cold anyway (§1).
- **Wrong model after a crash**: already handled — `open_session` restores the last model and `promptTop` re-pins every turn (`:435-437`); `noteActualModel` catches a pin that did not take.
- **Latency**: Jev adds ~0.3 s; mid-turn escalation adds one ~50K write (5-9 s TTFT observed). Kimi's TTFT (29.5 s on the one `pi/kimi` row) is the real risk — measure before promoting Kimi over Opus `:low`.
- **Family collapse**: a Kimi planner with a Kimi reader leg is D10 `family_collapse` (`configuration.md`, reader row). Safe only while `gemini-3.8-flash` stays reader[0]; code refuses the route when `familyOf(route) === familyOf(reader[0])`.

## Open questions for Paco

1. First month: trivial → Kimi (bucket relief, latency and D10 risk) or Opus `:low` (no quota saving, pure latency win)?
2. Is `hard` → `:high` worth it? Hard turns already spend 4-6 requests; `:high` adds thinking tokens to the bucket we protect.
3. Accept Jev egress for routing: message + 3-5 recent turns + two booleans (the approved intent-shadow envelope)?
4. Weekly-utilization flip (§4 v2): part of this spec, or SP3?
