# omp contract probe and cached version check — design

**Status:** Rev 2, proposed. Design approved in chat by Paco 2026-10-09; Rev 2 closes the spec-review and codex
blockers (§9).
**Governs:** ADR 0028 D1 (omp under profile `houge`, no version pin). Amendment owed on ship.
**Base:** `main@bd01859`, omp 18.7.0 on the mini.

## 1. Problem

The pin to one omp version was removed on 2026-10-07 (Paco: no hard-coded versions). Houge now accepts any omp that
prints a version. Two things follow.

1. **Nothing notices a quiet contract change.** Houge reads omp through a handful of exact shapes: the catalog JSON,
   the start-refusal line `Model "…" not found`, the RPC frames (`ready`, `open_session`, `set_model`,
   `set_thinking_level`, `new_session`, `message_end`, `agent_end`). An upgrade that rewords a refusal or renames a
   field does not crash anything; fallback, attribution or session reset silently stop working. The pin used to force
   a human look at every upgrade; nothing replaced it.
2. **The leftover version check costs ~0.8 s per one-shot call.** `spawnOneShot` (`src/llm/providers/omp.ts:130`)
   runs `omp --version` before every tick, judge, chair, reader and reviewer call (measured 0.76–0.80 s, omp 18.7.0).
   The planner preflight (`planner-supervisor.ts:807`) runs it at every child spawn. Since the unpin its only jobs are
   the `omp_unavailable` incident and the version shown in `houge_status`.

## 2. Decisions (Paco, 2026-10-09)

- D1. A probe checks the contract surface Houge depends on whenever the omp version has no passing probe on record.
- D2. A failed probe **pages and Houge keeps running**: no spawn is blocked, nothing is downgraded.
- D3. The probe makes **one tiny real prompt** on the Tiny role per probe run (flat-rate subscription leg).
- D4. `omp --version` runs once at boot and again only when the omp binary changes on disk. That change is also the
  probe's trigger.

## 3. Version cache — `src/omp/omp-version-cache.ts` (new)

```ts
export interface OmpBinaryFingerprint { path: string; mtimeMs: number; size: number; ino: number }
export interface OmpVersionCache {
  /** The cached ok result while the binary's fingerprint is unchanged; otherwise a fresh check. */
  current(): Promise<OmpCheckResult>;
  /** The last ok version this process saw, or null (houge_status). */
  lastVersion(): string | null;
  /** The one listener, called once per distinct ok version (the probe trigger). Replaces any earlier listener. */
  setNewVersionListener(cb: ((version: string) => void) | null): void;
}
export function createOmpVersionCache(cfg: Pick<OmpConfig, "bin" | "envPassthrough">, deps?: {
  check?: () => Promise<OmpCheckResult>; fingerprint?: () => OmpBinaryFingerprint | null;
}): OmpVersionCache;
/** The process-wide instance for (bin, envPassthrough): every production caller uses it. */
export function sharedOmpVersionCache(cfg: Pick<OmpConfig, "bin" | "envPassthrough">): OmpVersionCache;
```

- **Fingerprint.** Resolve `cfg.bin` as the spawn does: a path containing `/` as given, else the first executable
  match on the `PATH` of `buildChildEnv(cfg.envPassthrough)`. Then `realpathSync` and `statSync` →
  `{path, mtimeMs, size, ino}`. On the mini `omp` is a bun symlink to a self-contained `…/dist/cli.js`; a bun
  install gives it a new mtime and inode (review, verified). Sync, microseconds, no exec. Any fs error → `null`.
- **Hit.** Fingerprint non-null and equal to the cached entry's, cached result ok: return it, no exec.
- **Miss.** No entry, a changed fingerprint, or `null`: run `checkOmpVersionAsync(cfg)`. A failed result is **never
  cached**: the next call checks again, so a repaired omp is seen at once.
- **Single flight per fingerprint.** In-flight checks are keyed by the serialized fingerprint. A call whose
  fingerprint differs from the in-flight one starts its own check; it never receives the old binary's result. Only a
  result whose fingerprint is still the latest seen becomes the cached entry.
- **New version.** When an ok result's version differs from every version this process has seen, the listener is
  called after the result is cached. A listener that throws is caught and logged by code.
- **Sharing.** `sharedOmpVersionCache` keeps one instance per `bin + envPassthrough` key in a module-level map. The
  defaults change at the two chokepoints, so the eight `oneShotAdapter` construction sites, `diff-reviewer.ts:324`,
  the ticks and the CLI one-shots all share it without new wiring:
  - `spawnOneShot`: `deps.versionCheck ?? (() => sharedOmpVersionCache(deps.cfg).current())`.
  - `PlannerSupervisor.preflight()`: `this.d.versionCheck ?? (() => sharedOmpVersionCache(cfg).current())`.
  Injected `versionCheck` hooks keep working unchanged (tests). `onVersionCheck` → `reportOmpCheck` and `versionOk`
  are unchanged, so `omp_unavailable` opens and resolves as today. A CLI process has its own cache (its own process),
  which is correct.
- **Boot.** The daemon, after the store opens and before the first tick, registers the probe runner as the listener
  and awaits `sharedOmpVersionCache(cfg).current()` once (bounded by the check's existing 10 s timeout), passing the
  result to `reportOmpCheck`. A failed boot check opens `omp_unavailable` as any failed check does; boot continues.
- **Status.** `houge_status.omp` reads `sharedOmpVersionCache(cfg).lastVersion()` (the boot check fills it), falling
  back to the supervisor's `ompVersion()`.

## 4. The probe — `src/omp/omp-contract-probe.ts` (new)

```ts
export type ProbeCheckName = "catalog" | "start_refusal" | "session_open" | "pin_refusal" | "effort" | "new_session" | "prompt";
export type ProbeCheckOutcome = "pass" | `fail:${string}` | `inconclusive:${string}` | "skipped";
export interface ProbeResult {
  version: string; result: "pass" | "fail" | "inconclusive"; model: string | null;
  checks: Record<ProbeCheckName, ProbeCheckOutcome>;
  usage: { input_tokens: number; output_tokens: number } | null;
  started_at: string; finished_at: string;
}
export async function runOmpContractProbe(input: {
  cfg: OmpConfig; ctx: PathContext; version: string; model: ModelString | null; signal?: AbortSignal;
  session?: (o: PlannerSessionOptions) => ProbeSessionLike;   // tests inject a fake
  catalog?: () => Promise<CatalogRead>;
}): Promise<ProbeResult>;
```

### 4.1 Checks

Checks run in order. Outcome codes are fixed strings chosen by code; omp's text (stderr, error details, the model's
reply) is never stored, logged or sent.

| # | Check | Pass | Fail code (contract drift) |
|---|---|---|---|
| 1 | `catalog` | `readOmpCatalogResult(cfg)` → `{kind:"ok"}` with ≥1 model | `fail:unparsed` (`{kind:"unparsed"}`: exited 0, `parseOmpCatalog` null or empty) |
| 2 | `start_refusal` | a child started on `houge-probe/no-such-model` exits before `ready` with code `exited:model_missing` | `fail:unclassified` (exited before ready, any other code); `fail:started` (reached `ready`) |
| 3 | `session_open` | a child started on `model` sends `ready`, and `open_session` answers `{resumed: boolean, sessionId: non-empty string}` | `fail:shape` |
| 4 | `pin_refusal` | `set_model` to `houge-probe/no-such-model` rejects with a `PlannerRpcError` that `isModelRefusal` (exported from `planner-supervisor.ts:178`) accepts | `fail:accepted` (succeeded); `fail:unclassified` (rejected otherwise) |
| 5 | `effort` | `setModel(model)` (set_model then set_thinking_level `low`) succeeds **and** a `thinking_level_changed` frame arrives with `thinkingLevel === "low"` | `fail:rejected` (a command failed); `fail:no_frame` (no matching frame within 5 s) |
| 6 | `new_session` | `newSession()` answers with a boolean `cancelled` | `fail:shape` |
| 7 | `prompt` | prompt "Reply with exactly OK." yields a raw `message_end` whose `message` has `role: "assistant"`, string `provider`, `model`, `stopReason`, a `usage` object with numeric `input` and `output`, and non-empty text content; then `agent_end`; within 60 s | `fail:shape` (the frame arrived, a field missing or mistyped) |

Check 5 asserts the frame because live `set_thinking_level "bogus-level"` answers `success: true` (review): success
alone proves nothing. Check 7 validates the raw frame, not `summarizeAssistantMessage`, because that helper turns a
missing or mistyped usage field into zero counts (`omp-frames.ts:23`).

**Inconclusive, not drift:**
- any step's timeout: `inconclusive:timeout`;
- catalog read that did not exit 0: `inconclusive:catalog_unavailable` (`{kind:"unavailable"}`);
- check 3's child exits before `ready` with `exited:model_missing` or a stderr tail `classifyOmpError` reads as
  `quota`, `auth` or `transport`: `inconclusive:start_<kind>`; any other exit before ready: `fail:start` (drift);
- `model` null (the Tiny and Fast candidate lists both empty): `inconclusive:no_model`, checks 2–7 skipped;
- check 7 ends with an error the classifier reads as `quota`, `auth` or `transport`: `inconclusive:provider_<kind>`;
- the stop signal: the run is discarded (§5).

When check 3 does not pass, checks 4–7 are `skipped`. Result: `fail` if any check failed, else `inconclusive` if any
was inconclusive, else `pass`.

### 4.2 Model

`roles.candidates("tiny")[0]`, else `roles.candidates("fast")[0]`, else null (`RoleResolver.candidates`,
`role-resolver.ts:83`; Tiny falls back to its static list, so null needs both lists empty). The start flag
`--thinking` and check 5 use `low`. Today that is `kimi-code/k3`; nothing is hard-coded.

### 4.3 Isolation

Each child is built by `plannerArgs` exactly as the planner's (same argv, profile `houge`, same Seatbelt profile when
`cfg.sandbox`), with these differences only:
- `cwd` = `<data>/omp/workspace/probe-<uuid>`, `sessionDir` = `<data>/omp/sessions/probe-<uuid>`: inside the roots
  the planner Seatbelt profile allows. The daemon tmp root is denied to the sandboxed child (`planner.sb` line 170,
  review), so it is not used. `TMPDIR` stays `childTmpDir(cwd)` as for the planner.
- **No tools.** `PlannerSessionOptions` gains `tools?: "none"`; `plannerArgs` then emits `--no-tools` in place of
  `--tools read,edit,write`. Extensions empty; `bridgeSock` and `bridgeToken` empty strings (verified: `start()`
  works with neither). No tool can run.
- **Quiet errors.** `PlannerSessionOptions` gains `quietRpcErrors?: boolean`; when true, `dispatch` does not
  `console.error` the failed command's detail (`planner-session.ts:150`), so the deliberate pin refusal is not logged.
- A one-line system prompt file `probe-system.md` in `cwd`.
- **Shared setup.** The probe calls the same helpers as the planner preflight before its first child:
  `writeSeatbeltProfiles(ctx)` and a new exported `writeHougeConfigFile(ctx)` extracted from
  `PlannerSupervisor.preparePaths()` (the `HOUGE_CONFIG_YML` write), so a probe run on a fresh boot has both.
- `cwd` and `sessionDir` are removed in a `finally`; each child is stopped with `PlannerSession.stop()` in a `finally`.
  No chat id, no run, no lesson, no bridge.

`model-catalog.ts` gains `readOmpCatalogResult(cfg)` → `{kind:"ok", models} | {kind:"unparsed"} |
{kind:"unavailable", code}`; `readOmpCatalog` becomes a thin wrapper over it (behaviour unchanged).

## 5. Runner — `src/omp/omp-probe-runner.ts` (new)

```ts
export function createOmpProbeRunner(d: {
  store: RunStore; cfg: OmpConfig; ctx: PathContext; roles: Pick<RoleResolver, "candidates">;
  currentVersion: () => string | null; signal: AbortSignal;
  probe?: typeof runOmpContractProbe; now?: () => string;
}): { maybeProbe(version: string): void; probeNow(version: string): Promise<ProbeResult> };
```

- **Trigger.** The daemon sets `sharedOmpVersionCache(cfg).setNewVersionListener(runner.maybeProbe)` before its boot
  check, so the boot's first ok version and every later new version call it.
- **Skip rule.** `maybeProbe(v)` returns at once when a `pass` row exists for `v`. A `fail` or `inconclusive` row does
  not count: the next boot probes again. That re-probes after a Houge-side fix (kickstart) and after a downgrade to a
  version that once failed. Cost while drift persists: one tiny prompt per boot; the open incident keeps it to one
  page.
- **One at a time.** While a probe runs, a later `maybeProbe(v2)` stores `v2` as the pending version (latest wins).
  When the running probe settles, the runner probes the pending version unless the skip rule says otherwise. Within
  one process a version is attempted at most once.
- **Never on a turn's path.** `maybeProbe` starts the work un-awaited and catches everything; a throw is logged as
  `[omp-probe] failed: <error code>` and records nothing. The daemon's stop signal aborts it: children killed, dirs
  removed, no row, no pending run.
- **Record and incident, one transaction.** `store.inTransaction(() => …)` (synchronous) holds:
  1. one ledger event, `event_type: "omp_contract_probe"`, correlation `omp-probe`, actor `system`, payload =
     `ProbeResult` (pattern of `recordModelRolesResolved`, no migration); read back by
     `RunStore.latestOmpProbe(version, {result?})`;
  2. the incident transition, only when `result.version === currentVersion()` at settle time (a late result for an
     older binary records its row and touches no incident):
     - `fail` → `openAlertedIncident(store, {kind: "omp_contract_drift", subject: "omp:<version>", detail: {version,
       failed: {<check>: <code>}}, chat_id: null})`; alerted once while open;
     - `pass` → `resolveOpenIncidents(store, new Set(["omp_contract_drift"]))`;
     - `inconclusive` → no change.
- **Manual.** `houge omp probe` (a new `omp` subcommand in `src/cli.ts`) builds the cfg, ctx and a RoleResolver as the
  daemon does, reads the version through its own cache, runs `probeNow` (skip rule ignored), prints the per-check
  table, records the row and applies the incident rule. Exit 0 pass, 1 fail, 2 inconclusive, 3 omp unavailable.

## 6. Failure modes

| Situation | Behaviour |
|---|---|
| omp missing or not executable | fingerprint null → check → `not_runnable` → `omp_unavailable` (as today); never cached |
| omp upgraded while running | next `current()` sees a new fingerprint → re-check → new version → probe |
| upgrade leaves `cli.js` untouched | missed until the next boot (boot always checks); bun rewrites `cli.js` on install |
| two spawns race a changed binary | single flight per fingerprint: one `--version` per binary |
| drift found | one page, `omp_contract_drift` open, every spawn continues; re-probed each boot until a pass |
| provider rate-limited during check 7 | `inconclusive`, no page, retried next boot |
| omp starts crashing on every real model | check 3 `fail:start` → drift page; planner spawns already page through their own incidents |
| older probe settles after an upgrade | row recorded, incident untouched |
| daemon stops mid-probe | children killed, dirs removed, nothing recorded |
| probe throws | logged by code, nothing recorded, next boot retries |

The probe writes no `llm_audit` rows and spends no budget headroom; its token usage lives in the ledger row only.

## 7. Testing

- **Unit** (`tests/omp/`):
  - cache: hit; miss on each fingerprint field; null fingerprint always checks; failed result never cached; single
    flight per fingerprint, including a fingerprint change while a check is in flight; listener once per version;
    a throwing listener does not break `current()`;
  - `spawnOneShot` and `preflight()` defaults go through the shared cache (no exec on a hit);
  - probe with a fake session for every outcome code in §4.1 and each inconclusive path;
  - `plannerArgs` with `tools: "none"` emits `--no-tools` and not `--tools`; `quietRpcErrors` suppresses the log;
  - `readOmpCatalogResult` three kinds; `readOmpCatalog` unchanged;
  - runner: skip rule (pass skips, fail and inconclusive do not), pending latest-wins, one attempt per version per
    process, row and incident in one transaction, stale-version guard, stop-signal discard;
  - CLI exit codes.
- **Live gate** `scripts/live-gate-omp-probe.mjs`, on a `VACUUM INTO` copy, real omp, sandbox on:
  1. `probeNow` passes, all 7 checks `pass`, one row recorded with usage, no incident open.
  2. `HOUGE_OMP_BIN` → a wrapper that execs the real omp and rewrites `not found` to `is unknown` on stderr:
     `probeNow` returns `fail` with `start_refusal: fail:unclassified`; `omp_contract_drift` open, one outbox page.
     Proves a reworded refusal is caught, not just that a call returned.
  3. Cache through the real defaults: the wrapper (unmodified text) logs each `--version` call. Three `spawnOneShot`
     calls with a bogus-model chain (each fails in ~2 s, no prompt) → 1 `--version`; `touch` the wrapper → the next
     call adds 1.
  PASS requires all three; any other outcome fails the gate.

## 8. Out of scope

Blocking or downgrading on drift; a status field for the probe state (the open `omp_contract_drift` incident already
shows in `houge_status`); the deeper `--smoke` cases (sandbox canaries, shell and tool paths), which stay manual after
an upgrade.

Docs on ship: ADR 0028 amendment + index row; `configuration.md` (`houge omp probe`, `omp_contract_drift`); README
prerequisites; ROADMAP delta; `tasks/todo.md`; `sessions.md`.

## 9. Review log (Rev 1 → Rev 2)

Senior review against live omp 18.7.0 (no prompt sent) and a codex design pass. Confirmed live: the start-refusal line,
bogus `set_model` → model_missing, `open_session`/`new_session` shapes, `setModel` order, `start()` without bridge,
0.76 s per `--version`, the bun fingerprint, the wrapper under Seatbelt.

| Finding | Source | Resolution |
|---|---|---|
| workDir in daemon tmp root is denied by Seatbelt | both | §4.3 paths under `<data>/omp/{workspace,sessions}` |
| `set_thinking_level` accepts any level | review (live) | check 5 asserts the `thinking_level_changed` frame |
| `RoleResolver.resolve` does not exist | both | `candidates()`, §4.2 |
| `isPinRefusal` does not exist | review | export `isModelRefusal` |
| `plannerArgs` always enables tools | both | `tools: "none"` → `--no-tools` |
| catalog null cannot split fail/unavailable | both | `readOmpCatalogResult` |
| unkeyed single flight; dropped pending version | codex | per-fingerprint flight; pending latest-wins |
| no boot check | both | §3 Boot |
| no single owner across 8+ adapter sites | both | shared cache in the two chokepoint defaults |
| summarize turns bad usage into zeros | codex | raw frame validation in check 7 |
| PlannerSession logs pin-refusal detail | codex | `quietRpcErrors` |
| transaction unspecified; stale result clears new drift | codex | §5 one transaction + version guard |
| fail keyed on version blocks re-probe after a fix | review | skip only on `pass` |
| check 3 start failures unspecified | review | §4.1 inconclusive vs `fail:start` |
| gate step 3 spent prompts / didn't prove wiring | both | bogus-model chain through real defaults |
| probe usage unrecorded | review | `usage` in the row |
| `ompProbe` status field duplicates the incident | review | dropped |
| subscriber API | review | single listener |
| runner needs ctx and config file | review | `ctx` input; `writeHougeConfigFile` extracted |
