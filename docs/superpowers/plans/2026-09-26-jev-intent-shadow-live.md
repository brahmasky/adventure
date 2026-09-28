# Jev Intent Shadow — Live Phase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **TDD is mandatory (Paco, 2026-09-25):** every task starts from a failing test.

**Goal:** Run Jev beside every real `classifyIntent` call. The shadow never waits and never fails a
turn. It writes one `intent_shadow` ledger row per classified turn, and `houge jev-shadow report`
turns those rows into a PROMOTE / HOLD / KILL verdict per language.

**Architecture:**
- A pure shadow module (`src/jev/shadow.ts`) runs Jev on the classifier's exact inputs and maps
  every outcome to a status. It never rejects.
- `CoreWorker.classifyIntent` starts it before the LLM classifier and, once the classifier's raw
  reply is known, records the pair in the background.
- The store gains one write and two reads.
- A pure report module computes the verdict.
- The real Jev client is built only beside the production LLM adapter, so tests can never reach
  TypeSafe.

**Tech Stack:**
- TypeScript (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), ESM, Node ≥ 25.
- `node:sqlite` via `RunStore`; vitest; npm.
- **Zero runtime dependencies.** Keep it that way.

**Spec:** `docs/superpowers/specs/2026-09-25-jev-intent-shadow-design.md`: §"Live shadow" **and**
§"Live-shadow amendments from the replay and the plan research (2026-09-26)". The amendments win
where they conflict.

**Codex plan review (2026-09-26):** 4 BLOCKERs + 1 RISK + 1 NIT, each verified first-hand against the
live code and folded into the tasks below (B1 admission-first, B2 bounded `jev_model`, B3 tenure vs
`--since`, B4 outer deadline, R5 per-language missingness; N6 accepted as-is). Record and disposition:
§"Codex plan review" at the end.

**Builds on:** PR #1 (`feat/jev-replay`). This branch (`feat/jev-live-shadow`) is stacked on it and
reuses `src/jev/jev-client.ts`, `src/jev/intent-question.ts`, `src/jev/replay.ts` and
`src/jev/replay-report.ts`.

## Global Constraints

- **Model and client:**
  - Model pinned to `jev-1.13.0` (`JEV_MODEL`).
  - Live shadow client: `retries: 0`, `timeoutMs: 5_000` (`JEV_SHADOW_TIMEOUT_MS`).
  - Audit role `classify_shadow`; provider name only via `JEV_PROVIDER`. Never write a `"jev"`
    string literal in `src/` outside `src/llm/`.
- **Turn safety:**
  - The turn **never awaits** Jev.
  - Nothing in the shadow may throw into a turn.
  - The shadow starts **inside the classifier adapter's `execute`** — only after `CapabilityRunner`
    has admitted the call (budget reserved, contract allows `llm_answer`). A denied classifier never
    sends the message to Jev. (Codex B1.)
  - `runJevShadow` has an **outer deadline**, `JEV_SHADOW_DEADLINE_MS` = 6 000 ms, `unref`'d and
    cleared on settle: a call that never settles still resolves to `status: "timeout"`, so every
    eligible turn gets a row except at shutdown. The client's own 5 s abort normally fires first and
    writes the `llm_attempt` row. (Codex B4.)
  - Jev output never enters a prompt and never gates an action. It goes only to the ledger.
- **Flag:** `HOUGE_JEV_SHADOW_ENABLED`, default OFF, accepts `1/true/yes/on` (trimmed,
  case-insensitive).
  - Read **live per turn**.
  - Listed in `DISARM_FLAGS`.
  - Flag on with no `TYPESAFE_API_KEY` → ONE warning at `CoreWorker` construction, and the shadow
    stays off.
- **Key:** `broker.typesafeKey()` when a broker is injected, else `process.env.TYPESAFE_API_KEY`.
  Never logged.
- **Hermeticity:** the real Jev client is built only when `CoreWorker`'s LLM adapter is the
  production default. A test-injected LLM adapter plus no injected Jev call → shadow OFF.
- **`intent_shadow` ledger event:**
  - Required fields: `["status", "llm_intent", "llm_parsed", "lang"]`.
  - `status ∈ ok | skipped_state_too_large | error | timeout | fused | no_key | auth`.
  - `jev_*` fields only on `ok`; `jev_error` only on non-`ok`.
  - `modality: "text"`.
  - **Never message text.**
  - `jev_model` is the response's `model` field after jev-client validates it against a bounded id
    format (`/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/`, else the code-owned `model_invalid`), so provider
    prose can never reach the audit or the ledger through it. (Codex B2.)
- **Recording rules:**
  - An `intent_shadow` row is written only when the LLM classifier succeeded.
  - `llm_intent` is the RAW classifier label, taken before the clarify cap and the `recordedIntent`
    rewrite.
  - `llm_parsed` is computed by `llmLabel`.
- **Promotion bar, per language:**
  - HOLD until ≥ 60 matched turns AND ≥ 28 days since the first shadow row.
    The 28 days are measured from the first `intent_shadow` row **ever** (`firstIntentShadowAt`), never
    from the first row inside `--since`. `--since` only narrows the rows that are counted and matched,
    and the window the missingness count uses. (Codex B3.)
  - Then PROMOTE iff agreement ≥ 0.90 at Jev confidence ≥ 0.7 AND coverage ≥ 0.60; else KILL.
  - Matched = `status ok` AND `llm_parsed` AND `jev_model === JEV_MODEL`.
  - Coverage = (confidence ≥ 0.7 matched turns) ÷ (that language's `intent_shadow` rows, every
    status).
  - The report prints status counts and Jev-model counts **per language** as well as overall; a model
    appears only where an `ok` row returned one. (Codex R5.)
- **Conventions:**
  - Conventional Commits. Each commit message ends with a blank line and then exactly:
    `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
  - `git add` named files only.
  - Tests with `npx vitest run <path>`; `npm run typecheck`; full `npx vitest run` before each commit.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/jev/jev-client.ts` (modify) | Failure results carry `error_kind`; a validation failure names the check that failed |
| `src/jev/labels.ts` (create) | `llmLabel` + `observedAction`, moved from `replay.ts` (shared by replay and live) |
| `src/jev/replay.ts` (modify) | Import and re-export the two moved helpers; no behaviour change |
| `src/jev/shadow.ts` (create) | Flag resolver, `runJevShadow` (never rejects), `intentShadowPayload` (pure), types |
| `src/config/disarm-posture.ts` (modify) | `HOUGE_JEV_SHADOW_ENABLED` joins `DISARM_FLAGS` |
| `src/run/run-ledger.ts` (modify) | `intent_shadow` event type + required fields |
| `src/run/run-store.ts` (modify) | `recordIntentShadow`, `listIntentShadows`, `countClassifiedRunsWithoutShadow` |
| `src/core/core-worker.ts` (modify) | Constructor seam, boot warning, start/record the shadow inside `classifyIntent` |
| `src/jev/replay-report.ts` (modify) | Export `THRESHOLDS`, `atThreshold`, `pct`, `confusion` as generic helpers |
| `src/jev/shadow-report.ts` (create) | `loadShadowRows`, `summarizeShadow`, `formatShadowReport`, `parseShadowReportArgs` |
| `src/cli.ts` (modify) | `houge jev-shadow report [--since ISO]` |
| `scripts/live-gate-jev-shadow.mjs` (create) | One real turn in memory: real classifier chain + real Jev |
| `docs/reference/configuration.md`, `README.md` (modify) | Flag, report command, `/disarm` coverage |

---

### Task 1: jev-client — `error_kind` on failures + named validation failures

**Files:**
- Modify: `src/jev/jev-client.ts`
- Test: `tests/jev/jev-client.test.ts`

**Interfaces:**
- Produces:
  - `JevResult` failure variant becomes
    `{ ok: false; reason: "no_key" | "fused" | "auth" | "error"; detail: string; error_kind?: LlmErrorKind }`.
    `no_key` and `auth` carry `error_kind: "auth"`; `error` carries the attempt's kind (`timeout`,
    `transport`, `parse`, `other`); `fused` has none.
  - A validation failure's `detail` is `response failed validation: <code>`, with `<code>` one of:
    `body_not_object`, `model_missing`, `model_invalid`, `answers_missing`, `usage_input_tokens_missing`,
    `answer_missing:<question id>`, `answer_not_object`, `not_choice`, `choice_not_option`,
    `confidence_out_of_range`, `probabilities_missing`, `probability_keys`, `probability_sum`.

- [ ] **Step 1: Write the failing tests.** In `tests/jev/jev-client.test.ts`, replace the existing
  `it.each([...])("malformed answer (%s) → error/parse, no answer returned", ...)` block with:

```ts
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/jev/jev-client.test.ts`
Expected: FAIL. `detail` is `"response failed validation"` with no code, and `error_kind` is absent
from the results.

- [ ] **Step 3: Implement** in `src/jev/jev-client.ts`

Change the `JevResult` failure variant:

```ts
export type JevResult =
  | { ok: true; model: string; answers: Record<string, JevChoiceAnswer>; input_tokens: number; latency_ms: number }
  | { ok: false; reason: "no_key" | "fused" | "auth" | "error"; detail: string; error_kind?: LlmErrorKind };
```

In `createJevClient`, update the three failure returns (the `fused` return stays as it is):

```ts
      return { ok: false, reason: "no_key", detail: "TYPESAFE_API_KEY is not set", error_kind: "auth" };
```
```ts
      if (a.error_kind === "auth") return { ok: false, reason: "auth", detail: a.detail, error_kind: "auth" };
      if (!a.retryable || attempt >= config.retries) return { ok: false, reason: "error", detail: a.detail, error_kind: a.error_kind };
```

Replace `validateResponse` and `validateChoice` with versions that name the failed check, and
update the one call site in `attemptOnce`. Add `JEV_MODEL_ID` beside `PROBABILITY_SUM_TOLERANCE`:

```ts
/** A model id is a short token (Codex B2): anything else is a parse failure, so a response that echoes
 *  prose in `model` can never be written to the audit or the ledger. */
const JEV_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

type Validated<T> = { ok: true; value: T } | { ok: false; code: string };

function validateResponse(
  body: unknown,
  req: JevRequest
): Validated<{ model: string; answers: Record<string, JevChoiceAnswer>; input_tokens: number; output_tokens: number }> {
  if (typeof body !== "object" || body === null) return { ok: false, code: "body_not_object" };
  const b = body as Record<string, unknown>;
  if (typeof b.model !== "string") return { ok: false, code: "model_missing" };
  if (!JEV_MODEL_ID.test(b.model)) return { ok: false, code: "model_invalid" };
  if (typeof b.answers !== "object" || b.answers === null) return { ok: false, code: "answers_missing" };
  const usage = b.usage as Record<string, unknown> | undefined;
  if (typeof usage?.input_tokens !== "number") return { ok: false, code: "usage_input_tokens_missing" };
  const output_tokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  const answers: Record<string, JevChoiceAnswer> = {};
  for (const [id, question] of Object.entries(req.questions)) {
    const raw = (b.answers as Record<string, unknown>)[id];
    if (raw === undefined) return { ok: false, code: `answer_missing:${id}` };
    const answer = validateChoice(raw, Object.keys(question.criteria));
    if (!answer.ok) return answer;
    answers[id] = answer.value;
  }
  return { ok: true, value: { model: b.model, answers, input_tokens: usage.input_tokens, output_tokens } };
}

function validateChoice(raw: unknown, options: string[]): Validated<JevChoiceAnswer> {
  if (typeof raw !== "object" || raw === null) return { ok: false, code: "answer_not_object" };
  const a = raw as Record<string, unknown>;
  if (a.type !== "choice" || typeof a.choice !== "string") return { ok: false, code: "not_choice" };
  if (!options.includes(a.choice)) return { ok: false, code: "choice_not_option" };
  if (typeof a.confidence !== "number" || a.confidence < 0 || a.confidence > 1) return { ok: false, code: "confidence_out_of_range" };
  if (typeof a.probabilities !== "object" || a.probabilities === null) return { ok: false, code: "probabilities_missing" };
  const probs = a.probabilities as Record<string, unknown>;
  if (Object.keys(probs).length !== options.length || !options.every((o) => typeof probs[o] === "number")) {
    return { ok: false, code: "probability_keys" };
  }
  const sum = options.reduce((s, o) => s + (probs[o] as number), 0);
  if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) return { ok: false, code: "probability_sum" };
  return { ok: true, value: { choice: a.choice, probabilities: probs as Record<string, number>, confidence: a.confidence } };
}
```

In `attemptOnce`, replace the final `const parsed = validateResponse(body, req); return parsed ? … : …;`:

```ts
    const parsed = validateResponse(body, req);
    return parsed.ok
      ? { kind: "ok", result: { ok: true, model: parsed.value.model, answers: parsed.value.answers, input_tokens: parsed.value.input_tokens, latency_ms: 0 }, output_tokens: parsed.value.output_tokens }
      : { kind: "fail", outcome: "error", error_kind: "parse", retryable: false, detail: `response failed validation: ${parsed.code}` };
```

Every code is a code-owned literal (the question id comes from our own request keys). The response
body is still never echoed.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/jev/ && npm run typecheck`
Expected: PASS. The replay tests that assert `jev_failed` rows still pass; their `error` text now
ends with a code.

- [ ] **Step 5: Full suite, then commit**

```bash
npx vitest run
git add src/jev/jev-client.ts tests/jev/jev-client.test.ts
git commit -m "feat(jev): failures carry error_kind; a validation reject names the failed check"
```

---

### Task 2: The shadow module + `/disarm` coverage

**Files:**
- Create: `src/jev/labels.ts`, `src/jev/shadow.ts`
- Modify: `src/jev/replay.ts` (move two helpers out), `src/config/disarm-posture.ts`
- Test: `tests/jev/shadow.test.ts`; modify `tests/config/disarm-posture.test.ts`

**Interfaces:**
- Consumes: Task 1 `JevResult` (with `error_kind`); `buildJevIntentRequest`, `langOf`, `Lang` from
  `src/jev/intent-question.ts`.
- Produces:
```ts
// src/jev/labels.ts
export type ObservedAction = "selfcode" | "skill" | "research" | "answer" | "unknown";
export function observedAction(capabilities: string[]): ObservedAction;
export function llmLabel(raw: string): { intent: Intent; parsed: boolean };
// src/jev/shadow.ts
export type JevShadowCall = (req: JevRequest) => Promise<JevResult>;
export type ShadowStatus = "ok" | "skipped_state_too_large" | "error" | "timeout" | "fused" | "no_key" | "auth";
export const JEV_SHADOW_TIMEOUT_MS = 5_000;
export const JEV_SHADOW_DEADLINE_MS = 6_000;
export interface JevShadowOutcome {
  status: ShadowStatus; lang: Lang;
  jev?: { intent: string; confidence: number; probabilities: Record<string, number>; model: string; latency_ms: number };
  jev_error?: string;
}
export type IntentShadowPayload = {
  status: ShadowStatus; llm_intent: Intent; llm_parsed: boolean; lang: Lang; modality: "text";
  jev_intent?: string; jev_confidence?: number; jev_probabilities?: Record<string, number>;
  jev_model?: string; jev_latency_ms?: number; jev_error?: string;
};
export function resolveJevShadowEnabled(env: NodeJS.ProcessEnv): boolean;
export function runJevShadow(call: JevShadowCall, message: string, recentTurns: ChatTurnRow[], turnChars: number, recentClarifyCount: number): Promise<JevShadowOutcome>;
export function intentShadowPayload(outcome: JevShadowOutcome, llmRaw: string): IntentShadowPayload;
```

- [ ] **Step 1: Write the failing tests** in `tests/jev/shadow.test.ts`

```ts
import { describe, expect, it, vi } from "vitest";
import type { JevRequest, JevResult } from "../../src/jev/jev-client.js";
import { intentShadowPayload, JEV_SHADOW_DEADLINE_MS, resolveJevShadowEnabled, runJevShadow, type JevShadowOutcome } from "../../src/jev/shadow.js";
import { MAX_LATEST_MESSAGE_CHARS } from "../../src/jev/intent-question.js";

const ok = (choice = "research", confidence = 0.91, model = "jev-1.13.0"): JevResult => ({
  ok: true, model, input_tokens: 700, latency_ms: 240,
  answers: { intent: { choice, confidence, probabilities: { answer: 0.03, research: 0.91, feedback: 0.02, clarify: 0.02, selfcode: 0.01, skill: 0.01 } } }
});

describe("resolveJevShadowEnabled", () => {
  it.each([
    [undefined, false], ["", false], ["0", false], ["false", false], ["no", false],
    ["1", true], ["true", true], [" YES ", true], ["on", true]
  ])("%j → %s (default OFF — sending messages to a third party is opt-in)", (raw, want) => {
    expect(resolveJevShadowEnabled(raw === undefined ? {} : { HOUGE_JEV_SHADOW_ENABLED: raw })).toBe(want);
  });
});

describe("runJevShadow — never rejects; every outcome is a status", () => {
  it("ok: carries Jev's label, confidence, probabilities, model and latency", async () => {
    const call = vi.fn(async (_req: JevRequest) => ok());
    const out = await runJevShadow(call, "what's the RBA rate today?", [], 500, 0);
    expect(out).toMatchObject({ status: "ok", lang: "en", jev: { intent: "research", confidence: 0.91, model: "jev-1.13.0", latency_ms: 240 } });
    expect((call.mock.calls[0]![0].state as { latest_message: string }).latest_message).toBe("what's the RBA rate today?");
  });

  it.each([
    [{ ok: false, reason: "no_key", detail: "TYPESAFE_API_KEY is not set", error_kind: "auth" }, "no_key"],
    [{ ok: false, reason: "fused", detail: "metered fuse latched" }, "fused"],
    [{ ok: false, reason: "auth", detail: "HTTP 401", error_kind: "auth" }, "auth"],
    [{ ok: false, reason: "error", detail: "timed out after 5000ms", error_kind: "timeout" }, "timeout"],
    [{ ok: false, reason: "error", detail: "HTTP 503", error_kind: "transport" }, "error"],
    [{ ok: false, reason: "error", detail: "response failed validation: probability_sum", error_kind: "parse" }, "error"]
  ] as Array<[JevResult, string]>)("failure %j → status %s, with jev-client's code-owned detail", async (result, status) => {
    const out = await runJevShadow(async () => result, "hi", [], 500, 0);
    expect(out.status).toBe(status);
    expect(out.jev).toBeUndefined();
    expect(out.jev_error).toBe((result as { detail: string }).detail);
  });

  it("a call that throws or rejects becomes status error — it can never reject into a turn", async () => {
    const threw = await runJevShadow(() => { throw new Error("boom"); }, "hi", [], 500, 0);
    const rejected = await runJevShadow(async () => { throw new Error("boom"); }, "hi", [], 500, 0);
    for (const out of [threw, rejected]) expect(out).toMatchObject({ status: "error", jev_error: "shadow call threw" });
  });

  it("a call that never settles resolves timeout at the outer deadline — a row exists even if the client's own timer never fires (Codex B4)", async () => {
    vi.useFakeTimers();
    try {
      const pending = runJevShadow(() => new Promise<JevResult>(() => {}), "hi", [], 500, 0);
      await vi.advanceTimersByTimeAsync(JEV_SHADOW_DEADLINE_MS);
      expect(await pending).toMatchObject({ status: "timeout", lang: "en", jev_error: `no result after ${JEV_SHADOW_DEADLINE_MS}ms (shadow deadline)` });
    } finally {
      vi.useRealTimers();
    }
  });

  it("an over-cap message is skipped without calling Jev (egress cap, never truncated)", async () => {
    const call = vi.fn(async () => ok());
    const out = await runJevShadow(call, "x".repeat(MAX_LATEST_MESSAGE_CHARS + 1), [], 500, 0);
    expect(out.status).toBe("skipped_state_too_large");
    expect(call).not.toHaveBeenCalled();
  });

  it("tags language in code", async () => {
    expect((await runJevShadow(async () => ok(), "帮我研究一下澳洲的利率走势", [], 500, 0)).lang).toBe("zh");
  });
});

describe("intentShadowPayload — the ledger row, joined to the RAW classifier reply", () => {
  const okOutcome: JevShadowOutcome = { status: "ok", lang: "en", jev: { intent: "skill", confidence: 0.8, probabilities: { skill: 0.8, answer: 0.2 }, model: "jev-1.13.0", latency_ms: 300 } };

  it("ok: every jev_* field, the raw label, parsed=true, modality text — and no jev_error", () => {
    const p = intentShadowPayload(okOutcome, '{"intent":"research","query":"rba"}');
    expect(p).toEqual({
      status: "ok", llm_intent: "research", llm_parsed: true, lang: "en", modality: "text",
      jev_intent: "skill", jev_confidence: 0.8, jev_probabilities: { skill: 0.8, answer: 0.2 }, jev_model: "jev-1.13.0", jev_latency_ms: 300
    });
  });

  it("records the classifier's clarify verbatim — the cap/recordedIntent rewrite happens later and must not leak in", () => {
    expect(intentShadowPayload(okOutcome, '{"intent":"clarify","clarifying_question":"which?"}').llm_intent).toBe("clarify");
  });

  it("an unparseable reply is answer/parsed=false — the fallback is not a verdict", () => {
    expect(intentShadowPayload(okOutcome, "I think research")).toMatchObject({ llm_intent: "answer", llm_parsed: false });
  });

  it("failure: jev_error present, no jev_* fields", () => {
    const p = intentShadowPayload({ status: "timeout", lang: "zh", jev_error: "timed out after 5000ms" }, '{"intent":"answer"}');
    expect(p).toEqual({ status: "timeout", llm_intent: "answer", llm_parsed: true, lang: "zh", modality: "text", jev_error: "timed out after 5000ms" });
  });

  it("never carries message text (bodies-out-of-the-ledger)", async () => {
    const secret = "MY-PRIVATE-MESSAGE-5f2c";
    const out = await runJevShadow(async () => ok(), `please look up ${secret}`, [], 500, 0);
    expect(JSON.stringify(intentShadowPayload(out, '{"intent":"research","query":"look up it"}'))).not.toContain(secret);
  });
});
```

In `tests/config/disarm-posture.test.ts`, append to the exact `DISARM_FLAGS` expectation, after
`"HOUGE_RADAR_PANEL_ENABLED"` (keep the file's comment style):

```ts
      // Jev intent shadow (spec 2026-09-25): an unattended per-turn metered call that sends the
      // message + thread to a third party — the STOP switch covers it like the radar's calls.
      "HOUGE_JEV_SHADOW_ENABLED"
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/jev/shadow.test.ts tests/config/disarm-posture.test.ts`
Expected: FAIL. The module is not found, and the `DISARM_FLAGS` list does not match.

- [ ] **Step 3: Move the two label helpers.** Create `src/jev/labels.ts` by moving `ObservedAction`,
  `INTENT_IN_JSON`, `observedAction` and `llmLabel` out of `src/jev/replay.ts`, keeping their doc
  comments verbatim:

```ts
import { parseIntent, type Intent } from "../capabilities/intent.js";

/** Label helpers shared by the replay and the live shadow (Jev spec 2026-09-25). */
export type ObservedAction = "selfcode" | "skill" | "research" | "answer" | "unknown";

const INTENT_IN_JSON = /"intent"\s*:\s*"\s*(answer|research|feedback|clarify|selfcode|skill)\s*"/i;

export function observedAction(capabilities: string[]): ObservedAction {
  const has = (...names: string[]) => names.some((n) => capabilities.includes(n));
  if (has("self_diagnose", "self_write_propose")) return "selfcode";
  if (has("skill_author")) return "skill";
  if (has("web_search", "http_fetch")) return "research";
  return capabilities.length === 0 ? "answer" : "unknown";
}

/**
 * parseIntent defaults to "answer" on garbage — including JSON that has a well-formed `"intent"`
 * field but is otherwise broken (e.g. a trailing `undefined` literal), where a naive regex probe
 * would still "see" the field. `parsed` is true only when the regex-captured intent agrees with
 * what parseIntent actually read, so a malformed reply can never enter the GO/STOP gate under a
 * label the model didn't really produce.
 */
export function llmLabel(raw: string): { intent: Intent; parsed: boolean } {
  const intent = parseIntent(raw).intent;
  const captured = raw.match(INTENT_IN_JSON)?.[1]?.trim().toLowerCase();
  return { intent, parsed: captured === intent };
}
```

  In `src/jev/replay.ts`:
  - delete those four definitions;
  - drop `parseIntent` from its `../capabilities/intent.js` import (it has no other use there);
  - add
    `import { llmLabel, observedAction, type ObservedAction } from "./labels.js";` and
    `export { llmLabel, observedAction, type ObservedAction } from "./labels.js";`, so that
    `tests/jev/replay.test.ts` and `replay-report.ts` keep importing from `replay.js` unchanged.

- [ ] **Step 4: Implement** `src/jev/shadow.ts`

```ts
import type { Intent } from "../capabilities/intent.js";
import type { ChatTurnRow } from "../run/run-store.js";
import type { JevRequest, JevResult } from "./jev-client.js";
import { buildJevIntentRequest, langOf, type Lang } from "./intent-question.js";
import { llmLabel } from "./labels.js";

/**
 * The live intent shadow (Jev spec 2026-09-25 §"Live shadow" + 2026-09-26 amendments): Jev answers the
 * classifier's exact question, beside it, for measurement only. Nothing here may reject into a turn,
 * and nothing Jev returns reaches a prompt or gates an action — it goes to the ledger and nowhere else.
 */
export type JevShadowCall = (req: JevRequest) => Promise<JevResult>;
export type ShadowStatus = "ok" | "skipped_state_too_large" | "error" | "timeout" | "fused" | "no_key" | "auth";
export const JEV_SHADOW_TIMEOUT_MS = 5_000;
/** Backstop over the client's own abort (Codex B4): a shadow that never settles still yields a `timeout` row. */
export const JEV_SHADOW_DEADLINE_MS = 6_000;

export interface JevShadowOutcome {
  status: ShadowStatus;
  lang: Lang;
  jev?: { intent: string; confidence: number; probabilities: Record<string, number>; model: string; latency_ms: number };
  /** jev-client's code-owned failure string (HTTP status, timeout, validation code) — never provider prose. */
  jev_error?: string;
}

/** A type alias (not an interface) so it stays assignable to the ledger's Record payload. */
export type IntentShadowPayload = {
  status: ShadowStatus;
  llm_intent: Intent;
  llm_parsed: boolean;
  lang: Lang;
  modality: "text";
  jev_intent?: string;
  jev_confidence?: number;
  jev_probabilities?: Record<string, number>;
  jev_model?: string;
  jev_latency_ms?: number;
  jev_error?: string;
};

/** HOUGE_JEV_SHADOW_ENABLED — default OFF; 1/true/yes/on. Read LIVE per turn: `/disarm` flips it. */
export function resolveJevShadowEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.HOUGE_JEV_SHADOW_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * Run Jev on the classifier's inputs. Resolves on every path — a throw becomes `status: "error"`, and
 * a call that never settles becomes `status: "timeout"` at the outer deadline.
 */
export async function runJevShadow(
  call: JevShadowCall,
  message: string,
  recentTurns: ChatTurnRow[],
  turnChars: number,
  recentClarifyCount: number
): Promise<JevShadowOutcome> {
  const lang = langOf(message);
  let result: JevResult | "deadline";
  try {
    const built = buildJevIntentRequest(message, recentTurns, turnChars, recentClarifyCount);
    if (!built.ok) return { status: "skipped_state_too_large", lang };
    result = await withDeadline(call(built.request), JEV_SHADOW_DEADLINE_MS);
  } catch {
    return { status: "error", lang, jev_error: "shadow call threw" };
  }
  if (result === "deadline") return { status: "timeout", lang, jev_error: `no result after ${JEV_SHADOW_DEADLINE_MS}ms (shadow deadline)` };
  if (!result.ok) return { status: failureStatus(result), lang, jev_error: result.detail };
  const answer = result.answers.intent;
  if (!answer) return { status: "error", lang, jev_error: "response failed validation: answer_missing:intent" };
  return {
    status: "ok",
    lang,
    jev: { intent: answer.choice, confidence: answer.confidence, probabilities: answer.probabilities, model: result.model, latency_ms: result.latency_ms }
  };
}

function failureStatus(result: Extract<JevResult, { ok: false }>): ShadowStatus {
  if (result.reason === "no_key" || result.reason === "fused" || result.reason === "auth") return result.reason;
  return result.error_kind === "timeout" ? "timeout" : "error";
}

/** The timer is unref'd (a pending shadow never holds the daemon open at shutdown) and cleared on settle. */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | "deadline"> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), ms);
    timer.unref();
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

/** The `intent_shadow` payload: the Jev outcome joined to the classifier's RAW reply. Pure. */
export function intentShadowPayload(outcome: JevShadowOutcome, llmRaw: string): IntentShadowPayload {
  const label = llmLabel(llmRaw);
  return {
    status: outcome.status,
    llm_intent: label.intent,
    llm_parsed: label.parsed,
    lang: outcome.lang,
    modality: "text",
    ...(outcome.jev
      ? {
          jev_intent: outcome.jev.intent,
          jev_confidence: outcome.jev.confidence,
          jev_probabilities: outcome.jev.probabilities,
          jev_model: outcome.jev.model,
          jev_latency_ms: outcome.jev.latency_ms
        }
      : {}),
    ...(outcome.jev_error !== undefined ? { jev_error: outcome.jev_error } : {})
  };
}
```

Append the flag to `DISARM_FLAGS` in `src/config/disarm-posture.ts`, after
`"HOUGE_RADAR_PANEL_ENABLED"`. Add a comma to the previous element:

```ts
  // Jev intent shadow (spec 2026-09-25): an unattended per-turn metered call that sends the
  // message + thread to a third party — the STOP switch covers it like the radar's calls.
  "HOUGE_JEV_SHADOW_ENABLED"
```

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run tests/jev/ tests/config/disarm-posture.test.ts && npm run typecheck`
Expected: PASS, including the unchanged replay tests (they import the re-exported helpers).

- [ ] **Step 6: Full suite, then commit**

```bash
npx vitest run
git add src/jev/labels.ts src/jev/shadow.ts src/jev/replay.ts src/config/disarm-posture.ts tests/jev/shadow.test.ts tests/config/disarm-posture.test.ts
git commit -m "feat(jev): live shadow module — never-rejecting Jev run, intent_shadow payload, /disarm coverage"
```

---

### Task 3: Ledger event + store reads/writes

**Files:**
- Modify: `src/run/run-ledger.ts` (the `LedgerEventType` union ~L20-60; `requiredPayloadFields` ~L91)
- Modify: `src/run/run-store.ts` (next to `recordLoopHalted` ~L1400 for the write; next to
  `runLoopCapabilities` for the reads)
- Test: `tests/run/intent-shadow-store.test.ts`

**Interfaces:**
- Consumes: `IntentShadowPayload` (Task 2), as a **type-only** import.
- Produces:
```ts
recordIntentShadow(run_id: string, payload: IntentShadowPayload): void;
listIntentShadows(sinceIso?: string): Array<{ run_id: string; occurred_at: string; payload: Record<string, unknown> }>;
countClassifiedRunsWithoutShadow(fromIso: string, toIso: string): number;
firstIntentShadowAt(): string | undefined;
```

- [ ] **Step 1: Write the failing tests** in `tests/run/intent-shadow-store.test.ts`

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { RunStore } from "../../src/run/run-store.js";
import type { IntentShadowPayload } from "../../src/jev/shadow.js";

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
const payload = (over: Partial<IntentShadowPayload> = {}): IntentShadowPayload => ({
  status: "ok", llm_intent: "research", llm_parsed: true, lang: "en", modality: "text",
  jev_intent: "research", jev_confidence: 0.9, jev_probabilities: { research: 0.9, answer: 0.1 }, jev_model: "jev-1.13.0", jev_latency_ms: 250, ...over
});
const classifyOk = (store: RunStore, run_id: string) =>
  store.llmAuditSink({ run_id, role: "classify" }).record({ provider: "pi", role: "", outcome: "ok", model: "m", latency_ms: 1 });

afterEach(() => vi.useRealTimers());

describe("intent_shadow in the ledger", () => {
  it("recordIntentShadow writes one run-scoped row with the payload as given", () => {
    const store = RunStore.openInMemory();
    try {
      const run = createRun(store, "a");
      store.recordIntentShadow(run, payload());
      const rows = store.getLedgerEvents(run).filter((e) => e.event_type === "intent_shadow");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload).toMatchObject({ status: "ok", llm_intent: "research", llm_parsed: true, lang: "en" });
    } finally {
      store.close();
    }
  });

  it("no-bodies guarantee: the row carries only label/number/tag keys — never message text", () => {
    const store = RunStore.openInMemory();
    try {
      const run = createRun(store, "b");
      store.recordIntentShadow(run, payload({ status: "timeout", jev_error: "timed out after 5000ms" }));
      const row = store.getLedgerEvents(run).find((e) => e.event_type === "intent_shadow")!;
      const allowed = new Set(["status", "llm_intent", "llm_parsed", "lang", "modality", "jev_intent", "jev_confidence", "jev_probabilities", "jev_model", "jev_latency_ms", "jev_error"]);
      expect(Object.keys(row.payload).every((k) => allowed.has(k))).toBe(true);
      // `modality: "text"` is a legitimate value, so the probe looks for body-shaped keys, not the word "text".
      expect(JSON.stringify(row.payload)).not.toMatch(/prompt|question|message|content|system/i);
    } finally {
      store.close();
    }
  });

  it("llm_parsed=false is a valid value, not a missing required field", () => {
    const store = RunStore.openInMemory();
    try {
      const run = createRun(store, "c");
      expect(() => store.recordIntentShadow(run, payload({ llm_parsed: false, llm_intent: "answer" }))).not.toThrow();
    } finally {
      store.close();
    }
  });

  it("listIntentShadows: oldest first, honours since", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const store = RunStore.openInMemory();
    try {
      at("2026-09-01T00:00:00.000Z");
      const r1 = createRun(store, "d1");
      store.recordIntentShadow(r1, payload({ lang: "zh" }));
      at("2026-09-02T00:00:00.000Z");
      const r2 = createRun(store, "d2");
      store.recordIntentShadow(r2, payload({ lang: "en" }));
      expect(store.listIntentShadows().map((r) => r.payload.lang)).toEqual(["zh", "en"]);
      expect(store.listIntentShadows("2026-09-01T12:00:00.000Z").map((r) => r.run_id)).toEqual([r2]);
    } finally {
      store.close();
    }
  });

  it("countClassifiedRunsWithoutShadow: ok-classified runs with no shadow row, inside the window only", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const store = RunStore.openInMemory();
    try {
      at("2026-09-10T00:00:00.000Z");
      const shadowed = createRun(store, "e1");
      classifyOk(store, shadowed);
      store.recordIntentShadow(shadowed, payload());
      at("2026-09-11T00:00:00.000Z");
      const lost = createRun(store, "e2");
      classifyOk(store, lost);                                   // shutdown mid-shadow: counted
      const failedClassifier = createRun(store, "e3");
      store.llmAuditSink({ run_id: failedClassifier, role: "classify" })
        .record({ provider: "pi", role: "", outcome: "error", error_kind: "timeout", latency_ms: 1 }); // no label: not eligible
      at("2026-09-20T00:00:00.000Z");
      const afterWindow = createRun(store, "e4");
      classifyOk(store, afterWindow);                            // flag off later: outside [first,last]
      expect(store.countClassifiedRunsWithoutShadow("2026-09-10T00:00:00.000Z", "2026-09-12T00:00:00.000Z")).toBe(1);
    } finally {
      store.close();
    }
  });

  it("firstIntentShadowAt: the campaign start — the oldest intent_shadow row, independent of any --since (Codex B3)", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const store = RunStore.openInMemory();
    try {
      expect(store.firstIntentShadowAt()).toBeUndefined();
      at("2026-09-01T00:00:00.000Z");
      store.recordIntentShadow(createRun(store, "f1"), payload());
      at("2026-09-05T00:00:00.000Z");
      store.recordIntentShadow(createRun(store, "f2"), payload());
      expect(store.firstIntentShadowAt()).toBe("2026-09-01T00:00:00.000Z");
    } finally {
      store.close();
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/run/intent-shadow-store.test.ts`
Expected: FAIL. TypeScript errors: `recordIntentShadow` does not exist, `intent_shadow` is not a ledger event type.

- [ ] **Step 3: Implement.** In `src/run/run-ledger.ts`, add `| "intent_shadow"` to the
  `LedgerEventType` union (after `"llm_attempt"`), and to `requiredPayloadFields` (after `llm_attempt`):

```ts
  // Jev intent shadow (spec 2026-09-25 §"Live shadow" + 2026-09-26 amendments): ONE row per classified
  // turn while the shadow is armed — every status, so the report has a denominator. Labels, numbers,
  // a lang tag and a code-owned error string ONLY — never message text (bodies stay out of the ledger).
  intent_shadow: ["status", "llm_intent", "llm_parsed", "lang"],
```

In `src/run/run-store.ts`:
- add `import type { IntentShadowPayload } from "../jev/shadow.js";` beside the other imports (type
  only, erased at runtime);
- put the writer next to `recordLoopHalted` and the two readers next to `runLoopCapabilities`:

```ts
  /** Jev intent shadow (spec 2026-09-25): one `intent_shadow` row per classified turn. */
  recordIntentShadow(run_id: string, payload: IntentShadowPayload): void {
    this.appendRunLedgerEvent(run_id, "intent_shadow", "core", { ...payload });
  }
```

```ts
  /** `intent_shadow` rows, oldest first — the input of `houge jev-shadow report`. */
  listIntentShadows(sinceIso?: string): Array<{ run_id: string; occurred_at: string; payload: Record<string, unknown> }> {
    return this.db.prepare(`
      SELECT run_id, occurred_at, payload_json FROM ledger_events
      WHERE event_type = 'intent_shadow' AND occurred_at >= ?
      ORDER BY occurred_at ASC, sequence ASC
    `).all<{ run_id: string; occurred_at: string; payload_json: string }>(sinceIso ?? "")
      .map((r) => ({ run_id: r.run_id, occurred_at: r.occurred_at, payload: JSON.parse(r.payload_json) as Record<string, unknown> }));
  }

  /** When the shadow campaign started: the oldest `intent_shadow` row. The report's 28-day tenure clock. */
  firstIntentShadowAt(): string | undefined {
    return this.db.prepare(`
      SELECT occurred_at FROM ledger_events WHERE event_type = 'intent_shadow'
      ORDER BY occurred_at ASC, sequence ASC LIMIT 1
    `).get<{ occurred_at: string }>()?.occurred_at;
  }

  /**
   * Runs whose `classify` leg succeeded inside [fromIso, toIso] but that left no `intent_shadow` row:
   * a daemon shutdown mid-shadow, the flag toggled, or a failure after the classifier. The report's
   * missingness line. Callers pass the first and last shadow row times, so a later flag-off period is
   * not counted as loss.
   */
  countClassifiedRunsWithoutShadow(fromIso: string, toIso: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(DISTINCT e.run_id) AS n FROM ledger_events e
      WHERE e.event_type = 'llm_attempt' AND e.run_id IS NOT NULL
        AND json_extract(e.payload_json, '$.role') = 'classify'
        AND json_extract(e.payload_json, '$.outcome') = 'ok'
        AND e.occurred_at >= ? AND e.occurred_at <= ?
        AND NOT EXISTS (
          SELECT 1 FROM ledger_events s WHERE s.run_id = e.run_id AND s.event_type = 'intent_shadow'
        )
    `).get<{ n: number }>(fromIso, toIso);
    return row?.n ?? 0;
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/run/intent-shadow-store.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Full suite, then commit**

```bash
npx vitest run
git add src/run/run-ledger.ts src/run/run-store.ts tests/run/intent-shadow-store.test.ts
git commit -m "feat(store): intent_shadow ledger event — record, list, and count classified runs that left no shadow"
```

---

### Task 4: Wire the shadow into `classifyIntent`

**Files:**
- Modify: `src/core/core-worker.ts` (imports; constructor, last positional; the end of the
  constructor body; `classifyIntent` ~L3027; new private helpers next to `llmAdapterFor` ~L1378)
- Test: `tests/core/core-worker-jev-shadow.test.ts`

**Interfaces:**
- Consumes: Task 1 `createJevClient`, `JEV_MODEL`; Task 2 `runJevShadow`, `intentShadowPayload`,
  `resolveJevShadowEnabled`, `JEV_SHADOW_TIMEOUT_MS`, `JevShadowCall`, `JevShadowOutcome`; Task 3
  `recordIntentShadow`.
- Produces: `CoreWorker` gains an appended 14th positional constructor argument
  `jevShadowCall?: JevShadowCall`, after `googleDeps`.

- [ ] **Step 1: Write the failing tests** in `tests/core/core-worker-jev-shadow.test.ts`

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreWorker } from "../../src/core/core-worker.js";
import { evolutionLaneSettled, resetEvolutionLaneForTests } from "../../src/core/evolution-lane.js";
import { INTENT_DISCIPLINE } from "../../src/capabilities/intent.js";
import { DISTILL_DISCIPLINE } from "../../src/capabilities/distill.js";
import { RECONCILE_DISCIPLINE } from "../../src/capabilities/reconcile.js";
import { GATE_A_DISCIPLINE } from "../../src/capabilities/skill-router.js";
import { LOOP_DISCIPLINE } from "../../src/prompt/composer.js";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { CapabilityRunner } from "../../src/capabilities/capability-runner.js";
import { Gateway } from "../../src/gateway/gateway.js";
import type { JevRequest, JevResult } from "../../src/jev/jev-client.js";
import { RunStore } from "../../src/run/run-store.js";
import type { ToolAdapterResult } from "../../src/tools/tool-registry.js";

// HERMETICITY (the cardinal PINNED_ENV rule): the daemon's .env leaks into test runs via the
// self-write test gate — pin every flag that could arm the shadow or change the turn's path.
const PINNED_ENV = [
  "HOUGE_JEV_SHADOW_ENABLED", "TYPESAFE_API_KEY", "HOUGE_SECRETS_FIREWALL_ENABLED",
  "HOUGE_EPISODIC_ENABLED", "HOUGE_DUAL_LLM_ENABLED", "HOUGE_SKILLS_ENABLED", "HOUGE_SELFWRITE_ENABLED",
  "HOUGE_CODEX_ENABLED", "HOUGE_SCHEDULER_ENABLED", "HOUGE_WIKI_ENABLED", "HOUGE_EXTWORK_ENABLED",
  "HOUGE_BOUNTY_ENABLED", "HOUGE_GOOGLE_ENABLED", "HOUGE_MAX_CONSECUTIVE_CLARIFY"
] as const;
let savedEnv: Record<string, string | undefined> = {};
let dirs: string[] = [];
beforeEach(() => {
  savedEnv = {};
  for (const key of PINNED_ENV) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  resetEvolutionLaneForTests();
});
afterEach(async () => {
  await evolutionLaneSettled();
  resetEvolutionLaneForTests();
  for (const key of PINNED_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
  vi.restoreAllMocks();
});

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-jev-shadow-"));
  dirs.push(dir);
  return dir;
}

function turnRun(store: RunStore, message: string, key = `t:${message}`): string {
  const intake = new Gateway(store).intake(buildTypedTaskEvent({
    source: "telegram", type: "turn", program: "turn", goal: message,
    requested_by: { kind: "user", id: "paco" }, notify: { kind: "telegram", chat_id: "555" },
    idempotency_key: key, source_reference: "telegram:update:1:message:1"
  }));
  if (!intake.ok) throw new Error(`intake failed: ${JSON.stringify(intake)}`);
  return intake.run_id;
}

/** Classifier → `verdict` (after `beforeVerdict` settles); compose → a final answer; the rest → benign stubs. */
function fakeLlm(verdict: string, calls: Array<Record<string, unknown>> = [], beforeVerdict?: Promise<unknown>, classifierFails = false) {
  return async (input: Record<string, unknown>): Promise<ToolAdapterResult> => {
    calls.push(input);
    const system = typeof input.system === "string" ? input.system : "";
    if (system.includes(INTENT_DISCIPLINE)) {
      if (beforeVerdict) await beforeVerdict;
      if (classifierFails) return { ok: false, error: "classifier down" };
      return { ok: true, output: { question: input.question, answer: verdict, model: "fake", provider: "fake" } };
    }
    let answer = `ANSWER: ${String(input.question)}`;
    if (system.includes(LOOP_DISCIPLINE)) answer = '{"action":"final","answer":"done."}';
    else if (system === DISTILL_DISCIPLINE) answer = '{"durable":false}';
    else if (system === RECONCILE_DISCIPLINE) answer = '{"verdict":"ADD"}';
    else if (system === GATE_A_DISCIPLINE) answer = '{"verdict":"unsure","reason":"stub"}';
    return { ok: true, output: { question: input.question, answer, model: "fake", provider: "fake" } };
  };
}

const jevOk = (choice = "research", confidence = 0.9): JevResult => ({
  ok: true, model: "jev-1.13.0", input_tokens: 700, latency_ms: 250,
  answers: { intent: { choice, confidence, probabilities: { answer: 0.02, research: 0.9, feedback: 0.02, clarify: 0.02, selfcode: 0.02, skill: 0.02 } } }
});

/** A CoreWorker with injected LLM + Jev fakes (the Jev fake is the 14th positional). */
function worker(store: RunStore, llm: ReturnType<typeof fakeLlm>, jev?: (req: JevRequest) => Promise<JevResult>) {
  return new CoreWorker(store, root(), llm, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, jev);
}

const shadowRows = (store: RunStore, run_id: string) =>
  store.getLedgerEvents(run_id).filter((e) => e.event_type === "intent_shadow");

describe("the live Jev intent shadow inside classifyIntent", () => {
  it("flag OFF: Jev is never called and no intent_shadow row exists", async () => {
    const store = RunStore.openInMemory();
    try {
      const jev = vi.fn(async () => jevOk());
      const run = turnRun(store, "what is 2+2?");
      expect((await worker(store, fakeLlm('{"intent":"answer"}'), jev).executeRun(run, "w")).status).toBe("completed");
      expect(jev).not.toHaveBeenCalled();
      expect(shadowRows(store, run)).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("flag ON: one row pairing Jev's label with the classifier's RAW label, from the same inputs", async () => {
    process.env.HOUGE_JEV_SHADOW_ENABLED = "true";
    const store = RunStore.openInMemory();
    try {
      const jev = vi.fn(async (_req: JevRequest) => jevOk("research", 0.93));
      const run = turnRun(store, "what did the RBA decide today?");
      expect((await worker(store, fakeLlm('{"intent":"research","query":"rba decision"}'), jev).executeRun(run, "w")).status).toBe("completed");
      await vi.waitFor(() => expect(shadowRows(store, run)).toHaveLength(1));
      expect(shadowRows(store, run)[0]!.payload).toMatchObject({
        status: "ok", llm_intent: "research", llm_parsed: true, lang: "en", modality: "text",
        jev_intent: "research", jev_confidence: 0.93, jev_model: "jev-1.13.0", jev_latency_ms: 250
      });
      expect((jev.mock.calls[0]![0].state as { latest_message: string }).latest_message).toBe("what did the RBA decide today?");
    } finally {
      store.close();
    }
  });

  it("Jev starts BEFORE the classifier returns (concurrent, not after): a classifier that waits for Jev still completes", async () => {
    process.env.HOUGE_JEV_SHADOW_ENABLED = "1";
    const store = RunStore.openInMemory();
    try {
      let markJevStarted!: () => void;
      const jevStarted = new Promise<void>((r) => { markJevStarted = r; });
      const jev = vi.fn(async () => { markJevStarted(); return jevOk(); });
      const run = turnRun(store, "latest ASX close?");
      const result = await worker(store, fakeLlm('{"intent":"research"}', [], jevStarted), jev).executeRun(run, "w");
      expect(result.status).toBe("completed");
    } finally {
      store.close();
    }
  });

  it("the turn NEVER waits: a Jev call that never settles leaves the turn unaffected — its timeout row lands at the outer deadline (shadow.test.ts)", async () => {
    process.env.HOUGE_JEV_SHADOW_ENABLED = "true";
    const store = RunStore.openInMemory();
    try {
      const jev = vi.fn(() => new Promise<JevResult>(() => {}));
      const run = turnRun(store, "hello there");
      expect((await worker(store, fakeLlm('{"intent":"answer"}'), jev).executeRun(run, "w")).status).toBe("completed");
      expect(jev).toHaveBeenCalledTimes(1);
      expect(shadowRows(store, run)).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("a Jev call that throws cannot fail the turn — it is recorded as status error", async () => {
    process.env.HOUGE_JEV_SHADOW_ENABLED = "true";
    const store = RunStore.openInMemory();
    try {
      const run = turnRun(store, "hello again");
      const jev = vi.fn(async (): Promise<JevResult> => { throw new Error("socket hang up"); });
      expect((await worker(store, fakeLlm('{"intent":"answer"}'), jev).executeRun(run, "w")).status).toBe("completed");
      await vi.waitFor(() => expect(shadowRows(store, run)).toHaveLength(1));
      expect(shadowRows(store, run)[0]!.payload).toMatchObject({ status: "error", jev_error: "shadow call threw", llm_intent: "answer" });
    } finally {
      store.close();
    }
  });

  it("records the classifier's clarify BEFORE the recordedIntent rewrite turns it into answer", async () => {
    process.env.HOUGE_JEV_SHADOW_ENABLED = "true";
    const store = RunStore.openInMemory();
    try {
      const run = turnRun(store, "can you check it?");
      await worker(store, fakeLlm('{"intent":"clarify","clarifying_question":"check what?"}'), async () => jevOk("clarify", 0.8)).executeRun(run, "w");
      expect(store.getRecentChatTurns("555", 2).find((t) => t.role === "assistant")!.intent).toBe("answer");
      await vi.waitFor(() => expect(shadowRows(store, run)).toHaveLength(1));
      expect(shadowRows(store, run)[0]!.payload.llm_intent).toBe("clarify");
    } finally {
      store.close();
    }
  });

  it("an unparseable classifier reply is recorded as answer with llm_parsed=false", async () => {
    process.env.HOUGE_JEV_SHADOW_ENABLED = "true";
    const store = RunStore.openInMemory();
    try {
      const run = turnRun(store, "tell me something");
      await worker(store, fakeLlm("I think this is research"), async () => jevOk()).executeRun(run, "w");
      await vi.waitFor(() => expect(shadowRows(store, run)).toHaveLength(1));
      expect(shadowRows(store, run)[0]!.payload).toMatchObject({ llm_intent: "answer", llm_parsed: false });
    } finally {
      store.close();
    }
  });

  it("classifier failure: the turn fails as before and NO intent_shadow row is written (no label to pair)", async () => {
    process.env.HOUGE_JEV_SHADOW_ENABLED = "true";
    const store = RunStore.openInMemory();
    try {
      const run = turnRun(store, "anything");
      const result = await worker(store, fakeLlm('{"intent":"answer"}', [], undefined, true), async () => jevOk()).executeRun(run, "w");
      expect(result.status).not.toBe("completed");
      await new Promise((r) => setTimeout(r, 20));
      expect(shadowRows(store, run)).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("runner admission comes FIRST: a classifier the runner denies never sends the message to Jev (Codex B1)", async () => {
    process.env.HOUGE_JEV_SHADOW_ENABLED = "true";
    const store = RunStore.openInMemory();
    const original = CapabilityRunner.prototype.execute;
    vi.spyOn(CapabilityRunner.prototype, "execute").mockImplementation(async function (this: CapabilityRunner, input) {
      const system = typeof input.input.system === "string" ? input.input.system : "";
      if (input.capability === "llm_answer" && system.includes(INTENT_DISCIPLINE)) {
        return { status: "denied", reason: "budget exhausted (test)", recovery_hint: "Write a partial report" };
      }
      return original.call(this, input);
    });
    try {
      const jev = vi.fn(async () => jevOk());
      const run = turnRun(store, "a denied turn");
      const result = await worker(store, fakeLlm('{"intent":"answer"}'), jev).executeRun(run, "w");
      expect(result.status).not.toBe("completed");
      await new Promise((r) => setTimeout(r, 20));
      expect(jev).not.toHaveBeenCalled();
      expect(shadowRows(store, run)).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("Jev's label never reaches a prompt: the loop's hint is the classifier's, even when Jev disagrees confidently", async () => {
    process.env.HOUGE_JEV_SHADOW_ENABLED = "true";
    const store = RunStore.openInMemory();
    try {
      const calls: Array<Record<string, unknown>> = [];
      const run = turnRun(store, "what's new with the RBA?");
      await worker(store, fakeLlm('{"intent":"research"}', calls), async () => jevOk("skill", 0.99)).executeRun(run, "w");
      const compose = calls.filter((c) => String(c.system).includes(LOOP_DISCIPLINE));
      expect(compose.length).toBeGreaterThan(0);
      for (const c of compose) {
        expect(String(c.question)).toContain("A first-pass classifier suggests: research");
        expect(String(c.question)).not.toContain("suggests: skill");
      }
    } finally {
      store.close();
    }
  });

  it("the flag is read LIVE per turn (/disarm flips process.env): turning it off stops the next shadow", async () => {
    process.env.HOUGE_JEV_SHADOW_ENABLED = "true";
    const store = RunStore.openInMemory();
    try {
      const jev = vi.fn(async () => jevOk());
      const w = worker(store, fakeLlm('{"intent":"answer"}'), jev);
      await w.executeRun(turnRun(store, "first", "k1"), "w");
      process.env.HOUGE_JEV_SHADOW_ENABLED = "false";
      await w.executeRun(turnRun(store, "second", "k2"), "w");
      expect(jev).toHaveBeenCalledTimes(1);
    } finally {
      store.close();
    }
  });

  it("hermetic by construction: an injected LLM + a real key in env + no Jev fake → no network, no row", async () => {
    process.env.HOUGE_JEV_SHADOW_ENABLED = "true";
    process.env.TYPESAFE_API_KEY = "ts-live-looking-key-0000000000";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const store = RunStore.openInMemory();
    try {
      const run = turnRun(store, "is this hermetic?");
      await worker(store, fakeLlm('{"intent":"answer"}')).executeRun(run, "w");
      await new Promise((r) => setTimeout(r, 20));
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(shadowRows(store, run)).toHaveLength(0);
      expect(store.getLedgerEvents(run).filter((e) => e.event_type === "llm_attempt" && e.payload.role === "classify_shadow")).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("boot warning: flag on + no key + production adapters → exactly one warning; key present or flag off → none", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = RunStore.openInMemory();
    try {
      const jevWarnings = () => warn.mock.calls.filter((c) => String(c[0]).includes("[jev-shadow]")).length;
      process.env.HOUGE_JEV_SHADOW_ENABLED = "true";
      new CoreWorker(store, root());
      expect(jevWarnings()).toBe(1);
      process.env.TYPESAFE_API_KEY = "ts-live-looking-key-0000000000";
      new CoreWorker(store, root());
      process.env.HOUGE_JEV_SHADOW_ENABLED = "false";
      delete process.env.TYPESAFE_API_KEY;
      new CoreWorker(store, root());
      expect(jevWarnings()).toBe(1);
      expect(warn.mock.calls.flat().join(" ")).not.toContain("ts-live-looking-key");
    } finally {
      store.close();
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/core/core-worker-jev-shadow.test.ts`
Expected: FAIL. TypeScript rejects the 14th constructor argument. Once it compiles, the flag-ON
tests find no `intent_shadow` rows.

- [ ] **Step 3: Implement** in `src/core/core-worker.ts`

Imports (with the other `../jev`/`../llm` imports, or near the top):

```ts
import { createJevClient, JEV_MODEL } from "../jev/jev-client.js";
import {
  intentShadowPayload, JEV_SHADOW_TIMEOUT_MS, resolveJevShadowEnabled, runJevShadow,
  type JevShadowCall, type JevShadowOutcome
} from "../jev/shadow.js";
```

Constructor: append after `googleDeps` (add a comma after `defaultGoogleApiDeps()`):

```ts
    private readonly googleDeps: GoogleApiDeps = defaultGoogleApiDeps(),
    // Jev intent shadow (spec 2026-09-25 + 2026-09-26 amendments): tests inject a fake Jev call.
    // Absent → production builds an audited client per run, but ONLY beside the production LLM
    // adapter: a test-injected LLM never pairs with a real Jev call (the daemon's .env leaks into
    // test runs). Appended last so existing positional callers are unaffected.
    private readonly jevShadowCall?: JevShadowCall
  ) {
```

Add a private field beside the other private fields: `private jevOffModelWarned = false;`

At the very END of the constructor body:

```ts
    // Jev intent shadow: armed without a key → ONE boot warning, and the shadow stays off.
    if (resolveJevShadowEnabled(process.env) && !this.jevShadowCall && this.llmAdapterIsDefault && !this.typesafeKey()) {
      console.warn("[jev-shadow] HOUGE_JEV_SHADOW_ENABLED is on but TYPESAFE_API_KEY is not set — the live intent shadow stays off");
    }
```

New private helpers, next to `llmAdapterFor`:

```ts
  /** The TypeSafe key: broker-held when the secrets firewall is armed, else the ambient env. */
  private typesafeKey(): string | undefined {
    return this.broker ? this.broker.typesafeKey() : process.env.TYPESAFE_API_KEY;
  }

  /**
   * The Jev call for this run's intent shadow, or null when the shadow is off. The flag is read LIVE
   * (`/disarm` flips it). Production builds an audited client per run — `classify_shadow` rows, the
   * metered fuse, no retries, a 5 s timeout — and only beside the production LLM adapter.
   */
  private jevShadowCallFor(run_id: string): JevShadowCall | null {
    if (!resolveJevShadowEnabled(process.env)) return null;
    if (this.jevShadowCall) return this.jevShadowCall;
    if (!this.llmAdapterIsDefault) return null;
    const apiKey = this.typesafeKey();
    if (!apiKey) return null;
    return createJevClient({
      apiKey,
      audit: this.runStore.llmAuditSink({ run_id, role: "classify_shadow" }),
      meteredBreached: () => this.runStore.meteredFuseLatched(),
      retries: 0,
      timeoutMs: JEV_SHADOW_TIMEOUT_MS
    });
  }

  /**
   * Record the shadow once the classifier's raw reply is known. NEVER awaited by the turn: Jev has
   * usually settled already (~0.3 s vs the classifier's ~6 s), and a failure here is a warning, never
   * a turn failure. A shadow still in flight at shutdown is lost; the report counts it as missing.
   */
  private recordJevShadow(run_id: string, shadow: Promise<JevShadowOutcome>, llmRaw: string): void {
    void shadow
      .then((outcome) => {
        if (outcome.jev && outcome.jev.model !== JEV_MODEL && !this.jevOffModelWarned) {
          this.jevOffModelWarned = true;
          console.warn(`[jev-shadow] Jev answered as ${outcome.jev.model}, not the pinned ${JEV_MODEL}; the report keeps it out of the verdict`);
        }
        this.runStore.recordIntentShadow(run_id, intentShadowPayload(outcome, llmRaw));
      })
      .catch((error: unknown) => {
        console.warn(`[jev-shadow] recording failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
      });
  }
```

In `classifyIntent`:
- Replace the existing `registry.register({ name: "llm_answer", … execute: this.llmAdapterFor(claim.run_id, "classify") })`
  call with this, so the shadow starts INSIDE the adapter — after the runner's admission:

```ts
    // Jev intent shadow: started INSIDE the classifier adapter, i.e. only after CapabilityRunner has
    // admitted the call (budget reserved, contract allows it) — a denied classifier never sends the
    // message to Jev. Not awaited: Jev and the classifier run concurrently on identical inputs, and
    // runJevShadow resolves on every path. A holder object rather than a `let`, so TypeScript keeps
    // the widened type after the await (closure assignments do not reset narrowing).
    const shadowCall = this.jevShadowCallFor(claim.run_id);
    const shadow: { pending: Promise<JevShadowOutcome> | null } = { pending: null };
    const classifier = this.llmAdapterFor(claim.run_id, "classify");
    registry.register({
      name: "llm_answer",
      category: "tool",
      side_effect_level: "external_read",
      risk_level: "low",
      timeout_ms: llmTimeoutMs,
      output_limit_bytes: 100_000,
      // Phase 3.1 (W3): the intent classifier is a `classify`-role cheap-chain call → instrumented.
      execute: shadowCall
        ? (input) => {
            shadow.pending = runJevShadow(shadowCall, message, recentTurns, turnChars, recentClarifyCount);
            return classifier(input);
          }
        : classifier
    });
```

- Replace the method's tail (from `const raw = ...` to the end):

```ts
    const raw = typeof result.output.answer === "string" ? result.output.answer : "";
    if (shadow.pending) this.recordJevShadow(claim.run_id, shadow.pending, raw);
    return { ok: true, classification: parseIntent(raw) };
```

- Leave the `if (result.status !== "succeeded") { return { ok: false, failure: result }; }` branch
  unchanged. With no label there is no row. A denied or unknown-capability result never ran the
  adapter, so `shadow.pending` is still null and Jev was never called; a failed or timed-out adapter
  leaves a pending shadow that resolves harmlessly because it never rejects.

The existing guard in `tests/llm/audit-coverage.test.ts` now also checks this `createJevClient(`
site (inline `audit: this.runStore.llmAuditSink(` + `meteredBreached:`). It must stay green.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/core/core-worker-jev-shadow.test.ts tests/llm/audit-coverage.test.ts tests/core/core-worker-turn-loop.test.ts && npm run typecheck`
Expected: PASS. The existing turn-loop suite is unchanged: its adapters are injected, so the shadow
is off there by construction.

- [ ] **Step 5: Full suite, then commit**

```bash
npx vitest run
git add src/core/core-worker.ts tests/core/core-worker-jev-shadow.test.ts
git commit -m "feat(core): live Jev intent shadow beside classifyIntent — concurrent, never awaited, hermetic by construction"
```

---

### Task 5: `houge jev-shadow report` — PROMOTE / HOLD / KILL per language

**Files:**
- Modify: `src/jev/replay-report.ts` (export four helpers; no behaviour change)
- Create: `src/jev/shadow-report.ts`
- Modify: `src/cli.ts` (the `jev-shadow` branch)
- Test: `tests/jev/shadow-report.test.ts`

**Interfaces:**
- Consumes: Task 3 `listIntentShadows`, `countClassifiedRunsWithoutShadow`, `firstIntentShadowAt`; `runLoopCapabilities`;
  Task 2 `observedAction`, `ObservedAction`; `JEV_MODEL`.
- Produces:
```ts
// replay-report.ts (now exported)
export const THRESHOLDS: readonly number[];
export interface AgreementRow { jev_intent?: string; jev_confidence?: number; llm_intent?: string }
export function atThreshold<R extends AgreementRow>(matched: R[], t: number): { t: number; slice: number; agreement: number | null; coverage: number | null };
export function pct(x: number | null): string;
export function confusion<R extends AgreementRow>(rows: R[], other: (r: R) => string | undefined, label: string): string[];
// shadow-report.ts
export interface ShadowRow { run_id: string; occurred_at: string; status: string; lang: string; llm_intent: string; llm_parsed: boolean;
  jev_intent?: string; jev_confidence?: number; jev_model?: string; jev_error?: string; observed_action: ObservedAction }
export type LangVerdict = "PROMOTE" | "HOLD" | "KILL";
export interface LangSummary { rows: number; matched: number; agreement: number | null; coverage: number | null; verdict: LangVerdict; reason: string;
  byStatus: Record<string, number>; byModel: Record<string, number> }
export interface ShadowSummary { rows: number; matched: number; missing: number; days: number; byStatus: Record<string, number>;
  byModel: Record<string, number>; thresholds: ReturnType<typeof atThreshold>[]; byLang: Record<string, LangSummary>;
  costly: { research: number; missed: number }; clarify: { llm: number; matched: number } }
export function isShadowMatched(r: ShadowRow): boolean;
export function loadShadowRows(store: Pick<RunStore, "listIntentShadows" | "runLoopCapabilities">, sinceIso?: string): ShadowRow[];
export function summarizeShadow(rows: ShadowRow[], missing: number, nowIso: string, campaignStartIso?: string): ShadowSummary;
export function formatShadowReport(s: ShadowSummary, matchedRows: ShadowRow[]): string;
export function parseShadowReportArgs(argv: string[]): { ok: true; sinceIso?: string } | { ok: false; error: string };
```

- [ ] **Step 1: Write the failing tests** in `tests/jev/shadow-report.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { JEV_MODEL } from "../../src/jev/jev-client.js";
import { formatShadowReport, isShadowMatched, loadShadowRows, parseShadowReportArgs, summarizeShadow, type ShadowRow } from "../../src/jev/shadow-report.js";
import { RunStore } from "../../src/run/run-store.js";

const START = "2026-09-01T00:00:00.000Z";
const DAY = 86_400_000;
const after = (days: number) => new Date(Date.parse(START) + days * DAY).toISOString();
const row = (i: number, over: Partial<ShadowRow> = {}): ShadowRow => ({
  run_id: `r${i}`, occurred_at: i === 0 ? START : after(1), status: "ok", lang: "zh", llm_intent: "research", llm_parsed: true,
  jev_intent: "research", jev_confidence: 0.9, jev_model: JEV_MODEL, observed_action: "research", ...over
});
const rows = (n: number, over: Partial<ShadowRow> = {}, from = 0) => Array.from({ length: n }, (_, k) => row(from + k, over));
// A failed shadow row carries no jev_* fields at all (exactOptionalPropertyTypes forbids `jev_intent: undefined`).
const failed = (i: number): ShadowRow => ({
  run_id: `r${i}`, occurred_at: after(1), status: "timeout", lang: "zh", llm_intent: "research", llm_parsed: true,
  jev_error: "timed out after 5000ms", observed_action: "research"
});

describe("summarizeShadow — the per-language promotion bar", () => {
  it("HOLD below 60 matched turns, even at 100% agreement", () => {
    expect(summarizeShadow(rows(59), 0, after(30)).byLang.zh!.verdict).toBe("HOLD");
  });

  it("HOLD before 28 days, even with plenty of turns", () => {
    expect(summarizeShadow(rows(100), 0, after(27)).byLang.zh!.verdict).toBe("HOLD");
  });

  it("PROMOTE at exactly 90% agreement and full coverage", () => {
    const s = summarizeShadow([...rows(54), ...rows(6, { jev_intent: "answer" }, 54)], 0, after(30));
    expect(s.byLang.zh).toMatchObject({ verdict: "PROMOTE", matched: 60, agreement: 0.9, coverage: 1 });
  });

  it("KILL at 89.9% agreement", () => {
    const s = summarizeShadow([...rows(899), ...rows(101, { jev_intent: "answer" }, 899)], 0, after(30));
    expect(s.byLang.zh!.verdict).toBe("KILL");
  });

  it("KILL at 59% coverage: low-confidence and failed turns count in the denominator", () => {
    const s = summarizeShadow([
      ...rows(65),                                                        // confident + agreeing
      ...rows(35, { jev_confidence: 0.3 }, 65),                            // matched but below 0.7
      ...Array.from({ length: 10 }, (_, k) => failed(100 + k))
    ], 0, after(30));
    expect(s.byLang.zh).toMatchObject({ verdict: "KILL", coverage: 65 / 110 });
  });

  it("per-language verdicts: zh can PROMOTE while en HOLDs", () => {
    const s = summarizeShadow([...rows(80), ...rows(12, { lang: "en" }, 80)], 0, after(30));
    expect(s.byLang.zh!.verdict).toBe("PROMOTE");
    expect(s.byLang.en!.verdict).toBe("HOLD");
  });

  it("matched excludes unparsed classifier replies and non-pinned Jev models", () => {
    expect(isShadowMatched(row(1, { llm_parsed: false }))).toBe(false);
    expect(isShadowMatched(row(1, { jev_model: "jev-1.14.0" }))).toBe(false);
    expect(isShadowMatched(row(1, { status: "error" }))).toBe(false);
    expect(isShadowMatched(row(1))).toBe(true);
  });

  it("reports the costly direction and clarify — reported, never gating", () => {
    const s = summarizeShadow([
      ...rows(10),
      ...rows(2, { jev_intent: "answer" }, 10),                             // missed research calls
      ...rows(3, { llm_intent: "clarify", jev_intent: "clarify" }, 12),
      ...rows(4, { llm_intent: "clarify", jev_intent: "answer" }, 15)
    ], 0, after(30));
    expect(s.costly).toEqual({ research: 12, missed: 2 });
    expect(s.clarify).toEqual({ llm: 7, matched: 3 });
  });

  it("tenure is the campaign's age, not the age of the first --since row (Codex B3)", () => {
    // 100 rows in the last day, but the campaign started 30 days ago: not a tenure HOLD.
    const recent = rows(100).map((r) => ({ ...r, occurred_at: after(29) }));
    expect(summarizeShadow(recent, 0, after(30), START).byLang.zh!.verdict).toBe("PROMOTE");
    expect(summarizeShadow(recent, 0, after(30)).byLang.zh!.verdict).toBe("HOLD");
  });

  it("status and model counts are split per language — missingness by language and model (Codex R5)", () => {
    const s = summarizeShadow([...rows(5), ...rows(2, { lang: "en" }, 5), failed(7), row(8, { jev_model: "jev-1.14.0" })], 0, after(30));
    expect(s.byLang.zh!.byStatus).toEqual({ ok: 6, timeout: 1 });
    expect(s.byLang.zh!.byModel).toEqual({ [JEV_MODEL]: 5, "jev-1.14.0": 1 });
    expect(s.byLang.en!.byStatus).toEqual({ ok: 2 });
  });
});

describe("formatShadowReport", () => {
  it("leads with per-language verdicts, then counts, missingness, costly direction, clarify", () => {
    const all = [...rows(80), ...rows(12, { lang: "en" }, 80)];
    const text = formatShadowReport(summarizeShadow(all, 3, after(30)), all.filter(isShadowMatched));
    expect(text).toMatch(/zh: PROMOTE/);
    expect(text).toMatch(/en: HOLD/);
    expect(text).toMatch(/by status \{"ok":80\}/);
    expect(text).toMatch(/missing 3/);
    expect(text).toMatch(/Costly direction/);
    expect(text).toMatch(/Clarify/);
    expect(text).toMatch(/separate spec/);
  });

  it("an empty ledger says so instead of printing a verdict", () => {
    expect(formatShadowReport(summarizeShadow([], 0, after(1)), [])).toMatch(/No intent_shadow rows yet/);
  });
});

describe("loadShadowRows", () => {
  it("maps stored rows and joins the observed action from loop steps", () => {
    const store = RunStore.openInMemory();
    try {
      const created = store.createOrGet(buildTypedTaskEvent({
        source: "cli", type: "run", program: "research-brief", goal: "g",
        requested_by: { kind: "user", id: "paco" }, notify: { kind: "local" },
        idempotency_key: "k", source_reference: "argv", created_at: START
      }));
      if (created.status !== "created") throw new Error("expected created");
      store.recordIntentShadow(created.run_id, { status: "ok", llm_intent: "research", llm_parsed: true, lang: "en", modality: "text", jev_intent: "research", jev_confidence: 0.8, jev_model: JEV_MODEL, jev_latency_ms: 200, jev_probabilities: {} });
      store.recordLoopStep(created.run_id, { step: 1, action: "tool", capability: "web_search", ok: true, result_digest: "" });
      expect(loadShadowRows(store)).toEqual([expect.objectContaining({
        run_id: created.run_id, status: "ok", lang: "en", llm_intent: "research", llm_parsed: true,
        jev_intent: "research", jev_confidence: 0.8, jev_model: JEV_MODEL, observed_action: "research"
      })]);
    } finally {
      store.close();
    }
  });
});

describe("parseShadowReportArgs", () => {
  it("accepts nothing or --since ISO (normalised to UTC); rejects the rest", () => {
    expect(parseShadowReportArgs([])).toEqual({ ok: true });
    expect(parseShadowReportArgs(["--since", "2026-09-01T10:00:00+10:00"])).toEqual({ ok: true, sinceIso: "2026-09-01T00:00:00.000Z" });
    expect(parseShadowReportArgs(["--since", "yesterday"]).ok).toBe(false);
    expect(parseShadowReportArgs(["--limit", "5"]).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/jev/shadow-report.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Export the shared helpers** in `src/jev/replay-report.ts`. The behaviour must stay
  identical; the existing replay-report tests prove it.
  - `const THRESHOLDS = […]` → `export const THRESHOLDS: readonly number[] = [0.5, 0.6, 0.7, 0.8, 0.9];`
  - Add `export interface AgreementRow { jev_intent?: string; jev_confidence?: number; llm_intent?: string }`.
  - `function atThreshold(matched: ReplayRow[], t: number)` →
    `export function atThreshold<R extends AgreementRow>(matched: R[], t: number)`. The body is unchanged.
  - `function pct(` → `export function pct(`.
  - `function confusion(rows: ReplayRow[], other: (r: ReplayRow) => string | undefined, label: string)` →
    `export function confusion<R extends AgreementRow>(rows: R[], other: (r: R) => string | undefined, label: string)`.
    The body is unchanged.

- [ ] **Step 4: Implement** `src/jev/shadow-report.ts`

```ts
import type { RunStore } from "../run/run-store.js";
import { JEV_MODEL } from "./jev-client.js";
import { observedAction, type ObservedAction } from "./labels.js";
import { atThreshold, confusion, pct, THRESHOLDS } from "./replay-report.js";

/**
 * `houge jev-shadow report` (Jev spec 2026-09-25 §"Live shadow" + 2026-09-26 amendments): the live
 * intent_shadow rows → a PROMOTE / HOLD / KILL verdict per language. Read-only; promotion itself is a
 * separate spec.
 */
const GATE_CONFIDENCE = 0.7;
const PROMOTE_AGREEMENT = 0.9;
const PROMOTE_COVERAGE = 0.6;
const MIN_MATCHED = 60;
const MIN_DAYS = 28;
const DAY_MS = 86_400_000;

export interface ShadowRow {
  run_id: string;
  occurred_at: string;
  status: string;
  lang: string;
  llm_intent: string;
  llm_parsed: boolean;
  jev_intent?: string;
  jev_confidence?: number;
  jev_model?: string;
  jev_error?: string;
  observed_action: ObservedAction;
}
export type LangVerdict = "PROMOTE" | "HOLD" | "KILL";
export interface LangSummary {
  rows: number;
  matched: number;
  agreement: number | null;
  coverage: number | null;
  verdict: LangVerdict;
  reason: string;
  byStatus: Record<string, number>;
  byModel: Record<string, number>;
}
export interface ShadowSummary {
  rows: number;
  matched: number;
  missing: number;
  days: number;
  byStatus: Record<string, number>;
  byModel: Record<string, number>;
  thresholds: ReturnType<typeof atThreshold>[];
  byLang: Record<string, LangSummary>;
  costly: { research: number; missed: number };
  clarify: { llm: number; matched: number };
}

/** Matched = a parsed classifier label AND an ok answer from the pinned Jev model. */
export function isShadowMatched(r: ShadowRow): boolean {
  return r.status === "ok" && r.llm_parsed && r.jev_intent !== undefined && r.jev_confidence !== undefined && r.jev_model === JEV_MODEL;
}

export function loadShadowRows(store: Pick<RunStore, "listIntentShadows" | "runLoopCapabilities">, sinceIso?: string): ShadowRow[] {
  return store.listIntentShadows(sinceIso).map(({ run_id, occurred_at, payload: p }) => ({
    run_id,
    occurred_at,
    status: String(p.status),
    lang: String(p.lang),
    llm_intent: String(p.llm_intent),
    llm_parsed: p.llm_parsed === true,
    ...(typeof p.jev_intent === "string" ? { jev_intent: p.jev_intent } : {}),
    ...(typeof p.jev_confidence === "number" ? { jev_confidence: p.jev_confidence } : {}),
    ...(typeof p.jev_model === "string" ? { jev_model: p.jev_model } : {}),
    ...(typeof p.jev_error === "string" ? { jev_error: p.jev_error } : {}),
    // One loop-capabilities read per row, the replay's pattern: hundreds of rows on in-process SQLite.
    observed_action: observedAction(store.runLoopCapabilities(run_id))
  }));
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
  return out;
}

function langSummary(langRows: ShadowRow[], days: number): LangSummary {
  const matched = langRows.filter(isShadowMatched);
  const slice = matched.filter((r) => (r.jev_confidence ?? 0) >= GATE_CONFIDENCE);
  const agreement = slice.length > 0 ? slice.filter((r) => r.jev_intent === r.llm_intent).length / slice.length : null;
  const coverage = langRows.length > 0 ? slice.length / langRows.length : null;
  const base = {
    rows: langRows.length, matched: matched.length, agreement, coverage,
    byStatus: countBy(langRows, (r) => r.status),
    byModel: countBy(langRows.filter((r) => r.status === "ok" && r.jev_model !== undefined), (r) => r.jev_model ?? "")
  };
  if (matched.length < MIN_MATCHED || days < MIN_DAYS) {
    return { ...base, verdict: "HOLD", reason: `needs ≥${MIN_MATCHED} matched turns and ≥${MIN_DAYS} days (has ${matched.length}, ${days.toFixed(1)} days)` };
  }
  if (agreement !== null && agreement >= PROMOTE_AGREEMENT && coverage !== null && coverage >= PROMOTE_COVERAGE) {
    return { ...base, verdict: "PROMOTE", reason: `agreement ${pct(agreement)}, coverage ${pct(coverage)}, matched ${matched.length}` };
  }
  return { ...base, verdict: "KILL", reason: `agreement ${pct(agreement)} (bar ${pct(PROMOTE_AGREEMENT)}), coverage ${pct(coverage)} (bar ${pct(PROMOTE_COVERAGE)})` };
}

export function summarizeShadow(rows: ShadowRow[], missing: number, nowIso: string, campaignStartIso?: string): ShadowSummary {
  const matched = rows.filter(isShadowMatched);
  // Tenure is the campaign's age — the first intent_shadow row EVER — not the first row inside --since.
  const first = campaignStartIso ?? rows[0]?.occurred_at;
  const days = first === undefined ? 0 : (Date.parse(nowIso) - Date.parse(first)) / DAY_MS;
  const byLang: Record<string, LangSummary> = {};
  for (const lang of new Set(rows.map((r) => r.lang))) byLang[lang] = langSummary(rows.filter((r) => r.lang === lang), days);
  const confidentResearch = matched.filter((r) => r.llm_intent === "research" && (r.jev_confidence ?? 0) >= GATE_CONFIDENCE);
  const llmClarify = matched.filter((r) => r.llm_intent === "clarify");
  return {
    rows: rows.length,
    matched: matched.length,
    missing,
    days,
    byStatus: countBy(rows, (r) => r.status),
    byModel: countBy(rows.filter((r) => r.status === "ok" && r.jev_model !== undefined), (r) => r.jev_model ?? ""),
    thresholds: THRESHOLDS.map((t) => atThreshold(matched, t)),
    byLang,
    costly: { research: confidentResearch.length, missed: confidentResearch.filter((r) => r.jev_intent !== "research").length },
    clarify: { llm: llmClarify.length, matched: llmClarify.filter((r) => r.jev_intent === "clarify").length }
  };
}

export function formatShadowReport(s: ShadowSummary, matchedRows: ShadowRow[]): string {
  if (s.rows === 0) return "No intent_shadow rows yet — is HOUGE_JEV_SHADOW_ENABLED on, and has the daemon been restarted?";
  return [
    `Verdict by language (bar: ≥${pct(PROMOTE_AGREEMENT)} agreement at Jev confidence ≥${GATE_CONFIDENCE}, ≥${pct(PROMOTE_COVERAGE)} coverage, ≥${MIN_MATCHED} matched turns, ≥${MIN_DAYS} days):`,
    ...Object.entries(s.byLang).flatMap(([lang, v]) => [
      `  ${lang}: ${v.verdict} — ${v.reason}`,
      `     rows ${v.rows}, by status ${JSON.stringify(v.byStatus)}, by Jev model ${JSON.stringify(v.byModel)}`
    ]),
    "Promote only the languages marked PROMOTE; the promotion itself is a separate spec.",
    "",
    `Counts: shadowed ${s.rows}, matched ${s.matched}, missing ${s.missing} (shutdown, flag toggled, or failure after the classifier); by status ${JSON.stringify(s.byStatus)}`,
    `Shadowing for ${s.days.toFixed(1)} days.`,
    "",
    "Agreement vs the live classifier by Jev confidence (coverage here = share of matched turns):",
    ...s.thresholds.map((t) => `  ≥${t.t}: slice ${t.slice}, agreement ${pct(t.agreement)}, coverage ${pct(t.coverage)}`),
    "",
    `Costly direction (reported only): the classifier said research on ${s.costly.research} turn(s) where Jev was ≥${GATE_CONFIDENCE} confident; Jev said something else on ${s.costly.missed}.`,
    `Clarify (reported only): the classifier said clarify ${s.clarify.llm} time(s); Jev matched ${s.clarify.matched}.`,
    "",
    "By Jev model:",
    ...Object.entries(s.byModel).map(([model, n]) => `  ${model}: ${n}${model === JEV_MODEL ? "" : " (excluded from the verdict)"}`),
    "",
    ...confusion(matchedRows, (r) => r.llm_intent, "live classifier (gates)"),
    ...confusion(matchedRows, (r) => r.observed_action, "observed action (proxy, never gates)")
  ].join("\n");
}

export function parseShadowReportArgs(argv: string[]): { ok: true; sinceIso?: string } | { ok: false; error: string } {
  if (argv.length === 0) return { ok: true };
  const [flag, value] = argv;
  if (argv.length === 2 && flag === "--since" && value !== undefined && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value))) {
    return { ok: true, sinceIso: new Date(value).toISOString() };
  }
  return { ok: false, error: "Usage: houge jev-shadow report [--since ISO]" };
}
```

- [ ] **Step 5: Wire the CLI.** In `src/cli.ts`, at the top of the `command === "jev-shadow"` branch
  and BEFORE the existing `if (rest[0] !== "replay")` usage check, insert the read-only `report`
  subcommand. It needs no tombstone check, because inspection must survive a kill. Also update the
  usage string in the existing check.

```ts
  if (rest[0] === "report") {
    const { formatShadowReport, isShadowMatched, loadShadowRows, parseShadowReportArgs, summarizeShadow } = await import("./jev/shadow-report.js");
    const args = parseShadowReportArgs(rest.slice(1));
    if (!args.ok) {
      console.error(args.error);
      process.exit(1);
    }
    const store = RunStore.open("houge.sqlite", storeOptions);
    try {
      const rows = loadShadowRows(store, args.sinceIso);
      const first = rows[0]?.occurred_at;
      const last = rows[rows.length - 1]?.occurred_at;
      const missing = first !== undefined && last !== undefined ? store.countClassifiedRunsWithoutShadow(first, last) : 0;
      console.log(formatShadowReport(summarizeShadow(rows, missing, new Date().toISOString(), store.firstIntentShadowAt()), rows.filter(isShadowMatched)));
      process.exitCode = 0;
    } finally {
      store.close();
    }
  } else {
```

Close the added `else` at the end of the existing replay code. The replay path keeps its exact
behaviour inside the `else`. Its usage message becomes:
`Usage: houge jev-shadow replay [--since ISO] [--limit N] [--max-usd USD] [--dry-run] | houge jev-shadow report [--since ISO]`.

- [ ] **Step 6: Run, build, smoke the usage paths**

Run: `npx vitest run tests/jev/ && npm run typecheck && npm run build && node dist/cli.js jev-shadow report --bogus; echo exit=$?`
Expected: tests PASS; the last command prints the report usage line and `exit=1`. Do **not** run
`jev-shadow report` against the real `houge.sqlite` in this task.

- [ ] **Step 7: Full suite, then commit**

```bash
npx vitest run
git add src/jev/replay-report.ts src/jev/shadow-report.ts src/cli.ts tests/jev/shadow-report.test.ts
git commit -m "feat(jev): houge jev-shadow report — PROMOTE/HOLD/KILL per language, costly direction, missingness"
```

---

### Task 6: Live gate script + docs

**Files:**
- Create: `scripts/live-gate-jev-shadow.mjs`
- Modify: `docs/reference/configuration.md` (the "Jev intent shadow" section), `README.md` (the Jev section)

**Interfaces:**
- Consumes: the built `dist/` from Tasks 1–5.

- [ ] **Step 1: Write the gate script** `scripts/live-gate-jev-shadow.mjs`

```js
// Live gate for the Jev LIVE shadow (spec 2026-09-25 + 2026-09-26 amendments). ONE real turn in an
// IN-MEMORY store with the production adapters: the real classifier chain AND the real Jev client.
// PASS requires a completed turn, exactly one intent_shadow row (ok, pinned model, parsed label, no
// message text), and a classify_shadow llm_attempt row priced by the ceiling. Never opens
// houge.sqlite. Needs TYPESAFE_API_KEY in .env; makes 2+ flat-rate CLI calls and one Jev call.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHougeEnv } from "../dist/config/load-env.js";
import { DISARM_FLAGS } from "../dist/config/disarm-posture.js";
import { CoreWorker } from "../dist/core/core-worker.js";
import { buildTypedTaskEvent } from "../dist/domain/types.js";
import { Gateway } from "../dist/gateway/gateway.js";
import { JEV_MODEL } from "../dist/jev/jev-client.js";
import { RunStore } from "../dist/run/run-store.js";

loadHougeEnv();
// Hermetic turn: every optional capability off (the disarm set), episodic/dual-LLM off, shadow ON.
for (const flag of DISARM_FLAGS) process.env[flag] = "false";
process.env.HOUGE_EPISODIC_ENABLED = "false";
process.env.HOUGE_DUAL_LLM_ENABLED = "false";
process.env.HOUGE_JEV_SHADOW_ENABLED = "true";

const MESSAGE = "Say hello in one short sentence.";
const root = mkdtempSync(join(tmpdir(), "houge-gate-jev-shadow-"));
const store = RunStore.openInMemory();
const failures = [];
try {
  const intake = new Gateway(store).intake(buildTypedTaskEvent({
    source: "telegram", type: "turn", program: "turn", goal: MESSAGE,
    requested_by: { kind: "user", id: "gate" }, notify: { kind: "telegram", chat_id: "gate" },
    idempotency_key: `gate:jev-shadow:${Date.now()}`, source_reference: "gate"
  }));
  if (!intake.ok) throw new Error(`intake failed: ${JSON.stringify(intake)}`);
  const t0 = Date.now();
  const result = await new CoreWorker(store, root).executeRun(intake.run_id, "gate");
  console.log(`turn: ${result.status} in ${Date.now() - t0}ms`);
  if (result.status !== "completed") failures.push(`turn did not complete: ${result.status}`);

  const deadline = Date.now() + 10_000;
  let shadow = [];
  while (Date.now() < deadline) {
    shadow = store.getLedgerEvents(intake.run_id).filter((e) => e.event_type === "intent_shadow");
    if (shadow.length > 0) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const p = shadow[0]?.payload;
  console.log("intent_shadow:", JSON.stringify(p));
  if (shadow.length !== 1) failures.push(`expected 1 intent_shadow row, got ${shadow.length}`);
  if (p && p.status !== "ok") failures.push(`shadow status ${p.status} (${p.jev_error ?? "no detail"})`);
  if (p && p.jev_model !== JEV_MODEL) failures.push(`jev_model ${p.jev_model} ≠ pinned ${JEV_MODEL}`);
  if (p && p.llm_parsed !== true) failures.push("classifier label not parsed");
  if (p && JSON.stringify(p).includes("hello in one short sentence")) failures.push("message text leaked into intent_shadow");

  const attempts = store.getLedgerEvents(intake.run_id).filter((e) => e.event_type === "llm_attempt" && e.payload.role === "classify_shadow");
  console.log("classify_shadow attempts:", attempts.map((a) => JSON.stringify(a.payload)).join(" | "));
  if (attempts.length !== 1) failures.push(`expected 1 classify_shadow llm_attempt, got ${attempts.length}`);
  if (attempts[0] && !(attempts[0].payload.cost_usd > 0)) failures.push("classify_shadow attempt has no cost_usd — the ceiling is blind to it");
} finally {
  store.close();
  rmSync(root, { recursive: true, force: true });
}
console.log(failures.length === 0 ? "\nLIVE GATE: PASS" : `\nLIVE GATE: FAIL\n  - ${failures.join("\n  - ")}`);
process.exit(failures.length === 0 ? 0 : 1);
```

- [ ] **Step 2: Syntax-check only.** Run
  `npm run build && node --check scripts/live-gate-jev-shadow.mjs`, and confirm that every `../dist/…`
  import path exists. **Do not run the gate.** It is an operator step (Task 7) that needs the real
  key and makes real calls.

- [ ] **Step 3: Docs.** In `docs/reference/configuration.md`, section "Jev intent shadow — replay
  (spec 2026-09-25)":
  - Rename the section to "Jev intent shadow — replay and live shadow (spec 2026-09-25)".
  - Replace the final paragraph ("The **live shadow** … is specified but not yet built.") with this
    subsection:

```markdown
**Live shadow** (flag-gated, default OFF). With `HOUGE_JEV_SHADOW_ENABLED` on, every real
`classifyIntent` also asks Jev the same question, **concurrently and never awaited**: the turn uses
the classifier's label exactly as before, and Jev's answer is written to the ledger only (one
`intent_shadow` row per classified turn: `status`, the classifier's raw `llm_intent`, `llm_parsed`,
`lang`, Jev's label/confidence/model/latency or a code-owned `jev_error` — never message text). The
Jev call is audited as `llm_attempt` role `classify_shadow` (5 s timeout, no retries, metered fuse);
a dead key opens an `llm_leg_failing` incident for subject `jev`. `/disarm` turns it off (the flag
is in `DISARM_FLAGS` and read per turn).

```bash
houge jev-shadow report                    # PROMOTE / HOLD / KILL per language
houge jev-shadow report --since 2026-10-01T00:00:00Z   # narrows the evaluated rows; tenure still counts from the first shadow row
node scripts/live-gate-jev-shadow.mjs      # opt-in: one real turn in memory, real classifier + real Jev
```

The verdict per language is HOLD until ≥ 60 matched turns and ≥ 28 days since the first shadow row,
then PROMOTE only if Jev agrees with the classifier ≥ 90% at confidence ≥ 0.7 on ≥ 60% of that
language's turns (else KILL). The report also prints the costly direction (Jev overruling a
`research` call) and clarify agreement, which never gate. Promotion itself is a separate spec.
```

  - Add a row to that section's variable table:

```markdown
| `HOUGE_JEV_SHADOW_ENABLED` | off | Arms the live intent shadow. Accepts 1/true/yes/on; read per turn; in `DISARM_FLAGS`. On without `TYPESAFE_API_KEY` → one boot warning and the shadow stays off. |
```

  In `README.md`, section "Jev intent shadow — replay", replace the sentence beginning "Next: the
  live shadow beside every real classification" with:
  "The live shadow runs beside every real classification when `HOUGE_JEV_SHADOW_ENABLED` is on (never
  awaited, advisory only). `houge jev-shadow report` gives the per-language PROMOTE / HOLD / KILL
  verdict once four weeks and 60 matched turns have accrued; promotion is a separate decision."

- [ ] **Step 4: Full suite, then commit**

```bash
npx vitest run
git add scripts/live-gate-jev-shadow.mjs docs/reference/configuration.md README.md
git commit -m "docs(jev): live shadow — flag, report, live gate script"
```

---

### Task 7: Reviews, live gate, rollout (operator steps — no new code)

- [ ] **Step 1: Whole-branch review.**
  - Run the final Opus whole-branch review.
  - Run the **mandatory Codex whole-diff pass**: `codex exec -s read-only …` with
    "run git diff feat/jev-replay..HEAD", `</dev/null`.
  - Verify every finding first-hand, and fix confirmed ones TDD-style in one fix wave with one scoped
    re-review.
- [ ] **Step 2: Live gate.** `npm run build && node scripts/live-gate-jev-shadow.mjs`, run from the
  main checkout so it picks up `.env` (the key is already there). Expected: `LIVE GATE: PASS`.
- [ ] **Step 3: PR.** Push `feat/jev-live-shadow` and open a PR with base `feat/jev-replay`, stacked
  on PR #1. After #1 merges, GitHub retargets it to `main`.
- [ ] **Step 4: Arm (Paco's actions, after both PRs merge).**
  - Add `HOUGE_JEV_SHADOW_ENABLED=true` to the mini's `.env`.
  - `npm run build` in the main checkout, then kickstart the daemon (fish:
    `launchctl kickstart -k gui/(id -u)/com.houge.daemon`).
  - After the next real Telegram message, check:
    `sqlite3 houge.sqlite "SELECT occurred_at, json_extract(payload_json,'$.status'), json_extract(payload_json,'$.jev_intent'), json_extract(payload_json,'$.llm_intent') FROM ledger_events WHERE event_type='intent_shadow' ORDER BY occurred_at DESC LIMIT 3"`.
- [ ] **Step 5: Verdict.** After ≥ 28 days and ≥ 60 matched turns (about 6 weeks at the current
  ~1.5 turns/day), run `houge jev-shadow report`. For each language marked PROMOTE, open a promotion
  spec, which must keep "never overrule a research call from the LLM".
- [ ] **Step 6: Docs sync** at ship: spec status line, `tasks/todo.md`, `sessions.md`, `docs/ROADMAP.md` item 8.

---

## Codex plan review (2026-09-26) — findings and disposition

`codex exec -s read-only` over this plan + the spec amendments, before any code. Every finding was
verified first-hand against the live code before it was folded in.

| # | Sev | Finding | Verified | Disposition |
|---|---|---|---|---|
| 1 | BLOCKER | The shadow started before `CapabilityRunner.execute`, so a classifier the runner denies (budget, contract) still sends the message to Jev and pays for it | `capability-runner.ts` has three `denied` returns before `executeAdapter` | Task 4: the shadow starts inside the `llm_answer` adapter's `execute`, after admission; a holder object carries the promise out. New test: a denied classifier → Jev never called, no row |
| 2 | BLOCKER | `validateResponse` accepts any string as `model`; the shadow writes it as `jev_model`, so echoed prose could enter the ledger | `jev-client.ts` line 140 — `typeof b.model !== "string"` only; the audit already writes `a.result.model` | Task 1: `JEV_MODEL_ID` (bounded token) → `model_invalid`, a parse failure. New test with prose in `model`: rejected by name, nothing echoed in the audit |
| 3 | BLOCKER | `--since` filtered the rows, then the 28 days were measured from the first *filtered* row — amendment 9 says the first shadow row | Plan `summarizeShadow` used `rows[0]`; the CLI passed `args.sinceIso` to `loadShadowRows` | Task 3: `firstIntentShadowAt()`. Task 5: `summarizeShadow(…, campaignStartIso)`; `--since` narrows the evaluated rows and the missingness window only. New test: old campaign + recent rows → not a tenure HOLD |
| 4 | BLOCKER | `runJevShadow` awaited the call with no deadline; its own test expected a never-settling call to leave no row, contradicting the 5 s hard timeout and "a row for every eligible turn" | The client's abort timer covers HTTP only; an injected or wedged call had no backstop | Task 2: `withDeadline` (6 s, `unref`'d, cleared on settle) → `status: "timeout"`. New fake-timer test. The core-worker test keeps "the turn never waits" and points at the unit test for the row |
| 5 | RISK | Status and model counts were global; the design asks for missingness by language and model | Plan `ShadowSummary.byStatus`/`byModel` only | Task 5: `LangSummary.byStatus`/`byModel`, printed under each language's verdict; a model appears only for `ok` rows. New test |
| 6 | NIT | `loadShadowRows` runs `runLoopCapabilities` once per row | True; same pattern as `replay.ts` | Accepted as-is: hundreds of rows over the campaign, in-process SQLite, read-only CLI. A comment says so |

---

## Final reviews (2026-09-28) — findings and disposition

Whole-branch review (Fable, most capable model) over `d29708c..e43f11f` plus the mandatory Codex
whole-diff pass (`codex exec -s read-only`, reasoning high). Both verified first-hand.

| # | Source | Sev | Finding | Verified | Disposition |
|---|---|---|---|---|---|
| F1 | Fable | Important | The report counts schedule-fired turns in the verdict; the spec's replay result says they must not count but no amendment recorded it, so the plan built a source-blind report | Spec L373–376; `runs.source = 'schedule'` for fires (`schedule-tick.ts`); `ShadowRow` has no source | Fix wave: `runSource(run_id)` store read; `ShadowRow.source`; verdict, agreement, coverage and missingness over non-`schedule` rows; by-source counts printed. Spec amendment 13. Test: 40 scheduled rows at 100% must not flip a KILL |
| F2 | Codex | P1 | `llm_leg_failing` needs ≥ 3 failures and zero `ok` inside 24 h; at ~1.5 turns/day a dead Jev key never alerts, contradicting the spec's "same day" | `LLM_LEG_FAILING_MIN_ATTEMPTS = 3`, window 24 h (`invariant-sweep.ts:62-63`); `HAVING attempts >= ? AND ok = 0` (`run-store.ts:4018`) | Fix wave: HAVING becomes `ok = 0 AND (attempts >= ? OR last_error_kind = 'auth')` for every provider — an auth rejection is deterministic. Spec amendment 14. Test: one `classify_shadow` auth failure → incident; a later `ok` clears it; `classify_replay*` auth rows still ignored |
| M2 | Fable | Minor | Hermetic test spies `fetch` without a stub; a guard regression would hit the network before the assertion | `core-worker-jev-shadow.test.ts` | Fix wave: `mockRejectedValue` |
| M4 | Fable | Minor | "No intent_shadow rows yet" also prints when `--since` is past the last row | `shadow-report.ts:126` | Fix wave: say "no rows since <since>" when the campaign has started |
| M5 | Fable | Minor | configuration.md's dead-key sentence implied same-day detection | — | Fix wave: "at the next sweep (12 h cadence)"; true once F2 lands |
| M3 | Fable | Minor | Never-settles test leaves an unref'd 6 s deadline | plan-as-written | Deferred; noted in the ledger |
| M6 | Fable | Minor | Missingness window bounded by shadow-row times can miss the last pre-shutdown turn by ~6 s | real, immaterial | Deferred |

Ledger triage: every per-task deferred minor and the one parked ruling (gate-script `throw`) were
judged not-before-merge by the final reviewer; the ruling stands.
