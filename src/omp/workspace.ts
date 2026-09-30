import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** The one place a chat's omp workspace path is built: planner cwd, bash cwd, and where attachments must live. */
export function chatWorkspace(dataDir: string, chatId: string): string {
  return join(dataDir, "omp", "workspace", `chat-${chatId}`);
}

/**
 * The chat workspace's real path, or null when it could have been swapped (security C2): every component from
 * `<data>/omp` down to `chat-<id>` must be a real directory, never a symlink, and the workspace must resolve to
 * exactly `<realpath(<data>/omp)>/workspace/chat-<id>`. Seatbelt also pins it; this is the daemon-side check.
 */
export function verifiedWorkspace(ws: string): string | null {
  const wsRoot = dirname(ws); const ompRoot = dirname(wsRoot);
  try {
    for (const p of [ompRoot, wsRoot, ws]) {
      const st = lstatSync(p);
      if (st.isSymbolicLink() || !st.isDirectory()) return null;
    }
    const real = realpathSync(ws);
    return real === join(realpathSync(ompRoot), basename(wsRoot), basename(ws)) ? real : null;
  } catch {
    return null;
  }
}
