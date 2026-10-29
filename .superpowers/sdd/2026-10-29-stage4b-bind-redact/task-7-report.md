# Task 7 report — differential harness

Commit: see `git log -1` on stage4b ("test(stage4): differential harness — shared API, comparator self-test, coverage pins").

## API as built (scripts/stage4-diff-lib.mjs)
- `DISTS = {new,s3,s4a}` (CLI fills), `CORPORA = []` (CLI fills), `state = {requiredFailures, seq}`
- `async loadDist(dir)` -> {dir, RunStore, CapabilityRunner, decideCapability, classifyCommand, gateTargets, createToolApprovalSink, storeOptionsFor, decideSync, storeRecorder, createSecretBroker}; null for any missing module/export (verified: s3 and s4a report only storeOptionsFor null). Cached per dir.
- `initTemp(keep, base="/tmp")`, `cleanupTemp()`, `mkTemp(name)` — one run root `/tmp/hg-s4d-*`, removed on every exit path unless --keep (extra helpers beyond the brief; needed by the CLI).
- `mkStore(d, kind, path)` ("bare"|"firewall"; new dist via storeOptionsFor(broker, {}), old via {redact}/{}; no path -> openInMemory), `fakeBroker(d)`, `FAKE_VALUES` (extra export), `redactForPrint(s)`, `strip(projection, pair)`, `compare(corpus,item,a,b,pair)`, `requireNew(corpus,item,name,ok,detail)`.
- CLI: scripts/check-ladder-stage4-differential.mjs, args per brief; provenance exit 2; corpus order load -> coverage -> project/compare/required -> self-test; summary line per corpus.
- Stub corpus: 3 classifyCommand items, min.items 3, branch "plain".

## Proofs (full outputs)
1. PASS (exit 0): `PASS stub: 3 items (plain=3); pairs 6; differences 0; required failures 0; self-test ok` / `STAGE 4 DIFFERENTIAL: PASS` (provenance lines: s3 HEAD 548cb87b18d0, s4a HEAD 1451a6611538).
2. min.items=4 (reverted): `FAIL coverage [stub]: 3 items < required 4` / `FAIL stub: ...` / `STAGE 4 DIFFERENTIAL: FAIL`, exit 1.
3. Bad --old-dist-3 /nonexistent/dist: `differential setup error: Error: --old-dist-3 <previous build's dist> is required (no decisions/registry.js at /nonexistent/dist)` + stack, exit 2.
4. Comparator broken (compare made to always return null; reverted): `FAIL comparator self-test [stub]: a planted one-byte divergence was not reported as exactly its own key`, `FAIL stub: ... self-test FAILED`, exit 1. Re-run after revert: PASS exit 0. No /tmp/hg-s4d-* left behind.

## Tests
`npm run typecheck` clean; `npm test`: 409 files, 5788 tests passed. git status clean after commit.

## Deviations / notes
- The self-test mutates the stripped projection (first surviving string field), so a stripped id cannot make it vacuous; it also asserts an unmutated copy compares null.
- strip drops keys: id, ts, timestamp, latency_ms, *_at; arrays elements with entry_id approval.bind/secret.redact are dropped anywhere; tool_/op_ ids mapped to tool#n/op#n by order of appearance per strip call (so a/b sides are mapped independently — pairwise by position). __s3Omit always removed; its listed keys removed only when pair[0]==="s3".
- A projection throw is counted as a difference (FAIL), not a setup error. A `required` that throws is a required failure.
- Proof 4 mutated compare rather than strip (either allowed by the brief).
- --transcripts-dir / --live-db only pass through ctx; unused.

## Fix round 1
All seven findings applied: one failure counter (state.requiredFailures, read by the runner); private items (tag transcript or item.private) print only transcript#<n>, pair and key paths; __s3Omit union of both sides; canonical key-sorted comparison; self-test on the RAW new projection (first surviving string leaf, exactly one path required, no surviving leaf = FAIL); SIGTERM cleanup; explicit exported STRIP_KEYS. strip documents the positional-id limitation.
typecheck clean; npm test 409 files / 5788 tests passed.

### Verbatim proof output
```
=== 1 exit 0
s3  old build: worktree HEAD 548cb87b18d0, registry.js a655b40789a7 (new ddc53eaa67c1)
s4a old build: worktree HEAD 1451a6611538, capability-runner.js f32eee96c108 (new 6d5daed74f91)
PASS stub: 3 items (plain=3); pairs 6; differences 0; required failures 0; self-test ok

STAGE 4 DIFFERENTIAL: PASS
exit 0
=== 2 coverage
s3  old build: worktree HEAD 548cb87b18d0, registry.js a655b40789a7 (new ddc53eaa67c1)
s4a old build: worktree HEAD 1451a6611538, capability-runner.js f32eee96c108 (new 6d5daed74f91)
FAIL coverage [stub]: 3 items < required 4
FAIL stub: 3 items (plain=3); pairs 6; differences 0; required failures 0; self-test ok

STAGE 4 DIFFERENTIAL: FAIL
exit 1
=== 3 bad dist
differential setup error: Error: --old-dist-3 <previous build's dist> is required (no decisions/registry.js at /nonexistent/dist)
exit 2
=== 4 self-test break (compare sees nothing)
s3  old build: worktree HEAD 548cb87b18d0, registry.js a655b40789a7 (new ddc53eaa67c1)
s4a old build: worktree HEAD 1451a6611538, capability-runner.js f32eee96c108 (new 6d5daed74f91)
FAIL comparator self-test [stub]: a planted one-byte divergence was not reported as exactly its own key
FAIL stub: 3 items (plain=3); pairs 6; differences 0; required failures 0; self-test FAILED

STAGE 4 DIFFERENTIAL: FAIL
exit 1
=== 5 requireNew(false) probe
s3  old build: worktree HEAD 548cb87b18d0, registry.js a655b40789a7 (new ddc53eaa67c1)
s4a old build: worktree HEAD 1451a6611538, capability-runner.js f32eee96c108 (new 6d5daed74f91)
FAIL required [stub] stub#1 — probe: x
FAIL required [stub] stub#2 — probe: x
FAIL required [stub] stub#3 — probe: x
FAIL stub: 3 items (plain=3); pairs 6; differences 0; required failures 3; self-test ok

STAGE 4 DIFFERENTIAL: FAIL
exit 1
=== 6 key-reorder probe
reordered keys -> null
changed value  -> {"key":"k","pair":["s4a","new"],"diff":".a: \"x\" != \"y\"","paths":[".a"]}
private item   -> {"key":"transcript#4","pair":["s4a","new"],"diff":".a","paths":[".a"]}
s3Omit one side-> null
=== 7 reverted
s3  old build: worktree HEAD 548cb87b18d0, registry.js a655b40789a7 (new ddc53eaa67c1)
s4a old build: worktree HEAD 1451a6611538, capability-runner.js f32eee96c108 (new 6d5daed74f91)
PASS stub: 3 items (plain=3); pairs 6; differences 0; required failures 0; self-test ok

STAGE 4 DIFFERENTIAL: PASS
exit 0
 M scripts/check-ladder-stage4-differential.mjs
 M scripts/stage4-diff-lib.mjs
```
