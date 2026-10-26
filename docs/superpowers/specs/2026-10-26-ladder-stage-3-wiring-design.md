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
- `tool.policy` — the `decideCapability` call in `gateDenial`. The registered input shape is **amended in a version bump** from `{ allowed: boolean }` to `{ decision: CapabilityDecision["decision"]; reason?: string }`; the rung maps `decision === "deny" ? "denied" : "allowed"` and returns `d.reason` as `r.reason`. Capability-allowed (including `requires_approval`) is `allowed`. The wrapper keeps the raw `d.decision` driving the branch, never `r.verdict`.
- `tool.budget` — `turn.budget.reserveToolCall()` in `gateDenial` (fs_write branch). Input `{ ok: reserved.ok }`. Still decrement as today; wrap the boolean. `reasonCodes: ["budget_exhausted"]`.
- `tool.manifest` — `manifestFor` runs before an active turn exists. Its rows record with `run_id: null, tool_call_id: null`; per-declaration calls still apply `decideSync(... { include: result }, ctx)` (record only, filter stays authoritative). State the null-run attribution explicitly in the characterisation tests.
- `fetch.ssrf` — promote the context to **required fields on the adapter constructor's `ctx`**: `run_id: () => string | null; tool_call_id: () => string | null; recorder: () => DecisionRecorder`. Production code in `core-worker` constructs the adapter after the first turn is assigned, passing closure-style accessors capturing the **active** turn (`turn.run_id`, `turn.lastToolCallId`) and either `turn.decisionRecorder` or `turn.store`-backed recorder. For unit tests the adapter stays in no-record mode when these are absent. Static `validateFetchTarget` records a blocked verdict up front; if it passes and `fetchUrl` later returns an error beginning `refused:`, record a second blocked verdict before returning. Row-count: one row per refusal type **encountered** (static, then DNS-time), never more. Adapter output text stays identical.
- `tool.wall` — `UNTRUSTED_READ_ENTRIES.has(entry)` lookup in `render` is the single record site; do not also record in the gate path or anywhere else. `decideSync(... { crosses: membership }, ctx)` per call. `stage: post_tool`.
- `reader.family` — **three changes in order**: (a) make `spawnOneShot` return `leg: number | null` in its audit/result; (b) thread it through the successful `LlmResult` in `src/llm/registry.ts`; (c) populate a new `reader_leg: number | null` field on `ExternalReadResult`, recording which leg ran. `render` consumes that field with `{ primary: result.reader_leg === 0 }`. Any invocation where the leg is `null` downgrades to `primary: false`. `stage: post_tool`. `reasonCodes: []`.
- `selfwrite.guard` — at **both** guard invocations in `core-worker.ts` (`guardWorktree` at the attempt step and before publish), plus the raw-`parseDiffRaw` failure path near line 1759: an unreadable or unparsable diff records a blocked verdict whenever safety cannot be established. Fold **`GuardResult.allowed`**. Protected file unchanged.

## 4. Arithmetic and skip behaviour

`shouldRecord` (from `record.ts`) already drops routine rows. This is desired, but every wired seam must expose at least one row on its deny/unusual branch. Do not flip `alwaysRecord` unless debugging shows its absence hurts.

## 5. Invariants

1. Every branch is driven by the pre-`decideSync` predicate result (or its 1:1 verdict mapping), never by `r.verdict` alone.
2. Tests prove unchanged behaviour before and after via the existing seam tests; no new approval card text; no new incident kinds.
3. `self-write-guard.ts` is never edited by this work.
4. `fetch.ssrf` may produce up to two rows per invocation (static, then DNS-time) if both static and DNS-time refusals occur. No other entry may produce more than one row per call.

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