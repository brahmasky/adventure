import { parseModelChain, type ModelString } from "./model-string.js";

export interface OmpConfig {
  bin: string; profile: string; sandbox: boolean; version: string; versionAllow: string[];
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
  HOUGE_OMP_VERSION: "18.4.4",
  HOUGE_OMP_VERSION_ALLOW: "",
  HOUGE_OMP_PLANNER: "anthropic/claude-opus-5-5:medium,google-antigravity/claude-opus-4-6:medium,kimi-code/k3:low",
  HOUGE_OMP_READER: "google-antigravity/gemini-3.8-flash:low,kimi-code/k3:low,openai-codex/gpt-5.5:low",
  HOUGE_OMP_MEDIA: "google-antigravity/gemini-3.8-flash:low",
  HOUGE_OMP_TICKS: "kimi-code/k3:low",
  HOUGE_OMP_JUDGES: "kimi-code/k3,openai-codex/gpt-5.5,google-antigravity/gemini-3.1-pro",
  HOUGE_OMP_CHAIR: "anthropic/claude-opus-5-5:low",
  HOUGE_OMP_REVIEWER: "kimi-code/k3:high,google-antigravity/claude-opus-4-6:medium",
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

const CHAIN_KEYS: readonly Key[] = [
  "HOUGE_OMP_PLANNER", "HOUGE_OMP_READER", "HOUGE_OMP_MEDIA", "HOUGE_OMP_TICKS", "HOUGE_OMP_JUDGES", "HOUGE_OMP_CHAIR", "HOUGE_OMP_REVIEWER"
];

/** The seat-chain variables resolveOmpConfig would throw on (names only: safe for an incident). Empty = valid. */
export function ompConfigProblems(env: NodeJS.ProcessEnv): string[] {
  return CHAIN_KEYS.filter((k) => {
    try { parseModelChain(read(env, k)); return false; } catch { return true; }
  });
}

export function resolveOmpConfig(env: NodeJS.ProcessEnv): OmpConfig {
  return {
    bin: read(env, "HOUGE_OMP_BIN"),
    profile: read(env, "HOUGE_OMP_PROFILE"),
    sandbox: read(env, "HOUGE_OMP_SANDBOX") !== "0",
    version: read(env, "HOUGE_OMP_VERSION"),
    versionAllow: list(env.HOUGE_OMP_VERSION_ALLOW ?? ""),
    planner: parseModelChain(read(env, "HOUGE_OMP_PLANNER")),
    reader: parseModelChain(read(env, "HOUGE_OMP_READER")),
    media: parseModelChain(read(env, "HOUGE_OMP_MEDIA")),
    ticks: parseModelChain(read(env, "HOUGE_OMP_TICKS")),
    judges: parseModelChain(read(env, "HOUGE_OMP_JUDGES")),
    chair: parseModelChain(read(env, "HOUGE_OMP_CHAIR")),
    reviewer: parseModelChain(read(env, "HOUGE_OMP_REVIEWER")),
    envPassthrough: list(read(env, "HOUGE_OMP_ENV_PASSTHROUGH")),
    turnTimeoutMs: num(env, "HOUGE_OMP_TURN_TIMEOUT_MS"),
    frameIdleMs: num(env, "HOUGE_OMP_FRAME_IDLE_MS"),
    approvalTimeoutMs: num(env, "HOUGE_OMP_APPROVAL_TIMEOUT_MS"),
    oneshotTimeoutMs: num(env, "HOUGE_OMP_ONESHOT_TIMEOUT_MS"),
    idleExitMs: num(env, "HOUGE_OMP_IDLE_EXIT_MS"),
    shellTimeoutMs: num(env, "HOUGE_OMP_SHELL_TIMEOUT_MS"),
    leaseTtlS: num(env, "HOUGE_OMP_LEASE_TTL_S")
  };
}
