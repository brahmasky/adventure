# Jev pre-planner triage — memory lane (research + design)

Date 2026-10-04. Read-only investigation of `main@6f52dea` plus a scratch copy of `houge.sqlite`. Direction fixed by Paco: Jev is System One, code owns gates/thresholds, omp composes, `none`/low confidence falls through to the planner, Jev never gates security-bearing actions.

## 1. The inbound path and the slot

```
Telegram update → gateway.intake (code-owned pre-triage already: slash commands, bare rating digit)
  → worker.submitTurn → dispatchTurn → PlannerSupervisor.submit (steer if RUNNING, else queue)
  → startTurn: resolveText (voice/photo ingest) → ensureReady (spawn child) → recordChatTurn(user)
  → buildTurnPrompt ([context] facts/pages, clarify cap, restart note, seed) → promptTop → omp planner
```

- Hand-off: `src/telegram/telegram-daemon.ts:245-262`; `src/core/core-worker.ts:1972-1983` (`submitTurn`), `:2010-2022` (`dispatchTurn`); `src/omp/planner-supervisor.ts:218-227` (`submit`: steer vs queue), `:381-395` (`startTurn`).
- Precedent: `src/gateway/gateway.ts:268-345` consumes a bare digit as a rating only while a pending ask is active, forwards digit+comment as the turn, deactivates on any other message, idempotent via `beginTriggerProcessing`. The lane copies this shape: consume only when certain, never hijack a real message.
- **Slot:** inside `startTurn`, after `resolveText`, before `ensureReady`. Text is final (a voice "好" is transcribed), the run is claimed and leased, no child has been prompted. Wire it like `resolveMessage` (`planner-supervisor.ts:60`): `SupervisorDeps.triage?: (claim, text) => Promise<TriageVerdict>`. Run `ensureReady` concurrently with Jev so a `none` verdict costs no wall time.
- A **steered** message (mid-turn) never reaches `startTurn`, so it is never triaged — correct, it belongs to the live turn. Schedule-born runs skip triage; `lesson_write` already refuses them (`src/capabilities/lesson-write.ts:77-80`).
- Finishing without the planner: `TurnOutcomeSink.complete` (`planner-supervisor.ts:39-41`) → `ompComplete` (`finishRun` + `enqueueFinalReportNotification`) works unchanged with `tool_calls: 0`; the reply is the code-owned card.

**Cheap state at the slot** (all SQLite, no LLM): `getRecentChatTurns(chat, N, since)` (`src/run/run-store.ts:1111`); the last assistant row's `intent` (`clarify | loop`, set by `assistantIntentFor`, `src/omp/turn-context.ts:296-301`); pending `tool_approvals` (schema `run-store.ts:6818`); recent `memory_changes` for the chat (`run-store.ts:6559`); `getPendingRating(chat)`; the previous run's `loop_step.capability` set (did Houge just run `lesson_write`, `memory_correct`, `schedule_task`); the supervisor state (`IDLE | RUNNING | AWAITING_APPROVAL`, `planner-supervisor.ts:30`).

## 2. Can a one-shot use bridge tools? No — and it does not need to

`spawnOneShot` spawns `omp -p --mode json --no-session --no-tools --no-extensions` (`src/llm/providers/omp.ts:25-30, 104-141`). Bridge tools exist only for the planner child through the single extension and per-child socket (ADR 0028 "Shape"). A tool-bearing memory session would mean a second supervised RPC child per chat, a filtered manifest, a Seatbelt profile and a bridge server: the supervisor is ~1000 lines built around one planner per chat. Reject.

The decisive finding: **`lesson_write` is already code plus two ticks-seat one-shots.** The planner contributes only `scope` (`src/omp/tools/lesson_write.json`); the adapter anchors feedback to the real message and prior answer, scans for code-owned phrases, distills on role `distill`, reconciles on `consolidate`, both on `HOUGE_OMP_TICKS` (`core-worker.ts:2524-2561`, `LESSON_WRITE_ROLES` `:3372`, ADR 0028 build decision 12). The distill verdict itself decides "durable or not" (`lesson-write.ts:120-128`).

**Recommendation (smallest viable memory agent): no new agent.** The lane calls `createLessonWriteAdapter` with `feedback = message`, `priorAnswer = last assistant turn`, `scope` from Jev (or the code default), then `reconcileAndSaveLesson` (`core-worker.ts:983-1004`) — the identical pipeline the planner would have triggered. Wiring cost: triage dep + Jev question builder + lane executor + card + ledger event ≈ 300-400 lines and tests; no new process type, no new seat. Fact writes ("记住我…") and `memory_correct` ("忘掉那个") are phase 2: facts need the distill window's reconcile overlay; corrections need candidate ids from `searchActiveMemory` then a pick (Jev `choice` over ≤5 candidates is plausible) and keep the Approve card (`memory_correct_write` is `destructive`, `src/core/omp-turn-wiring.ts:31`).

## 3. The ack problem

Data: 19 of 365 Telegram user turns are ≤ 4 chars (好, 要, 是的, 对的, 👍, 点头, 清一下, 再查一次). Two cases:

1. **Approval pending** (`tool_approvals.state = 'pending'` for this chat, or supervisor `AWAITING_APPROVAL`): a bare ack is security-bearing. Jev is not asked. Code-owned reply: a nudge card ("Tap Approve or send `/approve <id>`"), as the gateway already does for refused approvals (`gateway.ts:980`). Never approves.
2. **Otherwise**: the ack goes to Jev with context; the criteria name acks as `none` explicitly (Jev reads literally), so it falls through to the planner — today's path. No new lane for acks in phase 1.

State fields added for context (metadata only, no new text egress): `last_houge_turn: { kind: "clarify" | "answer" | "lesson_saved" | "memory_card" | "approval_card", age_s }`, `pending: { approval: bool, memory_change_id?: string, rating_ask: bool }`, `last_turn_tools: string[]`. `recent_turns` stays as `buildJevIntentRequest` builds it (`src/jev/intent-question.ts:62-82`, same 8k/24k bounds).

## 4. Other lanes on the same triage call

Labels in the DB copy: 455 user turns (365 Telegram); `loop_step.capability`: `web_search` 1027, `lesson_write` 44 (13 runs in 60 d of 104 Telegram turns), `memory_correct` 17 + `_write` 6, `schedule_task` 12, `houge_status` 2; `memory_changes` 7; `session_ratings` 11; historic `chat_turns.intent`: research 156, answer 88, feedback 57, clarify 36.

| Lane | Today | Jev question | Lane does | Misroute risk | Labels |
|---|---|---|---|---|---|
| **memory** (this spec) | planner may call `lesson_write` | `lane`, `complete`, `scope` | adapter + reconcile, card | swallows a question (`pure` false positive) | `lesson_write` steps per run (live comparator, exists post-cutover) |
| forget / correct | planner → `memory_correct` search → gated write | `lane: memory_correct` | code search, pick ids, Approve card unchanged | wrong id → Undo exists | `memory_correct*` steps, `memory_changes` |
| status ("重启了吗") | planner → `houge_status` | `lane: status` | code-rendered text, zero LLM | none (read-only own state) | `houge_status` steps (2) |
| schedule/reminder | planner → `schedule_task` | hint only | route-and-inform prefix | durable side effect, provenance rules → keep planner | `schedule_task` 12 |
| quick factual Q | planner answers | `needs_live_info` | cheap seat answer | the replay's costly direction: Jev said `answer` on 11 % of research turns at ≥ 0.7 → defer | `intent=answer` 88, tool-less `loop` turns |
| chit-chat / ack | planner | `none` | nothing | — | — |
| rating digit | gateway code | — | already code-owned | — | `session_ratings` |

Phase order: memory → status → memory_correct; schedule and factual stay route-and-inform or unrouted.

## 5. Reply rendering

Everything leaves through the outbox → `TelegramNotificationAdapter` → `markdownToTelegramHtml` with `parse_mode: HTML`, plain-text retry on a 400, inline keyboard from `payload.buttons` (`src/notifications/telegram-notification-adapter.ts:113-150`, `src/telegram/markdown-to-telegram-html.ts:25`). Helpers: `lessonBullet` (`src/run/lesson-render.ts:50`), `escapeForTelegram` (`src/capabilities/text-hygiene.ts:26`), `clipText` (`src/status/houge-status.ts:146`), `inertCode` and the `🧠` card style (`src/capabilities/memory-correct.ts:145-167`), `NotificationButton` (`src/notifications/notification-types.ts:8`).

Saved card (code-owned, `intent_type: final_report`):
```
📒 Saved lesson #51 · hygiene (updated #44)
`Never end a reply with a sign-off or form of address.`
AVOID: `祝好 / Best regards`
[↩️ Undo]  [↪ Ask Houge anyway]
```
Undo = status flip of #51 and reactivation of the superseded row (lessons are never deleted; `/forget <id>` exists). "Ask Houge anyway" re-submits the same text as a planner turn with triage off (idempotency key suffixed) and is the override label for calibration.

Fallback: when the lane finds nothing durable (`saved:false`) or the verdict is `none`, **no card** — the planner answers as today. For `mixed`, the planner prompt gets a code-owned line, like `CLARIFY_CAP_NOTICE` (`turn-context.ts:51`): `[memory] Lesson #51 (hygiene) was just saved from this message; do not save it again.` and `ranOnce` is pre-seeded so a second `lesson_write` returns the existing "already took this action" digest.

## 6. External research, applied

- Anthropic, *Building effective agents*: routing "classifies an input and directs it to a specialized followup task", including "a more traditional classification model". Jev is that model; the specialised prompt is the existing distill discipline, not a new agent. ([anthropic.com](https://www.anthropic.com/engineering/building-effective-agents))
- Rasa `FallbackClassifier` + `TwoStageFallbackPolicy`: `nlu_threshold` **and** `ambiguity_threshold` (top-2 gap), plus a confirm-or-rephrase loop. Adopt the gap rule (`p(memory) − p(none) ≥ 0.5`). Reject the confirm loop: at ~3 messages/day a "did you mean" costs more than a planner turn; `mixed` → route-and-inform is Houge's equivalent. ([rasa.com](https://rasa.com/docs/rasa/reference/rasa/core/policies/two_stage_fallback/))
- Aurelio Semantic Router: rules (µs) → fast router (ms) → LLM fallback. Houge has the rule layer (gateway); Jev is the 0.3 s layer; the planner is the fallback. Their 0.50 is a cosine score, not transferable. ([aurelio.ai](https://docs.aurelio.ai/semantic-router/get-started/introduction))
- Front-door routing benchmark and CARGO: self-reported confidence can be uninformative; trained probes outperform; a second stage fires only on a small top-2 gap. Houge's evidence that Jev's confidence is informative is the replay's monotone curve (87.8/91.7/93.6 % at 0.6/0.7/0.8); keep the per-threshold report. ([arxiv 2604.02367](https://arxiv.org/pdf/2604.02367), [arxiv 2509.14899](https://arxiv.org/html/2509.14899v1))
- Mem0 vs Letta: passive extraction (an LLM call per write) vs agent-called memory tools. Houge runs both (distill tick; planner `lesson_write`). The lane is a third shape — user-explicit, code-triggered — and inherits the per-write cost: 7-13 s per k3 call (ADR 0028 residuals), so lane latency is the distill, not Jev. ([vectorize.io](https://vectorize.io/articles/mem0-vs-letta))
- Multi-intent (ML6): decompose and prioritise. Do not decompose; one `complete` question plus the planner finishing the remainder is enough for one user. ([ml6.eu](https://www.ml6.eu/en/blog/handling-multiple-intent-conversations-in-customer-support-chatbots))

## 7. Failure modes, ledger, incidents

| Case | Handling |
|---|---|
| Jev 401/403 | `jev-client` returns `auth` (`src/jev/jev-client.ts:110-111`) → alerted incident `jev_auth` at once (`src/run/incident-alert.ts:28`; the sweep's one-auth-failure rule backs it). Verdict `none`. |
| 429 / 5xx / network | `retries: 0`, timeout 1500 ms. First 429 opens `jev_rate_limited` (transition alert) — the "must reach Paco" rule; today's silent-retry path is not used. Verdict `none`. |
| Mis-route swallowing a question | `pure` needs `p(pure) ≥ 0.8`, else `mixed`; every card carries "Ask Houge anyway"; the override tap is the error label. Auto-disable after 3 overrides in 7 days (`triage_overrides`). |
| Double save | `[memory] saved …` prefix + pre-seeded `ranOnce` (§5). |
| Transcript gap (D4) | A skipped turn never enters the planner's session. The next turn's prompt carries `[memory] Since your last turn Paco said "<clip>" and lesson #51 was saved.`, claimed at dispatch like the restart note (`turn-context.ts:89-95`). |
| Latency | Jev ≈ 0.3 s concurrent with child start: zero added on fall-through. Lane: distill + reconcile on k3 ≈ 15-25 s vs planner p50 12.1 s (14 d). The win is an Opus turn saved and a deterministic card, **not** speed. |
| Disarm | `HOUGE_JEV_TRIAGE_ENABLED` (default off), in `DISARM_FLAGS`, read per turn; egress bounds as `intent-question.ts:12-13`. |

New ledger event `triage` (required `status, lane, complete, confidence, lang`; probabilities; never text) on every Telegram turn start, so coverage has a denominator. Incident kinds: `jev_auth`, `jev_rate_limited`, `triage_overrides`.

## Proposed design

**Components.** `src/jev/triage-question.ts` (pure: state + three `choice` questions, bounds); `src/jev/triage.ts` (client call, verdict, thresholds, ledger row); `src/core/memory-lane.ts` (adapter + reconcile + card + `complete` through the sink); supervisor dep `triage`; `houge jev-triage replay` reusing `src/jev/replay.ts` with the label **"did this run's loop call `lesson_write`"** (available since 2026-07-02 — the comparator the shadow lost now exists again).

**Data flow.** `startTurn` → (approval pending? code nudge) → Jev ‖ `ensureReady` → verdict → `memory+pure` ≥ bar: lane, card, `complete`, child stays idle · `memory+mixed`: lane, then prompt with saved note · else prompt as today.

**Questions (criteria drafts, literal wording).**
- `lane` — `memory`: "`latest_message` tells Houge how to behave from now on, states something about Paco to remember, or corrects something Houge believes. Signals: 以后/从现在起/记住/不要再/别再/always/never/from now on/remember/prefer, or a correction of Houge's previous reply in `recent_turns` that applies to future replies too." `none`: "Everything else: a question, a task, a lookup, small talk, a bare acknowledgement such as 好/嗯/ok/👍/是的 even right after Houge saved or proposed something, an answer to Houge's question, or a message about Houge's code or schedules."
- `complete` — `pure`: "`latest_message` contains ONLY the preference, fact or correction; nothing asks a question, requests work, or expects more than a confirmation." `mixed`: "It also asks something, requests work, or continues a task."
- `scope` — `ask`: "about how Houge replies in conversation." `research`: "about how Houge searches, which sources it trusts, or how it cites."

**Thresholds (start values, shadow-verified).** route-and-skip: `confidence ≥ 0.7 ∧ p(memory) ≥ 0.85 ∧ p(memory) − p(none) ≥ 0.5 ∧ p(pure) ≥ 0.8`; write-then-inform: same without the `pure` bar; else fall through. Theme is not asked of Jev — `reconcileLesson` already names it.

**Rollout.** (1) replay over 455 user turns vs the `lesson_write` label; stop below the agreed bar. (2) live shadow: `triage` rows only, compared with the planner's actual `lesson_write` calls. (3) arm the lane.

## Open questions for Paco

1. Skip or inform for `pure`? Skip saves the Opus turn but opens the transcript gap (mitigated by the catch-up line).
2. Is a 15-25 s card acceptable (k3 distill ×2), or should the lane ride a faster ticks leg?
3. Undo semantics for a saved lesson: retire the new row and reactivate the superseded one?
4. Bare ack with an approval pending: code nudge (proposed) or planner?
5. `scope` from Jev (proposed) or a code default from the last turn's tools?
6. Fact writes and `memory_correct` in phase 1 or 2 (proposed 2)?
7. Replay bar for GO: 85 % agreement at ≥ 0.7 on the `lesson_write` label, ≥ 50 % coverage?
8. Should `lane: status` ship in the same slice (zero-LLM, read-only)?
