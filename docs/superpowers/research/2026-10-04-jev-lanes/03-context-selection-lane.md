# Lane 3 — dynamic context / tool / skill selection per turn (Jev as System One)

Date: 2026-10-04. Read-only research; numbers from code constants, the live DB (`sqlite3 -readonly houge.sqlite`) and the built composer.

## 1. What enters the planner per turn, and when

Two channels exist under omp (ADR 0028 build decisions 4–6). **Session-level** = the system prompt file written at child spawn (`writeSystemPromptFile`, `src/omp/planner-supervisor.ts:611-613`); its sha256 is re-checked at every turn start and any change restarts the child (`:523`). **Per-turn** = the string handed to the `prompt` RPC (`:440-443`), built by `buildTurnPrompt` (`src/omp/turn-context.ts:286-300`): restart note, session seed, `[scheduled: …]` prefix, clarify-cap notice, one `[context]…[/context]` block of facts and wiki pages, then the message. That block persists in omp's transcript and is re-sent on every later turn of the session.

| Block | Channel | Live size (chars) | Source |
|---|---|---|---|
| temporal line | session | 33 | `composer.ts:313` |
| identity `memory/core/houge.md` | session | 2,434 | |
| `OMP_LOOP_DISCIPLINE` + guardrails | session | 2,674 + 198 | `composer.ts:220-262` |
| skills (1 ask + 2 research files, cap 4/scope) | session | ≈4,800 (files total 5,224) | `skill-store.ts:156-162`, `turn-context.ts:165-171` |
| core facts band (3 core rows, guard 600) | session | ≈200 | `episodic-retrieval.ts:170` |
| lessons: 13 active, 7 themes, cap 4,000 | session | ≈2,060 | `lesson-render.ts:14,71-100` |
| **system prompt total** | session | **≈12,400 (~3.5–4.5k tokens, CJK-heavy)** | |
| tool manifest: 15 declarations | session (served once at start, `planner-supervisor.ts:641-651`) | 11,686 JSON (~3k tokens) + omp read/edit/write | `src/omp/tools/*.json`, `tool-arming.ts:10-16` |
| facts ≤6 rows / 900 chars, pages ≤1,200 chars, cosine ≥ 0.42 | per turn | 0–900 / 0–1,200 | `episodic-retrieval.ts:27,48,57`, `wiki-retrieval.ts:30,39` |

Live planner input averages **28,665 tokens per attempt** (`llm_attempt`, anthropic/compose, n=162, last 45 d): the transcript dominates. System prompt + tools ≈ 6.5–7.5k tokens ≈ 25%; lessons ≈ 700 tokens ≈ **2.4%**; skills ≈ 1.5k ≈ 5%; tools ≈ 10%.

Live lessons: `ask` format 2 / honesty 1 / hygiene 2 / self 1 / sources 1 / time 1; `research` format 1 / sources 1 / tasks 2 / time 1. Facts: 36 active + 3 core (all embedded). Wiki: 7 active pages. The 7 `loop_started` rows with telemetry: 2 turns admitted 0 facts (best rejected 0.36–0.40), 3 admitted 1, 2 admitted 5; pages 0 in all 7. The gate already selects per turn.

**Attribution** is written at prompt-build time (`recordAttribution`, `turn-context.ts:238-256`) from the supervisor's spawn-time `applied` snapshot (`planner-supervisor.ts:166, 388-389`): every rendered lesson id is "applied", every turn.

## 2. Which selections deserve a Jev question

Jev's one request carries several questions (`JevRequest.questions: Record<…>`, `jev-client.ts:23-26`), ~290–350 ms (replay n=372 avg 287 ms; live shadow n=14 avg 352 ms), $0.042/M input, no text out.

**(b) `needs_memory` — reject.** The query embedding costs 26 ms (A1 benchmark; timeout 5 s, `embeddings.ts:13`) and Jev ≈ 300 ms: a Jev pre-check is 10× slower than the thing it would skip. The cosine gate with telemetry is already a calibrated System One for facts and pages; keep it.

**(a) Lesson themes — the right question, but not for tokens.** Theme split of the 2,060 chars: universal themes (format 287+28, hygiene 246, honesty 161+33 ≈ 760 chars) apply to every reply; conditional themes (time ≈ 220, sources ≈ 400, tasks ≈ 220, self ≈ 125 ≈ 965 chars) do not. A typical chat turn needs 1–2 of the four, so per-turn selection saves ~600–800 chars ≈ 250 tokens ≈ **<1% of planner input**. Token savings are negligible at 13 lessons. The value is (i) **credit precision** (§4: today a time rule is credited for a recipe question) and (ii) readiness for stage B, whose itemised one-rule lessons will multiply the count. Decomposition: `tasks` is known by code (`source === "schedule"`, `turn-context.ts:289`), no question needed; universal themes are code-owned always-on; **Jev decides three**: `time`, `sources`, `self`.

Draft criteria (literal, boundary-explicit; state = `latest_message`, `recent_turns`, `modality`, same egress the intent shadow has; **no lesson text leaves Houge**, the theme definitions are code constants in a public repo):

- `theme_time` (choice yes/no): *yes* when answering `latest_message` requires stating, converting or scheduling a date, clock time, deadline or time zone, or the message names one ("tomorrow", "明天", "9am", "下周"). *no* when time words are only incidental ("recently", "nowadays").
- `theme_sources` (yes/no): *yes* when the answer needs current or external information, a lookup, a comparison of claims, or the user asks where something came from. *no* for general knowledge, personal preferences, or reacting to Houge's last reply.
- `theme_self` (yes/no): *yes* when `latest_message` is about Houge itself: its behaviour, memory, code, runtime, restarts, what it can do or how it should change. "Houge", "猴哥", "you", "your" mean Houge. *no* when Houge merely performs a task.

**(c) Skills — the biggest block and the sharpest trigger.** Skills are ≈39% of the system prompt and two of three are recurring-report procedures (`periodic-news-newsletter`, `siem-soar-ueba-weekly-report`) that almost no Telegram turn needs; each already carries a one-line `when:` trigger (`skill-store.ts:160`). A `skill_applies_<name>` yes/no per active skill, criteria = the `when:` line verbatim, is exactly Jev's shape. Code alternative at zero cost: cosine of the message against the `when:` line using the embedding already computed for facts. Run both in shadow, keep the better. ADR 0028 decision 5 names a third route, omp-native `--skills` (progressive disclosure, SP4), which would move skills out of the prompt without any decider; worth verifying before building a Jev route.

**(d) Tools — defer.** The manifest is registered once per child and served at start (`planner-supervisor.ts:764-776`); per-turn omission needs omp support for toggling or deferring tools, unverified. Privilege is already code-owned (`tool-arming.ts`, `capability-map.ts:11-13`, Floor B), so Jev could only omit, never add; omitting `lesson_write` on a turn Paco corrects is a silent regression. The published gains (§3) come from 55–77k-token tool sets; at 15 tools ≈ 3k tokens the effect is small.

## 3. Cost/benefit, with the evidence

Shares of the ~28.7k-token planner input: tools ≈10%, skills ≈5%, lessons ≈2.4%, facts+wiki ≤3%. A 20% / 50% cut of the *selectable* blocks (skills + conditional lessons ≈ 5.8k chars) saves ≈400 / ≈1,000 tokens per turn: 1.4% / 3.5%. Transcript growth dominates; only the attention argument holds.

- Liu et al., *Lost in the Middle* (TACL 2023, arXiv 2307.03172): accuracy drops >20% when the relevant passage sits mid-context. Lessons already sit last-but-one (`composer.ts:338`), a good position; skills sit mid-prompt (`:331`), the worst one, and are the block least often relevant.
- Chroma, *Context Rot* (Hong, Troynikov, Huber, 2025): across 18 models one distractor lowers accuracy and several compound, even at short lengths. An irrelevant SIEM-report procedure is a distractor on every chat turn.
- Anthropic, *Advanced tool use* (Nov 2025): Tool Search cut tool context ~77k → ~8.7k tokens; selection accuracy 49% → 74% (Opus 4), 79.5% → 88.1% (Opus 4.5). Measured at 5–9× Houge's tool volume: a signal for SP4, not now.
- Gan & Sun, *RAG-MCP* (arXiv 2505.03275): relevant-only tools cut prompt tokens >50%, accuracy 13.6% → 43.1%, from a large pool. Same caveat.
- Anthropic, *Writing effective tools for agents* and *Effective context engineering* (Sep 2025): "too many or overlapping tools distract agents"; an "attention budget"; just-in-time retrieval over up-front loading. The frame for on-demand skills.
- Jaroslawicz et al., *IFScale* (arXiv 2507.11538): 68% at 500 simultaneous instructions, bias toward earlier ones. At 13 rules: weak evidence for trimming, strong for ordering and for acting before B grows the set.

## 4. Credit model follows the selection

Today: `applied_artifacts.lesson_ids` = all rendered (`turn-context.ts:238-256`); a rating credits the union over the window (`run-store.ts:2755-2778`, `gateway.ts:310-319`; +0.25 reuse at rating ≥2, `run-store.ts:2784-2796`); a low rating sends all applied lessons to an LLM culprit pass (`core-worker.ts:1026-1047`). Change: the attribution row gains `relevant_lesson_ids` (in-prompt ∩ (always-on ∪ Jev-yes ≥ τ)). `applyRatingToLessons` credits `relevant_lesson_ids` when present, else `lesson_ids` (Jev down → today's credit). `touchApplied` on the relevant set, `touchLessonsSeen` on the rest (A1's seen/credited split, `turn-context.ts:252-253`). The culprit pass gets the relevant set first (3–5 candidates, not 13). Stage C's cited ids supersede both. ADR 0005 line: "credit = in prompt **and** judged relevant, or in prompt when no judgment exists".

## 5. Labels and an offline replay that is not circular

Available: 455 user turns (365 Telegram); `loop_started.applied_artifacts` (372 rows; only the 14 since 10-02 hold the full lesson set, earlier rows carry the 1,200-cap bug); **11 session ratings, all 2–3, none ≤1**: no culprit flag exists, so ratings cannot calibrate anything yet.

Replay `houge jev-select replay`: per Telegram user turn, rebuild the Jev state as the intent replay does (`src/jev/replay.ts`), ask the theme and skill questions, write JSONL with ids and probabilities only. **Labels from the flight recorder, not from any model**: `time` ↔ the reply holds a date/clock/zone pattern or the run called `to_local_time`; `sources` ↔ the run called `web_search`/`http_fetch` or the reply carries URLs; `self` ↔ the run called `self_diagnose`/`self_write_propose`/`houge_status`/`lesson_write` or the reply names Houge/猴哥 in first person; skills ↔ the run was a schedule fire of that program. Metrics per theme at τ ∈ {0.6, 0.7, 0.8}: recall of the behavioural label (a miss = a rule Jev would have hidden on a turn that needed it), precision, coverage. Bar to arm per theme: **false-omission ≤ 5% with coverage ≥ 60%**; a failing theme stays always-on.

## 6. Failure modes, ledger rows, incidents

- Jev hides a rule Paco cares about: universal themes never go to Jev; a conditional theme below τ is **included** (inclusion is the safe direction); Jev down / no key / fused / timeout → everything in, as today. Ledger `context_select {status, themes_in, themes_out, conf_<theme>, skills_in, fallback}` per turn, ids and numbers only.
- Regression detector that does not wait for a rating: a `lesson_write` whose reconciled theme was omitted in the previous turn's `context_select` → ledger `context_select_miss {theme, lesson_ids}`; ≥2 in 7 days opens incident `context_select_missing_theme`. Jev failures ride `llm_leg_failing` (provider `jev`, role `context_select`).
- Transcript bloat if rules move to the per-turn channel (each injection persists in the session transcript), and user-channel rules weigh less than system-channel ones. Mitigation: keep lessons session-level in v1; if injected later, fence the block like `[context]` and inject only the delta.

## Proposed sequence

1. **Shadow first (one Jev call per turn, parallel to the embed, never awaited):** three theme questions + per-skill questions, `context_select` row, replay tool, §5 metrics. No prompt change. Credit precision (§4) switches on from the shadow row alone, behind `HOUGE_CONTEXT_SELECT_CREDIT`.
2. **Skills out of the system prompt** once the shadow passes the bar (or omp-native skills verified): the system prompt shrinks ≈39%.
3. Conditional lesson themes per turn only when B grows the set past the cap or the shadow shows a quality effect.
4. Tools: after an omp probe for per-turn tool toggling; not before.

## Open questions for Paco

1. Lessons stay session-level in v1 (Jev drives credit only) — agreed, or do you want per-turn rule injection now despite the transcript cost?
2. Skills: Jev question vs cosine on `when:` vs omp-native `--skills` — build the first two in shadow and compare, or verify native omp skills first?
3. Is a per-turn `context_select` Jev call (message + thread, the egress already approved for intent) acceptable for every Telegram turn, or only when a conditional theme or skill exists?
4. The universal set: format, hygiene, honesty always-on — add `self`?
