# Jev Intent Shadow — Replay Phase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **TDD is mandatory (Paco, 2026-09-25):** every task starts from a failing test.

**Goal:** Build `houge jev-shadow replay`. For each of the ~373 historical chat turns it asks two
classifiers the same question: Jev (TypeSafe) and the *current* LLM intent classifier, both on the
same rebuilt inputs. It then prints a GO/STOP report on whether Jev agrees with the LLM often enough
to justify a live shadow.

**Architecture:** Five small units, each with its own test cycle:
- plumbing: secret, price, roles and the sweep filter;
- a thin audited `fetch` client for Jev;
- a pure request builder;
- read-only store queries that rebuild each turn's thread;
- a replay engine and a report, both taking their dependencies as parameters.

A thin CLI branch wires the real dependencies. **No daemon code path changes in this plan.**

**Tech Stack:**
- TypeScript (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), ESM.
- Node ≥ 25: built-in `fetch`, `node:sqlite` through `RunStore`.
- vitest; npm (`package-lock.json`).
- **Zero runtime dependencies.** Keep it that way: validate by hand, no Zod, no SDK.

**Spec:** `docs/superpowers/specs/2026-09-25-jev-intent-shadow-design.md` (read it first; this plan
implements rollout steps 1–3).

**Scope:**
- **In:** replay only.
- **Out:** the live shadow (rollout step 4). It gets its own plan **after** replay prints GO and Paco
  confirms, because the replay findings may change the question wording and thresholds it depends on.

## Global Constraints

- Model is pinned to `jev-1.13.0`. Endpoint `https://api.typesafe.ai/v1/systemone`. Price: input $0.042 per million tokens (`0.042` per mtok), output $0.
- The key is `TYPESAFE_API_KEY`, read through `SecretBroker.typesafeKey()` when the firewall is armed and from `process.env` otherwise. **Never logged**; debug output shows at most `key.slice(0, 8)`.
- Jev is a metered provider: `"jev"` ∈ `METERED_PROVIDERS`.
- Audit roles: `classify_replay` (Jev) and `classify_replay_llm` (the replayed LLM classifier). Every Jev HTTP attempt produces exactly one `llm_attempt` row.
- Every `createJevClient(` call site passes an inline `audit: store.llmAuditSink(` and a `meteredBreached:`.
- Intents, in this order: `answer, research, feedback, clarify, selfcode, skill`.
- Caps: `latest_message` ≤ 8,000 chars; the whole serialized request ≤ 24,000 chars. Over either cap → skip, **never truncate**.
- Replay-bar thresholds: `confidence ≥ 0.7` agreement vs the replayed `llm_intent` ≥ 0.75 → GO; STOP if under 0.6 of eligible turns reach a matched pair.
- **No message text** is written to JSONL or to the ledger.
- Conventions: Conventional Commits; commit messages end with the repo's attribution trailer. Never `git add -A`; add named files only.
- Run tests with `npx vitest run <path>`, type-check with `npm run typecheck`.

**Deviation from the spec, deliberate:** replay runs **sequentially** instead of 4 Jev requests in
flight. The LLM leg is serial anyway, since it must not compete with the live daemon, and it takes
seconds per call. So parallel Jev calls would save nothing, and sequential dispatch makes the
`--max-usd` reservation exact.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/config/secret-broker.ts` (modify) | 9th secret `TYPESAFE_API_KEY`, `typesafeKey()` getter, redaction |
| `src/llm/metered-pricing.ts` (modify) | `"jev"` metered; `"jev-"` price row |
| `src/run/run-store.ts` (modify) | New roles in `LlmCallRole`; sweep query excludes `classify_replay%`; `getChatTurnsBefore`, `listReplayTurns`, `runLoopCapabilities` |
| `src/jev/jev-client.ts` (create) | Audited `fetch` client, retries, response validation |
| `src/jev/intent-question.ts` (create) | Jev intent question constant, `buildJevIntentRequest`, `langOf` |
| `src/jev/replay.ts` (create) | `runReplay` engine, `observedAction`, `llmLabel`, `parseReplayArgs` |
| `src/jev/replay-report.ts` (create) | `summarizeReplay` + `formatReplayReport` (pure) |
| `src/cli.ts` (modify) | `jev-shadow replay` branch |
| `tests/llm/audit-coverage.test.ts` (modify) | Guard `createJevClient(` call sites |
| `scripts/live-gate-jev.mjs` (create) | Opt-in real-API gate |
| `.gitignore` (modify) | `.houge/` |

---

### Task 1: Plumbing — secret, price, roles, sweep filter

**Files:**
- Modify: `src/config/secret-broker.ts` (SECRET_ENV_NAMES ~L19-28, interface ~L52-73, factory ~L81-125)
- Modify: `src/llm/metered-pricing.ts` (`METERED_PROVIDERS` L19, `DEFAULT_METERED_PRICES`)
- Modify: `src/run/run-store.ts` (`LlmCallRole` L45-59; `findFailingLlmLegs` ~L3875)
- Test: `tests/config/secret-broker.test.ts`, `tests/llm/metered-pricing.test.ts`, `tests/run/llm-audit-sink.test.ts`, `tests/run/invariant-sweep-llm.test.ts`

**Interfaces:**
- Produces:
  - `SecretBroker.typesafeKey(): string | undefined`
  - `METERED_PROVIDERS` has `"jev"`
  - `computeCostUsd("jev", "jev-1.13.0", usage)` → `input_tokens × 0.042 / 1e6`
  - `LlmCallRole` gains `"classify_replay" | "classify_replay_llm" | "classify_shadow"`
  - `findFailingLlmLegs` ignores rows whose role starts with `classify_replay`

- [ ] **Step 1: Write the failing tests**

In `tests/config/secret-broker.test.ts`:
- add `TYPESAFE_API_KEY: "ts-fake-typesafe-key-000111222"` to `FAKE`;
- extend the exact-list test to nine names, `"TYPESAFE_API_KEY"` last, and retitle it "…exact nine-name list (Jev spec 2026-09-25: eight becomes nine)";
- add:

```ts
  it("returns and redacts the TypeSafe key (ninth secret, Jev spec 2026-09-25)", () => {
    const b = createSecretBroker(fakeEnv());
    expect(b.typesafeKey()).toBe(FAKE.TYPESAFE_API_KEY);
    expect(b.redact(`k=${FAKE.TYPESAFE_API_KEY}`)).toBe(`k=${REDACTED_PLACEHOLDER}`);
  });
```

In `tests/llm/metered-pricing.test.ts` add:

```ts
  it("prices jev input-only at $0.042/Mtok — output is free (TypeSafe Models page)", () => {
    expect(METERED_PROVIDERS.has("jev")).toBe(true);
    const cost = computeCostUsd("jev", "jev-1.13.0", { input_tokens: 1_000_000, output_tokens: 500, cached_input_tokens: 0 }, {});
    expect(cost).toBeCloseTo(0.042, 10);
  });
```
(Add `METERED_PROVIDERS` to that file's import from `../../src/llm/metered-pricing.js` if it is not there.)

In `tests/run/llm-audit-sink.test.ts` add the following. *Why:* codex BLOCKER 3. The ceiling reads the
**stored** row, so the test must check the stored row, not the value handed to the sink.

```ts
  it("stores cost_usd on a jev attempt and the metered ceiling sums it", () => {
    const store = RunStore.openInMemory();
    try {
      const sink = store.llmAuditSink({ correlation_id: "cli:jev-replay", role: "classify_replay" });
      sink.record({ provider: "jev", role: "", outcome: "ok", model: "jev-1.13.0", latency_ms: 3, usage: { input_tokens: 2_000_000, output_tokens: 20, cached_input_tokens: 0 } });
      const [row] = attemptsOf(store);
      expect(row!.payload.role).toBe("classify_replay");
      expect(row!.payload.cost_usd).toBeCloseTo(0.084, 10);
      expect(store.meteredSpendUsd(new Date().toISOString()).daily_usd).toBeCloseTo(0.084, 10);
    } finally {
      store.close();
    }
  });
```

In `tests/run/invariant-sweep-llm.test.ts` add the following. *Why:* codex RISK 7. An operator's replay
run must not open daemon incidents.

```ts
  it("ignores classify_replay* attempts (a replay run must not open daemon incidents)", () => {
    const store = RunStore.openInMemory();
    try {
      const sink = store.llmAuditSink({ correlation_id: "cli:jev-replay", role: "classify_replay" });
      for (let i = 0; i < LLM_LEG_FAILING_MIN_ATTEMPTS + 2; i++) sink.record({ provider: "jev", role: "", outcome: "unavailable", latency_ms: 1, error_kind: "auth" });
      expect(legs(store)).toEqual([]);
      const live = store.llmAuditSink({ correlation_id: "tick:x", role: "classify_shadow" });
      for (let i = 0; i < LLM_LEG_FAILING_MIN_ATTEMPTS; i++) live.record({ provider: "jev", role: "", outcome: "unavailable", latency_ms: 1, error_kind: "auth" });
      expect(legs(store)).toEqual([{ kind: "llm_leg_failing", subject: "jev", detail: { attempts: LLM_LEG_FAILING_MIN_ATTEMPTS, ok: 0, last_error_kind: "auth" } }]);
    } finally {
      store.close();
    }
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/config/secret-broker.test.ts tests/llm/metered-pricing.test.ts tests/run/llm-audit-sink.test.ts tests/run/invariant-sweep-llm.test.ts`
Expected: FAIL. Among the failures: `typesafeKey is not a function`, `METERED_PROVIDERS.has("jev")` false,
`cost_usd` undefined, the sweep returning a `jev` violation, and TypeScript rejecting `"classify_replay"` as an `LlmCallRole`.

- [ ] **Step 3: Implement**

`src/config/secret-broker.ts`:
- append `"TYPESAFE_API_KEY"` to `SECRET_ENV_NAMES` and update its doc comment ("nine");
- add to the interface: `/** TypeSafe (Jev) API key — Jev spec 2026-09-25. */ typesafeKey(): string | undefined;`
- in `createSecretBroker`: `const typesafe = env.TYPESAFE_API_KEY;`, add `typesafe` to the `redactable` array, and return `typesafeKey: () => typesafe,`.

`src/llm/metered-pricing.ts`:
```ts
export const METERED_PROVIDERS: ReadonlySet<string> = new Set(["kimi-api", "gemini-api", "jev"]);
```
and in `DEFAULT_METERED_PRICES`:
```ts
  // TypeSafe / jev (Jev spec 2026-09-25). Charged per INPUT token only; output is free.
  "jev-": { input_usd_per_mtok: 0.042, output_usd_per_mtok: 0 },
```

`src/run/run-store.ts`:
- extend the `LlmCallRole` union with `| "classify_replay" | "classify_replay_llm" | "classify_shadow"`;
- in `findFailingLlmLegs`, add the role filter to **both** the outer `WHERE` and the correlated subquery:
```sql
AND COALESCE(json_extract(payload_json, '$.role'), '') NOT LIKE 'classify_replay%'
```
  In the subquery use the `e2.payload_json` alias.
- Update the method's doc comment with one line: "Replay roles (`classify_replay*`) are operator CLI runs, not daemon health, and are excluded."

- [ ] **Step 4: Run the tests to verify they pass**

Run: the same command as Step 2, then `npm run typecheck`.
Expected: all PASS, typecheck clean.

- [ ] **Step 5: Run the full suite** — `npx vitest run`. Expected: PASS. If another test pins `METERED_PROVIDERS` or the secret list, update its expectation. That is an intended change.

- [ ] **Step 6: Commit**

```bash
git add src/config/secret-broker.ts src/llm/metered-pricing.ts src/run/run-store.ts tests/config/secret-broker.test.ts tests/llm/metered-pricing.test.ts tests/run/llm-audit-sink.test.ts tests/run/invariant-sweep-llm.test.ts
git commit -m "feat(jev): TypeSafe key in the broker, jev priced as metered, replay roles kept out of the leg sweep"
```

---

### Task 2: `src/jev/jev-client.ts` — the audited fetch client

**Files:**
- Create: `src/jev/jev-client.ts`
- Test: `tests/jev/jev-client.test.ts`

**Interfaces:**
- Consumes: `LlmAuditSink`, `LlmErrorKind` from `src/llm/audit.ts`.
- Produces:
```ts
export const JEV_MODEL = "jev-1.13.0";
export interface JevChoiceQuestion { type: "choice"; instructions: string; criteria: Record<string, string> }
export interface JevRequest { state: unknown; questions: Record<string, JevChoiceQuestion> }
export interface JevChoiceAnswer { choice: string; probabilities: Record<string, number>; confidence: number }
export type JevResult =
  | { ok: true; model: string; answers: Record<string, JevChoiceAnswer>; input_tokens: number; latency_ms: number }
  | { ok: false; reason: "no_key" | "fused" | "auth" | "error"; detail: string };
export interface JevClientConfig {
  apiKey: string | undefined;
  audit: LlmAuditSink;
  meteredBreached: () => boolean;
  retries: number;        // 0 = live shadow, 3 = replay
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}
export function createJevClient(config: JevClientConfig): (req: JevRequest) => Promise<JevResult>;
```

- [ ] **Step 1: Write the failing tests** in `tests/jev/jev-client.test.ts`

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/jev/jev-client.test.ts`
Expected: FAIL, "Cannot find module ../../src/jev/jev-client.js".

- [ ] **Step 3: Implement** `src/jev/jev-client.ts`

```ts
import type { LlmAuditSink, LlmErrorKind } from "../llm/audit.js";

/**
 * Thin audited client for TypeSafe's System One endpoint (Jev spec 2026-09-25). Plain `fetch`, not
 * the SDK: the SDK retries internally, which would hide attempts from the `llm_attempt` audit — here
 * every HTTP attempt is exactly one audit row. Zero runtime deps, so responses are validated by hand.
 */
export const JEV_MODEL = "jev-1.13.0";
const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const PROVIDER = "jev";
const BACKOFF_BASE_MS = 500;
const PROBABILITY_SUM_TOLERANCE = 0.01;

export interface JevChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}
export interface JevRequest {
  state: unknown;
  questions: Record<string, JevChoiceQuestion>;
}
export interface JevChoiceAnswer {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}
export type JevResult =
  | { ok: true; model: string; answers: Record<string, JevChoiceAnswer>; input_tokens: number; latency_ms: number }
  | { ok: false; reason: "no_key" | "fused" | "auth" | "error"; detail: string };

export interface JevClientConfig {
  apiKey: string | undefined;
  audit: LlmAuditSink;
  meteredBreached: () => boolean;
  /** 0 = live shadow (record and drop); 3 = replay. Only 429 / 5xx / network errors retry. */
  retries: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

type Attempt =
  | { kind: "ok"; result: Extract<JevResult, { ok: true }> }
  | { kind: "fail"; outcome: "error" | "unavailable"; error_kind: LlmErrorKind; retryable: boolean; retryAfterMs?: number; detail: string };

export function createJevClient(config: JevClientConfig): (req: JevRequest) => Promise<JevResult> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const sleep = config.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  return async (req: JevRequest): Promise<JevResult> => {
    if (!config.apiKey) {
      config.audit.record({ provider: PROVIDER, role: "", outcome: "unavailable", error_kind: "auth", latency_ms: 0 });
      return { ok: false, reason: "no_key", detail: "TYPESAFE_API_KEY is not set" };
    }
    if (config.meteredBreached()) {
      return { ok: false, reason: "fused", detail: "metered fuse latched" };
    }
    for (let attempt = 0; ; attempt += 1) {
      const started = Date.now();
      const a = await attemptOnce(fetchImpl, config.apiKey, req, config.timeoutMs);
      const latency_ms = Date.now() - started;
      if (a.kind === "ok") {
        config.audit.record({
          provider: PROVIDER, role: "", outcome: "ok", model: a.result.model, latency_ms,
          usage: { input_tokens: a.result.input_tokens, output_tokens: 0, cached_input_tokens: 0 }
        });
        return { ...a.result, latency_ms };
      }
      config.audit.record({ provider: PROVIDER, role: "", outcome: a.outcome, error_kind: a.error_kind, latency_ms });
      if (a.error_kind === "auth") return { ok: false, reason: "auth", detail: a.detail };
      if (!a.retryable || attempt >= config.retries) return { ok: false, reason: "error", detail: a.detail };
      await sleep(a.retryAfterMs ?? BACKOFF_BASE_MS * 2 ** attempt);
    }
  };
}

async function attemptOnce(fetchImpl: typeof fetch, apiKey: string, req: JevRequest, timeoutMs: number): Promise<Attempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(JEV_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: JEV_MODEL, state: req.state, questions: req.questions }),
      signal: controller.signal
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    return timedOut
      ? { kind: "fail", outcome: "error", error_kind: "timeout", retryable: false, detail: `timed out after ${timeoutMs}ms` }
      : { kind: "fail", outcome: "error", error_kind: "transport", retryable: true, detail: "network error" };
  } finally {
    clearTimeout(timer);
  }
  // Never echo the body into `detail`: a provider error may reflect the Authorization header.
  if (res.status === 401 || res.status === 403) {
    return { kind: "fail", outcome: "unavailable", error_kind: "auth", retryable: false, detail: `HTTP ${res.status}` };
  }
  if (res.status === 429 || res.status >= 500) {
    const after = Number(res.headers.get("retry-after"));
    return {
      kind: "fail", outcome: "error", error_kind: "transport", retryable: true, detail: `HTTP ${res.status}`,
      ...(Number.isFinite(after) && after > 0 ? { retryAfterMs: after * 1000 } : {})
    };
  }
  if (!res.ok) return { kind: "fail", outcome: "error", error_kind: "other", retryable: false, detail: `HTTP ${res.status}` };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { kind: "fail", outcome: "error", error_kind: "parse", retryable: false, detail: "response is not JSON" };
  }
  const parsed = validateResponse(body, req);
  return parsed
    ? { kind: "ok", result: { ok: true, ...parsed, latency_ms: 0 } }
    : { kind: "fail", outcome: "error", error_kind: "parse", retryable: false, detail: "response failed validation" };
}

function validateResponse(body: unknown, req: JevRequest): { model: string; answers: Record<string, JevChoiceAnswer>; input_tokens: number } | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.model !== "string" || typeof b.answers !== "object" || b.answers === null) return null;
  const usage = b.usage as Record<string, unknown> | undefined;
  const input_tokens = typeof usage?.input_tokens === "number" ? usage.input_tokens : null;
  if (input_tokens === null) return null;
  const answers: Record<string, JevChoiceAnswer> = {};
  for (const [id, question] of Object.entries(req.questions)) {
    const answer = validateChoice((b.answers as Record<string, unknown>)[id], Object.keys(question.criteria));
    if (!answer) return null;
    answers[id] = answer;
  }
  return { model: b.model, answers, input_tokens };
}

function validateChoice(raw: unknown, options: string[]): JevChoiceAnswer | null {
  if (typeof raw !== "object" || raw === null) return null;
  const a = raw as Record<string, unknown>;
  if (a.type !== "choice" || typeof a.choice !== "string" || !options.includes(a.choice)) return null;
  if (typeof a.confidence !== "number" || a.confidence < 0 || a.confidence > 1) return null;
  if (typeof a.probabilities !== "object" || a.probabilities === null) return null;
  const probs = a.probabilities as Record<string, unknown>;
  const keys = Object.keys(probs);
  if (keys.length !== options.length || !options.every((o) => typeof probs[o] === "number")) return null;
  const sum = options.reduce((s, o) => s + (probs[o] as number), 0);
  if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) return null;
  return { choice: a.choice, probabilities: probs as Record<string, number>, confidence: a.confidence };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/jev/jev-client.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/jev/jev-client.ts tests/jev/jev-client.test.ts
git commit -m "feat(jev): audited System One client — one llm_attempt per HTTP attempt, hand-validated answers"
```

---

### Task 3: `src/jev/intent-question.ts` — the pure request builder

**Files:**
- Create: `src/jev/intent-question.ts`
- Test: `tests/jev/intent-question.test.ts`

**Interfaces:**
- Consumes: `feedTurnText`, `buildIntentQuestion`, `Intent` from `src/capabilities/intent.ts`; `ChatTurnRow` from `src/run/run-store.ts`; `JevRequest`, `JevChoiceQuestion` from Task 2.
- Produces:
```ts
export const JEV_INTENTS: readonly Intent[];            // answer, research, feedback, clarify, selfcode, skill
export const JEV_INTENT_QUESTION: JevChoiceQuestion;
export const MAX_LATEST_MESSAGE_CHARS = 8_000;
export const MAX_REQUEST_CHARS = 24_000;
export type Lang = "zh" | "en" | "mixed";
export function langOf(text: string): Lang;
export type JevIntentRequest = { ok: true; request: JevRequest; chars: number } | { ok: false; skip: "state_too_large" };
export function buildJevIntentRequest(message: string, recentTurns: ChatTurnRow[], turnChars: number, recentClarifyCount: number): JevIntentRequest;
```

- [ ] **Step 1: Write the failing tests** in `tests/jev/intent-question.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { buildIntentQuestion } from "../../src/capabilities/intent.js";
import { buildJevIntentRequest, JEV_INTENT_QUESTION, JEV_INTENTS, langOf, MAX_LATEST_MESSAGE_CHARS } from "../../src/jev/intent-question.js";
import type { ChatTurnRow } from "../../src/run/run-store.js";

const turn = (role: "user" | "assistant", text: string, i: number): ChatTurnRow => ({
  turn_id: `t${i}`, chat_id: "c", run_id: `r${i}`, role, text, intent: role === "assistant" ? "answer" : null, created_at: `2026-09-01T00:00:0${i}.000Z`
});

describe("buildJevIntentRequest", () => {
  const thread = [turn("user", "x".repeat(900), 1), turn("assistant", "short reply", 2)];

  it("feeds Jev the SAME thread the LLM classifier sees — else disagreement measures input drift", () => {
    const r = buildJevIntentRequest("and now?", thread, 500, 0);
    if (!r.ok) throw new Error("expected ok");
    const state = r.request.state as { recent_turns: { role: string; text: string }[] };
    const llmQuestion = buildIntentQuestion("and now?", thread, 500, 0);
    for (const t of state.recent_turns) {
      expect(llmQuestion).toContain(`${t.role === "user" ? "User" : "Houge"}: ${t.text}`);
    }
    expect(state.recent_turns[0]!.text).toHaveLength(501); // 500 + "…" — same cap as feedTurnText
  });

  it("offers exactly the six intents — a missing option reads as disagreement on every turn", () => {
    expect(Object.keys(JEV_INTENT_QUESTION.criteria)).toEqual([...JEV_INTENTS]);
    expect([...JEV_INTENTS]).toEqual(["answer", "research", "feedback", "clarify", "selfcode", "skill"]);
  });

  it("carries modality and the clarify flag (multimodal-ready; soft clarify nudge parity)", () => {
    const r = buildJevIntentRequest("the second one", thread, 500, 1);
    if (!r.ok) throw new Error("expected ok");
    expect(r.request.state).toMatchObject({ modality: "text", latest_message: "the second one", already_asked_clarification: true });
  });

  it("skips an over-cap message instead of truncating it (a truncated message yields a silently worse label)", () => {
    expect(buildJevIntentRequest("y".repeat(MAX_LATEST_MESSAGE_CHARS + 1), [], 500, 0)).toEqual({ ok: false, skip: "state_too_large" });
  });

  it("skips when the WHOLE request exceeds 24k chars — env-raised thread caps must not widen egress", () => {
    const fat = Array.from({ length: 30 }, (_, i) => turn(i % 2 ? "assistant" : "user", "z".repeat(1000), i));
    expect(buildJevIntentRequest("hi", fat, 1000, 0)).toEqual({ ok: false, skip: "state_too_large" });
  });
});

describe("langOf", () => {
  it.each([
    ["帮我研究一下澳洲的利率走势", "zh"],
    ["what's the latest on the RBA?", "en"],
    ["帮我看看 your intent classifier 为什么 always picks research", "mixed"],
    ["", "en"]
  ])("%s → %s", (text, lang) => {
    expect(langOf(text)).toBe(lang);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/jev/intent-question.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** `src/jev/intent-question.ts`

```ts
import { feedTurnText, type Intent } from "../capabilities/intent.js";
import type { ChatTurnRow } from "../run/run-store.js";
import type { JevChoiceQuestion, JevRequest } from "./jev-client.js";

/**
 * The Jev twin of the LLM intent classifier (Jev spec 2026-09-25). Same inputs as
 * `buildIntentQuestion`, so a disagreement measures the model, not input drift. Criteria are
 * rewritten from INTENT_DISCIPLINE in literal, boundary-explicit wording — jev-1.13 reads literally.
 */
export const JEV_INTENTS: readonly Intent[] = ["answer", "research", "feedback", "clarify", "selfcode", "skill"];
export const MAX_LATEST_MESSAGE_CHARS = 8_000;
export const MAX_REQUEST_CHARS = 24_000;

export const JEV_INTENT_QUESTION: JevChoiceQuestion = {
  type: "choice",
  instructions:
    "How should Houge handle `latest_message`? Houge is the AI agent in this conversation; " +
    "\"Houge\", \"猴哥\", \"you\" and \"your\" in the messages all mean Houge. `recent_turns` is the " +
    "conversation before `latest_message`, oldest first. If `already_asked_clarification` is true, " +
    "Houge just asked a clarifying question and `latest_message` is the user's reply to it.",
  criteria: {
    answer:
      "Houge can answer from general knowledge, with no live web lookup. This includes requests to " +
      "explain, analyse or write something when no current information is needed.",
    research:
      "Answering needs current or live information from the web: current events, news, prices, " +
      "\"latest\", anything time-sensitive, or an explicit request to look up, find or research a topic.",
    feedback:
      "`latest_message` reacts to or corrects Houge's previous answer in `recent_turns` (for example " +
      "\"too long\", \"that's wrong\", \"prefer primary sources\") instead of asking a new question.",
    clarify:
      "`latest_message` is so ambiguous or underspecified that Houge cannot act without first asking " +
      "one question. Never this option when `already_asked_clarification` is true.",
    selfcode:
      "Asks Houge to read, inspect, diagnose, fix or change Houge's own source code or internal behaviour.",
    skill:
      "Explicitly asks Houge to create, write, improve or refine a reusable skill or procedure, or to " +
      "retire, restore, deactivate or re-enable (退役/停用/恢复/启用) an existing skill. Asking Houge to " +
      "PERFORM a task is not this option, even when a matching skill exists."
  }
};

export type Lang = "zh" | "en" | "mixed";

const CJK = /[㐀-鿿豈-﫿]/g;
const LATIN_WORD = /[A-Za-z]+/g;

/** Language tag for the per-language report split. One CJK char ≈ one latin word. */
export function langOf(text: string): Lang {
  const cjk = text.match(CJK)?.length ?? 0;
  const latin = text.match(LATIN_WORD)?.length ?? 0;
  if (cjk + latin === 0) return "en";
  const share = cjk / (cjk + latin);
  if (share >= 0.7) return "zh";
  if (share <= 0.2) return "en";
  return "mixed";
}

export type JevIntentRequest = { ok: true; request: JevRequest; chars: number } | { ok: false; skip: "state_too_large" };

export function buildJevIntentRequest(
  message: string,
  recentTurns: ChatTurnRow[],
  turnChars: number,
  recentClarifyCount: number
): JevIntentRequest {
  if (message.length > MAX_LATEST_MESSAGE_CHARS) return { ok: false, skip: "state_too_large" };
  const request: JevRequest = {
    state: {
      modality: "text",
      latest_message: message,
      recent_turns: recentTurns.map((t) => ({ role: t.role === "user" ? "user" : "houge", text: feedTurnText(t.text, turnChars) })),
      already_asked_clarification: recentClarifyCount > 0
    },
    questions: { intent: JEV_INTENT_QUESTION }
  };
  const chars = JSON.stringify(request).length;
  if (chars > MAX_REQUEST_CHARS) return { ok: false, skip: "state_too_large" };
  return { ok: true, request, chars };
}
```

The `langOf` fixtures are part of the contract. If the "mixed" example lands outside `(0.2, 0.7)`, do
**not** tune the fixture to fit. Adjust the thresholds and state why in the commit body.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/jev/intent-question.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/jev/intent-question.ts tests/jev/intent-question.test.ts
git commit -m "feat(jev): intent question builder — same inputs as the LLM classifier, hard egress caps, lang tag"
```

---

### Task 4: Store reads for replay reconstruction

**Files:**
- Modify: `src/run/run-store.ts` (add after `getRecentChatTurns`, ~L950; the row type next to `ChatTurnRow` ~L258)
- Test: `tests/run/replay-reads.test.ts`

**Interfaces:**
- Produces:
```ts
export interface ReplayTurnRow {
  turn_id: string; chat_id: string; run_id: string; text: string; created_at: string;
  recorded_intent: string;
  anchor: string | null;                       // classification time (see anchor_kind)
  anchor_kind: "classify" | "run_start" | null;
}
getChatTurnsBefore(chat_id: string, limit: number, sinceIso: string, beforeIso: string, excludeRunId: string): ChatTurnRow[];
listReplayTurns(opts: { sinceIso?: string; limit?: number }): ReplayTurnRow[];
runLoopCapabilities(run_id: string): string[];
```

- [ ] **Step 1: Write the failing tests** in `tests/run/replay-reads.test.ts`

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { RunStore } from "../../src/run/run-store.js";

function createRun(store: RunStore, key: string): string {
  const created = store.createOrGet(buildTypedTaskEvent({
    source: "cli", type: "run", program: "research-brief", goal: key,
    requested_by: { kind: "user", id: "paco" }, notify: { kind: "local" },
    idempotency_key: key, source_reference: "argv", created_at: "2026-09-01T00:00:00.000Z"
  }));
  if (created.status !== "created") throw new Error("expected created");
  return created.run_id;
}
const at = (iso: string) => vi.setSystemTime(new Date(iso));

afterEach(() => vi.useRealTimers());

describe("replay reads", () => {
  it("anchors on the classify attempt, not chat_turns.created_at (completion time — codex BLOCKER 1)", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const store = RunStore.openInMemory();
    try {
      at("2026-09-10T00:00:00.000Z");
      const run = createRun(store, "k1");
      at("2026-09-10T00:00:05.000Z");
      store.llmAuditSink({ run_id: run, role: "classify" }).record({ provider: "pi", role: "", outcome: "ok", model: "m", latency_ms: 1 });
      store.recordChatTurn({ chat_id: "c", run_id: run, role: "user", text: "q", created_at: "2026-09-10T00:01:00.000Z" });
      store.recordChatTurn({ chat_id: "c", run_id: run, role: "assistant", text: "a", intent: "research", created_at: "2026-09-10T00:01:00.001Z" });
      const [row] = store.listReplayTurns({});
      expect(row).toMatchObject({ run_id: run, text: "q", recorded_intent: "research", anchor: "2026-09-10T00:00:05.000Z", anchor_kind: "classify" });
    } finally {
      store.close();
    }
  });

  it("falls back to the run's earliest ledger event before the audit chokepoint existed", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const store = RunStore.openInMemory();
    try {
      at("2026-08-01T00:00:00.000Z");
      const run = createRun(store, "k2");
      store.recordChatTurn({ chat_id: "c", run_id: run, role: "user", text: "q", created_at: "2026-08-01T00:02:00.000Z" });
      store.recordChatTurn({ chat_id: "c", run_id: run, role: "assistant", text: "a", intent: "answer", created_at: "2026-08-01T00:02:00.001Z" });
      const [row] = store.listReplayTurns({});
      expect(row!.anchor_kind).toBe("run_start");
      expect(row!.anchor).toBe(store.getLedgerEvents(run)[0]!.occurred_at);
    } finally {
      store.close();
    }
  });

  it("excludes evolution_report rows, user turns with no classified reply, and honours since/limit", () => {
    const store = RunStore.openInMemory();
    try {
      const a = createRun(store, "a"); const b = createRun(store, "b"); const c = createRun(store, "c");
      store.recordChatTurn({ chat_id: "c", run_id: a, role: "user", text: "1", created_at: "2026-09-01T00:00:00.000Z" });
      store.recordChatTurn({ chat_id: "c", run_id: a, role: "assistant", text: "r", intent: "evolution_report", created_at: "2026-09-01T00:00:01.000Z" });
      store.recordChatTurn({ chat_id: "c", run_id: b, role: "user", text: "2", created_at: "2026-09-02T00:00:00.000Z" });
      store.recordChatTurn({ chat_id: "c", run_id: c, role: "user", text: "3", created_at: "2026-09-03T00:00:00.000Z" });
      store.recordChatTurn({ chat_id: "c", run_id: c, role: "assistant", text: "r", intent: "answer", created_at: "2026-09-03T00:00:01.000Z" });
      expect(store.listReplayTurns({}).map((r) => r.text)).toEqual(["3"]);
      expect(store.listReplayTurns({ sinceIso: "2026-09-04T00:00:00.000Z" })).toEqual([]);
      expect(store.listReplayTurns({ limit: 0 })).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("getChatTurnsBefore: strictly before the anchor, inside the window, never the target run's own rows", () => {
    const store = RunStore.openInMemory();
    try {
      const rows = [
        ["r0", "user", "too old", "2026-09-01T00:00:00.000Z"],
        ["r1", "user", "in window", "2026-09-05T00:00:00.000Z"],
        ["r1", "assistant", "reply", "2026-09-05T00:00:01.000Z"],
        ["r2", "user", "concurrent run, completed later", "2026-09-05T00:10:00.000Z"],
        ["rT", "user", "target", "2026-09-05T00:00:03.000Z"]
      ] as const;
      for (const [run_id, role, text, created_at] of rows) store.recordChatTurn({ chat_id: "c", run_id, role, text, created_at });
      const got = store.getChatTurnsBefore("c", 20, "2026-09-04T00:00:00.000Z", "2026-09-05T00:05:00.000Z", "rT");
      expect(got.map((t) => t.text)).toEqual(["in window", "reply"]);
      expect(store.getChatTurnsBefore("c", 1, "2026-09-04T00:00:00.000Z", "2026-09-05T00:05:00.000Z", "rT").map((t) => t.text)).toEqual(["reply"]);
    } finally {
      store.close();
    }
  });

  it("runLoopCapabilities returns the distinct capabilities the loop used", () => {
    const store = RunStore.openInMemory();
    try {
      const run = createRun(store, "k3");
      for (const capability of ["web_search", "web_search", "http_fetch"]) {
        store.recordLoopStep(run, { step: 1, action: "tool", capability, ok: true, result_digest: "" });
      }
      expect(store.runLoopCapabilities(run).sort()).toEqual(["http_fetch", "web_search"]);
      expect(store.runLoopCapabilities("nope")).toEqual([]);
    } finally {
      store.close();
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/run/replay-reads.test.ts`
Expected: FAIL. TypeScript errors / "listReplayTurns is not a function".

- [ ] **Step 3: Implement** in `src/run/run-store.ts`

Next to `ChatTurnRow`:
```ts
/** One historical user turn eligible for Jev replay (Jev spec 2026-09-25). */
export interface ReplayTurnRow {
  turn_id: string;
  chat_id: string;
  run_id: string;
  text: string;
  created_at: string;
  recorded_intent: string;
  /** When the classifier ran: its first `classify` llm_attempt, else the run's first ledger event. */
  anchor: string | null;
  anchor_kind: "classify" | "run_start" | null;
}
```

After `getRecentChatTurns`:
```ts
  /**
   * The thread as it stood at `beforeIso` (exclusive), for Jev replay. `chat_turns.created_at` is
   * COMPLETION time — both rows of a turn are written after the loop — so the target run's own rows
   * are excluded explicitly, and a run that completed after the anchor is naturally left out.
   */
  getChatTurnsBefore(chat_id: string, limit: number, sinceIso: string, beforeIso: string, excludeRunId: string): ChatTurnRow[] {
    return this.db.prepare(`
      SELECT turn_id, chat_id, run_id, role, text, intent, created_at
      FROM chat_turns
      WHERE chat_id = ? AND created_at >= ? AND created_at < ? AND run_id <> ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `).all<ChatTurnRow>(chat_id, sinceIso, beforeIso, excludeRunId, limit).reverse();
  }

  /** User turns whose run produced a classified assistant reply, oldest first (Jev replay). */
  listReplayTurns(opts: { sinceIso?: string; limit?: number }): ReplayTurnRow[] {
    const rows = this.db.prepare(`
      SELECT u.turn_id, u.chat_id, u.run_id, u.text, u.created_at, a.intent AS recorded_intent,
        (SELECT MIN(e.occurred_at) FROM ledger_events e
          WHERE e.run_id = u.run_id AND e.event_type = 'llm_attempt'
            AND json_extract(e.payload_json, '$.role') = 'classify') AS classify_at,
        (SELECT MIN(e.occurred_at) FROM ledger_events e WHERE e.run_id = u.run_id) AS run_start
      FROM chat_turns u
      JOIN chat_turns a ON a.run_id = u.run_id AND a.role = 'assistant'
      WHERE u.role = 'user' AND a.intent IS NOT NULL AND a.intent <> 'evolution_report'
        AND u.created_at >= ?
      ORDER BY u.created_at ASC, u.rowid ASC
      LIMIT ?
    `).all<Omit<ReplayTurnRow, "anchor" | "anchor_kind"> & { classify_at: string | null; run_start: string | null }>(
      opts.sinceIso ?? "", opts.limit ?? -1
    );
    return rows.map(({ classify_at, run_start, ...row }) => ({
      ...row,
      anchor: classify_at ?? run_start,
      anchor_kind: classify_at ? "classify" : run_start ? "run_start" : null
    }));
  }

  /** Distinct `loop_step.capability` values for a run — the replay's observed-action proxy. */
  runLoopCapabilities(run_id: string): string[] {
    return this.db.prepare(`
      SELECT DISTINCT json_extract(payload_json, '$.capability') AS capability
      FROM ledger_events WHERE run_id = ? AND event_type = 'loop_step'
    `).all<{ capability: string | null }>(run_id)
      .map((r) => r.capability)
      .filter((c): c is string => typeof c === "string" && c.length > 0);
  }
```
(SQLite `LIMIT -1` means no limit.)

**Check before implementing:** the column names in `ledger_events` must be `run_id`, `event_type`,
`occurred_at` and `payload_json`. Run `sqlite3 -readonly houge.sqlite ".schema ledger_events"`. If a
name differs, use the real one; do not rename anything.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/run/replay-reads.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/run/run-store.ts tests/run/replay-reads.test.ts
git commit -m "feat(store): replay reads — classification-time anchor, thread-before-anchor, loop capabilities"
```

---

### Task 5: Replay engine + report

**Files:**
- Create: `src/jev/replay.ts`, `src/jev/replay-report.ts`
- Test: `tests/jev/replay.test.ts`, `tests/jev/replay-report.test.ts`

**Interfaces:**
- Consumes: Task 2 (`JevRequest`, `JevResult`); Task 3 (`buildJevIntentRequest`, `langOf`, `Lang`);
  Task 4 (`ReplayTurnRow`, store methods); `intent.ts` (`buildIntentQuestion`, `buildIntentSystemPrompt`,
  `parseIntent`, `countTrailingClarifyTurns`, `chatContextSince`, `resolveChatContextTurns`,
  `resolveChatContextTurnChars`); `computeCostUsd` from `metered-pricing.ts`.
- Produces:
```ts
// replay.ts
export type ObservedAction = "selfcode" | "skill" | "research" | "answer" | "unknown";
export function observedAction(capabilities: string[]): ObservedAction;
export function llmLabel(raw: string): { intent: Intent; parsed: boolean };
export type ReplayStatus = "ok" | "dry_run" | "skipped_state_too_large" | "skipped_no_anchor" | "jev_failed" | "llm_failed";
export interface ReplayRow {
  turn_id: string; run_id: string; lang: Lang; anchor_kind: "classify" | "run_start" | null;
  status: ReplayStatus; recorded_intent: string; observed_action: ObservedAction; est_tokens: number;
  jev_intent?: string; jev_confidence?: number; jev_probabilities?: Record<string, number>; jev_model?: string;
  llm_intent?: Intent; llm_parsed?: boolean; error?: string;
}
export interface ReplayDeps {
  store: Pick<RunStore, "listReplayTurns" | "getChatTurnsBefore" | "runLoopCapabilities">;
  env: NodeJS.ProcessEnv;
  jev: (req: JevRequest) => Promise<JevResult>;
  classifyLlm: (question: string, system: string) => Promise<{ ok: true; raw: string } | { ok: false; error: string }>;
  outPath: string; maxUsd: number; dryRun: boolean; sinceIso?: string; limit?: number;
  log?: (line: string) => void;
}
export interface ReplayOutcome { rows: ReplayRow[]; spentUsd: number; estimatedUsd: number; stopped?: "budget" | "auth" }
export function runReplay(deps: ReplayDeps): Promise<ReplayOutcome>;
export function parseReplayArgs(argv: string[]): { ok: true; sinceIso?: string; limit?: number; maxUsd: number; dryRun: boolean } | { ok: false; error: string };
export const REPLAY_OUT_PATH = ".houge/jev-shadow/replay.jsonl";
// replay-report.ts
export interface ReplaySummary {
  eligible: number; matched: number; byStatus: Record<string, number>; fallbackAnchors: number;
  thresholds: { t: number; slice: number; agreement: number | null; coverage: number | null }[];
  byLang: Record<string, { matched: number; agreementAt07: number | null; coverageAt07: number | null }>;
  verdict: "GO" | "STOP"; verdictReason: string;
  disagreements: { turn_id: string; jev: string; llm: string; confidence: number; lang: string }[];
}
export function summarizeReplay(rows: ReplayRow[]): ReplaySummary;
export function formatReplayReport(rows: ReplayRow[], outcome: { spentUsd: number; estimatedUsd: number; stopped?: string }): string;
```

- [ ] **Step 1: Write the failing engine tests** in `tests/jev/replay.test.ts`

```ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { JevResult } from "../../src/jev/jev-client.js";
import { llmLabel, observedAction, parseReplayArgs, runReplay, type ReplayDeps } from "../../src/jev/replay.js";
import type { ChatTurnRow, ReplayTurnRow } from "../../src/run/run-store.js";

const T = (i: number, over: Partial<ReplayTurnRow> = {}): ReplayTurnRow => ({
  turn_id: `u${i}`, chat_id: "c", run_id: `r${i}`, text: `message ${i}`, created_at: `2026-09-10T00:0${i}:00.000Z`,
  recorded_intent: "answer", anchor: `2026-09-10T00:0${i}:00.000Z`, anchor_kind: "classify", ...over
});
const jevOk = (choice = "research", confidence = 0.9): JevResult => ({
  ok: true, model: "jev-1.13.0", input_tokens: 400, latency_ms: 5,
  answers: { intent: { choice, confidence, probabilities: { answer: 0, research: 1, feedback: 0, clarify: 0, selfcode: 0, skill: 0 } } }
});

function deps(turns: ReplayTurnRow[], over: Partial<ReplayDeps> = {}) {
  const outPath = join(mkdtempSync(join(tmpdir(), "jev-replay-")), "replay.jsonl");
  const getChatTurnsBefore = vi.fn((): ChatTurnRow[] => []);
  const d: ReplayDeps = {
    store: { listReplayTurns: () => turns, getChatTurnsBefore, runLoopCapabilities: () => ["web_search"] },
    env: {},
    jev: vi.fn(async () => jevOk()),
    classifyLlm: vi.fn(async () => ({ ok: true as const, raw: '{"intent":"research","query":"x"}' })),
    outPath, maxUsd: 1, dryRun: false, ...over
  };
  return { d, outPath, getChatTurnsBefore };
}

describe("observedAction / llmLabel", () => {
  it.each([
    [["web_search", "self_write_propose"], "selfcode"],
    [["skill_author", "web_search"], "skill"],
    [["http_fetch"], "research"],
    [[], "answer"],
    [["lesson_write"], "unknown"]
  ])("%j → %s (precedence selfcode > skill > research)", (caps, want) => {
    expect(observedAction(caps as string[])).toBe(want);
  });

  it("marks an unparseable LLM reply as not parsed — parseIntent's silent 'answer' default must not count as agreement", () => {
    expect(llmLabel("sorry, I can't")).toEqual({ intent: "answer", parsed: false });
    expect(llmLabel('```json\n{"intent": "Selfcode"}\n```')).toEqual({ intent: "selfcode", parsed: true });
  });
});

describe("runReplay", () => {
  it("asks BOTH classifiers on the thread rebuilt at the anchor, excluding the target run", async () => {
    const { d, getChatTurnsBefore } = deps([T(1)]);
    const out = await runReplay(d);
    expect(getChatTurnsBefore).toHaveBeenCalledWith("c", 20, "2026-09-09T00:01:00.000Z", "2026-09-10T00:01:00.000Z", "r1");
    expect(out.rows[0]).toMatchObject({ status: "ok", jev_intent: "research", llm_intent: "research", llm_parsed: true, observed_action: "research", recorded_intent: "answer" });
    const [, system] = (d.classifyLlm as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(system).toContain("Today's date is 2026-09-10"); // dated at the ANCHOR, not today
  });

  it("writes JSONL rows WITHOUT message text (bodies never leave the ledger rule)", async () => {
    const { d, outPath } = deps([T(1, { text: "SECRET-ish personal message" })]);
    await runReplay(d);
    const file = readFileSync(outPath, "utf8");
    expect(file).not.toContain("SECRET-ish");
    expect(JSON.parse(file.trim())).toMatchObject({ turn_id: "u1", status: "ok" });
  });

  it("resumes: done turns are skipped on a second run, failed ones are retried", async () => {
    const turns = [T(1), T(2)];
    const first = deps(turns, { jev: vi.fn().mockResolvedValueOnce(jevOk()).mockResolvedValueOnce({ ok: false, reason: "error", detail: "HTTP 500" }) });
    await runReplay(first.d);
    const jev2 = vi.fn(async () => jevOk());
    const out = await runReplay({ ...first.d, jev: jev2 });
    expect(jev2).toHaveBeenCalledTimes(1);
    expect(out.rows.map((r) => [r.turn_id, r.status])).toEqual([["u1", "ok"], ["u2", "ok"]]);
  });

  it("stops before a request would push reserved spend past --max-usd", async () => {
    // First call's estimate is tiny (≪ $0.03) so it dispatches; it then reports 1M input tokens
    // ($0.042 spent), so the second call's spent+estimate exceeds the cap → stop before dispatch.
    const jev = vi.fn(async (): Promise<JevResult> => ({ ...jevOk(), input_tokens: 1_000_000 } as JevResult));
    const { d } = deps([T(1), T(2)], { maxUsd: 0.03, jev });
    const out = await runReplay(d);
    expect(out.stopped).toBe("budget");
    expect(d.jev).toHaveBeenCalledTimes(1);
  });

  it("aborts the whole run on auth — 373 identical failures are noise", async () => {
    const { d } = deps([T(1), T(2)], { jev: vi.fn(async (): Promise<JevResult> => ({ ok: false, reason: "auth", detail: "HTTP 401" })) });
    const out = await runReplay(d);
    expect(out.stopped).toBe("auth");
    expect(d.jev).toHaveBeenCalledTimes(1);
  });

  it("skips no-anchor and over-cap turns with a reason, and never calls either classifier for them", async () => {
    const { d } = deps([T(1, { anchor: null, anchor_kind: null }), T(2, { text: "y".repeat(9000) })]);
    const out = await runReplay(d);
    expect(out.rows.map((r) => r.status)).toEqual(["skipped_no_anchor", "skipped_state_too_large"]);
    expect(d.jev).not.toHaveBeenCalled();
    expect(d.classifyLlm).not.toHaveBeenCalled();
  });

  it("--dry-run calls nothing and reports an estimate", async () => {
    const { d } = deps([T(1)], { dryRun: true });
    const out = await runReplay(d);
    expect(d.jev).not.toHaveBeenCalled();
    expect(d.classifyLlm).not.toHaveBeenCalled();
    expect(out.rows[0]!.status).toBe("dry_run");
    expect(out.estimatedUsd).toBeGreaterThan(0);
  });
});

describe("parseReplayArgs", () => {
  it("parses flags with safe defaults and rejects junk", () => {
    expect(parseReplayArgs([])).toEqual({ ok: true, maxUsd: 1, dryRun: false });
    expect(parseReplayArgs(["--since", "2026-09-01T00:00:00.000Z", "--limit", "5", "--max-usd", "0.2", "--dry-run"]))
      .toEqual({ ok: true, sinceIso: "2026-09-01T00:00:00.000Z", limit: 5, maxUsd: 0.2, dryRun: true });
    expect(parseReplayArgs(["--limit", "-3"]).ok).toBe(false);
    expect(parseReplayArgs(["--since", "yesterday"]).ok).toBe(false);
    expect(parseReplayArgs(["--bogus"]).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Write the failing report tests** in `tests/jev/replay-report.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { formatReplayReport, summarizeReplay } from "../../src/jev/replay-report.js";
import type { ReplayRow } from "../../src/jev/replay.js";

const row = (i: number, jev: string, llm: string, confidence: number, over: Partial<ReplayRow> = {}): ReplayRow => ({
  turn_id: `u${i}`, run_id: `r${i}`, lang: "en", anchor_kind: "classify", status: "ok", recorded_intent: "answer",
  observed_action: "answer", est_tokens: 100, jev_intent: jev, jev_confidence: confidence, jev_model: "jev-1.13.0",
  jev_probabilities: {}, llm_intent: llm as ReplayRow["llm_intent"], llm_parsed: true, ...over
});
const agreeing = (n: number, start = 0) => Array.from({ length: n }, (_, i) => row(start + i, "research", "research", 0.9));
const disagreeing = (n: number, start = 1000) => Array.from({ length: n }, (_, i) => row(start + i, "answer", "research", 0.9));

describe("summarizeReplay — the GO/STOP screen", () => {
  it("GO at exactly 75% agreement at confidence ≥ 0.7", () => {
    expect(summarizeReplay([...agreeing(75), ...disagreeing(25)]).verdict).toBe("GO");
  });

  it("STOP just under the bar", () => {
    expect(summarizeReplay([...agreeing(74), ...disagreeing(26)]).verdict).toBe("STOP");
  });

  it("STOP when under 60% of eligible turns reach a matched pair — a biased remnant is not evidence", () => {
    const failed = Array.from({ length: 50 }, (_, i) => row(2000 + i, "x", "x", 0, { status: "jev_failed" }));
    const s = summarizeReplay([...agreeing(40), ...failed]);
    expect(s.verdict).toBe("STOP");
    expect(s.verdictReason).toMatch(/matched/);
  });

  it("an unparsed LLM label never counts as a match (parseIntent defaults to 'answer' silently)", () => {
    const s = summarizeReplay([row(1, "answer", "answer", 0.9, { llm_parsed: false })]);
    expect(s.matched).toBe(0);
  });

  it("low-confidence rows are outside the 0.7 slice; coverage is slice / matched", () => {
    const s = summarizeReplay([...agreeing(6), ...Array.from({ length: 4 }, (_, i) => row(500 + i, "answer", "research", 0.3))]);
    const t07 = s.thresholds.find((t) => t.t === 0.7)!;
    expect(t07).toMatchObject({ slice: 6, agreement: 1, coverage: 0.6 });
  });

  it("dry_run rows are not eligible; per-language split and fallback-anchor count are reported", () => {
    const rows = [...agreeing(3), row(9, "answer", "answer", 0.9, { lang: "zh", anchor_kind: "run_start" }), row(10, "x", "x", 0, { status: "dry_run" })];
    const s = summarizeReplay(rows);
    expect(s.eligible).toBe(4);
    expect(s.fallbackAnchors).toBe(1);
    expect(s.byLang.zh).toMatchObject({ matched: 1, agreementAt07: 1 });
  });

  it("lists at most 20 disagreements, most confident first", () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(i, "answer", "research", 0.5 + i / 100));
    const s = summarizeReplay(rows);
    expect(s.disagreements).toHaveLength(20);
    expect(s.disagreements[0]!.confidence).toBeCloseTo(0.79);
  });

  it("the printed report states the verdict, counts, cost and that anchors are approximate", () => {
    const text = formatReplayReport([...agreeing(8), ...disagreeing(2)], { spentUsd: 0.0012, estimatedUsd: 0.0012 });
    expect(text).toMatch(/Verdict: GO/);
    expect(text).toMatch(/eligible 10/);
    expect(text).toMatch(/\$0\.0012/);
    expect(text).toMatch(/approximate/);
  });
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `npx vitest run tests/jev/replay.test.ts tests/jev/replay-report.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement** `src/jev/replay.ts`

```ts
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  buildIntentQuestion, buildIntentSystemPrompt, chatContextSince, countTrailingClarifyTurns,
  parseIntent, resolveChatContextTurnChars, resolveChatContextTurns, type Intent
} from "../capabilities/intent.js";
import { computeCostUsd } from "../llm/metered-pricing.js";
import type { ReplayTurnRow, RunStore } from "../run/run-store.js";
import { JEV_MODEL, type JevRequest, type JevResult } from "./jev-client.js";
import { buildJevIntentRequest, langOf, type Lang } from "./intent-question.js";

/**
 * `houge jev-shadow replay` engine (Jev spec 2026-09-25, rollout steps 1–3). Sequential by design:
 * the replayed LLM leg must not compete with the live daemon, and one-at-a-time dispatch makes the
 * --max-usd reservation exact. Rows carry labels and numbers only — never message text.
 */
export const REPLAY_OUT_PATH = ".houge/jev-shadow/replay.jsonl";

export type ObservedAction = "selfcode" | "skill" | "research" | "answer" | "unknown";
export type ReplayStatus = "ok" | "dry_run" | "skipped_state_too_large" | "skipped_no_anchor" | "jev_failed" | "llm_failed";
export interface ReplayRow {
  turn_id: string;
  run_id: string;
  lang: Lang;
  anchor_kind: "classify" | "run_start" | null;
  status: ReplayStatus;
  recorded_intent: string;
  observed_action: ObservedAction;
  est_tokens: number;
  jev_intent?: string;
  jev_confidence?: number;
  jev_probabilities?: Record<string, number>;
  jev_model?: string;
  llm_intent?: Intent;
  llm_parsed?: boolean;
  error?: string;
}
export interface ReplayDeps {
  store: Pick<RunStore, "listReplayTurns" | "getChatTurnsBefore" | "runLoopCapabilities">;
  env: NodeJS.ProcessEnv;
  jev: (req: JevRequest) => Promise<JevResult>;
  classifyLlm: (question: string, system: string) => Promise<{ ok: true; raw: string } | { ok: false; error: string }>;
  outPath: string;
  maxUsd: number;
  dryRun: boolean;
  sinceIso?: string;
  limit?: number;
  log?: (line: string) => void;
}
export interface ReplayOutcome {
  rows: ReplayRow[];
  spentUsd: number;
  estimatedUsd: number;
  stopped?: "budget" | "auth";
}

const DONE: ReadonlySet<ReplayStatus> = new Set(["ok", "skipped_state_too_large", "skipped_no_anchor"]);
const INTENT_IN_JSON = /"intent"\s*:\s*"\s*(answer|research|feedback|clarify|selfcode|skill)\s*"/i;

export function observedAction(capabilities: string[]): ObservedAction {
  const has = (...names: string[]) => names.some((n) => capabilities.includes(n));
  if (has("self_diagnose", "self_write_propose")) return "selfcode";
  if (has("skill_author")) return "skill";
  if (has("web_search", "http_fetch")) return "research";
  return capabilities.length === 0 ? "answer" : "unknown";
}

/** parseIntent defaults to "answer" on garbage; `parsed` tells a real verdict from that default. */
export function llmLabel(raw: string): { intent: Intent; parsed: boolean } {
  return { intent: parseIntent(raw).intent, parsed: INTENT_IN_JSON.test(raw) };
}

/** chars/3 for CJK-heavy text, chars/4 otherwise — only for the pre-dispatch cost reservation. */
function estimateTokens(chars: number, lang: Lang): number {
  return Math.ceil(chars / (lang === "en" ? 4 : 3));
}

function readDone(outPath: string): Map<string, ReplayRow> {
  const done = new Map<string, ReplayRow>();
  if (!existsSync(outPath)) return done;
  for (const line of readFileSync(outPath, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    const row = JSON.parse(line) as ReplayRow;
    if (DONE.has(row.status)) done.set(row.turn_id, row);
    else done.delete(row.turn_id);
  }
  return done;
}

export async function runReplay(deps: ReplayDeps): Promise<ReplayOutcome> {
  const log = deps.log ?? (() => {});
  const done = deps.dryRun ? new Map<string, ReplayRow>() : readDone(deps.outPath);
  if (!deps.dryRun) mkdirSync(dirname(deps.outPath), { recursive: true });
  const turns = deps.store.listReplayTurns({
    ...(deps.sinceIso !== undefined ? { sinceIso: deps.sinceIso } : {}),
    ...(deps.limit !== undefined ? { limit: deps.limit } : {})
  });
  const rows: ReplayRow[] = [];
  let spentUsd = 0;
  let estimatedUsd = 0;

  for (const turn of turns) {
    const prior = done.get(turn.turn_id);
    if (prior) {
      rows.push(prior);
      continue;
    }
    const prepared = prepare(deps, turn);
    if ("row" in prepared) {
      emit(deps, rows, prepared.row);
      continue;
    }
    const estUsd = jevUsd(prepared.base.est_tokens, deps.env);
    estimatedUsd += estUsd;
    if (deps.dryRun) {
      rows.push({ ...prepared.base, status: "dry_run" });
      continue;
    }
    if (spentUsd + estUsd > deps.maxUsd) {
      log(`stopping: next request would exceed --max-usd ${deps.maxUsd}`);
      return { rows, spentUsd, estimatedUsd, stopped: "budget" };
    }
    const jev = await deps.jev(prepared.request);
    if (!jev.ok) {
      emit(deps, rows, { ...prepared.base, status: "jev_failed", error: jev.detail });
      if (jev.reason === "auth" || jev.reason === "no_key") return { rows, spentUsd, estimatedUsd, stopped: "auth" };
      continue;
    }
    spentUsd += jevUsd(jev.input_tokens, deps.env);
    const answer = jev.answers.intent!;
    const withJev: ReplayRow = {
      ...prepared.base, status: "ok", jev_intent: answer.choice, jev_confidence: answer.confidence,
      jev_probabilities: answer.probabilities, jev_model: jev.model
    };
    const llm = await deps.classifyLlm(prepared.llmQuestion, prepared.llmSystem);
    if (!llm.ok) {
      emit(deps, rows, { ...withJev, status: "llm_failed", error: llm.error });
      continue;
    }
    const label = llmLabel(llm.raw);
    emit(deps, rows, { ...withJev, llm_intent: label.intent, llm_parsed: label.parsed });
    log(`${rows.length}/${turns.length} ${turn.turn_id} jev=${answer.choice}@${answer.confidence.toFixed(2)} llm=${label.intent}`);
  }
  return { rows, spentUsd, estimatedUsd };
}

type Prepared =
  | { row: ReplayRow }
  | { base: ReplayRow; request: JevRequest; llmQuestion: string; llmSystem: string };

function prepare(deps: ReplayDeps, turn: ReplayTurnRow): Prepared {
  const lang = langOf(turn.text);
  const base: ReplayRow = {
    turn_id: turn.turn_id, run_id: turn.run_id, lang, anchor_kind: turn.anchor_kind, status: "ok",
    recorded_intent: turn.recorded_intent, observed_action: observedAction(deps.store.runLoopCapabilities(turn.run_id)), est_tokens: 0
  };
  if (turn.anchor === null) return { row: { ...base, status: "skipped_no_anchor" } };
  const anchor = new Date(turn.anchor);
  const turnChars = resolveChatContextTurnChars(deps.env);
  const recent = deps.store.getChatTurnsBefore(
    turn.chat_id, resolveChatContextTurns(deps.env), chatContextSince(deps.env, anchor), turn.anchor, turn.run_id
  );
  const clarifyCount = countTrailingClarifyTurns(recent);
  const built = buildJevIntentRequest(turn.text, recent, turnChars, clarifyCount);
  if (!built.ok) return { row: { ...base, status: "skipped_state_too_large" } };
  return {
    base: { ...base, est_tokens: estimateTokens(built.chars, lang) },
    request: built.request,
    llmQuestion: buildIntentQuestion(turn.text, recent, turnChars, clarifyCount),
    llmSystem: buildIntentSystemPrompt(anchor)
  };
}

function jevUsd(tokens: number, env: NodeJS.ProcessEnv): number {
  return computeCostUsd("jev", JEV_MODEL, { input_tokens: tokens, output_tokens: 0, cached_input_tokens: 0 }, env) ?? 0;
}

function emit(deps: ReplayDeps, rows: ReplayRow[], row: ReplayRow): void {
  rows.push(row);
  if (!deps.dryRun) appendFileSync(deps.outPath, `${JSON.stringify(row)}\n`);
}

export function parseReplayArgs(
  argv: string[]
): { ok: true; sinceIso?: string; limit?: number; maxUsd: number; dryRun: boolean } | { ok: false; error: string } {
  let sinceIso: string | undefined;
  let limit: number | undefined;
  let maxUsd = 1;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--dry-run") { dryRun = true; continue; }
    if (flag === "--since" && value && !Number.isNaN(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T/.test(value)) { sinceIso = value; i += 1; continue; }
    if (flag === "--limit" && value && /^\d+$/.test(value)) { limit = Number(value); i += 1; continue; }
    if (flag === "--max-usd" && value && Number(value) > 0) { maxUsd = Number(value); i += 1; continue; }
    return { ok: false, error: `bad argument near "${flag ?? ""}". Usage: houge jev-shadow replay [--since ISO] [--limit N] [--max-usd USD] [--dry-run]` };
  }
  return { ok: true, ...(sinceIso !== undefined ? { sinceIso } : {}), ...(limit !== undefined ? { limit } : {}), maxUsd, dryRun };
}
```

The window test expects `since` = anchor − 1440 min. That is the `chatContextSince` default, with an
empty `env`.

- [ ] **Step 5: Implement** `src/jev/replay-report.ts`

```ts
import type { ReplayRow } from "./replay.js";

/** Replay GO/STOP screen (Jev spec 2026-09-25). Replay is a feasibility screen, not the promotion gate. */
const THRESHOLDS = [0.5, 0.6, 0.7, 0.8, 0.9];
const GATE_CONFIDENCE = 0.7;
const GO_AGREEMENT = 0.75;
const MIN_MATCHED_SHARE = 0.6;
const MAX_DISAGREEMENTS = 20;

export interface ReplaySummary {
  eligible: number;
  matched: number;
  byStatus: Record<string, number>;
  fallbackAnchors: number;
  thresholds: { t: number; slice: number; agreement: number | null; coverage: number | null }[];
  byLang: Record<string, { matched: number; agreementAt07: number | null; coverageAt07: number | null }>;
  verdict: "GO" | "STOP";
  verdictReason: string;
  disagreements: { turn_id: string; jev: string; llm: string; confidence: number; lang: string }[];
}

const isMatched = (r: ReplayRow): boolean =>
  r.status === "ok" && r.llm_parsed === true && r.jev_intent !== undefined && r.llm_intent !== undefined && r.jev_confidence !== undefined;

function atThreshold(matched: ReplayRow[], t: number) {
  const slice = matched.filter((r) => (r.jev_confidence ?? 0) >= t);
  const agree = slice.filter((r) => r.jev_intent === r.llm_intent).length;
  return {
    t,
    slice: slice.length,
    agreement: slice.length > 0 ? agree / slice.length : null,
    coverage: matched.length > 0 ? slice.length / matched.length : null
  };
}

export function summarizeReplay(rows: ReplayRow[]): ReplaySummary {
  const eligibleRows = rows.filter((r) => r.status !== "dry_run");
  const matched = eligibleRows.filter(isMatched);
  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const byLang: ReplaySummary["byLang"] = {};
  for (const lang of new Set(matched.map((r) => r.lang))) {
    const m = matched.filter((r) => r.lang === lang);
    const t = atThreshold(m, GATE_CONFIDENCE);
    byLang[lang] = { matched: m.length, agreementAt07: t.agreement, coverageAt07: t.coverage };
  }
  const gate = atThreshold(matched, GATE_CONFIDENCE);
  const matchedShare = eligibleRows.length > 0 ? matched.length / eligibleRows.length : 0;
  let verdict: "GO" | "STOP" = "GO";
  let verdictReason = `agreement ${pct(gate.agreement)} at confidence ≥ ${GATE_CONFIDENCE} (bar ${pct(GO_AGREEMENT)})`;
  if (matchedShare < MIN_MATCHED_SHARE) {
    verdict = "STOP";
    verdictReason = `only ${pct(matchedShare)} of eligible turns matched (bar ${pct(MIN_MATCHED_SHARE)})`;
  } else if (gate.agreement === null || gate.agreement < GO_AGREEMENT) {
    verdict = "STOP";
  }
  const disagreements = matched
    .filter((r) => r.jev_intent !== r.llm_intent)
    .sort((a, b) => (b.jev_confidence ?? 0) - (a.jev_confidence ?? 0))
    .slice(0, MAX_DISAGREEMENTS)
    .map((r) => ({ turn_id: r.turn_id, jev: r.jev_intent!, llm: r.llm_intent!, confidence: r.jev_confidence!, lang: r.lang }));
  return {
    eligible: eligibleRows.length,
    matched: matched.length,
    byStatus,
    fallbackAnchors: eligibleRows.filter((r) => r.anchor_kind === "run_start").length,
    thresholds: THRESHOLDS.map((t) => atThreshold(matched, t)),
    byLang,
    verdict,
    verdictReason,
    disagreements
  };
}

function pct(x: number | null): string {
  return x === null ? "n/a" : `${(x * 100).toFixed(1)}%`;
}

function confusion(rows: ReplayRow[], other: (r: ReplayRow) => string | undefined, label: string): string[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.jev_intent} → ${other(r) ?? "?"}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [`Jev vs ${label}:`, ...[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `  ${k}: ${n}`)];
}

export function formatReplayReport(rows: ReplayRow[], outcome: { spentUsd: number; estimatedUsd: number; stopped?: string }): string {
  const s = summarizeReplay(rows);
  const matched = rows.filter(isMatched);
  return [
    `Verdict: ${s.verdict} — ${s.verdictReason}`,
    outcome.stopped ? `Run STOPPED early: ${outcome.stopped}` : "",
    `Counts: eligible ${s.eligible}, matched ${s.matched}; by status ${JSON.stringify(s.byStatus)}`,
    `Cost: spent $${outcome.spentUsd.toFixed(4)} (estimated $${outcome.estimatedUsd.toFixed(4)})`,
    `Thread reconstruction is approximate: ${s.fallbackAnchors} turn(s) used the run-start fallback anchor.`,
    "",
    "Agreement vs replayed LLM label by Jev confidence:",
    ...s.thresholds.map((t) => `  ≥${t.t}: slice ${t.slice}, agreement ${pct(t.agreement)}, coverage ${pct(t.coverage)}`),
    "",
    "By language (at ≥0.7):",
    ...Object.entries(s.byLang).map(([lang, v]) => `  ${lang}: matched ${v.matched}, agreement ${pct(v.agreementAt07)}, coverage ${pct(v.coverageAt07)}`),
    "",
    ...confusion(matched, (r) => r.llm_intent, "replayed LLM (gates)"),
    ...confusion(matched, (r) => r.recorded_intent, "recorded intent (noisy proxy, reported only)"),
    ...confusion(matched, (r) => r.observed_action, "observed action (proxy, never gates)"),
    "",
    `Top ${s.disagreements.length} disagreements (look the text up locally by turn_id):`,
    ...s.disagreements.map((d) => `  ${d.turn_id} [${d.lang}] jev=${d.jev}@${d.confidence.toFixed(2)} llm=${d.llm}`)
  ].filter((line, i, all) => !(line === "" && all[i - 1] === "")).join("\n");
}
```

- [ ] **Step 6: Run to verify both pass**

Run: `npx vitest run tests/jev/ && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/jev/replay.ts src/jev/replay-report.ts tests/jev/replay.test.ts tests/jev/replay-report.test.ts
git commit -m "feat(jev): replay engine + GO/STOP report — both classifiers on the rebuilt thread, resumable, budget-reserved"
```

---

### Task 6: CLI wiring, audit guard, `.gitignore`, live gate

**Files:**
- Modify: `src/cli.ts` (new `else if (command === "jev-shadow")` branch next to `lessons-consolidate` ~L310)
- Modify: `tests/llm/audit-coverage.test.ts`
- Modify: `.gitignore`
- Create: `scripts/live-gate-jev.mjs`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: `houge jev-shadow replay [--since ISO] [--limit N] [--max-usd USD] [--dry-run]`.

- [ ] **Step 1: Write the failing guard tests** in `tests/llm/audit-coverage.test.ts`. Append inside the `describe`:

```ts
  it("every createJevClient( call site in src passes a store-built sink and meteredBreached (Jev spec 2026-09-25)", () => {
    const offenders: string[] = [];
    let sites = 0;
    for (const f of files) {
      if (f.endsWith(join("src", "jev", "jev-client.ts"))) continue;
      const text = read(f);
      let i = text.indexOf("createJevClient(");
      while (i !== -1) {
        sites += 1;
        const window = text.slice(i, i + 900);
        if (!/audit:\s*[A-Za-z_.]*llmAuditSink\(/.test(window) || !/meteredBreached:/.test(window)) offenders.push(`${f}@${i}`);
        i = text.indexOf("createJevClient(", i + 1);
      }
    }
    expect(offenders).toEqual([]);
    expect(sites).toBeGreaterThan(0); // the CLI site exists — a guard over zero sites guards nothing
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/llm/audit-coverage.test.ts`
Expected: FAIL on `sites` > 0 (no call site yet).

- [ ] **Step 3: Add the CLI branch** in `src/cli.ts`, before the final `else`:

```ts
} else if (command === "jev-shadow") {
  // Jev intent-shadow replay (spec 2026-09-25): both classifiers on each historical turn's rebuilt
  // thread → JSONL + GO/STOP report. Makes external calls, so the kill switch refuses it like `run`.
  if (rest[0] !== "replay") {
    console.error("Usage: houge jev-shadow replay [--since ISO] [--limit N] [--max-usd USD] [--dry-run]");
    process.exit(1);
  }
  if (readTombstone()) {
    console.error(formatTombstoneParkedMessage(resolveTombstonePath(process.env)));
    process.exit(1);
  }
  const { parseReplayArgs, runReplay, REPLAY_OUT_PATH } = await import("./jev/replay.js");
  const { formatReplayReport } = await import("./jev/replay-report.js");
  const { createJevClient } = await import("./jev/jev-client.js");
  const { createLlmAnswerAdapter } = await import("./capabilities/llm-answer.js");
  const args = parseReplayArgs(rest.slice(1));
  if (!args.ok) {
    console.error(args.error);
    process.exit(1);
  }
  const store = RunStore.open("houge.sqlite", storeOptions);
  try {
    const jev = createJevClient({
      apiKey: broker ? broker.typesafeKey() : process.env.TYPESAFE_API_KEY,
      audit: store.llmAuditSink({ correlation_id: "cli:jev-replay", role: "classify_replay" }),
      meteredBreached: () => store.meteredFuseLatched(),
      retries: 3,
      timeoutMs: 15_000
    });
    const llm = createLlmAnswerAdapter({
      ...brokerOption,
      audit: store.llmAuditSink({ correlation_id: "cli:jev-replay", role: "classify_replay_llm" }),
      meteredBreached: () => store.meteredFuseLatched()
    });
    const outcome = await runReplay({
      store,
      env: process.env,
      jev,
      classifyLlm: async (question, system) => {
        const r = await llm({ question, system });
        return r.ok && typeof r.output.answer === "string"
          ? { ok: true as const, raw: r.output.answer }
          : { ok: false as const, error: r.ok ? "no answer" : r.error };
      },
      outPath: REPLAY_OUT_PATH,
      maxUsd: args.maxUsd,
      dryRun: args.dryRun,
      ...(args.sinceIso !== undefined ? { sinceIso: args.sinceIso } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      log: (line) => console.error(line)
    });
    console.log(formatReplayReport(outcome.rows, outcome));
    process.exitCode = outcome.stopped ? 1 : 0;
  } finally {
    store.close();
  }
```

The `readTombstone`, `formatTombstoneParkedMessage` and `resolveTombstonePath` imports already exist at the top of `cli.ts`.

Append to `.gitignore`:
```
# Jev shadow replay output (labels/numbers only, no message text) — local runtime state
.houge/
```

- [ ] **Step 4: Run the guard and the full suite**

Run: `npx vitest run && npm run typecheck && npm run build`
Expected: PASS, including the new guard (sites ≥ 1).

- [ ] **Step 5: Write** `scripts/live-gate-jev.mjs`

```js
// Live gate for the Jev replay slice (spec 2026-09-25 §Testing). Three fixed messages go to the REAL
// TypeSafe API through the real client into an IN-MEMORY store. PASS requires the right shape,
// the pinned model, an llm_attempt row with cost_usd > 0 — AND the two unambiguous messages labelled
// correctly at confidence ≥ 0.7, so a shape-only pass cannot hide a broken question.
// Never opens houge.sqlite — safe beside the live daemon. Needs TYPESAFE_API_KEY in .env.
import { loadHougeEnv } from "../dist/config/load-env.js";
import { createJevClient, JEV_MODEL } from "../dist/jev/jev-client.js";
import { buildJevIntentRequest } from "../dist/jev/intent-question.js";
import { RunStore } from "../dist/run/run-store.js";

loadHougeEnv();
const store = RunStore.openInMemory();
const failures = [];
const jev = createJevClient({
  apiKey: process.env.TYPESAFE_API_KEY,
  audit: store.llmAuditSink({ correlation_id: "gate:jev", role: "classify_replay" }),
  meteredBreached: () => false,
  retries: 1,
  timeoutMs: 15_000
});

const cases = [
  { label: "research", message: "What did the RBA decide at today's rate meeting?", want: "research" },
  { label: "selfcode", message: "Go read your intent classifier source and tell me why it keeps choosing research.", want: "selfcode" },
  { label: "chinese", message: "帮我解释一下什么是复利", want: null }
];

for (const c of cases) {
  const built = buildJevIntentRequest(c.message, [], 500, 0);
  if (!built.ok) { failures.push(`${c.label}: request skipped`); continue; }
  const r = await jev(built.request);
  if (!r.ok) { failures.push(`${c.label}: ${r.reason} ${r.detail}`); continue; }
  const a = r.answers.intent;
  console.log(`${c.label}: ${a.choice} @ ${a.confidence.toFixed(2)} (${r.model}, ${r.latency_ms}ms, ${r.input_tokens} tok)`);
  if (r.model !== JEV_MODEL) failures.push(`${c.label}: model ${r.model} ≠ pinned ${JEV_MODEL}`);
  if (c.want && (a.choice !== c.want || a.confidence < 0.7)) failures.push(`${c.label}: got ${a.choice}@${a.confidence}, want ${c.want}@≥0.7`);
}

const rows = store.getLedgerEvents().filter((e) => e.event_type === "llm_attempt");
if (rows.length !== cases.length) failures.push(`expected ${cases.length} llm_attempt rows, got ${rows.length}`);
if (!rows.every((r) => r.payload.provider === "jev" && r.payload.role === "classify_replay")) failures.push("attempt rows carry the wrong provider/role");
if (!rows.every((r) => r.payload.outcome !== "ok" || r.payload.cost_usd > 0)) failures.push("an ok jev attempt has no cost_usd — the ceiling is blind to it");
store.close();

console.log(failures.length === 0 ? "\nLIVE GATE: PASS" : `\nLIVE GATE: FAIL\n  - ${failures.join("\n  - ")}`);
process.exit(failures.length === 0 ? 0 : 1);
```

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts tests/llm/audit-coverage.test.ts .gitignore scripts/live-gate-jev.mjs
git commit -m "feat(cli): houge jev-shadow replay + audit guard for createJevClient sites + live gate"
```

---

### Task 7: Verification, live gate, the real replay (operator steps — no new code)

- [ ] **Step 1: Whole-diff review.** Run the parallel reviewers, then the **mandatory codex whole-diff pass**:
  `codex exec -s read-only … "run git diff <base-of-Task-1>..HEAD …" </dev/null`. Verify every finding
  first-hand; fix confirmed ones TDD-style; record confirmed and rejected findings, with reasons.
- [ ] **Step 2: Build.** `npm run build`
- [ ] **Step 3: Live gate.** Paco adds `TYPESAFE_API_KEY=…` to `.env` (the key never goes in chat or a
  commit). Then `node scripts/live-gate-jev.mjs`. Expected: `LIVE GATE: PASS`. If the selfcode or
  research label misses, **stop**: the question wording needs work before the replay means anything.
- [ ] **Step 4: Dry run.** `node dist/cli.js jev-shadow replay --dry-run`. Expected: `eligible` ≈ 370
  and an estimated cost of about $0.05. Its only effect on `houge.sqlite` is the migrate-on-open no-op
  every CLI command performs.
- [ ] **Step 5: Real replay.** `node dist/cli.js jev-shadow replay`. It runs sequentially, roughly 30–60
  min, dominated by the CLI classifier. It is resumable: after a Ctrl-C, re-running continues.
- [ ] **Step 6: Show Paco the report, verbatim.** It contains the verdict, counts, cost, per-language
  split, the three confusion matrices and the 20 disagreements. Paco looks the texts up locally by `turn_id`.
- [ ] **Step 7: Go/no-go (Paco's decision).**
  - **STOP:** record why in `tasks/lessons.md` and mark the spec status STOPPED.
  - **GO:** write the live-shadow plan (spec §"Live shadow") as a new plan document.
- [ ] **Step 8: Docs sync.**
  - `docs/reference/configuration.md` gets `TYPESAFE_API_KEY` (a broker-held secret) and the replay command.
  - The README gets one paragraph.
  - Update the spec status line.
  - Commit and push.
```
