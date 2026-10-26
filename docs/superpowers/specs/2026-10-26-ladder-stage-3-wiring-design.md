# Decision ladder, stage 3 — wiring slice: a decision for every tool and safety floor

- **Date:** 2026-10-26
- **Status:** draft for Paco's review
- **Spec series:** 2026-10-12 decision ladder. Builds on the 2026-10-24 registration slice (10 entries already merged) and closes it by replacing direct branches with `decideSync` at each seam. No behaviour change.

## 1. Goal

Every one of the ten stage-3 entries (`tool.shell_class`, `tool.path`, `selfwrite.guard`, `fetch.ssrf`, `tool.policy`, `tool.manifest`, `tool.budget`, `tool.wall`, `reader.family`, `posture.kill`) records a `decisions` row at its existing seam with today's verdict as rung-1, byte-for-byte. No approval card text, no entry added to a deny list, no new flag, no new surface.

## 2. Decision edge (one pattern, every entry)

1. Run the existing predicate/guard/classifier **unchanged**, producing the same raw result it does today.
2. Fold that result into the entry's existing input shape (`{ allowed: boolean }`, etc.), call `decideSync(ENTRY, input, ctx)`.
3. Let `r.verdict` drive the branch today's raw result drove. `shouldRecord` applies the rule in `record.ts` (routine verdicts skipped), so routine calls stay quiet; blocked/unusual ones land.
4. Use the recorder already on the turn context (or `storeRecorder`). Open a transaction only where the caller already has one. A failed record must not alter the verdict (the runner already guarantees this; keep the wrapper side-effect-only).
5. Never let the entry's `reason` override the seam's. Where the seam needs a closed reason (gate path), pass the seam's code through as `r.reason` only when it is in the entry's `reasonCodes`; otherwise the seam's code still drives the deny branch while the row carries `null`.

## 3. Seam map

- `tool.shell_class` — `src/omp/bridge-handler.ts:summaryFor`. Input stays `{ command }`; `classifyCommand` remains rung 1 and its result drives the label (`plain` → tool name, otherwise the regular label) exactly as today. `reasonCodes` remains `[]`; the wrapper **does not** pass `r.reason`. The ledger records the class only; the card keeps its current label source. (Resolves the registration-slice Important.)
- `tool.path` — `pathDenial` (+ the branch in `gateDenial`). Input `{ raw, home, cwd }`. `reasonCodes` widens to include `protected_path` so gate denials from `isDeniedRead`/`isDeniedWrite` survive.
- `posture.kill` — `turn.postureOk()` in `gateDenial`. Fold `{ armed: posture === null }`. Wrap only at the one call site.
- `tool.policy` — the `decideCapability` call in `gateDenial`. Input `{ allowed: d.decision !== "deny" }`. Capability-allowed (including `requires_approval`) is `allowed`, since the entry judges capability, not the approval.
- `tool.budget` — `turn.budget.reserveToolCall()` in `gateDenial` (fs_write branch). Input `{ ok: reserved.ok }`. Still decrement as today; wrap the boolean. `reasonCodes: ["budget_exhausted"]`.
- `tool.manifest` — `manifestFor`. Today's filter stays. For **each** declaration run the original `isToolArmed` + allowed-set test, then call `decideSync(... { include: result }, ctx)` only to **record**, returning the original filter result unchanged.
- `fetch.ssrf` — `createHttpFetchAdapter`. Static `validateFetchTarget` first, then a DNS-time refusal if `fetchUrl` returns `refused:`. Record one blocked verdict for each refusal (two rows possible in a rebind case). adapter output text stays identical.
- `tool.wall` — `UNTRUSTED_READ_ENTRIES.has(entry)` lookup in `render`. `decideSync(... { crosses: membership }, ctx)` per call; record only. `stage: post_tool`.
- `reader.family` — `renderExternalRead` per read, with `{ primary: <today's leg is leg 0> }`. Verdict set `["primary", "fallback"]` and input `{ primary: boolean }` (closes the registration ambiguity). `stage: post_tool`. `reasonCodes: []`.
- `selfwrite.guard` — at the `checkSelfWriteDiff` call site in `core-worker.ts`. Input `{ allowed: !GuardResult.blocked }`. The protected file is unchanged; the diff must show zero edits to `src/capabilities/self-write-guard.ts`.

## 4. Arithmetic and skip behaviour

`shouldRecord` (from `record.ts`) already drops routine rows. This is desired, but every wired seam must expose at least one row on its deny/unusual branch. Do not flip `alwaysRecord` unless debugging shows its absence hurts.

## 5. Invariants

1. Every branch is driven by the pre-`decideSync` predicate result (or its 1:1 verdict mapping), never by `r.verdict` alone.
2. Tests prove unchanged behaviour before and after via the existing seam tests; no new approval card text; no new incident kinds.
3. `self-write-guard.ts` is never edited by this work.
4. `fetch.ssrf` may produce two rows per invocation (static and DNS-time). No other entry may.

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