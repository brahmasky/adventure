import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { operationalWriteDeny, protectedRepoPaths, realpathOrSelf, secretPaths, writableExceptions, writeRoots, type PathContext } from "./protected-paths.js";

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
    ...writeDeny.flatMap((p) => rule("file-write*", p)),
    ...exceptions.flatMap(allowWrite),
    // the allow subpath also matches the root itself: pin the root so it cannot be moved or replaced by a symlink
    ...exceptions.flatMap((r) => variants(r).map((v) => `(deny file-write* (literal "${esc(v)}"))`)),
    ...ancestorRules([...writeDeny, ...secrets]),
    // secrets last: SBPL takes the last matching rule, so no allow above can re-open a secret
    ...secrets.flatMap((p) => rule("file-read* file-write*", p)),
    "(deny signal (target others))",
    '(deny process-exec (literal "/bin/launchctl"))',
    '(deny mach-lookup (global-name "com.apple.launchd"))'
  ];
}

export function renderSeatbelt(ctx: PathContext): { planner: string; shell: string } {
  return { planner: `${body(ctx, "planner").join("\n")}\n`, shell: `${body(ctx, "shell").join("\n")}\n` };
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
