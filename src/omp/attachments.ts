import { isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import { realpathOrSelf } from "./protected-paths.js";

function inside(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** `[[attach: <path>]]` lines leave the text; a path is kept only if it (and its real target) is inside the workspace. */
export function parseAttachments(text: string, workspace: string): { text: string; attachments: string[] } {
  const attachments: string[] = [];
  const kept = text.split("\n").filter((line) => {
    const m = /^\s*\[\[attach:\s*(.+?)\s*\]\]\s*$/.exec(line);
    if (!m) return true;
    const abs = resolvePath(workspace, m[1] as string);
    if (inside(workspace, abs) && inside(realpathOrSelf(workspace), realpathOrSelf(abs))) attachments.push(abs);
    return false;
  });
  return { text: kept.join("\n").trim(), attachments };
}
