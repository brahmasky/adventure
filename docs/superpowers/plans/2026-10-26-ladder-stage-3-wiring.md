# Decision ladder stage 3 — wiring slice implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every one of the ten registered stage-3 entries record a decision row at its existing seam, byte-for-byte unchanged behaviour, with the codex-approved handoffs for SSRF, reader family, policy cardinality, and run handoff.

**Architecture:** Each seam gets exactly one wrapper pattern: call decideSync on a folded copy of the seam's raw result, then branch as today on the seam's own raw result. Entries with required handoffs (`tool.policy`, `tool.path`'s reason) amend their registration shape in a small first batch (version 2 entries), message updates settle round-trip. Protected surface (`self-write-guard.ts`) stays untouched; other guarded modules are orchestrator-editable here.

**Tech Stack:** Node + TypeScript, vitest, tsc, codex passes in read-only.

**Spec:** `docs/superpowers/specs/2026-10-26-ladder-stage-3-wiring-design.md`.

## Global Constraints

- Dependencies: {} unchanged; no off switch / flag introduced (R13).
- `src/capabilities/self-write-guard.ts` must not change (zero-line diff enforced in review).
- Approval card text untouched; no new pages; no new incident kind.
- Data changes are additive (entry version bumps, not DB rebuilds beyond existing additive rows).
- Full hermetic suite + `npm run build` + the live-gate script for this slice, plus codex read-only pass on the whole branch.

---

### Task 1: Amend the two entry shapes that need value bodies
**Files:** `src/decisions/entries/tool-path.ts`, `src/decisions/entries/tool-policy.ts`, their tests; `registry.test.ts` policy reasons.
- Bump `TOOL_PATH` input to `{ allowed: boolean; reason?: string }`; rule returns its verdict, with the seam-only reason codes union `missing_path`, `bad_path`, `url_read`, `protected_path`.
- Bump `TOOL_POLICY` input to `{ decision: CapabilityDecision["decision"]; reason?: string }` and verdict set `allowed`, `requires_approval`, `denied`; alwaysRecord true; reasonCodes the six capability reason strings.
- Tests: path allow/blocked with reasons; policy allow and requires_approval/ denied.
- Commit.

### Task 2: Wire `tool.shell_class` at the bridge annotation seam
**Files:** `src/omp/bridge-handler.ts:summaryFor`, test.
- Call decideSync(TOOL_SHELL_CLASS, { command }, ctx) for the row; card label remains from classifyCommand directly.
- Assert nothing flips.

### Task 3: Wire `tool.path` at the gate path seam
**Files:** `src/omp/bridge-handler.ts:pathDenial` + gateDenial missing_path branch.
- Record rows with `denial` actually mapping to union of reasons.

### Task 4: Wire `posture.kill` at both call sites
**Files:** handleCall and gateDenial.

### Task 5: Wire `tool.policy`
**Files:** gateDenial and capability-runner; records verdict from d.decision; alwaysRecord makes a second row only on verdict change (dedup on `(run_id, tool_call_id, entry_id)`). Add capability-runner tests.

### Task 6: Wire `tool.budget`
**Files:** gateDenial + capability-runner + recordInvalid seam.

### Task 7: Wire `tool.manifest`
**Files:** manifestFor; one row per declaration with `run_id: null` and `tool_call_id: manifest:<name>`; recording only.

### Task 8: Wire `tool.wall` + `reader.family`
**Files:** `bridge-handler.ts:render` (bridge) + `lookup-lane.ts readStep/thinFetch`; StrictRead gains reader_collapse from `quarantineExtractStrict`; propagation through `llmToolAdapter`; record only, family verdict per foreign/fallback.

### Task 9: Wire `selfwrite.guard`
**Files:** `core-worker.ts` caller sites (attempt and pre-publish), never the guard file itself.

### Task 10: Wire `fetch.ssrf`
**Files:** `http-fetch.ts` adapter and `capability-runner` invoke three-arg call, plus `core-worker` bridge and lookup lane and `core-worker` loop.

### Task 11: `entryProblems` + registry test, typecheck & build.

### Task 12: Characterization snapshots + row-count verification across seams.

### Task 13: Rollback check (additive).

### Task 14: Live gate script + run git diff / codex pass.

### Task 15: Commit + push + docs sync.

Each task: TDD first, then implement, then tests; commits by name.

Execution note: Implementers must not edit `src/capabilities/self-write-guard.ts`; reviewer checks zero diff.

Approval prompt: "Plan complete and saved. Two execution options: Subagent-Driven (recommended) vs Inline. Which?"