# Houge Domain Context

This file defines domain language for Houge architecture reviews and implementation plans.

## Core Terms

**Houge**: The Telegram-first Multi-Agent Harness and autonomous worker orchestrator.

**Harness**: The deterministic runtime that owns global control: lifecycle, routing, policy, budgets, approvals, logs, memory updates, and final decisions.

**Trigger**: An external activation source that requests work. Initial triggers are Telegram, schedule, and CLI.

**Trigger Adapter**: The source-specific inbound adapter that converts raw Telegram updates, fired schedules, or CLI arguments into typed task events.

**Typed Task Event**: The normalized event produced by a trigger. It includes command type, requester, program, goal, notification target, idempotency key, and raw source reference.

**Gateway**: The deterministic control plane that receives typed task events, verifies authorization, creates or resumes runs, and sends user-facing status.

**Run**: One bounded execution of a task. A run owns lifecycle state, task contract, budget ledger, approvals, execution ledger, receipt paths, and terminal status.

**Task Contract**: The bounded work order for a run: objective, budget, allowed actions, forbidden actions, output contract, approval gates, and stop condition.

**Task Contract Module**: The module that compiles, validates, hashes, and exposes deterministic enforcement rules for task contracts.

**Run Ledger**: The append-only execution event record for a run. It is the source for audit, reports, budget accounting, trajectory eval, and telemetry export.

**Run Ledger Event**: A structured event with event ID, run ID when available, correlation ID, event type, timestamp, actor, sequence number, and typed payload.

**Idempotency Conflict**: A rejected trigger event where `source + idempotency_key` already exists but the canonical payload hash differs from the stored hash.

**Worker Lease**: A time-limited claim on a queued run. Only the worker holding the active lease may advance the run.

**Approval Request**: A single-use, expiring gate for one pending action. It is bound to run ID, action fingerprint, requester, and expected run state.

**Capability**: A governed action Houge may request, such as web research, local file read, browser action, Gmail draft, or coding-agent delegation.

**Capability Policy**: The deterministic policy module that decides whether a capability request is allowed, denied, or requires approval.

**Capability Runner**: The single execution module for governed capabilities. It coordinates Tool Registry lookup, schema validation, budget reservation, Capability Policy, approvals, adapter execution, result normalization, and Run Ledger events.

**Tool Registry**: The governed catalog of capabilities and adapters. It owns schemas, risk metadata, side-effect metadata, approval metadata, timeouts, output caps, adapter lookup, and result normalization.

**Capability Adapter**: A concrete implementation that executes a governed capability after Tool Registry and Capability Policy approve it.

**Notification Outbox**: The module that owns user-visible delivery. It formats, deduplicates, retries, and sends notification intents through local or Telegram adapters.

**Program**: A reusable task definition in `programs/<name>.md`. It compiles into task contract constraints, required skills, scoring rules, stop conditions, and eval hooks.

**Skill**: Procedural know-how loaded as context for a run. Skills do not secretly define policy.

**Memory Artifact**: A durable knowledge item such as a user profile, wiki page, environment guidebook, accepted or activated lesson, or eval checklist.

**Memory Catalog**: The metadata and lookup layer for memory artifacts. It owns tags, summaries, confidence, freshness, provenance, owner scope, visibility, trust class, and retrieval.

**Context Pack**: The bounded set of instructions, memory artifacts, skills, and metadata selected for one LLM task.

**Lesson**: A durable, scoped preference distilled from Paco's own feedback (the planner calls `lesson_write`), reconciled on write (ADD / SUPERSEDE / UPDATE) and folded into future prompts by the composer. Scope `ask` steers the planner; scope `research` steers the reader. Retired by status flip, never deleted.

**Category**: What kind of work a turn asks for, as answered by Jev's `category` question: `answer`, `lookup`, `research`, `memory`, `self_change`, `machine_task`, `schedule`, `wiki`, `mail_calendar`, `status` or `other` (11 values). Three lists carry the word "research" with three meanings: the category `research` (a turn), the lesson scope `research` (which lessons steer research turns), and the lesson theme `sources` (what a lesson is about; formerly `research`).

**Lane**: A handler whose control flow is code, with at most one composing one-shot; it falls through to the planner on any doubt. Stage B has four: memory, status, answer and lookup; every other category runs the planner, which is the floor.

**Role**: A named model seat (Fast, Default, Thinking, Reader, Vision, Tiny, Judges, Chair, Reviewer). Each role is a code-owned ordered list of `provider/model[:effort]` selectors resolved against omp's live catalog, with Paco's `/models` override on top. Fast, Default and Thinking are the planner's gears.

**Quoted Turn**: The earlier message a Telegram reply points at, resolved to a stored chat turn (`chat_turns.quoted_turn_id`) and carried into Jev's state and the planner prompt. A quote that does not resolve is a ledger note, not a failure.

**Decision**: A choice that changes a turn's path and whose answer an outcome could show wrong (ADR 0030). Mechanics — validation, timeouts, retries — are not decisions and stay plain code.

**Entry**: One decision in the code-owned registry (`src/decisions/`, protected): its id, version, stage, the input its judges read (`paco`, `tool`, `mixed`), closed verdicts, ladder, `fail` and default verdicts, what each verdict causes (and whether that is reversible and announced), and the outcome signals that can show it wrong. `turn.handler` and `turn.gear` are the first two.

**Rung**: One decider on an entry's ladder: a code `rule`, Jev (stored as `system_one`), a `model` one-shot, or `paco`. A rung answers, abstains (optionally with a monotone floor) or fails (`timeout`, `outage`, `parse`, `threw`, `stale_bar`, `budget`). Every entry ships armed; the only shadow is the front door's configured triage shadow (asked and recorded, never applied).

**Ladder**: An entry's rungs in order, code first; the first rung that answers decides, and the entry's `fail` verdict stands when none does. On a monotone entry a later rung can only tighten. What a Jev or model verdict may cause depends on what it read: over tool output only a tightening or a proposal, over Paco's own message a reversible, announced effect. The runner decides, then records (`decisions`); recording never changes a decision.

**Ladder move**: A recorded change of who decides an entry (`ladder_moves`), such as a standing approval moving a fingerprint from Paco's tap to a code rule. Only code may make one on its own (standing approvals, skill authoring after recurrence, stated-rule lessons); every loosening is a proposal for Paco's tap; locked entries never move.

**Trust level**: Clean, untrusted or hostile: what a turn has read so far (`turn.trust`, locked code). It only rises, and it only adds taps.

**Hostile turn**: A turn in which `tool.injection` withheld a passage, withheld an outside passage unjudged, or lost its judgement on outside text (framed as not checked); or a turn whose planner transcript carries a hostile level. Shell commands off the read-only list and all writes ask.

**Settle**: The last decision of a planner turn (`turn.settle`, ADR 0030 2b-i): when omp's `session_stop` hook fires, Houge decides whether the reply stands or goes back once. A code rule checks claims against the run's ledger and open todo items; a Jev rung asks four typed questions at per-question provisional bars. The final pass is audited again at the terminal `agent_end`.

**Pass**: One agent leg of a turn between settle points. Pass 0 is the planner's first answer; pass 1 is the continuation a send-back starts (it opens at that leg's `agent_start`). A turn has at most two.

**Send-back**: The one bounded continuation `turn.settle` may request through `session_stop` (`settle_sent_back`): the planner gets a code-owned note naming the reason and runs once more. The delivered reply is the continuation's text (with a code fallback that joins both passes under `— restated: —`; a failed continuation delivers pass 0 alone). A Jev-rung send-back also makes the rest of the turn's writes ask (`settleAsk`). Never repeated: a second fire settles.

**Withhold**: Replacing a passage of tool output with `[withheld: text aimed at the assistant]` before any model reads it.

**Noise band**: A reviewed per-question margin around a bar inside which a decision asks Jev once more and uses the mean (or, over tool input, the more cautious call).

**Tap label**: A calibration label taken from Paco's ✅ on a front-door lane route; other taps are evidence only.

**Dig deeper**: The button that ends every lane card (callback `lane:ask:<run_id>`; formerly "Ask Houge anyway"). A tap re-runs the message on the planner, skipping triage, and labels the lane's verdict `ask_anyway`. It is a correction signal, not a lane fault: three on one lane in seven days page Paco, and nothing is disarmed.

**Lane reply**: A turn a lane answered outside the planner's omp session. Its code-built one-line summary (`lane_replies.catch_up`) is what the next planner turn in that chat is told in the catch-up block; the lookup lane's prose is never carried.

**Learning Lifecycle**: The module that owns learning artifact states, provenance, approval, eval gates, activation, and rollback.

**Environment Guidebook**: A typed wiki artifact that maps a repeated environment such as a website, repo, inbox, chat, or tool ecosystem.

**Trajectory Eval**: An evaluation of the execution path, not just the final output. It checks repeated tool calls, policy violations, unsupported claims, missing approvals, and budget waste.

**Evolution Eval**: An evaluation that measures whether a learning artifact changed future behavior and improved quality, cost, time, steps, or approval burden.

**Self-Repair**: A V2 loop that restores expected Houge behavior after a runtime failure by diagnosing evidence, delegating to contained coding agents when allowed, validating a patch, and leaving a rollback receipt.

**Self-Evolution**: A V2 loop that improves expected future behavior through measured changes to programs, skills, wiki, guidebooks, evals, or code. It differs from self-repair because it changes the target behavior rather than restoring it.

**Behavioral Record (Flight Recorder)**: The durable record of what Houge actually *did* — `runs`, `ledger_events`, `scheduled_tasks`, `notification_outbox`, `daemon_heartbeat`. Distinct from the memory types, which store what was said, learned, or known. It is machine-checkable, which is what makes autonomous self-verification possible in the behavioral domain where conversation offers no verifier.

**Invariant**: A deterministic assertion over the behavioral record that must hold in a healthy system (e.g. "no two enabled schedules share chat + spec + tz + goal"; "an active run holds a live lease"). Checked by code, never by model judgment.

**Invariant Sweep**: The periodic tick that evaluates every invariant and maintains incidents. Least-privileged by construction: pure reads plus incident bookkeeping — no LLM, no capability, no run creation, so it can observe but never act.

**Incident**: A durable record of a violated invariant, fingerprinted `kind:subject`, with an open→resolved lifecycle. Rows are never deleted; a recurrence after resolution opens a new row so recurrence stays countable. Alerts fire on transitions only, never per sweep.

**Provenance Strip**: The rule that a run born from a schedule fire (`event.source === "schedule"`) has `schedule_task` removed from its task contract, so replayed schedule text can never be acted on as a fresh instruction to create or mutate schedules. The general principle: a capability is withheld based on how a run was *born*, not on what its text says.

**Google-Auth Client**: The shared OAuth closure that exchanges the broker-held Gmail refresh token for short-lived Google access tokens. The runtime-minted access token lives and dies inside the closure — it never appears in results, errors, digests, or ledger rows.

**Allowlist Registry**: The code-constant table in the google-api transport with exactly one row per granted OAuth scope (host + path prefix ↔ scope, 1:1 — ADR 0025 §3). Widening it is a three-party act: console OAuth grant (Paco) + registry row (code review) + ADR amendment. Path validation rejects rather than normalizes.

**Verification Extraction (`trusted_extract` side-channel)**: The deterministic regex pass over a raw mail body that extracts OTP codes and verification links, appended *after* the Q-LLM reader digest. Trusted for the same reason as time claims: structured, hygiened, hard-capped, no verb — code built it, so it cannot carry an instruction. Links stay byte-exact and remain attacker-controlled data.

**Lesson Consolidation (Preserve-All Merge)**: A daily merge tick that clusters near-duplicate ACTIVE lessons within a scope and merges each cluster into one lesson keeping every directive and every AVOID. It is **ADD-then-supersede-all**: the merged lesson is added and the originals are superseded (never deleted), reuse value carried (capped/clamped). A cluster-size cap plus gross-collapse and avoid-drop floors prevent over-collapse. It mirrors episodic consolidation and is the lesson-side analogue of reconcile-on-write, operating in bulk rather than per-write.

**API-vs-Subscription Usage Split**: The `/usage` (Telegram) and `houge usage` (CLI) accounting distinction between **metered API legs**, pay-per-token providers whose real dollar cost is tracked, and **subscription legs**, reported in tokens only and labelled "sub". Since the omp cutover every default leg is a subscription leg (omp under profile `houge`, `agy-cli` for voice, `codex`), so no row is priced and the metered-$ ceiling is dormant (ADR 0019 amendment). The audit sink (`RunStore.llmAuditSink`) remains the one pricing seam if a metered leg returns. The SQLite ledger is the telemetry substrate (OTel deferred by design).

## Runtime terms (omp, ADR 0028)

**omp**: The agent runtime (`@oh-my-pi/pi-coding-agent`, an oh-my-pi fork), with no version pin and always run under its own profile `houge`, on subscription OAuth only. Any version `omp --version` reports runs; only an omp that will not run or prints no version is refused (`omp_unavailable`).

**Planner**: The one supervised omp RPC process per Telegram chat that runs every chat turn. It has omp's `read`, `edit` and `write` built-ins plus Houge's tools, runs under `sandbox-exec`, and keeps the chat's transcript in its omp session. It spawns on the Default role and each turn is pinned to its routed role (Fast, Default or Thinking); a role is a code-owned list resolved against omp's catalog, never a pinned model.

**PlannerSupervisor**: The daemon-side owner of one chat's planner: it spawns and restarts the child, holds the run lease, queues and steers messages, enforces the turn deadline and frame watchdog, and finishes the run. A child counts as started only after the bridge has served it the tool manifest.

**Detached Turn**: A `turn` run handed to its chat's PlannerSupervisor instead of being awaited by the poll loop. The loop keeps polling, so `/approve`, `/kill`, a second message and outbox flushes are handled while the turn runs. Non-turn runs keep the synchronous path.

**Steered Run**: A message that arrives while its chat's turn is running. It is still its own run, claimed by the supervisor and `steer`ed into the live turn; Paco gets one reply (the parent's), and the steered run finishes as `merged_into:<run_id>`, or fails `merged_parent_failed` with its parent. Media and schedule-born runs never steer.

**Bridge**: The per-planner-child Unix socket through which every Houge tool runs daemon-side. Its authority (run, lease, contract, budget) is server-owned: the child sends a tool name, input and call id, never a run id. Request kinds are `call`, `gate`, `report`, `context` and `manifest`.

**Tool Declaration**: One JSON file per Houge tool under `src/omp/tools/` (name, description, JSON-Schema parameters). It is data: the daemon validates it at boot and serves it as the manifest, and it can never choose its own policy class.

**Capability Map**: The protected, code-owned mapping from a tool name (and validated input) to a Tool Registry entry (`src/omp/capability-map.ts`). `bash` maps to `shell`, or to `shell_external` when the matcher classifies the command as an external write.

**Policy Hook**: The `tool_call` hook in the planner's single extension (`dist/omp/extension/houge.js`). It allowlists tool names, refuses URL-shaped reads, canonicalises paths the way omp resolves them, and asks the bridge to `gate` every built-in file call before omp runs it.

**Seat**: A named LLM role with its own model chain. The planner is the conversational seat; every other seat (reader, photo, ticks, judges, chair, reviewer) is a **one-shot seat**: a tool-less, sessionless, extension-less omp spawn, one per call. Voice transcription (agy-cli) and the self-write writer (codex) are seats outside omp.

**Model String**: `provider/model[:effort]`, one entry in a seat's ordered chain. On a retryable error (quota, auth, transport, timeout, model missing) the next string serves; a refusal is final.

**Floor A**: The file floor. The planner process and every `bash` command run under rendered Seatbelt profiles (`planner.sb`, `shell.sb`): writes denied by default outside `$HOME`, `/private/tmp` and the workspace, then denied again for the Houge repo, `dist/`, binary install trees and code-running dotfiles; credential stores read- and write-denied. The policy hook denies the same paths with a clean reason. Code-owned, not bypassable by the model.

**Floor B**: The external-effect floor. A `bash` command that the code-owned matcher (`src/omp/command-matcher.ts`) classifies as an external write or a destructive delete, and any bridge tool whose registry level is `external_write`, waits for Paco's `/approve`. Best effort for `bash`: a command the matcher misses runs (accepted residual, D12).

**Tool Approval**: The in-turn approval record (`tool_approvals`) created when a bridge call hits floor B. The run stays `running` while the call is suspended; `/approve <id>` or `/deny <id>` resolves it, it expires after the approval timeout, and a single compare-and-set consume means one approval authorises exactly one execution. One approval is in flight per turn.

**Planner Workspace**: `<data>/omp/workspace/chat-<id>`, the planner's working directory and the only place `[[attach: <path>]]` may send a file from. Its root and chat directories are pinned against moves and symlink swaps.

**Family Collapse**: The state in which the planner and the quarantined reader resolve to the same model family after fallback. The read proceeds but is audited: the `llm_attempt` row carries `family_collapse`, a `wall_collapse` event is written, and incident `wall_collapsed` stays open (D10).

## Historical terms (retired by the omp cutover, 2026-10)

These appear in older ledger rows, specs and sessions. They no longer describe the running system.

**Inner Loop**: The pre-omp agentic loop (`src/core/inner-loop.ts`, ADR 0013) that handed the model a tool manifest and parsed one JSON action per step under a step cap. Replaced by omp's agent loop.

**JSON Action Protocol**: The inner loop's contract that the model reply with one JSON object naming the next action. Gone: the planner calls tools natively.

**Intent Classifier / Intent Router**: The per-turn LLM call (`classifyIntent`, the `intent_router` contract action) that labelled a message answer / research / feedback / clarify / selfcode / skill before dispatch. Deleted; the planner picks its own steps. The `Intent` type survives for historical rows, and `chat_turns.intent` is now `loop` or `clarify`, written by the supervisor.

**llm_answer**: The inner-loop tool that asked the model chain for a final answer. Deleted as a planner tool; the planner answers directly. The internal `/run` research programs still use an answer capability.

**Dual-LLM Arming Couple**: The rule that `gmail_read`/`google_api` armed only when both the Google flag and the dual-LLM flag were on. Gone: the wall is unconditional, so the Google flag alone arms them.

**Money Track**: The earning tools (`bounty_scan`, `project_*`, `external_work`) and the external workspace (ADR 0022, 0023). Code deleted at `3aabc04`; the tables and historical rows stay readable.
