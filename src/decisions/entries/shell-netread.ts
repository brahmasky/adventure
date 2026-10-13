import type { Entry, RungAnswer } from "../types.js";

/**
 * `tool.shell_netread` (spec §7.2): does a shell command read from the network? Code only, and conservative: a form that
 * cannot be read statically (a shell's `-c`, `eval`, `find -exec`, code on stdin) counts as network. A miss is not cheap:
 * the verdict also marks the output as from outside (Task 12), so a miss frames, rather than withholds, an outside passage
 * that trips the content check, and leaves the turn below hostile. A false positive only tightens (an extra `untrusted`,
 * a local passage withheld instead of framed). Kept apart from tool.shell_class, which keeps today's approvals untouched.
 */
export type NetreadVerdict = "local" | "network";
export type NetreadReason = "net_program" | "host_program" | "git_remote" | "package_fetch" | "indirection";
const NET_PROGRAMS: ReadonlySet<string> = new Set(["curl", "wget", "http", "https", "httpie", "xh", "nc", "ncat", "netcat", "socat", "telnet", "ftp",
  "sftp", "aria2c", "lynx", "w3m", "dig", "nslookup", "host", "whois", "ping", "gh", "npx", "bunx", "uvx", "pipx"]);
const HOST_PROGRAMS: ReadonlySet<string> = new Set(["ssh", "scp", "rsync"]);
const GIT_REMOTE: ReadonlySet<string> = new Set(["fetch", "clone", "pull", "push", "ls-remote", "submodule", "remote"]);
const PACKAGERS: ReadonlySet<string> = new Set(["npm", "pnpm", "yarn", "bun", "pip", "pip3", "uv", "brew", "cargo", "go", "gem", "deno"]);
const PACKAGE_FETCH: ReadonlySet<string> = new Set(["install", "i", "ci", "add", "update", "upgrade", "get", "fetch", "--with", "dlx", "x", "exec", "create", "tap"]);
/** Shells and interpreters: code in a `-c`/`-e` argument or on stdin cannot be read statically. */
const INTERPRETERS: ReadonlySet<string> = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish", "python", "python3", "node", "deno", "bun", "ruby",
  "perl", "php", "osascript", "lua", "tclsh", "pwsh"]);
const CODE_FLAGS: ReadonlySet<string> = new Set(["-c", "-e", "-E", "-r", "--eval", "-p", "--print", "-l", "-lc", "-ic", "-ec", "-xc"]);
/** Words that run a later word as the command; their flags may take values, so every later word is tried as the program. */
const WRAPPERS: ReadonlySet<string> = new Set(["env", "sudo", "doas", "xargs", "time", "nohup", "nice", "command", "exec", "timeout", "caffeinate",
  "stdbuf", "unbuffer", "arch", "builtin", "watch", "parallel"]);
/** A host operand: user@host, host:path (not a ./ or / local path). */
const HOST_ARG = /^(?:[\w.-]+@)?[\w.-]+:(?!\/\/)|^[\w.-]+@[\w.-]+$/;
/** Shell operators and substitutions: each piece between them is classified on its own (any network piece decides). */
const SEGMENT_SPLIT = /&&|\|\||[;&|(){}\n`]|\$\(|\bdo\b|\bthen\b|\belse\b/;

/** One word as the shell runs it: quotes and a leading `\` stripped (`\curl` runs curl). */
const clean = (w: string): string => w.replace(/^["']+|["']+$/g, "").replace(/^\\/, "");
const words = (segment: string): string[] => segment.trim().split(/\s+/).map(clean).filter(Boolean);
const base = (w: string): string => w.slice(w.lastIndexOf("/") + 1);

/** An interpreter whose code cannot be read: a code flag, a here-string or here-doc, or no script operand (code on stdin). */
function opaqueInterpreter(args: string[], segment: string): boolean {
  if (args.some((a) => CODE_FLAGS.has(a) || a === "-" || a === "-s") || /<</.test(segment)) return true;
  return !args.some((a) => !a.startsWith("-"));
}

/** `source`/`.`: a readable local file is local; nothing, stdin, a device or a URL is not. */
const opaqueSource = (args: string[]): boolean => args.length === 0 || /^(?:<|-$|\/dev\/|[a-z]+:\/\/)/.test(args[0]!);

/** The verdict for the program at ws[k] (no wrappers here: programReason handles those). */
function directReason(ws: string[], k: number, segment: string): NetreadReason | null {
  const w = base(ws[k]!);
  const args = ws.slice(k + 1);
  if (NET_PROGRAMS.has(w) || (w === "openssl" && args.includes("s_client"))) return "net_program";
  if (HOST_PROGRAMS.has(w) && (w === "ssh" || args.some((a) => HOST_ARG.test(a)))) return "host_program";
  if (w === "git" && args.some((a) => GIT_REMOTE.has(a))) return "git_remote";
  if (PACKAGERS.has(w) && args.some((a) => PACKAGE_FETCH.has(a))) return "package_fetch";
  if (w === "eval" || ((w === "source" || w === ".") && opaqueSource(args))) return "indirection";
  if (w === "find" && args.some((a) => a === "-exec" || a === "-execdir" || a === "-ok" || a === "-okdir")) return "indirection";
  const m = args.indexOf("-m"); // `python3 -m pip install …` runs the module as the program
  if (INTERPRETERS.has(w) && m >= 0 && m + 1 < args.length) return directReason(ws, k + 2 + m, segment);
  if (INTERPRETERS.has(w) && opaqueInterpreter(args, segment)) return "indirection";
  return null;
}

/** Past VAR=value; a wrapper (whose flags may take values) has every later word tried as the program it runs. */
function programReason(ws: string[], segment: string): NetreadReason | null {
  let k = 0;
  while (k < ws.length && /^\w+=/.test(ws[k]!)) k++;
  if (k >= ws.length) return null;
  if (!WRAPPERS.has(base(ws[k]!))) return directReason(ws, k, segment);
  for (let j = k + 1; j < ws.length; j++) {
    if (/^\w+=/.test(ws[j]!) || WRAPPERS.has(base(ws[j]!))) continue;
    const r = directReason(ws, j, segment);
    if (r) return r;
  }
  return null;
}

export function isNetworkCommand(command: string): { network: boolean; reason: NetreadReason | null } {
  for (const seg of command.split(SEGMENT_SPLIT)) {
    const reason = programReason(words(seg), seg);
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
  reasonCodes: ["net_program", "host_program", "git_remote", "package_fetch", "indirection"]
};
