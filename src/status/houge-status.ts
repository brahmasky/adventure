import { statSync } from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";
import { resolveGlobalBudgetCaps, type GlobalBudgetHeadroom } from "../budget/global-budget-ledger.js";
import { disarmPosturePresent } from "../config/disarm-posture.js";
import { formatModelString } from "../omp/model-string.js";
import { resolveOmpConfig } from "../omp/omp-config.js";
import { resolveLocalTimeZone } from "../prompt/tz-convert.js";
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
 */
export function classifyBoot(i: {
  marker: boolean; parked: boolean; previous: { stopped_at: string | null } | null; hostBootedAt: string;
}): BootReason {
  if (i.marker) return "self_write_reload";
  if (i.parked) return "revive_after_kill";
  if (!i.previous) return "unknown";
  if (i.previous.stopped_at === null) return "crash_recovery";
  return Date.parse(i.hostBootedAt) > Date.parse(i.previous.stopped_at) ? "restart" : "kickstart";
}

/** When the host last booted (os uptime): a clean stop before it means the host restarted in between. */
export function hostBootedAt(now: Date = new Date()): string {
  return new Date(now.getTime() - uptime() * 1000).toISOString();
}

export interface BootCode { head_sha: string | null; head_subject: string | null; head_committed_at: string | null; dist_built_at: string | null }

/** HEAD sha, subject and commit time of the project root, and the dist build time. Read once at boot; never throws. */
export function readBootCode(projectRoot: string, distDir: string): BootCode {
  let head: string[] = [];
  try {
    head = hardenedGitSync(["-C", projectRoot, "log", "-1", "--format=%H%x1f%s%x1f%cI"]).trim().split("\x1f");
  } catch { /* not a repo, or git unavailable: the status says unknown */ }
  let dist: string | null = null;
  try { dist = statSync(join(distDir, "omp", "extension", "houge.js")).mtime.toISOString(); } catch { /* no build */ }
  const iso = head[2] ? new Date(head[2]) : null;
  return {
    head_sha: head[0] || null, head_subject: head[1] ?? null,
    head_committed_at: iso && !Number.isNaN(iso.getTime()) ? iso.toISOString() : null, dist_built_at: dist
  };
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

function chainTops(env: NodeJS.ProcessEnv): { planner: string; reader: string } {
  try {
    const cfg = resolveOmpConfig(env);
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

export function collectHougeStatus(d: {
  store: RunStore; env: NodeJS.ProcessEnv; chatId: string; pid: number; now?: Date; supervisor?: StatusSupervisor;
}): HougeStatusInput {
  const now = (d.now ?? new Date()).toISOString();
  const tops = chainTops(d.env);
  const answered = d.supervisor?.answeredModel() ?? d.store.lastPlannerModel(d.chatId) ?? undefined;
  return {
    now, tz: resolveLocalTimeZone(d.env), pid: d.pid, boot: d.store.getLatestDaemonBoot(), lastMerge: d.store.getLastSelfWriteMerge(),
    omp: d.supervisor?.ompVersion() ?? null, plannerTop: tops.planner, readerTop: tops.reader,
    answeredBy: answered ? `${answered.provider}/${answered.model}` : null,
    incidentKinds: d.store.listOpenIncidents().map((i) => i.kind),
    budget: d.store.globalBudgetUsage(resolveGlobalBudgetCaps(d.env), now),
    posture: postureOf(d.env), lastPoll: d.store.getPollHeartbeat()?.last_success_at ?? null
  };
}

const clip = (s: string, n: number): string => {
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
  const subject = b.head_subject !== null ? ` "${clip(b.head_subject, SUBJECT_CHARS)}"` : "";
  const stale = b.head_committed_at && b.dist_built_at && Date.parse(b.head_committed_at) > Date.parse(b.dist_built_at)
    ? "; STALE: HEAD is newer than dist (built code is old)" : "";
  return `Code: HEAD ${short(b.head_sha)}${subject}; dist built ${localStamp(b.dist_built_at, i.tz)}${stale}`;
}

function mergeLine(i: HougeStatusInput): string {
  const m = i.lastMerge;
  if (!m) return "Last self-write merge: none recorded";
  const pending = m.pending ? " (merged, not live until restart)" : "";
  return `Last self-write merge: ${clip(m.branch, SUBJECT_CHARS)} ${short(m.sha)} at ${localStamp(m.merged_at, i.tz)}${pending}`;
}

function healthLine(i: HougeStatusInput): string {
  const kinds = [...new Set(i.incidentKinds)].sort();
  const listed = kinds.slice(0, 4).map((k) => clip(k, 40)).join(", ") + (kinds.length > 4 ? `, +${kinds.length - 4} more` : "");
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
