# Houge ChatOps Orchestrator Design

Date: 2026-05-25
Status: Draft for review

## Purpose

Houge (猴哥) is a Telegram-first Multi-Agent Harness and autonomous worker orchestrator inspired by Pi, OpenClaw, Hermes, Karpathy's autoresearch style, world-knowledge exploration research, and the user's experience with coding agents such as Codex, Claude, Gemini, Kimi, and Pi.

Houge should be able to receive commands through chat, convert them into bounded task runs, delegate work to coding agents and tools, report progress, ask for approval when needed, and evolve through measured learning. Task execution is the foundation. Learning, adaptation, and improvement are the long-term goal.

The first implementation should stay project-scoped under `/Users/pluo/Projects/adventure`. Trial and error is acceptable inside that scope. Non-recoverable operations, external side effects, account changes, money-moving actions, and writes outside the project folder require explicit approval.

## Product Shape

Houge starts as a Telegram ChatOps harness, not a generic chatbot and not a scheduler-first automation service.

Telegram is the first command center:

```text
Telegram message or scheduled trigger
-> Trigger Adapter
-> Houge Gateway
-> Houge Core
-> Capability Runner
-> Tool Registry
-> Agent and Tool Adapters
-> local run artifacts and memory
-> Telegram progress and result messages
```

The initial Telegram command surface is:

- `/ask <question>`: answer a question, optionally using research or local context.
- `/run <program> <goal>`: start a bounded autonomous task.
- `/status [run-id]`: report current run state.
- `/approve <id>`: approve a pending gated action; Milestone 4 also uses this for learning approvals.
- `/deny <id>`: deny a pending gated action; Milestone 4 also uses this for learning denials.

Milestone 4 adds:

- `/teach <lesson>`: explicitly teach Houge a preference, rule, workflow, or correction.

Commands are deterministic code paths. LLMs reason only inside bounded task execution.

`/ask` is a convenience command, not a bypass around the run system. In V1.0 it compiles to a built-in lightweight `ask` program with the same Gateway, Run, TaskContract, CapabilityRunner, budget, policy, ledger, and notification path as `/run`. The difference is that `/ask` selects the built-in program automatically, while `/run <program> <goal>` selects an explicit reusable program.

## Design Principles

- Deterministic code controls identity, routing, permissions, state transitions, retries, budgets, approvals, and side effects.
- LLMs are used for judgment calls: planning, synthesis, extraction, critique, summarization, and strategy.
- Houge is the harness and orchestrator. Delegated agents are workers or advisors, not authorities.
- Agents provide local intelligence. The harness owns global control: lifecycle, routing, budget, permissions, retries, termination, memory updates, and final decisions.
- Every nontrivial task has a contract: objective, budget, allowed actions, forbidden actions, output, approval gates, and stop condition.
- Every task leaves a receipt: report, events, artifacts, lessons, and telemetry.
- Learning must close the loop: activated learning changes what future runs retrieve and do.
- Houge evolves only when a learning artifact changes future behavior and the result is measured.
- Memory must be layered, curated, budgeted, and maintained. Houge must not load all memory by default.
- State and memory are different. State is short-lived execution data; memory is curated cross-task knowledge.
- Tools are governed resources, not plain function calls. All tool access goes through a registry with schema, risk, approval, and audit rules.
- Evaluation must inspect both final outputs and execution trajectories.
- External and destructive actions require explicit approval.
- Observability and security are built in from the start.

## Architecture

The system has six main layers:

```text
Trigger Adapters: Telegram, schedule, CLI, future events
-> Houge Gateway
-> Houge Core
-> Capability Runner
-> Tool Registry
-> Agent and Tool Adapters
```

### Trigger Layer

The Trigger Layer converts external activation sources into typed task events. It should be deterministic and thin.

Initial trigger sources:

- Telegram: chat commands and approval responses.
- Schedule: daily or weekly recurring tasks.
- CLI: local manual runs for development and debugging.

Future trigger sources:

- Gmail events.
- GitHub events.
- Calendar events.
- Website or RSS changes.

Trigger adapters own raw source details:

- `TelegramTriggerAdapter` owns Telegram long polling or webhook intake and command parsing for `/ask`, `/run`, `/status`, `/approve`, and `/deny`. Milestone 4 extends the parser with `/teach`.
- `ScheduleTriggerAdapter` owns fired schedule records from `launchd`, cron, or a small scheduler library.
- `CliTriggerAdapter` owns local argument parsing for development commands.

All triggers should create the same internal event shape:

```yaml
source: telegram | schedule | cli | event
type: ask | run | approve | deny | teach
program: optional program name
goal: optional goal text
requested_by: user, schedule, or system identity
notify: Telegram chat or local output target
idempotency_key: source-specific stable key
payload_hash: canonical hash of the normalized trigger payload
created_at: timestamp
```

The LLM should not decide when a schedule fires, which command type a trigger maps to, or whether the trigger is authorized. Even if a trigger adapter and the gateway run in the same process, the module seam remains: raw Telegram updates, cron records, and CLI args become `TypedTaskEvent`s before Gateway handling.

### Houge Gateway

The gateway is the deterministic ChatOps control plane.

Responsibilities:

- Accept only `TypedTaskEvent`s at the Gateway interface.
- Authenticate requester and source evidence against allowlisted Telegram users, chats, schedules, or local identities.
- Validate required event fields.
- Create and load sessions, run IDs, and approval IDs through the Run module.
- Deduplicate trigger events by idempotency key before creating work.
- Enforce run and approval state before routing execution.
- Enqueue and resume tasks.
- Emit notification intents for progress and final reports.
- Emit logs and OpenTelemetry spans for command handling.

The gateway should not ask an LLM whether a command is valid, whether a user is authorized, whether approval happened, or whether a side effect is allowed.

Gateway/Core invocation boundary:

```ts
interface Gateway {
  intake(event: TypedTaskEvent): Promise<
    | { ok: true; run_id: string; status: "created" | "duplicate" | "resumed" | "approval_resolved" }
    | { ok: false; error: GatewayIntakeError }
  >;
}

interface CoreWorker {
  execute_queued_runs(worker_id: string): Promise<void>;
}
```

`Gateway.intake` returns after deterministic intake, deduplication, contract attachment, approval resolution, and enqueueing. It does not wait for the run to complete. `CoreWorker` claims queued runs through the Run module and executes them.

### Schedule Trigger Adapter

Scheduling is a trigger source, not the center of the architecture.

Houge should not build a scheduler from scratch in V1.x. `ScheduleTriggerAdapter` should use an existing reliable mechanism such as macOS `launchd`, system `cron`, or a small Node scheduler library, then translate each fired schedule into the same typed task event used by Telegram.

Schedule definitions should live in project-local config:

```yaml
schedules:
  weekly_opportunity_scout:
    cron: "0 9 * * MON"
    timezone: "Australia/Sydney"
    command:
      type: run
      program: opportunity-scout
      goal: "Find 5 legitimate AI/dev opportunities for Paco this week."
    notify:
      telegram_chat: paco
    approval_policy: report_only
```

Schedule execution flow:

```text
schedule fires
-> deterministic schedule runner validates config
-> ScheduleTriggerAdapter creates a TypedTaskEvent with schedule idempotency key
-> Gateway verifies schedule identity and creates run record
-> TaskContract module compiles constraints
-> normal run flow continues through CoreWorker
-> report is written
-> NotificationOutbox sends Telegram summary
```

Scheduled runs obey the same safety rules as interactive runs. They may research, draft, summarize, and report by default. They may not send messages, submit applications, spend money, change accounts, or perform destructive actions without approval.

### Houge Core

The core owns task execution and learning.

Responsibilities:

- Build task contracts from requests and programs.
- Select relevant context under a token budget.
- Plan the task.
- Delegate bounded subtasks to agents and tools.
- Compare and critique delegated outputs.
- Track budget, stop conditions, and approval boundaries.
- Write reports and run receipts.
- Propose memory, program, skill, and eval updates.

The core can use Pi as the base agent runtime. Pi's extension and skill model should influence how Houge exposes tools, hooks, commands, and reusable skills.

### Tool Registry

The Tool Registry is the governed catalog between Houge Core and executable capabilities. Capability Policy makes authorization decisions; the registry supplies the metadata, schemas, adapter lookup, and result normalization needed to execute an approved request.

Responsibilities:

- Register every tool and adapter before use.
- Validate inputs with JSON Schema or equivalent structured schemas.
- Expose allowed agent/program metadata for Capability Policy decisions.
- Apply execution timeouts, output caps, and adapter-level rate limits.
- Classify risk level and side-effect level.
- Expose approval requirement metadata for Capability Policy decisions.
- Normalize output schemas.
- Emit audit events for every tool invocation.

Each tool record should include:

- unique name
- description for LLM/tool selection
- input schema
- output schema
- allowed agents and programs
- timeout and rate limit
- risk level: low, medium, high
- side-effect level: none, local_write, external_read, external_write, destructive, paid
- approval requirement
- audit retention policy

MCP servers, browser tools, shell commands, Gmail actions, and future coding-agent CLIs should all enter Houge through the Tool Registry when supported. MCP servers must not be exposed directly to agents.

### Agent and Tool Adapters

Adapters expose external capabilities to Houge Core through controlled interfaces.

Initial adapter candidates:

- Pi runtime and tools.
- Allowlisted local command adapters. V1.0 and V1.x should not include a generic shell adapter.
- Web research/browser adapter.

Future adapter candidates:

- Gmail adapter for a Houge-owned inbox.
- Local CLI adapters for coding agents such as Codex, Claude, Gemini, and Kimi. These are out of scope until deterministic process containment exists.

Each adapter should declare:

- name
- supported actions
- required permissions
- input schema
- output schema
- side-effect level
- telemetry fields

Adapters are implementation details behind Tool Registry entries. Houge Core should request a governed capability through Capability Runner, not call adapter code directly.

## Core Deep Modules

Implementation should start by making the main concepts deep modules with small, explicit interfaces. This avoids scattering lifecycle, safety, and memory logic across Gateway, Core, Tool Registry, and adapters.

### Trigger Adapter

`TriggerAdapter` is the source-specific inbound adapter seam. It owns raw activation details and emits `TypedTaskEvent`s.

Initial adapters:

- `TelegramTriggerAdapter`
- `ScheduleTriggerAdapter`
- `CliTriggerAdapter`

Interface responsibilities:

- listen to or receive raw source input
- parse source-specific commands or fired schedule records
- compute idempotency key and canonical payload hash
- attach raw source reference for audit
- emit a `TypedTaskEvent`

Interface sketch:

```ts
interface TriggerAdapter {
  source: "telegram" | "schedule" | "cli" | "event";
  listen(emit: (event: TypedTaskEvent) => Promise<void>): Promise<void>;
  normalize(raw: unknown): TypedTaskEvent | TriggerValidationError;
}
```

Trigger adapters do not create runs, resolve approvals, execute capabilities, or write memory.

### Typed Task Event

`TypedTaskEvent` is the seam between triggers and the gateway. Telegram, Schedule, CLI, and future event triggers are thin adapters that normalize source-specific input into this shape.

Interface responsibilities:

- source identity
- command type
- requested program and goal
- requester identity
- notification target
- idempotency key
- raw source reference for audit

The Gateway should not parse schedule or Telegram-specific details after this seam.

Ownership:

- Trigger adapters own source-specific parsing and normalization.
- Gateway owns authorization, session lookup, deduplication, run creation, and notification routing.
- `TypedTaskEvent` carries a canonical payload hash so same-key different-payload conflicts can be rejected and audited.

### Run

`Run` is the central lifecycle module. It owns run state, budget zone, approvals, execution events, receipts, and terminal semantics.

Interface responsibilities:

- create or deduplicate a run from a typed task event
- transition run state
- attach task contract
- record execution events
- track budget ledger
- create and resolve approval requests
- produce run receipt paths
- determine whether the run can resume, complete, fail, expire, or cancel

Gateway and Core should collaborate through the Run interface instead of each owning separate lifecycle rules.

Public Run operations should stay small:

- `create_or_get(event)`
- `attach_contract(contract)`
- `transition(expected_state, next_state, reason)`
- `request_approval(action)`
- `resolve_approval(approval_event)`
- `record_capability_result(result)`
- `complete(report_ref)`
- `fail(error_ref)`

Budget ledger, approval records, and Run Ledger events are internal implementation details unless a caller needs read-only reporting.

### Task Contract Module

`TaskContract` owns contract compilation, validation, and deterministic enforcement.

Inputs:

- typed task event
- selected Program
- default safety policy
- requester identity

Outputs:

- validated task contract
- validation errors
- contract hash
- eval hooks

Interface sketch:

```ts
type TaskContractResult =
  | { ok: true; contract: CompiledTaskContract }
  | { ok: false; error: TaskContractValidationError };

interface TaskContractCompiler {
  compile(input: {
    event: TypedTaskEvent;
    program?: ProgramDefinition;
    default_policy: SafetyPolicy;
    requester: Identity;
  }): TaskContractResult;
}
```

`CompiledTaskContract` must include objective, budget, allowed actions, forbidden actions, output contract, approval gates, stop condition, contract hash, and eval hooks.

Gateway and Core should not reimplement contract rules. Capability Policy consumes the validated contract.

### Capability Policy

`CapabilityPolicy` is called by Capability Runner. It makes one deterministic decision for every requested capability:

```text
allow | deny | requires_approval
```

Inputs:

- task contract
- requested capability
- requester identity
- run state
- tool risk level
- side-effect level
- approval metadata from the registry

The policy decision should be table-testable. Capability Runner should execute tool adapters only after the policy returns `allow` or an approval is resolved and revalidated.

Tool Registry and Capability Policy have separate authority:

- Tool Registry owns catalog metadata, schema validation, adapter lookup, timeouts, result envelopes, and normalized outputs.
- Capability Policy owns allow, deny, or requires-approval decisions.
- Capability Runner coordinates both and records the decision in the Run Ledger.

Agent delegation is a governed Capability. Pi, Codex, Claude, Gemini, and Kimi integrations must use the same policy, budget, result envelope, and ledger path as other tools.

V1.0 and V1.x policy rule:

- Capability requests with `category=coding_agent_cli` return `deny`.
- Denial reason: deterministic process containment is not implemented yet.
- This rule may be changed only in V2 after cwd jail, environment allowlist, filesystem allowlist, command prefix audit, timeout, output cap, and secret deny-by-default exist.

Schedule policy modes:

- `default`: use normal Capability Policy rules.
- `report_only`: allow only capabilities with `side_effect_level=none`; deny and report any capability that would require approval or create an external/local side effect.
- `require_all`: every capability request returns `requires_approval`, even if it would normally be allowed.

Schedule config cannot weaken global safety policy. It can only make scheduled runs stricter or convert unsafe scheduled actions into report-only findings.

### Capability Runner

`CapabilityRunner` is the only module that executes governed capabilities. Core asks for a capability result; the runner owns the full invocation lifecycle.

Interface responsibilities:

- accept a run reference, task contract, requester identity, and capability request
- look up registry metadata and validate request schema
- reserve budget before execution or delegation
- call Capability Policy and branch on `allow`, `deny`, or `requires_approval`
- create approval requests, release the worker lease while waiting, and resume only after the run is requeued, claimed again, and revalidated
- assign `tool_call_id`, `operation_id`, and `action_fingerprint`
- execute the selected adapter with timeout, output cap, and secret allowlist
- normalize adapter outputs into result envelopes
- reconcile reserved, estimated, and actual budget
- record ToolCall state transitions and Run Ledger events
- mark recovery as `uncertain_outcome` when a side effect may have happened but no completion event was recorded

Result envelope:

```ts
type CapabilityResult =
  | { status: "succeeded"; output_ref: string; output_hash: string }
  | { status: "denied"; reason: string; recovery_hint?: string }
  | { status: "requires_approval"; approval_id: string }
  | { status: "denied_on_revalidation"; reason: string; recovery_hint?: string }
  | { status: "failed" | "timed_out" | "cancelled"; error_ref: string }
  | { status: "uncertain_outcome"; reconciliation_ref: string };
```

Core receives denial, revalidation denial, failure, timeout, and uncertain-outcome results as structured tool results. It may replan only when the task contract permits a safe alternative; otherwise it reports the blocked action and stops or asks for user direction.

No Gateway, Core, Tool Registry, or adapter caller should bypass Capability Runner to execute a capability.

Adapters that can create side effects must declare their reconciliation contract:

- `idempotency_support`: none, client_key, provider_key, or read_after_write
- persisted external operation key when one exists
- whether a retry is safe after timeout or crash
- `reconcile(operation_id)` result: `not_started`, `completed`, `failed_before_side_effect`, or `uncertain`

Capability Runner records this in a Tool Operation Journal tied to `tool_call_id` and `operation_id`. Runs enter `reconciliation_required` when the adapter cannot prove a safe retry or safe continuation.

### Run Ledger

`RunLedger` is the source of truth for execution evidence. Reports, audit logs, trajectory evals, budget accounting, and OpenTelemetry exports should read from the ledger instead of parsing ad hoc logs.

V1 event types:

- trigger_received
- auth_failed
- validation_failed
- command_rejected
- command_rate_limited
- idempotency_conflict
- schedule_fired
- schedule_skipped_duplicate
- run_created
- contract_attached
- worker_lease_acquired
- worker_lease_released
- worker_lease_expired
- context_selected
- budget_zone_changed
- capability_requested
- policy_decision
- tool_started
- tool_finished
- approval_requested
- approval_resolved
- notification_queued
- notification_delivered
- notification_failed
- report_written
- lesson_proposed
- reconciliation_required
- eval_completed
- run_completed
- run_failed
- run_cancelled
- run_expired

Every Run Ledger event uses the same envelope:

```yaml
event_id: stable unique id
run_id: run id when available
correlation_id: trigger, approval, or recovery correlation id
event_type: one of the V1 event types
occurred_at: timestamp
actor: gateway | core | capability_runner | trigger_adapter | notification_outbox | system
sequence: monotonically increasing per run, or per correlation id before a run exists
payload: event-specific structured object
```

Minimum payload fields:

| Event | Required payload fields |
|-------|-------------------------|
| trigger_received | source, source_reference, requester, idempotency_key, payload_hash |
| auth_failed | source, source_reference, requester_evidence_hash, reason |
| validation_failed | source, source_reference, validation_error, payload_hash |
| command_rejected | source, requester, command_type, reason |
| command_rate_limited | source, requester, limit_name, retry_after |
| idempotency_conflict | source, idempotency_key, existing_run_id, stored_payload_hash, incoming_payload_hash, resolution |
| schedule_fired | schedule_id, scheduled_time, command_hash |
| schedule_skipped_duplicate | schedule_id, scheduled_time, idempotency_key, existing_run_id |
| run_created | source, idempotency_key, program, goal_hash, requester |
| contract_attached | contract_hash, program, budget, allowed_actions, approval_gates |
| worker_lease_acquired | worker_id, lease_expires_at, attempt_count |
| worker_lease_released | worker_id, reason |
| worker_lease_expired | worker_id, lease_expires_at, active_tool_call_id, recovery_action |
| context_selected | context_pack_id, included_artifact_ids, excluded_relevant_artifact_ids, token_estimate |
| budget_zone_changed | previous_zone, next_zone, remaining_budget, reason |
| capability_requested | tool_call_id, capability, input_hash, side_effect_level, risk_level |
| policy_decision | tool_call_id, decision, reason, policy_version |
| tool_started | tool_call_id, operation_id, adapter_name, input_hash, timeout_ms |
| tool_finished | tool_call_id, status, output_hash, duration_ms, bytes_out |
| approval_requested | approval_id, action_fingerprint, action_summary, side_effect_level, expires_at |
| approval_resolved | approval_id, decision, requester, resolved_at |
| notification_queued | notification_id, target, intent_type, idempotency_key |
| notification_delivered | notification_id, target, adapter, delivered_at |
| notification_failed | notification_id, target, adapter, error_ref, retryable |
| report_written | report_ref, report_hash, partial |
| lesson_proposed | lesson_id, source_run_id, provenance, target_artifact_type |
| reconciliation_required | tool_call_id, operation_id, reason, reconciliation_ref |
| eval_completed | eval_suite, passed, failed_case_ids, report_ref |
| run_completed | report_ref, budget_used, duration_ms |
| run_failed | error_type, error_ref, recoverable |
| run_cancelled | reason, requester, report_ref |
| run_expired | reason, expired_at, report_ref |

For idempotency conflicts, `resolution` is always `rejected`. The Gateway returns `IDEMPOTENCY_CONFLICT`, queues a user-visible notification when a notify target exists, and does not create a new run or alter existing run state.

### Notification Outbox

`NotificationOutbox` owns user-visible delivery. Other modules emit notification intents or Run Ledger events; the outbox formats, deduplicates, retries, and sends through adapters.

Initial adapters:

- local console/stdout
- Telegram

Notification intents should include idempotency keys so retrying after a Telegram failure does not send duplicate summaries.

Durable notification states:

```text
queued -> sending -> delivered
sending -> retry_wait -> queued
sending|retry_wait -> failed_terminal
```

Outbox records include target, idempotency key, send lease, attempt count, next attempt time, provider message id when available, and payload hash. Notification records for approval prompts and final reports are created in the same transaction as the run or approval state change that requires them. If an approval notification cannot be delivered before expiry, the approval expires and the run reports the blocked action.

### Memory Catalog and Context Pack

`MemoryCatalog` owns memory metadata, summaries, tags, confidence, freshness, provenance, and lookup. `ContextPack` is the bounded result passed to the LLM.

Memory artifacts must carry scope metadata:

- `owner`: user, system, project, program, or environment identity
- `visibility`: private, shared, or public-within-project
- `trust_class`: instruction, procedure, data, evidence, or raw

Context selection must filter memory by requester identity before ranking. User-scoped artifacts such as `memory/user/paco.md` are private to that requester unless explicitly marked shared. If multiple Telegram users are allowlisted, another user's run must not retrieve Paco-scoped profile, lessons, or artifacts by default.

The Context Selector should build a Context Pack from Memory Catalog results. It should not need to know every folder layout directly.

### Learning Lifecycle

`LearningLifecycle` owns learning artifact states and promotion rules.

Artifact states:

```text
proposed -> accepted
accepted -> activated
proposed -> rejected
accepted|activated -> reverted
```

Accepted means reviewed and indexed for follow-up eval or activation; it does not mean automatic prompt inclusion. Activated means eligible for automatic retrieval when trust class, task match, and budget allow it.

Memory Catalog indexes accepted and activated Memory Artifacts. Context Selector may surface accepted artifacts for review or eval, but it auto-retrieves only activated artifacts whose state and trust class allow prompt inclusion.

### Program

`Program` turns `programs/<name>.md` into contract constraints, scoring rules, required skills, stop conditions, and eval hooks. Skills remain procedural context. They should not secretly define policy.

## Command Flow

Example:

```text
/run research-brief "compare Pi, OpenClaw, and Hermes gateway designs"
```

Telegram flow:

```text
Telegram update
-> Telegram trigger parses /run into a TypedTaskEvent
-> gateway verifies user/chat allowlist
-> gateway validates the typed event and idempotency hash
-> gateway creates run record
-> TaskContract module verifies program exists and compiles constraints
-> gateway attaches contract and enqueues run
-> core worker claims queued run
-> core receives the task contract
-> context selector creates context pack
-> core plans and executes bounded work
-> core requests governed capabilities through Capability Runner
-> Capability Policy returns allow, deny, or requires_approval
-> approved capability executes through Tool Registry adapter lookup
-> approval gate queues NotificationOutbox request and releases worker lease if needed
-> gateway receives /approve or /deny deterministically and requeues approved run
-> core writes report and receipt
-> learning loop proposes updates
-> NotificationOutbox sends final summary to Telegram
```

Schedule flow:

```text
schedule runner fires weekly_opportunity_scout
-> schedule trigger creates a TypedTaskEvent for opportunity-scout
-> gateway verifies schedule is enabled and allowed
-> gateway creates run record with source=schedule
-> TaskContract module verifies program exists and compiles constraints
-> normal run flow continues
-> NotificationOutbox sends final report to Telegram
```

## Task Contract

Task contracts are the core safety and control object.

Example:

```yaml
objective: Find and summarize relevant gateway architecture patterns.
budget:
  time_minutes: 45
  max_agent_delegations: 3
  max_tool_calls: 30
allowed_actions:
  - web_research
  - read_local_memory
  - write_report
  - delegate_to_pi_runtime
forbidden_actions:
  - send_messages
  - submit_applications
  - spend_money
  - write_outside_project
output:
  path: runs/<run-id>/report.md
  format: sourced_markdown_report
approval_gates:
  - external_send
  - account_login
  - paid_action
  - destructive_file_action
  - write_outside_project
stop_condition: sufficient answer produced or budget exhausted
```

The gateway and executor enforce the contract. The LLM may draft or refine a contract, but deterministic code validates and applies it. In V1.0 and V1.x, delegation actions exclude `coding_agent_cli`; those requests are denied by Capability Policy until V2 containment exists.

## State Model

Houge separates state from memory.

State is execution data for the current command, session, or run. It is operational and time-bound. Memory is curated knowledge intended to influence future behavior.

State layers:

- Working State: current step context, scratch notes, intermediate tool outputs, and temporary plan state. It expires when the run ends.
- Session State: Telegram chat/session context, pending approvals, active run IDs, and short-lived user interaction state. It may use SQLite with explicit retention and cleanup.
- Execution Log: immutable event history for audit, debugging, replay, evaluation, and observability. It is not loaded into prompt context by default.

The LLM may reason over selected state, but deterministic code owns state transitions.

### V1.0 Persistent Storage Model

V1.0 uses SQLite for operational state and the project filesystem for human-readable reports, artifacts, memory, programs, skills, and eval fixtures. SQLite is the authority for lifecycle, idempotency, approvals, leases, outbox delivery, artifact indexes, and schema versioning.

Minimum SQLite entities:

- `schema_migrations`: ordered migration id, checksum, applied timestamp, and result.
- `runs`: `run_id` primary key, `source`, `idempotency_key`, `payload_hash`, `state`, `program`, `requester`, `notify_target`, `attempt_count`, `worker_id`, `lease_expires_at`, timestamps; unique on `source + idempotency_key`.
- `sessions`: `session_id` primary key, source, requester, chat or local target hash, active run id, and last activity timestamp.
- `approvals`: `approval_id` primary key, `run_id`, `approval_type`, `state`, `action_fingerprint`, `requester`, `expires_at`, `consumed_tool_call_id`; unique active approval per `run_id + action_fingerprint`.
- `tool_calls`: `tool_call_id` primary key, `run_id`, `operation_id`, `action_fingerprint`, `state`, `capability`, `side_effect_level`, `risk_level`, timestamps.
- `tool_operations`: `operation_id` primary key, `tool_call_id`, idempotency support, external operation key, reconciliation state, evidence refs, and operator resolution notes.
- `run_ledger`: `event_id` primary key, `run_id`, `correlation_id`, `sequence`, `event_type`, `schema_version`, `payload_json`, `occurred_at`; unique on `run_id + sequence` when `run_id` exists.
- `budget_ledger`: `entry_id` primary key, `run_id`, reservation or usage type, amount, unit, related `tool_call_id`, timestamps.
- `notification_outbox`: `notification_id` primary key, `target`, `idempotency_key`, `state`, `attempt_count`, `next_attempt_at`, `provider_message_id`, `payload_json`; unique on `target + idempotency_key`.
- `artifact_index`: `artifact_id` primary key, `run_id`, `artifact_type`, canonical path, content hash, byte count, created timestamp, and producer event id.

Every persisted envelope includes a schema or contract version. Readers must accept the current version and any explicitly supported older versions; unsupported future versions fail loudly instead of guessing.

### Migration Contract

Migrations are ordered, checksummed files applied through `schema_migrations`. Each migration runs transactionally when SQLite permits it and includes validation queries. Before applying migrations to an existing database, Houge creates a project-local backup or snapshot note with enough information to restore the previous state. Migrations that change persisted JSON payloads, ledger events, task contracts, or artifact indexes must include a backfill or a compatibility reader. Destructive migrations require an explicit rollback plan in the migration file.

### Artifact Write Protocol

Reports and raw artifacts are written through an atomic artifact writer:

- write to a temp file under the intended project-local directory
- compute content hash and byte count
- atomically rename into the final path
- record or update `artifact_index`
- emit ledger events only after the final path and index entry exist

Recovery scans compare ledger refs, `artifact_index`, and filesystem paths. Missing referenced artifacts, orphan files, or hash mismatches produce reconciliation records instead of being silently ignored.

### State Machines

State machines must be specified before implementation. They are the guardrail against duplicate Telegram updates, retried schedules, approval replay, and double execution.

Run states:

```text
created
-> contracted
-> queued
-> running
-> reporting
-> completed

running
-> waiting_for_approval
-> queued

running
-> queued

running
-> reconciliation_required

reconciliation_required
-> queued

created|contracted|queued|running|waiting_for_approval|reconciliation_required|reporting
-> failed|cancelled|expired
```

Rules:

- Run creation is idempotent by `TypedTaskEvent.idempotency_key`.
- The run store enforces a unique constraint on `source + idempotency_key`.
- `create_or_get` runs in one transaction and stores a canonical payload hash.
- Same idempotency key plus same payload hash returns the existing run.
- Duplicate intake for a non-terminal run must resume unfinished deterministic intake phases instead of only returning `duplicate`. If the existing run is `created`, Gateway re-runs idempotent contract attachment. If the existing run is `contracted`, Gateway re-runs idempotent enqueue. These operations must be safe to retry after a crash.
- Same idempotency key plus different payload hash returns `IDEMPOTENCY_CONFLICT`, records an `idempotency_conflict` Run Ledger event tied to the existing run when available, emits a user-visible notification when a notify target exists, and does not create a new run or alter existing run state.
- Payload hash is computed from a canonical JSON representation of the normalized `TypedTaskEvent` after source-specific parsing and before Gateway intake. Raw source transport metadata is excluded unless it changes task meaning.
- Terminal states are `completed`, `failed`, `cancelled`, and `expired`.
- Terminal runs cannot resume or accept approval actions.
- A run may enter `waiting_for_approval` only with a pending approval request bound to a specific action.
- Entering `waiting_for_approval` releases the active worker lease. A run waiting on a human must not hold the single V1.0 worker.
- After approval is resolved, the run transitions back to `queued`; a worker must claim it again before execution resumes.
- A run may resume execution only after the approval is resolved, the run is claimed again, and the action is revalidated.
- `reconciliation_required` parks a run when Houge cannot prove whether a non-idempotent side effect happened.
- A run in `reconciliation_required` is not claimable. It may move to `queued` only after explicit reconciliation records why retry or continuation is safe.

Queue and worker lease rules:

- V1.0 starts with one local worker. Multi-worker queues are explicitly later.
- Milestone 1 may execute synchronously, but it should use the same claim path that later Telegram/background runs will use.
- `claim_next(worker_id, lease_ttl_seconds=60)` atomically moves one `queued` run to `running` and records `worker_id`, `lease_expires_at`, and `attempt_count`.
- Only the worker holding the active lease may advance a `running` run.
- Worker heartbeat runs every 20 seconds and extends the lease to `now + 60s` only when `worker_id` and expected run state still match.
- On worker startup and then at least once per minute, recovery scans for expired running leases.
- An expired lease with no running ToolCall may be requeued if attempts remain; otherwise the run fails with a recovery receipt.
- An expired lease with an active idempotent ToolCall may be requeued if attempts remain and the adapter can prove the operation did not complete.
- An expired lease with a possibly executed non-idempotent ToolCall records `uncertain_outcome`, moves the run to `reconciliation_required`, and stops instead of retrying automatically.
- The `running -> queued` transition is allowed only for expired lease recovery when attempts remain and no side effect is active, or the active operation is proven not to have completed.

Approval states:

```text
pending -> approved -> consumed
pending -> denied
pending -> expired
```

Rules:

- Approval IDs are single-use and expire.
- Approval records are bound to `run_id`, `action_fingerprint`, `requester`, and expected current run state.
- `/approve` atomically moves `pending -> approved` and requeues the run. Replayed approvals are ignored and reported.
- `approved -> consumed` happens inside CapabilityRunner immediately before adapter execution, in the same transaction that binds the approval to `tool_call_id`, `operation_id`, and `action_fingerprint`.
- The gated action is revalidated immediately before execution.

Approval requests shown to the user must include:

- human-readable action summary
- run ID and approval ID
- side-effect level and risk level
- affected paths, accounts, URLs, or external systems
- canonical adapter/input hash
- requester and expected run state
- expiry time
- consequences of approving or denying

Users should never approve an opaque ID without seeing the exact action being authorized.

Approval workflow:

```text
CapabilityRunner creates approval request
-> Run records pending approval and releases worker lease
-> NotificationOutbox queues approval notification
-> Telegram adapter sends /approve and /deny instructions
-> TelegramTriggerAdapter parses /approve or /deny into TypedTaskEvent
-> Gateway verifies requester, approval id, expiry, run state, and action fingerprint
-> Run resolves approval atomically
-> approved run returns to queued; denied run reports blocked action
-> worker claims queued run and CapabilityRunner revalidates before execution
```

Learning approvals reuse the same Approval Request module with `approval_type=learning`. Learning approval notifications must show lesson text or summary, source run, provenance, proposed artifact changes, activation effect, expiry, and consequences of approval or denial.

Tool call states:

```text
requested -> policy_checked -> running -> succeeded
requested -> policy_checked -> denied
requested -> policy_checked -> waiting_for_approval -> running
waiting_for_approval -> denied_on_revalidation
running -> failed|timed_out|cancelled|uncertain_outcome
```

Rules:

- Tool calls execute only after Capability Policy returns `allow`.
- Every capability request has `tool_call_id`, `operation_id`, and `action_fingerprint`.
- Tool calls have wall-time limits, output byte limits, and structured result envelopes.
- `waiting_for_approval -> running` happens only after the parent run is requeued, claimed by a worker, and revalidated.
- A crash after a side effect but before `tool_finished` records `uncertain_outcome` on recovery.
- Non-idempotent external writes are not retried automatically after `uncertain_outcome`; the run moves to `reconciliation_required`.
- If approval is granted but revalidation fails, the tool call records `denied_on_revalidation`. Core may replan only if the task contract allows a safe alternative.
- Tool calls record start, finish, failure, timeout, and policy decision events in the Run Ledger.

Schedule definition states:

```text
disabled -> enabled
enabled -> disabled
```

Schedule fire occurrence states:

```text
fired -> enqueued
fired -> skipped_duplicate
fired -> failed
```

Rules:

- Schedule definitions are disabled by default.
- Schedule events use idempotency keys such as `schedule_id + scheduled_time + command_hash`.
- Duplicate firings are skipped and recorded.
- Schedules never bypass task contracts, tool policy, or approval gates.

## Budget Runtime Policy

Budgets are runtime control, not only post-run accounting.

Each run tracks:

- elapsed time
- token estimate and actual token usage where available
- tool-call count
- delegation count
- retry count
- external side-effect attempts
- subprocess wall time
- output bytes
- spawned agent count

Budget zones:

- Green: above 50% remaining. Execute normally.
- Yellow: 20% to 50% remaining. Compress context and reduce optional exploration.
- Red: 5% to 20% remaining. Prefer cheaper model/tool routes, skip nonessential review, and prepare a partial result.
- Fuse: below 5% remaining. Stop new work, write a partial report, and explain what remains.

The harness, not an agent, decides when a run changes zones or terminates.

Budgets should be represented as a ledger with hard caps. When a cap is reached, the Run module records a budget fuse event, stops new work, writes a partial report, and sends a visible status message.

Budget delegation rules:

- A run must reserve budget before spawning a tool or agent.
- Child tool/agent calls receive explicit caps for wall time, output bytes, and token/cost estimate.
- Each model or tool adapter declares cost metadata where available.
- The budget ledger reconciles reserved, estimated, and actual usage at the end of each child call.
- Unused reserved budget returns to the parent run.

Budget check points:

- Before each Capability Runner reservation, deny or downscope calls that would exceed a hard cap.
- After each child call finishes, reconcile actual usage and emit `budget_zone_changed` if needed.
- Before Core plans the next step, check the current budget zone.
- If the zone is `Fuse`, Core stops new work, writes a partial report, and records the skipped remaining work.
- In-flight non-idempotent tool calls are not interrupted mid-side-effect solely because the budget zone changes; the fuse applies before the next action.

### Global Budget Breaker (cross-run autonomy floor)

The per-run budget above bounds a single run. A separate **global circuit-breaker** bounds Houge as a whole over a rolling 24h window — the safety floor that makes the always-on/scheduled daemon (Milestone 3) responsible rather than reckless. It is a breaker, not a throttle: once any cap is reached, new run admissions are **refused at the Gateway** with a `global_budget_fuse` ledger event and exactly one deduped Telegram alert per fuse episode; admissions re-arm automatically as the window clears. Status, approve, and deny commands are never blocked.

Three independent caps (resolution: env var → code default; defaults in `src/budget/global-budget-ledger.ts`):

- `HOUGE_GLOBAL_MAX_RUNS_24H` (default 200) — **volume**: looping schedules, re-enqueue bugs, command floods.
- `HOUGE_GLOBAL_MAX_TOOL_CALLS_24H` (default 1000) — **cost**: aggregate LLM/tool spend across all runs (e.g. a single run that burns thousands of calls).
- `HOUGE_GLOBAL_MAX_GATED_ATTEMPTS_24H` (default 100) — **risk**: repeated attempts at approval-requiring actions (bad lesson, injection, loop) and the approval-prompt spam they cause.

Run admissions are counted in a dedicated `global_budget_events` table; tool-calls and gated attempts are derived from the ledger (`tool_finished` / `approval_requested`). `/status` surfaces per-cap headroom, run counts by state, and the last error. See README "Global autonomy circuit-breaker" for the operator reference.

## Delegation Model

Houge can delegate subtasks to coding agents and tools.

Example:

```text
Houge:
  Need repo analysis and architecture critique.

Delegations:
  Codex: inspect implementation and tests.
  Claude: review architecture risks.
  Gemini: research related projects and docs.
  Kimi: synthesize long-context notes.

Houge:
  Compare findings, resolve conflicts, write final report, and propose lessons.
```

Delegated agents should return structured output:

```yaml
summary: concise result
evidence: files, links, commands, or observations
risks: uncertainties or failure modes
recommended_next_steps: actions Houge may consider
teaching_packet: optional reusable lesson
```

Houge owns the final decision, memory merge, and user-facing report.

## Learning Loop

> **Design:** the end-to-end mechanism (capture → proposed lesson → **eval gate** →
> activate → measure → rollback), the evolvable-vs-constitution boundary (紧箍咒), and the
> injection-from-web safety case are specified in
> [ADR 0007](../../decisions/0007-learning-loop.md). The eval gate is the crux: a lesson
> activates only if it demonstrably helps and regresses nothing. First slice: feedback-driven
> procedural lessons for `/research`, human-gated, with the SPCX case as eval fixture #1.
> The concrete, buildable v1 (channels, files, the composer, store-grows-prompt-bounded, and
> the simple-now-scalable-later staging) is specified in
> [Learning Mechanism v1](2026-06-19-learning-mechanism-v1.md).

Learning has three lanes:

### Explicit Teaching

The user can teach Houge directly:

```text
/teach When scouting projects, prioritize ones I can prototype in under 7 days.
```

The gateway records the teaching event. Houge classifies it and proposes updates to wiki, user profile, programs, skills, or evals.

### Run Reflection

Every completed `/run` includes a short reflection:

- What worked?
- What failed?
- Was the task contract accurate?
- Did the selected tools or agents help?
- Should a program, skill, wiki page, or eval change?

V1.x should write proposed lessons rather than silently changing durable behavior.

Learning is a memory-poisoning risk. V1.x must treat all learning as proposed-only until reviewed.

Rules:

- Every proposed lesson records provenance: source run, source agent/tool, source artifact, and whether the source was user-authored, agent-authored, or external content.
- External web pages, emails, repo text, and delegated agent outputs cannot directly become durable behavior.
- Human approval is required before a lesson changes user profile, program, skill, wiki, guidebook, or eval artifacts.
- Accepted lessons should get at least one eval or retrieval check before activation and automatic loading in future runs.
- Safety policy and approval rules cannot be modified by `/teach` or agent teaching packets without an explicit ADR-level decision.
- Learning approval uses the unified Approval Request module with `approval_type=learning`; approved lessons move to `accepted`, denied lessons move to `rejected`, and activation requires the eval or retrieval gate.

Prompt-boundary trust rules:

- Core identity and safety policy are instructions.
- Programs and approved skills may provide procedural instructions.
- Wiki pages, environment guidebooks, run journals, raw artifacts, and lesson evidence are data, not instructions.
- Data artifacts are rendered as quoted or fenced context so embedded prompt-injection text cannot compete with core instructions.
- Context Pack metadata records each artifact's trust class.
- If retrieved data conflicts with core identity, safety policy, task contract, or Capability Policy, the higher-priority artifact wins and the conflict is logged.

### Delegated Agent Teaching

Delegated agents can return teaching packets:

```md
What worked:
Read package scripts before choosing test commands.

What failed:
Assuming npm test exists.

Reusable rule:
For JavaScript repos, inspect package.json scripts before running tests.

Suggested eval:
Given a JS repo, Houge should inspect scripts before selecting a test command.

Evidence:
Run <run-id>, files <paths>.
```

Houge stores teaching packets in a lesson inbox, deduplicates them, checks for conflicts, and proposes durable updates.

### Closed Feedback Loop

Learning only counts if future behavior changes.

Required loop:

```text
run or teach event
-> lesson proposed
-> lesson accepted for review and eval
-> wiki/program/skill/eval updated
-> lesson activated after retrieval or eval gate
-> future matching task retrieves activated artifact
-> Houge behaves differently
-> result is measured
-> keep, refine, or revert
```

The context selector must guarantee that activated learning is considered for future matching tasks.

## Evolution Model

Houge's long-term goal is measured evolution: it should execute tasks, learn from them, adapt its artifacts, and prove that the adaptation helps.

Maturity ladder:

1. Executes tasks: runs bounded tasks safely and leaves receipts.
2. Remembers: stores durable user preferences, wiki facts, lessons, and run history.
3. Reuses memory: retrieves the right artifacts next time and behaves differently.
4. Improves workflows: updates programs, skills, tool rules, and evals from experience.
5. Explores environments: proactively builds guidebooks for repos, websites, inboxes, tools, and communities.
6. Measures improvement: compares quality, cost, steps, time, and approval burden before and after a change.
7. Evolves safely: applies low-risk improvements automatically while asking approval for high-risk changes.

Core rule:

```text
Houge evolves only when a learning artifact changes future behavior and the result is measured.
```

### Environment Guidebooks

Houge should gradually shift from task-only execution toward environment awareness. For any repeated repo, website, inbox, chat, or tool ecosystem, it should maintain a compact guidebook that improves future task success, cost, and speed.

Guidebook path:

```text
wiki/environments/<environment-id>.md
```

A guidebook is structured world knowledge for one environment:

- environment purpose
- key URLs, files, pages, folders, or sections
- navigation and workflow map
- important entities, dates, rules, commands, and constraints
- reliable entry points for common tasks
- traps, noisy areas, login walls, stale pages, or misleading affordances
- source links and evidence
- last verified date
- confidence
- known task types that should load this guidebook

Guidebook loop:

```text
unknown or repeated environment
-> /run explore-environment <target>
-> generate compact guidebook
-> evaluate usefulness on later tasks
-> refresh, compress, or archive guidebook
```

The `explore-environment` program should be allowed to inspect an environment safely before a specific downstream task exists. It must still obey budgets, tool registry rules, approval gates, and project-scope constraints.

## Memory System

Houge uses layered memory. Memory is not a single growing prompt.

> **Architecture direction (informed by a mid-2026 survey):** see
> [ADR 0005](../../decisions/0005-agent-memory-architecture.md) and
> [docs/research/agent-memory-2026.md](../../research/agent-memory-2026.md). The survey
> validated this layered, human-gated, markdown design and added these commitments to
> the design below: **(a)** the durable store is **SQLite + FTS5** (zero-dependency, no
> vector DB) with **hybrid retrieval scored recency × importance × relevance** into the
> Context Pack budget; **(b)** raw episodic is auto-captured, durable distillation is
> human-gated (keep raw + provenance); **(c)** semantic facts are **temporally correct** —
> `valid_from`/`valid_until`, **invalidate-don't-delete**; **(d)** consolidation/reflection
> runs **off the hot path in the always-on daemon's idle loop**; **(e)** memory is
> **user-editable over Telegram** (extend `/teach` with view/correct/forget); **(f)**
> measured by a small domain eval, not vendor benchmarks.

### Layers

1. Core Identity
2. User Profile
3. Programs
4. Skills
5. Wiki
6. Environment Guidebooks
7. Lessons
8. Run Journal
9. Raw Artifacts

### Core Identity

Path:

```text
memory/core/houge.md
```

Always loaded. Kept short. Contains stable operating principles, safety boundaries, deterministic-vs-LLM split, approval rules, and the learning loop.

### User Profile

Path:

```text
memory/user/paco.md
```

Often loaded, but curated. Contains durable preferences that affect many tasks.

Examples:

- Prefers Karpathy-style programs, evals, and explicit feedback loops.
- Wants a Telegram-first autonomous worker.
- Accepts project-scoped trial and error.
- Requires approval for risky external actions.

### Programs

Path:

```text
programs/<name>.md
```

Loaded by `/run <program>`. Programs define repeatable task behavior, inputs, scoring rules, allowed actions, stop conditions, and required skills.

### Skills

Path:

```text
skills/<name>.md
```

Loaded by need. Skills define procedural know-how and tool-use recipes.

### Wiki

Path:

```text
wiki/**/*.md
```

Retrieved selectively. Wiki pages should have frontmatter:

```yaml
title: Karpathy autoresearch
tags: [karpathy, research, autonomous-agents]
summary: >
  Autoresearch frames research as bounded experiments with logs,
  metrics, and iterative program updates.
last_verified: 2026-05-25
confidence: medium
```

Houge searches indexes, tags, and summaries before loading full pages.

### Environment Guidebooks

Path:

```text
wiki/environments/<environment-id>.md
```

Retrieved when a task targets a known environment or when the context selector detects a matching URL, repo path, inbox, chat, tool ecosystem, or platform.

Guidebook pages should have frontmatter:

```yaml
title: Devpost guidebook
environment_type: website
target: https://devpost.com
tags: [opportunities, hackathons, scouting]
summary: >
  Map of Devpost discovery, search filters, hackathon pages, submission flows,
  eligibility signals, and common dead ends.
last_verified: 2026-05-25
confidence: medium
usefulness:
  task_success_delta: unknown
  step_reduction: unknown
  last_measured: null
```

Guidebooks are compact by design. They are mental maps, not archives.

V1.x should treat Environment Guidebooks as typed Wiki artifacts with stronger metadata. If later guidebook behavior grows beyond Wiki retrieval, it can become a deeper standalone module.

### Lessons

Path:

```text
lessons/inbox/
lessons/proposed/
lessons/accepted/
lessons/activated/
lessons/archived/
```

Lessons are not all permanent prompt memory. Most should be promoted into programs, skills, wiki, user profile, or evals, then archived.

### Run Journal

Path:

```text
runs/YYYY-MM-DD/<run-id>/
```

Run journals are receipts and audit history. They are never loaded by default. Future tasks may query summaries or retrieve specific runs for debugging.

### Raw Artifacts

Path:

```text
artifacts/<run-id>/
```

Raw pages, repo snapshots, transcripts, email exports, and other bulky source materials are referenced by path or ID. They are summarized into reports and wiki pages instead of loaded directly.

## Context Selector

The context selector builds a bounded context pack for each task.

Always included:

- core identity
- safety policy
- task contract
- trigger source and requester identity

Command-specific:

- selected program

Retrieved:

- relevant user preferences
- top relevant wiki pages
- matching environment guidebooks
- required skills
- recent activated lessons for the program
- eval checklists relevant to the task

Excluded by default:

- raw run logs
- full chat history
- stale lesson inbox items
- unrelated wiki pages
- raw artifacts

Example budget:

```yaml
max_context_tokens: 12000
reserved_for_task: 4000
max_wiki_pages: 5
max_guidebooks: 2
max_skills: 3
max_lessons: 5
```

If too much context appears relevant, Houge summarizes or narrows selection. It should not silently load everything. V1.0 does not expand context beyond the task contract budget through approval; that can be revisited after memory evals are reliable.

Context Pack output should include:

- included artifact IDs and paths
- token estimates
- reason each artifact was selected
- freshness and confidence notes
- excluded high-scoring artifacts that did not fit the budget

This makes retrieval auditable and gives evals a stable surface.

## Memory Maintenance

Maintenance jobs are first-class because long-term memory can rot.

Initial jobs:

- `consolidate-lessons`: merge repeated lessons into programs, skills, wiki, user profile, or evals.
- `prune-stale-lessons`: archive lesson proposals that were never useful.
- `verify-wiki`: mark external facts as stale when they may have changed.
- `refresh-guidebooks`: re-check guidebooks for environments that are stale or frequently used.
- `compress-guidebooks`: shorten guidebooks that exceed retrieval budgets while preserving evidence links and workflow maps.
- `detect-conflicts`: find contradictory user preferences, program rules, or skill instructions.
- `eval-coverage`: check whether important lessons have matching evals.
- `guidebook-coverage`: check whether frequently visited environments have guidebooks.
- `usage-review`: report which memory items are frequently retrieved, ignored, or associated with failed runs.

Maintenance jobs should produce reviewable reports and proposed changes. Low-risk cleanup can later be auto-applied once evals and approvals are reliable.

These jobs are post-Milestone 5 unless a milestone explicitly selects one report-only job. V1.0 does not implement memory maintenance jobs.

## Evaluation

Houge needs mixed evaluation. Deterministic checks should be used when the expected behavior is structural, factual, or safety-related. LLM-as-judge should be reserved for open-ended quality judgments that cannot be reduced to rules.

Eval layers:

- Component Eval: a single agent, tool, parser, or program step behaved correctly.
- Trajectory Eval: the execution path was efficient, authorized, non-repetitive, and aligned with the task contract.
- Task Completion Eval: the final result satisfied the objective and output contract.
- Evolution Eval: a learning artifact improved future behavior compared with a baseline.

V1.0 eval fixtures:

- command parser and typed task event fixtures
- allowlist auth fixtures
- run state transition table
- approval approve, deny, expire, consume, and replay cases
- task contract validation cases
- capability policy matrix
- budget fuse cases
- repeated tool-call trajectory cases
- unsupported final claim cases
- context retrieval budget cases

V1.x eval fixtures add guidebook retrieval before/after cases when Milestone 5 starts.

Eval artifact layout:

```text
evals/
  fixtures/
    typed-task-events/
    run-ledger/
    task-contracts/
    capability-policy/
    context-packs/
  golden-trajectories/
  suites/
    milestone-0.json
    milestone-1.json
    milestone-2.json
```

Eval runner expectations:

- `houge eval milestone-0` runs schema, state machine, idempotency, and policy tests.
- `houge eval milestone-1` adds local run engine, budget fuse, report writer, and read-only capability tests.
- `houge eval milestone-2` adds Telegram trigger parser/auth, notification outbox, approval UX, and replay tests.
- Milestone suites use deterministic fake Trigger, Planner/Agent, Capability, and Notification adapters. Live Pi, Telegram, browser, and web integrations are covered by manual smoke tests until they have stable deterministic harnesses.
- Golden trajectory fixtures are JSONL Run Ledger event sequences.
- Deterministic evals fail the milestone on any failing case.
- LLM-as-judge evals are advisory until a threshold and human calibration set are defined.

Trajectory Eval should detect:

- repeated tool calls with no new information
- steps that ignore the task contract
- unauthorized or unnecessary tool access
- bad agent routing
- budget waste
- missing approval gates
- final claims unsupported by sources or execution logs

Unsupported claim detection should be deterministic in V1.0:

- Final reports must mark factual claims with source IDs, file refs, tool output refs, or run artifact refs.
- The eval runner checks that each cited ref exists in the Run Ledger or artifact index.
- Claims without evidence refs are flagged as unsupported.
- LLM-as-judge can help classify claims later, but V1.0 pass/fail should not depend on it.

Guidebook Eval should compare runs with and without the guidebook when practical:

- task success
- step count
- tool-call count
- elapsed time
- token/cost estimate
- factual correctness
- user acceptance

An accepted guidebook or lesson should remain non-automatic until activation. Activated guidebooks and lessons should stay provisional until later runs show that they help or at least do not hurt.

Golden trajectories should be small JSONL fixtures built from Run Ledger events. They should let tests assert that repeated tool calls, missing approval gates, unsupported claims, and budget fuses are detected without invoking an LLM.

## Observability

Houge should use OpenTelemetry from the beginning.

Trace/span candidates:

- Telegram update received.
- Schedule fired.
- CLI trigger received.
- Command parsed.
- Auth checked.
- Run created.
- Task contract built.
- Budget zone changed.
- Context selected.
- Agent delegated.
- Tool registry decision made.
- Tool called.
- Approval requested.
- Approval resolved.
- Notification queued.
- Notification delivered.
- Notification failed.
- Report written.
- Learning proposal created.
- Guidebook selected or updated.
- Trajectory eval completed.
- Memory update applied.
- Error occurred.

Structured log fields:

- run ID
- trigger source
- command
- user/chat ID hash
- program
- task state
- budget zone
- adapter name
- tool name
- side-effect level
- approval ID
- notification ID
- duration
- token/tool budget usage
- trajectory eval result
- error type

V1.0 can start with logs and traces. A local dashboard can follow once the event model is stable.

## Security and Approval Policy

Default constraints:

- Writes are scoped to `/Users/pluo/Projects/adventure`.
- Filesystem reads and writes are scoped to `/Users/pluo/Projects/adventure` unless an approval explicitly names the out-of-scope path and action.
- Filesystem paths are canonicalized before use. Symlink escapes outside the project folder are denied.
- Secret-like paths and files are deny-by-default for both reads and writes, including `.env*`, private keys, token files, credential stores, browser profiles, and shell history. Secret contents must not be copied into reports, memory, Telegram messages, logs, or traces.
- Generic shell access is out of scope for V1.0 and V1.x.
- Local command capabilities are allowlisted, schema-validated, path-checked, timed, and output-capped.
- Telegram users and chats are allowlisted. V1.0 is single-user: Paco is the only project owner/operator. Telegram intake must bind `from.id` and `chat.id` to that configured identity, require both user and chat matches for group chats, and reject forwarded messages, channel posts, and anonymous admin commands. Before adding additional users, the spec must define roles for private runs, shared learning, and project-owner approvals.
- Schedule definitions are project-local and disabled unless explicitly enabled.
- Secrets are referenced from a secret store or environment, not written into memory. Tool adapters do not inherit ambient secrets by default.
- Web and browser capabilities may access only validated `http` and `https` URLs by default. They deny `file://`, localhost, loopback, link-local, private-network, and metadata-service targets unless a specific approval names the target and reason. Local files, user-scoped memory, private artifacts, and prompt context must not be sent to external services or search queries without approval.
- Gateway intake enforces per-actor and per-chat limits for queued runs, active runs, pending approvals, and command rate. Denied or throttled commands are recorded as gateway audit events.
- Coding-agent CLI adapters are out of scope until process containment exists: cwd jail, environment allowlist, filesystem allowlist, command prefix audit, timeout, output cap, and secret deny-by-default.
- Tool calls go through Capability Runner and Capability Policy before execution.
- MCP tools are imported through Tool Registry with schema validation, whitelists, quotas, policy metadata, and tracing.
- External side effects require approval.
- Destructive local actions require approval.
- Money-moving actions require approval.
- Public submissions, project applications, and account changes require approval.
- Gmail send/reply actions require approval until the program is proven safe.

Approval is deterministic:

```text
/approve <approval-id>
```

The gateway verifies the approval ID, authorized sender, pending action, and current run state. The LLM does not decide whether approval was granted.

### Retention and Redaction

V1.0 retention is conservative and local:

| Artifact class | Retention | Redaction rule |
|----------------|-----------|----------------|
| Telegram raw update references | 30 days | store source ids as hashes where possible; do not store full chat history |
| Run Ledger and state rows | keep until manual cleanup | hash user/chat ids; keep enough evidence for replay |
| Approval records | keep until manual cleanup | store action summaries and hashes, not secrets |
| Reports and run journals | keep until manual cleanup | redact secrets before write |
| Raw artifacts | keep until manual cleanup unless marked sensitive | redact or omit secrets; reference bulky content by path/hash |
| Logs and traces | 30 days by default | no prompt bodies, secrets, or raw Telegram text unless explicitly marked debug |
| Memory artifacts | until superseded, archived, or manually deleted | include provenance, owner, visibility, trust class, and last reviewed date |

Deletion should leave an audit tombstone when it removes an artifact referenced by a ledger event, report, eval, or memory item.

## Implementation Milestones

V1.0 is the Telegram-first local ChatOps loop and covers Milestones 0 through 2. Milestones 3 through 5 are V1.x expansions after the local and Telegram run loops are reliable. Do not land every subsystem in one slice.

### Milestone -1: Runtime and Integration Discovery

- Runtime choice and package scaffold decision.
- Pi and `pi-chat` availability: locate the local checkout or decide to defer Pi integration and use a deterministic minimal runtime for V1.0.
- Current validation on 2026-05-25: `pi` CLI 0.75.5 is installed at `/opt/homebrew/bin/pi`. `pi-chat` was validated from `https://github.com/earendil-works/pi-chat` using project-local install, but it added about 218 MB under `.pi/` and was removed from the project folder after validation.
- V1.0 must not depend on adapting `pi-chat` until its account/channel model, Telegram path, Gondolin VM behavior, dependency footprint, and storage layout are reviewed against Houge's project-scope rules. Start with a deterministic minimal runtime and fake planner/agent adapter.
- Do not install `pi-chat` globally for Houge by default. Global installation would make Houge depend on mutable machine-level Pi package state. If a later spike needs `pi-chat`, install it project-locally with `pi install -l https://github.com/earendil-works/pi-chat`, verify behavior, then remove it unless the milestone explicitly accepts the dependency.
- The installed Pi CLI attempts to use `~/.pi/agent` by default. Future Pi commands for this project should set `PI_CODING_AGENT_DIR=/Users/pluo/Projects/adventure/.pi/agent`, set project-local session paths, or run with `--no-session`, so they do not write outside `/Users/pluo/Projects/adventure`.
- Pi runtime boundary: identify the smallest Pi package/API that can execute a bounded task with controlled tools and return structured output.
- First read-only capability choice: web research or local file read.
- Telegram strategy: confirm whether to adapt `pi-chat` or build a minimal Telegram gateway around Pi.
- Tool Registry implementation direction: Houge-native registry, Pi extension wrapper, or thin hybrid.
- Local test strategy with deterministic fake trigger, planner/agent, capability, and notification adapters.

### Milestone 0: Shared Schemas and State Machines

- Git repository initialization if the project is still not a git repo.
- Test framework and commands.
- SQLite and migration approach.
- Fixture layout under `evals/`.
- Local development commands for typecheck, test, and eval.
- `TypedTaskEvent` schema with idempotency key.
- `Run` state machine and terminal states.
- `Approval` state machine and replay rules.
- `ToolCall` state machine.
- `Schedule` state machine.
- Task Contract schema and validation.
- Tool metadata schema.
- Minimal Capability Policy decision table and matrix tests.
- Run Ledger event taxonomy and envelope schema.
- Unit tests for all state transitions and validation rules.
- Milestone 0 eval suite and fixture loader.

### Milestone 1: Local Run Engine

- CLI trigger only.
- `/run research-brief <goal>` equivalent through local command.
- SQLite run state and Run Ledger.
- Single-worker claim and lease path with stuck-run recovery tests.
- Task contract creation and validation.
- Minimal Capability Runner, Tool Registry, and policy integration.
- One read-only capability: web research or local file read, selected after Pi discovery.
- Report writer under `runs/`.
- Budget ledger with hard caps.
- Minimal context selector with core identity, task contract, selected program, and no Memory Catalog dependency.
- No live approval channel yet. If Capability Policy returns `requires_approval`, Milestone 1 real runs record a deterministic denied result and report the blocked action. Approval transitions may be simulated only in unit/eval fixtures.
- Milestone 1 approval fixtures must still test `waiting_for_approval -> queued`, lease release, approval expiry, replay rejection, and revalidation denial. Milestone 2 replaces simulated approval input with Telegram `/approve` and `/deny`.
- No Telegram, schedules, generic shell, approvals, durable learning, or guidebooks yet.

### Milestone 2: Telegram Gateway and Approvals

- `TelegramTriggerAdapter` with long polling.
- `TelegramTriggerAdapter` deterministic command parser for `/ask`, `/run`, `/status`, `/approve`, and `/deny`.
- Built-in `ask` program contract and eval fixture proving `/ask` uses the normal Run, TaskContract, CapabilityRunner, and ledger path.
- Gateway `TypedTaskEvent` intake for Telegram-origin events.
- Allowlist-based auth.
- Telegram progress and final report notifications.
- Notification Outbox with local and Telegram adapters.
- Approval requests bound to run state and action fingerprint.
- Delivered as a one-shot poll (`telegram-poll --once`): it completes the full round-trip when invoked. (The continuous, unattended always-on daemon was subsequently delivered in Milestone 3 — see below.)

### Milestone 3: Always-On Service and Schedule Trigger

Turns Houge from a manually-invoked one-shot poll into an unattended, supervised service. The always-on daemon and the scheduler share the same operational model (process supervision, restart, graceful shutdown), so they are grouped here.

**Always-on Telegram daemon — DELIVERED.** `houge telegram-poll` (no `--once`) runs the continuous long-poll loop; see [ADR 0004](../../decisions/0004-long-poll-daemon.md) and [deploy/launchd/README.md](../../../deploy/launchd/README.md).

- ✅ Continuous long-poll loop (`houge telegram-poll`, no `--once`): block on the Telegram `getUpdates` long-poll timeout, process each batch through the existing offset-durable, idempotent Gateway intake, then repeat — so `/ask` is answered automatically within seconds of arrival with no manual poll.
- ✅ Process supervision: a `launchd` user-agent plist (macOS) for auto-start at login and auto-restart on crash, with documented install/uninstall. (Runs the built `node dist/cli.js` directly so SIGTERM reaches the daemon.)
- ✅ Graceful shutdown: finish the in-flight run and flush the notification outbox on `SIGTERM`/`SIGINT` before exit.
- ✅ Single-instance guard (PID lockfile) so two pollers never double-consume updates and trigger a Telegram `getUpdates` 409 conflict.
- ✅ Resilience: exponential backoff on Telegram API errors and rate limits; structured logging; a heartbeat/health signal (last successful poll timestamp, last error) surfaced in `/status`.
- ✅ Reuses the durable `trigger_offsets` table and idempotent intake already built in Milestone 2, so no message is lost or double-processed across restarts.
- ✅ Stays within V1 scope: a single long-poll loop — NOT public webhook hosting and NOT a complex multi-worker queue (both remain out of scope).

**Schedule trigger — PENDING (the remaining M3 piece).** Per the daemon's in-process model, this becomes a tick inside the loop.

- Project-local schedule config.
- Existing scheduler mechanism: `launchd`, system `cron`, or a small Node scheduler library (reuses the daemon's supervision model).
- Schedule trigger emits `TypedTaskEvent` with schedule idempotency key.
- Duplicate schedule firing tests.
- Telegram notification for scheduled run results.

### Milestone 4: Memory and Learning Proposals

- Markdown memory folders.
- Memory Catalog metadata.
- Context Pack output with retrieval reasons and budget accounting.
- `TelegramTriggerAdapter` deterministic command parser for `/teach`.
- Lesson inbox and proposed learning updates.
- Human approval before durable learning is retrieved automatically.
- Evals for accepted-to-activated lesson promotion.

### Milestone 5: Environment Guidebooks

- `explore-environment` program.
- Environment guidebook schema under `wiki/environments/`.
- Guidebooks treated as typed Wiki artifacts in V1.x.
- Before/after guidebook eval for one target environment.
- Maintenance reports for stale or oversized guidebooks.

### V2: Autonomous Repair and Self-Evolution

V2 owns autonomous self-repair and broader self-evolution. V1.0 and V1.x may detect failures, write receipts, propose lessons, and produce human-reviewable improvement plans, but they should not autonomously patch their own runtime or delegate code changes to coding agents.

V2 goals:

- `repair-runtime-error` program: diagnose failed Houge runs from Run Ledger, traces, test output, and local artifacts.
- Governed coding-agent delegation through Capability Runner.
- Deterministic process containment for coding-agent CLIs: cwd jail, environment allowlist, filesystem allowlist, command prefix audit, timeout, output cap, and secret deny-by-default.
- Patch isolation and rollback notes for every repair attempt.
- Diff inspection before accepting a repair: changed files, risk level, forbidden paths, and relation to the failed run.
- Allowlisted test/eval execution with captured output before a repair is considered valid.
- Resume the original task only after the repair passes verification and policy allows continuation.
- Autonomous low-risk artifact improvements only after eval gates prove benefit; high-risk changes still require approval.

V2 success criteria:

- Houge can detect a runtime failure, create a repair sub-run, delegate diagnosis to a contained coding agent, evaluate the proposed patch, run tests/evals, and either keep the patch or roll it back.
- Houge can distinguish self-repair from self-evolution: repair restores expected behavior; evolution changes expected future behavior and must be measured against a baseline.
- Every autonomous repair or evolution leaves a receipt: failure evidence, agent outputs, diff summary, tests/evals, policy decisions, and rollback path.
- Failed repair attempts terminate cleanly without recursive repair loops.

Out of scope for V1.0 and V1.x unless explicitly re-scoped:

- WhatsApp and WeChat.
- Public webhook hosting.
- Building a custom scheduler engine from scratch.
- Generic shell adapter.
- Coding-agent CLI adapters without deterministic process containment.
- Fully automatic external side effects.
- Automatic paid project applications.
- Complex multi-worker queues.
- Full automatic guidebook refresh without review.
- Full OpenClaw-compatible gateway APIs.
- Unreviewed self-modification of durable behavior.
- Autonomous self-repair that patches Houge runtime code.
- Autonomous coding-agent repair loops.

### Pi as Agent Runtime: Inference vs Agentic Modes

Pi serves Houge in two distinct modes, and the boundary between them is a safety boundary, not an implementation detail.

- **Inference mode (V1, shipped):** Pi is invoked single-shot with tools disabled (`--no-tools`), no session, no context files, the prompt delivered on stdin under an environment allowlist with an authoritative timeout. This is a pure prompt-to-text call, classified `external_read` and run ungated. The `/ask` capability uses this mode through the LLM provider chain.
- **Agentic mode (V2):** Pi is invoked with a Houge-approved subset of its tools enabled. This is the `coding_agent_cli` category and stays denied until V2 deterministic containment exists (cwd jail, environment allowlist, filesystem allowlist, command prefix audit, timeout, output cap, secret deny-by-default).

Governing principle: **Houge governs Pi's extension surface; it does not replace it.** Pi is an open, extensible agent (built-in tools, skills, extensions, plugins, `pi install`). Houge harnesses that ecosystem rather than rebuilding it: the Tool Registry and Capability Policy decide which of Pi's tools/skills are reachable per run, Pi runs contained, and every tool call and side effect flows through Capability Runner and the Run Ledger. Pi's own flags are the control surface Houge drives — `--no-tools`, `--tools <allowlist>`, `--extension`/`--no-extensions`. The underlying model/agent is a swappable implementation behind the capability seam; the harness's control, audit, budget, and approval guarantees are identical regardless of which agent is underneath.

### Beyond V2: Governed Self-Extension

A later track, building on V2 containment, lets Houge acquire and use new capabilities at runtime — under harness control. It is sequenced as a ladder so each rung has its own gate; Houge never jumps straight to a self-installing agent.

1. **Agentic Pi with a curated, contained toolset.** V2 containment plus a Houge-vetted `--tools` allowlist — the bridge from inference to governed action.
2. **Tool Registry as the Pi tool/skill catalog.** Houge exposes a fixed, vetted set of fundamental tools/skills to Pi by policy; Pi may use only what the Registry and Capability Policy allow.
3. **`agent-browser` capability.** A governed browser tool for discovery and research, on the same seam (a browser is itself a powerful, gated capability).
4. **Governed self-extension (the new frontier).** A `find-skills` discovery-and-install loop that lets Houge add new Pi skills/extensions. This is the highest-risk capability Houge can have: installing a third-party skill is *running third-party code* — strictly more dangerous than modifying Houge's own code. It requires, at minimum:
   - **Trust and provenance:** an allowlist of sources, pinning/signatures, no arbitrary install.
   - **Sandboxed evaluation before activation:** run the candidate contained, on a fixture, and measure.
   - **Approval before activation** plus an **eval gate** — a skill becomes active only after it demonstrably helps. This mirrors the lesson lifecycle (proposed → accepted → eval-gated → activated → measured → keep or rollback), applied to capabilities rather than knowledge.
   - **Containment at use time** (the V2 list) and full Run Ledger receipts for discovery, install, activation, and rollback.
5. **Self-evolution.** Houge improves its own programs, skills, wiki, and code, measured against a baseline (the V2 self-evolution goals).

**The first, safest self-evolution target is persona-voice** (tone/character/mood), gated by the learning lifecycle — lowest-risk and highest-feedback, it proves the self-evolution loop before it touches code or capabilities. But identity obeys the **紧箍咒 rule** ([ADR 0005](../../decisions/0005-agent-memory-architecture.md)): the voice may evolve; the **constitution** (accuracy/honesty, safety boundaries, operating rules in `memory/core/houge.md`) is immutable and never self-edited — no rung of this ladder may weaken it.

This track requires a dedicated security review (`/cso`) before implementation: dynamic third-party-code installation is the largest attack surface Houge would ever expose, and the supply-chain, trust, and sandboxing requirements above are the gate, not a nice-to-have.

Out of scope until this track is explicitly designed and reviewed: arbitrary or unpinned skill/plugin installation, running unreviewed third-party skills, and any self-extension that bypasses the Capability Runner, approval, and eval gates.

## Success Criteria

V1.0 is successful when:

- The project has a runtime scaffold, test command, eval command, SQLite migration approach, and git repository metadata.
- Milestone 0 state machine and schema tests pass.
- A local CLI-triggered `research-brief` run creates a task contract, run record, ledger, and report under `runs/`.
- Duplicate trigger events do not create duplicate runs.
- Tool policy can allow, deny, and require approval in deterministic tests.
- Budget fuse behavior stops work and writes a partial report.
- A Telegram allowlisted user can run `/ask` and receive a response after Milestone 2.
- A Telegram allowlisted user can run `/run research-brief <goal>` after Milestone 2.
- Houge can pause on an approval gate and resume after `/approve` after Milestone 2.
- Telegram approval messages display the exact action summary, side effect level, affected resources, expiry, and consequences.
- Logs or traces show command handling, run execution, tool registry decisions, budget zones, and delegation boundaries.

V1.x expansion success criteria:

- A project-local schedule can trigger the same `research-brief` run flow and notify Telegram after Milestone 3.
- Proposed learning is stored with provenance after Milestone 4.
- Activated learning is retrieved by a later matching run after Milestone 4.
- A Telegram allowlisted user can run `/run explore-environment <target>` and produce a compact guidebook after Milestone 5.
- Houge loads a matching guidebook on a later task against the same environment after Milestone 5.

## Implementation Discovery Questions

These questions should be answered in Milestone -1 by inspecting Pi and, only if needed, temporarily installing or inspecting `pi-chat` from its source:

- Gateway starting point: adapt `pi-chat` if its Telegram/session model can be kept project-scoped and simple; otherwise build a minimal Telegram gateway around Pi.
- Schedule mechanism: choose `launchd`, system `cron`, or a small Node scheduler library for Milestone 3 rather than writing a scheduler engine.
- Pi runtime boundary: identify the smallest Pi package/API that can execute a bounded task with tools and return structured output.
- Tool Registry implementation: decide whether to model tools as Pi extensions, Houge-native registry entries, or a thin wrapper over both.
- Message storage: store command/run state in SQLite and write human-readable summaries into run journals; avoid storing full Telegram history as prompt memory.
- Dashboard stack: start with OpenTelemetry logs/traces only; choose a local dashboard after the event model is stable.
- First non-Pi coding agent adapter: define process containment first, then choose the adapter with the most reliable local CLI behavior after the Pi path works.
- Guidebook evaluation: define the first small before/after benchmark for `research-brief` or `explore-environment`.

## What Already Exists

The project currently contains design artifacts, project guidance, domain context, README dependency notes, and ignore rules. There is no runtime, package manifest, test framework, local Pi checkout, local `pi-chat` checkout, or git repository metadata in `/Users/pluo/Projects/adventure`.

Existing assets to reuse:

- `AGENTS.md`: project safety and workflow rules.
- `README.md`: current phase and dependency guidance.
- `.gitignore`: generated dependency/cache paths such as `.pi/`, `runs/`, `artifacts/`, and `node_modules/`.
- `CONTEXT.md`: Houge domain language.
- This design spec: current product and architecture source of truth.
- Installed agent skills and tools outside the project folder, including Codex skills and `dev-browser`, subject to project-scope approval rules.

Implementation should not assume existing app infrastructure.

## NOT in Scope

Deferred intentionally:

- WhatsApp and WeChat: higher integration risk than Telegram.
- Public webhooks: long polling keeps V1.0 and V1.x local and avoids public exposure.
- Custom scheduler engine: use `launchd`, cron, or a small library.
- Generic shell adapter: too easy to bypass project-scope and secret rules.
- Gmail send/reply: external side effect until approvals and evals are proven.
- Paid project applications: high-impact external action.
- Multi-worker queue: not needed until the single local worker is reliable.
- Full automatic guidebook refresh: learning changes must stay reviewable early.
- OpenClaw-compatible gateway APIs: useful later, not required for first Houge loop.

## Parallelization Strategy

Do Milestone -1 and Milestone 0 sequentially. The runtime decision and shared schemas/state machines are the coordination point for every later lane.

After Milestone 0:

| Lane | Modules Touched | Depends On |
|------|-----------------|------------|
| A | Trigger adapters, Gateway event intake, Telegram fake client | Milestone 0 |
| B | Run store, Run Ledger, worker leases | Milestone 0 |
| C | Capability Runner, Tool Registry, Capability Policy, read-only capability adapter | Milestone 0 |
| D1 | Minimal context selector, report writer | Milestone 0 |
| D2 | Memory Catalog, Context Pack, learning retrieval | Milestone 1 |
| E | Eval fixtures, golden trajectories, telemetry export | Milestone 0 |

Execution order:

```text
Milestone -1 discovery
-> Milestone 0 sequential
-> launch lanes B, C, D1, E in parallel if using worktrees
-> merge B + C + D1 for local run engine
-> merge A for Telegram
-> launch D2 for memory and learning after local run engine works
-> add schedules after idempotency and worker leases pass tests
```

Conflict flags:

- Lanes B and E both depend on Run Ledger event shape. Keep event taxonomy frozen before splitting.
- Lanes C and D2 both affect Context Pack content when tool results become memory evidence. Coordinate through explicit schemas.
