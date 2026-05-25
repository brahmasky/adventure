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
