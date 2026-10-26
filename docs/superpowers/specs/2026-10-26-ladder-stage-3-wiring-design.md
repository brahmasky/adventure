# Decision ladder, stage 3 — wiring slice: a decision for every tool and safety floor

- **Date:** 2026-10-26
- **Status:** draft for Paco's review
- **Spec series:** 2026-10-12 decision ladder. Builds on the 2026-10-24 registration slice (10 entries already merged) and closes it by replacing direct branches with `decideSync` at each seam. No behaviour change.

## 1. Goal

Every one of the ten stage-3 entries (`tool.shell_class`, `tool.path`, `selfwrite.guard`, `fetch.ssrf`, `tool.policy`, `tool.manifest`, `tool.budget`, `tool.wall`, `reader.family`, `posture.kill`) records a `decisions` row at its existing seam with today's verdict as rung-1, byte-for-byte. No approval card text, no entry added to a deny list, no new flag, no new surface.

## 2. Decision edge (one pattern, every entry)

1. Run the existing predicate/guard/classifier **unchanged**, producing the same raw result it does today.
2. Fold that result into the entry's input shape (`{ allowed: boolean }`, etc.), call `decideSync(ENTRY, input, ctx)`.
3. **The code rule is rung 1, and its verdict (which equals the raw predicate's, because it wraps it) drives the branch.** `r.verdict` is not a second decision; nothing in the wrapper branches on a value different from today's raw result. When a blocked path records only, the raw predicate remains the driver in name; its verdict can be used after `decideSync` returns because it is identical. On `r.rung === "fail"`, fall back to the safest predicate result (see row 5 of invariant 1).
4. Use the recorder already on the turn context (or `storeRecorder`). Open a transaction only where the caller already has one. A failed record must not alter the verdict (the runner already guarantees this; keep the wrapper side-effect-only).
5. Never let the entry's `reason` override the seam's. Where the seam needs a closed reason (gate path), pass the seam's code through as `r.reason` only when it is in the entry's `reasonCodes`; otherwise the seam's code still drives the deny branch while the row carries `null`.

## 3. Seam map

- `tool.shell_class` — `src/omp/bridge-handler.ts:summaryFor`. Input stays `{ command }`; `classifyCommand` remains rung 1 and its result drives the label (`plain` → tool name, otherwise the regular label) exactly as today. `reasonCodes` remains `[]`; the wrapper **does not** pass `r.reason`. The ledger records the class only; the card keeps its current label source. (Resolves the registration-slice Important.)
- `tool.path` — `pathDenial` (+ the branch in `gateDenial`). Registered shape `{raw,home,cwd}` is amended to `{ allowed: denial === null, reason?: string }` in a version-2 entry; the seam owns `gateTargets` + `isDeniedRead`/`isDeniedWrite`, folding its deny code (including `protected_path`, `missing_path`) into `reason`. Where `gatePaths` returns no raw path, record a `missing_path` row before the `pathDenial` loop (matching `handleGate` today). `reasonCodes` is the fixed union of those codes. Only the record path reads `r.reason`, never the deny.
- `posture.kill` — both `turn.postureOk()` call sites in `bridge-handler.ts`: the bridge-call gate at `handleCall` (~line 259) **and** `gateDenial` (~line 569). Fold `{ armed: posture === null }` independently at each, because they are separate decision surfaces. Wrap both.
- `reader.family` — (consolidated; see the later bullet in §3 for the final six-step path.)
- `tool.budget` — **three seams**: `turn.budget.reserveToolCall()` in `gateDenial` (fs_write branch), `src/capabilities/capability-runner.ts` `execute` reserve path, and the `recordInvalid` path (~230) which also decrements. Fold each reserve answer into `{ ok: reserved.ok }`; decrement as today. `reasonCodes: ["budget_exhausted"]`. Raw reserve result always drives.
- `tool.manifest` — `manifestFor` runs before an active turn exists, so `run_id: null` for every row. Per-declaration attribution is carried in `tool_call_id` as the fixed token `manifest:<decl.name>`, a public tool identifier (never a raw config string), allowing omitted tools to be distinguished across rows while all rows share the run `null`. Filter stays authoritative (record only).
- `tool.policy` — close policy reason-code mapping: exact `CapabilityDecision.reason -> tool-policy.reason` table: `"Capability forbidden by task contract" -> forbidden`, `"Coding-agent CLI delegation is not allowed by this task contract" -> coding_agent_cli_not_allowed`, `"Capability not allowed by task contract" -> capability_not_allowed`, `"Capability has gated side effects" -> gated_side_effect`, `"Turn trust asks for a tap" -> trust_ask`, `"Capability allowed by task contract" -> allowed`.
- `tool.policy` — wire in **two places** (`gateDenial` and `src/capabilities/capability-runner.ts`). The entry's verdict set is **amended in a version bump** to `["allowed", "requires_approval", "denied"]` (default `allowed`, fail `denied`). Input shape `{ decision: CapabilityDecision["decision"]; reason?: string }`; rung maps exact decision → verdict. `reasonCodes` is the six closed codes mapped from `CapabilityDecision.reason`, enumerated in the plan. The raw `d.decision` drives the branch. The entry also sets `alwaysRecord: true` so a `requires_approval -> allowed` revalidation still lands despite `allowed` being the default. **Re-run policy evaluations of the same `tool_call_id` (on approval) record only the first time their verdict differs from the **most recent** `tool.policy` row for that call; a later return to that same old verdict records a new row. This preserves the transition as a visible event.**
- `fetch.ssrf` — **exact handoff, three paths:** (`a`) bridge tool call: `httpFetchAdapter(input, signal, ssrfCtx)` with `ssrfCtx = { run_id: turn.run_id, tool_call_id: req.toolCallId, recorder: turnRecorder(turn) }`, forwarded from `CapabilityRunner.execute(input, signal, ssrfCtx)` to the adapter; (`b`) lookup lane `thinFetch`: `httpFetchAdapter(input, signal, { run_id, tool_call_id: null, recorder })`; (`c`) `core-worker` tool-loop wrapper (~3629) also calls adapter with `ssrfCtx` and records. Adapter constructor carries no run context; the adapter itself calls `validateFetchTarget` then `fetchUrl`, recording one verdict on the first refusal (static → no fetch). Missing `ssrfCtx` (unit tests) records nothing. Adapter output unchanged.
- `tool.wall` — `UNTRUSTED_READ_ENTRIES.has(entry)` lookup in `render` is the single **bridge-side** record site. The lookup lane, which never reaches `render`, records the same verdict in `readStep` for every build-in reader invocation (`crosses: true` for its reader set). No other call site records it. `stage: post_tool`.
- (legacy alias note: no `reader_leg` field; family collapse only, as the primary bullet defines.)
- `reader.family` — recorded fact is family separation only (not positional index): verdict `primary` when the successful leg ran in a **different** family from the planner (`family_collapse=false`), verdict `fallback` otherwise (`same` family, or **failure/null → fallback**). Concretely: `ExternalReadResult.reader_collapse?: boolean`; missing means `fallback`. Handoff: (`a`) `spawnOneShot` exposes `family_collapse: boolean` on `LlmResult`; (`b`) `LlmResult` retains it; (`c`) `llmToolAdapter` keeps it; (`d`) `quarantineExtract` receives it and assigns `reader_collapse`; (`e`) on parse-retry, use the successful retry's flag. One row per successful read (first and any thinFetch retry); failures record `fallback`. Record in `render` after quarantine returns (bridge) and in lookup `readStep`/`thinFetch-success` (lookup). `stage: post_tool`. `reasonCodes: []`.
- `selfwrite.guard` — name all three call sites: the attempt start, the post-test-gate `guardWorktree` call, and the pre-publish `guardWorktree` call. Each is recorded at **its caller** (not inside the guard, which has no run id), using `{ run_id, tool_call_id: null, recorder }`. The guard's boolean is the only driver. Protected file untouched.

## 4. Arithmetic and skip behaviour

`shouldRecord` (from `record.ts`) already drops routine rows. This is desired, but every wired seam must expose at least one row on its deny/unusual branch. Do not flip `alwaysRecord` unless debugging shows its absence hurts.

## 5. Invariants

1. **ADR 0030 contract:** the code rule is rung 1 and `r.verdict` is what decides; because the rung wraps the exact predicate, its result is byte-for-byte today's. The seam acts on `r.verdict`. On a rule failure (`r.rung === "fail"`), preserve the safest existing behaviour: `tool.path`/`fetch.ssrf`→blocked, `tool.policy`→deny, `tool.budget`→exceeded, `tool.wall`→crosses, `reader.family`→fallback, `posture.kill`→killed. Failure is detected via `r.rung === "fail"`, not a property on the result.
2. Tests prove unchanged behaviour before and after via the existing seam tests; no new approval card text; no new incident kinds. `tool.policy` is exempt from the zero-routine-row rule (its entry is `alwaysRecord`), and its test proves a changed revalidation verdict records while an identical one does not.
3. No-protected-file gate applies to `src/capabilities/self-write-guard.ts` only (never edited here). Other guarded files under `src/decisions/` change here with attribution, per orchestrator rights.
4. `fetch.ssrf` produces at most one row per invocation: static-target refusal first, else DNS-time refusal. The adapter returns on the first refusal, so the two static and DNS paths never both fire. Adapter-level shape validation (empty URL etc.) does NOT record an `fetch.ssrf` row; it remains a shape error.
5. `tool.policy` (only entry) may produce a second row for the **same `tool_call_id`** when the second pass (on approval) yields a different verdict than the first; identical verdicts dedup. Every other entry may produce at most one row per call.

## 6. Migration and rollback

Additive. Revert + rebuild + kickstart remains rollback (R13). No new table or column.

## 7. Tests

For each wired seam:
- existing seam tests still pass;
- one added test per seam asserts (a) unchanged branch on a matrix of cases, (b) `storeRecorder` writes a row on the deny/unusual branch with `entry_id`, `verdict`, and `rung: "rule"`, and zero rows on the routine branch for the same input.

`registry.test.ts` and `entryProblems` (all 18) must be empty.

## 8. Gates

- `npm run typecheck && npm test && npm run build` green.
- `entryProblems == []` for all 18.
- At least one integration test per wired seam produces a row on the deny path.
- No flags, no off switch, no edit to `src/capabilities/self-write-guard.ts`, no consumer test renamed. (Other files under `src/decisions/` may vary.)
- Re-run the additive-only rollback check.
- New `scripts/live-gate-ladder-stage3-wired.mjs` proving one recorded row per entry and behaviour unchanged.

## 9. Success criteria

- Every wired seam's row appears in `decisions` on its deny/unusual branch; approval cards and outputs are byte-identical.
- `entryProblems` (all 18) = [].
- Stage 3 (registration + wiring) complete; ready for decision-tree stage C / SP2.

## 10. Not in this slice

- Jev/model rungs on any stage-3 entry (own spec).
- Any change to approval card wording, new incident kinds, or privileged-path loosening.
- Consumer discovery for a seam that turns out better left seam-only; if so, the plan folds it into a later task rather than drop evidence.

Spec self-review: scope matches registration contract extended to wiring; shell-class Important resolved (keep `classifyCommand` as card-label source; ledger records only the class); open plan item — add the policy reason strings to `tool.policy.reasonCodes` from `CapabilityDecision.reason`. Only open turn is confirming before plan.
