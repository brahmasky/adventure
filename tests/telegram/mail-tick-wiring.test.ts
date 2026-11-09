import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GoogleApiDeps } from "../../src/capabilities/google-api.js";
import type { GoogleAuthClient } from "../../src/capabilities/google-auth.js";
import { RunStore } from "../../src/run/run-store.js";
import { MAIL_TICK_SHUTDOWN_CAP_MS, runTelegramDaemon } from "../../src/telegram/telegram-daemon.js";
import { pinOmpEnv } from "../helpers/omp-env.js";

// SP2 mail wiring (spec 2026-11-09 §7): the poll loop runs the mail tick on its own detached job. With the env switch and the
// stored switch on and a fake Gmail, one cycle stores a mail and enqueues exactly one mail_card; with the flag off no Gmail call is made.
pinOmpEnv();

let dirs: string[] = [];
afterEach(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); dirs = []; vi.unstubAllEnvs(); });
const ALLOWLIST = { users: [{ telegram_user_id: 111, identity_id: "paco" }], chats: [{ telegram_chat_id: 222, label: "private", allowed_identity_ids: ["paco"] }] };
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const auth: GoogleAuthClient = { getAccessToken: async () => "ya29.t", invalidate: () => undefined };
const cards = (store: RunStore) => (store as any).db.prepare("SELECT idempotency_key FROM notification_outbox WHERE idempotency_key LIKE 'mail:%'").all() as Array<{ idempotency_key: string }>;

function fakeGmail(onMessage: (signal?: AbortSignal | null) => Promise<void> | void) {
  const paths: string[] = [];
  const fetchImpl = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const p = new URL(String(i)).pathname.slice("/gmail/v1/users/me/".length);
    paths.push(p);
    if (p === "profile") return json({ historyId: "100" });
    if (p === "messages") return json({ messages: [{ id: "m1", threadId: "t1" }] });
    await onMessage(init?.signal);
    return json({ id: "m1", threadId: "t1", snippet: "s", labelIds: ["INBOX"], internalDate: String(Date.now() - 3_600_000),
      payload: { headers: [{ name: "From", value: "Ann <ann@example.com>" }, { name: "Subject", value: "Hello" }] } });
  }) as typeof fetch;
  return { paths, deps: { fetchImpl, now: () => new Date() } as GoogleApiDeps };
}

async function runOnce(store: RunStore, mailDeps: { gmail: GoogleApiDeps; auth: GoogleAuthClient }, stop: AbortController, polls: { n: number }) {
  const root = mkdtempSync(join(tmpdir(), "houge-daemon-mail-")); dirs.push(root);
  await runTelegramDaemon({ store, projectRoot: root, allowlist: ALLOWLIST, stopSignal: stop.signal, longPollTimeoutSeconds: 0, mailDeps,
    llmAdapter: async (input) => ({ ok: true as const, output: { question: input.question, answer: "A", model: "fake" } }),
    telegramClient: { getUpdates: async () => { polls.n += 1; if (polls.n >= 3 && !stop.signal.aborted) stop.abort(); return []; }, sendMessage: async () => ({ message_id: 1 }) } });
}

describe("runTelegramDaemon: the mail tick", () => {
  it("on: a cycle polls the fake Gmail, stores the mail and enqueues one mail_card (an always-rule sender pings a backfilled mail)", async () => {
    vi.stubEnv("HOUGE_MAIL_ENABLED", "1"); vi.stubEnv("HOUGE_PACO_GMAIL_ADDRESS", "paco@example.com"); vi.stubEnv("HOUGE_PACO_GMAIL_REFRESH_TOKEN", "1//rt-example");
    const store = RunStore.openInMemory();
    store.setMailState({ enabled: true, enabled_at: new Date().toISOString() });
    store.upsertSenderRule({ rule_id: "r1", address: "ann@example.com", action: "always", source_item_id: null, created_at: new Date().toISOString() });
    const stop = new AbortController();
    const g = fakeGmail(() => stop.abort());
    await runOnce(store, { gmail: g.deps, auth }, stop, { n: 0 });
    expect(g.paths).toContain("profile");
    expect(store.hasMailItem("m1")).toBe(true);
    expect(cards(store)).toEqual([{ idempotency_key: "mail:m1" }]);
    expect(store.mailState().history_id).toBe("100");
    store.close();
  });
  it("off (the env switch unset): no Gmail call is made", async () => {
    vi.stubEnv("HOUGE_MAIL_ENABLED", ""); vi.stubEnv("HOUGE_PACO_GMAIL_ADDRESS", "paco@example.com"); vi.stubEnv("HOUGE_PACO_GMAIL_REFRESH_TOKEN", "1//rt-example");
    const store = RunStore.openInMemory();
    store.setMailState({ enabled: true, enabled_at: new Date().toISOString() });
    const g = fakeGmail(() => undefined);
    await runOnce(store, { gmail: g.deps, auth }, new AbortController(), { n: 0 });
    expect(g.paths).toEqual([]);
    expect(store.mailState().last_attempt_at).toBeNull();
    store.close();
  });

  it("/mail off through the daemon drops Paco's cached token on the poller's auth client and switches off", async () => {
    vi.stubEnv("HOUGE_MAIL_ENABLED", ""); vi.stubEnv("HOUGE_PACO_GMAIL_ADDRESS", "paco@example.com");
    const store = RunStore.openInMemory();
    store.setMailState({ enabled: true, enabled_at: new Date().toISOString() });
    const invalidate = vi.fn();
    const client: GoogleAuthClient = { getAccessToken: async () => "ya29.t", invalidate };
    const stop = new AbortController();
    let polls = 0;
    const root = mkdtempSync(join(tmpdir(), "houge-daemon-mail-")); dirs.push(root);
    await runTelegramDaemon({ store, projectRoot: root, allowlist: ALLOWLIST, stopSignal: stop.signal, longPollTimeoutSeconds: 0, mailDeps: { gmail: fakeGmail(() => undefined).deps, auth: client },
      llmAdapter: async (input) => ({ ok: true as const, output: { question: input.question, answer: "A", model: "fake" } }),
      telegramClient: { getUpdates: async () => {
        polls += 1;
        if (polls >= 2) { stop.abort(); return []; }
        return [{ update_id: 7001, message: { message_id: 9, text: "/mail off", from: { id: 111 }, chat: { id: 222 } } }];
      }, sendMessage: async () => ({ message_id: 1 }) } });
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(store.mailState().enabled).toBe(false);
    store.close();
  });

  // The shutdown wait (Rev 1.1): the stop arrives while the tick is parked in messages.get; that call finishes 300 ms after the
  // stop, long after the other shutdown awaits. Without `settledWithin(mailTick.settled(), …)` the daemon returns first and the mail is not stored.
  function shutdownCase(release: boolean) {
    vi.stubEnv("HOUGE_MAIL_ENABLED", "1"); vi.stubEnv("HOUGE_PACO_GMAIL_ADDRESS", "paco@example.com"); vi.stubEnv("HOUGE_PACO_GMAIL_REFRESH_TOKEN", "1//rt-example");
    const store = RunStore.openInMemory();
    store.setMailState({ enabled: true, enabled_at: new Date().toISOString() });
    store.upsertSenderRule({ rule_id: "r1", address: "ann@example.com", action: "always", source_item_id: null, created_at: new Date().toISOString() });
    const stop = new AbortController();
    let parked = false;
    const g = fakeGmail(() => new Promise<void>((resolve) => {
      parked = true;
      if (release) stop.signal.addEventListener("abort", () => setTimeout(resolve, 300), { once: true });
    }));
    return { store, stop, g, parked: () => parked };
  }
  it("shutdown waits for an in-flight tick: the mail is stored and the stop returns within the cap", async () => {
    const { store, stop, g, parked } = shutdownCase(true);
    let polls = 0; let stoppedAt = 0;
    const root = mkdtempSync(join(tmpdir(), "houge-daemon-mail-")); dirs.push(root);
    const stall = setTimeout(() => stop.abort(), 8_000);
    try {
      await runTelegramDaemon({ store, projectRoot: root, allowlist: ALLOWLIST, stopSignal: stop.signal, longPollTimeoutSeconds: 0, mailDeps: { gmail: g.deps, auth },
        llmAdapter: async (input) => ({ ok: true as const, output: { question: input.question, answer: "A", model: "fake" } }),
        telegramClient: { getUpdates: async () => {
          polls += 1;
          if (polls >= 2) { for (let i = 0; i < 200 && !parked(); i++) await new Promise((r) => setTimeout(r, 10)); stoppedAt = Date.now(); stop.abort(); }
          return [];
        }, sendMessage: async () => ({ message_id: 1 }) } });
      expect(parked()).toBe(true);
      expect(store.hasMailItem("m1")).toBe(true);
      expect(Date.now() - stoppedAt).toBeLessThan(MAIL_TICK_SHUTDOWN_CAP_MS + 1_000);
    } finally { clearTimeout(stall); store.close(); }
  });
  it("a tick that never settles is abandoned at the cap, not waited for", async () => {
    const { store, stop, g, parked } = shutdownCase(false);
    let polls = 0; let stoppedAt = 0;
    const root = mkdtempSync(join(tmpdir(), "houge-daemon-mail-")); dirs.push(root);
    try {
      await runTelegramDaemon({ store, projectRoot: root, allowlist: ALLOWLIST, stopSignal: stop.signal, longPollTimeoutSeconds: 0, mailDeps: { gmail: g.deps, auth },
        llmAdapter: async (input) => ({ ok: true as const, output: { question: input.question, answer: "A", model: "fake" } }),
        telegramClient: { getUpdates: async () => {
          polls += 1;
          if (polls >= 2) { for (let i = 0; i < 200 && !parked(); i++) await new Promise((r) => setTimeout(r, 10)); stoppedAt = Date.now(); stop.abort(); }
          return [];
        }, sendMessage: async () => ({ message_id: 1 }) } });
      expect(store.hasMailItem("m1")).toBe(false);
      expect(Date.now() - stoppedAt).toBeLessThan(MAIL_TICK_SHUTDOWN_CAP_MS + 1_000);
    } finally { store.close(); }
  }, 20_000);
  it("mail on but no Paco address: one latched code-only line, no Gmail call", async () => {
    vi.stubEnv("HOUGE_MAIL_ENABLED", "1"); vi.stubEnv("HOUGE_PACO_GMAIL_ADDRESS", ""); vi.stubEnv("HOUGE_PACO_GMAIL_REFRESH_TOKEN", "1//rt-example");
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = RunStore.openInMemory();
    store.setMailState({ enabled: true, enabled_at: new Date().toISOString() });
    const g = fakeGmail(() => undefined);
    await runOnce(store, { gmail: g.deps, auth }, new AbortController(), { n: 0 });
    expect(g.paths).toEqual([]);
    expect(err.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("mail tick skipped"))).toEqual(["[telegram-daemon] mail tick skipped: no_paco_address"]);
    err.mockRestore(); store.close();
  });
});
