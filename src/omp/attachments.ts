import { resolve as resolvePath } from "node:path";
import { inside } from "../notifications/attachment-check.js";
import { realpathOrSelf } from "./protected-paths.js";

/**
 * `[[attach: <path>]]` lines leave the text; a path is kept only if it (and its real target) is inside the workspace. attach.path's parse
 * predicate (spec R7 §4.1; ADR 0034 4.1): `refused` is that if's else, each refused marker's resolved path in line order.
 */
export function parseAttachments(text: string, workspace: string): { text: string; attachments: string[]; refused: string[] } {
  const attachments: string[] = [];
  const refused: string[] = [];
  const kept = text.split("\n").filter((line) => {
    const m = /^\s*\[\[attach:\s*(.+?)\s*\]\]\s*$/.exec(line);
    if (!m) return true;
    const abs = resolvePath(workspace, m[1] as string);
    if (inside(workspace, abs) && inside(realpathOrSelf(workspace), realpathOrSelf(abs))) attachments.push(abs);
    else refused.push(abs);
    return false;
  });
  return { text: kept.join("\n").trim(), attachments, refused };
}
