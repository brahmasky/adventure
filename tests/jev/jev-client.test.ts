import { describe, expect, it, vi } from "vitest";
import { createJevClient, JEV_MODEL, type JevRequest } from "../../src/jev/jev-client.js";
import { recordingSink } from "../helpers/llm-audit.js";

const OPTIONS = ["answer", "research", "feedback", "clarify", "selfcode", "skill"] as const;
const REQ: JevRequest = {
  state: { latest_message: "what's the ASX close today?" },
  questions: { intent: { type: "choice", instructions: "How should Houge handle it?", criteria: Object.fromEntries(OPTIONS.map((o) => [o, o])) } }
};
const KEY = "ts-live-key-abcdefgh-123456";

function okBody(overrides: Record<string, unknown> = {}) {
  const probabilities = { answer: 0.05, research: 0.85, feedback: 0.02, clarify: 0.03, selfcode: 0.03, skill: 0.02 };
  return {
    model: JEV_MODEL,
    answers: { intent: { type: "choice", choice: "research", probabilities, confidence: 0.82, ...overrides } },
    usage: { input_tokens: 300, output_tokens: 20 }
  };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function client(fetchImpl: typeof fetch, extra: Partial<Parameters<typeof createJevClient>[0]> = {}) {
  const audit = recordingSink();
  const sleep = vi.fn(async () => {});
  const call = createJevClient({ apiKey: KEY, audit, meteredBreached: () => false, retries: 0, timeoutMs: 1000, fetchImpl, sleep, ...extra });
  return { call, audit, sleep };
}

describe("createJevClient", () => {
  it("200: returns the validated answer and audits one ok attempt with usage", async () => {
    const fetchImpl = vi.fn(async () => json(200, okBody()));
    const { call, audit } = client(fetchImpl as unknown as typeof fetch);
    const r = await call(REQ);
    expect(r).toMatchObject({ ok: true, model: JEV_MODEL, input_tokens: 300 });
    if (r.ok) expect(r.answers.intent!.choice).toBe("research");
    expect(audit.attempts).toHaveLength(1);
    expect(audit.attempts[0]).toMatchObject({ provider: "jev", outcome: "ok", model: JEV_MODEL, usage: { input_tokens: 300, output_tokens: 20, cached_input_tokens: 0 } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(JSON.parse(String(init.body))).toMatchObject({ model: JEV_MODEL });
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
  });

  it("no key: no fetch, audits unavailable/auth — a missing key is visible, never silent", async () => {
    const fetchImpl = vi.fn();
    const { call, audit } = client(fetchImpl as unknown as typeof fetch, { apiKey: undefined });
    expect(await call(REQ)).toMatchObject({ ok: false, reason: "no_key" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(audit.attempts[0]).toMatchObject({ provider: "jev", outcome: "unavailable", error_kind: "auth" });
  });

  it("metered fuse latched: no fetch at all (ADR 0019 ceiling covers jev)", async () => {
    const fetchImpl = vi.fn();
    const { call } = client(fetchImpl as unknown as typeof fetch, { meteredBreached: () => true });
    expect(await call(REQ)).toMatchObject({ ok: false, reason: "fused" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([401, 403])("%i → unavailable/auth, never retried", async (status) => {
    const fetchImpl = vi.fn(async () => json(status, { error: "bad key" }));
    const { call, audit } = client(fetchImpl as unknown as typeof fetch, { retries: 3 });
    expect(await call(REQ)).toMatchObject({ ok: false, reason: "auth" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(audit.attempts).toEqual([expect.objectContaining({ outcome: "unavailable", error_kind: "auth" })]);
  });

  it("429 with retry-after: retries, honours the header, ONE audit row per attempt", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json(429, {}, { "retry-after": "2" }))
      .mockResolvedValueOnce(json(503, {}))
      .mockResolvedValueOnce(json(200, okBody()));
    const { call, audit, sleep } = client(fetchImpl as unknown as typeof fetch, { retries: 3 });
    expect((await call(REQ)).ok).toBe(true);
    expect(sleep).toHaveBeenNthCalledWith(1, 2000);
    expect(sleep).toHaveBeenNthCalledWith(2, 1000); // backoff 500·2^1 for the 2nd retry
    expect(audit.attempts.map((a) => a.outcome)).toEqual(["error", "error", "ok"]);
    expect(audit.attempts[0]).toMatchObject({ error_kind: "transport" });
  });

  it("retries: 0 (live shadow) → a 429 is recorded and dropped, not retried", async () => {
    const fetchImpl = vi.fn(async () => json(429, {}));
    const { call } = client(fetchImpl as unknown as typeof fetch);
    expect(await call(REQ)).toMatchObject({ ok: false, reason: "error" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("timeout → error/timeout, not retried", async () => {
    const fetchImpl = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    const { call, audit } = client(fetchImpl as unknown as typeof fetch, { timeoutMs: 5, retries: 3 });
    expect(await call(REQ)).toMatchObject({ ok: false, reason: "error" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(audit.attempts[0]).toMatchObject({ outcome: "error", error_kind: "timeout" });
  });

  it.each([
    ["an option missing from probabilities", { probabilities: { research: 1 } }],
    ["probabilities that do not sum to 1", { probabilities: { answer: 0.5, research: 0.9, feedback: 0, clarify: 0, selfcode: 0, skill: 0 } }],
    ["confidence out of range", { confidence: 1.4 }],
    ["a choice that is not an option", { choice: "banana" }]
  ])("malformed answer (%s) → error/parse, no answer returned", async (_label, overrides) => {
    const fetchImpl = vi.fn(async () => json(200, okBody(overrides)));
    const { call, audit } = client(fetchImpl as unknown as typeof fetch);
    expect(await call(REQ)).toMatchObject({ ok: false, reason: "error" });
    expect(audit.attempts[0]).toMatchObject({ outcome: "error", error_kind: "parse" });
  });

  it("never writes the key to any console channel", async () => {
    const spies = (["log", "warn", "error", "debug", "info"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const fetchImpl = vi.fn(async () => json(500, { error: `echo ${KEY}` }));
    const { call } = client(fetchImpl as unknown as typeof fetch, { retries: 1 });
    const r = await call(REQ);
    const logged = spies.flatMap((s) => s.mock.calls.flat()).join(" ");
    expect(logged).not.toContain(KEY);
    if (!r.ok) expect(r.detail).not.toContain(KEY);
    spies.forEach((s) => s.mockRestore());
  });
});
