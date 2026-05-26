import { existsSync, readFileSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import type { ToolAdapterResult } from "../tools/tool-registry.js";

export type ProjectFileReadResult = { ok: true; content: string } | { ok: false; error: string };

function escapesRoot(root: string, target: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return target !== root && !target.startsWith(prefix);
}

export function readProjectFile(projectRoot: string, relativePath: string): ProjectFileReadResult {
  const root = realpathSync(projectRoot);
  const target = resolve(root, relativePath);

  if (escapesRoot(root, target)) {
    return { ok: false, error: "Path escapes project root" };
  }

  if (!existsSync(target)) {
    return { ok: false, error: `File not found: ${relativePath}` };
  }

  const canonicalTarget = realpathSync(target);
  if (escapesRoot(root, canonicalTarget)) {
    return { ok: false, error: "Path escapes project root" };
  }

  return { ok: true, content: readFileSync(canonicalTarget, "utf8") };
}

export function createLocalFileReadAdapter(
  projectRoot: string
): (input: Record<string, unknown>) => ToolAdapterResult {
  return (input: Record<string, unknown>): ToolAdapterResult => {
    if (typeof input.path !== "string") {
      return { ok: false, error: "path must be a string" };
    }

    const result = readProjectFile(projectRoot, input.path);
    if (!result.ok) {
      return result;
    }

    return {
      ok: true,
      output: {
        path: relative(projectRoot, resolve(projectRoot, input.path)),
        content: result.content
      }
    };
  };
}
