// The voice leg's model, resolved from agy's own catalog (`agy models`) instead of a pinned version (Paco, 2026-10-07:
// no hard-coded model versions): the highest-versioned Gemini Flash at low effort.
import { daemonTmpRoot } from "../../run/daemon-tmp.js";
import { buildChildEnv, type SpawnImpl } from "../../omp/child-env.js";

export interface AgyModel { id: string; name: string }

/** One resolution per window: the listing costs seconds and the catalog moves in days, not per voice note. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** A failed listing is remembered briefly, so a stalled `agy models` costs one voice note its timeout, not every one. */
const FAILURE_TTL_MS = 10 * 60 * 1000;
/** The live listing answers in about 2 s; the bound keeps a stall well inside the voice stage deadline. */
const LIST_TIMEOUT_MS = 10_000;
const LIST_MAX_BYTES = 65_536;
const VOICE_MODEL_ID = /^gemini-(\d+(?:\.\d+)*)-flash-low$/;
/** A display name passed as `--model`: words, spaces, dots, dashes, parentheses; never a leading dash. */
const SAFE_NAME = /^[A-Za-z0-9][\w .()-]{0,63}$/;

let cache: { binary: string; model: string | null; at: number } | undefined;
/** Display names agy refused as retired, with when: excluded from picks for CACHE_TTL_MS even if a stale listing shows them. */
const rejected = new Map<string, number>();

/** `<id>\t<display name>` per line; anything else (the "Fetching…" progress line, an unsafe name) is skipped. */
export function parseAgyModels(stdout: string): AgyModel[] {
  return stdout.split("\n").flatMap((line) => {
    const [id, name, extra] = line.split("\t").map((s) => s.trim());
    return id && name && extra === undefined && SAFE_NAME.test(name) ? [{ id, name }] : [];
  });
}

/** Dotted numeric versions compared part by part: "3.10" is newer than "3.9". */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number); const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The display name (what `--model` takes, live since 2026-09-29) of the highest-versioned Gemini Flash low; null if none. */
export function pickVoiceModel(models: readonly AgyModel[], exclude: ReadonlySet<string> = new Set()): string | null {
  let best: { version: string; name: string } | undefined;
  for (const m of models) {
    const v = exclude.has(m.name) ? undefined : VOICE_MODEL_ID.exec(m.id)?.[1];
    if (v !== undefined && (!best || compareVersions(v, best.version) > 0)) best = { version: v, name: m.name };
  }
  return best?.name ?? null;
}

/** One `agy models` read; null on any failure. Never throws. */
async function listVoiceModel(binary: string, spawnImpl: SpawnImpl, exclude: ReadonlySet<string>): Promise<string | null> {
  try {
    const env = { ...buildChildEnv(process.env.HOUGE_AGY_ENV_PASSTHROUGH), TMPDIR: daemonTmpRoot() };
    const r = await spawnImpl(binary, ["models"], { timeoutMs: LIST_TIMEOUT_MS, cwd: daemonTmpRoot(), env, maxBytes: LIST_MAX_BYTES, input: "" });
    return r.code === 0 && !r.timedOut && !r.spawnError ? pickVoiceModel(parseAgyModels(r.stdout), exclude) : null;
  } catch (error) {
    console.warn(`[agy] model listing failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * The cached voice model, else a fresh `agy models` read. A success is cached 6 h; a failure (null: the caller passes no
 * `--model`, so agy uses its own default) is cached 10 min, then retried. Never throws.
 */
export async function resolveAgyVoiceModel(binary: string, spawnImpl: SpawnImpl, now: number = Date.now()): Promise<string | null> {
  if (cache && cache.binary === binary && now - cache.at < (cache.model === null ? FAILURE_TTL_MS : CACHE_TTL_MS)) return cache.model;
  for (const [name, at] of rejected) if (now - at >= CACHE_TTL_MS) rejected.delete(name);
  const model = await listVoiceModel(binary, spawnImpl, new Set(rejected.keys()));
  if (model === null) console.warn("[agy] no Gemini Flash low model from `agy models`; using agy's default model");
  cache = { binary, model, at: now };
  return model;
}

/**
 * agy refused `model` as retired: drop the cache and exclude that name from picks for CACHE_TTL_MS, so a stale listing
 * that still shows it cannot cache it again (the next pick is the next-best Flash low, or null = agy's own default).
 */
export function invalidateAgyVoiceModel(model: string, now: number = Date.now()): void {
  cache = undefined;
  rejected.set(model, now);
}

/** @internal Tests only. */
export function resetAgyModelCacheForTest(): void {
  cache = undefined;
  rejected.clear();
}
