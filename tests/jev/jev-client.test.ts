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
    expect(audit.attempts[0]).toMatchObject({ error_kind: "rate_limited" });
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
    ["an option missing from probabilities", { probabilities: { research: 1 } }, "probability_keys"],
    ["probabilities that do not sum to 1", { probabilities: { answer: 0.5, research: 0.9, feedback: 0, clarify: 0, selfcode: 0, skill: 0 } }, "probability_sum"],
    ["confidence out of range", { confidence: 1.4 }, "confidence_out_of_range"],
    ["a choice that is not an option", { choice: "banana" }, "choice_not_option"]
  ])("malformed answer (%s) → error/parse, and the detail NAMES the failed check", async (_label, overrides, code) => {
    const fetchImpl = vi.fn(async () => json(200, okBody(overrides)));
    const { call, audit } = client(fetchImpl as unknown as typeof fetch);
    const r = await call(REQ);
    expect(r).toMatchObject({ ok: false, reason: "error", error_kind: "parse", detail: `response failed validation: ${code}` });
    expect(audit.attempts[0]).toMatchObject({ outcome: "error", error_kind: "parse" });
  });

  it("a body without usage.input_tokens is rejected by name (replay's 2 rejects were undiagnosable without this)", async () => {
    const body = okBody();
    delete (body as { usage?: unknown }).usage;
    const fetchImpl = vi.fn(async () => json(200, body));
    const { call } = client(fetchImpl as unknown as typeof fetch);
    expect(await call(REQ)).toMatchObject({ ok: false, detail: "response failed validation: usage_input_tokens_missing" });
  });

  it("a model field that is not a bounded id is rejected by name — provider prose can never reach the ledger as jev_model (Codex B2)", async () => {
    const prose = { ...okBody(), model: "jev-1.13.0 — echoing your message: what's the ASX close today?" };
    const fetchImpl = vi.fn(async () => json(200, prose));
    const { call, audit } = client(fetchImpl as unknown as typeof fetch);
    expect(await call(REQ)).toMatchObject({ ok: false, reason: "error", error_kind: "parse", detail: "response failed validation: model_invalid" });
    expect(JSON.stringify(audit.attempts)).not.toContain("echoing");
  });

  it("failures carry error_kind so the live shadow can tell a timeout from other errors", async () => {
    const noKey = client(vi.fn() as unknown as typeof fetch, { apiKey: undefined });
    expect(await noKey.call(REQ)).toMatchObject({ ok: false, reason: "no_key", error_kind: "auth" });

    const denied = client(vi.fn(async () => json(401, {})) as unknown as typeof fetch);
    expect(await denied.call(REQ)).toMatchObject({ ok: false, reason: "auth", error_kind: "auth" });

    const flaky = client(vi.fn(async () => json(503, {})) as unknown as typeof fetch);
    expect(await flaky.call(REQ)).toMatchObject({ ok: false, reason: "error", error_kind: "transport", detail: "HTTP 503" });

    const hang = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    const slow = client(hang as unknown as typeof fetch, { timeoutMs: 5 });
    expect(await slow.call(REQ)).toMatchObject({ ok: false, reason: "error", error_kind: "timeout" });

    const fused = client(vi.fn() as unknown as typeof fetch, { meteredBreached: () => true });
    const r = await fused.call(REQ);
    expect(r).toMatchObject({ ok: false, reason: "fused" });
    expect(r.ok === false && r.error_kind).toBe(undefined);
  });

  it("F7: the fuse is re-checked before EVERY attempt — latching mid-retry stops the retry, not just the first call", async () => {
    let breached = false;
    const fetchImpl = vi.fn(async () => {
      breached = true; // the fuse latches as a side effect of the first (429) attempt
      return json(429, {});
    });
    const { call } = client(fetchImpl as unknown as typeof fetch, { retries: 3, meteredBreached: () => breached });
    expect(await call(REQ)).toMatchObject({ ok: false, reason: "fused" });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // the retry is refused by the fuse check, never a second fetch
  });

  it("F8: retry-after is capped at 60s — a huge header value never sleeps past the cap", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json(429, {}, { "retry-after": "3600" }))
      .mockResolvedValueOnce(json(200, okBody()));
    const { call, sleep } = client(fetchImpl as unknown as typeof fetch, { retries: 1 });
    expect((await call(REQ)).ok).toBe(true);
    expect(sleep).toHaveBeenCalledWith(60_000);
  });

  it("F8: the abort timer stays armed through the body read — a res.json() that hangs past timeoutMs times out instead of never resolving", async () => {
    const fetchImpl = vi.fn((_u: string, init: RequestInit) => Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () => new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      })
    } as unknown as Response));
    const { call, audit } = client(fetchImpl as unknown as typeof fetch, { timeoutMs: 5, retries: 0 });
    expect(await call(REQ)).toMatchObject({ ok: false, reason: "error" });
    expect(audit.attempts[0]).toMatchObject({ outcome: "error", error_kind: "timeout" });
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

describe("status → error kind (spec §3.3: outages are distinguishable, 422 is a code bug)", () => {
  const Q = { q: { type: "choice" as const, instructions: "x", criteria: { a: "a", b: "b" } } };
  it("maps 429 to rate_limited and retries only when retries > 0", async () => {
    const fetchImpl = vi.fn(async () => json(429, { error: "slow down" }, { "retry-after": "1" }));
    const { call, audit } = client(fetchImpl as unknown as typeof fetch);
    const r = await call({ state: {}, questions: Q });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error_kind).toBe("rate_limited");
    expect(fetchImpl).toHaveBeenCalledTimes(1); // retries: 0 on live paths
    expect(audit.attempts.at(-1)?.error_kind).toBe("rate_limited");
  });
  it("maps 529 to overloaded (retryable) and 500 to transport", async () => {
    const r529 = await client(vi.fn(async () => json(529, {})) as unknown as typeof fetch).call({ state: {}, questions: Q });
    const r500 = await client(vi.fn(async () => json(500, {})) as unknown as typeof fetch).call({ state: {}, questions: Q });
    expect(!r529.ok && r529.error_kind).toBe("overloaded");
    expect(!r500.ok && r500.error_kind).toBe("transport");
  });
  it("maps 422 to malformed_question and never retries it even with retries: 3", async () => {
    const fetchImpl = vi.fn(async () => json(422, { error: { field: "questions.q.criteria" } }));
    const { call } = client(fetchImpl as unknown as typeof fetch, { retries: 3 });
    const r = await call({ state: {}, questions: Q });
    expect(!r.ok && r.error_kind).toBe("malformed_question");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // the body may echo our own question text or a provider message: never copied into detail
    expect(!r.ok && r.detail).toBe("HTTP 422");
  });
});
