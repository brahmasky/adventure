import { mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { operationalWriteDeny, protectedRepoPaths, realpathOrSelf, secretPaths, writableExceptions, type PathContext } from "./protected-paths.js";

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/** Not on disk yet: a real extension (or .env) means file; a bare dotdir such as .ssh means directory. */
function looksLikeFile(p: string): boolean {
  const base = p.slice(p.lastIndexOf("/") + 1);
  return base === ".env" || /.\.[a-z0-9-]+$/i.test(base);
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return !looksLikeFile(p); }
}

function rule(verbs: string, p: string): string[] {
  const variants = [...new Set([p, realpathOrSelf(p)])];
  return variants.map((v) => `(deny ${verbs} (${isDir(v) ? "subpath" : "literal"} "${esc(v)}"))`);
}

function body(ctx: PathContext, kind: "planner" | "shell"): string[] {
  const ompStore = join(ctx.home, ".omp");
  const secrets = kind === "planner" ? secretPaths(ctx).filter((p) => p !== ompStore) : secretPaths(ctx);
  const allow = (p: string) =>
    [...new Set([p, realpathOrSelf(p)])].map((v) => `(allow file-write* (subpath "${esc(v)}"))`).join("\n");
  return [
    "(version 1)",
    "(allow default)",
    ...[...protectedRepoPaths(ctx), ...operationalWriteDeny(ctx)].flatMap((p) => rule("file-write*", p)),
    ...writableExceptions(ctx, kind).map(allow),
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
