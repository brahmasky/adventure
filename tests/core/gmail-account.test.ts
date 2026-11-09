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
async function call(spy: ReturnType<typeof spyFetch>, input: Record<string, unknown>, tool = "gmail_read") {
  const run_id = newRun();
  const worker = ompWorker(store, tmp.dir, { llm, project: join(tmp.dir, "project"), google: { fetchImpl: spy.fetchImpl, now: () => new Date() } });
  return { worker, r: await bridgeTurn(store, worker, run_id, tmp.dir).call(tool, input) };
}

describe("gmail_read / google_api account:\"paco\" is gated by the mail switch", () => {
  it("refuses with no fetch when mail is off (env off)", async () => {
    store.setMailState({ enabled: true });
    const spy = spyFetch();
    const { r } = await call(spy, { account: "paco", get: "m1" });
    expect(r.isError).toBe(true);
    // The read-tool wall withholds every failed read's error text from the planner; the refusal is still a failed tool call.
    expect(r.content).toContain("Status: failed");
    expect(spy.urls).toHaveLength(0);
  });
  it("refuses with no fetch when the stored switch is off (env on)", async () => {
    process.env.HOUGE_MAIL_ENABLED = "1";
    const spy = spyFetch();
    const { r } = await call(spy, { account: "paco", get: "m1" }, "google_api");
    expect(r.isError).toBe(true);
    expect(spy.urls).toHaveLength(0);
  });
  it("with mail on, mints from the paco refresh token", async () => {
    process.env.HOUGE_MAIL_ENABLED = "1"; store.setMailState({ enabled: true });
    const spy = spyFetch();
    const { r } = await call(spy, { account: "paco", get: "m1" });
    expect(r.isError).toBe(false);
    expect(spy.refreshTokens).toEqual(["paco-refresh"]);
  });
  it("no account (or houge) keeps today's path: houge refresh token, even with mail off", async () => {
    const spy = spyFetch();
    await call(spy, { get: "m1" });
    await call(spy, { account: "houge", get: "m1" });
    expect(new Set(spy.refreshTokens)).toEqual(new Set(["houge-refresh"]));
  });
  it("invalidatePacoGmail drops the cached paco token so the next read re-mints", async () => {
    process.env.HOUGE_MAIL_ENABLED = "1"; store.setMailState({ enabled: true });
    const spy = spyFetch();
    const { worker } = await call(spy, { account: "paco", get: "m1" });
    worker.invalidatePacoGmail();
    const run_id = newRun();
    await bridgeTurn(store, worker, run_id, tmp.dir).call("gmail_read", { account: "paco", get: "m1" });
    expect(spy.refreshTokens).toEqual(["paco-refresh", "paco-refresh"]);
  });
});
