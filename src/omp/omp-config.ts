import type { ModelString } from "./model-string.js";
import { staticRoleChains, type RoleChains } from "./model-roles.js";

export interface OmpConfig {
  bin: string; profile: string; sandbox: boolean;
  planner: ModelString[]; reader: ModelString[]; media: ModelString[]; ticks: ModelString[];
  judges: ModelString[]; chair: ModelString[]; reviewer: ModelString[];
  envPassthrough: string[];
  turnTimeoutMs: number; frameIdleMs: number; approvalTimeoutMs: number; oneshotTimeoutMs: number;
  idleExitMs: number; shellTimeoutMs: number; leaseTtlS: number;
}

const DEFAULTS = {
  HOUGE_OMP_BIN: "omp",
  HOUGE_OMP_PROFILE: "houge",
  HOUGE_OMP_SANDBOX: "1",
  HOUGE_OMP_ENV_PASSTHROUGH: "KIMI_CODE_OAUTH_HOST,KIMI_CODE_BASE_URL",
  HOUGE_OMP_TURN_TIMEOUT_MS: "600000",
  HOUGE_OMP_FRAME_IDLE_MS: "180000",
  HOUGE_OMP_APPROVAL_TIMEOUT_MS: "1800000",
  HOUGE_OMP_ONESHOT_TIMEOUT_MS: "120000",
  HOUGE_OMP_IDLE_EXIT_MS: "3600000",
  HOUGE_OMP_SHELL_TIMEOUT_MS: "120000",
  HOUGE_OMP_LEASE_TTL_S: "120"
} as const;

export const OMP_ENV_VARS: readonly string[] = Object.keys(DEFAULTS);

type Key = keyof typeof DEFAULTS;
const read = (env: NodeJS.ProcessEnv, k: Key): string => {
  const v = env[k]?.trim();
  return v && v.length > 0 ? v : DEFAULTS[k];
};
const num = (env: NodeJS.ProcessEnv, k: Key): number => {
  const n = Number(read(env, k));
  return Number.isFinite(n) && n > 0 ? n : Number(DEFAULTS[k]);
};
const list = (s: string): string[] => s.split(",").map((x) => x.trim()).filter(Boolean);

/** The seven seat-chain variables the model roles replaced (spec 2026-10-06 §4.2): a set one is ignored and named once at boot. */
export const RETIRED_OMP_CHAIN_VARS: readonly string[] = [
  "HOUGE_OMP_PLANNER", "HOUGE_OMP_READER", "HOUGE_OMP_MEDIA", "HOUGE_OMP_TICKS", "HOUGE_OMP_JUDGES", "HOUGE_OMP_CHAIR", "HOUGE_OMP_REVIEWER"
];
const warnedRetired = new Set<string>();

/** Names every retired chain variable still set, once per process per name (a stale .env is visible, never fatal). Returns the names warned. */
export function warnRetiredOmpChainVars(env: NodeJS.ProcessEnv, warn: (line: string) => void = console.warn): string[] {
  const set = RETIRED_OMP_CHAIN_VARS.filter((k) => (env[k]?.trim() ?? "").length > 0 && !warnedRetired.has(k));
  for (const k of set) warnedRetired.add(k);
  if (set.length > 0) warn(`[omp-config] ${set.join(", ")} no longer read: model roles replace the seat chains (src/omp/model-roles.ts, /models to override)`);
  return set;
}

/** HOUGE_OMP_APPROVAL_TIMEOUT_MS alone (never throws on an unrelated malformed chain): the sweep needs only this. */
export function resolveApprovalTimeoutMs(env: NodeJS.ProcessEnv): number { return num(env, "HOUGE_OMP_APPROVAL_TIMEOUT_MS"); }

/**
 * The three fields the catalog read needs, alone (F5): none of them throws, so a malformed lease TTL never makes the
 * RoleResolver's read fail and fake a model_catalog_unavailable page.
 */
export function resolveOmpCatalogConfig(env: NodeJS.ProcessEnv): Pick<OmpConfig, "bin" | "profile" | "envPassthrough"> {
  return { bin: read(env, "HOUGE_OMP_BIN"), profile: read(env, "HOUGE_OMP_PROFILE"), envPassthrough: list(read(env, "HOUGE_OMP_ENV_PASSTHROUGH")) };
}

/** The supervisor renews a planner lease this often (spec §7.1). */
export const PLANNER_HEARTBEAT_MS = 30_000;
/** A lease shorter than three renewals lets the recovery timer fail a live turn between two heartbeats (N2). */
export const MIN_LEASE_TTL_S = (3 * PLANNER_HEARTBEAT_MS) / 1000;

/** The variables resolveOmpConfig would throw on (names only: safe for an incident). Empty = valid. */
export function ompConfigProblems(env: NodeJS.ProcessEnv): string[] {
  return num(env, "HOUGE_OMP_LEASE_TTL_S") < MIN_LEASE_TTL_S ? ["HOUGE_OMP_LEASE_TTL_S"] : [];
}

function leaseTtl(env: NodeJS.ProcessEnv): number {
  const ttl = num(env, "HOUGE_OMP_LEASE_TTL_S");
  if (ttl < MIN_LEASE_TTL_S) throw new Error(`HOUGE_OMP_LEASE_TTL_S must be at least ${MIN_LEASE_TTL_S} (3x the ${PLANNER_HEARTBEAT_MS / 1000} s heartbeat)`);
  return ttl;
}

/** The omp config. Its seven seat chains come from the caller: a RoleResolver's `chains()`, else the static role lists (today's chains). */
export function resolveOmpConfig(env: NodeJS.ProcessEnv, chains: RoleChains = staticRoleChains()): OmpConfig {
  return {
    bin: read(env, "HOUGE_OMP_BIN"),
    profile: read(env, "HOUGE_OMP_PROFILE"),
    sandbox: read(env, "HOUGE_OMP_SANDBOX") !== "0",
    planner: chains.planner,
    reader: chains.reader,
    media: chains.media,
    ticks: chains.ticks,
    judges: chains.judges,
    chair: chains.chair,
    reviewer: chains.reviewer,
    envPassthrough: list(read(env, "HOUGE_OMP_ENV_PASSTHROUGH")),
    turnTimeoutMs: num(env, "HOUGE_OMP_TURN_TIMEOUT_MS"),
    frameIdleMs: num(env, "HOUGE_OMP_FRAME_IDLE_MS"),
    approvalTimeoutMs: num(env, "HOUGE_OMP_APPROVAL_TIMEOUT_MS"),
    oneshotTimeoutMs: num(env, "HOUGE_OMP_ONESHOT_TIMEOUT_MS"),
    idleExitMs: num(env, "HOUGE_OMP_IDLE_EXIT_MS"),
    shellTimeoutMs: num(env, "HOUGE_OMP_SHELL_TIMEOUT_MS"),
    leaseTtlS: leaseTtl(env)
  };
}
