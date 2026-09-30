import { join } from "node:path";

/** The one place a chat's omp workspace path is built: planner cwd, bash cwd, and where attachments must live. */
export function chatWorkspace(dataDir: string, chatId: string): string {
  return join(dataDir, "omp", "workspace", `chat-${chatId}`);
}
