import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PROTECTED_DIRS, PROTECTED_FILES } from "../capabilities/self-write-guard.js";

export interface PathContext { home: string; repo: string; data: string }

export function secretPaths(ctx: PathContext): string[] {
  const h = (p: string) => join(ctx.home, p);
  return [
    join(ctx.repo, ".env"), join(ctx.data, "houge.sqlite"), join(ctx.data, "houge.sqlite-wal"), join(ctx.data, "houge.sqlite-shm"),
    h(".ssh"), h(".gnupg"), h(".pi"), h(".claude"), h(".codex"), h(".kimi"), h(".kimi-code"), h(".omp"),
    h(".config/gcloud"), h("Library/Keychains"), h(".claude.json")
  ];
}

export function protectedRepoPaths(ctx: PathContext): string[] {
  return [...PROTECTED_DIRS, ...PROTECTED_FILES].map((p) => join(ctx.repo, p));
}

export function writableExceptions(ctx: PathContext, kind: "planner" | "shell"): string[] {
  const ws = join(ctx.data, "omp", "workspace");
  return kind === "planner" ? [ws, join(ctx.data, "omp", "sessions")] : [ws];
}

export function operationalWriteDeny(ctx: PathContext): string[] {
  return [ctx.repo, join(ctx.repo, "dist"), join(ctx.data, "omp", "bridge"), join(ctx.data, "omp", "planner.sb"),
    join(ctx.data, "omp", "shell.sb"), join(ctx.data, "omp", "houge-config.yml"),
    join(ctx.home, "Library/LaunchAgents/com.houge.daemon.plist"), join(ctx.data, "houge.kill"), join(ctx.data, "houge.parked")];
}

/**
 * Canonical form of `p`. Seatbelt matches canonical paths only (/var is a symlink to /private/var),
 * so a path that does not exist yet is canonicalised through its deepest existing ancestor and the
 * missing tail is re-appended.
 */
export function realpathOrSelf(p: string): string {
  const abs = resolve(p);
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try { return join(realpathSync(cur), ...tail); } catch { /* not there yet: climb */ }
    const parent = dirname(cur);
    if (parent === cur) return abs;
    tail.unshift(cur.slice(parent.length).replace(/^\/+/, ""));
    cur = parent;
  }
}

function under(abs: string, roots: string[]): boolean {
  const a = realpathOrSelf(abs).toLowerCase();
  return roots.some((r) => {
    const root = realpathOrSelf(r).toLowerCase();
    return a === root || a.startsWith(root.endsWith("/") ? root : `${root}/`);
  });
}

export function isDeniedRead(absPath: string, ctx: PathContext): boolean {
  return under(absPath, secretPaths(ctx));
}

export function isDeniedWrite(absPath: string, ctx: PathContext): boolean {
  if (under(absPath, secretPaths(ctx))) return true;
  if (under(absPath, writableExceptions(ctx, "shell"))) return false;
  return under(absPath, [...protectedRepoPaths(ctx), ...operationalWriteDeny(ctx)]);
}
