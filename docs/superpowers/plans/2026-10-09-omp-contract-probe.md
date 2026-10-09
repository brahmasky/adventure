# omp contract probe and cached version check — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run `omp --version` once per omp binary instead of before every one-shot call, and probe omp's contract surface (catalog, refusals, RPC frames, one tiny prompt) whenever the version has no passing probe, paging Paco on drift while Houge keeps running.

**Architecture:** A process-wide version cache keyed on the omp binary's fingerprint replaces the per-call check at the two chokepoints (`spawnOneShot`, `PlannerSupervisor.preflight`). Its new-version listener starts a probe runner that drives throwaway `PlannerSession` children (no tools, no bridge, sandboxed) through seven checks, records one `omp_contract_probe` ledger event and opens or resolves `omp_contract_drift`.

**Tech Stack:** Node 22 + TypeScript, `node:sqlite` via `RunStore`, vitest. Zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-09-omp-contract-probe-design.md` (Rev 2, `abf9f35`). The spec is the authority; read it before your task.

## Global Constraints

- `dependencies: {}` stays empty; Node stdlib only.
- No hard-coded omp version, model id or provider in production code: the probe model comes from `RoleResolver.candidates`. The bogus selector `houge-probe/no-such-model` is the one fixed string (it is deliberately not a model).
- omp's own text (stderr, RPC error detail, the model's reply) is never stored, logged, sent or put in an incident. Outcome codes are fixed strings chosen by code.
- A failed probe never blocks or downgrades a spawn (D2).
- Functions under 50 lines. Match surrounding style (terse JSDoc on exports, one-line comments only where the why is non-obvious).
- Tests live in `tests/<area>/` mirroring `src/`, use real SQLite (`RunStore.openInMemory()`), and each test states why the behaviour matters. Tests never reach a real omp (`tests/omp/hermetic-omp.test.ts`: `HOUGE_OMP_BIN` is a stub).
- Commands: `npm run typecheck && npm test && npm run build`. Single file: `npx vitest run tests/omp/<file>.test.ts`.
- Conventional Commits, stage files by name, end every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Incident kind `omp_contract_drift`, subject `omp:<version>`. Ledger `event_type: "omp_contract_probe"`, correlation `omp-probe`, actor `system`.

## File map

| File | Responsibility |
|---|---|
| `src/omp/omp-version-cache.ts` (new) | fingerprint, cache, single flight, new-version listener, shared instance |
| `src/llm/providers/omp.ts` | `spawnOneShot` default check → shared cache |
| `src/omp/planner-supervisor.ts` | `preflight` default → shared cache; export `isModelRefusal`; extract `writeHougeConfigFile` |
| `src/status/houge-status.ts` | `omp` from the cache, supervisor fallback |
| `src/omp/planner-session.ts` | `tools?: "none"` → `--no-tools`; `quietRpcErrors` |
| `src/omp/model-catalog.ts` | `readOmpCatalogResult` (ok / unparsed / unavailable) |
| `src/omp/omp-contract-probe.ts` (new) | the seven checks, isolation, result |
| `src/run/run-store.ts` | `recordOmpProbe`, `latestOmpProbe` |
| `src/omp/omp-probe-runner.ts` (new) | skip rule, one-at-a-time, settle (row + incident) |
| `src/core/core-worker.ts` | public `ompProbeContext()` |
| `src/telegram/telegram-daemon.ts` | boot check + listener |
| `src/cli.ts` | `houge omp probe` |
| `scripts/live-gate-omp-probe.mjs` (new) | live gate |

---

### Task 1: Version cache

**Files:**
- Create: `src/omp/omp-version-cache.ts`
- Test: `tests/omp/omp-version-cache.test.ts`

**Interfaces:**
- Consumes: `checkOmpVersionAsync`, `OmpCheckResult` (`src/omp/omp-version.ts`); `buildChildEnv` (`src/omp/child-env.ts`); `OmpConfig` (`src/omp/omp-config.ts`).
- Produces:
  ```ts
  export interface OmpBinaryFingerprint { path: string; mtimeMs: number; size: number; ino: number }
  export interface OmpVersionCache {
    current(): Promise<OmpCheckResult>;
    lastVersion(): string | null;
    setNewVersionListener(cb: ((version: string) => void) | null): void;
  }
  export function fingerprintOmpBinary(cfg: Pick<OmpConfig, "bin" | "envPassthrough">): OmpBinaryFingerprint | null;
  export function createOmpVersionCache(cfg: Pick<OmpConfig, "bin" | "envPassthrough">, deps?: {
    check?: () => Promise<OmpCheckResult>; fingerprint?: () => OmpBinaryFingerprint | null;
  }): OmpVersionCache;
  export function sharedOmpVersionCache(cfg: Pick<OmpConfig, "bin" | "envPassthrough">): OmpVersionCache;
  /** Tests only: install a cache for cfg's key (null clears every shared instance). */
  export function setSharedOmpVersionCacheForTest(cfg: Pick<OmpConfig, "bin" | "envPassthrough"> | null, cache?: OmpVersionCache): void;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { chmodSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OmpCheckResult } from "../../src/omp/omp-version.js";
import {
  createOmpVersionCache, fingerprintOmpBinary, setSharedOmpVersionCacheForTest, sharedOmpVersionCache, type OmpBinaryFingerprint
} from "../../src/omp/omp-version-cache.js";

// Spec §3: `omp --version` cost 0.8 s before every one-shot call. The cache must exec it once per binary, re-check the moment
// the binary changes (an upgrade is also the probe trigger), never remember a failure (a repaired omp must be seen at once),
// and never hand a caller the old binary's answer after an upgrade.
const cfg = { bin: "omp", envPassthrough: [] as string[] };
const fp = (o: Partial<OmpBinaryFingerprint> = {}): OmpBinaryFingerprint => ({ path: "/x/cli.js", mtimeMs: 1, size: 10, ino: 7, ...o });
const ok = (version: string): OmpCheckResult => ({ ok: true, version });
const down: OmpCheckResult = { ok: false, kind: "not_runnable", version: null, reason: "omp not runnable: ENOENT" };

function harness(results: OmpCheckResult[], fingerprint: OmpBinaryFingerprint | null = fp()) {
  let print = fingerprint; let calls = 0;
  const cache = createOmpVersionCache(cfg, {
    check: async () => { calls += 1; return results[Math.min(calls - 1, results.length - 1)] as OmpCheckResult; },
    fingerprint: () => print
  });
  return { cache, calls: () => calls, setPrint: (p: OmpBinaryFingerprint | null) => { print = p; } };
}

afterEach(() => setSharedOmpVersionCacheForTest(null));

describe("omp version cache", () => {
  it("execs once while the binary is unchanged", async () => {
    const h = harness([ok("18.7.0")]);
    for (let i = 0; i < 3; i++) expect(await h.cache.current()).toEqual(ok("18.7.0"));
    expect(h.calls()).toBe(1);
    expect(h.cache.lastVersion()).toBe("18.7.0");
  });

  it.each(["path", "mtimeMs", "size", "ino"] as const)("re-checks when the fingerprint's %s changes", async (field) => {
    const h = harness([ok("18.7.0"), ok("18.8.0")]);
    await h.cache.current();
    h.setPrint(fp({ [field]: field === "path" ? "/y/cli.js" : 99 }));
    expect(await h.cache.current()).toEqual(ok("18.8.0"));
    expect(h.calls()).toBe(2);
  });

  it("never caches a failure: a repaired omp is seen on the next call", async () => {
    const h = harness([down, down, ok("18.7.0")]);
    expect(await h.cache.current()).toEqual(down);
    expect(await h.cache.current()).toEqual(down);
    expect(await h.cache.current()).toEqual(ok("18.7.0"));
    expect(h.calls()).toBe(3);
    expect(h.cache.lastVersion()).toBe("18.7.0");
  });

  it("an unresolvable binary always checks", async () => {
    const h = harness([ok("18.7.0")], null);
    await h.cache.current(); await h.cache.current();
    expect(h.calls()).toBe(2);
  });

  it("joins concurrent calls for one binary into one exec", async () => {
    const h = harness([ok("18.7.0")]);
    await Promise.all([h.cache.current(), h.cache.current(), h.cache.current()]);
    expect(h.calls()).toBe(1);
  });

  it("a call after an upgrade never receives the old binary's in-flight answer", async () => {
    let release!: (r: OmpCheckResult) => void;
    let print = fp(); let calls = 0;
    const cache = createOmpVersionCache(cfg, {
      check: () => { calls += 1; return calls === 1 ? new Promise((r) => { release = r; }) : Promise.resolve(ok("18.8.0")); },
      fingerprint: () => print
    });
    const old = cache.current();
    print = fp({ mtimeMs: 2 });
    expect(await cache.current()).toEqual(ok("18.8.0"));
    release(ok("18.7.0"));
    expect(await old).toEqual(ok("18.7.0"));
    // the stale answer settled last but must not become the cached entry for the new binary
    expect(await cache.current()).toEqual(ok("18.8.0"));
    expect(calls).toBe(2);
    expect(cache.lastVersion()).toBe("18.8.0");
  });

  it("calls the listener once per distinct ok version, after caching it", async () => {
    const h = harness([ok("18.7.0"), ok("18.8.0")]);
    const seen: Array<[string, string | null]> = [];
    h.cache.setNewVersionListener((v) => seen.push([v, h.cache.lastVersion()]));
    await h.cache.current(); await h.cache.current();
    h.setPrint(fp({ ino: 8 }));
    await h.cache.current();
    expect(seen).toEqual([["18.7.0", "18.7.0"], ["18.8.0", "18.8.0"]]);
  });

  it("a throwing listener never breaks the check", async () => {
    const h = harness([ok("18.7.0")]);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    h.cache.setNewVersionListener(() => { throw new Error("boom"); });
    expect(await h.cache.current()).toEqual(ok("18.7.0"));
    expect(err).toHaveBeenCalledWith("[omp-version-cache] new-version listener threw");
    err.mockRestore();
  });

  it("fingerprints the real file behind a PATH lookup and a symlink-free path", () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-fp-"));
    try {
      const bin = join(dir, "omp");
      writeFileSync(bin, "#!/bin/sh\necho omp/1.0.0\n"); chmodSync(bin, 0o755);
      vi.stubEnv("PATH", `${dir}:/usr/bin:/bin`);
      const a = fingerprintOmpBinary({ bin: "omp", envPassthrough: [] });
      expect(a?.path).toContain("omp");
      utimesSync(bin, new Date(), new Date(Date.now() + 5_000));
      expect(fingerprintOmpBinary({ bin: "omp", envPassthrough: [] })?.mtimeMs).not.toBe(a?.mtimeMs);
      expect(fingerprintOmpBinary({ bin: join(dir, "missing"), envPassthrough: [] })).toBeNull();
    } finally { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("shares one instance per bin and passthrough", () => {
    expect(sharedOmpVersionCache(cfg)).toBe(sharedOmpVersionCache({ ...cfg }));
    expect(sharedOmpVersionCache(cfg)).not.toBe(sharedOmpVersionCache({ bin: "/other/omp", envPassthrough: [] }));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/omp/omp-version-cache.test.ts`
Expected: FAIL, cannot resolve `../../src/omp/omp-version-cache.js`.

- [ ] **Step 3: Implement**

```ts
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { buildChildEnv } from "./child-env.js";
import type { OmpConfig } from "./omp-config.js";
import { checkOmpVersionAsync, type OmpCheckResult } from "./omp-version.js";

type BinCfg = Pick<OmpConfig, "bin" | "envPassthrough">;
export interface OmpBinaryFingerprint { path: string; mtimeMs: number; size: number; ino: number }
export interface OmpVersionCache {
  /** The cached ok result while the binary's fingerprint is unchanged; otherwise a fresh check (spec §3). */
  current(): Promise<OmpCheckResult>;
  /** The last ok version this process saw, or null (houge_status). */
  lastVersion(): string | null;
  /** The one listener, called once per distinct ok version (the probe trigger). Replaces any earlier listener. */
  setNewVersionListener(cb: ((version: string) => void) | null): void;
}

/** The file the spawn would run: a slashed bin as given, else the first executable on the child env's PATH; then realpath. */
function resolveBin(cfg: BinCfg): string | null {
  if (cfg.bin.includes("/")) return isAbsolute(cfg.bin) ? cfg.bin : join(process.cwd(), cfg.bin);
  for (const dir of (buildChildEnv(cfg.envPassthrough).PATH ?? "").split(delimiter)) {
    if (dir.length === 0) continue;
    const p = join(dir, cfg.bin);
    try { accessSync(p, constants.X_OK); return p; } catch { /* next PATH entry */ }
  }
  return null;
}

/** Sync stat, no exec: an upgrade (bun rewrites the bundled cli.js) changes mtime and inode. Any fs error → null. */
export function fingerprintOmpBinary(cfg: BinCfg): OmpBinaryFingerprint | null {
  try {
    const found = resolveBin(cfg);
    if (found === null) return null;
    const path = realpathSync(found);
    const s = statSync(path);
    return { path, mtimeMs: s.mtimeMs, size: s.size, ino: s.ino };
  } catch { return null; }
}

const keyOf = (f: OmpBinaryFingerprint | null): string => (f ? `${f.path}|${f.mtimeMs}|${f.size}|${f.ino}` : "null");

export function createOmpVersionCache(cfg: BinCfg, deps: {
  check?: () => Promise<OmpCheckResult>; fingerprint?: () => OmpBinaryFingerprint | null;
} = {}): OmpVersionCache {
  const check = deps.check ?? (() => checkOmpVersionAsync(cfg));
  const fingerprint = deps.fingerprint ?? (() => fingerprintOmpBinary(cfg));
  let cached: { key: string; result: OmpCheckResult & { ok: true } } | undefined;
  let latestKey: string | undefined;
  let last: string | null = null;
  const seen = new Set<string>();
  const flights = new Map<string, Promise<OmpCheckResult>>();
  let listener: ((v: string) => void) | null = null;

  const settle = (key: string, r: OmpCheckResult): void => {
    if (!r.ok || key !== latestKey || key === "null") return; // a stale or failed answer is returned, never cached
    cached = { key, result: r };
    last = r.version;
    if (seen.has(r.version)) return;
    seen.add(r.version);
    try { listener?.(r.version); } catch { console.error("[omp-version-cache] new-version listener threw"); }
  };

  return {
    current(): Promise<OmpCheckResult> {
      const key = keyOf(fingerprint());
      latestKey = key;
      if (cached && cached.key === key) return Promise.resolve(cached.result);
      const inFlight = key === "null" ? undefined : flights.get(key);
      if (inFlight) return inFlight;
      const p = check().then((r) => { settle(key, r); return r; }).finally(() => { flights.delete(key); });
      if (key !== "null") flights.set(key, p);
      return p;
    },
    lastVersion: () => last,
    setNewVersionListener(cb) { listener = cb; }
  };
}
```

Note: an ok answer under a null fingerprint is returned but never cached, and does not move `lastVersion()` or fire the listener: an omp the cache cannot fingerprint is re-checked on every call (spec §3 Miss).

Shared instance, same file:

```ts
const shared = new Map<string, OmpVersionCache>();
const sharedKey = (cfg: BinCfg): string =>
  `${cfg.bin}|${Array.isArray(cfg.envPassthrough) ? cfg.envPassthrough.join(",") : String(cfg.envPassthrough ?? "")}`;

/** The process-wide instance for (bin, envPassthrough): every production caller uses it (spec §3 Sharing). */
export function sharedOmpVersionCache(cfg: BinCfg): OmpVersionCache {
  const k = sharedKey(cfg);
  let c = shared.get(k);
  if (!c) { c = createOmpVersionCache(cfg); shared.set(k, c); }
  return c;
}

/** Tests only: install a cache for cfg's key (null clears every shared instance). */
export function setSharedOmpVersionCacheForTest(cfg: BinCfg | null, cache?: OmpVersionCache): void {
  if (cfg === null) { shared.clear(); return; }
  if (cache) shared.set(sharedKey(cfg), cache); else shared.delete(sharedKey(cfg));
}
```

Check `OmpConfig.envPassthrough`'s declared type in `src/omp/omp-config.ts` and make `sharedKey` match it exactly (it may be `string[]` only; then drop the String branch).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/omp/omp-version-cache.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/omp/omp-version-cache.ts tests/omp/omp-version-cache.test.ts
git commit -m "feat(omp): cache the omp version per binary fingerprint"
```

---

### Task 2: Route the version check through the shared cache

**Files:**
- Modify: `src/llm/providers/omp.ts:130` (`spawnOneShot`)
- Modify: `src/omp/planner-supervisor.ts:805-807` (`preflight`)
- Modify: `src/status/houge-status.ts:131-140` (`collectHougeStatus`)
- Test: `tests/llm/providers/omp-version-cache-wiring.test.ts` (new; put it beside the existing `spawnOneShot` tests — find them with `grep -rln spawnOneShot tests/`), `tests/omp/planner-supervisor.test.ts` (add one case), `tests/status/houge-status.test.ts` (add one case; find the file with `grep -rln collectHougeStatus tests/`)

**Interfaces:**
- Consumes: `sharedOmpVersionCache`, `setSharedOmpVersionCacheForTest`, `OmpVersionCache` (Task 1).
- Produces: nothing new; existing injected `versionCheck` hooks keep precedence.

- [ ] **Step 1: Write the failing tests**

One-shot wiring (new file). Build the `OneShotInput`/`OneShotDeps` the way the existing `spawnOneShot` tests do (copy their minimal input: an audio-free prompt, a one-entry chain, the test cfg). The point: with no injected `versionCheck`, the call asks the shared cache, and a failed cache answer stops the call before any leg spawns.

```ts
// Spec §3: the one-shot path paid `omp --version` (0.8 s) on every call. With no injected check it must ask the shared
// per-binary cache instead, and an unavailable omp must still stop the call before any leg spawns (omp_unavailable path).
it("asks the shared cache when no versionCheck is injected", async () => {
  let asked = 0;
  setSharedOmpVersionCacheForTest(cfg, {
    current: async () => { asked += 1; return { ok: false, kind: "not_runnable", version: null, reason: "omp not runnable: ENOENT" }; },
    lastVersion: () => null, setNewVersionListener: () => {}
  });
  const r = await spawnOneShot(input, { cfg, audit: () => {} });
  expect(asked).toBe(1);
  expect(r).toMatchObject({ ok: false, unavailable: true, omp_check: { kind: "not_runnable" } });
});
it("an injected versionCheck still wins over the cache", async () => {
  let asked = 0;
  setSharedOmpVersionCacheForTest(cfg, { current: async () => { asked += 1; return { ok: true, version: "x" }; }, lastVersion: () => null, setNewVersionListener: () => {} });
  await spawnOneShot(input, { cfg, audit: () => {}, versionCheck: () => ({ ok: false, kind: "no_version", version: null, reason: "r" }) });
  expect(asked).toBe(0);
});
```

Add `afterEach(() => setSharedOmpVersionCacheForTest(null))`. Match `audit`'s real type in `OneShotDeps`.

Supervisor (add to `tests/omp/planner-supervisor.test.ts`, reusing that file's deps builder): build a supervisor WITHOUT `versionCheck`, install a shared cache for its `cfg` that returns `{ok:false, kind:"not_runnable", …}` and counts calls, trigger a spawn the way neighbouring tests do, and assert the cache was asked once and the `omp_unavailable` incident path ran (the existing assertion style for `versionCheck` failures in that file). Comment: "the planner preflight reads the shared cache, so a spawn after boot costs no exec".

Status (add to the houge-status test file): install a shared cache whose `lastVersion()` returns `"18.7.0"` for `resolveOmpConfig(env)`'s bin/passthrough, call `collectHougeStatus` with no supervisor, expect `omp: "18.7.0"`; with a supervisor reporting `"18.6.0"` and a cache returning null, expect `"18.6.0"`. Comment: "houge_status shows the boot check's version before any planner started".

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/llm/providers/omp-version-cache-wiring.test.ts tests/omp/planner-supervisor.test.ts tests/status/houge-status.test.ts`
Expected: the new cases FAIL (the default still execs the stub; status returns null).

- [ ] **Step 3: Implement**

`src/llm/providers/omp.ts`:
```ts
import { sharedOmpVersionCache } from "../../omp/omp-version-cache.js";
// …
  const version = await (deps.versionCheck ?? (() => sharedOmpVersionCache(deps.cfg).current()))(); // one exec per omp binary (spec §3)
```
Drop the `checkOmpVersionAsync` import if it becomes unused.

`src/omp/planner-supervisor.ts` `preflight()`:
```ts
    const v = await (this.d.versionCheck ?? (() => sharedOmpVersionCache(cfg).current()))();
```
Update the JSDoc on line 804 to: "omp's version comes from the shared per-binary cache (one exec per binary); wrapper hash and Seatbelt render unless skipped for unit tests." Update the `versionCheck` doc at line 91 likewise.

`src/status/houge-status.ts` `collectHougeStatus`:
```ts
    omp: cachedOmpVersion(d.env) ?? d.supervisor?.ompVersion() ?? null,
```
with
```ts
/** The shared cache's last ok version (the daemon's boot check fills it); null when the config is invalid or nothing passed yet. */
function cachedOmpVersion(env: NodeJS.ProcessEnv): string | null {
  try { return sharedOmpVersionCache(resolveOmpConfig(env)).lastVersion(); } catch { return null; }
}
```

- [ ] **Step 4: Run to verify they pass, then the whole suite**

Run: `npx vitest run tests/llm tests/omp tests/status && npm run typecheck && npm test`
Expected: PASS, none skipped.

- [ ] **Step 5: Commit**

```bash
git add src/llm/providers/omp.ts src/omp/planner-supervisor.ts src/status/houge-status.ts tests/llm/providers/omp-version-cache-wiring.test.ts tests/omp/planner-supervisor.test.ts tests/status/houge-status.test.ts
git commit -m "perf(omp): read the omp version from the shared cache at both spawn chokepoints"
```

---

### Task 3: Probe seams (no-tools argv, quiet errors, catalog result, shared helpers)

**Files:**
- Modify: `src/omp/planner-session.ts:7-19` (options + `plannerArgs`), `:148-152` (`dispatch`)
- Modify: `src/omp/model-catalog.ts:37-52`
- Modify: `src/omp/planner-supervisor.ts:133` (`HOUGE_CONFIG_YML`), `:178` (`isModelRefusal`), `:826-842` (`preparePaths`)
- Test: `tests/omp/planner-session.test.ts`, `tests/omp/model-catalog.test.ts`, `tests/omp/planner-supervisor.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // planner-session.ts
  export interface PlannerSessionOptions { /* existing fields */ tools?: "none"; quietRpcErrors?: boolean }
  // model-catalog.ts
  export type CatalogRead = { kind: "ok"; models: CatalogModel[] } | { kind: "unparsed" } | { kind: "unavailable"; code: string };
  export async function readOmpCatalogResult(cfg: Pick<OmpConfig, "bin" | "profile" | "envPassthrough">, exec?: ExecFileAsync): Promise<CatalogRead>;
  // planner-supervisor.ts
  export const isModelRefusal: (e: unknown) => boolean;
  /** Writes <data>/omp/houge-config.yml atomically (0600) and returns its path. */
  export function writeHougeConfigFile(ctx: Pick<PathContext, "data">): string;
  ```

- [ ] **Step 1: Write the failing tests**

`tests/omp/planner-session.test.ts` (reuse the file's option builder):
```ts
// Spec §4.3: the probe child must run with no tools at all; the planner keeps read,edit,write.
it("tools: none swaps --tools read,edit,write for --no-tools", () => {
  const { args } = plannerArgs({ ...opts, tools: "none" });
  expect(args).toContain("--no-tools");
  expect(args).not.toContain("--tools");
  expect(plannerArgs(opts).args).toEqual(expect.arrayContaining(["--tools", "read,edit,write"]));
});
```
And a quiet-errors case: drive a fake child (the file already fakes `spawn` or uses a stub script; follow it) that answers a command with `{"type":"response","id":"c1","success":false,"error":"Model not found: x"}`; with `quietRpcErrors: true`, `console.error` is not called and the rejection is still `PlannerRpcError` with `code: "command_failed:set_model"` and `detail` set; without it, `console.error` is called once. Comment: "the probe's deliberate pin refusal must not put omp's text in the daemon log (spec §4.3)".

`tests/omp/model-catalog.test.ts`:
```ts
// Spec §4.1 check 1: an omp that answers but in a new shape is drift; an omp that cannot answer is not.
it("readOmpCatalogResult splits ok, unparsed and unavailable", async () => {
  const exec = (stdout: string) => (async () => ({ stdout, stderr: "" })) as unknown as ExecFileAsync;
  expect(await readOmpCatalogResult(cfg, exec(JSON.stringify({ models: [{ provider: "p", id: "m" }] })))).toMatchObject({ kind: "ok", models: [{ provider: "p", id: "m" }] });
  expect(await readOmpCatalogResult(cfg, exec(JSON.stringify({ items: [] })))).toEqual({ kind: "unparsed" });
  const fail = (async () => { throw Object.assign(new Error("x"), { code: "ETIMEDOUT" }); }) as unknown as ExecFileAsync;
  expect(await readOmpCatalogResult(cfg, fail)).toEqual({ kind: "unavailable", code: "ETIMEDOUT" });
  expect(await readOmpCatalog(cfg, fail)).toBeNull();
});
```
(Match the file's existing `cfg` and exec-fake style.)

`tests/omp/planner-supervisor.test.ts`:
```ts
// The probe reuses the planner's own config file and refusal classifier, so the two can never drift apart.
it("writeHougeConfigFile writes the planner's config at <data>/omp/houge-config.yml, 0600", () => {
  const data = mkdtempSync(join(tmpdir(), "hcfg-"));
  try {
    mkdirSync(join(data, "omp"), { recursive: true });
    const p = writeHougeConfigFile({ data });
    expect(p).toBe(join(data, "omp", "houge-config.yml"));
    expect(readFileSync(p, "utf8")).toContain("checkUpdate: false");
    expect(statSync(p).mode & 0o777).toBe(0o600);
  } finally { rmSync(data, { recursive: true, force: true }); }
});
it("isModelRefusal accepts only a classified set_model refusal", () => {
  expect(isModelRefusal(new PlannerRpcError("command_failed:set_model", "Model not found: x/y"))).toBe(true);
  expect(isModelRefusal(new PlannerRpcError("command_failed:set_model", "rate limit"))).toBe(false);
  expect(isModelRefusal(new PlannerRpcError("command_failed:prompt", "Model not found: x/y"))).toBe(false);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/omp/planner-session.test.ts tests/omp/model-catalog.test.ts tests/omp/planner-supervisor.test.ts`
Expected: new cases FAIL (missing exports, `--tools` still present).

- [ ] **Step 3: Implement**

`planner-session.ts`:
```ts
export interface PlannerSessionOptions {
  cfg: OmpConfig; sessionDir: string; cwd: string; systemPromptFile: string; extensions: string[]; skills?: string;
  bridgeSock: string; bridgeToken: string; model: ModelString; configFile: string; plannerProfile: string;
  sendTimeoutMs?: number; maxFrameBufferBytes?: number;
  /** "none": no built-in tools (the contract probe, spec §4.3); absent: the planner's read,edit,write. */
  tools?: "none";
  /** Do not log a refused command's detail (the probe's deliberate refusals); the rejection still carries it. */
  quietRpcErrors?: boolean;
}
// in plannerArgs, replace `"--tools", "read,edit,write",` with:
    ...(o.tools === "none" ? ["--no-tools"] : ["--tools", "read,edit,write"]),
// in dispatch:
      if (!this.o.quietRpcErrors) console.error(`planner ${w.type} failed: ${detail}`);
```

`model-catalog.ts`:
```ts
export type CatalogRead = { kind: "ok"; models: CatalogModel[] } | { kind: "unparsed" } | { kind: "unavailable"; code: string };

/** readOmpCatalog with the two failures apart: omp answered in a shape we cannot parse (drift) vs could not answer. Never throws. */
export async function readOmpCatalogResult(cfg: Pick<OmpConfig, "bin" | "profile" | "envPassthrough">, exec: ExecFileAsync = execFileAsync): Promise<CatalogRead> {
  let stdout: string;
  try {
    const env = { ...buildChildEnv(cfg.envPassthrough), TMPDIR: daemonTmpRoot() };
    ({ stdout } = await exec(cfg.bin, ["--profile", cfg.profile, "models", "--json"], { timeout: CATALOG_TIMEOUT_MS, maxBuffer: CATALOG_MAX_BYTES, env }));
  } catch (error) {
    const e = error as { code?: unknown; signal?: unknown };
    return { kind: "unavailable", code: String(e.code ?? e.signal ?? "error") };
  }
  const models = parseOmpCatalog(stdout);
  return models ? { kind: "ok", models } : { kind: "unparsed" };
}

export async function readOmpCatalog(cfg: Pick<OmpConfig, "bin" | "profile" | "envPassthrough">, exec: ExecFileAsync = execFileAsync): Promise<CatalogModel[] | null> {
  const r = await readOmpCatalogResult(cfg, exec);
  if (r.kind === "unavailable") console.warn(`[model-catalog] omp models failed: ${r.code}`);
  return r.kind === "ok" ? r.models : null;
}
```
Keep `readOmpCatalog`'s JSDoc.

`planner-supervisor.ts`: `export const isModelRefusal = …` (body unchanged). Add near `HOUGE_CONFIG_YML`:
```ts
/** The planner's omp config file, written atomically (0600); the contract probe writes the same file (spec §4.3). */
export function writeHougeConfigFile(ctx: Pick<PathContext, "data">): string {
  const configFile = join(ctx.data, "omp", "houge-config.yml");
  const tmp = `${configFile}.tmp-${process.pid}`;
  writeFileSync(tmp, HOUGE_CONFIG_YML, { mode: 0o600 });
  renameSync(tmp, configFile);
  return configFile;
}
```
and in `preparePaths()` replace the four config lines with `const configFile = writeHougeConfigFile(ctx);`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/omp && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/omp/planner-session.ts src/omp/model-catalog.ts src/omp/planner-supervisor.ts tests/omp/planner-session.test.ts tests/omp/model-catalog.test.ts tests/omp/planner-supervisor.test.ts
git commit -m "refactor(omp): seams for the contract probe (no-tools argv, quiet refusals, catalog result, shared config writer)"
```

---

### Task 4: The probe

**Files:**
- Create: `src/omp/omp-contract-probe.ts`
- Test: `tests/omp/omp-contract-probe.test.ts`

**Interfaces:**
- Consumes: `PlannerSession`, `PlannerSessionOptions` (`tools`, `quietRpcErrors`), `PlannerRpcError`; `readOmpCatalogResult`, `CatalogRead`; `isModelRefusal`, `writeHougeConfigFile`; `writeSeatbeltProfiles` (`src/omp/seatbelt.ts`); `classifyOmpError`, `OmpFrame`; `PathContext`; `ModelString`; `OmpConfig`.
- Produces:
  ```ts
  export type ProbeCheckName = "catalog" | "start_refusal" | "session_open" | "pin_refusal" | "effort" | "new_session" | "prompt";
  export type ProbeCheckOutcome = "pass" | `fail:${string}` | `inconclusive:${string}` | "skipped";
  export interface ProbeResult {
    version: string; result: "pass" | "fail" | "inconclusive"; model: string | null;
    checks: Record<ProbeCheckName, ProbeCheckOutcome>;
    usage: { input_tokens: number; output_tokens: number } | null;
    started_at: string; finished_at: string;
  }
  export interface ProbeSessionLike {
    start(): Promise<{ resumed: boolean; sessionId: string }>;
    setModel(m: ModelString): Promise<void>;
    newSession(): Promise<{ cancelled: boolean }>;
    prompt(text: string): Promise<void>;
    onFrame(cb: (f: OmpFrame) => void): void;
    stop(): Promise<void>;
  }
  export const PROBE_BOGUS_MODEL: ModelString; // { provider: "houge-probe", model: "no-such-model" }
  export interface ProbeInput {
    cfg: OmpConfig; ctx: PathContext; version: string; model: ModelString | null; signal?: AbortSignal;
    session?: (o: PlannerSessionOptions) => ProbeSessionLike;
    catalog?: () => Promise<CatalogRead>;
    prepare?: (ctx: PathContext) => { configFile: string; plannerProfile: string };
    now?: () => string;
    timeouts?: { startMs?: number; commandMs?: number; frameMs?: number; promptMs?: number };
  }
  export async function runOmpContractProbe(input: ProbeInput): Promise<ProbeResult>;
  ```

**Behaviour (spec §4.1, binding):**
- Defaults: `session = (o) => new PlannerSession(o)`; `catalog = () => readOmpCatalogResult(cfg)`; `prepare = (ctx) => { writeSeatbeltProfiles(ctx); return { configFile: writeHougeConfigFile(ctx), plannerProfile: join(ctx.data, "omp", "planner.sb") }; }`; timeouts `startMs 30_000`, `commandMs 15_000`, `frameMs 5_000`, `promptMs 60_000`.
- Paths: `id = randomUUID()`; `cwd = join(ctx.data, "omp", "workspace", \`probe-${id}\`)`; `sessionDir = join(ctx.data, "omp", "sessions", \`probe-${id}\`)`; both `mkdirSync(…, {recursive: true, mode: 0o700})`; `systemPromptFile = join(cwd, "probe-system.md")` with the text `"You are a connectivity probe for Houge. Answer in as few words as possible."`. Both dirs `rmSync(…, {recursive: true, force: true})` in a `finally`.
- Session options for every child: `{ cfg, sessionDir, cwd, systemPromptFile, extensions: [], bridgeSock: "", bridgeToken: "", model, configFile, plannerProfile, tools: "none", quietRpcErrors: true, sendTimeoutMs: commandMs }`.
- Every child is stopped in a `finally` (`await s.stop().catch(() => {})`). An abort on `input.signal` stops the live child at once (listener), and later checks become `skipped`.
- Check codes exactly as the spec table, plus these rulings (they fill gaps the spec leaves):
  - A step bounded by its timeout that does not settle → `inconclusive:timeout`. Implement one helper `bounded(p, ms)` returning the value or a `TIMED_OUT` symbol (same shape as `planner-supervisor.ts` `bounded`).
  - Check 2: `start()` rejects with `PlannerRpcError` code `exited:model_missing` → pass; rejects with any other code → `fail:unclassified`; resolves → `fail:started`.
  - Check 3: `start()` rejects with code matching `/^exited:(model_missing|quota|auth|transport)$/` → `inconclusive:start_<kind>`; any other rejection → `fail:start`; resolves with `typeof resumed === "boolean"` and a non-empty string `sessionId` → pass; else `fail:shape`.
  - Check 4: `setModel(PROBE_BOGUS_MODEL)` resolves → `fail:accepted`; rejects with `isModelRefusal(e)` → pass; `PlannerRpcError` code starting `timeout:` → `inconclusive:timeout`; otherwise `fail:unclassified`.
  - Check 5: the expected level is `model.effort`; when `model.effort` is undefined the check is `skipped`. Subscribe to frames first, then `setModel(model)`; a rejection → `fail:rejected` (`timeout:` code → `inconclusive:timeout`); then wait up to `frameMs` for a frame with `type === "thinking_level_changed"` and `thinkingLevel === model.effort` → pass, else `fail:no_frame`.
  - Check 6: `newSession()` resolves → pass (its own code already rejects a non-boolean `cancelled` with `new_session_malformed`); rejects with code `new_session_malformed` → `fail:shape`; `timeout:` → `inconclusive:timeout`; other → `fail:shape`.
  - Check 7: subscribe to frames, `prompt("Reply with exactly OK.")`, wait up to `promptMs` for `agent_end`. Take the last `message_end` whose `message.role === "assistant"`. If its `message.stopReason === "error"` or it has a string `errorMessage`: classify that text with `classifyOmpError` and return `inconclusive:provider_<kind>` (any kind: an errored reply is a provider condition, not drift; ruling over the spec's three-kind list). Otherwise pass only when `provider`, `model`, `stopReason` are strings, `usage` is an object whose `input` and `output` are finite numbers, and the joined `type: "text"` content is non-empty after trim; else `fail:shape`. No `message_end` before `agent_end` → `fail:shape`. Record `usage = { input_tokens: input, output_tokens: output }` on pass. Never keep the text.
  - When check 3 is not `pass`, checks 4–7 are `skipped`. When `model` is null: check 1 runs, check 2 runs (it needs no real model), checks 3–7 are `inconclusive:no_model` for check 3 and `skipped` for 4–7.
  - Check 1 → `{kind:"ok"}` pass, `{kind:"unparsed"}` `fail:unparsed`, `{kind:"unavailable"}` `inconclusive:catalog_unavailable`.
  - `result`: any `fail:` → `"fail"`; else any `inconclusive:` → `"inconclusive"`; else `"pass"`.
  - `model` in the result: `"provider/model:effort"` (use `formatModelString` from `src/omp/model-string.ts`) or null.
- Structure: one function per check (each under 50 lines) plus `runOmpContractProbe` orchestrating; a check function returns its `ProbeCheckOutcome`.

- [ ] **Step 1: Write the failing tests**

Build a scripted fake session. Each test sets only what it needs.

```ts
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROBE_BOGUS_MODEL, runOmpContractProbe, type ProbeInput, type ProbeSessionLike } from "../../src/omp/omp-contract-probe.js";
import type { OmpFrame } from "../../src/omp/omp-frames.js";
import { PlannerRpcError, type PlannerSessionOptions } from "../../src/omp/planner-session.js";
import { resolveOmpConfig } from "../../src/omp/omp-config.js";
import type { ModelString } from "../../src/omp/model-string.js";

// Spec §4: the probe is the only thing standing between a quiet omp contract change and silently broken fallback,
// attribution or session reset. Every drift shape must FAIL (page), every provider or timing hiccup must be INCONCLUSIVE
// (no page), the probe child must never get tools, and omp's text must never leave the probe.
const MODEL: ModelString = { provider: "kimi-code", model: "k3", effort: "low" };
const GOOD_END: OmpFrame = { type: "message_end", message: { role: "assistant", provider: "kimi-code", model: "k3", stopReason: "stop",
  usage: { input: 12, output: 2 }, content: [{ type: "text", text: "OK" }] } };

interface Script {
  startRefusal?: () => Promise<{ resumed: boolean; sessionId: string }>;
  start?: () => Promise<{ resumed: boolean; sessionId: string }>;
  pin?: () => Promise<void>;
  effort?: () => Promise<void>;
  effortFrame?: OmpFrame | null;
  newSession?: () => Promise<{ cancelled: boolean }>;
  promptFrames?: OmpFrame[];
}
let data: string; let opened: PlannerSessionOptions[]; let stopped: number;

function fakeSession(s: Script) {
  return (o: PlannerSessionOptions): ProbeSessionLike => {
    opened.push(o);
    const cbs: Array<(f: OmpFrame) => void> = [];
    const emit = (f: OmpFrame) => { for (const cb of cbs) cb(f); };
    const bogus = o.model.provider === PROBE_BOGUS_MODEL.provider;
    return {
      start: () => (bogus ? (s.startRefusal ?? (() => Promise.reject(new PlannerRpcError("exited:model_missing"))))()
        : (s.start ?? (async () => ({ resumed: false, sessionId: "s1" })))()),
      setModel: async (m) => {
        if (m.provider === PROBE_BOGUS_MODEL.provider) return (s.pin ?? (() => Promise.reject(new PlannerRpcError("command_failed:set_model", "Model not found: houge-probe/no-such-model"))))();
        await (s.effort ?? (async () => {}))();
        const f = s.effortFrame === undefined ? { type: "thinking_level_changed", thinkingLevel: m.effort } : s.effortFrame;
        if (f) setTimeout(() => emit(f), 0);
      },
      newSession: () => (s.newSession ?? (async () => ({ cancelled: false })))(),
      prompt: async () => { setTimeout(() => { for (const f of s.promptFrames ?? [GOOD_END, { type: "agent_end" }]) emit(f); }, 0); },
      onFrame: (cb) => { cbs.push(cb); },
      stop: async () => { stopped += 1; }
    };
  };
}
const run = (s: Script, o: Partial<ProbeInput> = {}) => runOmpContractProbe({
  cfg: resolveOmpConfig({}), ctx: { home: data, repo: data, data }, version: "18.7.0", model: MODEL,
  session: fakeSession(s), catalog: async () => ({ kind: "ok", models: [{ provider: "kimi-code", id: "k3", thinking: ["low"] }] }),
  prepare: () => ({ configFile: join(data, "c.yml"), plannerProfile: join(data, "p.sb") }),
  timeouts: { startMs: 200, commandMs: 200, frameMs: 100, promptMs: 200 }, ...o
});

beforeEach(() => { data = mkdtempSync(join(tmpdir(), "probe-")); opened = []; stopped = 0; });
afterEach(() => { rmSync(data, { recursive: true, force: true }); });

describe("omp contract probe", () => {
  it("passes all seven checks on a healthy omp, records usage, and cleans up", async () => {
    const r = await run({});
    expect(r.result).toBe("pass");
    expect(Object.values(r.checks)).toEqual(Array(7).fill("pass"));
    expect(r.usage).toEqual({ input_tokens: 12, output_tokens: 2 });
    expect(r.model).toBe("kimi-code/k3:low");
    expect(stopped).toBe(opened.length);
    expect(readdirSync(join(data, "omp", "workspace"))).toEqual([]);
    expect(readdirSync(join(data, "omp", "sessions"))).toEqual([]);
  });

  it("never gives a probe child tools, a bridge, or a log line of omp's text", async () => {
    await run({});
    for (const o of opened) expect(o).toMatchObject({ tools: "none", quietRpcErrors: true, extensions: [], bridgeSock: "", bridgeToken: "" });
    expect(opened.every((o) => o.cwd.startsWith(join(data, "omp", "workspace", "probe-")))).toBe(true);
    expect(opened.every((o) => o.sessionDir.startsWith(join(data, "omp", "sessions", "probe-")))).toBe(true);
  });

  it.each([
    ["catalog unparsed is drift", { catalog: async () => ({ kind: "unparsed" as const }) }, "catalog", "fail:unparsed"],
    ["catalog unavailable is not", { catalog: async () => ({ kind: "unavailable" as const, code: "ETIMEDOUT" }) }, "catalog", "inconclusive:catalog_unavailable"]
  ])("%s", async (_n, o, check, code) => {
    const r = await run({}, o);
    expect(r.checks[check as "catalog"]).toBe(code);
  });

  it("a reworded start refusal is drift", async () => {
    const r = await run({ startRefusal: () => Promise.reject(new PlannerRpcError("exited:other")) });
    expect(r.checks.start_refusal).toBe("fail:unclassified");
    expect(r.result).toBe("fail");
  });

  it("a bogus model that starts is drift", async () => {
    expect((await run({ startRefusal: async () => ({ resumed: false, sessionId: "x" }) })).checks.start_refusal).toBe("fail:started");
  });

  it.each([
    ["exited:quota", "inconclusive:start_quota"], ["exited:auth", "inconclusive:start_auth"],
    ["exited:transport", "inconclusive:start_transport"], ["exited:model_missing", "inconclusive:start_model_missing"],
    ["exited:other", "fail:start"]
  ])("session_open start failure %s → %s, later checks skipped", async (code, want) => {
    const r = await run({ start: () => Promise.reject(new PlannerRpcError(code)) });
    expect(r.checks.session_open).toBe(want);
    expect([r.checks.pin_refusal, r.checks.effort, r.checks.new_session, r.checks.prompt]).toEqual(Array(4).fill("skipped"));
  });

  it("an open_session reply without a sessionId is drift", async () => {
    expect((await run({ start: async () => ({ resumed: false, sessionId: "" }) })).checks.session_open).toBe("fail:shape");
  });

  it("a start that never reaches ready is inconclusive, not drift", async () => {
    expect((await run({ start: () => new Promise(() => {}) })).checks.session_open).toBe("inconclusive:timeout");
  });

  it.each([
    ["accepted", async () => {}, "fail:accepted"],
    ["reworded", () => Promise.reject(new PlannerRpcError("command_failed:set_model", "no such thing")), "fail:unclassified"]
  ])("pin refusal %s → %s", async (_n, pin, want) => {
    expect((await run({ pin })).checks.pin_refusal).toBe(want);
  });

  it("effort passes only on the thinking_level_changed frame, since omp answers success to any level", async () => {
    expect((await run({ effortFrame: null })).checks.effort).toBe("fail:no_frame");
    expect((await run({ effortFrame: { type: "thinking_level_changed", thinkingLevel: "high" } })).checks.effort).toBe("fail:no_frame");
    expect((await run({ effort: () => Promise.reject(new PlannerRpcError("command_failed:set_thinking_level", "x")) })).checks.effort).toBe("fail:rejected");
  });

  it("new_session without a boolean cancelled is drift", async () => {
    expect((await run({ newSession: () => Promise.reject(new PlannerRpcError("new_session_malformed")) })).checks.new_session).toBe("fail:shape");
  });

  it.each([
    ["usage missing", { ...GOOD_END, message: { ...(GOOD_END.message as object), usage: undefined } }],
    ["usage mistyped", { ...GOOD_END, message: { ...(GOOD_END.message as object), usage: { input: "12", output: 2 } } }],
    ["provider missing", { ...GOOD_END, message: { ...(GOOD_END.message as object), provider: undefined } }],
    ["empty text", { ...GOOD_END, message: { ...(GOOD_END.message as object), content: [] } }]
  ])("a message_end with %s is drift", async (_n, end) => {
    const r = await run({ promptFrames: [end as OmpFrame, { type: "agent_end" }] });
    expect(r.checks.prompt).toBe("fail:shape");
    expect(r.usage).toBeNull();
  });

  it("a rate-limited reply is inconclusive and its text is not kept", async () => {
    const end = { ...GOOD_END, message: { ...(GOOD_END.message as object), stopReason: "error", errorMessage: "429 rate limit, resets in 3h" } };
    const r = await run({ promptFrames: [end as OmpFrame, { type: "agent_end" }] });
    expect(r.checks.prompt).toBe("inconclusive:provider_quota");
    expect(JSON.stringify(r)).not.toContain("resets in");
  });

  it("no model: start refusal still checked, the rest inconclusive or skipped", async () => {
    const r = await run({}, { model: null });
    expect(r.checks.start_refusal).toBe("pass");
    expect(r.checks.session_open).toBe("inconclusive:no_model");
    expect(r.result).toBe("inconclusive");
  });

  it("an abort stops the live child and skips the rest", async () => {
    const ac = new AbortController();
    const r = await run({ start: () => { ac.abort(); return new Promise(() => {}); } }, { signal: ac.signal });
    expect(r.checks.prompt).toBe("skipped");
    expect(stopped).toBe(opened.length);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/omp/omp-contract-probe.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** `src/omp/omp-contract-probe.ts` to the behaviour block above. Header JSDoc: what the probe is for (spec §1), that omp's text never leaves it, and that a fail pages while spawns continue (D2). Keep each check its own function.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/omp/omp-contract-probe.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/omp/omp-contract-probe.ts tests/omp/omp-contract-probe.test.ts
git commit -m "feat(omp): contract probe over catalog, refusals, RPC frames and one tiny prompt"
```

---

### Task 5: Probe record and runner

**Files:**
- Modify: `src/run/run-store.ts` (next to `recordModelRolesResolved`, ~line 4981)
- Create: `src/omp/omp-probe-runner.ts`
- Test: `tests/run/omp-probe-store.test.ts`, `tests/omp/omp-probe-runner.test.ts`

**Interfaces:**
- Consumes: `ProbeResult`, `ProbeCheckName`, `runOmpContractProbe` (Task 4); `openAlertedIncident`, `resolveOpenIncidents` (`src/run/incident-alert.ts`); `RoleResolver` (`candidates`).
- Produces:
  ```ts
  // run-store.ts
  recordOmpProbe(r: ProbeResult): void;
  latestOmpProbe(version: string, o?: { result?: ProbeResult["result"] }): ProbeResult | undefined;
  // omp-probe-runner.ts
  export const OMP_CONTRACT_DRIFT = "omp_contract_drift";
  export function pickProbeModel(roles: Pick<RoleResolver, "candidates">): ModelString | null;
  export function settleProbe(store: RunStore, r: ProbeResult, currentVersion: string | null, now: string): void;
  export interface OmpProbeRunner { maybeProbe(version: string): void; probeNow(version: string): Promise<ProbeResult> }
  export function createOmpProbeRunner(d: {
    store: RunStore; cfg: OmpConfig; ctx: PathContext; roles: Pick<RoleResolver, "candidates">;
    currentVersion: () => string | null; signal: AbortSignal;
    probe?: (i: ProbeInput) => Promise<ProbeResult>; now?: () => string;
  }): OmpProbeRunner;
  ```
  `ProbeResult` is imported into `run-store.ts` as a type only (`import type`), so no runtime cycle.

**Behaviour (spec §5, binding):**
- `recordOmpProbe`: `appendLedgerEvent(createLedgerEvent({ correlation_id: "omp-probe", event_type: "omp_contract_probe", actor: "system", sequence: this.nextLedgerSequence(), payload: { ...r } }))`.
- `latestOmpProbe(version, {result})`: `SELECT payload_json FROM ledger_events WHERE event_type = 'omp_contract_probe' AND json_extract(payload_json, '$.version') = ? [AND json_extract(payload_json, '$.result') = ?] ORDER BY sequence DESC LIMIT 1` (parameterised), parsed and shape-checked (`version` string, `result` one of the three, `checks` object) else undefined.
- `pickProbeModel`: `roles.candidates("tiny", { effort: "low" })[0] ?? roles.candidates("fast", { effort: "low" })[0] ?? null`. Confirm `RoutedEffort` includes `"low"` in `src/omp/role-resolver.ts`/`model-roles.ts`; if the routed-effort type does not take `"low"`, call `candidates(role)` and set `effort: "low"` only when the catalog lists it — record which in the report.
- `settleProbe`: inside `store.inTransaction(() => { … })`: `recordOmpProbe(r)`; if `r.version !== currentVersion` stop there; `fail` → `openAlertedIncident(store, { kind: OMP_CONTRACT_DRIFT, subject: \`omp:${r.version}\`, detail: { version: r.version, failed: <object of the checks whose outcome starts with "fail:"> }, chat_id: null, now })`; `pass` → `resolveOpenIncidents(store, new Set([OMP_CONTRACT_DRIFT]), undefined, now)`; `inconclusive` → nothing. Before writing, check that neither `openAlertedIncident` nor anything it calls opens its own `BEGIN` (the model-roles tick already calls it inside `inTransaction`, `model-roles-tick.ts:39`, so it should be safe; confirm).
- Runner state: `running: boolean`, `pending: string | null`, `attempted: Set<string>`.
  - `maybeProbe(v)`: `pending = v`; if not running, `drain()`. Never throws (wrap in try/catch → `console.error("[omp-probe] failed: <errorCode>")`, `errorCode` from wherever `telegram-daemon.ts` imports it).
  - `drain()`: take `pending` (set it null); return if null, `signal.aborted`, `attempted.has(v)`, or `store.latestOmpProbe(v, { result: "pass" })` exists. Else `running = true`, `attempted.add(v)`, start `execute(v)` un-awaited; on settle (`finally`) `running = false` then `drain()` again (the pending version, latest wins). A rejection is logged as above unless the signal aborted.
  - `execute(v)`: `model = pickProbeModel(roles)`; `r = await probe({ cfg, ctx, version: v, model, signal })`; if `signal.aborted` throw a private `ProbeAborted` (nothing recorded); else `settleProbe(store, r, currentVersion(), now())`; return r.
  - `probeNow(v)`: `execute(v)` directly (skip rule ignored, used by the CLI).

- [ ] **Step 1: Write the failing tests**

`tests/run/omp-probe-store.test.ts`:
```ts
// Spec §5: the probe row is the record that a version is known-good; the skip rule reads only a PASS for that exact version.
it("records and reads back the latest probe per version and result", () => {
  const store = RunStore.openInMemory();
  try {
    store.recordOmpProbe(result("18.7.0", "fail"));
    store.recordOmpProbe(result("18.7.0", "pass"));
    store.recordOmpProbe(result("18.8.0", "inconclusive"));
    expect(store.latestOmpProbe("18.7.0")?.result).toBe("pass");
    expect(store.latestOmpProbe("18.7.0", { result: "fail" })?.result).toBe("fail");
    expect(store.latestOmpProbe("18.8.0", { result: "pass" })).toBeUndefined();
    expect(store.latestOmpProbe("18.9.0")).toBeUndefined();
  } finally { store.close(); }
});
```
with a `result(version, r)` builder returning a full `ProbeResult` (all seven checks, `usage: null`, fixed instants).

`tests/omp/omp-probe-runner.test.ts` (store `RunStore.openInMemory()`, `vi.stubEnv("HOUGE_TELEGRAM_CHAT_ID", "42")` so pages enqueue; read pages with the outbox read the model-roles-tick test uses, or `store.listOpenIncidents()` for incidents):
```ts
// Spec §5: a drift pages ONCE and every spawn continues; a pass clears drift; an old binary's late answer must not touch
// the incident for the new one; inconclusive retries next boot; the probe never runs twice at once and never on a turn's path.
```
Cases (each its own `it`, with a fake `probe` that resolves a scripted `ProbeResult` and counts calls; await settle with a small `flush()` helper looping `await new Promise((r) => setImmediate(r))` a few times):
1. `fail` for the current version → one `omp_contract_drift` incident open with subject `omp:18.7.0`, `detail.failed` = `{ start_refusal: "fail:unclassified" }`, one outbox notification; a second `fail` (new runner, same store) opens nothing new.
2. `pass` for the current version after an open drift → incident resolved; row recorded.
3. `fail` whose version is not `currentVersion()` → row recorded, no incident.
4. `inconclusive` → row, no incident; a NEW runner on the same store probes `18.7.0` again (inconclusive does not count for the skip rule).
5. a `pass` row exists → `maybeProbe("18.7.0")` never calls the probe.
6. a `fail` row exists → a new runner probes again (re-probe after a Houge-side fix).
7. one at a time, latest wins: the first probe is held on a deferred promise; `maybeProbe("18.8.0")` then `maybeProbe("18.9.0")` while it runs; release → exactly ONE more call, for `18.9.0`. Total calls 2, versions `["18.7.0", "18.9.0"]`.
8. one attempt per version per process: `maybeProbe("18.7.0")` twice sequentially with an `inconclusive` result → probe called once.
9. stop signal: abort while the probe is pending, resolve it → no row, no incident, and a later `maybeProbe` does nothing.
10. a probe that throws → `console.error` called with `"[omp-probe] failed: <code>"`, no row, `maybeProbe` itself did not throw.
11. `pickProbeModel`: Tiny's head when present; Fast's when Tiny is empty; null when both empty (fake `candidates`).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/run/omp-probe-store.test.ts tests/omp/omp-probe-runner.test.ts`
Expected: FAIL (missing methods / module).

- [ ] **Step 3: Implement** the store methods and `src/omp/omp-probe-runner.ts` to the behaviour block.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/run tests/omp && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/run/run-store.ts src/omp/omp-probe-runner.ts tests/run/omp-probe-store.test.ts tests/omp/omp-probe-runner.test.ts
git commit -m "feat(omp): probe runner records each probe and pages omp_contract_drift once"
```

---

### Task 6: Daemon boot wiring and `houge omp probe`

**Files:**
- Modify: `src/core/core-worker.ts:1540-1545,2195` (public probe context)
- Modify: `src/telegram/telegram-daemon.ts:187` (boot, right after `await worker.modelRoles().refreshCatalog();`)
- Modify: `src/cli.ts` (new `omp` branch beside `jev`, and the usage text)
- Test: `tests/telegram/telegram-daemon-omp-probe.test.ts` (new; copy the minimal daemon harness from the closest existing daemon boot test, find it with `grep -rln "runTelegramDaemon" tests/telegram`), `tests/cli/omp-probe-cli.test.ts` (new) if a CLI test pattern exists (`ls tests/cli`); else test the extracted `runOmpProbeCli` function directly.

**Interfaces:**
- Consumes: `sharedOmpVersionCache` (T1), `createOmpProbeRunner` (T5), `reportOmpCheck` (`src/llm/registry.ts`), `formatModelString`.
- Produces:
  ```ts
  // core-worker.ts
  ompProbeContext(): { cfg: OmpConfig; ctx: PathContext };
  // src/omp/omp-probe-cli.ts (new, so cli.ts stays a thin dispatcher)
  export async function runOmpProbeCli(d: { store: RunStore; env: NodeJS.ProcessEnv; cwd: string; out: (line: string) => void;
    runner?: Pick<OmpProbeRunner, "probeNow">; versionCheck?: () => Promise<OmpCheckResult> }): Promise<number>;
  ```

**Behaviour (spec §3 Boot, §5 Manual, binding):**
- `CoreWorker.ompProbeContext()` returns `{ cfg: this.ompConfig(), ctx: this.ompPathContext() }`.
- Daemon boot, after the catalog read and before `bootPlanners`:
  ```ts
  await startOmpProbe(options, worker);
  ```
  ```ts
  /** Spec §3 Boot: one bounded version check, its incident as any check's, and the probe runner as the new-version listener. */
  async function startOmpProbe(options: RunTelegramDaemonOptions, worker: CoreWorker): Promise<void> {
    try {
      const { cfg, ctx } = worker.ompProbeContext();
      const cache = sharedOmpVersionCache(cfg);
      const runner = createOmpProbeRunner({ store: options.store, cfg, ctx, roles: worker.modelRoles(),
        currentVersion: () => cache.lastVersion(), signal: options.stopSignal });
      cache.setNewVersionListener((v) => runner.maybeProbe(v));
      reportOmpCheck(options.store, cfg, await cache.current());
    } catch (error) {
      console.error(`[telegram-daemon] omp probe start failed: ${errorCode(error)}`);
    }
  }
  ```
  A test-injected `options.llmAdapter` daemon (hermetic tests) must still not reach a real omp: the stub omp returns not_runnable, so the listener never fires; assert that in the test.
- `houge omp probe` in `cli.ts`: `if (rest[0] !== "probe") { usage; exit 1 }`, tombstone check as the `jev` branch does, open `RunStore.open("houge.sqlite", storeOptions)`, `process.exit(await runOmpProbeCli({ store, env: process.env, cwd: process.cwd(), out: (l) => console.log(l) }))`, closing the store in `finally`.
- `runOmpProbeCli`: build roles `new RoleResolver({ store, readCatalog: () => readOmpCatalog(resolveOmpCatalogConfig(env)) })` and `await roles.refreshCatalog()`; `cfg = resolveOmpConfig(env, roles.chains())`; `ctx = { home: homedir(), repo: cwd, data: env.HOUGE_OMP_DATA_DIR ?? cwd, binDirs: installedBinaryDirs(env, process.execPath) }` — first confirm how the daemon's `options.omp.dataDir` is set at launch (`grep -rn "dataDir" src/index.ts src/cli.ts src/omp/omp-config.ts src/telegram`) and use the same source; record it in the report. Version: `versionCheck ?? (() => sharedOmpVersionCache(cfg).current())`; not ok → print `omp unavailable: <reason>`, return 3. Else `r = await (runner ?? createOmpProbeRunner({…, currentVersion: () => version, signal: new AbortController().signal})).probeNow(version)`; print one line per check `  <check padded to 14>  <outcome>`, then `omp <version>: <result> (model <model>)`; return `{pass: 0, fail: 1, inconclusive: 2}[r.result]`.

- [ ] **Step 1: Write the failing tests**
  - Daemon: (a) with a shared cache installed for the worker's cfg that returns `ok 18.7.0` and a fake runner seam — inject by installing a cache whose `setNewVersionListener` records the callback and whose `current()` invokes it — assert boot registered the listener and called `current()` once, and `reportOmpCheck` resolved any open `omp_unavailable` (seed one; expect it resolved). (b) default hermetic boot (stub omp): `omp_unavailable` opened once, boot completed, no probe row. Comment: "an idle daemon must still learn its omp version at boot and start the probe; a broken omp must page as before and never stop boot".
  - CLI: `runOmpProbeCli` with a fake runner returning `pass` → exit 0 and the seven lines + summary printed; `fail` → 1; `inconclusive` → 2; `versionCheck` not ok → 3 and the runner never called.
- [ ] **Step 2: Run to verify they fail** (`npx vitest run tests/telegram/telegram-daemon-omp-probe.test.ts tests/omp/omp-probe-cli.test.ts`)
- [ ] **Step 3: Implement** to the behaviour block.
- [ ] **Step 4: Run** `npm run typecheck && npm test && npm run build`. Expected: all green, none skipped.
- [ ] **Step 5: Commit**

```bash
git add src/core/core-worker.ts src/telegram/telegram-daemon.ts src/cli.ts src/omp/omp-probe-cli.ts tests/telegram/telegram-daemon-omp-probe.test.ts tests/omp/omp-probe-cli.test.ts
git commit -m "feat(omp): boot version check starts the contract probe; houge omp probe"
```

---

### Task 7: Live gate

**Files:**
- Create: `scripts/live-gate-omp-probe.mjs`

**Behaviour (spec §7, binding).** Model the script on an existing gate (`scripts/live-gate-jev-triage.mjs`: DB copy via `VACUUM INTO`, env loading, `../dist/` imports, PASS/FAIL tally, non-zero exit on any FAIL). No test seam: this is the live run. It must:
1. Copy `houge.sqlite` with `VACUUM INTO` into a temp dir; run everything against the copy; `HOUGE_TELEGRAM_CHAT_ID` set so a page enqueues into the copy's outbox (never sent: no dispatcher runs).
2. Use a data dir inside the temp dir for `ctx.data` (so Seatbelt profiles and probe dirs land there), sandbox on.
3. Step 1: real omp, `probeNow(version)` → expect `result === "pass"`, all seven `pass`, `usage.output_tokens > 0`, one `omp_contract_probe` row, no open `omp_contract_drift`.
4. Step 2: write a bash wrapper into the temp dir with the real omp path and the log path baked into its text (the child env allowlist would drop extra env vars), then `chmod 755`:
   ```bash
   #!/bin/bash
   echo "$*" >> '<LOG>'
   if [ "$1" = "--version" ] || [ '<REWRITE>' = 0 ]; then exec '<REAL_OMP>' "$@"; fi
   exec '<REAL_OMP>' "$@" 2> >(sed -u 's/not found/is unknown/' >&2)
   ```
   `exec` keeps omp's exit status and stdout untouched; only stderr is rewritten. Point `HOUGE_OMP_BIN` at it (REWRITE=1), clear the shared caches (`setSharedOmpVersionCacheForTest(null)`), `probeNow` → expect `result === "fail"`, `checks.start_refusal === "fail:unclassified"`, one open `omp_contract_drift` with subject `omp:<version>`, one outbox row for it.
5. Step 3: rewrite the wrapper with REWRITE=0 (it still logs each argv line). Fresh shared cache. Three `spawnOneShot` calls with chain `[houge-probe/no-such-model]` (no prompt is ever answered; each fails fast) through the real default (no `versionCheck`) → the log has exactly 1 `--version` line; `touch` the wrapper; one more call → exactly 2.
6. Print each step PASS/FAIL with the evidence, exit 1 on any FAIL. Clean the temp dir.

- [ ] **Step 1:** Write the script. **Step 2:** `npm run build && node scripts/live-gate-omp-probe.mjs`; all three steps PASS. **Step 3:** Commit:
```bash
git add scripts/live-gate-omp-probe.mjs
git commit -m "test(omp): live gate for the contract probe and the version cache"
```
