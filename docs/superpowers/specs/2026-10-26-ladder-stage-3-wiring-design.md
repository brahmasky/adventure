# Decision ladder, stage 3 — wiring slice: a decision for every tool and safety floor

- **Date:** 2026-10-26
- **Status:** draft for Paco's review
- **Spec series:** 2026-10-12 decision ladder. Builds on the 2026-10-24 registration slice (10 entries already merged) and closes it by replacing direct branches with `decideSync` at each seam. No behaviour change.

## 1. Goal

Every one of the ten stage-3 entries (`tool.shell_class`, `tool.path`, `selfwrite.guard`, `fetch.ssrf`, `tool.policy`, `tool.manifest`, `tool.budget`, `tool.wall`, `reader.family`, `posture.kill`) records a `decisions` row at its existing seam with today's verdict as rung-1, byte-for-byte. No approval card text, no entry added to a deny list, no new flag, no new surface.

## 2. Decision edge (one pattern, every entry)

1. Run the existing predicate/guard/classifier **unchanged**, producing the same raw result it does today.
2. Fold that result into the entry's input shape (`{ allowed: boolean }`, etc.), call `decideSync(ENTRY, input, ctx)`.
3. **The raw result from step 1 — and only step 1 — drives the seam's branch and its return value.** `r.verdict` records what would have happened; it never replaces today's outcome. This is the correction the wrapper relies on: entries log, they do not decide. `shouldRecord` then applies the rule in `record.ts` (routine verdicts skipped), so routine calls stay quiet; blocked/unusual ones land.
4. Use the recorder already on the turn context (or `storeRecorder`). Open a transaction only where the caller already has one. A failed record must not alter the verdict (the runner already guarantees this; keep the wrapper side-effect-only).
5. Never let the entry's `reason` override the seam's. Where the seam needs a closed reason (gate path), pass the seam's code through as `r.reason` only when it is in the entry's `reasonCodes`; otherwise the seam's code still drives the deny branch while the row carries `null`.

## 3. Seam map

- `tool.shell_class` — `src/omp/bridge-handler.ts:summaryFor`. Input stays `{ command }`; `classifyCommand` remains rung 1 and its result drives the label (`plain` → tool name, otherwise the regular label) exactly as today. `reasonCodes` remains `[]`; the wrapper **does not** pass `r.reason`. The ledger records the class only; the card keeps its current label source. (Resolves the registration-slice Important.)
- `tool.path` — `pathDenial` (+ the branch in `gateDenial`). Registered shape `{raw,home,cwd}` is amended to `{ allowed: denial === null, reason?: string }` in a version-2 entry; the seam owns `gateTargets` + `isDeniedRead`/`isDeniedWrite`, folds its deny code (including `protected_path`, `missing_path`) into `reason`. `reasonCodes` is the fixed union of those codes. Only the record path reads `r.reason`, never the deny.
- `posture.kill` — both `turn.postureOk()` call sites in `bridge-handler.ts`: the bridge-call gate at `handleCall` (~line 259) **and** `gateDenial` (~line 569). Fold `{ armed: posture === null }` independently at each, because they are separate decision surfaces. Wrap both.
- `reader.family` — (consolidated; see the later bullet in §3 for the final six-step path.)
- `tool.budget` — **two seams**: `turn.budget.reserveToolCall()` in `gateDenial` (fs_write branch) **and** `src/capabilities/capability-runner.ts` `execute`'s tool-capacity reserve path. Fold each reserve answer into `{ ok: reserved.ok }`; decrement as today. `reasonCodes: ["budget_exhausted"]`. Raw reserve result always drives; the entry records only.
- `tool.manifest` — `manifestFor` runs before an active turn exists, so `run_id: null` for every row. Per-declaration attribution is carried in `tool_call_id` as the fixed token `manifest:<decl.name>`, a public tool identifier (never a raw config string), allowing omitted tools to be distinguished across rows while all rows share the run `null`. Filter stays authoritative (record only).
- `tool.policy` — wire in **two places** (`gateDenial` and `src/capabilities/capability-runner.ts`). The entry's verdict set is **amended in a version bump** to `["allowed", "requires_approval", "denied"]` (default `allowed`, fail `denied`). Input shape `{ decision: CapabilityDecision["decision"]; reason?: string }`; rung maps exact decision → verdict. `reasonCodes` is the six closed codes mapped from `CapabilityDecision.reason`, enumerated in the plan. The raw `d.decision` drives the branch. **Re-run policy evaluations of the same `tool_call_id` (on approval) record a row only when their verdict differs from any row already recorded for that call; identical verdicts do not add a duplicate.**
- `fetch.ssrf` — **exact handoff:** adapter/context flows as call-time argument. `ToolAdapter`/`CapabilityRunner.execute`/http-fetch adapter all gain `(input, signal, ssrfCtx?)`. Bridge passes `{ run_id: turn.run_id, tool_call_id: req.toolCallId, recorder: turnRecorder(turn) }`; lookup lane passes `{ run_id: LaneInput.run_id, tool_call_id: null, recorder: laneDecisionRecorder(run_id) }` per call in `thinFetch`. Missing `ssrfCtx` (tests) records nothing. Adapter constructor carries no run context. Static `validateFetchTarget` records one blocked verdict on failure; if it passes and `fetchUrl` later returns a `refused:` error, record one blocked verdict on that path; never both. Adapter output unchanged.
- `tool.wall` — `UNTRUSTED_READ_ENTRIES.has(entry)` lookup in `render` is the single **bridge-side** record site. The lookup lane, which never reaches `render`, records the same verdict in `readStep` for every build-in reader invocation (`crosses: true` for its reader set). No other call site records it. `stage: post_tool`.
- `reader.family` — full handoff: (`a`) `spawnOneShot` exposes `leg: number | null`; (`b`) the successful `LlmResult` retains `leg`; (`c`) `llmToolAdapter` keeps it while extracting `ExternalReadResult`; (`d`) `quarantineExtract`, which currently returns only digest/flags/bytes, receives the leg and assigns `ExternalReadResult.reader_leg`; (`e`) on parse failure then retry, use the successful retry's leg. Record the decision **in `render` after quarantine returns and before `renderExternalRead`** (bridge path), and in `lookup lane readStep` after every strict reader result (first, and again on a `thinFetch` second read if it succeeds), (lookup path), with `run_id` from the active invocation and the tool call's id forwarded where one exists; otherwise `null`. Default `reader_leg: null` (recorded as fallback). `{ primary: result.reader_leg === 0 }`. `stage: post_tool`. `reasonCodes: []`.
- `selfwrite.guard` — one record site: `guardWorktree`'s outcome (which already encapsulates an unreadable/unparsable diff as a blocked `GuardResult`). Record once per attempt at that call site; `guardWorktree` before publish uses the same site. Fold **`GuardResult.allowed`**. Protected file unchanged.

## 4. Arithmetic and skip behaviour

`shouldRecord` (from `record.ts`) already drops routine rows. This is desired, but every wired seam must expose at least one row on its deny/unusual branch. Do not flip `alwaysRecord` unless debugging shows its absence hurts.

## 5. Invariants

1. Every branch is driven by the pre-`decideSync` predicate result (or its 1:1 verdict mapping), never by `r.verdict` alone.
2. Tests prove unchanged behaviour before and after via the existing seam tests; no new approval card text; no new incident kinds.
3. `self-write-guard.ts` is never edited by this work.
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
- No flags, no off switch, no protected-file change, no consumer test renamed.
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
