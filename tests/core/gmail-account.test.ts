import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";
import type { ToolAdapterResult } from "../../src/tools/tool-registry.js";
import { pinEnabledFlags, pinOmpEnv, shortTmp } from "../helpers/omp-env.js";
import { bridgeTurn, ompWorker } from "../helpers/omp-worker.js";

pinOmpEnv();
pinEnabledFlags();
const ENV = ["HOUGE_GOOGLE_ENABLED", "HOUGE_MAIL_ENABLED", "HOUGE_GMAIL_CLIENT_ID", "HOUGE_GMAIL_CLIENT_SECRET", "HOUGE_GMAIL_REFRESH_TOKEN", "HOUGE_PACO_GMAIL_REFRESH_TOKEN", "HOUGE_TOMBSTONE_PATH"];
const kept: Record<string, string | undefined> = {};
let tmp: { dir: string; cleanup: () => void };
let store: RunStore;
beforeEach(() => {
  for (const k of ENV) { kept[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, { HOUGE_GOOGLE_ENABLED: "1", HOUGE_GMAIL_CLIENT_ID: "cid", HOUGE_GMAIL_CLIENT_SECRET: "sec",
    HOUGE_GMAIL_REFRESH_TOKEN: "houge-refresh", HOUGE_PACO_GMAIL_REFRESH_TOKEN: "paco-refresh" });
  tmp = shortTmp("gma-");
  process.env.HOUGE_TOMBSTONE_PATH = join(tmp.dir, "houge.kill");
  store = RunStore.openInMemory();
});
afterEach(() => {
  store.close(); tmp.cleanup();
  for (const k of ENV) { if (kept[k] === undefined) delete process.env[k]; else process.env[k] = kept[k]; }
});

const llm = async (input: Record<string, unknown>): Promise<ToolAdapterResult> => ({ ok: true, output: { question: input.question, answer: "digest" } });

function spyFetch(): { fetchImpl: typeof fetch; refreshTokens: string[]; urls: string[] } {
  const refreshTokens: string[] = []; const urls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    urls.push(url);
    if (url.includes("oauth2")) {
      refreshTokens.push(new URLSearchParams(String(init?.body)).get("refresh_token") ?? "");
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: "m1", payload: { mimeType: "text/plain", headers: [], body: { data: Buffer.from("hello").toString("base64url") } } }), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, refreshTokens, urls };
}

let seq = 0;
function newRun(): string {
  const intake = new Gateway(store).intake(buildTypedTaskEvent({
    source: "telegram", type: "turn", program: "turn", goal: "mail", requested_by: { kind: "user", id: "paco" },
    notify: { kind: "telegram", chat_id: "555" }, idempotency_key: `t:mail:${++seq}`, source_reference: `telegram:update:${seq}:message:1`
  }));
  if (!intake.ok) throw new Error(`intake failed: ${JSON.stringify(intake)}`);
  return intake.run_id;
}
function makeWorker(spy: ReturnType<typeof spyFetch>) {
  return ompWorker(store, tmp.dir, { llm, project: join(tmp.dir, "project"), google: { fetchImpl: spy.fetchImpl, now: () => new Date() } });
}
/** One more run on the SAME worker (each bridge turn needs its own claimed run). */
function callOn(worker: ReturnType<typeof makeWorker>, input: Record<string, unknown>, tool = "gmail_read") {
  return bridgeTurn(store, worker, newRun(), tmp.dir).call(tool, input);
}
const OFF_TEXT = "Paco's mail is off (/mail on to allow)";

describe("gmail_read / google_api account:\"paco\" is gated by the mail switch", () => {
  it("refuses with the code-owned text and no fetch when the env switch is off", async () => {
    store.setMailState({ enabled: true });
    const spy = spyFetch();
    const r = await callOn(makeWorker(spy), { account: "paco", get: "m1" });
    expect(r.isError).toBe(true);
    expect(r.content).toBe(OFF_TEXT);
    expect(spy.urls).toHaveLength(0);
  });
  it("refuses google_api too when only the stored switch is off", async () => {
    process.env.HOUGE_MAIL_ENABLED = "1";
    const spy = spyFetch();
    const r = await callOn(makeWorker(spy), { account: "paco", path: "gmail/v1/users/me/messages" }, "google_api");
    expect(r.isError).toBe(true);
    expect(r.content).toBe(OFF_TEXT);
    expect(spy.urls).toHaveLength(0);
  });
  it("ledgers the refusal as denied/mail_off before any execution", async () => {
    const spy = spyFetch();
    const run_id = newRun();
    await bridgeTurn(store, makeWorker(spy), run_id, tmp.dir).call("gmail_read", { account: "paco", get: "m1" });
    const ev = JSON.stringify(store.getLedgerEvents(run_id));
    expect(ev).toContain("mail_off");
    expect(ev).toContain("denied");
  });
  it("one worker: houge -> paco -> paco(cached) -> invalidate -> houge(cached) -> paco(re-mint)", async () => {
    process.env.HOUGE_MAIL_ENABLED = "1"; store.setMailState({ enabled: true });
    const spy = spyFetch();
    const w = makeWorker(spy);
    expect((await callOn(w, { get: "m1" })).isError).toBe(false);
    expect((await callOn(w, { account: "paco", get: "m1" })).isError).toBe(false);
    expect((await callOn(w, { account: "paco", get: "m1" })).isError).toBe(false);
    w.invalidatePacoGmail();
    expect((await callOn(w, { account: "houge", get: "m1" })).isError).toBe(false);
    expect((await callOn(w, { account: "paco", get: "m1" })).isError).toBe(false);
    expect(spy.refreshTokens).toEqual(["houge-refresh", "paco-refresh", "paco-refresh"]);
  });
});
