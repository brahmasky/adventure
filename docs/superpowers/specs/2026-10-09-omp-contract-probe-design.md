# omp contract probe and cached version check — design

**Status:** proposed (design approved in chat by Paco 2026-10-09; spec review pending)
**Governs:** ADR 0028 D1 (omp under profile `houge`, no version pin). Amendment owed on ship.
**Base:** `main@c6d8395`, omp 18.7.0 on the mini.

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

- D1. A probe runs once per new omp version and checks the contract surface Houge depends on.
- D2. A failed probe **pages and Houge keeps running**: no spawn is blocked, nothing is downgraded.
- D3. The probe makes **one tiny real prompt** on the Tiny role per new version (flat-rate subscription leg).
- D4. `omp --version` runs once at boot and again only when the omp binary changes on disk. That change is also the
  probe's trigger.

## 3. Components

### 3.1 `src/omp/omp-version-cache.ts` (new): one check per binary

One instance per daemon process, shared by the planner supervisors and every one-shot call site.

```ts
export interface OmpBinaryFingerprint { path: string; mtimeMs: number; size: number; ino: number }
export interface OmpVersionCache {
  /** The cached result while the binary's fingerprint is unchanged; otherwise a fresh checkOmpVersionAsync. */
  current(): Promise<OmpCheckResult>;
  /** The last ok version, or null before the first passing check (houge_status). */
  lastVersion(): string | null;
  /** Called once per distinct ok version this process sees (the probe trigger). */
  onNewVersion(cb: (version: string) => void): void;
}
export function createOmpVersionCache(cfg: Pick<OmpConfig, "bin" | "envPassthrough">, deps?: {
  check?: () => Promise<OmpCheckResult>; fingerprint?: () => OmpBinaryFingerprint | null;
}): OmpVersionCache;
```

- **Fingerprint.** Resolve `cfg.bin` the way the spawn does: an absolute or slashed path as given, else the first
  executable match on the `PATH` of `buildChildEnv(cfg.envPassthrough)`. Then `realpathSync` (on the mini `omp` is a
  bun symlink to `…/@oh-my-pi/pi-coding-agent/dist/cli.js`) and `statSync`: `{path, mtimeMs, size, ino}`. Sync
  stat, microseconds, no exec.
- **Hit.** Same fingerprint as the cached entry and the cached result was ok: return it, no exec.
- **Miss.** No entry, a changed fingerprint, or an unresolvable binary (`null` fingerprint): run
  `checkOmpVersionAsync`. A failed result is **never cached**, so the next call checks again and a repaired omp is
  seen at once.
- **Single flight.** Concurrent `current()` calls during a check share one promise.
- **New version.** When an ok result's version differs from every version this process has seen, fire
  `onNewVersion(version)` after the result is cached. The first ok result at boot fires it.

The callers keep their present contract: `OmpCheckResult` in, the same incidents out.
- `PlannerSupervisor.preflight()` takes `versionCheck` defaulting to `cache.current()` (its injected test hook stays).
- `spawnOneShot` gets `deps.versionCheck = () => cache.current()` from the registry and from `diff-reviewer.ts`.
  `onVersionCheck` → `reportOmpCheck` is unchanged, so `omp_unavailable` opens and resolves as today.
- `PlannerSupervisor.checkedVersion` stays (per child, set from the result); `houge_status.omp` reads
  `cache.lastVersion()` so it shows a version before any planner started.

### 3.2 `src/omp/omp-contract-probe.ts` (new): the checks

```ts
export type ProbeCheckName = "catalog" | "start_refusal" | "session_open" | "pin_refusal" | "effort" | "new_session" | "prompt";
export type ProbeCheckOutcome = "pass" | `fail:${string}` | `inconclusive:${string}` | "skipped";
export interface ProbeResult {
  version: string; result: "pass" | "fail" | "inconclusive"; model: string | null;
  checks: Record<ProbeCheckName, ProbeCheckOutcome>; started_at: string; finished_at: string;
}
export async function runOmpContractProbe(input: {
  cfg: OmpConfig; version: string; model: ModelString | null; workDir: string; signal?: AbortSignal;
  session?: (o: PlannerSessionOptions) => ProbeSessionLike;   // tests inject a fake
  catalog?: () => Promise<CatalogModel[] | null>;
}): Promise<ProbeResult>;
```

Checks run in this order. Outcome codes are fixed strings chosen by code; omp's own text (stderr, error messages,
the model's reply) is never stored, logged or sent.

| # | Check | Pass | Fail code (contract drift) |
|---|---|---|---|
| 1 | `catalog` | `readOmpCatalog(cfg)` returns ≥1 model | `fail:unparsed` (exited 0, `parseOmpCatalog` → null or empty) |
| 2 | `start_refusal` | a child started on the bogus model `houge-probe/no-such-model` exits before `ready` with code `exited:model_missing` | `fail:unclassified` (exited before ready, any other code); `fail:started` (reached `ready`) |
| 3 | `session_open` | a child started on `model` sends `ready`, and `open_session` answers `{resumed: boolean, sessionId: non-empty string}` | `fail:shape` |
| 4 | `pin_refusal` | `set_model` to `houge-probe/no-such-model` rejects with a `PlannerRpcError` the supervisor's `isPinRefusal` accepts | `fail:accepted` (succeeded); `fail:unclassified` (rejected otherwise) |
| 5 | `effort` | `set_model` back to `model` with thinking `low` succeeds (both commands) | `fail:rejected` |
| 6 | `new_session` | `newSession()` answers with a boolean `cancelled` | `fail:shape` |
| 7 | `prompt` | prompt "Reply with exactly OK." yields a `message_end` that `summarizeAssistantMessage` parses with non-empty `provider`, `model`, `usage` and a `stopReason`, then `agent_end`, within 60 s | `fail:shape` (frame arrived, field missing) |

**Inconclusive, not drift:** a timeout on any step (`inconclusive:timeout`); a catalog read that did not exit 0
(`inconclusive:catalog_unavailable`); `model` null because the Tiny role and the Fast role both resolve to nothing
(`inconclusive:no_model`, checks 2–7 skipped); a prompt that ends with an error classified `quota`, `auth` or
`transport` by `classifyOmpError` (`inconclusive:provider_<kind>`); the stop signal (the run is discarded, §3.3).

When check 3 does not pass, checks 4–7 are `skipped`. Result: `fail` if any check failed, else `inconclusive` if any
was inconclusive, else `pass`.

**Model.** The first candidate of `RoleResolver.resolve("tiny")`, else of `"fast"`. The probe passes its effort as
the `--thinking` start flag and in check 5. Today that is `kimi-code/k3:low`; nothing is hard-coded.

**Isolation.** Each child is built by `plannerArgs` exactly as the planner's (same argv, profile `houge`, same
Seatbelt profile when `cfg.sandbox`), with these differences only: `sessionDir` and `cwd` under a fresh
`workDir` = `<daemon tmp root>/omp-probe-<uuid>`; extensions empty (the bridge is not started; no tool can run);
a one-line probe system prompt file in `workDir`. `workDir` is removed in a `finally`. Each child is stopped with
`PlannerSession.stop()` (process-group kill) in a `finally`. No chat id, no run, no lesson, no bridge token.

### 3.3 `src/omp/omp-probe-runner.ts` (new): when it runs and what it records

```ts
export function createOmpProbeRunner(d: {
  store: RunStore; cfg: OmpConfig; roles: Pick<RoleResolver, "resolve">; signal: AbortSignal;
  probe?: typeof runOmpContractProbe; now?: () => string;
}): { maybeProbe(version: string): void; probeNow(version: string): Promise<ProbeResult> };
```

- **Trigger.** The daemon wires `cache.onNewVersion(runner.maybeProbe)`. The boot's first passing version check
  fires it; so does the first check after an upgrade.
- **Skip rule.** `maybeProbe` returns at once when a `pass` or `fail` row exists for this version, when a probe is in
  flight, or when this process already attempted this version. An `inconclusive` row does not count, so the next
  boot tries again.
- **Never on a turn's path.** `maybeProbe` starts the probe un-awaited and catches everything; a thrown error is
  logged as `[omp-probe] failed: <code>` and records nothing. The daemon's stop signal aborts it: children are
  killed, `workDir` removed, **no row recorded**.
- **Record.** One ledger event per finished probe, `event_type: "omp_contract_probe"`, correlation `omp-probe`,
  actor `system`, payload = `ProbeResult`. Same store pattern as `recordModelRolesResolved`; no migration.
  `RunStore.latestOmpProbe(version)` reads it back.
- **Incident.** In the same transaction as the row:
  - `fail` → `openAlertedIncident(store, {kind: "omp_contract_drift", subject: "omp:<version>", detail: {version,
    failed: {<check>: <code>}}, chat_id: null})`. Alerted once; the open incident is the throttle.
  - `pass` → `resolveOpenIncidents(store, {"omp_contract_drift"})`: a newer version that passes clears an older drift.
  - `inconclusive` → no incident change.
- **Manual.** `houge omp probe` (new `omp` subcommand in `src/cli.ts`) runs `probeNow` against the cwd's
  `houge.sqlite`, ignoring the skip rule, prints the per-check table, records the row and applies the incident rule.
  Exit code 0 on pass, 1 on fail, 2 on inconclusive.

### 3.4 Status

`HougeStatusInput` gains `ompProbe: "known_good" | "drift" | "pending" | "inconclusive" | null`, from
`latestOmpProbe(cache.lastVersion())`: pass → known_good, fail → drift, inconclusive → inconclusive, no row → pending,
no version → null. `omp` keeps its type and now comes from the cache.

## 4. Failure modes

| Situation | Behaviour |
|---|---|
| omp missing or not executable | fingerprint null → check runs → `not_runnable` → `omp_unavailable` (as today); not cached, re-checked per call |
| omp upgraded while running | next `current()` sees a new fingerprint → re-check → new version → probe |
| upgrade changes files but not `cli.js` | missed until the next boot (boot always checks). Accepted: bun replaces the package dir |
| two spawns race a changed binary | single flight: one `--version` |
| probe drift found | one page, `omp_contract_drift` open, all spawns continue; `houge_status` shows `drift` |
| provider rate-limited during check 7 | `inconclusive`, retried next boot, no page |
| daemon stops mid-probe | children killed, workDir removed, nothing recorded |
| probe itself throws | logged by code, nothing recorded, next boot retries |

## 5. Testing

- **Unit** (`tests/omp/`): cache hit, miss on each fingerprint field, failed result not cached, single flight,
  `onNewVersion` once per version; probe with a fake session for every outcome code in §3.2; runner skip rule, row and
  incident per result, stop-signal discard; status mapping; one-shot and preflight read the cache (no exec on a hit).
- **Live gate** `scripts/live-gate-omp-probe.mjs` on a `VACUUM INTO` copy, real omp:
  1. `probeNow` passes, all 7 checks `pass`, a row recorded, no incident.
  2. With `HOUGE_OMP_BIN` pointed at a wrapper that execs the real omp and rewrites `not found` to `is unknown` on
     stderr: `probeNow` returns `fail` with `start_refusal: fail:unclassified`, and `omp_contract_drift` is open.
     This proves the probe catches a reworded refusal, not just that a call returned.
  3. Cache: the wrapper logs each `--version` call. Three one-shot version checks → 1 exec; touch the wrapper → 1 more.

## 6. Out of scope

Blocking or downgrading on drift; re-probing a known-good version on every boot; the deeper `--smoke` cases
(sandbox canaries, shell and tool paths), which stay manual after an upgrade.

## 7. Docs on ship

ADR 0028 amendment + index row; `configuration.md` (`houge omp probe`, the incident kind); README prerequisites
(`--smoke` still manual, probe automatic); ROADMAP delta (the "omp contract probe" item); `tasks/todo.md`;
`sessions.md`.
