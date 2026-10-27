import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RoomPair } from "./cleanroom.js";
import { CREDENTIAL_PATTERNS, ENV_TEMPLATE_PATTERNS, operationalWriteDeny, protectedRepoPaths, realpathOrSelf, secretPaths, writableExceptions, writeRoots, type PathContext } from "./protected-paths.js";

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/** Every variant a rule must cover: Seatbelt matches canonical paths, callers may hold either form. */
const variants = (p: string): string[] => [...new Set([p, realpathOrSelf(p)])];

/** subpath always: for a file it is the file itself, so a path that does not exist yet cannot fail open. */
function rule(verbs: string, p: string): string[] {
  return variants(p).map((v) => `(deny ${verbs} (subpath "${esc(v)}"))`);
}

/**
 * Seatbelt checks a rename only against its source and destination, so moving an unprotected ancestor
 * of a denied root would carry the subtree to a path no rule matches. A literal write deny on each
 * ancestor directory blocks that rename while still allowing files to be created inside it.
 */
function ancestorRules(roots: string[]): string[] {
  const out = new Set<string>();
  for (const v of roots.flatMap(variants)) {
    for (let d = dirname(v); d !== "/" && d !== "."; d = dirname(d)) out.add(`(deny file-write* (literal "${esc(d)}"))`);
  }
  return [...out];
}

/**
 * A path as an SBPL regex body. Only [A-Za-z0-9/_-] is kept literally; any other ASCII char becomes `.` and any
 * non-ASCII char `[^/]+`. Both only widen what a DENY matches (fail closed) and no quote or backslash survives.
 */
function regexPath(p: string): string {
  return [...p].map((c) => (/^[A-Za-z0-9/_-]$/.test(c) ? c : c.charCodeAt(0) < 0x80 ? "." : "[^/]+")).join("");
}

/** Top-level `~/.<name>.env` / `~/.env` (protected-paths HOME_DOTENV_NAME): read and write denied, both home spellings. */
function dotenvRules(home: string): string[] {
  return variants(home).map((h) => `(deny file-read* file-write* (regex #"^${regexPath(h)}/\\.([^/]+\\.)?[Ee][Nn][Vv]$"))`);
}

/** Credential files by name (protected-paths CREDENTIAL_PATTERNS), read and write denied, then .env templates re-allowed. */
function credentialRules(home: string): string[] {
  const deny = variants(home).flatMap((h) => CREDENTIAL_PATTERNS.map((b) => `(deny file-read* file-write* (regex #"^${regexPath(h)}${b}$"))`));
  const allow = variants(home).flatMap((h) => ENV_TEMPLATE_PATTERNS.map((b) => `(allow file-read* file-write* (regex #"^${regexPath(h)}${b}$"))`));
  return [...deny, ...allow];
}

/** The device nodes a normal process writes: the null sink, its controlling terminal, and its own fds. */
const DEV_WRITES = ['(allow file-write* (literal "/dev/null"))', '(allow file-write* (literal "/dev/tty"))', '(allow file-write* (subpath "/dev/fd"))'];

const allowWrite = (p: string) => variants(p).map((v) => `(allow file-write* (subpath "${esc(v)}"))`);

/**
 * SBPL takes the LAST matching rule, so order is the policy: default-deny writes; allow the write roots ($HOME, the
 * temp roots, the omp workspace/sessions); deny the repo, the install trees and the code-running dotfiles inside
 * them; re-allow the workspace (and sessions for the planner); pin the roots; secrets last.
 */
function body(ctx: PathContext, kind: "planner" | "shell"): string[] {
  const ompStore = join(ctx.home, ".omp");
  const secrets = kind === "planner" ? secretPaths(ctx).filter((p) => p !== ompStore) : secretPaths(ctx);
  const writeDeny = [...protectedRepoPaths(ctx), ...operationalWriteDeny(ctx)];
  const exceptions = writableExceptions(ctx, kind);
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    ...writeRoots(ctx, kind).flatMap(allowWrite),
    ...DEV_WRITES,
    // before the write denies and the secrets: a later rule wins, so no .env-template allow re-opens a protected tree
    ...credentialRules(ctx.home),
    ...writeDeny.flatMap((p) => rule("file-write*", p)),
    ...exceptions.flatMap(allowWrite),
    // the allow subpath also matches the root itself: pin the root so it cannot be moved or replaced by a symlink
    ...exceptions.flatMap((r) => variants(r).map((v) => `(deny file-write* (literal "${esc(v)}"))`)),
    // and pin every chat dir under them (chat-<id>, which only the daemon creates) the same way: a swapped chat
    // workspace would let the daemon attach files the sandbox denies (security C2)
    ...exceptions.flatMap((r) => variants(r).map((v) => `(deny file-write* (regex #"^${regexPath(v)}/chat-[^/]+$"))`)),
    ...ancestorRules([...writeDeny, ...secrets]),
    // secrets last: SBPL takes the last matching rule, so no allow above can re-open a secret
    ...secrets.flatMap((p) => rule("file-read* file-write*", p)),
    ...dotenvRules(ctx.home),
    "(deny signal (target others))",
    '(deny process-exec (literal "/bin/launchctl"))',
    // the Keychain is reached over Mach IPC, not files: the CLI that asks securityd for a secret must not run
    '(deny process-exec (literal "/usr/bin/security"))',
    '(deny mach-lookup (global-name "com.apple.launchd"))'
  ];
}

export function renderSeatbelt(ctx: PathContext): { planner: string; shell: string } {
  return { planner: `${body(ctx, "planner").join("\n")}\n`, shell: `${body(ctx, "shell").join("\n")}\n` };
}

/** Every ancestor directory of p, canonical and as given, root excluded: bash getcwd needs metadata on each (probe item 3). */
function ancestorsOf(p: string): string[] {
  const out = new Set<string>();
  for (const v of variants(p)) for (let d = dirname(v); d !== "/" && d !== "."; d = dirname(d)) out.add(d);
  return [...out];
}

/**
 * P8 (spec §P8 evidence, measured 2026-10-28): nothing on this host is reachable — loopback in every spelling, the
 * host's own addresses, IPv4-mapped IPv6, UDP of any kind (so no broadcast/multicast path to a local service), Unix
 * sockets but the resolver's, listening, Mach lookups. Families are named on every filter and sit in ONE rule: a bare
 * `ip` filter stops matching IPv4 loopback once any ip6 rule exists, and network rules interact non-locally, so the
 * exact text is pinned and the live matrix re-runs on every edit. Cost: TCP egress only, no IPv6 egress.
 */
export const CLEANROOM_NETWORK_RULES: readonly string[] = [
  "(deny mach-lookup)",
  '(deny network-outbound (remote ip4 "localhost:*") (remote ip6 "*:*") (remote udp4 "*:*"))',
  "(deny network-outbound (remote unix-socket))",
  '(allow network-outbound (literal "/private/var/run/mDNSResponder"))',
  "(deny network-inbound)",
  "(deny network-bind)"
];
/** Root-owned, outside every write set; without them `date` in the room is UTC and a "book tomorrow" command is wrong for hours a day. */
const CLEANROOM_TZ_READS = ['(allow file-read* (literal "/private/etc/localtime"))', '(allow file-read* (subpath "/private/var/db/timezone"))', '(allow file-read* (subpath "/usr/share/zoneinfo"))'];
const CLEANROOM_TZ_META = ["/private", "/private/var", "/private/var/db"];

// No /Library: its world-writable trees (/Library/Caches …) would be readable plants; TLS roots come from /System.
const CLEANROOM_READ_TREES = ["/usr", "/bin", "/System", "/private/etc/ssl"];
/**
 * User-writable trees inside a readable system root, re-denied right after it (last match wins): /usr/local is
 * Homebrew's, owned by the user. The probe showed curl (HTTPS, cookie jar) and bash (loops, pwd) need neither.
 */
const CLEANROOM_READ_HOLES: Record<string, string[]> = { "/usr": ["/usr/local"] };

/**
 * The clean room (decision-ladder design §8.3, probe 13-cleanroom-probe.md): reads deny-default, re-opened only for the
 * system trees, /private/etc/ssl (curl's openssl.cnf; hosts and the resolver are NOT needed — DNS goes over IPC), the
 * room and the fresh home; metadata on the symlinks /etc /var /tmp (DNS) and the room's ancestors (getcwd); writes only
 * in the room; the launchd / security / python3-shim escape hatches closed; the P8 block closes local network and the
 * rest of IPC (CLEANROOM_NETWORK_RULES).
 */
export function renderCleanroom(dirs: RoomPair): string {
  const sub = (p: string) => variants(p).map((v) => `(allow file-read* (subpath "${esc(v)}"))`);
  const meta = (p: string) => `(allow file-read-metadata (literal "${esc(p)}"))`;
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-read*)",
    '(allow file-read* (literal "/"))',
    ...CLEANROOM_READ_TREES.flatMap((t) => [...sub(t), ...(CLEANROOM_READ_HOLES[t] ?? []).map((h) => `(deny file-read* (subpath "${esc(h)}"))`)]),
    '(allow file-read* (literal "/dev/null"))',
    ...CLEANROOM_TZ_READS,
    ...sub(dirs.room),
    ...sub(dirs.home),
    '(allow file-read-data (literal "/"))',
    ...[...new Set(["/", "/etc", "/var", "/tmp", ...CLEANROOM_TZ_META, ...ancestorsOf(dirs.room), ...ancestorsOf(dirs.home)])].map(meta),
    "(deny file-write*)",
    ...variants(dirs.room).map((v) => `(allow file-write* (subpath "${esc(v)}"))`),
    '(allow file-write* (literal "/dev/null"))',
    "(deny signal (target others))",
    '(deny process-exec (literal "/bin/launchctl"))',
    '(deny process-exec (literal "/usr/bin/security"))',
    '(deny process-exec (literal "/usr/bin/python3"))',
    '(deny mach-lookup (global-name "com.apple.launchd"))',
    ...CLEANROOM_NETWORK_RULES
  ].join("\n") + "\n";
}

function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

export function writeSeatbeltProfiles(ctx: PathContext): { planner: string; shell: string } {
  const dir = join(ctx.data, "omp");
  mkdirSync(dir, { recursive: true });
  const r = renderSeatbelt(ctx);
  const paths = { planner: join(dir, "planner.sb"), shell: join(dir, "shell.sb") };
  atomicWrite(paths.planner, r.planner);
  atomicWrite(paths.shell, r.shell);
  return paths;
}
