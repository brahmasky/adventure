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

**Lesson**: A proposed, accepted, or activated reusable learning from `/teach`, run reflection, or delegated agent teaching packets.

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

**Dual-LLM Arming Couple**: The manifest rule that `gmail_read`/`google_api` are armed only when `HOUGE_GOOGLE_ENABLED` and `HOUGE_DUAL_LLM_ENABLED` are both on, composed in the tool manifest. There is no configuration in which un-quarantined mail bytes reach the planner; if either flag is off, the tools silently vanish from the manifest.
