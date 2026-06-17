import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import type { ToolAdapterResult } from "../tools/tool-registry.js";

function escapesRoot(root: string, target: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return target !== root && !target.startsWith(prefix);
}

/**
 * Adapter for the gated `local_project_write` capability. It accepts
 * `{ path, content }`, rejects paths outside the project root, writes only
 * beneath `runs/<run-id>/`, and returns `{ wrote: true, path }`.
 */
export function createLocalProjectWriteAdapter(
  projectRoot: string,
  run_id: string
): (input: Record<string, unknown>) => ToolAdapterResult {
  return (input: Record<string, unknown>): ToolAdapterResult => {
    if (typeof input.path !== "string") {
      return { ok: false, error: "path must be a string" };
    }
    if (typeof input.content !== "string") {
      return { ok: false, error: "content must be a string" };
    }

    let root: string;
    try {
      root = realpathSync(projectRoot);
    } catch {
      return { ok: false, error: `Project root not found: ${projectRoot}` };
    }

    const target = resolve(root, input.path);
    if (escapesRoot(root, target)) {
      return { ok: false, error: "Path escapes project root" };
    }

    const runPrefix = resolve(root, "runs", run_id);
    if (escapesRoot(runPrefix, target)) {
      return { ok: false, error: "Path must be beneath runs/<run-id>/" };
    }

    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, input.content, "utf8");
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }

    return {
      ok: true,
      output: { wrote: true, path: relative(root, target) }
    };
  };
}
