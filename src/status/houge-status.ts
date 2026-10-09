import { statSync } from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";
import { resolveGlobalBudgetCaps, type GlobalBudgetHeadroom } from "../budget/global-budget-ledger.js";
import { disarmPosturePresent } from "../config/disarm-posture.js";
import { formatModelString } from "../omp/model-string.js";
import { resolveOmpConfig } from "../omp/omp-config.js";
import { sharedOmpVersionCache } from "../omp/omp-version-cache.js";
import type { RoleChains } from "../omp/model-roles.js";
import { resolveLocalTimeZone } from "../prompt/tz-convert.js";
import { newestMtimeMs } from "../capabilities/self-write-merge.js";
import { hardenedGitSync } from "../run/git-hardened.js";
import type { DaemonBoot, RunStore, SelfWriteMergeRecord } from "../run/run-store.js";
import { readParkMarker, readTombstone } from "../run/tombstone.js";

/**
 * houge_status (2026-10-02): what the planner needs to answer "did you restart, why, and which code
 * is live" from Houge's own state. Live: after a self-write reload Houge told Paco it could not see
 * the daemon start time and asked him to kickstart a daemon that had already restarted itself.
 * Every value is code-owned or Houge's own state; nothing here reads an env VALUE into the output.
 */

/** Why the daemon booted. `restart` = a clean stop whose cause cannot be told apart (host reboot, unload, …). */
export type BootReason = "self_write_reload" | "kickstart" | "revive_after_kill" | "crash_recovery" | "restart" | "unknown";

export const HOUGE_STATUS_MAX_CHARS = 1200;
/** The built artifact whose mtime stands for the dist build time (repo-relative, as rendered). */
export const DIST_ARTIFACT = "dist/omp/extension/houge.js";
const SUBJECT_CHARS = 60;

/**
 * The boot reason from what the daemon knows at boot: a consumed reload marker, the park marker
 * (left by a /kill park), and whether the previous boot recorded a clean stop. A clean stop with
 * the host up throughout is an operator restart (kickstart); after a host reboot it is only `restart`.
 * No clean stop is a crash, unless the host rebooted after that daemon started (power loss): `restart`.
 */
export function classifyBoot(i: {
  marker: boolean; parked: boolean; previous: { started_at: string; stopped_at: string | null } | null; hostBootedAt: string;
}): BootReason {
  if (i.marker) return "self_write_reload";
  if (i.parked) return "revive_after_kill";
  if (!i.previous) return "unknown";
  const host = Date.parse(i.hostBootedAt);
  // no clean stop, but the host itself rebooted while that daemon ran (power loss): not a daemon crash
  if (i.previous.stopped_at === null) return host > Date.parse(i.previous.started_at) ? "restart" : "crash_recovery";
  return host > Date.parse(i.previous.stopped_at) ? "restart" : "kickstart";
}

/** When the host last booted (os uptime): a clean stop before it means the host restarted in between. */
export function hostBootedAt(now: Date = new Date()): string {
  return new Date(now.getTime() - uptime() * 1000).toISOString();
}

export interface BootCode {
  head_sha: string | null; head_subject: string | null; head_committed_at: string | null;
  /** The newest first-parent commit touching a build input (src, package files, tsconfigs, the asset copier). */
  build_input_committed_at: string | null;
  dist_built_at: string | null;
  /** The newest src .ts mtime is newer than the newest dist .js mtime (an uncommitted edit never built). */
  src_newer_than_dist: boolean;
}

/** What `npm run build` reads: a commit touching none of these (docs, tasks) never makes the dist stale. */
export const BUILD_INPUTS: readonly string[] = [
  "src", "package.json", "package-lock.json", "tsconfig.json", "tsconfig.build.json", "scripts/copy-omp-assets.mjs"
];

const isoOrNull = (raw: string | undefined): string | null => {
  const t = raw ? new Date(raw) : null;
  return t && !Number.isNaN(t.getTime()) ? t.toISOString() : null;
};

/** One git read; [] when the root is not a repo or git is unavailable (the status then says unknown). */
function gitFields(projectRoot: string, args: string[]): string[] {
  try {
    return hardenedGitSync(["-C", projectRoot, ...args]).trim().split("\x1f");
  } catch {
    return [];
  }
}

/** HEAD, the newest build-input commit, the dist build time and the src-vs-dist mtimes. Read once at boot; never throws. */
export function readBootCode(projectRoot: string, distDir: string): BootCode {
  const head = gitFields(projectRoot, ["log", "-1", "--format=%H%x1f%s%x1f%cI"]);
  const input = gitFields(projectRoot, ["log", "-1", "--first-parent", "--format=%cI", "--", ...BUILD_INPUTS]);
  let dist: string | null = null;
  try { dist = statSync(join(distDir, "omp", "extension", "houge.js")).mtime.toISOString(); } catch { /* no build */ }
  const srcNewest = newestMtimeMs(join(projectRoot, "src"), ".ts");
  const distNewest = newestMtimeMs(distDir, ".js");
  return {
    head_sha: head[0] || null, head_subject: head[1] ?? null, head_committed_at: isoOrNull(head[2]),
    build_input_committed_at: isoOrNull(input[0]), dist_built_at: dist,
    src_newer_than_dist: srcNewest !== undefined && (distNewest === undefined || srcNewest > distNewest)
  };
}

/** The one stale-build rule: a build-input commit newer than the dist, or a src edit newer than any dist .js. */
export function isBuildStale(b: Pick<BootCode, "build_input_committed_at" | "dist_built_at" | "src_newer_than_dist">): boolean {
  if (b.src_newer_than_dist) return true;
  return b.build_input_committed_at !== null && b.dist_built_at !== null && Date.parse(b.build_input_committed_at) > Date.parse(b.dist_built_at);
}

/** What the chat's planner supervisor knows: the version its spawn check read, and the model that last answered. */
export interface StatusSupervisor {
  ompVersion(): string | null;
  answeredModel(): { provider: string; model: string } | undefined;
}

export interface HougeStatusInput {
  now: string; tz: string; pid: number; boot: DaemonBoot | null; lastMerge: SelfWriteMergeRecord | null;
  omp: string | null; plannerTop: string; readerTop: string; answeredBy: string | null;
  incidentKinds: string[]; budget: GlobalBudgetHeadroom[]; posture: string[]; lastPoll: string | null;
}

function chainTops(env: NodeJS.ProcessEnv, chains?: RoleChains): { planner: string; reader: string } {
  try {
    const cfg = resolveOmpConfig(env, chains);
    return { planner: formatModelString(cfg.planner[0]!), reader: formatModelString(cfg.reader[0]!) };
  } catch {
    return { planner: "unknown (config invalid)", reader: "unknown (config invalid)" };
  }
}

function postureOf(env: NodeJS.ProcessEnv): string[] {
  return [
    ...(readTombstone(env) ? ["killed"] : []), ...(readParkMarker(env) ? ["parked"] : []), ...(disarmPosturePresent(env) ? ["disarmed"] : [])
  ];
}

/** The shared cache's last ok version (the daemon's boot check fills it); null when the config is invalid or nothing passed yet. */
function cachedOmpVersion(env: NodeJS.ProcessEnv): string | null {
  try { return sharedOmpVersionCache(resolveOmpConfig(env)).lastVersion(); } catch { return null; }
}

export function collectHougeStatus(d: {
  store: RunStore; env: NodeJS.ProcessEnv; chatId: string; pid: number; now?: Date; supervisor?: StatusSupervisor; chains?: RoleChains;
}): HougeStatusInput {
  const now = (d.now ?? new Date()).toISOString();
  const tops = chainTops(d.env, d.chains);
  const live = d.supervisor?.answeredModel();
  const recorded = live ? null : d.store.lastPlannerModel(d.chatId);
  return {
    now, tz: resolveLocalTimeZone(d.env), pid: d.pid, boot: d.store.getLatestDaemonBoot(), lastMerge: d.store.getLastSelfWriteMerge(),
    omp: cachedOmpVersion(d.env) ?? d.supervisor?.ompVersion() ?? null, plannerTop: tops.planner, readerTop: tops.reader,
    answeredBy: live ? `${live.provider}/${live.model}` : recorded ? `${recorded.provider}/${recorded.model} (last recorded)` : null,
    incidentKinds: d.store.listOpenIncidents().map((i) => i.kind),
    budget: d.store.globalBudgetUsage(resolveGlobalBudgetCaps(d.env), now),
    posture: postureOf(d.env), lastPoll: d.store.getPollHeartbeat()?.last_success_at ?? null
  };
}

/** One line, at most `n` chars (an ellipsis marks a cut). */
export const clipText = (s: string, n: number): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : `${flat.slice(0, n - 1)}…`;
};
const short = (sha: string | null): string => (sha ? sha.slice(0, 7) : "unknown");

/** `YYYY-MM-DD HH:MM` in `tz`; "unknown" for a missing or unparseable instant. */
export function localStamp(iso: string | null, tz: string): string {
  const t = iso ? new Date(iso) : null;
  if (!t || Number.isNaN(t.getTime())) return "unknown";
  return t.toLocaleString("sv-SE", { timeZone: tz, hour12: false }).slice(0, 16);
}

function duration(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = String(m % 60).padStart(2, "0");
  return d > 0 ? `${d}d${h}h${mm}m` : `${h}h${mm}m`;
}

function daemonLine(i: HougeStatusInput): string {
  const b = i.boot;
  if (!b) return `Daemon: pid ${i.pid}, no boot record (not started by the daemon loop)`;
  const other = b.pid !== i.pid ? ` (boot record is pid ${b.pid})` : "";
  return `Daemon: pid ${i.pid}${other}, started ${b.started_at} (${localStamp(b.started_at, i.tz)} ${i.tz}), ` +
    `up ${duration(Date.parse(i.now) - Date.parse(b.started_at))}`;
}

function codeLine(i: HougeStatusInput): string {
  const b = i.boot;
  if (!b) return "Code: unknown (no boot record)";
  const subject = b.head_subject !== null ? ` "${clipText(b.head_subject, SUBJECT_CHARS)}"` : "";
  const stale = isBuildStale(b) ? "; STALE: dist is older than its sources (rebuild + restart)" : "";
  return `Code: HEAD ${short(b.head_sha)}${subject}; dist built ${localStamp(b.dist_built_at, i.tz)}${stale}`;
}

function mergeLine(i: HougeStatusInput): string {
  const m = i.lastMerge;
  if (!m) return "Last self-write merge: none recorded";
  const pending = m.pending ? " (merged, not live until restart)" : "";
  return `Last self-write merge: ${clipText(m.branch, SUBJECT_CHARS)} ${short(m.sha)} at ${localStamp(m.merged_at, i.tz)}${pending}`;
}

function healthLine(i: HougeStatusInput): string {
  const kinds = [...new Set(i.incidentKinds)].sort();
  const listed = kinds.slice(0, 4).map((k) => clipText(k, 40)).join(", ") + (kinds.length > 4 ? `, +${kinds.length - 4} more` : "");
  const incidents = i.incidentKinds.length > 0 ? `incidents ${i.incidentKinds.length} open (${listed})` : "incidents none open";
  const label = (k: string) => (k === "gated_attempts" ? "gated" : k);
  const breaker = i.budget.map((b) => `${label(b.kind)} ${b.used}/${b.limit}`).join(", ");
  const posture = i.posture.length > 0 ? i.posture.join(", ") : "normal";
  return `Health: ${incidents}; breaker ${breaker}; posture ${posture}; last poll ${localStamp(i.lastPoll, i.tz)}`;
}

/** The status block: short code-rendered lines, no JSON, no env values, bounded to {@link HOUGE_STATUS_MAX_CHARS}. */
export function renderHougeStatus(i: HougeStatusInput): string {
  const b = i.boot;
  const reason = b ? (b.reason === "self_write_reload" ? `${b.reason} ${short(b.reload_sha)}` : b.reason) : "unknown";
  const text = [
    daemonLine(i), `Boot reason: ${reason}`, codeLine(i), mergeLine(i),
    `Runtime: omp ${i.omp ?? "unknown"}; planner top ${i.plannerTop}; last answered by ${i.answeredBy ?? "unknown"}; reader top ${i.readerTop}`,
    healthLine(i)
  ].join("\n");
  return text.length <= HOUGE_STATUS_MAX_CHARS ? text : `${text.slice(0, HOUGE_STATUS_MAX_CHARS - 1)}…`;
}
