import { execFileAsync } from "../run/exec-file-async.js";
import { daemonTmpRoot } from "../run/daemon-tmp.js";
import { buildChildEnv } from "./child-env.js";
import { parseModelString, type OmpEffort } from "./model-string.js";
import type { CatalogModel } from "./model-roles.js";
import type { OmpConfig } from "./omp-config.js";

/** The exec seam (tests inject a fake; production is the promisified execFile). */
export type ExecFileAsync = typeof execFileAsync;
/** One catalog read never holds boot or a tick longer than this (the child is SIGTERMed). */
export const CATALOG_TIMEOUT_MS = 15_000;
const CATALOG_MAX_BYTES = 8 * 1024 * 1024;
const EFFORTS: ReadonlySet<string> = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** One catalog entry, or null. An id the selector syntax cannot carry (e.g. ollama's `name:tag`) is never a candidate. */
function catalogEntry(raw: unknown): CatalogModel | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { provider, id, thinking } = raw as Record<string, unknown>;
  if (typeof provider !== "string" || typeof id !== "string") return null;
  try { parseModelString(`${provider}/${id}`); } catch { return null; }
  if (thinking === null || thinking === undefined) return { provider, id, thinking: null };
  if (!Array.isArray(thinking)) return null;
  const levels = thinking.filter((t): t is OmpEffort => typeof t === "string" && EFFORTS.has(t));
  return { provider, id, thinking: levels.length > 0 ? levels : null };
}

/** `omp models --json` output → validated entries; null when it is not `{models: [...]}` with at least one usable entry. */
export function parseOmpCatalog(json: string): CatalogModel[] | null {
  let doc: unknown;
  try { doc = JSON.parse(json); } catch { return null; }
  const models = typeof doc === "object" && doc !== null ? (doc as { models?: unknown }).models : undefined;
  if (!Array.isArray(models)) return null;
  const out = models.map(catalogEntry).filter((m): m is CatalogModel => m !== null);
  return out.length > 0 ? out : null;
}

/**
 * One session-less `omp --profile <p> models --json` (spec §4; Decision 1: the catalog is the authority). Bounded by
 * CATALOG_TIMEOUT_MS, run under the allowlisted child env like every omp spawn (ADR 0015). Never throws: any failure is
 * null, and the caller keeps its last good catalog and ledgers the miss.
 */
export async function readOmpCatalog(cfg: Pick<OmpConfig, "bin" | "profile" | "envPassthrough">, exec: ExecFileAsync = execFileAsync): Promise<CatalogModel[] | null> {
  try {
    const env = { ...buildChildEnv(cfg.envPassthrough), TMPDIR: daemonTmpRoot() };
    const { stdout } = await exec(cfg.bin, ["--profile", cfg.profile, "models", "--json"], { timeout: CATALOG_TIMEOUT_MS, maxBuffer: CATALOG_MAX_BYTES, env });
    return parseOmpCatalog(stdout);
  } catch (error) {
    const e = error as { code?: unknown; signal?: unknown };
    console.warn(`[model-catalog] omp models failed: ${String(e.code ?? e.signal ?? "error")}`);
    return null;
  }
}
