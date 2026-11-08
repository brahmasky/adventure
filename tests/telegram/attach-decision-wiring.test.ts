import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chatWorkspace } from "../../src/omp/workspace.js";
import { LocalNotificationAdapter } from "../../src/notifications/local-notification-adapter.js";
import { RunStore } from "../../src/run/run-store.js";
import { createOutboxDispatcher } from "../../src/telegram/telegram-daemon.js";
import { runTelegramPollOnce, workspaceTelegramAdapter } from "../../src/telegram/telegram-poll-runner.js";
import { createQueuedTurnRun } from "../helpers/runs.js";
import { pinOmpEnv, tmpOmpDist, useFakeOmp } from "../helpers/omp-env.js";

pinOmpEnv();
const PINNED = ["HOUGE_TELEGRAM_CHAT_ID", "HOUGE_SCHEDULER_ENABLED", "HOUGE_RADAR_ENABLED", "HOUGE_RADAR_PANEL_ENABLED", "HOUGE_MEDIA_INGEST_ENABLED", "HOUGE_LLM_MEDIA_PROVIDERS"];
const savedEnv = new Map<string, string | undefined>();
beforeEach(() => { for (const k of [...PINNED, "HOUGE_MODEL_ROLES"]) { savedEnv.set(k, process.env[k]); delete process.env[k]; } process.env.HOUGE_MODEL_ROLES = "static"; });
afterEach(() => { for (const [k, v] of savedEnv) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } savedEnv.clear(); });

const ALLOW = { users: [{ telegram_user_id: 111, identity_id: "paco" }], chats: [{ telegram_chat_id: 555, label: "p", allowed_identity_ids: ["paco"] }] };

/** A verified workspace for chat 555 under `root` and a seeded final_report naming a 21 MiB sparse file there (spec R7 §4.4 wiring). */
function seed(store: RunStore, root: string): { run: string; ws: string } {
  const ws = chatWorkspace(root, "555"); mkdirSync(ws, { recursive: true });
  const big = join(ws, "big.bin"); writeFileSync(big, ""); truncateSync(big, 21 * 1024 * 1024);
  const run = createQueuedTurnRun(store, "wired");
  store.enqueueFinalReportNotification(run, { text: "report", report_path: "r.md", attachments: [big] });
  return { run, ws };
}
const attach = (store: RunStore) => store.listDecisionsBetween("1970-01-01T00:00:00.000Z", "2999-01-01T00:00:00.000Z").filter((r) => r.entry_id === "attach.path").map((r) => [r.verdict, r.reason_code, r.run_id]);
const client = { sendMessage: async () => ({ message_id: 1 }), sendDocument: async (): Promise<never> => { throw new Error("must not upload"); } };
const state = (store: RunStore) => (store as unknown as { db: { prepare(s: string): { all(): Array<Record<string, unknown>> } } }).db.prepare("SELECT state FROM notification_outbox WHERE intent_type = 'final_report'").all().map((r) => r.state);

describe("R7 attach.path send wiring", () => {
  it("(a) runTelegramPollOnce records the send-time refusal", async () => {
    const store = RunStore.openInMemory(); const root = mkdtempSync(join(tmpdir(), "hg-aw-"));
    try {
      useFakeOmp({ "*": { rpcText: "x" } }, root);
      const { run } = seed(store, root);
      await runTelegramPollOnce({ store, projectRoot: root, omp: { dataDir: root, distDir: tmpOmpDist(root) }, allowlist: ALLOW, telegramClient: { getUpdates: async () => [], ...client } });
      expect(attach(store)).toEqual([["refuse", "too_large", run]]);
      expect(state(store)).toEqual(["delivered"]);
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("(b) the daemon's createOutboxDispatcher records the same row", async () => {
    const store = RunStore.openInMemory(); const root = mkdtempSync(join(tmpdir(), "hg-aw-"));
    try {
      const { run } = seed(store, root);
      await createOutboxDispatcher(store, { local: new LocalNotificationAdapter(() => undefined), telegram: workspaceTelegramAdapter(client, root) }).dispatchOnce("t");
      expect(attach(store)).toEqual([["refuse", "too_large", run]]);
      expect(state(store)).toEqual(["delivered"]);
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("(d) each production dispatcher construction passes the store recorder; the eval runner's does not", () => {
    const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
    expect(src("telegram/telegram-daemon.ts")).toMatch(/new NotificationDispatcher\(new NotificationOutbox\(store\), adapters, \{[^}]*recorder: storeRecorder\(store\)/);
    expect(src("telegram/telegram-poll-runner.ts")).toMatch(/new NotificationDispatcher\(new NotificationOutbox\(options\.store\), \{[\s\S]*?\}, \{ recorder: storeRecorder\(options\.store\) \}\)/);
    expect(src("cli.ts")).toMatch(/process\.cwd\(\)\)\n\s*\}, \{ recorder: storeRecorder\(store\) \}\);/);
    expect(src("eval/eval-runner.ts")).not.toMatch(/recorder/);
    for (const p of ["telegram/telegram-poll-runner.ts", "telegram/telegram-daemon.ts", "cli.ts"]) expect(src(p), p).not.toMatch(/beforeRecheckForTest/);
  });
});
