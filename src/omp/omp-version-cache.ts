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
    try { accessSync(p, constants.X_OK); if (statSync(p).isFile()) return p; } catch { /* next PATH entry */ }
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
    if (!r.ok || key !== latestKey) return; // a stale or failed answer is returned, never cached
    if (key !== "null") cached = { key, result: r }; // an unstat-able binary is re-checked every call, but still reported
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

const shared = new Map<string, OmpVersionCache>();
const sharedKey = (cfg: BinCfg): string => `${cfg.bin}|${cfg.envPassthrough.join(",")}`;

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
