# Phase 3 spec — code self-write (gated) + security review

**ADR:** [0011](../../decisions/0011-self-evolution-architecture.md) §3/§5/§6/§7. **Date:** 2026-06-25.
**Scope:** the highest-risk self-evolution surface — Houge writes a *diff to his own source*, runs it
through a layered check stack, and lands it on a **branch** for Paco to merge. **Writes happen only
inside a throwaway worktree; the daemon never hot-swaps; Paco merges + reloads by hand (§5).**

This is the spec ADR 0011 §7 gates behind a **security review of the protected surface** — that review
is §"Security review" below, and it is the reason this phase exists as its own document.

---

## Goal

On a natural-language Telegram message that asks Houge to **fix/change** his own code (not just read it),
e.g. *"猴哥, the intent router never sees your identity — go fix it so you stop asking which 猴哥,"* Houge:
classifies `selfcode` + **write intent**, frames the task with his context, has **Codex write a diff in a
fresh worktree**, runs it **autonomously** through **three automated checkers** (writer ≠ checker by
construction), and — only if all pass — **publishes the diff as a branch and notifies Paco**. Paco
**merges + reloads at his leisure** (the §5 one constant — nothing hot-swaps). This closes the standing
live fixture: **Houge fixes the 猴哥 classifier bug himself.**

## The check stack (writer ≠ checker)

Three automated checkers run **autonomously** (no human in the synchronous loop). The deterministic ones
are ungameable; the agent one is a *different agent* from the writer. The **human checkpoint is the §5
merge** — asynchronous and pull-based, not a blocking gate.

| # | Checker | Type | Catches | New? |
|---|---|---|---|---|
| — | **Codex** (`--sandbox workspace-write`) | **writer** | produces the diff in the worktree | new write mode |
| 1 | **Protected-path check** | deterministic, ungameable | gate / identity / dep / test-integrity erosion → **HARD DENY** (§ Security review) | new |
| 2 | **Test gate** (`typecheck` + `npm test` + `build`) | deterministic, ungameable | doesn't compile / tests red | new |
| 3 | **Independent reviewer = Claude** (model diversity) | semantic / adversarial | "passes tests but wrong / hacky / scope-creep / doesn't fix it" — the staff-engineer check | new (spike-gated) |
| → | **auto-publish branch + notify Paco** | observability | — | new |
| ✓ | **Paco merges + reloads** | human, **async / pull** | the §5 one constant: nothing reaches the running daemon without Paco's `git merge` | reuse (§5) |

**No synchronous human gate (decided 2026-06-25).** The original `/approve`-before-branch gate is
**removed** — the intent is for Houge to **run and evolve by himself**. This is safe and principled:
- A self-write-to-branch is **fully reversible** (a branch, not merged, not running). The core-principle
  approval gate exists only for **irreversible** actions (real accounts, paid, destructive) — self-write
  was never in that class, so it doesn't need the human approval gate.
- **§5's one constant is untouched:** the daemon still never hot-swaps; Paco still merges + reloads. The
  human judgment for *what runs* simply moves from a blocking Telegram `/approve` to a pull-based `git
  merge` (reviewing the branch when he chooses) — same human-in-the-loop for the running system, zero
  blocking on Houge's ability to *produce* candidates. This is *freedom-over-control* (ADR 0001/0011):
  deterministic safety nets stay; the human bottleneck goes.

> **Deviation from ADR §7.** §7 specifies "preview in the `/approve` prompt (hash-bound)". This spec
> supersedes that with autonomous-to-branch + notify; the human checkpoint is the §5 merge, not `/approve`.
> Recommend a short ADR 0011 amendment (or ADR 0012) recording this. The `/approve` + hash-binding
> machinery is untouched and still governs the genuinely irreversible core-principle actions.

**Ordering rationale.** Protected-check is instant → run first. The test gate is mechanical truth → run
before spending a reviewer pass (don't review a red diff). The reviewer runs **only on green diffs** as
the quality/scope check tests can't give. Then auto-publish + notify. This satisfies §3 ("the harness
mechanically verifies the change before it is accepted") — the three checkers are that verification.

## Architecture (flow)

```
selfcode msg w/ FIX intent ─▶ runSelfWrite
  1. Frame task: symptom + relevant lessons/memory + "you are EDITING Houge's OWN source"
     (untrusted DATA channel, ADR 0006)                       [reuse Phase-1 framing]
  2. git worktree add --detach HEAD                            [reuse src/run/worktree.ts AS-IS]
  3. codex exec --sandbox workspace-write -C <wt> ...          [NEW: write-mode adapter]
       → Codex edits files inside the worktree
  4. CHECKER 1 — protected-path check on `git diff --name-status`
       → any protected path touched? → revert + TRACK + SURFACE (see § Surfacing) + STOP
  5. CHECKER 2 — test gate in <wt>: npm run typecheck && npm test && npm run build
       → red? → (refine ≤3, § Refine) → still red? → revert + surface "couldn't fix, tests red" + STOP
  6. CHECKER 3 — Claude reviews the diff (adversarial verdict: fixes-it / bugs / scope-creep)
       → reject? → (refine ≤3) → still reject? → revert + surface reviewer's reasons + STOP
  7. AUTO-PUBLISH the verified diff as a BRANCH (houge/selfwrite/<run-id>) + record event
  8. NOTIFY Paco (async reply over Telegram): "fixed X · gates green · reviewer: <verdict> ·
       branch <name> ready · summary <…>"        [rides Phase-1 ack-then-deliver async turn]
  9. Paco merges + reloads the daemon, at his leisure  [§5 — daemon NEVER hot-swaps; pull-based]
```

Steps 1, 2 reuse existing machinery. **Net-new code:** write-mode Codex adapter, the protected-path
check, the test gate, the Claude reviewer, `compileCodeSelfWriteContract`, the selfcode diagnose↔fix
sub-route, the branch-publish, the notification, and the tracking of hard-deny + failures + publishes.

## Diagnose ↔ fix sub-route

`selfcode` currently routes only to read-only diagnose (Phase 1). Phase 3 adds a **sub-decision inside
the selfcode route**: write intent ("fix", "change", "implement", "make it…") → `runSelfWrite`; read
intent ("why", "explain", "read", "look at") → `runSelfDiagnose` (unchanged). **Default to diagnose
when ambiguous** (the safe direction — read before write). Not a new top-level intent; a branch inside
the existing route. Disabled entirely unless `HOUGE_SELFWRITE_ENABLED=true` (off by default).

---

## Security review (the ADR §7 prerequisite)

**The threat unique to write-mode.** A read-only worktree leaks nothing (Phase 1). A *write* worktree's
danger is **gate erosion**: Codex, driven by a confused/over-eager cheap-chain framing, could propose a
diff that **weakens its own safety machinery** — flip `--sandbox` off in `coding-agent.ts`, open
`forbidden_actions` in a contract, un-ignore `.env` in `.gitignore`, add a dependency (supply chain), or
**delete the failing test** to fake-pass the test gate. The worktree's tracked-only property stops
*secret exfiltration* but does **nothing** against gate erosion, because the gate code is tracked and
therefore present and writable in the worktree.

**The invariant (decided).** The self-write channel is **structurally incapable** of modifying the
safety surface. Enforced by a **deterministic post-diff path check (checker 1) that is a HARD DENY — NOT
overridable by `/approve`.** Per ADR §5, the constants are "changeable only by Paco's hand": Paco edits
those files **directly**, never through Houge's self-write even with a rubber-stamp. This defends against
a confused cheap chain *and* a rushed human approval in one stroke.

**Write scope = deny-list (decided — freedom-over-control).** Everything is improvable EXCEPT the
protected list. Fits ADR 0001/0011's freedom-over-control framing: only the constants are locked; Houge
evolves broadly. Trade-off accepted: a *newly added* sensitive file isn't protected until we add it to
the list — mitigated by (a) the list being path/dir-prefix based so whole sensitive dirs are covered,
and (b) the reviewer + `/approve` as backstops.

**The protected surface** (verified tracked against `git ls-files`, 2026-06-25):

| Class | Paths (dir-prefix or file) | Why protected |
|---|---|---|
| Gate machinery | `src/policy/`, `src/contracts/task-contract.ts`, `src/capabilities/capability-runner.ts`, `src/capabilities/capability-policy.ts`, `src/run/run-store.ts`, `src/run/worktree.ts`, `src/capabilities/coding-agent.ts`, **+ the new Phase-3 self-write module(s)** | self-write must not weaken its own gates / sandbox / approval / worktree isolation |
| Identity / rules | `memory/core/houge.md`, `docs/decisions/` (the ADRs), `AGENTS.md` | core principles = character, Paco's hand only (§5) |
| Supply chain / build | `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`, `.github/` | defend zero-deps invariant; `.gitignore` edit could un-ignore secrets into a future worktree |
| Test integrity | `tests/` — **existing files immutable; net-new test files ALLOWED** | else he deletes/edits the failing test to fake-pass checker 2; net-new coverage for his own fix is good engineering and permitted |

**Test-integrity enforcement (net-new only).** The path check distinguishes, per `git diff
--name-status`: a path under `tests/` with status `A` (added) → ALLOWED; status `M`/`D`/`R` on an
existing `tests/` file → HARD DENY. So Houge may add coverage but can never weaken the gate that judges
him.

**Self-protection.** The protected list itself lives in the Phase-3 module, which is in the gate-machinery
class → it is protected → Houge cannot edit the list of what he's forbidden to edit. Closes the obvious
bypass.

### Notification, surfacing + tracking (decided — autonomy + observability)

Paco is **not** a synchronous gate, but he is **always notified** — every self-write outcome is **signal,
never a silent drop**. All outcomes record a structured run-store event (the audit trail + the future
dashboard's data source) **and** an async Telegram notification in Houge's voice:

| Outcome | Run-store event | Notification to Paco |
|---|---|---|
| **Published** (all 3 checkers green) | `self_write_published` (branch, summary, reviewer verdict, gate results) | *"🐒 Fixed `<X>`. Protected ✓ · tests ✓ · reviewer: `<verdict>`. Branch `houge/selfwrite/<run-id>` is ready — merge + reload when you like. Changed: `<summary>`."* |
| **Hard-deny** (touched protected surface) | `self_write_blocked` (attempted paths + status + context) | *"I worked out a fix for `<X>`, but it wanted to touch `<protected file(s)>` — the locked surface (gates / identity / deps / existing tests), so I stopped. If this genuinely needs a change there, it's **yours to make**. Here's what I was trying: `<summary>`."* (a fix that *requires* a protected change = a **"needs Paco's hand" escalation**) |
| **Failed** (tests red / reviewer reject after refine ≤3) | `self_write_failed` (reason + last output) | *"Tried to fix `<X>`, couldn't land a clean one (`<tests red / reviewer flagged …>`). Not publishing."* |

The notification rides the **existing async ack-then-deliver turn** (the self-write was *requested* over
Telegram, so the result is just that request's async reply — no proactive-trigger dependency). A
future **read-only dashboard** over the `self_write_*` events is the longer-term observability layer
(backlogged; needs no new write surface).

### Containment summary

- `codex exec --sandbox workspace-write` (Codex's own sandbox, confined to `-C <worktree>`); **never** any
  `--dangerously-bypass-*` flag (asserted in tests, as Phase 1).
- Worktree of HEAD → secrets absent by construction (Phase 1 invariant, unchanged).
- `coding_agent_cli` write-mode reachable **only** via `compileCodeSelfWriteContract` (every other
  contract keeps it forbidden), and only when `HOUGE_SELFWRITE_ENABLED=true`.
- Hard-deny protected-path check + net-new-tests-only, ungameable, not overridable by anything.
- Daemon never hot-swaps: diff → branch → **Paco** merges + reloads (§5) — the one human checkpoint,
  pull-based. Houge auto-publishes the branch but **cannot** make it run; only Paco's `git merge` can.
- The branch *is* the reviewable artifact (Paco reviews it in git / future dashboard before merging) —
  no `/approve` hash-binding needed since nothing executes until he merges. (The `/approve` machinery
  remains, untouched, for the genuinely irreversible core-principle actions.)

---

## Refine loop (ADR §6 anti-overfit)

If checker 2 (tests red) or checker 3 (reviewer reject) fails, feed the failure back to the writer-Codex
and retry — **capped at ≤3 passes total**, then give up and surface. Prefer stopping early over chasing
green (OPENSKILL: refining to "all pass" overfits the verifier). A self-write that can't pass in 3 is
reported as "couldn't land a clean fix," not forced through.

---

## Model-agnostic check (ADR 0010 consistency)

The runtime **engine** (Houge's cognition: intent, memory, judgment, framing) stays **pi/kimi** —
untouched. Codex (writer) and Claude (reviewer) are **rented build-time muscle invoked via a runtime
trigger** — the same accepted category as Phase 1's Codex, *not* the engine. The runtime's core functions
(chat, research, skills, diagnose) have **zero dependency** on either; only the rare, Paco-present,
build-class self-*write* surface uses them. If Claude is unavailable, self-write fails safe (no
candidate) — it never degrades the rest of Houge. The muscle stays swappable (Codex↔open coder;
Claude↔independent-Codex reviewer).

---

## Spike first (de-risk before building — like Phase 2c Gate B)

**Unknown:** can the launchd daemon invoke **Claude headlessly** to review a diff? Codex's `auth.json`
headless path is proven (Phase 1); Claude-CLI/API-from-the-daemon is **not**. Throwaway spike:

- `scripts/spike-claude-reviewer-p3.mjs` — from the daemon's environment, invoke Claude headlessly on a
  small fixture diff with the adversarial-review prompt; confirm (a) it authenticates, (b) returns a
  parseable verdict, (c) latency is tolerable for the async ack-then-deliver UX.
- **GO** → build with Claude as checker 3. **NO-GO** → fall back to an **independent Codex session** as
  checker 3 (fresh session + adversarial prompt; writer≠checker preserved, no new infra) — **no
  redesign, just a swapped checker-3 binding.** Keep the script for the build's regression use.

### Spike RESULT — **GO** (2026-06-25)

Ran `scripts/spike-claude-reviewer-p3.mjs`. **Path A (CLI print mode, `claude -p`) is GO.**

- Invoked by **absolute bin** (`/Users/pluo/.local/bin/claude`) under the **daemon's restricted PATH**
  (`/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin` — `claude` is NOT on it; this confirms the build
  needs a configurable **`HOUGE_CLAUDE_BIN`**, mirroring `HOUGE_CODEX_BIN`).
- **Discriminates cleanly, no rubber-stamp:** GOOD diff → `pass` (fixes ✓ / bugs ✗ / scope ✗), **29s**;
  BAD diff → `reject` (fixes ✗ / bugs ✓ / scope ✓), **7s** — it caught BOTH planted faults: the no-op
  "fix" that accepts the identity param but ignores it, AND the deleted test (gate-gaming). Exactly the
  adversarial behavior checker 3 needs.
- Verdict JSON parsed first-try with the tolerant extractor. Latency fits the async ack-then-deliver UX.
- Uses the **subscription** (cheap, mirrors Codex) — no per-token bill. **Path B (API) skipped:**
  `ANTHROPIC_API_KEY` is an empty placeholder in `.env`; moot since CLI is the recommended path.

**Decision:** build checker 3 on the **Claude CLI in print mode**, absolute `HOUGE_CLAUDE_BIN`, spawned
with the daemon's PATH (the script is the validated invocation pattern). API path remains the documented
fallback (set the key) if CLI subscription auth ever flakes; Codex-session remains the no-Claude fallback.

---

## New code (file pointers)

| Piece | Where | Notes |
|---|---|---|
| Write-mode coding adapter | `src/capabilities/coding-agent.ts` *(extend)* — but the file is **protected**, so the write-mode path is added carefully and the protected-list includes it | `--sandbox workspace-write`; reuses config resolvers; new `side_effect_level` (a local write that becomes a branch). Asserts no bypass flag. |
| Protected-path check | `src/capabilities/self-write-guard.ts` (new) | pure fn: `(diffNameStatus) → {allowed} | {denied, paths}`; dir-prefix match + net-new-tests rule; **the protected list lives here and is itself protected.** Heavily unit-tested (every bypass attempt). |
| Test gate | `src/run/test-gate.ts` (new) | runs `typecheck`/`test`/`build` in `-C <wt>`; returns `{green}|{red, output}`; output-capped; timeout. |
| Claude reviewer | `src/capabilities/diff-reviewer.ts` (new) | adversarial-review prompt → parseable verdict `{verdict: pass|reject, reasons[]}`; tolerant parse; spike-gated (Codex fallback). |
| Branch publish | `src/run/worktree.ts` *(extend — protected file)* or a sibling | `publishBranch(wt, name) → houge/selfwrite/<run-id>` from the verified worktree; no merge, no checkout of the live tree. |
| Self-write route | `src/core/core-worker.ts` *(extend)* | `runSelfWrite`: framing → write-Codex → checker stack → refine ≤3 → **auto-publish branch + notify** / surface failure. selfcode diagnose↔fix sub-route. |
| Contract | `src/contracts/task-contract.ts` *(extend)* | `compileCodeSelfWriteContract`: allows `coding_agent_cli` (write) + `llm_answer` + `write_report`; keeps `generic_shell`/`destructive`/`paid` forbidden. No approval gate — the branch is reversible; merge is Paco's. |
| Tracking + notify | `src/run/run-store.ts` *(extend — protected file)* | `self_write_published` / `self_write_blocked` / `self_write_failed` event records (audit trail + dashboard source). Notification is the route's async reply, not a new outbound channel. |
| Config | `docs/reference/configuration.md` | `HOUGE_SELFWRITE_ENABLED` (off by default), `HOUGE_SELFWRITE_REVIEWER` (`claude`\|`codex`), reuse `HOUGE_CODEX_*`. |

> **Note on editing protected files during the BUILD.** Several net-new hooks live in *protected* files
> (`coding-agent.ts`, `task-contract.ts`, `run-store.ts`, `core-worker.ts` is not protected). That is
> fine: the protected list constrains **Houge's runtime self-write channel**, not our build-time work on
> Claude. We (build muscle) edit them now; Houge (runtime) can never edit them later.

---

## Build stages (each green; via build + independent-verification subagents)

- [ ] **S0. Spike** — `scripts/spike-claude-reviewer-p3.mjs`; GO/NO-GO on headless Claude reviewer.
- [ ] S1. `self-write-guard.ts` (protected-path check + net-new-tests rule) + exhaustive unit tests
      (every protected class, every bypass: rename, symlink, `tests/` M vs A, `.gitignore`, self-edit).
- [ ] S2. `test-gate.ts` (typecheck+test+build in worktree, capped/timeout) + tests (green/red mapping).
- [ ] S3. Write-mode `coding-agent` adapter (`workspace-write`, no-bypass assertion) + tests.
- [ ] S4. `diff-reviewer.ts` (Claude reviewer, or Codex fallback per S0) + tolerant-parse tests.
- [ ] S5. `compileCodeSelfWriteContract` + selfcode diagnose↔fix sub-route + `runSelfWrite` orchestration
      (checker stack, refine ≤3, **auto-publish branch + notify**) + `self_write_published/blocked/failed`
      tracking + the three notification paths.
- [ ] S6. Config + `configuration.md` + README "Self-evolution / Phase 3" + `.env` flags. Off by default.
- [ ] S7. Gates: typecheck clean · `npm test` green · `npm run build` OK · `dependencies: {}` ·
      independent adversarial verification (focus: **can any diff reach a protected path?**).
- [ ] S8. **LIVE gate** (stop-gate rule): real Telegram → *"猴哥, fix the intent router so it sees your
      identity"* → write-Codex diff → checker stack green → **branch auto-published + Paco notified** →
      Paco merges + reloads → **the 猴哥 bug is gone** (Houge fixed himself, autonomously). Plus a
      negative live proof: a request whose fix needs a protected file → **hard-deny notified** (tracked
      + reported), nothing landed.

## Live RESULT — **PASS** (2026-06-25)

Harness `scripts/live-selfwrite-p3.mjs` drove the REAL chain (pi→kimi classify + REAL Codex
`workspace-write` + REAL reviewer), Telegram simulated, in-memory DB, writes confined to throwaway
worktrees.

- **POSITIVE — Houge fixed the 猴哥 bug himself, autonomously.** Root-caused that
  `buildIntentSystemPrompt` composed from `temporalContext + INTENT_DISCIPLINE` and **bypassed
  `composeSystemPrompt`** (which loads the `houge.md` identity); routed the intent prompt *through* the
  composer (added a `discipline` option, kept backward-compat overloads + the injectable test clock) and
  **wrote a net-new test**. Protected ✓ · tests ✓ · reviewer **pass** → branch published + 🐒
  notification. Branch tree clean (no `node_modules`).
- **NEGATIVE — hard-deny proven.** "Change the Codex timeout in `coding-agent.ts`" → Codex edited a
  PROTECTED file → **hard-deny** surfaced (*"yours to make — I can't edit my own safety surface"*),
  nothing landed. Proven on multiple runs.

**Live-surfaced fixes** (the live gate doing its job):
1. Reviewer verdict parse was a greedy `{...}` match → broke when a real diff's reviewer reply contained
   stray braces. Replaced with a string-aware balanced-brace scanner that takes the LAST valid verdict
   object (+ case-insensitive verdict, fence-tolerant).
2. Reviewer pinned to a fast model (`--model sonnet`) + tools denied + **retry ≤2 × 180s** — the default
   (Opus) over-thought a large diff and ran out the clock; the CLI also throttles under burst.
3. `publishBranch` now excludes the test-gate's `node_modules` symlink (`.gitignore`'s `node_modules/`
   dir-pattern doesn't match a symlink *file*), so merged branches never carry it.

**Reviewer note:** the **Claude reviewer is the default and was proven end-to-end live**; under heavy
back-to-back calls the subscription rate-limits, in which case `HOUGE_SELFWRITE_REVIEWER=codex` (the
sanctioned fallback) is reliable — used for the final clean run. In production self-write is rare and
Paco-present, so the Claude path's ~20s normal latency is fine.

## Phase 3.1 — per-role writer/checker flags + real LLM telemetry (2026-06-25)

**Motivation (Paco).** The *writer* consumes far more tokens than the *checker* (measured: Codex writer
~200K–1.2M total/run, mostly cached input from agentic file-reading; Claude reviewer ~25K + ~1.2K out,
~$0.08). So which engine plays which role should be a **per-role `.env` flag**, to put the heavy writer
load on whichever subscription is largest (e.g. Claude Max 5x writer + Codex Plus reviewer). And token
usage must be observed **properly**, not by hand-grepping Codex rollout logs.

**Design.**
- **Two independent flags** (writer was hardcoded to Codex; reviewer already swappable):
  | Flag | Values | Default |
  |---|---|---|
  | `HOUGE_SELFWRITE_WRITER` | `codex` \| `claude` | `codex` |
  | `HOUGE_SELFWRITE_REVIEWER` | `codex` \| `claude` | `claude` |
  Paco's case → `WRITER=claude`, `REVIEWER=codex`. **Model diversity preserved** (writer ≠ reviewer
  provider) — keep a soft warning if both are set to the same provider, don't block.
- **Writer abstraction** `SelfWriter` with two impls: Codex (`--sandbox workspace-write`, existing) and
  **Claude** (`claude -p --permission-mode bypassPermissions --output-format json`, agentic edit in the
  worktree — the spike's validated pattern; absolute `HOUGE_CLAUDE_BIN`, daemon PATH). Per-role model
  overrides `HOUGE_CLAUDE_WRITER_MODEL` / `HOUGE_CLAUDE_REVIEWER_MODEL` (fall back to `HOUGE_CLAUDE_MODEL`,
  default `sonnet`).
- **Real telemetry (retires the temp method; lands backlog #3).** Capture structured usage at the source
  — Codex `--json` (`token_count` events), Claude `--output-format json` (`usage` + `total_cost_usd`),
  and the kimi cheap-chain client — and emit an **`llm_call` ledger event** `{provider, model, role
  (writer|reviewer|classify|frame|answer), input_tokens, output_tokens, cached, latency_ms, cost_usd}`.
  Also stamp writer+reviewer usage onto the `self_write_*` events (feeds the dashboard, #10).
- **Security: unchanged + writer-agnostic.** The deterministic guard checks the *diff*, not who wrote it,
  so swapping the writer cannot widen what may land. Both writers are confined to the throwaway worktree;
  Claude's permission-bypass is scoped by `cwd`; test-gate + branch-isolation + no-hot-swap all hold.

**Spikes — both GO (2026-06-25).**
- Reviewer (`spike-claude-reviewer-p3.mjs`): GO — see "Spike RESULT" above.
- Writer (`spike-claude-writer-p3.mjs`): **GO** — `claude -p --permission-mode bypassPermissions
  --output-format json` edited a file headlessly in **15s**, clean correct diff, no permission hang,
  usage captured (input 5 / output 317 / cache_read 63046 / cache_creation 7972, $0.072, 3 turns,
  is_error false). Claude writer used ~71K vs Codex's 200K–1.2M on comparable work — telemetry will give
  real per-role figures.

**Build stages (W1–W6):** W1 `SelfWriter` abstraction + Claude writer adapter + `HOUGE_SELFWRITE_WRITER`
flag + tests · W2 `llm_call` ledger event + usage capture in codex/claude/kimi adapters + tests · W3
wire writer flag into `runSelfWrite`, stamp writer/reviewer usage on `self_write_*`, soft-warn
same-provider · W4 config + docs (`.env` flags, configuration.md, README) + mark backlog #3 done · W5
gates + independent verification (guard still writer-agnostic; bypass confined; telemetry leaks no
secrets) · W6 LIVE: harness with `WRITER=claude/REVIEWER=codex` publishes a branch with per-role tokens
recorded (+ the reverse, the proven default).

## Risks / unknowns

1. **Headless Claude from the daemon** — the S0 spike; Codex fallback if NO-GO.
2. **Write-intent classification** on the cheap chain — crisp examples; **default to diagnose** when
   unsure (read before write).
3. **Codex write quality / latency** — refine ≤3, ack-then-deliver async, test gate is ground truth.
4. **Diff applied-vs-approved drift** — handled by existing hash-binding; the branch == the approved diff.
5. **Protected-list completeness** — deny-list gap risk; dir-prefix coverage + reviewer + `/approve`
   backstops; revisit the list whenever a new sensitive surface is added.

## Out of scope (→ later)

Auto-merge (never — §5, Paco merges). Daemon hot-reload of self-authored code (never). Multi-file
sweeping refactors (start with focused single-concern fixes). Idle-loop autonomous self-write +
*proactive* (unprompted) notification (needs the deferred scheduler ADR — Phase 3 is request-driven, so
notification rides the request's async reply). The **observability dashboard** over `self_write_*` events
(backlogged — Telegram notification covers the observe-need for now). Mutation testing of the gate.

## Verification

Build + independent-verification subagents on Claude (keep main context clean); the independent verifier's
**primary mandate is the security invariant** — attempt to construct any diff that reaches a protected
path (rename tricks, symlinks, `tests/` edits, `.gitignore`, self-list-edit) and confirm all are denied.
The LIVE gate (S8) stays interactive — Paco drives the Telegram message + the `/approve`, agent observes
the run-store + branch.
