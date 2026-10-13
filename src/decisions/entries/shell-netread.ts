import type { Entry, RungAnswer } from "../types.js";

/**
 * `tool.shell_netread` (spec §7.2): does a shell command read from the network? Best effort and code only. It decides only
 * the trust level (a miss costs a missed `untrusted`, never a missed judgement: every shell output is judged, §7.1). Kept
 * apart from tool.shell_class, which keeps today's approval classification untouched.
 */
export type NetreadVerdict = "local" | "network";
export type NetreadReason = "net_program" | "host_program" | "git_remote" | "script_net";
const NET_PROGRAMS: ReadonlySet<string> = new Set(["curl", "wget", "http", "https", "httpie", "xh", "nc", "ncat", "netcat", "telnet", "ftp", "sftp", "aria2c", "lynx", "w3m"]);
const HOST_PROGRAMS: ReadonlySet<string> = new Set(["ssh", "scp", "rsync"]);
const GIT_REMOTE: ReadonlySet<string> = new Set(["fetch", "clone", "pull", "ls-remote", "submodule", "remote"]);
const SCRIPTERS: ReadonlySet<string> = new Set(["python", "python3", "node", "deno", "bun", "ruby", "perl", "php"]);
const SCRIPT_NET = /\b(?:urllib|requests|http\.client|httpx|aiohttp|socket|fetch\s*\(|axios|node-fetch|https?:\/\/|Net::HTTP|LWP)/;
/** A host operand: user@host, host:path (not a ./ or / local path). */
const HOST_ARG = /^(?:[\w.-]+@)?[\w.-]+:(?!\/\/)|^[\w.-]+@[\w.-]+$/;

const words = (segment: string): string[] => segment.trim().split(/\s+/).map((w) => w.replace(/^["']|["']$/g, "")).filter(Boolean);
const base = (w: string): string => w.slice(w.lastIndexOf("/") + 1);

/** Words that run the next word as the command (env, sudo, xargs, …); their flags, numbers and VAR=value come before it. */
const WRAPPERS: ReadonlySet<string> = new Set(["env", "sudo", "xargs", "time", "nohup", "nice", "command", "exec", "timeout", "caffeinate"]);

/** The index of the word that runs (the program), past VAR=value assignments and wrappers; -1 when none. */
function programIndex(ws: string[]): number {
  let wrapped = false;
  for (let k = 0; k < ws.length; k++) {
    const w = ws[k]!;
    if (/^\w+=/.test(w) || (wrapped && (w.startsWith("-") || /^\d+$/.test(w)))) continue;
    if (WRAPPERS.has(base(w))) { wrapped = true; continue; }
    return k;
  }
  return -1;
}

/** Only the program position counts: `grep -rn http src` names no network reader, `xargs curl` does. */
function segmentReason(ws: string[], whole: string): NetreadReason | null {
  const k = programIndex(ws);
  if (k < 0) return null;
  const w = base(ws[k]!);
  const args = ws.slice(k + 1);
  if (NET_PROGRAMS.has(w)) return "net_program";
  if (HOST_PROGRAMS.has(w) && (w === "ssh" || args.some((a) => HOST_ARG.test(a)))) return "host_program";
  if (w === "git" && args.some((a) => GIT_REMOTE.has(a))) return "git_remote";
  if (SCRIPTERS.has(w) && args.some((a) => a === "-c" || a === "-e") && SCRIPT_NET.test(whole)) return "script_net";
  return null;
}

export function isNetworkCommand(command: string): { network: boolean; reason: NetreadReason | null } {
  for (const seg of command.split(/[;&|()\n`]|\$\(|\bdo\b|\bthen\b/)) {
    const reason = segmentReason(words(seg), command);
    if (reason) return { network: true, reason };
  }
  return { network: false, reason: null };
}

function netreadRule(s: { command: string }): RungAnswer<NetreadVerdict> {
  const r = isNetworkCommand(s.command);
  return r.network ? { verdict: "network", reason: r.reason! } : { verdict: "local" };
}

export const TOOL_SHELL_NETREAD: Entry<{ command: string }, NetreadVerdict> = {
  id: "tool.shell_netread", version: 1, stage: "post_tool", input: "tool",
  question: "Does this shell command read from the network?",
  verdicts: ["local", "network"],
  ladder: [{ kind: "rule", name: "patterns", decide: netreadRule }],
  fail: "network", monotone: { order: ["local", "network"] }, defaultVerdict: "local",
  outcomes: [], armed: { rule: "on" },
  effects: { local: { kind: "none", reversible: true, announced: "none" }, network: { kind: "tighten", reversible: true, announced: "none", what: "the turn rises to untrusted" } },
  reasonCodes: ["net_program", "host_program", "git_remote", "script_net"]
};
