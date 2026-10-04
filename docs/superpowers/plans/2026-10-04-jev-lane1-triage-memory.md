# Jev System One — Lane 1 (triage → memory + status) Implementation Plan

**Rev 5 (2026-10-04, final)** — Codex's confirmation on Rev 4 (5 closed, 3 exact sentences) applied: `settleTriage` owns the act writes too (called from inside `inTx`); the retained answered rows settle distill/reconcile/rollback failures as answered `fallback`; Task 3's armed check is lane-specific; Task 9's broker test uses its local `jevSays` body. Plan review gate closed.

**Rev 4 (2026-10-04)** — Codex's confirmation pass on Rev 3 (8 sentences) applied: one `settleTriage` finaliser in Task 9 with per-stage failure tests; skipped rows persisted by the caller after the cancellation check (Task 5); Task 8 tests assert one exact terminal outcome per injected failure; Task 10 labels only a genuinely new run and catches the unknown-run lookup; the quoted-literal rule is opaque-only with a prose negative and the nine-digit rule documented (Task 2); `readFileSync` import, lane-specific arming (`status` needs only the `lane` row), CLI passes permuted rows + measured shadow stats into the report (Tasks 3/11/12); Task 13 replaces the retained script lines explicitly and forces the second call through the real `lesson_write` tool path; Task 9 gains the fake-broker test via an `ompWorker` `broker` option.

**Rev 3 (2026-10-04)** — Codex's scoped re-pass on Rev 2 (7 remaining items, exact sentences) applied: §7/§9 committed flag and one outer finaliser, §8 `finishLane` ordering with `finally`, §9 cancellation checks before every write, §10 atomic override creation, §2 sanitiser shapes + CJK negatives, §3/§11/§13 arming sequence, §13 forced second `lesson_write` probe.

**Rev 2 (2026-10-04)** — both plan reviews folded in (Codex: 11 blockers / 7 risks / 2 nits; senior live-probe: 3 blockers / 11 warnings / 8 suggestions; see the Review record at the end). Tasks 2, 3, 5, 7–14 were rewritten; where a Rev 2 task says "as Rev 1", the Rev 1 text is retained beneath it for the code blocks it points at.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pure memory instruction or a status question from Paco is answered by code (a saved lesson with an Undo card, or the `houge_status` text) after one ~0.3 s Jev call, without an Opus planner turn; everything else, and every Jev failure, takes today's path exactly — and every decision leaves a replayable row.

**Architecture:** A small generic layer (`src/jev/questions/`, `decide.ts`, `thresholds.ts`, table `jev_decisions`) sits in front of the omp planner at two slots in `PlannerSupervisor` (a bare-ack nudge in `submit()`, triage in `startTurn()`). `CoreWorker.triageTurn` owns the decision: flag → posture → modality → Jev → thresholds → lane. The memory lane reuses the existing distill → reconcile → save pipeline through an extracted `runLessonWrite` service shared with the `lesson_write` loop tool, with an adapter-level already-saved guard and a recorded `lesson_changes` set for Undo. `finishSuccess` stays the only turn terminal; cards ride the existing final-report notification with buttons. A replay harness + labelling CLI produce the calibration evidence before anything is armed.

**Tech Stack:** Node ≥ 22 (`node:sqlite`, `node:crypto`), TypeScript strict, vitest (hermetic: real in-memory SQLite, stubbed `fetch`, fake omp session). Zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-04-jev-system-one-design.md` (Rev 5, §3 and §5; §4 invariants). ADR: `docs/decisions/0029-jev-system-one.md`. Seam facts gathered 2026-10-04 against `main@8f2c333` are quoted inline; when the code and this plan disagree, read the code, fix the plan line, and say so in the task report.

## Global Constraints

- `dependencies: {}` stays empty (ADR 0001/0016). Node stdlib + devDeps only.
- Protected surface untouched by any self-write; this plan is Claude-orchestrated on `main` (AGENTS.md): `src/policy/`, `docs/decisions/` edits are docs sync by Claude, approved by Paco.
- Functions under 50 lines (reviewers enforce it). Match surrounding style; comments at the density of the file.
- Every new ledger event type gets a `requiredPayloadFields` entry (`src/run/run-ledger.ts`, `as const satisfies Record<LedgerEventType, readonly string[]>`), or the build fails. Payloads carry ids, enums, numbers only — **never message text, never provider `detail` strings**.
- Jev state egress stays inside the 2026-09-25 approval: Paco's text + recent thread, `MAX_LATEST_MESSAGE_CHARS = 8_000`, `MAX_REQUEST_CHARS = 24_000`, skip never truncate; redacted through the broker; no `trusted_extract` material.
- Jev never produces allow/deny; the only effects a Jev answer may have in this slice are: save a lesson through the full existing gates, answer status from code, or nothing (today's path).
- Live paths: `retries: 0`, `timeoutMs: 1_500`; `meteredBreached` checked before every attempt (unchanged client behaviour).
- Flags default **off**: `HOUGE_JEV_ENABLED` (master, in `DISARM_FLAGS`), `HOUGE_JEV_TRIAGE_ENABLED=off|shadow|arm`. Thresholds: `HOUGE_JEV_TRIAGE_MIN_CONF` (0.7), `HOUGE_JEV_TRIAGE_MIN_PURE` (0.8), `HOUGE_JEV_TRIAGE_MIN_STATUS` (0.8); memory bar also `p(memory) ≥ 0.85` and `p(memory) − p(none) ≥ 0.5` (constants in code, named).
- Tests live in `tests/<area>/` mirroring `src/`; each test says why the behaviour matters. The test setup must never reach the real Jev endpoint: `tests/helpers/setup-no-real-omp.ts` deletes `TYPESAFE_API_KEY` (Task 1) so an un-stubbed call is `no_key`.
- Commands: `npm run typecheck && npm test && npm run build`. Single file: `npx vitest run tests/<path>.test.ts`. Commit per task, stage by name, Conventional Commits, trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Repo is public: no personal text in fixtures; use neutral strings ("以后回复短一点", "did you restart?").

---

## File map

| File | Responsibility | Task |
|---|---|---|
| `src/llm/audit.ts` | `LlmErrorKind` + `rate_limited`, `overloaded`, `malformed_question` | 1 |
| `src/jev/jev-client.ts` | HTTP status → error-kind mapping (422/429/529) | 1 |
| `src/jev/jev-incidents.ts` (new) | first-failure alerted incidents for Jev outages | 1 |
| `src/run/run-store.ts` | `LlmCallRole` + `triage`; `findFailingLlmLegs` ignores `jev`; migrations `jev_decisions`, `lesson_changes`; `unpruneLesson`; lesson-change insert/undo; `insertJevDecision`/`markJevDecision`; `triageOverrideFor`; `countRecentLedgerEvents`; `userTurnTextForRun`; `LessonSource` + `lane` | 1, 4 |
| `src/run/run-ledger.ts` | event types `triage`, `ack_nudged`, `lesson_saved`, `lesson_change_undone`, `triage_override` | 4 |
| `src/jev/questions/types.ts` (new) | `Question`, `toJevQuestion`, `criteriaHash` (no model in the hash) | 2 |
| `src/jev/egress-redact.ts` (new) | `sanitizeJevText`: broker redact + credential-shape stripping, one seam for live and replay | 2 |
| `src/jev/calibration.ts` (new) | `CALIBRATED_ROWS` (empty at ship) + `calibratedLang` | 3 |
| `src/jev/questions/triage.ts` (new) | the three frozen triage questions + `buildTriageState` | 2 |
| `src/jev/thresholds.ts` (new) | threshold table keyed by `(question, hash, model, lang)`, env overrides, `triageVerdict` | 3 |
| `src/jev/decide.ts` (new) | `decide()`: request, call, validate, rows, skip reasons | 5 |
| `src/jev/jev-flags.ts` (new) | `resolveJevEnabled`, `resolveJevTriageMode`, disarm marker | 6 |
| `src/config/disarm-posture.ts` | `HOUGE_JEV_ENABLED` in `DISARM_FLAGS` | 6 |
| `src/capabilities/lesson-write.ts` | `alreadySaved` guard | 7 |
| `src/core/core-worker.ts` | `runLessonWrite` service, reconcile/save split, `triageTurn`, Jev client, `ompComplete` buttons, `resolveOmpMessage` modality, `TriageOutcome` | 7, 9 |
| `src/omp/planner-supervisor.ts` | slot A (`submit` ack nudge), slot B (`triage` dep, warm spawn, lane finish), `TurnRequest.skipTriage`, `TurnOutcomeSink.complete.buttons` | 8 |
| `src/omp/bare-ack.ts` (new) | `isBareAck` | 8 |
| `src/core/memory-lane-card.ts` (new) | card text + buttons | 9 |
| `src/triggers/telegram-command-parser.ts`, `telegram-trigger-adapter.ts`, `src/domain/types.ts`, `src/gateway/gateway.ts`, `src/gateway/memlane-commands.ts` (new) | `memlane:undo:*` / `memlane:ask:*` callbacks → events → handlers | 10 |
| `src/jev/replay-core.ts` (new), `src/jev/triage-replay.ts` (new), `src/jev/wilson.ts` (new), `src/jev/triage-report.ts` (new) | generic replay, lane 1 replay, Wilson bound, per-class report | 11 |
| `src/cli.ts`, `src/jev/triage-label.ts` (new) | `houge jev replay triage`, `houge jev label triage`, `houge jev report triage` | 12 |
| `scripts/live-gate-jev-triage.mjs` (new) | live gate | 13 |
| `docs/reference/configuration.md`, `README.md`, ADR 0013/0014/0019/0029, `tasks/todo.md`, `tasks/lessons.md`, `sessions.md`, `docs/reference/jev-decision-layer.md` (new) | docs sync | 14 |

Task order is dependency order. Tasks 2, 3 and 6 are independent of each other and of 4; a parallel executor may run them together after Task 1.

---

### Task 1: Error kinds, client status mapping, `triage` audit role, Jev incidents, sweep exclusion

**Files:**
- Modify: `src/llm/audit.ts:25-29` (`LlmErrorKind`)
- Modify: `src/jev/jev-client.ts:110-120` (`attemptOnce` status mapping)
- Create: `src/jev/jev-incidents.ts`
- Modify: `src/run/run-store.ts:50-68` (`LlmCallRole`), `:4717-4743` (`findFailingLlmLegs`)
- Modify: `tests/helpers/setup-no-real-omp.ts` (delete `TYPESAFE_API_KEY`)
- Test: `tests/jev/jev-client.test.ts` (extend), `tests/jev/jev-incidents.test.ts` (new), `tests/run/invariant-sweep-llm.test.ts` (extend)

**Interfaces:**
- Produces: `LlmErrorKind` gains `"rate_limited" | "overloaded" | "malformed_question"`. `JevResult` failure rows carry them in `error_kind`. `LlmCallRole` gains `"triage"`. `export function jevIncidentKind(r: Extract<JevResult, { ok: false }>): JevIncidentKind | undefined` and `export function openJevIncident(store: RunStore, r: Extract<JevResult, { ok: false }>, detail: Record<string, unknown>): void` from `src/jev/jev-incidents.ts`, where `export type JevIncidentKind = "jev_auth" | "jev_rate_limited" | "jev_overloaded" | "jev_question_invalid" | "jev_no_key"`.

- [ ] **Step 1: Write the failing client-mapping tests**

Append to `tests/jev/jev-client.test.ts` (reuse the file's `json`, `client`, `okBody` helpers):

```ts
describe("status → error kind (spec §3.3: outages are distinguishable, 422 is a code bug)", () => {
  it("maps 429 to rate_limited and retries only when retries > 0", async () => {
    const fetchImpl = vi.fn(async () => json(429, { error: "slow down" }, { "retry-after": "1" }));
    const { call, audit } = client(fetchImpl as unknown as typeof fetch);
    const r = await call({ state: {}, questions: { q: { type: "choice", instructions: "x", criteria: { a: "a", b: "b" } } } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error_kind).toBe("rate_limited");
    expect(fetchImpl).toHaveBeenCalledTimes(1); // retries: 0 on live paths
    expect(audit.attempts.at(-1)?.error_kind).toBe("rate_limited");
  });
  it("maps 529 to overloaded (retryable) and 500 to transport", async () => {
    const r529 = await client(vi.fn(async () => json(529, {})) as unknown as typeof fetch).call({ state: {}, questions: { q: { type: "choice", instructions: "x", criteria: { a: "a", b: "b" } } } });
    const r500 = await client(vi.fn(async () => json(500, {})) as unknown as typeof fetch).call({ state: {}, questions: { q: { type: "choice", instructions: "x", criteria: { a: "a", b: "b" } } } });
    expect(!r529.ok && r529.error_kind).toBe("overloaded");
    expect(!r500.ok && r500.error_kind).toBe("transport");
  });
  it("maps 422 to malformed_question and never retries it even with retries: 3", async () => {
    const fetchImpl = vi.fn(async () => json(422, { error: { field: "questions.q.criteria" } }));
    const { call } = client(fetchImpl as unknown as typeof fetch, { retries: 3 });
    const r = await call({ state: {}, questions: { q: { type: "choice", instructions: "x", criteria: { a: "a", b: "b" } } } });
    expect(!r.ok && r.error_kind).toBe("malformed_question");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // the body may echo our own question text or a provider message: never copied into detail
    expect(!r.ok && r.detail).toBe("HTTP 422");
  });
});
```

Check the helper's audit shape first: `recordingSink()` in `tests/helpers/llm-audit.ts` — use whatever array it exposes (the dossier names it `audit.attempts`; if it is `audit.rows`, use that).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/jev/jev-client.test.ts`
Expected: FAIL — `error_kind` is `"transport"` for 429/529 and `"other"` for 422.

- [ ] **Step 3: Add the error kinds and the mapping**

`src/llm/audit.ts`:

```ts
export type LlmErrorKind =
  | "auth" | "model_missing" | "timeout" | "spawn" | "transport" | "parse" | "other"
  | "quota" | "model_refusal" | "aborted" | "wall_collapse"
  | "shutdown"
  // Jev (ADR 0029 §3.3): outages are told apart so each opens its own incident; 422 is a question bug, never retried.
  | "rate_limited" | "overloaded" | "malformed_question";
```

`src/jev/jev-client.ts`, replace the status block in `attemptOnce` (today: 401/403 → auth; `429 || >= 500` → transport):

```ts
    if (res.status === 401 || res.status === 403) {
      return { kind: "fail", outcome: "unavailable", error_kind: "auth", retryable: false, detail: `HTTP ${res.status}` };
    }
    // 422 names a malformed question: a code bug on our side, so it is never retried (spec §3.3).
    if (res.status === 422) {
      return { kind: "fail", outcome: "error", error_kind: "malformed_question", retryable: false, detail: "HTTP 422" };
    }
    if (res.status === 429 || res.status === 529 || res.status >= 500) {
      const after = Number(res.headers.get("retry-after"));
      const error_kind: LlmErrorKind = res.status === 429 ? "rate_limited" : res.status === 529 ? "overloaded" : "transport";
      return {
        kind: "fail", outcome: "error", error_kind, retryable: true, detail: `HTTP ${res.status}`,
        ...(Number.isFinite(after) && after > 0 ? { retryAfterMs: Math.min(after * 1000, RETRY_AFTER_CAP_MS) } : {})
      };
    }
```

Run typecheck; if any exhaustive `switch` over `LlmErrorKind` breaks (search `case "wall_collapse"`), add the three kinds to the same branch as `transport` (`rate_limited`, `overloaded`) and `other` (`malformed_question`).

- [ ] **Step 4: Run the client tests**

Run: `npx vitest run tests/jev/jev-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing incident tests**

Create `tests/jev/jev-incidents.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { RunStore } from "../../src/run/run-store.js";
import { jevIncidentKind, openJevIncident } from "../../src/jev/jev-incidents.js";

// Spec §3.3: every Jev outage class reaches Paco as an alerted incident on the FIRST failure;
// a second identical failure must not page again (fingerprint dedupe in openAlertedIncident).
describe("jev incidents", () => {
  it("maps each failure class to its own kind", () => {
    expect(jevIncidentKind({ ok: false, reason: "no_key", detail: "", error_kind: "auth" })).toBe("jev_no_key");
    expect(jevIncidentKind({ ok: false, reason: "auth", detail: "HTTP 401", error_kind: "auth" })).toBe("jev_auth");
    expect(jevIncidentKind({ ok: false, reason: "error", detail: "HTTP 429", error_kind: "rate_limited" })).toBe("jev_rate_limited");
    expect(jevIncidentKind({ ok: false, reason: "error", detail: "HTTP 529", error_kind: "overloaded" })).toBe("jev_overloaded");
    expect(jevIncidentKind({ ok: false, reason: "error", detail: "HTTP 422", error_kind: "malformed_question" })).toBe("jev_question_invalid");
    // fused rides ADR 0019's own alert; timeout/parse/transport are per-call noise, not outages
    expect(jevIncidentKind({ ok: false, reason: "fused", detail: "" })).toBeUndefined();
    expect(jevIncidentKind({ ok: false, reason: "error", detail: "", error_kind: "timeout" })).toBeUndefined();
  });
  it("opens one incident per kind and does not re-page while it is open", () => {
    const store = RunStore.openInMemory();
    const r = { ok: false as const, reason: "error" as const, detail: "HTTP 429", error_kind: "rate_limited" as const };
    openJevIncident(store, r, { point: "triage", question_id: null });
    openJevIncident(store, r, { point: "triage", question_id: null });
    const open = store.listOpenIncidents().filter((i) => i.kind === "jev_rate_limited");
    expect(open).toHaveLength(1);
    expect(open[0]?.subject).toBe("jev");
    store.close();
  });
});
```

If `listOpenIncidents` is not the store's name, use the incidents reader `tests/run/incidents-store.test.ts` uses.

- [ ] **Step 6: Run to verify they fail**

Run: `npx vitest run tests/jev/jev-incidents.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7: Create `src/jev/jev-incidents.ts`**

```ts
import { openAlertedIncident } from "../run/incident-alert.js";
import type { RunStore } from "../run/run-store.js";
import type { JevResult } from "./jev-client.js";

/** Jev outage classes (ADR 0029 §3.3). The FIRST failure opens an alerted incident; dedupe/flap damping is openAlertedIncident's. */
export type JevIncidentKind = "jev_auth" | "jev_rate_limited" | "jev_overloaded" | "jev_question_invalid" | "jev_no_key";
export const JEV_INCIDENT_SUBJECT = "jev";

type JevFailure = Extract<JevResult, { ok: false }>;

export function jevIncidentKind(r: JevFailure): JevIncidentKind | undefined {
  if (r.reason === "no_key") return "jev_no_key";
  if (r.reason === "auth") return "jev_auth";
  if (r.reason === "fused") return undefined; // the metered-fuse latch already alerted (ADR 0019)
  switch (r.error_kind) {
    case "rate_limited": return "jev_rate_limited";
    case "overloaded": return "jev_overloaded";
    case "malformed_question": return "jev_question_invalid";
    default: return undefined; // timeout / parse / transport: per-call noise, visible in the decision rows
  }
}

/** Never puts `detail` (which may echo provider text) into the incident; only enums and ids. */
export function openJevIncident(store: RunStore, r: JevFailure, detail: Record<string, unknown>): void {
  const kind = jevIncidentKind(r);
  if (!kind) return;
  openAlertedIncident(store, { kind, subject: JEV_INCIDENT_SUBJECT, detail: { ...detail, error_kind: r.error_kind ?? null, reason: r.reason } });
}
```

- [ ] **Step 8: Add the `triage` role and the sweep exclusion**

`src/run/run-store.ts:50-68`: add `| "triage"` to `LlmCallRole` (comment: `// Jev decision points (ADR 0029): one role per point so the per-point rate is readable in llm_attempt`).

`findFailingLlmLegs` (`:4717-4743`): add `AND json_extract(payload_json, '$.provider') <> 'jev'` to both the outer `WHERE` and the subquery, with the comment `-- Jev has its own incidents (jev_*); never double-page through llm_leg_failing (ADR 0029 §3.3)`.

Test, append to `tests/run/invariant-sweep-llm.test.ts` (find the existing test that seeds failing `llm_attempt` rows and copy its seeding helper):

```ts
it("ignores provider 'jev' rows: Jev outages page through their own incidents (ADR 0029 §3.3)", () => {
  const store = RunStore.openInMemory();
  const sink = store.llmAuditSink({ correlation_id: "t", role: "triage" });
  for (let i = 0; i < 4; i++) sink.record({ provider: "jev", role: "", outcome: "error", error_kind: "rate_limited", latency_ms: 1 });
  expect(store.findFailingLlmLegs(new Date().toISOString(), 24 * 3600_000, 3).map((l) => l.subject)).not.toContain("jev");
  store.close();
});
```

`findFailingLlmLegs(nowIso, windowMs, minAttempts)` (`run-store.ts:4717`).

- [ ] **Step 9: Make the test setup Jev-safe**

`tests/helpers/setup-no-real-omp.ts`: add `delete process.env.TYPESAFE_API_KEY;` next to the omp pins with the comment `// Jev (ADR 0029): no suite may reach api.typesafe.ai; an un-stubbed client must see no_key.`

- [ ] **Step 10: Run the three files, then typecheck**

Run: `npx vitest run tests/jev/jev-client.test.ts tests/jev/jev-incidents.test.ts tests/run/invariant-sweep-llm.test.ts && npm run typecheck`
Expected: PASS, typecheck 0.

- [ ] **Step 11: Commit**

```bash
git add src/llm/audit.ts src/jev/jev-client.ts src/jev/jev-incidents.ts src/run/run-store.ts tests/helpers/setup-no-real-omp.ts tests/jev/jev-client.test.ts tests/jev/jev-incidents.test.ts tests/run/invariant-sweep-llm.test.ts
git commit -m "feat(jev): distinct outage kinds, first-failure incidents, triage audit role"
```

---

### Task 2: Question library — `Question`, ordered `criteriaHash`, egress sanitiser, the three triage questions, `buildTriageState`

**Files:**
- Create: `src/jev/questions/types.ts`, `src/jev/egress-redact.ts`, `src/jev/questions/triage.ts`
- Test: `tests/jev/questions.test.ts`, `tests/jev/egress-redact.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // types.ts
  export interface Question { id: string; type: "choice"; instructions: string; criteria: ReadonlyArray<readonly [string, string]>; }
  export function toJevQuestion(q: Question): JevChoiceQuestion;      // criteria object in the listed order
  export function criteriaHash(q: Question): string;                  // sha256 hex of {type, instructions, criteria:[[opt,text]…]} — the MODEL is a separate key (spec §3.1/§3.5)
  export function optionsOf(q: Question): string[];
  // egress-redact.ts  (spec §4.5: broker redact + credential-shape stripping; one deterministic seam for live and replay)
  export function sanitizeJevText(text: string, brokerRedact?: (s: string) => string): string;
  // triage.ts
  export const TRIAGE_LANE: Question; export const TRIAGE_COMPLETE: Question; export const TRIAGE_SCOPE: Question; export const TRIAGE_QUESTIONS: readonly Question[];
  export type LastHougeTurn = { kind: "clarify" | "answer"; age_s: number } | null;
  export function lastHougeTurnOf(recent: ChatTurnRow[], nowMs: number): LastHougeTurn;   // ONE rule, used live and in the replay (state_hash must join)
  export interface TriageStateInput { userText: string; recentTurns: ChatTurnRow[]; turnChars: number; modality: TurnModality; lastHougeTurn: LastHougeTurn; }
  export type TriageStateResult = { ok: true; state: Record<string, unknown>; chars: number } | { ok: false; skip: "state_too_large" };
  export function buildTriageState(i: TriageStateInput, brokerRedact?: (s: string) => string): TriageStateResult;  // applies sanitizeJevText to every text field
  ```
  `pending` and `last_turn_tools` from spec §5.2 are **not** in slice 1: no question reads them, and the replay cannot reconstruct `rating_ask`, so including them would make `state_hash` never join (review finding). Re-add with the first question that needs them.

- [ ] **Step 1: Write the failing tests**

Create `tests/jev/egress-redact.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { sanitizeJevText } from "../../src/jev/egress-redact.js";

// Spec §4.5: nothing credential-shaped leaves for TypeSafe, broker or no broker; Paco's words otherwise untouched.
describe("sanitizeJevText", () => {
  it("strips bearer tokens, known key prefixes and long opaque tokens", () => {
    expect(sanitizeJevText("use Authorization: Bearer abc.def-123 please")).toBe("use Authorization: Bearer <token> please");
    expect(sanitizeJevText("key ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 and sk-abcdefghijklmnopqrstuvwxyz0123 and AKIAIOSFODNN7EXAMPLE")).toBe("key <token> and <token> and <token>");
    expect(sanitizeJevText("hash 0123456789abcdef0123456789abcdef0123")).toBe("hash <token>");
  });
  it("replaces URLs, home paths, heredocs, long quoted literals, OTP-shaped codes and every chat/user id form", () => {
    expect(sanitizeJevText("see https://example.com/a?b=c and /Users/paco/x and -1001234567890 and 987654321")).toBe("see <url> and ~/x and <id> and <id>");
    expect(sanitizeJevText("run cat <<'EOF'\nsecret stuff\nEOF\nthen")).toBe("run cat <heredoc>\nthen");
    expect(sanitizeJevText(`echo "${"a".repeat(45)}"`)).toBe("echo <literal>");
    expect(sanitizeJevText("your code is 482913 ok")).toBe("your code is <code> ok");
  });
  it("leaves ordinary Chinese and English prose, punctuation, dates, years and short numbers alone", () => {
    const zh = "明天 9am，预算 3500，电话 0412 不要存。以后回复请短一点，不要用敬语；如果我没说清楚就先问我一句，不要猜。2026 年 10 月 4 日。";
    expect(sanitizeJevText(zh)).toBe(zh);
    const en = "From now on keep replies under three sentences unless I ask for detail; it's 2026-10-04 and the budget is 3,500.";
    expect(sanitizeJevText(en)).toBe(en);
    // the 40+ opaque-token rule must not eat a long plain word; if it does, require at least one digit or symbol in the token class
    expect(sanitizeJevText("Pneumonoultramicroscopicsilicovolcanoconiosis is a long word")).toBe("Pneumonoultramicroscopicsilicovolcanoconiosis is a long word");
    const quoted = 'he said "from now on please keep every answer short and skip the greeting" and left';
    expect(sanitizeJevText(quoted)).toBe(quoted); // long quoted PROSE stays; only opaque 40+ char quoted tokens are literals
  });
  it("documents the accepted false positive: a standalone 9+ digit number (a phone, an order number) is treated as an id", () => {
    expect(sanitizeJevText("order 123456789 shipped")).toBe("order <id> shipped");
  });
  it("applies the broker redactor first, then the shapes", () => {
    expect(sanitizeJevText("secret VALUE123 and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345", (s) => s.replace("VALUE123", "<redacted>"))).toBe("secret <redacted> and <token>");
  });
});
```

Create `tests/jev/questions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { criteriaHash, optionsOf, toJevQuestion, type Question } from "../../src/jev/questions/types.js";
import { TRIAGE_COMPLETE, TRIAGE_LANE, TRIAGE_QUESTIONS, TRIAGE_SCOPE, buildTriageState, lastHougeTurnOf } from "../../src/jev/questions/triage.js";
import { MAX_LATEST_MESSAGE_CHARS } from "../../src/jev/intent-question.js";

const q = (criteria: ReadonlyArray<readonly [string, string]>): Question => ({ id: "t", type: "choice", instructions: "pick", criteria });
const turn = (role: "user" | "assistant", text: string, created_at = "2026-10-04T00:00:00.000Z", intent: string | null = null) =>
  ({ turn_id: "t", chat_id: "c", run_id: "r", role, text, intent, created_at });

describe("criteriaHash (spec §3.1: option ORDER is a calibration variable; the model is a separate key)", () => {
  it("changes when options are reordered or a word changes; does not depend on the model", () => {
    const a = criteriaHash(q([["none", "n"], ["memory", "m"]]));
    expect(a).not.toBe(criteriaHash(q([["memory", "m"], ["none", "n"]])));
    expect(a).not.toBe(criteriaHash({ ...q([["none", "n"], ["memory", "m"]]), instructions: "pick one" }));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it("renders the criteria object in listed order and freezes the triage order", () => {
    expect(Object.keys(toJevQuestion(q([["none", "n"], ["status", "s"], ["memory", "m"]])).criteria)).toEqual(["none", "status", "memory"]);
    expect(optionsOf(TRIAGE_LANE)).toEqual(["none", "status", "memory"]);
    expect(optionsOf(TRIAGE_COMPLETE)).toEqual(["mixed", "pure"]);
    expect(optionsOf(TRIAGE_SCOPE)).toEqual(["ask", "research"]);
    expect(TRIAGE_QUESTIONS.map((x) => x.id)).toEqual(["lane", "complete", "scope"]);
  });
});

describe("lastHougeTurnOf (one rule for live and replay)", () => {
  it("finds the last assistant turn, maps clarify intent, computes age in seconds; null when none", () => {
    const now = Date.parse("2026-10-04T00:01:00.000Z");
    expect(lastHougeTurnOf([turn("assistant", "q?", "2026-10-04T00:00:30.000Z", "clarify"), turn("user", "x")], now)).toEqual({ kind: "clarify", age_s: 30 });
    expect(lastHougeTurnOf([turn("assistant", "a", "2026-10-04T00:00:00.000Z", "loop")], now)).toEqual({ kind: "answer", age_s: 60 });
    expect(lastHougeTurnOf([turn("user", "x")], now)).toBeNull();
  });
});

describe("buildTriageState (2026-09-25 egress envelope + metadata; sanitised; skip never truncate)", () => {
  const base = { userText: "以后回复短一点", recentTurns: [turn("assistant", "long answer with ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345")], turnChars: 300, modality: "text" as const, lastHougeTurn: { kind: "answer" as const, age_s: 12 } };
  it("carries message, thread as user/houge, last_houge_turn and modality, all sanitised", () => {
    const r = buildTriageState(base);
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.state).toEqual({ modality: "text", latest_message: "以后回复短一点", recent_turns: [{ role: "houge", text: "long answer with <token>" }], last_houge_turn: { kind: "answer", age_s: 12 } });
    expect(Object.keys(r.state).sort()).toEqual(["last_houge_turn", "latest_message", "modality", "recent_turns"]);
  });
  it("skips when the message or the request exceeds the caps", () => {
    expect(buildTriageState({ ...base, userText: "x".repeat(MAX_LATEST_MESSAGE_CHARS + 1) })).toEqual({ ok: false, skip: "state_too_large" });
    expect(buildTriageState({ ...base, recentTurns: Array.from({ length: 200 }, () => turn("user", "y".repeat(300))) })).toEqual({ ok: false, skip: "state_too_large" });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/jev/questions.test.ts tests/jev/egress-redact.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Create `src/jev/egress-redact.ts`**

```ts
/**
 * The one text seam before anything leaves for TypeSafe (ADR 0029 §4.5). Order: the broker masks the secret VALUES it
 * holds (when a broker exists), then code strips credential SHAPES Houge cannot know by value. Deterministic, so the
 * replay and the live path hash the same state. Ordinary words, dates and short numbers pass through.
 */
const SHAPES: Array<[RegExp, string]> = [
  // shell/heredoc bodies and long quoted literals: the material a steered command would hide (spec §4.5)
  [/<<-?\s*['"]?(\w+)['"]?[\s\S]*?\n\1\b/g, "<heredoc>"],
  [/(["'`])[^"'`\s]{40,}\1/g, "<literal>"], // opaque only (no whitespace): a quoted sentence is prose, not a secret
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, "Bearer <token>"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, "<token>"],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, "<token>"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "<token>"],
  [/\b[A-Fa-f0-9]{32,}\b/g, "<token>"],
  [/\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g, "<token>"],
  [/\bhttps?:\/\/[^\s<>"']+/g, "<url>"],
  [/\/Users\/[^/\s]+/g, "~"],
  // OTP-shaped codes (6–8 digits standing alone) and every Telegram id form (9+ digit ids, negative supergroup ids)
  [/(?<![\d.,])\d{6,8}(?![\d.,])/g, "<code>"],
  [/(?<![\d.])-?\d{9,}\b/g, "<id>"]
];

export function sanitizeJevText(text: string, brokerRedact?: (s: string) => string): string {
  let out = brokerRedact ? brokerRedact(text) : text;
  for (const [re, rep] of SHAPES) out = out.replace(re, rep);
  return out;
}
```

- [ ] **Step 4: Create `src/jev/questions/types.ts`**

```ts
import { createHash } from "node:crypto";
import type { JevChoiceQuestion } from "../jev-client.js";

/**
 * A frozen Jev question (ADR 0029 §3.1). Criteria are an ORDERED list because jev-1.13 leans toward the first
 * option: order is part of the calibration key, so the hash covers it. The model id is NOT in the hash — it is the
 * second key of a threshold row (§3.5), so a model move and a wording edit are told apart in the rows.
 */
export interface Question {
  id: string;
  type: "choice";
  instructions: string;
  criteria: ReadonlyArray<readonly [string, string]>;
}

export function optionsOf(q: Question): string[] {
  return q.criteria.map(([option]) => option);
}

/** The wire shape: an object whose insertion order is the listed order. */
export function toJevQuestion(q: Question): JevChoiceQuestion {
  const criteria: Record<string, string> = {};
  for (const [option, text] of q.criteria) criteria[option] = text;
  return { type: q.type, instructions: q.instructions, criteria };
}

/** sha256 over the exact request shape: `{type, instructions, criteria: [[opt, text], …]}`. */
export function criteriaHash(q: Question): string {
  return createHash("sha256").update(JSON.stringify({ type: q.type, instructions: q.instructions, criteria: q.criteria.map(([o, t]) => [o, t]) })).digest("hex");
}
```

- [ ] **Step 5: Create `src/jev/questions/triage.ts`**

Same three questions as Rev 1 (wording unchanged: `TRIAGE_LANE` options `none, status, memory`; `TRIAGE_COMPLETE` `mixed, pure`; `TRIAGE_SCOPE` `ask, research` — copy the criteria text verbatim from the spec §5.3), plus:

```ts
import { feedTurnText } from "../../capabilities/intent.js";
import type { TurnModality } from "../../media/media-config.js";
import type { ChatTurnRow } from "../../run/run-store.js";
import { sanitizeJevText } from "../egress-redact.js";
import { MAX_LATEST_MESSAGE_CHARS, MAX_REQUEST_CHARS } from "../intent-question.js";
import { toJevQuestion, type Question } from "./types.js";

export type LastHougeTurn = { kind: "clarify" | "answer"; age_s: number } | null;

/** The last assistant turn before `nowMs`; `intent === "clarify"` is the stored clarify mark (turn-context.ts assistantIntentFor). */
export function lastHougeTurnOf(recent: ChatTurnRow[], nowMs: number): LastHougeTurn {
  const last = [...recent].reverse().find((t) => t.role === "assistant");
  if (!last) return null;
  return { kind: last.intent === "clarify" ? "clarify" : "answer", age_s: Math.max(0, Math.round((nowMs - Date.parse(last.created_at)) / 1000)) };
}

export interface TriageStateInput { userText: string; recentTurns: ChatTurnRow[]; turnChars: number; modality: TurnModality; lastHougeTurn: LastHougeTurn }
export type TriageStateResult = { ok: true; state: Record<string, unknown>; chars: number } | { ok: false; skip: "state_too_large" };

/** Same envelope as the intent shadow (2026-09-25 approval) plus `last_houge_turn`; every text field sanitised; skip, never truncate. */
export function buildTriageState(i: TriageStateInput, brokerRedact?: (s: string) => string): TriageStateResult {
  if (i.userText.length > MAX_LATEST_MESSAGE_CHARS) return { ok: false, skip: "state_too_large" };
  const state: Record<string, unknown> = {
    modality: i.modality,
    latest_message: sanitizeJevText(i.userText, brokerRedact),
    recent_turns: i.recentTurns.map((t) => ({ role: t.role === "user" ? "user" : "houge", text: sanitizeJevText(feedTurnText(t.text, i.turnChars), brokerRedact) })),
    last_houge_turn: i.lastHougeTurn
  };
  const chars = JSON.stringify({ state, questions: TRIAGE_QUESTIONS.map(toJevQuestion) }).length;
  if (chars > MAX_REQUEST_CHARS) return { ok: false, skip: "state_too_large" };
  return { ok: true, state, chars };
}
```

- [ ] **Step 6: Run the tests, commit**

Run: `npx vitest run tests/jev/questions.test.ts tests/jev/egress-redact.test.ts` → PASS.

```bash
git add src/jev/questions/types.ts src/jev/questions/triage.ts src/jev/egress-redact.ts tests/jev/questions.test.ts tests/jev/egress-redact.test.ts
git commit -m "feat(jev): question library with ordered criteria hash, egress sanitiser, lane 1 triage questions and state"
```

---

#### Rev 1 text retained for the code blocks referenced above (reference only; the Rev 2 steps above are the ones to execute)


**Files:**
- Create: `src/jev/questions/types.ts`, `src/jev/questions/triage.ts`
- Test: `tests/jev/questions.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // types.ts
  export interface Question { id: string; type: "choice"; instructions: string; criteria: ReadonlyArray<readonly [string, string]>; }
  export function toJevQuestion(q: Question): JevChoiceQuestion;           // criteria object in the listed order
  export function criteriaHash(q: Question, model?: string): string;      // sha256 hex of {model,type,instructions,criteria:[[opt,text]…]}
  export function optionsOf(q: Question): string[];
  // triage.ts
  export const TRIAGE_LANE: Question;      // id "lane",     options in order: none, status, memory
  export const TRIAGE_COMPLETE: Question;  // id "complete", options: mixed, pure
  export const TRIAGE_SCOPE: Question;     // id "scope",    options: ask, research
  export const TRIAGE_QUESTIONS: readonly Question[];
  export interface TriageStateInput { userText: string; recentTurns: ChatTurnRow[]; turnChars: number; modality: TurnModality;
    lastHougeTurn: { kind: "clarify" | "answer" | "lesson_saved" | "memory_card" | "approval_card"; age_s: number } | null;
    pending: { memory_change_id?: string; rating_ask: boolean }; lastTurnTools: string[]; }
  export type TriageStateResult = { ok: true; state: Record<string, unknown>; chars: number } | { ok: false; skip: "state_too_large" };
  export function buildTriageState(i: TriageStateInput, redact: (s: string) => string): TriageStateResult;
  ```

- [x] ~~Step 1: Write the failing tests**

Create `tests/jev/questions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { criteriaHash, optionsOf, toJevQuestion, type Question } from "../../src/jev/questions/types.js";
import { TRIAGE_COMPLETE, TRIAGE_LANE, TRIAGE_QUESTIONS, TRIAGE_SCOPE, buildTriageState } from "../../src/jev/questions/triage.js";
import { MAX_LATEST_MESSAGE_CHARS } from "../../src/jev/intent-question.js";

const q = (criteria: ReadonlyArray<readonly [string, string]>): Question => ({ id: "t", type: "choice", instructions: "pick", criteria });

describe("criteriaHash (spec §3.1: option ORDER is a calibration variable)", () => {
  it("changes when options are reordered, even with identical text", () => {
    const a = criteriaHash(q([["none", "n"], ["memory", "m"]]));
    const b = criteriaHash(q([["memory", "m"], ["none", "n"]]));
    expect(a).not.toBe(b);
  });
  it("changes when the model id changes and when one word of instructions changes", () => {
    const base = q([["a", "x"], ["b", "y"]]);
    expect(criteriaHash(base)).not.toBe(criteriaHash(base, "jev-1.14.0"));
    expect(criteriaHash(base)).not.toBe(criteriaHash({ ...base, instructions: "pick one" }));
  });
  it("renders the criteria object in listed order (Jev leans to the first option)", () => {
    const j = toJevQuestion(q([["none", "n"], ["status", "s"], ["memory", "m"]]));
    expect(Object.keys(j.criteria)).toEqual(["none", "status", "memory"]);
    expect(optionsOf(TRIAGE_LANE)).toEqual(["none", "status", "memory"]);
    expect(optionsOf(TRIAGE_COMPLETE)).toEqual(["mixed", "pure"]);
    expect(optionsOf(TRIAGE_SCOPE)).toEqual(["ask", "research"]);
    expect(TRIAGE_QUESTIONS.map((x) => x.id)).toEqual(["lane", "complete", "scope"]);
  });
});

describe("buildTriageState (egress envelope of 2026-09-25, metadata only beyond it)", () => {
  const turn = (role: "user" | "assistant", text: string) => ({ turn_id: "t", chat_id: "c", run_id: "r", role, text, intent: null, created_at: "2026-10-04T00:00:00.000Z" });
  const base = { userText: "以后回复短一点", recentTurns: [turn("assistant", "long answer")], turnChars: 300, modality: "text" as const,
    lastHougeTurn: { kind: "answer" as const, age_s: 12 }, pending: { rating_ask: false }, lastTurnTools: ["web_search"] };
  it("carries the message, the thread as user/houge, and the metadata fields; redacts through the given seam", () => {
    const r = buildTriageState(base, (s) => s.replace("短", "X"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.latest_message).toBe("以后回复X一点");
    expect(r.state.recent_turns).toEqual([{ role: "houge", text: "long answer" }]);
    expect(r.state.last_houge_turn).toEqual({ kind: "answer", age_s: 12 });
    expect(r.state.last_turn_tools).toEqual(["web_search"]);
    expect(r.state.modality).toBe("text");
  });
  it("skips, never truncates, when the message or the request exceeds the caps", () => {
    const big = buildTriageState({ ...base, userText: "x".repeat(MAX_LATEST_MESSAGE_CHARS + 1) }, (s) => s);
    expect(big).toEqual({ ok: false, skip: "state_too_large" });
    const many = buildTriageState({ ...base, recentTurns: Array.from({ length: 200 }, () => turn("user", "y".repeat(300))) }, (s) => s);
    expect(many).toEqual({ ok: false, skip: "state_too_large" });
  });
});
```

- [x] ~~Step 2: Run to verify they fail**

Run: `npx vitest run tests/jev/questions.test.ts`
Expected: FAIL — modules not found.

- [x] ~~Step 3: Create `src/jev/questions/types.ts`**

```ts
import { createHash } from "node:crypto";
import { JEV_MODEL, type JevChoiceQuestion } from "../jev-client.js";

/**
 * A frozen Jev question (ADR 0029 §3.1). Criteria are an ORDERED list because jev-1.13 leans toward the first
 * option: order is part of the calibration key, so the hash covers it. Edit the wording or the order and every
 * threshold keyed to the old hash falls back until the question is re-calibrated.
 */
export interface Question {
  id: string;
  type: "choice";
  instructions: string;
  criteria: ReadonlyArray<readonly [string, string]>;
}

export function optionsOf(q: Question): string[] {
  return q.criteria.map(([option]) => option);
}

/** The wire shape: an object whose insertion order is the listed order. */
export function toJevQuestion(q: Question): JevChoiceQuestion {
  const criteria: Record<string, string> = {};
  for (const [option, text] of q.criteria) criteria[option] = text;
  return { type: q.type, instructions: q.instructions, criteria };
}

/** sha256 over the exact request shape plus the model id: `{model, type, instructions, criteria: [[opt, text], …]}`. */
export function criteriaHash(q: Question, model: string = JEV_MODEL): string {
  const canonical = JSON.stringify({ model, type: q.type, instructions: q.instructions, criteria: q.criteria.map(([o, t]) => [o, t]) });
  return createHash("sha256").update(canonical).digest("hex");
}
```

- [x] ~~Step 4: Create `src/jev/questions/triage.ts`**

```ts
import { feedTurnText } from "../../capabilities/intent.js";
import type { TurnModality } from "../../media/media-config.js";
import type { ChatTurnRow } from "../../run/run-store.js";
import { MAX_LATEST_MESSAGE_CHARS, MAX_REQUEST_CHARS } from "../intent-question.js";
import type { Question } from "./types.js";
import { toJevQuestion } from "./types.js";

/**
 * Lane 1 questions (spec §5.3), frozen: the fall-through option first on `lane`, the cautious option first on
 * `complete`. Wording is literal and names its boundary cases; Jev reads literally. Changing a word here changes
 * the criteria hash (types.ts) and un-arms the lane until re-calibrated.
 */
export const TRIAGE_LANE: Question = {
  id: "lane",
  type: "choice",
  instructions:
    "What should Houge do with `latest_message`? Houge is the AI agent in this conversation; \"Houge\", \"猴哥\", " +
    "\"you\" and \"your\" mean Houge. `recent_turns` is the conversation before `latest_message`, oldest first. " +
    "`last_houge_turn.kind` says what Houge's previous message was.",
  criteria: [
    ["none",
      "Everything else: a question, a task, a lookup, small talk, a bare acknowledgement such as 好 / 嗯 / ok / 👍 / 是的 " +
      "even right after Houge saved or proposed something, an answer to a question Houge asked, or a message about " +
      "Houge's code or schedules."],
    ["status",
      "`latest_message` asks whether Houge restarted, which build or code is live, or whether it is running normally; " +
      "nothing else."],
    ["memory",
      "`latest_message` tells Houge how to behave from now on, states something about the user to remember, or corrects " +
      "something Houge believes. Signals: 以后 / 从现在起 / 记住 / 不要再 / 别再 / always / never / from now on / remember / " +
      "prefer, or a correction of Houge's previous reply in `recent_turns` that applies to future replies too."]
  ]
};

export const TRIAGE_COMPLETE: Question = {
  id: "complete",
  type: "choice",
  instructions: "Does `latest_message` contain anything besides a preference, fact or correction for Houge to keep?",
  criteria: [
    ["mixed", "`latest_message` also asks something, requests work, or continues a task."],
    ["pure", "It contains only the preference, fact or correction; nothing asks a question, requests work, or expects more than a confirmation."]
  ]
};

export const TRIAGE_SCOPE: Question = {
  id: "scope",
  type: "choice",
  instructions: "If `latest_message` is a preference or correction, which part of Houge's behaviour is it about?",
  criteria: [
    ["ask", "How Houge replies in conversation: length, tone, language, format, what to include or leave out."],
    ["research", "How Houge searches, which sources it trusts, or how it cites and reports what it found."]
  ]
};

export const TRIAGE_QUESTIONS: readonly Question[] = [TRIAGE_LANE, TRIAGE_COMPLETE, TRIAGE_SCOPE];

export interface TriageStateInput {
  userText: string;
  recentTurns: ChatTurnRow[];
  turnChars: number;
  modality: TurnModality;
  lastHougeTurn: { kind: "clarify" | "answer" | "lesson_saved" | "memory_card" | "approval_card"; age_s: number } | null;
  pending: { memory_change_id?: string; rating_ask: boolean };
  lastTurnTools: string[];
}
export type TriageStateResult = { ok: true; state: Record<string, unknown>; chars: number } | { ok: false; skip: "state_too_large" };

/** Same egress envelope as the intent shadow (2026-09-25 approval) plus code-owned metadata; skip, never truncate. */
export function buildTriageState(i: TriageStateInput, redact: (s: string) => string): TriageStateResult {
  if (i.userText.length > MAX_LATEST_MESSAGE_CHARS) return { ok: false, skip: "state_too_large" };
  const state: Record<string, unknown> = {
    modality: i.modality,
    latest_message: redact(i.userText),
    recent_turns: i.recentTurns.map((t) => ({ role: t.role === "user" ? "user" : "houge", text: redact(feedTurnText(t.text, i.turnChars)) })),
    last_houge_turn: i.lastHougeTurn,
    pending: i.pending,
    last_turn_tools: i.lastTurnTools
  };
  const chars = JSON.stringify({ state, questions: TRIAGE_QUESTIONS.map(toJevQuestion) }).length;
  if (chars > MAX_REQUEST_CHARS) return { ok: false, skip: "state_too_large" };
  return { ok: true, state, chars };
}
```

- [x] ~~Step 5: Run the tests**

Run: `npx vitest run tests/jev/questions.test.ts`
Expected: PASS.

- [x] ~~Step 6: Commit**

```bash
git add src/jev/questions/types.ts src/jev/questions/triage.ts tests/jev/questions.test.ts
git commit -m "feat(jev): question library with ordered criteria hash; lane 1 triage questions and state"
```

---

---
### Task 3: Calibration rows, thresholds and the pure `triageVerdict`

**Files:**
- Create: `src/jev/calibration.ts`, `src/jev/thresholds.ts`
- Test: `tests/jev/thresholds.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // calibration.ts — the ONLY place a question becomes armable. Empty at ship: every lane starts uncalibrated (spec §3.5, §5.9).
  export interface CalibrationRow { question_id: string; criteria_hash: string; model: string; lang: "zh" | "en"; approved: string /* ISO date */; evidence: string /* replay file + report line */ }
  export const CALIBRATED_ROWS: readonly CalibrationRow[];   // [] in slice 1; the replay report prints the rows to add once the bars pass; Paco's commit adds them
  export function calibratedLang(questionId: string, hash: string, model: string, lang: Lang, rows?: readonly CalibrationRow[]): "zh" | "en" | undefined;  // mixed → zh
  // thresholds.ts
  export const THRESHOLD_VERSION = "2026-10-04.1";
  export interface TriageBars { minConf: number; minMemory: number; minGap: number; minPure: number; minStatus: number; }
  export const TRIAGE_BAR_DEFAULTS: TriageBars;  // 0.7, 0.85, 0.5, 0.8, 0.8
  export function resolveTriageBars(env: NodeJS.ProcessEnv): TriageBars;
  export type TriageDecision = { kind: "fallthrough"; reason: "uncalibrated" | "below_bar" | "none" } | { kind: "status" } | { kind: "memory"; complete: "pure" | "mixed"; scope: "ask" | "research" };
  export function triageVerdict(answers: Record<string, JevChoiceAnswer>, bars: TriageBars, lang: Lang, model: string, rows?: readonly CalibrationRow[]): TriageDecision;
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/jev/thresholds.test.ts` — same cases as Rev 1 with two changes: every "acts" case passes an explicit `rows` list that calibrates all three triage questions for the test language and `JEV_MODEL` (`const rows = TRIAGE_QUESTIONS.flatMap(q => ["zh","en"].map(lang => ({ question_id: q.id, criteria_hash: criteriaHash(q), model: JEV_MODEL, lang, approved: "test", evidence: "test" })))`), and a new case:

```ts
it("ships uncalibrated: with the real CALIBRATED_ROWS a perfect answer still falls through (spec §5.9: no arming before the replay)", () => {
  expect(CALIBRATED_ROWS).toHaveLength(0);
  expect(triageVerdict(answers({ none: 0.05, status: 0.05, memory: 0.9 }, { mixed: 0.1, pure: 0.9 }, { ask: 0.8, research: 0.2 }), bars, "zh", JEV_MODEL)).toEqual({ kind: "fallthrough", reason: "uncalibrated" });
});
it("a row for another model or another hash does not calibrate", () => {
  expect(calibratedLang("lane", criteriaHash(TRIAGE_LANE), "jev-1.14.0", "zh", rows)).toBeUndefined();
  expect(calibratedLang("lane", "deadbeef", JEV_MODEL, "zh", rows)).toBeUndefined();
  expect(calibratedLang("lane", criteriaHash(TRIAGE_LANE), JEV_MODEL, "mixed", rows)).toBe("zh");
});
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run tests/jev/thresholds.test.ts` → module not found.

- [ ] **Step 3: Create `src/jev/calibration.ts`**

```ts
import type { Lang } from "./intent-question.js";

/**
 * Calibration rows (ADR 0029 §3.5). A question is armed for a language ONLY when a row names its exact criteria hash
 * and the reported model. Slice 1 ships NONE: the lane cannot act until the lane 1 replay + Paco's labels clear the
 * §5.9 bars, the report prints the rows, and Paco commits them here (his hand, like an ADR amendment).
 */
import { readFileSync } from "node:fs";

export interface CalibrationRow { question_id: string; criteria_hash: string; model: string; lang: "zh" | "en"; approved: string; evidence: string }

export const CALIBRATED_ROWS: readonly CalibrationRow[] = [];

/**
 * Arming sequence (spec §5.9; Codex plan review): production rows come ONLY from this constant, added by Paco's commit.
 * `HOUGE_JEV_CALIBRATION_FILE` (a JSON array of CalibrationRow) exists for the live gate and a labelled shadow copy
 * of the DB — it is never set in the daemon's .env (configuration.md says so) and `resolveJevTriageMode` caps `arm`
 * at shadow while it is set outside a gate (`HOUGE_JEV_GATE=1`).
 */
export function calibrationRows(env: NodeJS.ProcessEnv): readonly CalibrationRow[] {
  const file = env.HOUGE_JEV_CALIBRATION_FILE?.trim();
  if (!file) return CALIBRATED_ROWS;
  try { return JSON.parse(readFileSync(file, "utf8")) as CalibrationRow[]; } catch { return []; } // unreadable = uncalibrated
}

export function calibratedLang(questionId: string, hash: string, model: string, lang: Lang, rows: readonly CalibrationRow[] = CALIBRATED_ROWS): "zh" | "en" | undefined {
  const effective = lang === "mixed" ? "zh" : lang; // mixed inherits zh until it has ≥ 20 labelled rows (spec §3.4)
  return rows.some((r) => r.question_id === questionId && r.criteria_hash === hash && r.model === model && r.lang === effective) ? effective : undefined;
}
```

- [ ] **Step 4: Create `src/jev/thresholds.ts`** — as Rev 1, with `calibratedLang` imported from `./calibration.js`, `criteriaHash(q)` (no model argument), and `triageVerdict(answers, bars, lang, model, rows = CALIBRATED_ROWS)` passing `rows` through; `triageTurn` (Task 9) passes `calibrationRows(process.env)`. **Lane-specific arming:** the `status` decision needs only the `lane` row for the language; the `memory` decision needs all three (`lane`, `complete`, `scope`). `triageVerdict` evaluates `status` first with the `lane`-only check, then `memory` with the three-row check; an uncalibrated `complete`/`scope` with a calibrated `lane` therefore arms status alone. Add a test for that split.

**Arming sequence, end to end (binding for Tasks 3, 11, 12, 13, 14):**
1. Ship with `CALIBRATED_ROWS = []`: the lane cannot act anywhere, in any mode.
2. The first live gate (Task 13) runs with `HOUGE_JEV_GATE=1` and `HOUGE_JEV_CALIBRATION_FILE=<tmp rows for zh/en>`; production stays unarmable.
3. Full replay over the universe + the permuted run + Paco's labelling sitting (every required set non-empty) + the live shadow (`shadow` mode ≥ 14 days with ≥ 5 matched planner `lesson_write` calls, read from the `triage` rows by `houge jev report triage`).
4. The report prints the **eligible** rows separately for memory and for status (status only with precision 1.0 on n ≥ 5; otherwise status stays shadow), per language.
5. Paco approves and commits only those rows into `CALIBRATED_ROWS` (his hand, like an ADR amendment), the daemon is rebuilt, and the armed live gate is re-run against the committed calibration (no file override) before `HOUGE_JEV_TRIAGE_ENABLED=arm` is set. The armed checks are lane-specific: `status` requires only the calibrated `lane` row (`calibratedLang(TRIAGE_LANE.id, criteriaHash(TRIAGE_LANE), model, lang, rows) !== undefined`); `memory` requires calibrated `lane`, `complete` and `scope` rows (`[TRIAGE_LANE, TRIAGE_COMPLETE, TRIAGE_SCOPE].every(...)`). `triageVerdict` evaluates status first under its own check, then memory under the three-row check, else `fallthrough: uncalibrated`.

- [ ] **Step 5: Run, commit**

Run: `npx vitest run tests/jev/thresholds.test.ts` → PASS.

```bash
git add src/jev/calibration.ts src/jev/thresholds.ts tests/jev/thresholds.test.ts
git commit -m "feat(jev): calibration rows (empty at ship), thresholds and the pure triage verdict"
```

---

#### Rev 1 text retained for the code blocks referenced above (reference only; the Rev 2 steps above are the ones to execute)


**Files:**
- Create: `src/jev/thresholds.ts`
- Test: `tests/jev/thresholds.test.ts`

**Interfaces:**
- Consumes: `criteriaHash`, `TRIAGE_*` (Task 2); `JevChoiceAnswer`, `JEV_MODEL` (client); `Lang` (`intent-question.ts`).
- Produces:
  ```ts
  export const THRESHOLD_VERSION = "2026-10-04.1";
  export interface TriageBars { minConf: number; minMemory: number; minGap: number; minPure: number; minStatus: number; }
  export const TRIAGE_BAR_DEFAULTS: TriageBars; // 0.7, 0.85, 0.5, 0.8, 0.8
  export function resolveTriageBars(env: NodeJS.ProcessEnv): TriageBars;   // HOUGE_JEV_TRIAGE_MIN_CONF / _MIN_PURE / _MIN_STATUS override
  export function calibratedLang(questionId: string, hash: string, model: string, lang: Lang): Lang | undefined; // zh|en rows; mixed→zh; unknown→undefined
  export type TriageDecision =
    | { kind: "fallthrough"; reason: "uncalibrated" | "below_bar" | "none" }
    | { kind: "status" }
    | { kind: "memory"; complete: "pure" | "mixed"; scope: "ask" | "research" };
  export function triageVerdict(answers: Record<string, JevChoiceAnswer>, bars: TriageBars, lang: Lang, model: string): TriageDecision;
  ```

- [x] ~~Step 1: Write the failing tests**

Create `tests/jev/thresholds.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { JEV_MODEL, type JevChoiceAnswer } from "../../src/jev/jev-client.js";
import { criteriaHash } from "../../src/jev/questions/types.js";
import { TRIAGE_LANE } from "../../src/jev/questions/triage.js";
import { TRIAGE_BAR_DEFAULTS, calibratedLang, resolveTriageBars, triageVerdict } from "../../src/jev/thresholds.js";

const ans = (choice: string, probabilities: Record<string, number>): JevChoiceAnswer => {
  const n = Object.keys(probabilities).length;
  const pMax = Math.max(...Object.values(probabilities));
  return { choice, probabilities, confidence: (pMax - 1 / n) / (1 - 1 / n) }; // Jev's documented confidence formula
};
const answers = (lane: Record<string, number>, complete: Record<string, number>, scope: Record<string, number>) => ({
  lane: ans(Object.entries(lane).sort((a, b) => b[1] - a[1])[0]![0], lane),
  complete: ans(Object.entries(complete).sort((a, b) => b[1] - a[1])[0]![0], complete),
  scope: ans(Object.entries(scope).sort((a, b) => b[1] - a[1])[0]![0], scope)
});
const bars = TRIAGE_BAR_DEFAULTS;

// Spec §5.4. A wrong `pure` swallows a question, so every bar is tested at its edge.
describe("triageVerdict", () => {
  it("route-and-skip only when conf, p(memory), gap and p(pure) all clear", () => {
    const d = triageVerdict(answers({ none: 0.05, status: 0.05, memory: 0.9 }, { mixed: 0.1, pure: 0.9 }, { ask: 0.8, research: 0.2 }), bars, "zh", JEV_MODEL);
    expect(d).toEqual({ kind: "memory", complete: "pure", scope: "ask" });
  });
  it("downgrades to mixed when p(pure) is one hundredth under the bar", () => {
    const d = triageVerdict(answers({ none: 0.05, status: 0.05, memory: 0.9 }, { mixed: 0.21, pure: 0.79 }, { ask: 0.3, research: 0.7 }), bars, "zh", JEV_MODEL);
    expect(d).toEqual({ kind: "memory", complete: "mixed", scope: "research" });
  });
  it("falls through when p(memory) ≥ .85 but the gap to none is under .5", () => {
    const d = triageVerdict(answers({ none: 0.4, status: 0.0, memory: 0.6 }, { mixed: 0.1, pure: 0.9 }, { ask: 0.9, research: 0.1 }), bars, "zh", JEV_MODEL);
    expect(d.kind).toBe("fallthrough");
  });
  it("status needs only p(status) ≥ .8; a bare ack after a proposal is none", () => {
    expect(triageVerdict(answers({ none: 0.15, status: 0.8, memory: 0.05 }, { mixed: 0.5, pure: 0.5 }, { ask: 0.5, research: 0.5 }), bars, "en", JEV_MODEL)).toEqual({ kind: "status" });
    expect(triageVerdict(answers({ none: 0.97, status: 0.01, memory: 0.02 }, { mixed: 0.5, pure: 0.5 }, { ask: 0.5, research: 0.5 }), bars, "zh", JEV_MODEL)).toEqual({ kind: "fallthrough", reason: "none" });
  });
  it("falls through as uncalibrated for a language with no threshold row, and for a model other than the pinned one", () => {
    const a = answers({ none: 0.05, status: 0.05, memory: 0.9 }, { mixed: 0.1, pure: 0.9 }, { ask: 0.8, research: 0.2 });
    expect(triageVerdict(a, bars, "zh", "jev-1.14.0")).toEqual({ kind: "fallthrough", reason: "uncalibrated" });
    expect(calibratedLang("lane", criteriaHash(TRIAGE_LANE), JEV_MODEL, "mixed")).toBe("zh"); // mixed inherits zh (spec §3.4)
    expect(calibratedLang("lane", "deadbeef", JEV_MODEL, "zh")).toBeUndefined();            // an edited question is un-armed
  });
});

describe("resolveTriageBars", () => {
  it("reads env overrides and ignores garbage", () => {
    expect(resolveTriageBars({ HOUGE_JEV_TRIAGE_MIN_CONF: "0.9", HOUGE_JEV_TRIAGE_MIN_PURE: "x", HOUGE_JEV_TRIAGE_MIN_STATUS: "1.5" }))
      .toEqual({ ...TRIAGE_BAR_DEFAULTS, minConf: 0.9 });
  });
});
```

- [x] ~~Step 2: Run to verify they fail**

Run: `npx vitest run tests/jev/thresholds.test.ts`
Expected: FAIL — module not found.

- [x] ~~Step 3: Create `src/jev/thresholds.ts`**

```ts
import { JEV_MODEL, type JevChoiceAnswer } from "./jev-client.js";
import type { Lang } from "./intent-question.js";
import { criteriaHash } from "./questions/types.js";
import { TRIAGE_COMPLETE, TRIAGE_LANE, TRIAGE_SCOPE } from "./questions/triage.js";

/** Bump when a start value changes; stored on every decision row so a replay knows which bars judged it. */
export const THRESHOLD_VERSION = "2026-10-04.1";

export interface TriageBars { minConf: number; minMemory: number; minGap: number; minPure: number; minStatus: number }
export const TRIAGE_BAR_DEFAULTS: TriageBars = { minConf: 0.7, minMemory: 0.85, minGap: 0.5, minPure: 0.8, minStatus: 0.8 };

function unit(raw: string | undefined, fallback: number): number {
  const n = Number(raw?.trim());
  return raw !== undefined && Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

/** Env overrides (spec §5.4): a bad calibration is an .env edit, not a revert. */
export function resolveTriageBars(env: NodeJS.ProcessEnv): TriageBars {
  return {
    ...TRIAGE_BAR_DEFAULTS,
    minConf: unit(env.HOUGE_JEV_TRIAGE_MIN_CONF, TRIAGE_BAR_DEFAULTS.minConf),
    minPure: unit(env.HOUGE_JEV_TRIAGE_MIN_PURE, TRIAGE_BAR_DEFAULTS.minPure),
    minStatus: unit(env.HOUGE_JEV_TRIAGE_MIN_STATUS, TRIAGE_BAR_DEFAULTS.minStatus)
  };
}

/**
 * Calibration rows (spec §3.5): a question is armed for a language only when a row exists for its exact criteria
 * hash and the pinned model. Slice 1 ships the start rows for zh and en from the 2026-09-26 replay shape; the lane 1
 * replay (Task 11) is what justifies them before `arm`. `mixed` inherits zh until it has ≥ 20 labelled rows.
 */
const CALIBRATED: ReadonlySet<string> = new Set(
  [TRIAGE_LANE, TRIAGE_COMPLETE, TRIAGE_SCOPE].flatMap((q) => (["zh", "en"] as const).map((lang) => `${q.id}|${criteriaHash(q)}|${JEV_MODEL}|${lang}`))
);

export function calibratedLang(questionId: string, hash: string, model: string, lang: Lang): Lang | undefined {
  const effective: Lang = lang === "mixed" ? "zh" : lang;
  return CALIBRATED.has(`${questionId}|${hash}|${model}|${effective}`) ? effective : undefined;
}

export type TriageDecision =
  | { kind: "fallthrough"; reason: "uncalibrated" | "below_bar" | "none" }
  | { kind: "status" }
  | { kind: "memory"; complete: "pure" | "mixed"; scope: "ask" | "research" };

const p = (a: JevChoiceAnswer, option: string): number => a.probabilities[option] ?? 0;

/** Pure: probabilities in, decision out. Thresholds are the caller's (code-owned); Jev never applies them. */
export function triageVerdict(answers: Record<string, JevChoiceAnswer>, bars: TriageBars, lang: Lang, model: string): TriageDecision {
  const lane = answers.lane; const complete = answers.complete; const scope = answers.scope;
  if (!lane || !complete || !scope) return { kind: "fallthrough", reason: "uncalibrated" };
  const armed = [TRIAGE_LANE, TRIAGE_COMPLETE, TRIAGE_SCOPE].every((q) => calibratedLang(q.id, criteriaHash(q, model), model, lang) !== undefined);
  if (!armed) return { kind: "fallthrough", reason: "uncalibrated" };
  if (p(lane, "status") >= bars.minStatus) return { kind: "status" };
  const memory = p(lane, "memory");
  if (memory < bars.minMemory || lane.confidence < bars.minConf || memory - p(lane, "none") < bars.minGap) {
    return { kind: "fallthrough", reason: lane.choice === "none" ? "none" : "below_bar" };
  }
  const scopeChoice: "ask" | "research" = p(scope, "research") > p(scope, "ask") ? "research" : "ask";
  return { kind: "memory", complete: p(complete, "pure") >= bars.minPure ? "pure" : "mixed", scope: scopeChoice };
}
```

- [x] ~~Step 4: Run the tests**

Run: `npx vitest run tests/jev/thresholds.test.ts`
Expected: PASS.

- [x] ~~Step 5: Commit**

```bash
git add src/jev/thresholds.ts tests/jev/thresholds.test.ts
git commit -m "feat(jev): calibration-keyed thresholds and the pure triage verdict"
```

---

---
### Task 4: Store — `jev_decisions`, `lesson_changes` (+ Undo, `unpruneLesson`), ledger event types, helpers

**Files:**
- Modify: `src/run/run-store.ts` (migrations list `:6491-6519`; lesson block near `:1373-1410`; memory-change block `:4115-4220` as template; `LessonSource` `:374`)
- Modify: `src/run/run-ledger.ts` (`LedgerEventType`, `requiredPayloadFields`)
- Test: `tests/run/jev-decisions-store.test.ts` (new), `tests/run/lesson-changes-store.test.ts` (new), `tests/run/run-ledger.test.ts` (extend)

**Interfaces:**
- Produces (all on `RunStore`):
  ```ts
  export type LessonSource = "user_feedback" | "loop" | "migration" | "consolidation" | "lane";
  export type JevDecisionStatus = "answered" | "skipped";
  export type JevDecisionOutcome = "act" | "ask" | "fallback" | "shadow";
  export interface JevDecisionRow { decision_id: string; run_id: string | null; point: string; question_id: string | null; criteria_hash: string | null;
    model_reported: string | null; state_hash: string | null; lang: string; answers_json: string | null; confidence: number | null; top_prob: number | null;
    margin: number | null; threshold_version: string | null; threshold_used: string | null; decision: JevDecisionOutcome | null;
    outcome_source: "llm_label" | "paco_correction" | "observed_action" | "none"; outcome_value: string | null; latency_ms: number | null;
    input_tokens: number | null; status: JevDecisionStatus; skip_reason: string | null; created_at: string; }
  insertJevDecision(row: Omit<JevDecisionRow, "decision_id" | "created_at" | "outcome_source" | "outcome_value"> & { created_at?: string }): string; // returns decision_id `jd_<uuid>`
  markJevDecision(decision_id: string, decision: JevDecisionOutcome, threshold_used: string | null): void;
  recordJevOutcome(decision_id: string, source: JevDecisionRow["outcome_source"], value: string): void;
  listJevDecisions(run_id: string): JevDecisionRow[];

  export interface LessonChange { change_id: string; run_id: string | null; chat_id: string; new_id: number; superseded_id: number | null; pruned_ids: number[]; created_at: string; undone_at: string | null; }
  export type LessonUndoResult = { status: "undone"; change: LessonChange; restored: number[]; skipped: number[] } | { status: "already_undone" | "changed_since"; change: LessonChange } | { status: "not_found" };
  insertLessonChange(c: Omit<LessonChange, "change_id" | "created_at" | "undone_at"> & { created_at?: string }): LessonChange; // `lc_<uuid>`
  getLessonChange(change_id: string): LessonChange | undefined;
  undoLessonChange(change_id: string, now?: string): LessonUndoResult;   // one transaction, compare-and-set; writes lesson_change_undone inside it
  unpruneLesson(id: number): boolean;                                     // WHERE status = 'pruned'
  triageOverrideFor(run_id: string): boolean;                             // a triage_override row names this run as new_run_id
  countRecentLedgerEvents(event_type: LedgerEventType, sinceIso: string): number;
  userTurnTextForRun(run_id: string): string | undefined;                 // the user chat_turn recorded for the run
  ```
  Ledger: `triage` (required `status, lane, complete, scope, confidence, top_prob, margin, lang, decision`), `ack_nudged` (`approval_run_id`), `lesson_saved` (`lesson_id, change_id, source`), `lesson_change_undone` (`change_id, restored, skipped`), `triage_override` (`run_id, new_run_id, change_id`).

- [ ] **Step 1: Write the failing ledger-type test**

Append to `tests/run/run-ledger.test.ts`:

```ts
it("ADR 0029 events require their enum/number fields and accept null for a skipped triage (never text)", () => {
  const ok = validateLedgerEvent(createLedgerEvent({ correlation_id: "r", event_type: "triage", actor: "core", sequence: 1,
    payload: { status: "skipped", lane: null, complete: null, scope: null, confidence: null, top_prob: null, margin: null, lang: "zh", decision: "fallback", skip_reason: "no_key" } }));
  expect(ok.ok).toBe(true);
  const missing = validateLedgerEvent(createLedgerEvent({ correlation_id: "r", event_type: "lesson_saved", actor: "core", sequence: 2, payload: { lesson_id: 51 } }));
  expect(missing.ok).toBe(false);
});
```

- [ ] **Step 2: Add the event types**

`src/run/run-ledger.ts`: extend `LedgerEventType` with `| "triage" | "ack_nudged" | "lesson_saved" | "lesson_change_undone" | "triage_override"` and `requiredPayloadFields` with:

```ts
  // Jev System One, lane 1 (ADR 0029 §5.8). Enums, numbers and ids only — NEVER message text or provider detail.
  // `triage` is the per-turn denominator: written once per eligible Telegram turn after the outcome is known;
  // a skipped call carries nulls for the answer fields and a skip_reason.
  triage: ["status", "lane", "complete", "scope", "confidence", "top_prob", "margin", "lang", "decision"],
  ack_nudged: ["approval_run_id"],
  lesson_saved: ["lesson_id", "change_id", "source"],
  lesson_change_undone: ["change_id", "restored", "skipped"],
  // "Ask Houge anyway": the override label for calibration; new_run_id is the re-submitted planner turn.
  triage_override: ["run_id", "new_run_id", "change_id"],
```

Run: `npx vitest run tests/run/run-ledger.test.ts` → PASS.

- [ ] **Step 3: Write the failing `jev_decisions` tests**

Create `tests/run/jev-decisions-store.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { RunStore } from "../../src/run/run-store.js";

// Spec §3.4: one row per question when answered, one skipped row otherwise; no text columns; replay joins on state_hash.
describe("jev_decisions", () => {
  const base = { run_id: "run_1", point: "triage", question_id: "lane", criteria_hash: "h", model_reported: "jev-1.13.0", state_hash: "s", lang: "zh",
    answers_json: JSON.stringify({ none: 0.1, status: 0.0, memory: 0.9 }), confidence: 0.85, top_prob: 0.9, margin: 0.8, threshold_version: "2026-10-04.1",
    threshold_used: null, decision: null, latency_ms: 300, input_tokens: 1200, status: "answered" as const, skip_reason: null };
  it("inserts, marks and lists rows for a run in insertion order", () => {
    const store = RunStore.openInMemory();
    const a = store.insertJevDecision(base);
    const b = store.insertJevDecision({ ...base, question_id: "complete" });
    store.markJevDecision(a, "act", "memory:0.85/0.5/0.8");
    const rows = store.listJevDecisions("run_1");
    expect(rows.map((r) => r.question_id)).toEqual(["lane", "complete"]);
    expect(rows[0]).toMatchObject({ decision_id: a, decision: "act", threshold_used: "memory:0.85/0.5/0.8", outcome_source: "none" });
    expect(rows[1]).toMatchObject({ decision_id: b, decision: null });
    store.close();
  });
  it("records a skipped call as one row with question_id NULL and keeps the reason as an enum", () => {
    const store = RunStore.openInMemory();
    store.insertJevDecision({ ...base, question_id: null, criteria_hash: null, model_reported: null, state_hash: null, answers_json: null, confidence: null,
      top_prob: null, margin: null, threshold_version: null, latency_ms: null, input_tokens: null, status: "skipped", skip_reason: "no_key" });
    expect(store.listJevDecisions("run_1")).toMatchObject([{ status: "skipped", skip_reason: "no_key", question_id: null }]);
    store.close();
  });
  it("outcome labels attach later without touching the answer", () => {
    const store = RunStore.openInMemory();
    const id = store.insertJevDecision(base);
    store.recordJevOutcome(id, "paco_correction", "override");
    expect(store.listJevDecisions("run_1")[0]).toMatchObject({ outcome_source: "paco_correction", outcome_value: "override", confidence: 0.85 });
    store.close();
  });
});
```

- [ ] **Step 4: Write the failing `lesson_changes` tests**

Create `tests/run/lesson-changes-store.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { RunStore } from "../../src/run/run-store.js";

const NOW = "2026-10-04T10:00:00.000Z";
function lesson(store: RunStore, text: string, scope = "ask"): number {
  return store.addLesson({ scope, text, theme: "format", source: "loop", created_at: NOW });
}

// Spec §5.6: Undo restores each affected row to its RECORDED prior state, compare-and-set, one transaction.
describe("lesson_changes + undo", () => {
  it("retires the new row, reactivates the superseded one and un-prunes the cap victims", () => {
    const store = RunStore.openInMemory();
    const old = lesson(store, "old rule"); const victim = lesson(store, "weak rule");
    const saved = store.saveReconciledLesson({ scope: "ask", text: "new rule", theme: "format" }, { verdict: "UPDATE", id: old, text: "new rule" }, "lane", NOW, 1);
    expect(saved.id).toBeDefined(); expect(saved.prunedIds).toContain(victim);
    const change = store.insertLessonChange({ run_id: "run_1", chat_id: "555", new_id: saved.id!, superseded_id: old, pruned_ids: saved.prunedIds });
    const r = store.undoLessonChange(change.change_id, NOW);
    expect(r.status).toBe("undone");
    if (r.status !== "undone") return;
    expect(r.restored.sort()).toEqual([old, victim].sort());
    expect(store.getLesson(saved.id!)?.status).toBe("pruned");
    expect(store.getLesson(old)?.status).toBe("active");
    expect(store.getLesson(victim)?.status).toBe("active");
    expect(store.getLessonChange(change.change_id)?.undone_at).toBe(NOW);
    expect(store.getLedgerEvents().some((e) => e.event_type === "lesson_change_undone" && e.payload.change_id === change.change_id)).toBe(true);
    store.close();
  });
  it("refuses when the new row was changed since, and reports already_undone on a second tap", () => {
    const store = RunStore.openInMemory();
    const id = lesson(store, "rule");
    const change = store.insertLessonChange({ run_id: null, chat_id: "555", new_id: id, superseded_id: null, pruned_ids: [] });
    store.saveReconciledLesson({ scope: "ask", text: "newer", theme: "format" }, { verdict: "SUPERSEDE", id }, "loop", NOW, 20); // a later write superseded #id
    expect(store.undoLessonChange(change.change_id, NOW).status).toBe("changed_since");
    const fresh = lesson(store, "x"); const c2 = store.insertLessonChange({ run_id: null, chat_id: "555", new_id: fresh, superseded_id: null, pruned_ids: [] });
    expect(store.undoLessonChange(c2.change_id, NOW).status).toBe("undone");
    expect(store.undoLessonChange(c2.change_id, NOW).status).toBe("already_undone");
    store.close();
  });
  it("leaves a row alone when its status moved since and names it in skipped", () => {
    const store = RunStore.openInMemory();
    const victim = lesson(store, "weak"); const kept = lesson(store, "new");
    const change = store.insertLessonChange({ run_id: null, chat_id: "555", new_id: kept, superseded_id: null, pruned_ids: [victim] });
    store.unpruneLesson(victim); // someone restored it already (status active, not pruned)
    const r = store.undoLessonChange(change.change_id, NOW);
    expect(r.status === "undone" && r.skipped).toEqual([victim]);
    store.close();
  });
  it("unpruneLesson only restores a pruned row", () => {
    const store = RunStore.openInMemory();
    const id = lesson(store, "a");
    expect(store.unpruneLesson(id)).toBe(false);
    store.forgetLesson(id);
    expect(store.unpruneLesson(id)).toBe(true);
    expect(store.getLesson(id)?.status).toBe("active");
    store.close();
  });
  it("helpers: triageOverrideFor, countRecentLedgerEvents, userTurnTextForRun", () => {
    const store = RunStore.openInMemory();
    store.recordChatTurn({ chat_id: "555", run_id: "run_a", role: "user", text: "以后回复短一点" });
    store.recordMemoryEvent("triage_override", { run_id: "run_a", new_run_id: "run_b", change_id: null });
    expect(store.triageOverrideFor("run_b")).toBe(true);
    expect(store.triageOverrideFor("run_a")).toBe(false);
    expect(store.countRecentLedgerEvents("triage_override", "2026-01-01T00:00:00.000Z")).toBe(1);
    expect(store.userTurnTextForRun("run_a")).toBe("以后回复短一点");
    store.close();
  });
});
```

Note `forgetLesson(id)` exists (`run-store.ts:1406`, sets `pruned`); `getLesson` at `:1329`.

- [ ] **Step 5: Run to verify they fail**

Run: `npx vitest run tests/run/jev-decisions-store.test.ts tests/run/lesson-changes-store.test.ts`
Expected: FAIL — methods do not exist.

- [ ] **Step 6: Add the migrations**

In `src/run/run-store.ts`, after `applyPlannerSessionStateMigration` in the migration list (`:6519`), register `this.applyJevDecisionsMigration(); this.applyLessonChangesMigration();` and add, next to `applyMemoryChangesMigration` (`:6554`):

```ts
  /** Jev System One (ADR 0029 §3.4): one row per answered question, one skipped row per skipped call. No text columns. */
  private applyJevDecisionsMigration(): void {
    const version = "2026-10-04-jev-decisions";
    this.inTransaction(() => {
      const applied = this.db.prepare(`SELECT version FROM schema_migrations WHERE version = ?`).get<{ version: string }>(version);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS jev_decisions (
          decision_id TEXT PRIMARY KEY,
          run_id TEXT,
          point TEXT NOT NULL,
          question_id TEXT,
          criteria_hash TEXT,
          model_reported TEXT,
          state_hash TEXT,
          lang TEXT NOT NULL,
          answers_json TEXT,
          confidence REAL,
          top_prob REAL,
          margin REAL,
          threshold_version TEXT,
          threshold_used TEXT,
          decision TEXT CHECK (decision IN ('act', 'ask', 'fallback', 'shadow')),
          outcome_source TEXT NOT NULL DEFAULT 'none' CHECK (outcome_source IN ('llm_label', 'paco_correction', 'observed_action', 'none')),
          outcome_value TEXT,
          latency_ms INTEGER,
          input_tokens INTEGER,
          status TEXT NOT NULL CHECK (status IN ('answered', 'skipped')),
          skip_reason TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS jev_decisions_run_idx ON jev_decisions(run_id, created_at);
        CREATE INDEX IF NOT EXISTS jev_decisions_point_idx ON jev_decisions(point, created_at);
      `);
      if (!applied) this.db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`).run(version, new Date().toISOString());
    });
  }

  /** Memory lane Undo (ADR 0029 §5.6): the change set a lane save produced. Separate from memory_changes (its kind CHECK excludes lessons). */
  private applyLessonChangesMigration(): void {
    const version = "2026-10-04-lesson-changes";
    this.inTransaction(() => {
      const applied = this.db.prepare(`SELECT version FROM schema_migrations WHERE version = ?`).get<{ version: string }>(version);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS lesson_changes (
          change_id TEXT PRIMARY KEY,
          run_id TEXT,
          chat_id TEXT NOT NULL,
          new_id INTEGER NOT NULL,
          superseded_id INTEGER,
          pruned_ids TEXT NOT NULL,
          created_at TEXT NOT NULL,
          undone_at TEXT
        );
      `);
      if (!applied) this.db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`).run(version, new Date().toISOString());
    });
  }
```

- [ ] **Step 7: Add the types and methods**

`LessonSource` (`:374`): `export type LessonSource = "user_feedback" | "loop" | "migration" | "consolidation" | "lane";` — grep `LessonSource` for exhaustive switches (`rg "case \"consolidation\"" src`) and extend any you find the same way `loop` is handled.

Next to the `MemoryChange` types (`:882-898`) add the exported `JevDecisionRow`, `JevDecisionStatus`, `JevDecisionOutcome`, `LessonChange`, `LessonUndoResult` types exactly as in **Interfaces**. Then the methods, placed after `undoMemoryChangeTx`:

```ts
  // ── Jev decisions (ADR 0029 §3.4) ─────────────────────────────────────────

  insertJevDecision(row: Omit<JevDecisionRow, "decision_id" | "created_at" | "outcome_source" | "outcome_value"> & { created_at?: string }): string {
    const decision_id = `jd_${randomUUID()}`;
    this.db.prepare(`
      INSERT INTO jev_decisions (decision_id, run_id, point, question_id, criteria_hash, model_reported, state_hash, lang, answers_json, confidence,
        top_prob, margin, threshold_version, threshold_used, decision, latency_ms, input_tokens, status, skip_reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(decision_id, row.run_id, row.point, row.question_id, row.criteria_hash, row.model_reported, row.state_hash, row.lang, row.answers_json,
      row.confidence, row.top_prob, row.margin, row.threshold_version, row.threshold_used, row.decision, row.latency_ms, row.input_tokens,
      row.status, row.skip_reason, row.created_at ?? new Date().toISOString());
    return decision_id;
  }

  markJevDecision(decision_id: string, decision: JevDecisionOutcome, threshold_used: string | null): void {
    this.db.prepare(`UPDATE jev_decisions SET decision = ?, threshold_used = ? WHERE decision_id = ?`).run(decision, threshold_used, decision_id);
  }

  recordJevOutcome(decision_id: string, source: JevDecisionRow["outcome_source"], value: string): void {
    this.db.prepare(`UPDATE jev_decisions SET outcome_source = ?, outcome_value = ? WHERE decision_id = ?`).run(source, value, decision_id);
  }

  listJevDecisions(run_id: string): JevDecisionRow[] {
    return this.db.prepare(`SELECT * FROM jev_decisions WHERE run_id = ? ORDER BY rowid ASC`).all<JevDecisionRow>(run_id);
  }

  // ── Lesson changes: the memory lane's undoable change set (ADR 0029 §5.6) ──

  insertLessonChange(c: Omit<LessonChange, "change_id" | "created_at" | "undone_at"> & { created_at?: string }): LessonChange {
    const change: LessonChange = { change_id: `lc_${randomUUID()}`, run_id: c.run_id, chat_id: c.chat_id, new_id: c.new_id, superseded_id: c.superseded_id,
      pruned_ids: [...c.pruned_ids], created_at: c.created_at ?? new Date().toISOString(), undone_at: null };
    this.db.prepare(`INSERT INTO lesson_changes (change_id, run_id, chat_id, new_id, superseded_id, pruned_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(change.change_id, change.run_id, change.chat_id, change.new_id, change.superseded_id, JSON.stringify(change.pruned_ids), change.created_at);
    return change;
  }

  getLessonChange(change_id: string): LessonChange | undefined {
    const r = this.db.prepare(`SELECT * FROM lesson_changes WHERE change_id = ?`).get<Omit<LessonChange, "pruned_ids"> & { pruned_ids: string }>(change_id);
    return r ? { ...r, pruned_ids: JSON.parse(r.pruned_ids) as number[] } : undefined;
  }

  /** Only a pruned row comes back; a row that moved since (active or superseded) is left alone. */
  unpruneLesson(id: number): boolean {
    return this.db.prepare(`UPDATE lessons SET status = 'active' WHERE id = ? AND status = 'pruned'`).run(id).changes === 1;
  }

  /** Compare-and-set in one transaction: valid only while the new row is still active (spec §5.6). */
  undoLessonChange(change_id: string, now: string = new Date().toISOString()): LessonUndoResult {
    return this.inTransaction(() => {
      const change = this.getLessonChange(change_id);
      if (!change) return { status: "not_found" };
      if (change.undone_at !== null) return { status: "already_undone", change };
      if (this.getLesson(change.new_id)?.status !== "active") return { status: "changed_since", change };
      this.db.prepare(`UPDATE lesson_changes SET undone_at = ? WHERE change_id = ?`).run(now, change_id);
      this.db.prepare(`UPDATE lessons SET status = 'pruned' WHERE id = ? AND status = 'active'`).run(change.new_id);
      const restored: number[] = []; const skipped: number[] = [];
      if (change.superseded_id !== null) (this.reactivateLesson(change.superseded_id) ? restored : skipped).push(change.superseded_id);
      for (const id of change.pruned_ids) (this.unpruneLesson(id) ? restored : skipped).push(id);
      // the event rides the same transaction as the restore (spec §5.6); recordMemoryEvent opens no transaction of its own
      this.recordMemoryEvent("lesson_change_undone", { change_id, restored, skipped });
      return { status: "undone", change: { ...change, undone_at: now }, restored, skipped };
    });
  }

  // ── small readers for lane 1 ───────────────────────────────────────────────

  /** True when an "Ask Houge anyway" tap re-submitted this run: triage is skipped for it (the tap is the override label). */
  triageOverrideFor(run_id: string): boolean {
    const r = this.db.prepare(`SELECT 1 AS one FROM ledger_events WHERE event_type = 'triage_override' AND json_extract(payload_json, '$.new_run_id') = ? LIMIT 1`).get<{ one: number }>(run_id);
    return r !== undefined;
  }

  countRecentLedgerEvents(event_type: LedgerEventType, sinceIso: string): number {
    return this.db.prepare(`SELECT COUNT(*) AS n FROM ledger_events WHERE event_type = ? AND occurred_at >= ?`).get<{ n: number }>(event_type, sinceIso)?.n ?? 0;
  }

  userTurnTextForRun(run_id: string): string | undefined {
    return this.db.prepare(`SELECT text FROM chat_turns WHERE run_id = ? AND role = 'user' ORDER BY created_at ASC LIMIT 1`).get<{ text: string }>(run_id)?.text;
  }
```

`reactivateLesson` is at `:1373`; `randomUUID` is already imported in run-store (check the import block; add `import { randomUUID } from "node:crypto"` only if missing). `recordMemoryEvent(event_type, payload)` (`:6430`) is what the override test uses to write the ledger row.

- [ ] **Step 8: Run the store tests and typecheck**

Run: `npx vitest run tests/run/jev-decisions-store.test.ts tests/run/lesson-changes-store.test.ts tests/run/run-ledger.test.ts && npm run typecheck`
Expected: PASS, 0 type errors.

- [ ] **Step 9: Commit**

```bash
git add src/run/run-store.ts src/run/run-ledger.ts tests/run/jev-decisions-store.test.ts tests/run/lesson-changes-store.test.ts tests/run/run-ledger.test.ts
git commit -m "feat(store): jev_decisions and lesson_changes with compare-and-set undo; ADR 0029 ledger events"
```

---

### Task 5: `decide()` — request, call, validate, decision rows as data, skip reasons, incidents

**Files:**
- Create: `src/jev/decide.ts`
- Test: `tests/jev/decide.test.ts`

**Interfaces:**
- Consumes: client, Task 2 (`toJevQuestion`, `criteriaHash`), Task 4 (`insertJevDecision`), Task 1 (`openJevIncident`).
- Produces:
  ```ts
  export type SkipReason = "no_key" | "fused" | "auth" | "rate_limited" | "overloaded" | "malformed_question" | "timeout" | "parse" | "transport"
    | "state_too_large" | "disabled" | "posture" | "modality" | "override" | "error";
  export type DecisionPoint = "triage";
  export type JevDecisionInsert = Parameters<RunStore["insertJevDecision"]>[0];
  export interface DecideInput { point: DecisionPoint; run_id: string | null; state: Record<string, unknown>; questions: readonly Question[]; lang: Lang;
    client: (req: JevRequest) => Promise<JevResult>; store: RunStore; thresholdVersion: string; now?: () => Date; }
  export type Decision =
    | { status: "answered"; answers: Record<string, JevChoiceAnswer>; model: string; latency_ms: number; input_tokens: number; stateHash: string;
        rows: JevDecisionInsert[] }                 // NOT yet written: the caller persists them in ITS transaction (spec §3.4)
    | { status: "skipped"; reason: SkipReason };    // NOT written here either: the caller checks cancellation first, then calls recordSkip (Task 9 settleTriage)
  export async function decide(i: DecideInput): Promise<Decision>;
  export function persistDecisionRows(store: RunStore, rows: JevDecisionInsert[], decision: "act" | "fallback" | "shadow", threshold_used: string | null): string[]; // returns decision_ids; call inside inTransaction
  export function recordSkip(store: RunStore, point: DecisionPoint, run_id: string | null, lang: Lang, reason: SkipReason, now?: string): void;
  export function stateHash(state: unknown): string;
  export function marginOf(a: JevChoiceAnswer): number;
  ```

- [ ] **Step 1: Write the failing tests** — Rev 1's `tests/jev/decide.test.ts` with these changes: the first test asserts `d.rows` has three entries with `criteria_hash: criteriaHash(TRIAGE_QUESTIONS[0]!)`, `model_reported: JEV_MODEL`, `state_hash`, `top_prob`, `margin`, `status: "answered"`, `decision: null`, and that `store.listJevDecisions("run_1")` is **empty** until `persistDecisionRows(store, d.rows, "act", "v1:memory")` returns three ids and the rows read back with `decision: "act"`. The 429, no-key, parse and `recordSkip` cases are unchanged (skipped rows are written immediately).

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Create `src/jev/decide.ts`** — Rev 1's module with: no `model` argument to `criteriaHash`; the answered branch builds `rows` (one `JevDecisionInsert` per question, `decision: null`, `threshold_used: null`) and returns them; plus:

```ts
/** Inside the caller's transaction: the rows land with their final decision, next to the lane's own writes. */
export function persistDecisionRows(store: RunStore, rows: JevDecisionInsert[], decision: "act" | "fallback" | "shadow", threshold_used: string | null): string[] {
  return rows.map((r) => store.insertJevDecision({ ...r, decision, threshold_used }));
}
```

- [ ] **Step 4: Run, typecheck, commit**

```bash
git add src/jev/decide.ts tests/jev/decide.test.ts
git commit -m "feat(jev): decide() returns decision rows for the caller's transaction; every failure is a skip reason"
```

---

#### Rev 1 text retained for the code blocks referenced above (reference only; the Rev 2 steps above are the ones to execute)


**Files:**
- Create: `src/jev/decide.ts`
- Test: `tests/jev/decide.test.ts`

**Interfaces:**
- Consumes: `createJevClient`/`JevResult` (client), `Question`, `toJevQuestion`, `criteriaHash` (Task 2), `insertJevDecision`/`markJevDecision` (Task 4), `openJevIncident` (Task 1), `langOf`/`Lang`.
- Produces:
  ```ts
  export type SkipReason = "no_key" | "fused" | "auth" | "rate_limited" | "overloaded" | "malformed_question" | "timeout" | "parse" | "transport"
    | "state_too_large" | "disabled" | "posture" | "modality" | "override" | "error";
  export type DecisionPoint = "triage";
  export interface DecideInput { point: DecisionPoint; run_id: string | null; state: Record<string, unknown>; questions: readonly Question[]; lang: Lang;
    client: (req: JevRequest) => Promise<JevResult>; store: RunStore; thresholdVersion: string; now?: () => Date; }
  export type Decision =
    | { status: "answered"; answers: Record<string, JevChoiceAnswer>; model: string; latency_ms: number; input_tokens: number; decisionIds: Record<string, string>; stateHash: string }
    | { status: "skipped"; reason: SkipReason };
  export async function decide(i: DecideInput): Promise<Decision>;
  export function recordSkip(store: RunStore, point: DecisionPoint, run_id: string | null, lang: Lang, reason: SkipReason): void; // pre-call skips (disabled, posture, …)
  export function stateHash(state: unknown): string;
  export function marginOf(a: JevChoiceAnswer): number;  // p1 − p2
  ```

- [x] ~~Step 1: Write the failing tests**

Create `tests/jev/decide.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { JEV_MODEL, createJevClient } from "../../src/jev/jev-client.js";
import { decide, marginOf, recordSkip, stateHash } from "../../src/jev/decide.js";
import { TRIAGE_QUESTIONS } from "../../src/jev/questions/triage.js";
import { criteriaHash } from "../../src/jev/questions/types.js";
import { RunStore } from "../../src/run/run-store.js";
import { recordingSink } from "../helpers/llm-audit.js";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const choice = (choice: string, probabilities: Record<string, number>) => {
  const n = Object.keys(probabilities).length; const pMax = Math.max(...Object.values(probabilities));
  return { type: "choice", choice, probabilities, confidence: (pMax - 1 / n) / (1 - 1 / n) };
};
const okBody = () => ({ model: JEV_MODEL, usage: { input_tokens: 900, output_tokens: 0 }, answers: {
  lane: choice("memory", { none: 0.05, status: 0.05, memory: 0.9 }), complete: choice("pure", { mixed: 0.1, pure: 0.9 }), scope: choice("ask", { ask: 0.8, research: 0.2 }) } });
function setup(fetchImpl: typeof fetch, apiKey: string | undefined = "k") {
  const store = RunStore.openInMemory();
  const client = createJevClient({ apiKey, audit: recordingSink(), meteredBreached: () => false, retries: 0, timeoutMs: 1000, fetchImpl });
  return { store, client, input: { point: "triage" as const, run_id: "run_1", state: { latest_message: "x" }, questions: TRIAGE_QUESTIONS, lang: "zh" as const, client, store, thresholdVersion: "v1" } };
}

// Spec §3.2/§3.4: decide() never applies a threshold; it writes one row per question with the numbers a replay needs.
describe("decide", () => {
  it("answers and writes one row per question with hash, state hash, confidence, top_prob and margin", async () => {
    const { store, input } = setup(vi.fn(async () => json(200, okBody())) as unknown as typeof fetch);
    const d = await decide(input);
    expect(d.status).toBe("answered");
    if (d.status !== "answered") return;
    const rows = store.listJevDecisions("run_1");
    expect(rows.map((r) => r.question_id)).toEqual(["lane", "complete", "scope"]);
    expect(rows[0]).toMatchObject({ criteria_hash: criteriaHash(TRIAGE_QUESTIONS[0]!), model_reported: JEV_MODEL, state_hash: stateHash({ latest_message: "x" }),
      top_prob: 0.9, status: "answered", threshold_version: "v1", decision: null, input_tokens: 900 });
    expect(rows[0]!.margin).toBeCloseTo(0.85, 5);
    expect(d.decisionIds.lane).toBe(rows[0]!.decision_id);
    expect(rows[0]!.answers_json).not.toContain("latest_message"); // numbers only
    store.close();
  });
  it("returns skipped without writing a row (the caller persists after its cancellation check) and opens the incident on a 429", async () => {
    const { store, input } = setup(vi.fn(async () => json(429, {})) as unknown as typeof fetch);
    const d = await decide(input);
    expect(d).toEqual({ status: "skipped", reason: "rate_limited" });
    expect(store.listJevDecisions("run_1")).toHaveLength(0);
    expect(store.listOpenIncidents().some((i) => i.kind === "jev_rate_limited")).toBe(true);
    recordSkip(store, "triage", "run_1", "zh", "rate_limited");
    expect(store.listJevDecisions("run_1")).toMatchObject([{ status: "skipped", skip_reason: "rate_limited", question_id: null }]);
    store.close();
  });
  it("no key is skipped{no_key} with the jev_no_key incident, never a fetch", async () => {
    const fetchImpl = vi.fn();
    const { store, input } = setup(fetchImpl as unknown as typeof fetch, undefined);
    expect(await decide(input)).toEqual({ status: "skipped", reason: "no_key" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.listOpenIncidents().some((i) => i.kind === "jev_no_key")).toBe(true);
    store.close();
  });
  it("a malformed response is skipped as parse with no incident (per-call noise, visible in rows)", async () => {
    const { store, input } = setup(vi.fn(async () => json(200, { model: JEV_MODEL, answers: {}, usage: { input_tokens: 1 } })) as unknown as typeof fetch);
    expect(await decide(input)).toEqual({ status: "skipped", reason: "parse" });
    expect(store.listOpenIncidents()).toHaveLength(0);
    store.close();
  });
  it("recordSkip writes the pre-call skipped row for disabled/posture/modality", () => {
    const store = RunStore.openInMemory();
    recordSkip(store, "triage", "run_9", "en", "posture");
    expect(store.listJevDecisions("run_9")).toMatchObject([{ status: "skipped", skip_reason: "posture", lang: "en", point: "triage" }]);
    store.close();
  });
  it("marginOf is p1 − p2 over the two largest probabilities", () => {
    expect(marginOf({ choice: "a", probabilities: { a: 0.5, b: 0.3, c: 0.2 }, confidence: 0 })).toBeCloseTo(0.2, 9);
  });
});
```

- [x] ~~Step 2: Run to verify they fail**

Run: `npx vitest run tests/jev/decide.test.ts`
Expected: FAIL — module not found.

- [x] ~~Step 3: Create `src/jev/decide.ts`**

```ts
import { createHash } from "node:crypto";
import type { RunStore } from "../run/run-store.js";
import type { Lang } from "./intent-question.js";
import type { JevChoiceAnswer, JevRequest, JevResult } from "./jev-client.js";
import { openJevIncident } from "./jev-incidents.js";
import { criteriaHash, toJevQuestion, type Question } from "./questions/types.js";

/**
 * The one way Houge asks Jev (ADR 0029 §3.2). Builds the request, calls, validates, writes the decision rows and
 * returns the answers. It NEVER applies a threshold: the caller's code does, so every lane's gate is readable in one
 * place. Every failure is a `skipped` row with an enum reason; the caller treats it as "no answer" = today's path.
 */
export type SkipReason =
  | "no_key" | "fused" | "auth" | "rate_limited" | "overloaded" | "malformed_question" | "timeout" | "parse" | "transport"
  | "state_too_large" | "disabled" | "posture" | "modality" | "override" | "error";
export type DecisionPoint = "triage";

export interface DecideInput {
  point: DecisionPoint;
  run_id: string | null;
  state: Record<string, unknown>;
  questions: readonly Question[];
  lang: Lang;
  client: (req: JevRequest) => Promise<JevResult>;
  store: RunStore;
  thresholdVersion: string;
  now?: () => Date;
}
export type Decision =
  | { status: "answered"; answers: Record<string, JevChoiceAnswer>; model: string; latency_ms: number; input_tokens: number; decisionIds: Record<string, string>; stateHash: string }
  | { status: "skipped"; reason: SkipReason };

export function stateHash(state: unknown): string {
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

/** p1 − p2: the gap between the top two options, a steadier signal than confidence when n > 2. */
export function marginOf(a: JevChoiceAnswer): number {
  const sorted = Object.values(a.probabilities).sort((x, y) => y - x);
  return (sorted[0] ?? 0) - (sorted[1] ?? 0);
}

function skipReasonOf(r: Extract<JevResult, { ok: false }>): SkipReason {
  if (r.reason === "no_key" || r.reason === "fused" || r.reason === "auth") return r.reason;
  switch (r.error_kind) {
    case "rate_limited": case "overloaded": case "malformed_question": case "timeout": case "parse": case "transport": return r.error_kind;
    default: return "error";
  }
}

export function recordSkip(store: RunStore, point: DecisionPoint, run_id: string | null, lang: Lang, reason: SkipReason, now?: string): void {
  store.insertJevDecision({ run_id, point, question_id: null, criteria_hash: null, model_reported: null, state_hash: null, lang, answers_json: null,
    confidence: null, top_prob: null, margin: null, threshold_version: null, threshold_used: null, decision: null, latency_ms: null, input_tokens: null,
    status: "skipped", skip_reason: reason, ...(now ? { created_at: now } : {}) });
}

export async function decide(i: DecideInput): Promise<Decision> {
  const questions: Record<string, ReturnType<typeof toJevQuestion>> = {};
  for (const q of i.questions) questions[q.id] = toJevQuestion(q);
  const r = await i.client({ state: i.state, questions });
  const now = i.now?.().toISOString();
  if (!r.ok) {
    // No row here: the caller persists the skip after its cancellation check (a lost turn writes nothing late).
    // The incident is not a row and may open regardless: an outage is an outage even if this turn ended.
    openJevIncident(i.store, r, { point: i.point, run_id: i.run_id });
    return { status: "skipped", reason: skipReasonOf(r) };
  }
  const sh = stateHash(i.state);
  const decisionIds: Record<string, string> = {};
  for (const q of i.questions) {
    const a = r.answers[q.id];
    if (!a) continue; // validated by the client: every requested id is present
    decisionIds[q.id] = i.store.insertJevDecision({
      run_id: i.run_id, point: i.point, question_id: q.id, criteria_hash: criteriaHash(q, r.model), model_reported: r.model, state_hash: sh, lang: i.lang,
      answers_json: JSON.stringify(a.probabilities), confidence: a.confidence, top_prob: Math.max(...Object.values(a.probabilities)), margin: marginOf(a),
      threshold_version: i.thresholdVersion, threshold_used: null, decision: null, latency_ms: r.latency_ms, input_tokens: r.input_tokens,
      status: "answered", skip_reason: null, ...(now ? { created_at: now } : {})
    });
  }
  return { status: "answered", answers: r.answers, model: r.model, latency_ms: r.latency_ms, input_tokens: r.input_tokens, decisionIds, stateHash: sh };
}
```

Note: `criteriaHash(q, r.model)` keys the row to the **reported** model, so a silent `jev-latest` move shows up as an uncalibrated hash (Task 3's `calibratedLang` then falls through) — exactly the spec's intent.

- [x] ~~Step 4: Run the tests**

Run: `npx vitest run tests/jev/decide.test.ts && npm run typecheck`
Expected: PASS.

- [x] ~~Step 5: Commit**

```bash
git add src/jev/decide.ts tests/jev/decide.test.ts
git commit -m "feat(jev): decide() writes replayable decision rows and maps every failure to a skip reason"
```

---

---
### Task 6: Flags — master, lane mode, persisted disarm marker

**Files:**
- Create: `src/jev/jev-flags.ts`
- Modify: `src/config/disarm-posture.ts:33` (`DISARM_FLAGS`)
- Test: `tests/jev/jev-flags.test.ts`, `tests/config/disarm-posture.test.ts` (extend, or wherever `DISARM_FLAGS` is asserted)

**Interfaces:**
- Produces:
  ```ts
  export type JevTriageMode = "off" | "shadow" | "arm";
  export function resolveJevEnabled(env: NodeJS.ProcessEnv): boolean;                 // HOUGE_JEV_ENABLED: 1/true/yes/on; default off
  export function resolveJevTriageMode(env: NodeJS.ProcessEnv, dataDir: string): JevTriageMode; // off unless master on; "false"/"0"/"off"/missing → off; marker caps at shadow
  export function jevDisarmMarkerPath(env: NodeJS.ProcessEnv, dataDir: string): string;   // HOUGE_JEV_DISARM_PATH ?? <dataDir>/houge.jev-disarmed
  export function writeJevDisarmMarker(path: string, reason: string, now?: string): void; // JSON {reason, at}; re-arm = Paco deletes the file
  export function readJevDisarmMarker(path: string): { reason: string; at: string } | null;
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/jev/jev-flags.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { jevDisarmMarkerPath, readJevDisarmMarker, resolveJevEnabled, resolveJevTriageMode, writeJevDisarmMarker } from "../../src/jev/jev-flags.js";
import { DISARM_FLAGS } from "../../src/config/disarm-posture.js";

// Spec §3.8: default off; /disarm (which writes "false") must switch the lane off; the auto-disable marker
// (triage_overrides) caps the lane at shadow and only Paco's hand (deleting the file) re-arms it.
describe("jev flags", () => {
  const dir = mkdtempSync(join(tmpdir(), "jevflags-"));
  afterEach(() => rmSync(join(dir, "houge.jev-disarmed"), { force: true }));
  it("is off by default and off when the master is off, whatever the lane flag says", () => {
    expect(resolveJevEnabled({})).toBe(false);
    expect(resolveJevTriageMode({ HOUGE_JEV_TRIAGE_ENABLED: "arm" }, dir)).toBe("off");
    expect(resolveJevTriageMode({ HOUGE_JEV_ENABLED: "false", HOUGE_JEV_TRIAGE_ENABLED: "arm" }, dir)).toBe("off");
  });
  it("reads off|shadow|arm, treats /disarm's 'false' as off, and lists the master in DISARM_FLAGS", () => {
    expect(resolveJevTriageMode({ HOUGE_JEV_ENABLED: "1", HOUGE_JEV_TRIAGE_ENABLED: "shadow" }, dir)).toBe("shadow");
    expect(resolveJevTriageMode({ HOUGE_JEV_ENABLED: "1", HOUGE_JEV_TRIAGE_ENABLED: "arm" }, dir)).toBe("arm");
    expect(resolveJevTriageMode({ HOUGE_JEV_ENABLED: "1", HOUGE_JEV_TRIAGE_ENABLED: "false" }, dir)).toBe("off");
    expect(resolveJevTriageMode({ HOUGE_JEV_ENABLED: "1", HOUGE_JEV_TRIAGE_ENABLED: "banana" }, dir)).toBe("off");
    expect(DISARM_FLAGS).toContain("HOUGE_JEV_ENABLED");
  });
  it("the persisted marker caps arm at shadow until deleted", () => {
    const p = jevDisarmMarkerPath({}, dir);
    writeJevDisarmMarker(p, "triage_overrides", "2026-10-04T00:00:00.000Z");
    expect(readJevDisarmMarker(p)).toEqual({ reason: "triage_overrides", at: "2026-10-04T00:00:00.000Z" });
    expect(resolveJevTriageMode({ HOUGE_JEV_ENABLED: "1", HOUGE_JEV_TRIAGE_ENABLED: "arm" }, dir)).toBe("shadow");
    rmSync(p);
    expect(resolveJevTriageMode({ HOUGE_JEV_ENABLED: "1", HOUGE_JEV_TRIAGE_ENABLED: "arm" }, dir)).toBe("arm");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/jev/jev-flags.test.ts`
Expected: FAIL — module not found; `DISARM_FLAGS` lacks the master.

- [ ] **Step 3: Create `src/jev/jev-flags.ts` and extend `DISARM_FLAGS`**

```ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Jev System One flags (ADR 0029 §3.8). Master + one tri-state flag per lane; everything defaults OFF. */
export type JevTriageMode = "off" | "shadow" | "arm";
export const JEV_DISARM_MARKER = "houge.jev-disarmed";

const ON = new Set(["1", "true", "yes", "on"]);

export function resolveJevEnabled(env: NodeJS.ProcessEnv): boolean {
  return ON.has(env.HOUGE_JEV_ENABLED?.trim().toLowerCase() ?? "");
}

/** `/disarm` writes "false" into every DISARM_FLAGS entry; the lane flag reads any non-mode value as off. */
export function resolveJevTriageMode(env: NodeJS.ProcessEnv, dataDir: string): JevTriageMode {
  if (!resolveJevEnabled(env)) return "off";
  const raw = env.HOUGE_JEV_TRIAGE_ENABLED?.trim().toLowerCase();
  const mode: JevTriageMode = raw === "shadow" || raw === "arm" ? raw : "off";
  // The auto-disable marker (spec §5.8 triage_overrides, §3.7 drift) caps an armed lane at shadow; only Paco deletes it.
  // A calibration FILE is for gates only: outside HOUGE_JEV_GATE=1 it caps the lane at shadow too (arming sequence, Task 3).
  const fileOutsideGate = Boolean(env.HOUGE_JEV_CALIBRATION_FILE?.trim()) && env.HOUGE_JEV_GATE !== "1";
  return mode === "arm" && (fileOutsideGate || readJevDisarmMarker(jevDisarmMarkerPath(env, dataDir))) ? "shadow" : mode;
}

export function jevDisarmMarkerPath(env: NodeJS.ProcessEnv, dataDir: string): string {
  return env.HOUGE_JEV_DISARM_PATH?.trim() || join(dataDir, JEV_DISARM_MARKER);
}

export function writeJevDisarmMarker(path: string, reason: string, now: string = new Date().toISOString()): void {
  writeFileSync(path, JSON.stringify({ reason, at: now }), { mode: 0o600 });
}

export function readJevDisarmMarker(path: string): { reason: string; at: string } | null {
  if (!existsSync(path)) return null;
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as { reason?: unknown; at?: unknown };
    return { reason: typeof v.reason === "string" ? v.reason : "unknown", at: typeof v.at === "string" ? v.at : "" };
  } catch {
    return { reason: "unreadable", at: "" }; // an unreadable marker still disarms: fail toward today
  }
}
```

`src/config/disarm-posture.ts:33`: add `"HOUGE_JEV_ENABLED"` to `DISARM_FLAGS` with the comment `// Jev System One master (ADR 0029): /disarm switches every Jev lane off in one write.`

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run tests/jev/jev-flags.test.ts tests/config && npm run typecheck`
Expected: PASS (if a disarm-posture test asserts the exact `DISARM_FLAGS` list, update it to include the new flag and say why in the assertion message).

- [ ] **Step 5: Commit**

```bash
git add src/jev/jev-flags.ts src/config/disarm-posture.ts tests/jev/jev-flags.test.ts tests/config
git commit -m "feat(jev): master and lane flags, persisted disarm marker caps arm at shadow"
```

---

### Task 7: Lesson-write service — extract `runLessonWrite`, split reconcile from save, already-saved guard, abort-aware

**Files:**
- Modify: `src/capabilities/lesson-write.ts:31-71` (config + early check)
- Modify: `src/core/core-worker.ts:990-1004`, `:2524-2561`, `OmpTurnState` (`:208-215`)
- Test: `tests/capabilities/lesson-write.test.ts` (extend), `tests/core/core-worker-lesson-service.test.ts` (new)

**Interfaces:**
- Produces:
  ```ts
  // lesson-write.ts
  export interface LessonWriteAdapterConfig { …existing…; alreadySaved?: { id: number } }
  export const ALREADY_SAVED_REASON = "already_saved_this_turn";
  // core-worker.ts
  interface OmpTurnState { …existing…; lessonSavedThisTurn?: { id: number; theme: string; change_id: string } }
  export interface LessonWriteOutcome { result: ToolAdapterResult; saved?: LessonSaveResult & { id: number }; change_id?: string; theme?: string }
  export interface LessonWriteOptions { source: "loop" | "lane"; signal?: AbortSignal; inTx?: (saved: LessonSaveResult, change_id: string) => void }
  runLessonWrite(claim: ClaimedRun, chatId: string, input: Record<string, unknown>, o: LessonWriteOptions): Promise<LessonWriteOutcome>;
  private reconcileLessonVerdict(candidate, llm): Promise<{ verdict: LessonReconcileVerdict; theme: string; themeKnown: boolean }>;
  private saveLessonVerdict(candidate, r, source, now): LessonSaveResult;   // sync; callers wrap it in inTransaction
  ```
  `inTx` runs **inside** the save transaction after the lesson, its `lesson_changes` row and the `lesson_saved` event are written — the lane uses it to land its decision rows and the `triage` event atomically with the save (spec §3.4). `signal` (the turn's abort signal) and the state-identity check make a save impossible after the turn ended.

- [ ] **Step 1: Adapter guard test** — Rev 1 Step 1 unchanged.

- [ ] **Step 2: Add the guard** — Rev 1 Step 3 unchanged.

- [ ] **Step 3: Write the failing service tests**

`tests/core/core-worker-lesson-service.test.ts` — Rev 1's two cases (the distill/reconcile stub keyed on `/durable/i.test(system)` is valid: `DISTILL_DISCIPLINE` contains "durable", `RECONCILE_DISCIPLINE` does not) with these additions:

```ts
it("the voice transcript, not the placeholder objective, is the feedback anchor (loop caller parity)", async () => {
  // resolveOmpMessage sets state.objective for voice (core-worker.ts:2236); the service must read it like ompLoopExecute does (:2198)
  const seen: string[] = [];
  const llm = async (input: Record<string, unknown>) => { seen.push(String(input.question)); return { ok: true as const, output: { answer: JSON.stringify({ durable: false }) } }; };
  const store = RunStore.openInMemory(); const worker = ompWorker(store, mkdtempSync(join(tmpdir(), "hls-")), { llm });
  const run_id = createQueuedTurnRun(store, "[voice]"); const claim = store.claimRun(run_id, "w", 120)!;
  worker.buildOmpTools(claim, "555"); worker.setOmpObjectiveForTest(run_id, "以后回复短一点");
  await worker.runLessonWrite(claim, "555", { scope: "ask" }, { source: "loop" });
  expect(seen[0]).toContain("以后回复短一点"); expect(seen[0]).not.toContain("[voice]");
  store.close();
});
it("inTx runs inside the save transaction; a throwing hook rolls the lesson back and leaves no guard", async () => {
  const store = RunStore.openInMemory(); const worker = ompWorker(store, mkdtempSync(join(tmpdir(), "hls-")), { llm: distillThenReconcile({
    durable: JSON.stringify({ durable: true, lesson: "Keep replies short." }), reconcile: JSON.stringify({ verdict: "ADD", theme: "format" }) }) });
  const run_id = createQueuedTurnRun(store, "以后回复短一点"); const claim = store.claimRun(run_id, "w", 120)!; worker.buildOmpTools(claim, "555");
  const out = await worker.runLessonWrite(claim, "555", { scope: "ask" }, { source: "lane", inTx: () => { throw new Error("boom"); } });
  expect(out.result.ok).toBe(false); expect(out.committed).toBe(false);
  expect(store.getActiveLessons("ask")).toHaveLength(0);
  expect(store.getLedgerEvents().filter((e) => e.event_type === "lesson_saved")).toHaveLength(0);
  const again = await worker.runLessonWrite(claim, "555", { scope: "ask" }, { source: "loop" });
  expect(again.result.ok && (again.result.output as { reason?: string }).reason).not.toBe("already_saved_this_turn"); // guard was never set
  store.close();
});
it("no save after the turn is gone: an aborted signal or a replaced turn state yields drop and writes nothing", async () => {
  const store = RunStore.openInMemory(); const worker = ompWorker(store, mkdtempSync(join(tmpdir(), "hls-")), { llm: distillThenReconcile({
    durable: JSON.stringify({ durable: true, lesson: "Keep replies short." }), reconcile: JSON.stringify({ verdict: "ADD", theme: "format" }) }) });
  const run_id = createQueuedTurnRun(store, "以后回复短一点"); const claim = store.claimRun(run_id, "w", 120)!; worker.buildOmpTools(claim, "555");
  const ac = new AbortController(); ac.abort();
  const out = await worker.runLessonWrite(claim, "555", { scope: "ask" }, { source: "lane", signal: ac.signal });
  expect(out.saved).toBeUndefined(); expect(store.getActiveLessons("ask")).toHaveLength(0);
  store.close();
});
```

`setOmpObjectiveForTest(run_id, text)` is a one-line `@internal` test hook on CoreWorker that sets `this.ompTurns.get(run_id)!.objective = text` (the same field `resolveOmpMessage` sets).

- [ ] **Step 4: Run to verify they fail.**

- [ ] **Step 5: Implement**

`OmpTurnState` gains `lessonSavedThisTurn?: { id: number; theme: string; change_id: string }`. The reconcile/save split is Rev 1's (`reconcileLessonVerdict`, `saveLessonVerdict`, `reconcileAndSaveLesson` composition for the `user_feedback` callers). The service:

```ts
export interface LessonWriteOutcome { result: ToolAdapterResult; saved?: LessonSaveResult & { id: number }; change_id?: string; theme?: string; committed: boolean }
export interface LessonWriteOptions { source: "loop" | "lane"; signal?: AbortSignal; inTx?: (saved: LessonSaveResult, change_id: string) => void }

  /**
   * ONE lesson-write pipeline for both callers (ADR 0029 §5.5): the `lesson_write` loop tool (source "loop") and the
   * memory lane ("lane"). Trust anchors: the effective objective (a voice transcript when there is one, else the
   * claim objective) and the real prior answer — never the planner's or Jev's text. The save, its lesson_changes row,
   * the lesson_saved event and the caller's `inTx` writes land in one transaction; the in-memory guard is set only
   * after that transaction committed. A turn that ended (abort signal, or its state replaced) can no longer save.
   */
  async runLessonWrite(claim: ClaimedRun, chatId: string, input: Record<string, unknown>, o: LessonWriteOptions): Promise<LessonWriteOutcome> {
    const state = this.ompTurns.get(claim.run_id);
    if (!state) return { result: { ok: false, error: "no turn state for this run" }, committed: false };
    const outcome: LessonWriteOutcome = { result: { ok: false, error: "lesson write did not run" }, committed: false };
    const adapter = createLessonWriteAdapter({
      feedback: state.objective ?? claim.contract.objective,
      priorAnswer: state.anchor.priorAnswer, allowedScopes: ["ask", "research"], defaultScope: state.anchor.defaultScope,
      llm: (i) => this.llmAdapterFor(claim.run_id, LESSON_WRITE_ROLES.distill)(i),
      scheduledRun: this.runStore.runSource(claim.run_id) === "schedule",
      srcContains: createSrcPhraseChecker(this.projectRoot),
      threadUserTexts: [...state.turnCtx.recentTurns].reverse().filter((t) => t.role === "user" && this.runStore.runSource(t.run_id) !== "schedule").map((t) => t.text),
      ...(state.lessonSavedThisTurn ? { alreadySaved: { id: state.lessonSavedThisTurn.id } } : {}),
      saveLesson: (candidate, now) => this.saveForTurn(claim, chatId, state, candidate, now, o, outcome)
    });
    outcome.result = await adapter(input);
    return outcome;
  }

  private async saveForTurn(claim: ClaimedRun, chatId: string, state: OmpTurnState, candidate: { scope: string; text: string; avoid?: string }, now: string,
    o: LessonWriteOptions, outcome: LessonWriteOutcome): Promise<LessonSaveResult> {
    const r = await this.reconcileLessonVerdict(candidate, async (i) => {
      const a = await this.llmAdapterFor(claim.run_id, LESSON_WRITE_ROLES.reconcile)(i);
      return a.ok && typeof a.output.answer === "string" ? { ok: true, answer: a.output.answer } : { ok: false };
    });
    // The turn ended while Kimi was thinking: nothing durable may land on a finished run (spec §5.1).
    if (o.signal?.aborted || this.ompTurns.get(claim.run_id) !== state) return { verb: "drop", lesson: candidate.text, prunedIds: [] };
    let change_id: string | undefined;
    const saved = this.runStore.inTransaction(() => {
      const s = this.saveLessonVerdict(candidate, r, o.source, now);
      if (s.id === undefined) return s;
      const change = this.runStore.insertLessonChange({ run_id: claim.run_id, chat_id: chatId, new_id: s.id, superseded_id: s.supersededId ?? null, pruned_ids: s.prunedIds, created_at: now });
      change_id = change.change_id;
      this.runStore.appendRunLedgerEvent(claim.run_id, "lesson_saved", "core", { lesson_id: s.id, change_id: change.change_id, source: o.source });
      o.inTx?.(s, change.change_id);
      return s;
    });
    // `inTransaction` returned: only now is anything committed. `inTx` must not mutate in-memory state — a rolled-back
    // hook is a failed save and `outcome.committed` stays false.
    if (saved.id !== undefined && change_id) {
      state.lessonSavedThisTurn = { id: saved.id, theme: r.theme, change_id };
      Object.assign(outcome, { saved: saved as LessonSaveResult & { id: number }, change_id, theme: r.theme, committed: true });
    }
    return saved;
  }
```

The loop-tool branch: `return async (input) => (await this.runLessonWrite(claim, this.chatOf(claim.run_id), input, { source: "loop" })).result;`. `inTransaction` requires a synchronous callback (`run-store.ts:4090`); the reconcile `await` is outside it and none of the inner store calls opens a transaction (checked: `saveReconciledLesson`, `addLesson`, `pruneScopeOverflow`, `recordMemoryEvent`, `appendLedgerEvent` — no `BEGIN`). A throwing `inTx` rolls everything back and the guard stays unset.

- [ ] **Step 6: Run, typecheck, commit**

```bash
git add src/capabilities/lesson-write.ts src/core/core-worker.ts tests/capabilities/lesson-write.test.ts tests/core/core-worker-lesson-service.test.ts
git commit -m "refactor(core): one lesson-write service for the loop tool and the memory lane; atomic save, already-saved guard, abort-aware"
```

---

#### Rev 1 text retained for the code blocks referenced above (reference only; the Rev 2 steps above are the ones to execute)


**Files:**
- Modify: `src/capabilities/lesson-write.ts:31-71` (config) and the adapter's early checks
- Modify: `src/core/core-worker.ts:990-1004` (`reconcileAndSaveLesson`), `:2524-2561` (`lesson_write` branch), `OmpTurnState` (`:208-215`)
- Test: `tests/capabilities/lesson-write.test.ts` (extend; find the existing file for `createLessonWriteAdapter`), `tests/core/core-worker-lesson-service.test.ts` (new)

**Interfaces:**
- Consumes: `insertLessonChange`, `LessonSource "lane"` (Task 4).
- Produces:
  ```ts
  // lesson-write.ts
  export interface LessonWriteAdapterConfig { …existing…; alreadySaved?: { id: number } }
  export const ALREADY_SAVED_REASON = "already_saved_this_turn";
  // core-worker.ts
  interface OmpTurnState { …existing…; lessonSavedThisTurn?: { id: number; theme: string; change_id: string } }
  export interface LessonWriteOutcome { result: ToolAdapterResult; saved?: LessonSaveResult; change_id?: string; theme?: string }
  // CoreWorker (public for tests; called by the loop tool and the lane)
  runLessonWrite(claim: ClaimedRun, chatId: string, input: Record<string, unknown>, source: "loop" | "lane"): Promise<LessonWriteOutcome>;
  private reconcileLessonVerdict(candidate, llm): Promise<{ verdict: LessonReconcileVerdict; theme: string; themeKnown: boolean }>;
  private saveLessonVerdict(candidate, r, source, now): LessonSaveResult;   // sync; callers wrap it in inTransaction
  ```

- [x] ~~Step 1: Write the failing adapter test**

Append to the existing `createLessonWriteAdapter` test file (`rg -l createLessonWriteAdapter tests/`):

```ts
it("returns the already-saved digest before any LLM call when the turn already saved a lesson (spec §5.5)", async () => {
  const llm = vi.fn();
  const saveLesson = vi.fn();
  const adapter = createLessonWriteAdapter({ feedback: "以后回复短一点", priorAnswer: "…", allowedScopes: ["ask", "research"], defaultScope: "ask",
    llm, saveLesson, alreadySaved: { id: 51 } });
  const r = await adapter({ scope: "ask" });
  expect(r).toEqual({ ok: true, output: { saved: false, reason: "already_saved_this_turn", lesson_id: 51 } });
  expect(llm).not.toHaveBeenCalled();
  expect(saveLesson).not.toHaveBeenCalled();
});
```

- [x] ~~Step 2: Run to verify it fails**

Run: `npx vitest run tests/capabilities/lesson-write.test.ts`
Expected: FAIL — `alreadySaved` unknown / LLM called.

- [x] ~~Step 3: Add the guard to the adapter**

`src/capabilities/lesson-write.ts`: add to `LessonWriteAdapterConfig`:

```ts
  /**
   * Memory lane (ADR 0029 §5.5): the lane already saved from this turn's message. A planner `lesson_write` in the same
   * turn gets this digest and spends nothing — no second row, no UPDATE superseding the card's lesson.
   */
  alreadySaved?: { id: number };
```

and `export const ALREADY_SAVED_REASON = "already_saved_this_turn";`. In the adapter body, right after the `scheduledRun` check and before the empty-feedback check:

```ts
    if (config.alreadySaved) {
      return { ok: true, output: { saved: false, reason: ALREADY_SAVED_REASON, lesson_id: config.alreadySaved.id } };
    }
```

- [x] ~~Step 4: Write the failing service test**

Create `tests/core/core-worker-lesson-service.test.ts`. Use the omp-path harness `ompWorker(store, root, { llm })` from `tests/helpers/omp-worker.ts` and `createQueuedTurnRun(store, text)` from `tests/helpers/runs.ts`; the injected `llm` answers both the distill and the reconcile prompts (look at `tests/core/core-worker-omp-tools.test.ts` for how an existing test drives `lesson_write` through the loop tool and copy its distill/reconcile JSON answers).

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RunStore } from "../../src/run/run-store.js";
import { createQueuedTurnRun } from "../helpers/runs.js";
import { ompWorker } from "../helpers/omp-worker.js";

// Spec §5.5: ONE pipeline for the loop tool and the lane; the lane's save leaves a lesson_changes row and a
// lesson_saved ledger event in the same transaction as the lesson; a second write in the turn is refused by code.
const distillThenReconcile = (answers: { durable: string; reconcile: string }) => async (input: Record<string, unknown>) => {
  const q = String(input.question ?? "");
  const answer = /durable/i.test(String(input.system ?? "")) ? answers.durable : answers.reconcile;
  return { ok: true as const, output: { answer } };
};

describe("CoreWorker.runLessonWrite", () => {
  it("source 'lane' saves through reconcile, records lesson_changes + lesson_saved, and sets lessonSavedThisTurn", async () => {
    const store = RunStore.openInMemory();
    const root = mkdtempSync(join(tmpdir(), "hls-"));
    const worker = ompWorker(store, root, { llm: distillThenReconcile({
      durable: JSON.stringify({ durable: true, lesson: "Keep replies short.", avoid: "Long preambles" }),
      reconcile: JSON.stringify({ verdict: "ADD", theme: "format" }) }) });
    const run_id = createQueuedTurnRun(store, "以后回复短一点");
    const claim = store.claimRun(run_id, "w", 120)!;
    worker.buildOmpTools(claim, "555"); // creates the OmpTurnState the service reads
    const out = await worker.runLessonWrite(claim, "555", { scope: "ask" }, "lane");
    expect(out.result.ok).toBe(true);
    expect(out.saved?.id).toBeDefined();
    expect(out.change_id).toMatch(/^lc_/);
    expect(store.getLessonChange(out.change_id!)).toMatchObject({ new_id: out.saved!.id, chat_id: "555", run_id });
    expect(store.getLedgerEvents().some((e) => e.event_type === "lesson_saved" && e.payload.change_id === out.change_id && e.payload.source === "lane")).toBe(true);
    expect(store.getLesson(out.saved!.id!)?.source).toBe("lane");
    // second call in the same turn: the adapter-level guard, zero LLM calls
    const again = await worker.runLessonWrite(claim, "555", { scope: "ask" }, "loop");
    expect(again.result).toEqual({ ok: true, output: { saved: false, reason: "already_saved_this_turn", lesson_id: out.saved!.id } });
    store.close();
  });
  it("the loop tool path is unchanged for the planner (source 'loop', same gates)", async () => {
    const store = RunStore.openInMemory();
    const root = mkdtempSync(join(tmpdir(), "hls-"));
    const worker = ompWorker(store, root, { llm: distillThenReconcile({ durable: JSON.stringify({ durable: false }), reconcile: "{}" }) });
    const run_id = createQueuedTurnRun(store, "谢谢");
    const claim = store.claimRun(run_id, "w", 120)!;
    worker.buildOmpTools(claim, "555");
    const out = await worker.runLessonWrite(claim, "555", { scope: "ask" }, "loop");
    expect(out.result.ok && (out.result.output as { saved: boolean }).saved).toBe(false);
    expect(out.change_id).toBeUndefined();
    expect(store.getLedgerEvents().filter((e) => e.event_type === "lesson_saved")).toHaveLength(0);
    store.close();
  });
});
```

If `getLedgerEvents()` is not the reader's name, use the one `tests/run/run-ledger.test.ts` uses. If the distill discipline string does not contain "durable", key the stub on the question instead (the distill question contains the feedback text; the reconcile question contains `#` ids or "candidate").

- [x] ~~Step 5: Run to verify it fails**

Run: `npx vitest run tests/core/core-worker-lesson-service.test.ts`
Expected: FAIL — `runLessonWrite` is not a function.

- [x] ~~Step 6: Split reconcile from save and add the service**

In `src/core/core-worker.ts`:

1. `OmpTurnState` gains `lessonSavedThisTurn?: { id: number; theme: string; change_id: string };`.
2. Replace `reconcileAndSaveLesson` (`:990-1004`) by three methods; the first two are the split, the third keeps the old name for its `user_feedback` callers (`:1790, 1825, 1838`), unchanged behaviour:

```ts
  private async reconcileLessonVerdict(
    candidate: { scope: string; text: string; avoid?: string },
    llm: (input: { question: string; system: string }) => Promise<{ ok: true; answer: string } | { ok: false }>
  ): Promise<{ verdict: LessonReconcileVerdict; theme: string; themeKnown: boolean }> {
    const scopes = [...new Set([candidate.scope, ...OMP_LESSON_SCOPES])];
    const existing = scopes.flatMap((scope) => this.runStore.getActiveLessons(scope));
    return reconcileLesson({ candidate, existing, llm });
  }

  /** Synchronous: callers that need the save atomic with their own rows wrap it in `runStore.inTransaction`. */
  private saveLessonVerdict(
    candidate: { scope: string; text: string; avoid?: string },
    r: { verdict: LessonReconcileVerdict; theme: string; themeKnown: boolean },
    source: LessonSource,
    now: string
  ): LessonSaveResult {
    const saved = this.runStore.saveReconciledLesson({ ...candidate, theme: r.theme }, r.verdict, source, now, resolveLessonCapPerScope(process.env));
    if (!r.themeKnown && saved.id !== undefined) this.runStore.recordMemoryEvent("lesson_theme_unknown", { lesson_id: saved.id });
    return saved;
  }

  private async reconcileAndSaveLesson(
    candidate: { scope: string; text: string; avoid?: string },
    source: LessonSource,
    llm: (input: { question: string; system: string }) => Promise<{ ok: true; answer: string } | { ok: false }>,
    now: string = new Date().toISOString()
  ): Promise<LessonSaveResult> {
    return this.saveLessonVerdict(candidate, await this.reconcileLessonVerdict(candidate, llm), source, now);
  }
```

Check `reconcileLesson`'s return type in `src/capabilities/reconcile.ts:121` — if it returns `{ verdict, theme, themeKnown }` already, the first method is a pass-through; otherwise map its fields (`LessonReconcileVerdict` is exported from run-store, `:402`).

3. Add the service (next to `loopToolExecute`), then make the `lesson_write` branch call it:

```ts
  /**
   * ONE lesson-write pipeline for both callers (ADR 0029 §5.5): the `lesson_write` loop tool (source "loop") and
   * the memory lane (source "lane"). Trust anchors are the claim objective and the real prior answer, never the
   * planner's or Jev's text. A save, its lesson_changes row and the lesson_saved event land in one transaction.
   */
  async runLessonWrite(claim: ClaimedRun, chatId: string, input: Record<string, unknown>, source: "loop" | "lane"): Promise<LessonWriteOutcome> {
    const state = this.ompTurns.get(claim.run_id);
    if (!state) return { result: { ok: false, error: "no turn state for this run" } };
    const outcome: LessonWriteOutcome = { result: { ok: false, error: "lesson write did not run" } };
    const adapter = createLessonWriteAdapter({
      feedback: claim.contract.objective,
      priorAnswer: state.anchor.priorAnswer,
      allowedScopes: ["ask", "research"],
      defaultScope: state.anchor.defaultScope,
      llm: (i) => this.llmAdapterFor(claim.run_id, LESSON_WRITE_ROLES.distill)(i),
      scheduledRun: this.runStore.runSource(claim.run_id) === "schedule",
      srcContains: createSrcPhraseChecker(this.projectRoot),
      threadUserTexts: [...state.turnCtx.recentTurns].reverse()
        .filter((t) => t.role === "user" && this.runStore.runSource(t.run_id) !== "schedule").map((t) => t.text),
      ...(state.lessonSavedThisTurn ? { alreadySaved: { id: state.lessonSavedThisTurn.id } } : {}),
      saveLesson: async (candidate, now) => {
        const r = await this.reconcileLessonVerdict(candidate, async (i) => {
          const a = await this.llmAdapterFor(claim.run_id, LESSON_WRITE_ROLES.reconcile)(i);
          return a.ok && typeof a.output.answer === "string" ? { ok: true, answer: a.output.answer } : { ok: false };
        });
        return this.runStore.inTransaction(() => {
          const saved = this.saveLessonVerdict(candidate, r, source, now);
          if (saved.id !== undefined) {
            const change = this.runStore.insertLessonChange({ run_id: claim.run_id, chat_id: chatId, new_id: saved.id, superseded_id: saved.supersededId ?? null, pruned_ids: saved.prunedIds, created_at: now });
            state.lessonSavedThisTurn = { id: saved.id, theme: r.theme, change_id: change.change_id };
            this.runStore.appendRunLedgerEvent(claim.run_id, "lesson_saved", "core", { lesson_id: saved.id, change_id: change.change_id, source });
            Object.assign(outcome, { saved, change_id: change.change_id, theme: r.theme });
          }
          return saved;
        });
      }
    });
    outcome.result = await adapter(input);
    return outcome;
  }
```

with, near `OmpTurnState`:

```ts
export interface LessonWriteOutcome { result: ToolAdapterResult; saved?: LessonSaveResult; change_id?: string; theme?: string }
```

and the loop-tool branch becomes:

```ts
    if (name === "lesson_write") {
      // One pipeline with the memory lane (ADR 0029 §5.5); trust anchors live in runLessonWrite.
      return async (input) => (await this.runLessonWrite(claim, this.chatOf(claim.run_id), input, "loop")).result;
    }
```

(`lessonAnchor` is no longer read in that branch; `loopToolExecute` keeps its parameter for the other callers.) `appendRunLedgerEvent(run_id, event_type, actor, payload)` is at `run-store.ts:6411`. `inTransaction` requires a synchronous callback (`:4090`): the reconcile `await` sits outside it, as written.

- [x] ~~Step 7: Run both test files and the existing lesson tests**

Run: `npx vitest run tests/capabilities/lesson-write.test.ts tests/core/core-worker-lesson-service.test.ts tests/core/core-worker-omp-tools.test.ts tests/run/lesson-caps.test.ts && npm run typecheck`
Expected: PASS (the planner path's existing tests prove nothing regressed).

- [x] ~~Step 8: Commit**

```bash
git add src/capabilities/lesson-write.ts src/core/core-worker.ts tests/capabilities/lesson-write.test.ts tests/core/core-worker-lesson-service.test.ts
git commit -m "refactor(core): one lesson-write service for the loop tool and the memory lane; already-saved guard"
```

---

---
### Task 8: Supervisor — slot A (bare-ack nudge in `submit`), slot B (`triage` dep, warm spawn, lane finish), buttons on completion

**Files:**
- Create: `src/omp/bare-ack.ts`
- Modify: `src/omp/planner-supervisor.ts` (`TurnOutcomeSink` `:39-49`, `SupervisorDeps` `:50-69`, `Turn` `:101-119`, `submit` `:219-228`, `startTurn` `:380-398`, `ensureReady` `:401-407`, `failTurn` `:374-378`, `finishSuccess` `:943-952`, `resolveText` `:413-419`)
- Test: `tests/omp/bare-ack.test.ts` (new), `tests/omp/planner-supervisor.test.ts` (extend)

**Interfaces:**
- Produces:
  ```ts
  // bare-ack.ts
  export function isBareAck(text: string): boolean;
  export const ACK_NUDGE_TEXT: string;
  // planner-supervisor.ts
  export interface TurnOutcomeSink { complete(i: { …existing…; buttons?: NotificationButton[] }): void; … }
  export type TriageOutcome = { kind: "fallthrough" } | { kind: "inform"; note: string } | { kind: "lane_reply"; text: string; buttons: NotificationButton[] };
  export interface TriageInput { claim: ClaimedRun; text: string; userText: string; modality: TurnModality; posture: string | null; signal: AbortSignal }
  export interface SupervisorDeps { …existing…; triage?: (i: TriageInput) => Promise<TriageOutcome>;
    resolveMessage?: (claim) => Promise<{ ok: true; text: string; userText?: string; modality?: TurnModality } | { ok: false; error_ref: string }>; }
  interface Turn { …existing…; laneButtons?: NotificationButton[]; laneEnded: boolean }
  ```
  The supervisor hands the lane its own posture reading (`this.d.posture()`, the same dep the bridge uses) and the turn's abort signal; the lane never looks up posture itself.

- [ ] **Step 1: `isBareAck` test and module** — Rev 1's `tests/omp/bare-ack.test.ts` and `src/omp/bare-ack.ts`, unchanged.

- [ ] **Step 2: Write the failing supervisor tests**

Append to `tests/omp/planner-supervisor.test.ts`. Helper shapes (verified): `heldSession()` returns `{ session, live, end }`; `Script.start` is `() => Promise<unknown>`; `Outcome.done` is `unknown[]`; `harness(session, env, extra)`; `req(run_id, text)`; `untilState(sup, state)`; `until(ok)`; `createQueuedTurnRun(store, text)`; `sup.setAwaitingApprovalForTest(on)`.

```ts
type Done = { run_id: string; text: string; tool_calls: number; buttons?: unknown[] };
const dones = (o: { done: unknown[] }) => o.done as Done[];

describe("ADR 0029 lane 1 slots", () => {
  it("slot A: a bare ack during AWAITING_APPROVAL is nudged, not steered, not queued, approves nothing", async () => {
    const held = heldSession();
    const { sup, store, outcome } = harness(held.session);
    const r1 = createQueuedTurnRun(store, "push it");
    sup.submit(req(r1, "push it")); await held.live(1);
    sup.setAwaitingApprovalForTest(true);
    const r2 = createQueuedTurnRun(store, "好");
    sup.submit(req(r2, "好"));
    await until(() => dones(outcome).some((d) => d.run_id === r2));
    expect(held.session.steers).toHaveLength(0);
    expect(dones(outcome).find((d) => d.run_id === r2)?.text).toContain("waiting for your tap");
    expect(store.getLedgerEvents().some((e) => e.event_type === "ack_nudged" && e.payload.approval_run_id === r1)).toBe(true);
    expect(store.getRunState(r2)).toBe("completed");
    sup.setAwaitingApprovalForTest(false); held.end(); await untilState(sup, "IDLE");
  });
  it("slot A does not fire for a non-ack: it is steered as today", async () => {
    const held = heldSession();
    const { sup, store } = harness(held.session);
    sup.submit(req(createQueuedTurnRun(store, "push it"), "push it")); await held.live(1);
    sup.setAwaitingApprovalForTest(true);
    sup.submit(req(createQueuedTurnRun(store, "好，再查一次"), "好，再查一次"));
    await until(() => held.session.steers.length === 1);
    sup.setAwaitingApprovalForTest(false); held.end(); await untilState(sup, "IDLE");
  });
  it("slot B lane_reply: completes with tool_calls 0 and buttons, never prompts the child, leaves it idle", async () => {
    const session = fakeSession();
    const buttons = [{ text: "↩️ Undo", data: "memlane:undo:lc_x" }];
    const { sup, store, outcome } = harness(session, {}, { triage: async () => ({ kind: "lane_reply", text: "📒 Saved lesson #51", buttons }) });
    const r = createQueuedTurnRun(store, "以后回复短一点");
    sup.submit(req(r, "以后回复短一点"));
    await until(() => outcome.done.length === 1);
    expect(session.prompts).toHaveLength(0);
    expect(dones(outcome)[0]).toMatchObject({ run_id: r, tool_calls: 0, text: "📒 Saved lesson #51", buttons });
    expect(store.getRecentChatTurns("42", 10).map((t) => t.role)).toEqual(["user", "assistant"]);
    await untilState(sup, "IDLE");
  });
  it("slot B passes the posture reading and the abort signal to the lane", async () => {
    const seen: Array<{ posture: string | null; aborted: boolean }> = [];
    const session = fakeSession();
    const { sup, store, outcome } = harness(session, {}, { posture: () => "killed", triage: async (i) => { seen.push({ posture: i.posture, aborted: i.signal.aborted }); return { kind: "fallthrough" }; } });
    sup.submit(req(createQueuedTurnRun(store, "hi"), "hi"));
    await until(() => outcome.done.length + outcome.failed.length === 1);
    expect(seen).toEqual([{ posture: "killed", aborted: false }]);
  });
  it("slot B inform: the note precedes the message in the prompt and the planner runs", async () => {
    const session = fakeSession();
    const { sup, store, outcome } = harness(session, {}, { triage: async () => ({ kind: "inform", note: "[memory] Lesson #51 (format) was just saved from this message; do not save it again." }) });
    sup.submit(req(createQueuedTurnRun(store, "以后短一点，另外今天天气？"), "以后短一点，另外今天天气？"));
    await until(() => outcome.done.length === 1);
    expect(session.prompts[0]).toMatch(/^\[memory\] Lesson #51[\s\S]*另外今天天气？$/);
  });
  it("slot B: a triage that throws falls through to today's path with a closed-reason incident", async () => {
    const session = fakeSession();
    const { sup, store, outcome } = harness(session, {}, { triage: async () => { throw new Error("boom with a bound value"); } });
    sup.submit(req(createQueuedTurnRun(store, "hi"), "hi"));
    await until(() => outcome.done.length === 1);
    expect(session.prompts).toHaveLength(1); expect(outcome.failed).toHaveLength(0);
    expect((outcome.incidents as Array<{ k: string; d: Record<string, unknown> }>).find((i) => i.k === "triage_threw")?.d.reason).toBe("triage_threw");
  });
  it("slot B lane_reply when the spawn rejects or hangs: the lane still completes; the spawn failure never fails the turn", async () => {
    const rejecting = fakeSession({ start: async () => { throw new PlannerRpcError("exited:1"); } });
    let h = harness(rejecting, {}, { triage: async () => ({ kind: "lane_reply", text: "status: ok", buttons: [] }) });
    let r = createQueuedTurnRun(h.store, "did you restart?");
    h.sup.submit(req(r, "did you restart?"));
    await until(() => h.outcome.done.length + h.outcome.failed.length === 1);
    expect(dones(h.outcome).map((d) => d.run_id)).toEqual([r]); expect(h.outcome.failed).toHaveLength(0);
    const hanging = fakeSession({ start: () => new Promise(() => undefined) });
    h = harness(hanging, {}, { triage: async () => ({ kind: "lane_reply", text: "status: ok", buttons: [] }) });
    r = createQueuedTurnRun(h.store, "did you restart?");
    h.sup.submit(req(r, "did you restart?"));
    await until(() => h.outcome.done.length === 1); // completes after ABORT_GRACE_MS (5 s) through stopSession; within vitest's 10 s
    expect(h.outcome.failed).toHaveLength(0);
  });
  it.each([
    ["recordChatTurn", (h: ReturnType<typeof harness>) => vi.spyOn(h.store, "recordChatTurn").mockImplementationOnce(() => { throw new Error("disk"); }), false],
    ["stopSession", (h: ReturnType<typeof harness>) => vi.spyOn(h.sup as unknown as { stopSession: () => Promise<void> }, "stopSession").mockRejectedValueOnce(new Error("stop")), true],
    ["settleStart", (h: ReturnType<typeof harness>) => vi.spyOn(h.sup as unknown as { settleStart: () => Promise<void> }, "settleStart").mockRejectedValueOnce(new Error("settle")), true]
  ])("a %s failure before laneEnded reaches settle() as exactly one FAILED outcome (start_failed), never a stranded turn", async (_name, inject, hang) => {
    const session = hang ? fakeSession({ start: () => new Promise(() => undefined) }) : fakeSession();
    const h = harness(session, {}, { triage: async () => ({ kind: "lane_reply", text: "x", buttons: [] }) });
    const spy = inject(h);
    h.sup.submit(req(createQueuedTurnRun(h.store, "hi"), "hi"));
    await until(() => h.outcome.done.length + h.outcome.failed.length === 1);
    expect(h.outcome.done).toHaveLength(0);
    expect((h.outcome.failed[0] as { error_ref: string }).error_ref).toMatch(/^start_failed/);
    spy.mockRestore();
  });
  it("a sessionFactory that throws synchronously is caught by the warm promise, not the turn", async () => {
    const { sup, store, outcome } = harness(fakeSession(), {}, { sessionFactory: () => { throw new Error("factory"); }, triage: async () => ({ kind: "lane_reply", text: "x", buttons: [] }) });
    sup.submit(req(createQueuedTurnRun(store, "hi"), "hi"));
    await until(() => outcome.done.length === 1);
    expect(outcome.failed).toHaveLength(0);
  });
});
```

Import `PlannerRpcError` is already in the file (`:11`). If `fakeSession`'s `start` override does not reach `spawn()`'s own try/catch the way the "rejecting" case assumes, keep the test and let it tell you which path the rejection takes — the assertion (lane completes, no failure) is the contract either way.

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run tests/omp/planner-supervisor.test.ts -t "ADR 0029"` → FAIL.

- [ ] **Step 4: Implement in `planner-supervisor.ts`**

Types as in **Interfaces** (`TriageInput` gains `posture` and `signal`; `Turn` gains `laneEnded: boolean`, initialised `false` in `newTurn`). `resolveText` returns `modality: r.modality ?? "text"`.

`submit()` and `nudgeAck()` — Rev 1 text unchanged (slot A).

`startTurn` (the local variable is `promptMessage`, not `message`, because the module's `message(e)` helper is used in the `catch`):

```ts
  private async startTurn(turn: Turn): Promise<void> {
    const { store, chatId, turnContext } = this.d;
    try {
      const resolved = await this.resolveText(turn);
      if (resolved === ENDED || turn.failure) return;
      const { text, userText, modality } = resolved;
      // Slot B (ADR 0029 §5.1): the child starts now; only planner paths await it. `warm` never rejects: a start failure
      // is the spawn's own incident (or a string result), never this turn's.
      const warm: Promise<StartResult> = this.ensureSession(0).catch((e): StartResult => `spawn_failed: ${message(e)}`);
      const verdict = await this.triage(turn, { claim: turn.claim, text, userText, modality, posture: this.d.posture(), signal: turn.abort.signal });
      if (verdict === ENDED || turn.failure) return;
      if (verdict.kind === "lane_reply") { await this.finishLane(turn, userText, verdict, warm); return; }
      const promptMessage = verdict.kind === "inform" ? `${verdict.note}\n\n${text}` : text;
      if (!(await this.ensureReady(turn))) return;
      store.recordChatTurn({ chat_id: chatId, run_id: turn.req.run_id, role: "user", text: userText });
      const prompt = await this.step(turn, buildTurnPrompt(turnContext, {
        run_id: turn.req.run_id, chat_id: chatId, message: promptMessage, source: turn.req.source, applied: this.applied,
        ...(turn.req.goal !== undefined ? { goal: turn.req.goal } : {})
      }));
      if (prompt === ENDED || turn.failure) return;
      if (this.stale && !(await this.ensureReady(turn))) return;
      await this.promptTop(turn, prompt);
    } catch (e) {
      this.failTurn(turn, "planner_exit", `start_failed: ${message(e)}`);
    }
  }

  /** Any triage error is today's path; the reason is a closed enum (an Error message may carry bound values). */
  private async triage(turn: Turn, i: TriageInput): Promise<TriageOutcome | typeof ENDED> {
    if (!this.d.triage || turn.req.source !== "telegram") return { kind: "fallthrough" };
    try {
      return await this.step(turn, this.d.triage(i));
    } catch (e) {
      console.error(`planner supervisor: triage threw: ${message(e)}`);
      this.incident("triage_threw", { run_id: turn.req.run_id, reason: "triage_threw" });
      return { kind: "fallthrough" };
    }
  }

  /**
   * Lane terminal (spec §5.1 "one terminal owner"): record the user turn, hand the card to finishSuccess through
   * lastText/laneButtons, make sure no start can still touch this turn, then end it. settle() → finishSuccess records
   * the assistant turn and completes the run once, with tool_calls 0 from the untouched budget.
   */
  private async finishLane(turn: Turn, userText: string, v: Extract<TriageOutcome, { kind: "lane_reply" }>, warm: Promise<StartResult>): Promise<void> {
    // Order matters (Codex plan review): everything that can throw runs BEFORE laneEnded; after it, completion is
    // guaranteed by the finally. A throw before laneEnded reaches startTurn's catch → failTurn (the lane's save, if any,
    // is named by ompFail from state.lessonSavedThisTurn).
    this.d.store.recordChatTurn({ chat_id: this.d.chatId, run_id: turn.req.run_id, role: "user", text: userText });
    if ((await bounded(warm, ABORT_GRACE_MS)) === TIMED_OUT) { await this.stopSession(); await this.settleStart(); } // supersede a start that will not settle (gen bump)
    turn.lastText = v.text;
    turn.laneButtons = v.buttons;
    turn.laneEnded = true; // from here a late start result may not fail or re-enter this turn
    try { turn.live = false; } finally { turn.done("end"); }
  }
```

Guards:

```ts
  private failTurn(turn: Turn, type: PlannerFailure, ref: string): void {
    if (turn.finished || turn.laneEnded) return; // ADR 0029 §5.1: a late spawn result never mutates a lane-ended turn
    …
  }
  private async ensureReady(turn: Turn): Promise<boolean> {
    if (turn.finished || turn.laneEnded) return false;
    …
  }
```

`finishSuccess`: `outcome.complete({ ...base, run_id: t.req.run_id, attachments, ...(t.laneButtons ? { buttons: t.laneButtons } : {}) });`.

Behaviour note for the plan reader (and Task 14's docs): during the lane's 15–25 s, `turn.live` is false and the state is IDLE/STARTING, so a second Telegram message is **queued**, not steered; nothing is lost, nothing is acknowledged until the card. `ensureSession(0)` on a warm unchanged child returns `null` after a fingerprint compare and now runs twice per planner turn (warm + `ensureReady`) — fine at ~1.7 turns/day.

- [ ] **Step 5: Run the supervisor suite + typecheck**

Run: `npx vitest run tests/omp/planner-supervisor.test.ts tests/omp/bare-ack.test.ts && npm run typecheck`
Expected: PASS, every pre-existing supervisor test (90) still green.

- [ ] **Step 6: Commit**

```bash
git add src/omp/bare-ack.ts src/omp/planner-supervisor.ts tests/omp/bare-ack.test.ts tests/omp/planner-supervisor.test.ts
git commit -m "feat(omp): lane 1 slots — bare-ack nudge in submit, triage before the planner, lane replies via finishSuccess"
```

---

#### Rev 1 text retained for the code blocks referenced above (reference only; the Rev 2 steps above are the ones to execute)


**Files:**
- Create: `src/omp/bare-ack.ts`
- Modify: `src/omp/planner-supervisor.ts` (`TurnOutcomeSink` `:39-49`, `SupervisorDeps` `:50-69`, `Turn` `:101-119`, `submit` `:219-228`, `startTurn` `:380-398`, `ensureReady` `:401-407`, `failTurn` `:374-378`, `finishSuccess` `:943-952`, `resolveText` `:413-419`)
- Test: `tests/omp/bare-ack.test.ts` (new), `tests/omp/planner-supervisor.test.ts` (extend)

**Interfaces:**
- Produces:
  ```ts
  // bare-ack.ts
  export function isBareAck(text: string): boolean;   // code-owned list, ≤ 4 chars after trim/lower/strip trailing 。！!.~～
  export const ACK_NUDGE_TEXT: string;                 // "⏸ Houge is waiting for your tap on the approval card above — tap Approve/Deny, or send /approve <id>."
  // planner-supervisor.ts
  export interface TurnOutcomeSink { complete(i: { …existing…; buttons?: NotificationButton[] }): void; … }
  export type TriageOutcome = { kind: "fallthrough" } | { kind: "inform"; note: string } | { kind: "lane_reply"; text: string; buttons: NotificationButton[] };
  export interface TriageInput { claim: ClaimedRun; text: string; userText: string; modality: TurnModality }
  export interface SupervisorDeps { …existing…; triage?: (i: TriageInput) => Promise<TriageOutcome>;
    resolveMessage?: (claim) => Promise<{ ok: true; text: string; userText?: string; modality?: TurnModality } | { ok: false; error_ref: string }>; }
  interface Turn { …existing…; laneButtons?: NotificationButton[] }
  ```

- [x] ~~Step 1: Write the failing `isBareAck` test**

Create `tests/omp/bare-ack.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isBareAck } from "../../src/omp/bare-ack.js";

// Spec §5.1 slot A: a bare ack while an approval card waits must never be read as consent; the list is code-owned.
describe("isBareAck", () => {
  it.each(["好", "好的", "嗯", "ok", "OK", "Okay", "是的", "对", "👍", "yes", "行", "可以", "好。", "ok!"])("accepts %s", (t) => expect(isBareAck(t)).toBe(true));
  it.each(["好，再查一次", "ok but why", "approve", "/approve 12", "不要", "", "   "])("rejects %s", (t) => expect(isBareAck(t)).toBe(false));
});
```

- [x] ~~Step 2: Create `src/omp/bare-ack.ts`**

```ts
/**
 * Bare acknowledgements (ADR 0029 §5.1, slot A). While a turn is AWAITING_APPROVAL such a message is neither
 * steered nor queued: it gets a code-owned nudge and approves nothing. The list is code-owned on purpose — no model
 * decides what counts as consent.
 */
const ACKS: ReadonlySet<string> = new Set([
  "好", "好的", "好啊", "嗯", "嗯嗯", "是", "是的", "对", "对的", "行", "可以", "没问题", "ok", "okay", "k", "yes", "y", "yep", "sure", "👍", "👌"
]);
const TRAILING = /[。！!.~～\s]+$/u;

export function isBareAck(text: string): boolean {
  const t = text.trim().replace(TRAILING, "").toLowerCase();
  return t.length > 0 && t.length <= 4 && ACKS.has(t);
}

export const ACK_NUDGE_TEXT = "⏸ Houge is waiting for your tap on the approval card above — tap Approve or Deny there, or send /approve <id>.";
```

Run: `npx vitest run tests/omp/bare-ack.test.ts` → PASS. Commit later with the supervisor change.

- [x] ~~Step 3: Write the failing supervisor tests**

Append to `tests/omp/planner-supervisor.test.ts` (uses the file's `harness`, `heldSession`, `req`, `untilState`, `until`, `createQueuedTurnRun`-style run creation — read the first 200 lines of the file to match the helpers exactly):

```ts
describe("ADR 0029 lane 1 slots", () => {
  it("slot A: a bare ack during AWAITING_APPROVAL is nudged, not steered, not queued, and approves nothing", async () => {
    const session = heldSession();
    const { sup, store, outcome } = harness(session);
    const r1 = createQueuedTurnRun(store, "push it");
    sup.submit(req(r1, "push it"));
    await untilState(sup, "RUNNING");
    sup.setAwaitingApprovalForTest(true);
    const r2 = createQueuedTurnRun(store, "好");
    sup.submit(req(r2, "好"));
    await until(() => outcome.done.some((d) => d.run_id === r2));
    expect(session.steers).toHaveLength(0);
    expect(outcome.done.find((d) => d.run_id === r2)?.text).toContain("waiting for your tap");
    expect(store.getLedgerEvents().some((e) => e.event_type === "ack_nudged" && e.payload.approval_run_id === r1)).toBe(true);
    expect(store.getRunState(r2)).toBe("completed");
    sup.setAwaitingApprovalForTest(false);
    session.end(); await untilState(sup, "IDLE");
  });
  it("slot A does not fire for a non-ack: it is steered as today", async () => {
    const session = heldSession();
    const { sup, store } = harness(session);
    const r1 = createQueuedTurnRun(store, "push it");
    sup.submit(req(r1, "push it")); await untilState(sup, "RUNNING");
    sup.setAwaitingApprovalForTest(true);
    sup.submit(req(createQueuedTurnRun(store, "好，再查一次"), "好，再查一次"));
    await until(() => session.steers.length === 1);
    sup.setAwaitingApprovalForTest(false); session.end(); await untilState(sup, "IDLE");
  });
  it("slot B lane_reply: completes with tool_calls 0 and buttons, never prompts the child, leaves it idle", async () => {
    const session = fakeSession();
    const buttons = [{ text: "↩️ Undo", data: "memlane:undo:lc_x" }];
    const { sup, store, outcome } = harness(session, {}, { triage: async () => ({ kind: "lane_reply", text: "📒 Saved lesson #51", buttons }) });
    const r = createQueuedTurnRun(store, "以后回复短一点");
    sup.submit(req(r, "以后回复短一点"));
    await until(() => outcome.done.length === 1);
    expect(session.prompts).toHaveLength(0);
    expect(outcome.done[0]).toMatchObject({ run_id: r, tool_calls: 0, text: "📒 Saved lesson #51", buttons });
    const turns = store.getRecentChatTurns("42", 10);
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant"]);
    await untilState(sup, "IDLE"); // the warm child is up and idle for the next turn
  });
  it("slot B inform: the note precedes the message in the prompt and the planner runs", async () => {
    const session = fakeSession();
    const { sup, store, outcome } = harness(session, {}, { triage: async () => ({ kind: "inform", note: "[memory] Lesson #51 (format) was just saved from this message; do not save it again." }) });
    const r = createQueuedTurnRun(store, "以后短一点，另外今天天气？");
    sup.submit(req(r, "以后短一点，另外今天天气？"));
    await until(() => outcome.done.length === 1);
    expect(session.prompts[0]).toMatch(/^\[memory\] Lesson #51[\s\S]*另外今天天气？$/);
  });
  it("slot B: a triage that throws or hangs past its budget falls through to today's path", async () => {
    const session = fakeSession();
    const { sup, store, outcome } = harness(session, {}, { triage: async () => { throw new Error("boom"); } });
    const r = createQueuedTurnRun(store, "hi");
    sup.submit(req(r, "hi"));
    await until(() => outcome.done.length === 1);
    expect(session.prompts).toHaveLength(1);
    expect(outcome.failed).toHaveLength(0);
  });
  it("slot B lane_reply when the spawn fails: the lane still completes and the spawn failure never fails the turn", async () => {
    const session = fakeSession({ start: "fail" }); // use the Script option the file offers for a failing start
    const { sup, store, outcome } = harness(session, {}, { triage: async () => ({ kind: "lane_reply", text: "status: ok", buttons: [] }) });
    const r = createQueuedTurnRun(store, "did you restart?");
    sup.submit(req(r, "did you restart?"));
    await until(() => outcome.done.length === 1 || outcome.failed.length === 1);
    expect(outcome.done.map((d) => d.run_id)).toEqual([r]);
    expect(outcome.failed).toHaveLength(0);
  });
});
```

Read the `Script` type in the test file for the exact way to make `start()` fail (the dossier lists `start` among the options) and adjust `{ start: "fail" }` to it.

- [x] ~~Step 4: Run to verify they fail**

Run: `npx vitest run tests/omp/planner-supervisor.test.ts -t "ADR 0029"`
Expected: FAIL — `triage` unknown, nudge missing, steer happens.

- [x] ~~Step 5: Implement in `planner-supervisor.ts`**

Types:

```ts
import type { NotificationButton } from "../notifications/notification-types.js";
import type { TurnModality } from "../media/media-config.js";
import { ACK_NUDGE_TEXT, isBareAck } from "./bare-ack.js";

export interface TurnOutcomeSink {
  complete(i: { run_id: string; worker_id: string; text: string; attachments: string[]; duration_ms: number; tool_calls: number; merged_into?: string; buttons?: NotificationButton[] }): void;
  …
}
/** Lane 1 (ADR 0029 §5.1): what the daemon decided before the planner. Anything but lane_reply/inform is today's path. */
export type TriageOutcome = { kind: "fallthrough" } | { kind: "inform"; note: string } | { kind: "lane_reply"; text: string; buttons: NotificationButton[] };
export interface TriageInput { claim: ClaimedRun; text: string; userText: string; modality: TurnModality }
// SupervisorDeps:
  triage?: (i: TriageInput) => Promise<TriageOutcome>;
  resolveMessage?: (claim: ClaimedRun) => Promise<{ ok: true; text: string; userText?: string; modality?: TurnModality } | { ok: false; error_ref: string }>;
// Turn:
  laneButtons?: NotificationButton[];
```

`resolveText` returns `{ text, userText, modality }` with `modality: r.modality ?? "text"`.

`submit()`:

```ts
  submit(req: TurnRequest): void {
    const t = this.turn;
    const live = t?.live && t.req.source === "telegram" && req.source === "telegram" && !req.needsIngest;
    // Slot A (ADR 0029 §5.1): a bare ack while an approval card waits is consent to nothing — nudge, never steer or queue.
    if (live && this.st === "AWAITING_APPROVAL" && isBareAck(req.text)) { this.nudgeAck(t, req); return; }
    if (live && (this.st === "RUNNING" || this.st === "AWAITING_APPROVAL")) {
      void this.steer(t, req).catch((e) => this.incident("planner_steer_failed", { run_id: req.run_id, reason: rpcCode(e) }));
      return;
    }
    this.queue.push(req);
    if (!this.busy) this.draining = this.drain();
  }

  /** The nudged run completes on its own, code-owned, with zero tool calls; the waiting turn is untouched. */
  private nudgeAck(waiting: Turn, req: TurnRequest): void {
    const { store, chatId, cfg, outcome } = this.d;
    const worker = `planner:${chatId}:nudge:${randomUUID()}`;
    if (!store.claimRun(req.run_id, worker, cfg.leaseTtlS)) return;
    store.recordChatTurn({ chat_id: chatId, run_id: req.run_id, role: "user", text: req.text });
    store.appendRunLedgerEvent(req.run_id, "ack_nudged", "core", { approval_run_id: waiting.req.run_id });
    store.recordChatTurn({ chat_id: chatId, run_id: req.run_id, role: "assistant", text: ACK_NUDGE_TEXT, intent: "loop" });
    outcome.complete({ run_id: req.run_id, worker_id: worker, text: ACK_NUDGE_TEXT, attachments: [], duration_ms: 0, tool_calls: 0 });
  }
```

`startTurn`:

```ts
  private async startTurn(turn: Turn): Promise<void> {
    const { store, chatId, turnContext } = this.d;
    try {
      const resolved = await this.resolveText(turn);
      if (resolved === ENDED || turn.failure) return;
      const { text, userText, modality } = resolved;
      // Slot B (ADR 0029 §5.1): the child starts now but is awaited only by planner paths; a lane reply needs no child.
      const warm = this.ensureSession(0);
      warm.catch(() => undefined); // its failure belongs to the spawn (incidents), never to this turn
      const verdict = await this.triage(turn, { claim: turn.claim, text, userText, modality });
      if (verdict === ENDED || turn.failure) return;
      const message = verdict.kind === "inform" ? `${verdict.note}\n\n${text}` : text;
      if (verdict.kind === "lane_reply") { await this.finishLane(turn, userText, verdict, warm); return; }
      if (!(await this.ensureReady(turn))) return;
      store.recordChatTurn({ chat_id: chatId, run_id: turn.req.run_id, role: "user", text: userText });
      const prompt = await this.step(turn, buildTurnPrompt(turnContext, {
        run_id: turn.req.run_id, chat_id: chatId, message, source: turn.req.source, applied: this.applied,
        ...(turn.req.goal !== undefined ? { goal: turn.req.goal } : {})
      }));
      if (prompt === ENDED || turn.failure) return;
      if (this.stale && !(await this.ensureReady(turn))) return;
      await this.promptTop(turn, prompt);
    } catch (e) {
      this.failTurn(turn, "planner_exit", `start_failed: ${message(e)}`);
    }
  }

  /** Any triage error or an ended turn is today's path: the lane may never cost a turn. */
  private async triage(turn: Turn, i: TriageInput): Promise<TriageOutcome | typeof ENDED> {
    if (!this.d.triage || turn.req.source !== "telegram") return { kind: "fallthrough" };
    try {
      return await this.step(turn, this.d.triage(i));
    } catch (e) {
      this.incident("triage_failed", { run_id: turn.req.run_id, reason: message(e) });
      return { kind: "fallthrough" };
    }
  }

  /**
   * Lane terminal (spec §5.1 "one terminal owner"): record the user turn, hand the card to finishSuccess through
   * lastText/laneButtons, make sure the warm spawn can no longer touch this turn, then end it. settle() → finishSuccess
   * records the assistant turn and completes the run once, with tool_calls 0 from the untouched budget.
   */
  private async finishLane(turn: Turn, userText: string, v: Extract<TriageOutcome, { kind: "lane_reply" }>, warm: Promise<StartResult>): Promise<void> {
    this.d.store.recordChatTurn({ chat_id: this.d.chatId, run_id: turn.req.run_id, role: "user", text: userText });
    turn.lastText = v.text;
    turn.laneButtons = v.buttons;
    if ((await bounded(warm, ABORT_GRACE_MS)) === TIMED_OUT) await this.stopSession(); // supersede a start that will not settle
    turn.live = false;
    turn.done("end");
  }
```

Note the variable `message` shadows the module's `message(e)` helper inside `startTurn`'s `catch`; rename the local to `promptMessage` if the file's helper is named `message` (it is: `message(e)` at `:397`).

`ensureReady` and `failTurn` gain the finished guard:

```ts
  private failTurn(turn: Turn, type: PlannerFailure, ref: string): void {
    if (turn.finished) return; // a late spawn result may not mutate a turn the lane already ended (ADR 0029 §5.1)
    …
  }
  private async ensureReady(turn: Turn): Promise<boolean> {
    if (turn.finished) return false;
    …
  }
```

`finishSuccess`: `outcome.complete({ ...base, run_id: t.req.run_id, attachments, ...(t.laneButtons ? { buttons: t.laneButtons } : {}) });` and the assistant chat turn gets `intent: t.laneButtons || t.lastText ? assistantIntentFor(text, t.usedTool) : …` — leave `assistantIntentFor(text, t.usedTool)` as is (a lane reply has no question mark, so it classifies as `loop`).

Where `settle()` treats `"end"` with `turn.lastError === undefined` and no failure as success, nothing changes. Confirm `bounded`/`TIMED_OUT`/`StartResult` are in scope (same file). `ensureSession(0)` on a warm, unchanged child returns `null` immediately (`:518-523`), so the common case costs nothing.

- [x] ~~Step 6: Run the supervisor suite + typecheck**

Run: `npx vitest run tests/omp/planner-supervisor.test.ts tests/omp/bare-ack.test.ts && npm run typecheck`
Expected: PASS, including every pre-existing supervisor test (turn ordering, steer, approval, reset, retry legs).

- [x] ~~Step 7: Commit**

```bash
git add src/omp/bare-ack.ts src/omp/planner-supervisor.ts tests/omp/bare-ack.test.ts tests/omp/planner-supervisor.test.ts
git commit -m "feat(omp): lane 1 slots — bare-ack nudge in submit, triage before the planner, lane replies via finishSuccess"
```

---

---
### Task 9: `CoreWorker.triageTurn` — one finalisation per turn, atomic with the lane's save; `ompFail` names a saved lesson

**Files:**
- Create: `src/core/memory-lane-card.ts`
- Modify: `src/core/core-worker.ts` (`OmpWorkerOptions` `:218-225`, `supervisorDeps` `:2101-2113`, `resolveOmpMessage` `:2231-2240`, `ompComplete` `:2285-2303`, `ompFail` `:2306-2316`, new `triageTurn` + helpers)
- Modify: `tests/helpers/omp-worker.ts` (accept `jevFetch`, `jevNow`)
- Test: `tests/core/memory-lane-card.test.ts` (new), `tests/core/core-worker-triage.test.ts` (new)

**Interfaces:**
- Produces:
  ```ts
  // memory-lane-card.ts — as Rev 1 (memoryLaneCard, memoryInformNote, MEMLANE_UNDO_PREFIX, MEMLANE_ASK_PREFIX)
  // core-worker.ts
  export interface OmpWorkerOptions { …; jevFetch?: typeof fetch; jevNow?: () => Date }
  triageTurn(i: TriageInput): Promise<TriageOutcome>;   // wired as SupervisorDeps.triage
  setOmpObjectiveForTest(run_id: string, objective: string): void;  // @internal (Task 7's test)
  ```
  **Finalisation rule:** exactly one `triage` ledger event per eligible turn, written by one function (`finalizeTriage`), and for an answered call the decision rows are written in the same transaction as that event: inside the lane's save transaction when a lesson was saved (via Task 7's `inTx`), else in a small transaction of their own. A failure *after* a committed save returns `inform` (the planner still answers; the note names the lesson) and `ompFail` appends "📒 Lesson #N was saved before the failure." when a state carries `lessonSavedThisTurn`.

- [ ] **Step 1: Card test + module** — Rev 1 unchanged.

- [ ] **Step 2: Write the failing `triageTurn` tests**

`tests/core/core-worker-triage.test.ts` — Rev 1's cases with these corrections and additions: env through `vi.stubEnv(...)` in `setup` and `vi.unstubAllEnvs()` in `afterEach` (the vitest pool shares `process.env`); the posture case passes `posture: "killed"` in the input instead of relying on a tombstone; two new cases:

```ts
it("a throw after the save (card builder) yields inform, decisions 'act', one triage row", async () => {
  const { store, worker, turn } = setup(jevSays(MEMORY));
  worker.breakMemoryLaneCardForTest(); // @internal: makes memoryLaneCard throw once
  const t = turn("以后回复短一点");
  const out = await worker.triageTurn(t.input);
  expect(out).toMatchObject({ kind: "inform", note: expect.stringMatching(/^\[memory\] Lesson #\d+/) });
  expect(triageRows(store, t.run_id)).toHaveLength(1);
  expect(triageRows(store, t.run_id)[0]).toMatchObject({ decision: "act", lane: "memory" });
  expect(store.listJevDecisions(t.run_id).every((r) => r.decision === "act")).toBe(true);
  store.close();
});
it("a rolled-back inTx hook leaves no lesson, no guard, and exactly one fallback triage row", async () => {
  const { store, worker, turn } = setup(jevSays(MEMORY));
  const t = turn("以后回复短一点");
  worker.breakLaneFinalizeOnceForTest(); // @internal: makes the inTx finalize throw once (simulates the event write failing)
  expect(await worker.triageTurn(t.input)).toEqual({ kind: "fallthrough" });
  expect(store.getActiveLessons("ask")).toHaveLength(0);
  expect(triageRows(store, t.run_id)).toMatchObject([{ status: "answered", decision: "fallback" }]);
  expect(store.listJevDecisions(t.run_id).filter((r) => r.decision === "fallback")).toHaveLength(3);
  store.close();
});
it("an aborted turn writes nothing after Jev: no rows, no event, no lesson", async () => {
  const { store, worker, turn } = setup(jevSays(MEMORY));
  const t = turn("以后回复短一点"); const ac = new AbortController();
  const p = worker.triageTurn({ ...t.input, signal: ac.signal }); ac.abort();
  expect(await p).toEqual({ kind: "fallthrough" });
  expect(triageRows(store, t.run_id)).toHaveLength(0); expect(store.listJevDecisions(t.run_id)).toHaveLength(0);
  store.close();
});
it("the decision rows and the triage event land in the SAME transaction as the lesson (a failing event write rolls the lesson back)", async () => {
  const { store, worker, turn } = setup(jevSays(MEMORY));
  const t = turn("以后回复短一点");
  const original = store.appendRunLedgerEvent.bind(store);
  const spy = vi.spyOn(store, "appendRunLedgerEvent").mockImplementation((run_id, type, actor, payload) => { if (type === "triage") throw new Error("disk"); return original(run_id, type, actor, payload); });
  await worker.triageTurn(t.input).catch(() => undefined);
  spy.mockRestore();
  expect(store.getActiveLessons("ask")).toHaveLength(0);
  expect(store.listJevDecisions(t.run_id).filter((r) => r.status === "answered")).toHaveLength(0);
  store.close();
});
```

Replace Rev 1's `rating_ask`/`last_turn_tools` expectations: the state has four keys (Task 2).

Add the broker test (the live gate cannot prove it): `tests/helpers/omp-worker.ts` gains `broker?: SecretBroker` threaded to the 8th constructor argument; a fake `{ typesafeKey: () => "test-key", redact: (s: string) => s } as unknown as SecretBroker` and a `fetchImpl` that records `init.headers`:

```ts
it("the broker's key wins over the environment and reaches the Authorization header", async () => {
  const body = jevSays(MEMORY); // the file's own response factory (a vi.fn returning a 200 Response)
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => { seenAuth = String((init.headers as Record<string, string>).authorization); return body(url, init); });
  let seenAuth = "";
  const store = RunStore.openInMemory();
  const worker = ompWorker(store, mkdtempSync(join(tmpdir(), "htri-")), { llm: distillThenReconcile, jevFetch: fetchImpl as unknown as typeof fetch,
    broker: { typesafeKey: () => "test-key", redact: (s: string) => s } as unknown as SecretBroker });
  vi.stubEnv("HOUGE_JEV_ENABLED", "1"); vi.stubEnv("HOUGE_JEV_TRIAGE_ENABLED", "shadow"); vi.stubEnv("TYPESAFE_API_KEY", "env-key");
  const run_id = createQueuedTurnRun(store, "以后回复短一点"); const claim = store.claimRun(run_id, "w", 120)!; worker.buildOmpTools(claim, "555");
  await worker.triageTurn({ claim, text: "以后回复短一点", userText: "以后回复短一点", modality: "text", posture: null, signal: new AbortController().signal });
  expect(seenAuth).toBe("Bearer test-key");
  store.close();
});
```

- [ ] **Step 3: Run to verify they fail.**

- [ ] **Step 4: Implement in `core-worker.ts`**

Imports: `decide, persistDecisionRows, recordSkip, marginOf, type Decision, type SkipReason, type JevDecisionInsert` from `../jev/decide.js`; `createJevClient, type JevRequest, type JevResult` from `../jev/jev-client.js`; `langOf, type Lang` from `../jev/intent-question.js`; `buildTriageState, lastHougeTurnOf, TRIAGE_QUESTIONS` from `../jev/questions/triage.js`; `THRESHOLD_VERSION, resolveTriageBars, triageVerdict, type TriageDecision` from `../jev/thresholds.js`; `resolveJevTriageMode` from `../jev/jev-flags.js`; `memoryInformNote, memoryLaneCard` from `./memory-lane-card.js`; `type TriageInput, type TriageOutcome` from `../omp/planner-supervisor.js`.

`OmpWorkerOptions` + `jevFetch?`, `jevNow?`. `supervisorDeps`: `triage: (i) => this.triageTurn(i)`. `resolveOmpMessage`: return `modality: r.modality`. `ompComplete`: pass `buttons`. `ompFail`: before `plannerFailureText`, read `const state = this.ompTurns.get(i.run_id)` (currently deleted at the top — move the delete after reading) and, when `state?.lessonSavedThisTurn`, append `\n\n📒 Lesson #${id} was saved before the failure.` to a non-null text.

```ts
  // ── Jev System One, lane 1 (ADR 0029 §5): the decision before the planner ─────────────────

  private jevClient(run_id: string): (req: JevRequest) => Promise<JevResult> { /* Rev 1 */ }

  type TriagePayload = { status: "answered" | "skipped"; lang: Lang; decision: "act" | "fallback" | "shadow"; skip_reason?: SkipReason;
    lane?: string; complete?: string; scope?: string; confidence?: number; top_prob?: number; margin?: number };

  /** The denominator (spec §3.2): one `triage` event per eligible turn, written once the outcome is known. */
  private triageEvent(run_id: string, p: TriagePayload): void {
    this.runStore.appendRunLedgerEvent(run_id, "triage", "core", {
      status: p.status, lane: p.lane ?? null, complete: p.complete ?? null, scope: p.scope ?? null, confidence: p.confidence ?? null,
      top_prob: p.top_prob ?? null, margin: p.margin ?? null, lang: p.lang, decision: p.decision, ...(p.skip_reason ? { skip_reason: p.skip_reason } : {})
    });
  }

  /**
   * THE finaliser (Codex plan review): every eligible, still-active exit of triageTurn passes through here exactly once.
   * `rows` are the answered decision rows (empty for a skip); a lost turn (signal / state identity) writes nothing.
   * Guarded by a per-turn `finalized` flag on the state so the act path (finalised inside the save transaction via
   * `inTx`) and the fallback path can never both write.
   */
  private settleTriage(i: TriageInput, state: OmpTurnState | undefined, lang: Lang, f:
    | { kind: "skipped"; reason: SkipReason }
    | { kind: "answered"; rows: JevDecisionInsert[]; decision: "act" | "fallback" | "shadow"; threshold_used: string; numbers: Record<string, unknown> },
    o: { inTx?: boolean } = {}): void {
    if (state?.triageFinalized) return;
    if (state && this.laneLost(i, state)) return;
    const run_id = i.claim.run_id;
    const write = () => {
      if (f.kind === "skipped") { recordSkip(this.runStore, "triage", run_id, lang, f.reason); this.triageEvent(run_id, { status: "skipped", lang, decision: "fallback", skip_reason: f.reason }); }
      else { persistDecisionRows(this.runStore, f.rows, f.decision, f.threshold_used); this.triageEvent(run_id, { status: "answered", lang, decision: f.decision, ...f.numbers }); }
    };
    if (o.inTx) { write(); return; } // already inside the save transaction; the caller flips the flag after commit
    this.runStore.inTransaction(write);
    if (state) state.triageFinalized = true;
  }

  private triageSkip(i: TriageInput, state: OmpTurnState | undefined, lang: Lang, reason: SkipReason): TriageOutcome {
    this.settleTriage(i, state, lang, { kind: "skipped", reason });
    return { kind: "fallthrough" };
  }

  async triageTurn(i: TriageInput): Promise<TriageOutcome> {
    const run_id = i.claim.run_id; const lang = langOf(i.userText);
    const state = this.ompTurns.get(run_id);
    const held: { answered?: Parameters<CoreWorker["settleTriage"]>[3] } = {}; // the answered rows, retained once Jev succeeded
    try {
      return await this.triageTurnInner(i, state, lang, held);
    } catch (e) {
      // Any non-acting throw still produces exactly one finalisation: answered `fallback` when Jev had answered
      // (distill / reconcile / rolled-back inTx / card), skipped `error` when it had not (client threw).
      console.error(`triage: threw: ${e instanceof Error ? e.message : String(e)}`);
      this.settleTriage(i, state, lang, held.answered ? { ...held.answered, decision: held.answered.kind === "answered" ? "fallback" : held.answered.decision } : { kind: "skipped", reason: "error" });
      return state?.lessonSavedThisTurn ? { kind: "inform", note: memoryInformNote(state.lessonSavedThisTurn.id, state.lessonSavedThisTurn.theme) } : { kind: "fallthrough" };
    }
  }

  private async triageTurnInner(i: TriageInput, state: OmpTurnState | undefined, lang: Lang, held: { answered?: Parameters<CoreWorker["settleTriage"]>[3] }): Promise<TriageOutcome> {
    const run_id = i.claim.run_id;
    const mode = resolveJevTriageMode(process.env, this.ompDataDir());
    if (mode === "off") return this.triageSkip(i, state, lang, "disabled");
    if (this.runStore.triageOverrideFor(run_id)) return this.triageSkip(i, state, lang, "override");
    if (i.posture !== null) return this.triageSkip(i, state, lang, "posture");
    if (i.modality !== "text") return this.triageSkip(i, state, lang, "modality");
    if (!state) return this.triageSkip(i, state, lang, "error");
    const built = buildTriageState({ userText: i.userText, recentTurns: state.turnCtx.recentTurns, turnChars: state.turnCtx.turnChars, modality: i.modality,
      lastHougeTurn: lastHougeTurnOf(state.turnCtx.recentTurns, (this.ompOptions.jevNow?.() ?? new Date()).getTime()) }, this.broker ? (s) => this.broker!.redact(s) : undefined);
    if (!built.ok) return this.triageSkip(i, state, lang, built.skip);
    const d = await decide({ point: "triage", run_id, state: built.state, questions: TRIAGE_QUESTIONS, lang, client: this.jevClient(run_id),
      store: this.runStore, thresholdVersion: THRESHOLD_VERSION, ...(this.ompOptions.jevNow ? { now: this.ompOptions.jevNow } : {}) });
    if (d.status === "skipped") return this.triageSkip(i, state, lang, d.reason); // settleTriage checks laneLost before writing
    const verdict = triageVerdict(d.answers, resolveTriageBars(process.env), lang, d.model, calibrationRows(process.env));
    const lane = d.answers.lane!;
    const numbers = { lane: lane.choice, complete: d.answers.complete?.choice, scope: d.answers.scope?.choice, confidence: lane.confidence, top_prob: Math.max(...Object.values(lane.probabilities)), margin: marginOf(lane) };
    const answered = (decision: "act" | "fallback" | "shadow") => ({ kind: "answered" as const, rows: d.rows, decision, threshold_used: `${THRESHOLD_VERSION}:${verdict.kind}`, numbers });
    held.answered = answered("fallback"); // from here a throw settles as answered fallback (outer catch)
    if (mode === "shadow" || verdict.kind === "fallthrough") { this.settleTriage(i, state, lang, answered(mode === "shadow" ? "shadow" : "fallback")); return { kind: "fallthrough" }; }
    return this.runTriageLane(i, state, lang, verdict, answered);
  }

  /** True once the turn is gone: aborted signal, or its state replaced/deleted (ompComplete/ompFail delete it). */
  private laneLost(i: TriageInput, state: OmpTurnState): boolean {
    return i.signal.aborted || this.ompTurns.get(i.claim.run_id) !== state;
  }

  /** The lane: status is code; memory is the shared service; `finalize` runs inside the save transaction or, with no save, in its own. */
  private async runTriageLane(i: TriageInput, state: OmpTurnState, lang: Lang, v: TriageDecision,
    answered: (d: "act" | "fallback") => Parameters<CoreWorker["settleTriage"]>[3]): Promise<TriageOutcome> {
    const chatId = this.chatOf(i.claim.run_id);
    if (v.kind === "status") { this.settleTriage(i, state, lang, answered("act")); return { kind: "lane_reply", text: this.hougeStatusText(chatId), buttons: [] }; }
    if (v.kind !== "memory") { this.settleTriage(i, state, lang, answered("fallback")); return { kind: "fallthrough" }; }
    // inside the save transaction: settleTriage writes the act rows + event (its `finalized` flag flips only when the
    // transaction commits — settleTriage takes `{ inTx: true }` to defer the flag to the caller, which sets it after commit)
    const w = await this.runLessonWrite(i.claim, chatId, { scope: v.scope }, { source: "lane", signal: i.signal,
      inTx: () => this.settleTriage(i, state, lang, answered("act"), { inTx: true }) });
    if (w.committed) state.triageFinalized = true;
    if (!w.committed || !w.saved || !w.change_id || !w.theme) {
      // nothing durable / refused / dropped / hook rolled back / turn lost: the same finaliser writes answered fallback (nothing for a lost turn)
      this.settleTriage(i, state, lang, answered("fallback"));
      return { kind: "fallthrough" };
    }
    if (v.complete === "mixed") return { kind: "inform", note: memoryInformNote(w.saved.id, w.theme) };
    try {
      const row = this.runStore.getLesson(w.saved.id);
      return { kind: "lane_reply", ...this.memoryLaneCard({ lesson_id: w.saved.id, theme: w.theme, text: w.saved.lesson, ...(row?.avoid ? { avoid: row.avoid } : {}),
        ...(w.saved.supersededId !== undefined ? { superseded_id: w.saved.supersededId } : {}), verb: w.saved.verb as "add" | "update" | "supersede", change_id: w.change_id, run_id: i.claim.run_id }) };
    } catch (e) {
      // The save is committed and finalised as "act"; the planner answers and the note names the lesson (spec §5.1).
      console.error(`memory lane: card failed after save: ${e instanceof Error ? e.message : String(e)}`);
      return { kind: "inform", note: memoryInformNote(w.saved.id, w.theme) };
    }
  }
```

`OmpTurnState` gains `triageFinalized?: boolean`. `breakLaneFinalizeOnceForTest()` arms a one-shot throw inside the `inTx` writes (test-only). **Per-stage failure tests** (one each, all asserting exactly one `triage` row and the right `decision`): Jev client throws (`fetchImpl` rejects) → skipped `error`; distill LLM throws → answered `fallback` (3 rows `fallback`); reconcile throws → answered `fallback`; `inTx` throws → answered `fallback`, no lesson, guard unset; card throws after commit → `act` already written, `inform`; a lost turn at each of those points → zero rows and zero events. `this.memoryLaneCard` is a one-line indirection (`private memoryLaneCard = memoryLaneCard`) so `breakMemoryLaneCardForTest()` can swap it once; mark both `@internal`. A `mixed` verdict whose save returned nothing durable runs the planner with no note and no guard — it may spend a second distill/reconcile pair; accepted and documented in Task 14.

- [ ] **Step 5: Run, typecheck**

Run: `npx vitest run tests/core/core-worker-triage.test.ts tests/core/core-worker-lesson-service.test.ts tests/core/memory-lane-card.test.ts tests/omp/planner-supervisor.test.ts && npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add src/core/memory-lane-card.ts src/core/core-worker.ts tests/helpers/omp-worker.ts tests/core/memory-lane-card.test.ts tests/core/core-worker-triage.test.ts
git commit -m "feat(core): triageTurn — one finalisation per turn, atomic with the lane's save; failures after a save are named"
```

---

#### Rev 1 text retained for the code blocks referenced above (reference only; the Rev 2 steps above are the ones to execute)


**Files:**
- Create: `src/core/memory-lane-card.ts`
- Modify: `src/core/core-worker.ts` (`OmpWorkerOptions` `:218-225`, `supervisorDeps` `:2101-2113`, `resolveOmpMessage` `:2231-2240`, `ompComplete` `:2285-2303`, new `triageTurn` + helpers)
- Test: `tests/core/memory-lane-card.test.ts` (new), `tests/core/core-worker-triage.test.ts` (new)

**Interfaces:**
- Consumes: Tasks 2–8.
- Produces:
  ```ts
  // memory-lane-card.ts
  export const MEMLANE_UNDO_PREFIX = "memlane:undo:"; export const MEMLANE_ASK_PREFIX = "memlane:ask:";
  export function memoryLaneCard(i: { lesson_id: number; theme: string; text: string; avoid?: string; superseded_id?: number; verb: "add" | "update" | "supersede"; change_id: string; run_id: string }): { text: string; buttons: NotificationButton[] };
  export function memoryInformNote(lesson_id: number, theme: string): string;
  // core-worker.ts
  export interface OmpWorkerOptions { …; jevFetch?: typeof fetch; jevNow?: () => Date }
  triageTurn(i: TriageInput): Promise<TriageOutcome>;   // public for tests; wired as SupervisorDeps.triage
  ```

- [x] ~~Step 1: Write the failing card test**

Create `tests/core/memory-lane-card.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { memoryInformNote, memoryLaneCard } from "../../src/core/memory-lane-card.js";

// Spec §5.6: the card is code-owned, carries Undo + Ask Houge anyway, and callback data stays ≤ 64 bytes.
describe("memoryLaneCard", () => {
  const base = { lesson_id: 51, theme: "hygiene", text: "Never end a reply with a sign-off.", avoid: "祝好", verb: "update" as const, superseded_id: 44,
    change_id: "lc_12345678-1234-1234-1234-123456789abc", run_id: "run_12345678-1234-1234-1234-123456789abc" };
  it("renders header, lesson, AVOID and two buttons", () => {
    const c = memoryLaneCard(base);
    expect(c.text.split("\n")[0]).toBe("📒 Saved lesson #51 · hygiene (updated #44)");
    expect(c.text).toContain("Never end a reply with a sign-off.");
    expect(c.text).toContain("AVOID: ");
    expect(c.buttons).toEqual([{ text: "↩️ Undo", data: `memlane:undo:${base.change_id}` }, { text: "↪ Ask Houge anyway", data: `memlane:ask:${base.run_id}` }]);
    for (const b of c.buttons) expect(Buffer.byteLength(b.data, "utf8")).toBeLessThanOrEqual(64);
  });
  it("an add has no parenthetical; markdown-sensitive characters in the lesson are neutralised", () => {
    const c = memoryLaneCard({ ...base, verb: "add", superseded_id: undefined, avoid: undefined, text: "Use *short* [lists]" });
    expect(c.text.split("\n")[0]).toBe("📒 Saved lesson #51 · hygiene");
    expect(c.text).not.toContain("AVOID");
    expect(c.text).not.toMatch(/[*[\]]/);
  });
  it("the inform note names the lesson and forbids a second save", () => {
    expect(memoryInformNote(51, "format")).toBe("[memory] Lesson #51 (format) was just saved from this message; do not save it again.");
  });
});
```

- [x] ~~Step 2: Create `src/core/memory-lane-card.ts`**

```ts
import { inertCode } from "../capabilities/memory-correct.js";
import { escapeForTelegram } from "../capabilities/text-hygiene.js";
import type { NotificationButton } from "../notifications/notification-types.js";

/** Memory lane reply (ADR 0029 §5.6): code-owned, through the rich renderer, never a score or a "safe" word. */
export const MEMLANE_UNDO_PREFIX = "memlane:undo:";
export const MEMLANE_ASK_PREFIX = "memlane:ask:";
const CALLBACK_DATA_MAX_BYTES = 64;

function button(text: string, data: string): NotificationButton {
  if (Buffer.byteLength(data, "utf8") > CALLBACK_DATA_MAX_BYTES) throw new Error("memlane callback_data exceeds 64 bytes");
  return { text, data };
}

export function memoryLaneCard(i: {
  lesson_id: number; theme: string; text: string; avoid?: string; superseded_id?: number;
  verb: "add" | "update" | "supersede"; change_id: string; run_id: string;
}): { text: string; buttons: NotificationButton[] } {
  const tail = i.superseded_id !== undefined ? ` (${i.verb === "update" ? "updated" : "replaced"} #${i.superseded_id})` : "";
  const lines = [`📒 Saved lesson #${i.lesson_id} · ${i.theme}${tail}`, inertCode(escapeForTelegram(i.text))];
  if (i.avoid) lines.push(`AVOID: ${inertCode(escapeForTelegram(i.avoid))}`);
  return {
    text: lines.join("\n"),
    buttons: [button("↩️ Undo", `${MEMLANE_UNDO_PREFIX}${i.change_id}`), button("↪ Ask Houge anyway", `${MEMLANE_ASK_PREFIX}${i.run_id}`)]
  };
}

export function memoryInformNote(lesson_id: number, theme: string): string {
  return `[memory] Lesson #${lesson_id} (${theme}) was just saved from this message; do not save it again.`;
}
```

Run: `npx vitest run tests/core/memory-lane-card.test.ts` → PASS.

- [x] ~~Step 3: Write the failing `triageTurn` tests**

Create `tests/core/core-worker-triage.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JEV_MODEL } from "../../src/jev/jev-client.js";
import { RunStore } from "../../src/run/run-store.js";
import { createQueuedTurnRun } from "../helpers/runs.js";
import { ompWorker } from "../helpers/omp-worker.js";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const choice = (choice: string, probabilities: Record<string, number>) => {
  const n = Object.keys(probabilities).length; const pMax = Math.max(...Object.values(probabilities));
  return { type: "choice", choice, probabilities, confidence: (pMax - 1 / n) / (1 - 1 / n) };
};
const jevSays = (lane: Record<string, number>, complete: Record<string, number> = { mixed: 0.1, pure: 0.9 }, scope: Record<string, number> = { ask: 0.9, research: 0.1 }) =>
  vi.fn(async () => json(200, { model: JEV_MODEL, usage: { input_tokens: 800, output_tokens: 0 }, answers: {
    lane: choice(Object.entries(lane).sort((a, b) => b[1] - a[1])[0]![0], lane), complete: choice("pure", complete), scope: choice("ask", scope) } }));
const MEMORY = { none: 0.05, status: 0.05, memory: 0.9 };
const distillThenReconcile = async (input: Record<string, unknown>) => ({ ok: true as const, output: { answer:
  /durable/i.test(String(input.system ?? "")) ? JSON.stringify({ durable: true, lesson: "Keep replies short." }) : JSON.stringify({ verdict: "ADD", theme: "format" }) } });

function setup(fetchImpl: unknown, env: Record<string, string> = { HOUGE_JEV_ENABLED: "1", HOUGE_JEV_TRIAGE_ENABLED: "arm" }) {
  const store = RunStore.openInMemory();
  const root = mkdtempSync(join(tmpdir(), "htri-"));
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  process.env.TYPESAFE_API_KEY = "test-key";
  const worker = ompWorker(store, root, { llm: distillThenReconcile, jevFetch: fetchImpl as typeof fetch });
  const turn = (text: string) => {
    const run_id = createQueuedTurnRun(store, text);
    const claim = store.claimRun(run_id, "w", 120)!;
    worker.buildOmpTools(claim, "555");
    return { run_id, claim, input: { claim, text, userText: text, modality: "text" as const, posture: null, signal: new AbortController().signal } };
  };
  return { store, worker, turn };
}
const triageRows = (store: RunStore, run_id: string) => store.getLedgerEvents().filter((e) => e.event_type === "triage" && e.correlation_id === run_id).map((e) => e.payload);

describe("CoreWorker.triageTurn (spec §5.1 flow; every exit leaves exactly one triage row)", () => {
  const saved = { ...process.env };
  beforeEach(() => { for (const k of ["HOUGE_JEV_ENABLED", "HOUGE_JEV_TRIAGE_ENABLED", "TYPESAFE_API_KEY"]) delete process.env[k]; });
  afterEach(() => { process.env = { ...saved }; });

  it("flag off: skipped{disabled}, fallthrough, no fetch, one triage row", async () => {
    const fetchImpl = vi.fn();
    const { store, worker, turn } = setup(fetchImpl, {});
    const t = turn("以后回复短一点");
    expect(await worker.triageTurn(t.input)).toEqual({ kind: "fallthrough" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(triageRows(store, t.run_id)).toMatchObject([{ status: "skipped", skip_reason: "disabled", decision: "fallback" }]);
    store.close();
  });
  it("photo turn: skipped{modality}; killed posture: skipped{posture}", async () => {
    const { store, worker, turn } = setup(jevSays(MEMORY));
    const t = turn("caption");
    expect(await worker.triageTurn({ ...t.input, modality: "photo" })).toEqual({ kind: "fallthrough" });
    expect(triageRows(store, t.run_id)[0]).toMatchObject({ skip_reason: "modality" });
    store.close();
  });
  it("pure memory: saves through the service, replies with the card, marks decisions 'act'", async () => {
    const { store, worker, turn } = setup(jevSays(MEMORY));
    const t = turn("以后回复短一点");
    const out = await worker.triageTurn(t.input);
    expect(out.kind).toBe("lane_reply");
    if (out.kind !== "lane_reply") return;
    expect(out.text).toMatch(/^📒 Saved lesson #\d+ · format/);
    expect(out.buttons.map((b) => b.data.split(":")[1])).toEqual(["undo", "ask"]);
    expect(triageRows(store, t.run_id)).toMatchObject([{ status: "answered", lane: "memory", complete: "pure", scope: "ask", decision: "act", lang: "zh" }]);
    expect(store.listJevDecisions(t.run_id).every((r) => r.decision === "act")).toBe(true);
    store.close();
  });
  it("mixed memory: saves, returns the inform note, planner path continues", async () => {
    const { store, worker, turn } = setup(jevSays(MEMORY, { mixed: 0.7, pure: 0.3 }));
    const t = turn("以后短一点，另外今天天气？");
    const out = await worker.triageTurn(t.input);
    expect(out).toMatchObject({ kind: "inform", note: expect.stringMatching(/^\[memory\] Lesson #\d+ \(format\)/) });
    expect(triageRows(store, t.run_id)[0]).toMatchObject({ complete: "mixed", decision: "act" });
    store.close();
  });
  it("memory verdict but nothing durable: no card, fallthrough, decision 'fallback'", async () => {
    const { store, worker, turn } = setup(jevSays(MEMORY));
    const notDurable = async () => ({ ok: true as const, output: { answer: JSON.stringify({ durable: false }) } });
    const w2 = ompWorker(store, mkdtempSync(join(tmpdir(), "htri-")), { llm: notDurable, jevFetch: jevSays(MEMORY) as unknown as typeof fetch });
    const t = turn("谢谢你");
    w2.buildOmpTools(t.claim, "555");
    expect(await w2.triageTurn(t.input)).toEqual({ kind: "fallthrough" });
    expect(triageRows(store, t.run_id)[0]).toMatchObject({ lane: "memory", decision: "fallback" });
    store.close();
  });
  it("status: code-rendered houge_status text, no planner, no LLM", async () => {
    const { store, worker, turn } = setup(jevSays({ none: 0.1, status: 0.85, memory: 0.05 }));
    const t = turn("did you restart?");
    const out = await worker.triageTurn(t.input);
    expect(out.kind).toBe("lane_reply");
    if (out.kind === "lane_reply") { expect(out.buttons).toEqual([]); expect(out.text.length).toBeGreaterThan(10); }
    expect(triageRows(store, t.run_id)[0]).toMatchObject({ lane: "status", decision: "act" });
    store.close();
  });
  it("shadow mode: rows written with decision 'shadow', behaviour unchanged", async () => {
    const { store, worker, turn } = setup(jevSays(MEMORY), { HOUGE_JEV_ENABLED: "1", HOUGE_JEV_TRIAGE_ENABLED: "shadow" });
    const t = turn("以后回复短一点");
    expect(await worker.triageTurn(t.input)).toEqual({ kind: "fallthrough" });
    expect(triageRows(store, t.run_id)[0]).toMatchObject({ lane: "memory", decision: "shadow" });
    expect(store.getLedgerEvents().filter((e) => e.event_type === "lesson_saved")).toHaveLength(0);
    store.close();
  });
  it("Jev 429: skipped{rate_limited}, incident jev_rate_limited, fallthrough", async () => {
    const { store, worker, turn } = setup(vi.fn(async () => json(429, {})));
    const t = turn("以后回复短一点");
    expect(await worker.triageTurn(t.input)).toEqual({ kind: "fallthrough" });
    expect(triageRows(store, t.run_id)[0]).toMatchObject({ status: "skipped", skip_reason: "rate_limited" });
    expect(store.listOpenIncidents().some((i) => i.kind === "jev_rate_limited")).toBe(true);
    store.close();
  });
  it("an override run (Ask Houge anyway) is never triaged again", async () => {
    const fetchImpl = jevSays(MEMORY);
    const { store, worker, turn } = setup(fetchImpl);
    const t = turn("以后回复短一点");
    store.recordMemoryEvent("triage_override", { run_id: "run_old", new_run_id: t.run_id, change_id: null });
    expect(await worker.triageTurn(t.input)).toEqual({ kind: "fallthrough" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(triageRows(store, t.run_id)[0]).toMatchObject({ skip_reason: "override" });
    store.close();
  });
});
```

`ompWorker` must accept `jevFetch` and pass it into `OmpWorkerOptions` (edit `tests/helpers/omp-worker.ts` accordingly). The `ledger_events.correlation_id` for a run-scoped event is the run id (`appendRunLedgerEvent`); if the reader exposes it under another name, adapt `triageRows`.

- [x] ~~Step 4: Run to verify they fail**

Run: `npx vitest run tests/core/core-worker-triage.test.ts`
Expected: FAIL — `triageTurn` missing.

- [x] ~~Step 5: Implement in `core-worker.ts`**

Imports to add: `decide, recordSkip, type SkipReason` from `../jev/decide.js`; `createJevClient, type JevRequest, type JevResult` from `../jev/jev-client.js`; `langOf` from `../jev/intent-question.js`; `buildTriageState, TRIAGE_QUESTIONS` from `../jev/questions/triage.js`; `THRESHOLD_VERSION, resolveTriageBars, triageVerdict, type TriageDecision` from `../jev/thresholds.js`; `resolveJevTriageMode` from `../jev/jev-flags.js`; `memoryInformNote, memoryLaneCard` from `./memory-lane-card.js`; `type TriageInput, type TriageOutcome` from `../omp/planner-supervisor.js`.

`OmpWorkerOptions`: add `jevFetch?: typeof fetch;` (`/** Tests only: the Jev client's fetch. */`) and `jevNow?: () => Date;`.

`supervisorDeps`: add `triage: (i) => this.triageTurn(i),` after `resolveMessage`.

`resolveOmpMessage`: return `{ ok: true, text: r.text, userText: …, modality: r.modality }` (and widen its declared return type to include `modality`; `TurnModality` is `src/media/media-config.ts:9`).

`ompComplete`: `this.runStore.enqueueFinalReportNotification(i.run_id, { text, report_path: report.path, attachments: i.attachments, ...(i.buttons ? { buttons: i.buttons } : {}) });`

The triage implementation (keep each function under 50 lines):

```ts
  // ── Jev System One, lane 1 (ADR 0029 §5): the decision before the planner ─────────────────

  private jevClient(run_id: string): (req: JevRequest) => Promise<JevResult> {
    return createJevClient({
      apiKey: this.broker?.typesafeKey() ?? process.env.TYPESAFE_API_KEY,
      audit: this.runStore.llmAuditSink({ run_id, role: "triage" }),
      meteredBreached: () => this.runStore.meteredFuseLatched(),
      retries: 0, timeoutMs: 1_500,
      ...(this.ompOptions.jevFetch ? { fetchImpl: this.ompOptions.jevFetch } : {})
    });
  }

  /** One `triage` row per eligible Telegram turn, written after the outcome is known (the denominator, spec §3.2). */
  private recordTriage(run_id: string, p: { status: "answered" | "skipped"; lang: string; decision: "act" | "fallback" | "shadow"; skip_reason?: SkipReason;
    lane?: string; complete?: string; scope?: string; confidence?: number; top_prob?: number; margin?: number }): void {
    this.runStore.appendRunLedgerEvent(run_id, "triage", "core", {
      status: p.status, lane: p.lane ?? null, complete: p.complete ?? null, scope: p.scope ?? null, confidence: p.confidence ?? null,
      top_prob: p.top_prob ?? null, margin: p.margin ?? null, lang: p.lang, decision: p.decision, ...(p.skip_reason ? { skip_reason: p.skip_reason } : {})
    });
  }

  private triageSkip(run_id: string, lang: Lang, reason: SkipReason): TriageOutcome {
    recordSkip(this.runStore, "triage", run_id, lang, reason);
    this.recordTriage(run_id, { status: "skipped", lang, decision: "fallback", skip_reason: reason });
    return { kind: "fallthrough" };
  }

  async triageTurn(i: TriageInput): Promise<TriageOutcome> {
    const run_id = i.claim.run_id;
    const lang = langOf(i.userText);
    const mode = resolveJevTriageMode(process.env, this.ompDataDir());
    if (mode === "off") return this.triageSkip(run_id, lang, "disabled");
    if (this.runStore.triageOverrideFor(run_id)) return this.triageSkip(run_id, lang, "override");
    if (readTombstone()) return this.triageSkip(run_id, lang, "posture");
    if (i.modality !== "text") return this.triageSkip(run_id, lang, "modality");
    const state = this.ompTurns.get(run_id);
    if (!state) return this.triageSkip(run_id, lang, "error");
    const built = buildTriageState(this.triageStateInput(i, state), (s) => this.broker?.redact(s) ?? s);
    if (!built.ok) return this.triageSkip(run_id, lang, built.skip);
    const d = await decide({ point: "triage", run_id, state: built.state, questions: TRIAGE_QUESTIONS, lang, client: this.jevClient(run_id),
      store: this.runStore, thresholdVersion: THRESHOLD_VERSION, ...(this.ompOptions.jevNow ? { now: this.ompOptions.jevNow } : {}) });
    if (d.status === "skipped") { this.recordTriage(run_id, { status: "skipped", lang, decision: "fallback", skip_reason: d.reason }); return { kind: "fallthrough" }; }
    const verdict = triageVerdict(d.answers, resolveTriageBars(process.env), lang, d.model);
    const lane = d.answers.lane!;
    const numbers = { lane: lane.choice, complete: d.answers.complete?.choice, scope: d.answers.scope?.choice, confidence: lane.confidence,
      top_prob: Math.max(...Object.values(lane.probabilities)), margin: marginOf(lane) };
    const mark = (decision: "act" | "fallback" | "shadow") => { for (const id of Object.values(d.decisionIds)) this.runStore.markJevDecision(id, decision, `${THRESHOLD_VERSION}:${verdict.kind}`); };
    if (mode === "shadow") { mark("shadow"); this.recordTriage(run_id, { status: "answered", lang, decision: "shadow", ...numbers }); return { kind: "fallthrough" }; }
    const out = await this.runTriageLane(i, verdict);
    const decision = out.kind === "fallthrough" ? "fallback" : "act";
    mark(decision);
    this.recordTriage(run_id, { status: "answered", lang, decision, ...numbers });
    return out;
  }

  private triageStateInput(i: TriageInput, state: OmpTurnState): TriageStateInput {
    const last = [...state.turnCtx.recentTurns].reverse().find((t) => t.role === "assistant");
    const ageS = last ? Math.max(0, Math.round((Date.now() - Date.parse(last.created_at)) / 1000)) : 0;
    return {
      userText: i.userText, recentTurns: state.turnCtx.recentTurns, turnChars: state.turnCtx.turnChars, modality: i.modality,
      lastHougeTurn: last ? { kind: last.intent === "clarify" ? "clarify" : "answer", age_s: ageS } : null,
      pending: { rating_ask: this.runStore.getPendingRating(this.chatOf(i.claim.run_id)) !== undefined },
      lastTurnTools: last ? this.runStore.runLoopCapabilities(last.run_id) : []
    };
  }

  /** The lane itself: status is code; memory is the shared lesson-write service with every gate it already has. */
  private async runTriageLane(i: TriageInput, v: TriageDecision): Promise<TriageOutcome> {
    const chatId = this.chatOf(i.claim.run_id);
    if (v.kind === "status") return { kind: "lane_reply", text: this.hougeStatusText(chatId), buttons: [] };
    if (v.kind !== "memory") return { kind: "fallthrough" };
    const w = await this.runLessonWrite(i.claim, chatId, { scope: v.scope }, "lane");
    if (!w.saved?.id || !w.change_id || !w.theme || w.saved.verb === "capped" || w.saved.verb === "drop") return { kind: "fallthrough" };
    if (v.complete === "mixed") return { kind: "inform", note: memoryInformNote(w.saved.id, w.theme) };
    const row = this.runStore.getLesson(w.saved.id);
    return { kind: "lane_reply", ...memoryLaneCard({ lesson_id: w.saved.id, theme: w.theme, text: w.saved.lesson, ...(row?.avoid ? { avoid: row.avoid } : {}),
      ...(w.saved.supersededId !== undefined ? { superseded_id: w.saved.supersededId } : {}), verb: w.saved.verb, change_id: w.change_id, run_id: i.claim.run_id }) };
  }
```

Imports also need `marginOf` (decide.ts), `type Lang`, `type TriageStateInput`. `getPendingRating(chat)` and `runLoopCapabilities(run_id)` exist on the store (dossier §A cheap state, §F replay deps); if `getPendingRating` returns `null` rather than `undefined`, compare accordingly. `broker.redact` is `secret-broker.ts:76`; the broker is optional on CoreWorker (`private readonly broker?: SecretBroker`).

- [x] ~~Step 6: Run the triage tests, the lesson-service tests, the supervisor suite, typecheck**

Run: `npx vitest run tests/core/core-worker-triage.test.ts tests/core/core-worker-lesson-service.test.ts tests/core/memory-lane-card.test.ts tests/omp/planner-supervisor.test.ts && npm run typecheck`
Expected: PASS.

- [x] ~~Step 7: Commit**

```bash
git add src/core/memory-lane-card.ts src/core/core-worker.ts tests/helpers/omp-worker.ts tests/core/memory-lane-card.test.ts tests/core/core-worker-triage.test.ts
git commit -m "feat(core): triageTurn — flag, posture, modality, Jev, thresholds, status and memory lanes with the saved card"
```

---

---
### Task 10: Callbacks — `memlane:undo:*` / `memlane:ask:*` → events → gateway; chat-bound, single admission, override label

**Files:**
- Modify: `src/triggers/telegram-command-parser.ts` (after `:286`), `src/triggers/telegram-trigger-adapter.ts` (`normalizeCallbackQuery`, after the memory-undo branch), `src/domain/types.ts:4`, `src/gateway/gateway.ts` (constructor `:126`, result union `:60-80`, dispatch `:205-240`), `src/telegram/telegram-daemon.ts:151`, `src/telegram/telegram-poll-runner.ts:123` (pass `dataDir` to the gateway)
- Create: `src/gateway/memlane-commands.ts`
- Test: `tests/triggers/telegram-command-parser.test.ts` (extend), `tests/gateway/memlane-commands.test.ts` (new)

**Interfaces:**
- Produces:
  ```ts
  export function parseMemLaneCallback(data: unknown): { action: "undo"; change_id: string } | { action: "ask"; run_id: string } | null;   // parser
  // types.ts: TaskEventType += "memlane_undo" | "memlane_ask"
  // gateway.ts: constructor gains a 6th parameter `options: { dataDir?: string } = {}`; result union += { ok: true; status: "lesson_change_undone"; run_id: string }
  // memlane-commands.ts
  export const TRIAGE_OVERRIDE_LIMIT = 3; export const TRIAGE_OVERRIDE_WINDOW_DAYS = 7;
  export function handleMemLaneUndo(store: RunStore, event: TypedTaskEvent): GatewayIntakeResult;
  export function memLaneAskTurnEvent(store: RunStore, event: TypedTaskEvent): { ok: true; turnEvent: TypedTaskEvent; original_run_id: string } | { ok: false; result: GatewayIntakeResult };
  //   chat-bound: refuses unless getRunNotifyTarget(run_id) is this chat; builds the `turn` event from userTurnTextForRun with idempotency `${event.idempotency_key}:ask`
  export function recordTriageOverride(store: RunStore, original_run_id: string, new_run_id: string, env: NodeJS.ProcessEnv, dataDir: string, chat_id: string): void;
  //   ledger triage_override {run_id, new_run_id, change_id}; recordJevOutcome(id, "paco_correction", "override") for every jev_decisions row of the original run;
  //   ≥ TRIAGE_OVERRIDE_LIMIT in TRIAGE_OVERRIDE_WINDOW_DAYS → disarm marker + incident triage_overrides (subject "jev")
  ```
  **Single admission.** `Gateway.intake` rate-limits once per event (`gateway.ts:141`) before the `turn` branch (`:237`). For `memlane_ask` the gateway, **after** the limiter, rewrites the event into the turn event (`memLaneAskTurnEvent`) and continues into the same turn-creation branch — no nested `intake`, one admission. When that branch returns `created`, the gateway calls `recordTriageOverride` inside the same `inTransaction` as the run creation if the branch is synchronous (it is: `intake` returns a value, not a promise); otherwise immediately after, before returning. The daemon's existing `status === "created" → submitTurn` path then runs the planner turn; `triageTurn` sees `triageOverrideFor(run_id)` and skips with reason `override`.

- [ ] **Step 1: Parser test + implementation** — Rev 1 unchanged (`parseMemLaneCallback`, `TaskEventType`, adapter branch mirroring `buildMemoryUndoTapEvent`).

- [ ] **Step 2: Write the failing handler tests**

```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { handleMemLaneUndo, TRIAGE_OVERRIDE_LIMIT } from "../../src/gateway/memlane-commands.js";
import { jevDisarmMarkerPath, readJevDisarmMarker } from "../../src/jev/jev-flags.js";
import { RunStore } from "../../src/run/run-store.js";
import { createQueuedTurnRun } from "../helpers/runs.js";

const NOW = "2026-10-04T10:00:00.000Z";
const tap = (type: "memlane_undo" | "memlane_ask", metadata: Record<string, unknown>, chat = "555", key = `k:${Math.random()}`) => buildTypedTaskEvent({
  source: "telegram", type, requested_by: { kind: "user", id: "paco" }, notify: { kind: "telegram", chat_id: chat }, idempotency_key: key, source_reference: key,
  metadata: { telegram_update_id: 1, telegram_callback_id: key, ...metadata } });

describe("memlane callbacks (spec §5.6)", () => {
  it("undo: chat-bound, compare-and-set, event inside the transaction, second tap says already undone", () => {
    const store = RunStore.openInMemory();
    const id = store.addLesson({ scope: "ask", text: "rule", theme: "format", source: "lane", created_at: NOW });
    const change = store.insertLessonChange({ run_id: "run_x", chat_id: "555", new_id: id, superseded_id: null, pruned_ids: [] });
    expect(handleMemLaneUndo(store, tap("memlane_undo", { change_id: change.change_id }, "999")).ok).toBe(false);
    expect(store.getLesson(id)?.status).toBe("active");
    expect(handleMemLaneUndo(store, tap("memlane_undo", { change_id: change.change_id }))).toMatchObject({ ok: true, status: "lesson_change_undone" });
    expect(store.getLesson(id)?.status).toBe("pruned");
    expect(store.getLedgerEvents().some((e) => e.event_type === "lesson_change_undone" && e.payload.change_id === change.change_id)).toBe(true);
    expect(handleMemLaneUndo(store, tap("memlane_undo", { change_id: change.change_id })).ok).toBe(true);
    store.close();
  });
  it("ask: one admission, creates the planner turn, writes the override label and the outcome on the original decisions", () => {
    const store = RunStore.openInMemory(); const dir = mkdtempSync(join(tmpdir(), "mla-"));
    const original = createQueuedTurnRun(store, "以后回复短一点"); // chat 555
    store.recordChatTurn({ chat_id: "555", run_id: original, role: "user", text: "以后回复短一点" });
    const jd = store.insertJevDecision({ run_id: original, point: "triage", question_id: "lane", criteria_hash: "h", model_reported: "jev-1.13.0", state_hash: "s", lang: "zh",
      answers_json: "{}", confidence: 0.9, top_prob: 0.9, margin: 0.8, threshold_version: "v", threshold_used: null, decision: "act", latency_ms: 1, input_tokens: 1, status: "answered", skip_reason: null });
    const gateway = new Gateway(store, undefined, undefined, undefined, undefined, { dataDir: dir });
    const r = gateway.intake(tap("memlane_ask", { run_id: original }));
    expect(r.ok && r.status).toBe("created");
    const newRun = r.ok && "run_id" in r ? r.run_id : "";
    expect(store.triageOverrideFor(newRun)).toBe(true);
    expect(store.userTurnTextForRun(original)).toBe("以后回复短一点");
    expect(store.listJevDecisions(original).find((x) => x.decision_id === jd)).toMatchObject({ outcome_source: "paco_correction", outcome_value: "override" });
    store.close();
  });
  it("ask from another chat is refused and creates nothing", () => {
    const store = RunStore.openInMemory();
    const original = createQueuedTurnRun(store, "以后回复短一点");
    store.recordChatTurn({ chat_id: "555", run_id: original, role: "user", text: "以后回复短一点" });
    const r = new Gateway(store).intake(tap("memlane_ask", { run_id: original }, "999"));
    expect(r.ok).toBe(false);
    expect(store.countRecentLedgerEvents("triage_override", "2026-01-01T00:00:00.000Z")).toBe(0);
    store.close();
  });
  it("three overrides in seven days write the disarm marker and open triage_overrides", () => {
    const store = RunStore.openInMemory(); const dir = mkdtempSync(join(tmpdir(), "mla-"));
    const gateway = new Gateway(store, undefined, undefined, undefined, undefined, { dataDir: dir });
    for (let i = 0; i < TRIAGE_OVERRIDE_LIMIT; i++) {
      const run = createQueuedTurnRun(store, `msg ${i}`); store.recordChatTurn({ chat_id: "555", run_id: run, role: "user", text: `msg ${i}` });
      expect(gateway.intake(tap("memlane_ask", { run_id: run })).ok).toBe(true);
    }
    expect(readJevDisarmMarker(jevDisarmMarkerPath({}, dir))?.reason).toBe("triage_overrides");
    expect(store.listOpenIncidents().some((i) => i.kind === "triage_overrides")).toBe(true);
    store.close();
  });
});
```

`createQueuedTurnRun` goes through the real gateway with chat `555` (helper), so `getRunNotifyTarget(original)` is `{kind:"telegram", chat_id:"555"}`. The per-chat rate limit is 5 accepted/min: the fourth test makes three `ask` admissions plus three `createQueuedTurnRun` admissions in one chat — if the limiter trips, create the three runs under distinct `requested_by.id`s or use the limiter's test bypass the gateway tests use.

- [ ] **Step 3: Run to verify they fail.**

- [ ] **Step 4: Implement**

`src/gateway/memlane-commands.ts`:

```ts
import { buildTypedTaskEvent, type TypedTaskEvent } from "../domain/types.js";
import type { GatewayIntakeResult } from "./gateway.js";
import { oncePerTrigger, replyTo } from "./memory-commands.js";
import { jevDisarmMarkerPath, writeJevDisarmMarker } from "../jev/jev-flags.js";
import { openAlertedIncident } from "../run/incident-alert.js";
import type { RunStore } from "../run/run-store.js";

export const TRIAGE_OVERRIDE_LIMIT = 3;
export const TRIAGE_OVERRIDE_WINDOW_DAYS = 7;
export const LESSON_CHANGE_NOT_FOUND_TEXT = "That lesson change does not exist here, so nothing was undone.";
export const LESSON_CHANGED_SINCE_TEXT = "↩️ Not undone: that lesson has changed since; use /lessons.";
export const LESSON_ALREADY_UNDONE_TEXT = "↩️ Already undone.";
export const MEMLANE_ASK_NOT_FOUND_TEXT = "I can't find that message any more; please send it again.";

const chatOf = (e: TypedTaskEvent): string => (e.notify.kind === "telegram" ? e.notify.chat_id : "");

export function handleMemLaneUndo(store: RunStore, event: TypedTaskEvent): GatewayIntakeResult {
  return oncePerTrigger(store, event, () => {
    const change_id = typeof event.metadata?.change_id === "string" ? event.metadata.change_id : "";
    const change = store.getLessonChange(change_id);
    if (!change || change.chat_id !== chatOf(event)) {
      replyTo(store, event, "memlane_undo_refused", LESSON_CHANGE_NOT_FOUND_TEXT);
      return { ok: false, error: { code: "LESSON_CHANGE_NOT_FOUND", message: "No such lesson change in this chat" } };
    }
    const r = store.undoLessonChange(change_id); // writes lesson_change_undone inside its transaction (Task 4)
    const text = r.status === "undone"
      ? `↩️ Undone: lesson #${change.new_id} retired, restored #${r.restored.join(", #") || "—"}${r.skipped.length ? ` (left as is: #${r.skipped.join(", #")})` : ""}.`
      : r.status === "changed_since" ? LESSON_CHANGED_SINCE_TEXT : LESSON_ALREADY_UNDONE_TEXT;
    replyTo(store, event, "memlane_undo", text);
    return { ok: true, status: "lesson_change_undone", run_id: "" };
  });
}

/** Chat-bound: the original run must notify THIS chat. Builds the turn event the gateway then admits as an ordinary turn. */
export function memLaneAskTurnEvent(store: RunStore, event: TypedTaskEvent): { ok: true; turnEvent: TypedTaskEvent; original_run_id: string } | { ok: false; result: GatewayIntakeResult } {
  const run_id = typeof event.metadata?.run_id === "string" ? event.metadata.run_id : "";
  let target: ReturnType<RunStore["getRunNotifyTarget"]> | null = null;
  try { target = run_id ? store.getRunNotifyTarget(run_id) : null; } catch { target = null; } // unknown run: getRunNotifyTarget throws (run-store.ts:6181) → refusal
  const text = run_id ? store.userTurnTextForRun(run_id) : undefined;
  if (!text || !target || target.kind !== "telegram" || target.chat_id !== chatOf(event)) {
    replyTo(store, event, "memlane_ask_refused", MEMLANE_ASK_NOT_FOUND_TEXT);
    return { ok: false, result: { ok: false, error: { code: "MEMLANE_ASK_NOT_FOUND", message: "No such turn in this chat" } } };
  }
  return { ok: true, original_run_id: run_id, turnEvent: buildTypedTaskEvent({ source: "telegram", type: "turn", program: "turn", goal: text, requested_by: event.requested_by,
    notify: event.notify, idempotency_key: `${event.idempotency_key}:ask`, source_reference: `${event.source_reference}:ask` }) };
}

/** The override label (spec §5.9) and the drift signal: three in seven days cap the lane at shadow through the persisted marker. */
export function recordTriageOverride(store: RunStore, original_run_id: string, new_run_id: string, env: NodeJS.ProcessEnv, dataDir: string, chat_id: string): void {
  const change_id = store.getLessonChangeByRun(original_run_id)?.change_id ?? null;
  store.recordMemoryEvent("triage_override", { run_id: original_run_id, new_run_id, change_id });
  for (const d of store.listJevDecisions(original_run_id)) store.recordJevOutcome(d.decision_id, "paco_correction", "override");
  const since = new Date(Date.now() - TRIAGE_OVERRIDE_WINDOW_DAYS * 86_400_000).toISOString();
  if (store.countRecentLedgerEvents("triage_override", since) >= TRIAGE_OVERRIDE_LIMIT) {
    writeJevDisarmMarker(jevDisarmMarkerPath(env, dataDir), "triage_overrides");
    openAlertedIncident(store, { kind: "triage_overrides", subject: "jev", detail: { window_days: TRIAGE_OVERRIDE_WINDOW_DAYS, limit: TRIAGE_OVERRIDE_LIMIT }, chat_id });
  }
}
```

`getRunNotifyTarget(run_id)` exists (`core-worker.ts:2078` uses it). Add `getLessonChangeByRun(run_id)` to the store in this task (latest `lesson_changes` row for the run, `pruned_ids` parsed).

`src/gateway/gateway.ts`: constructor gains `private readonly options: { dataDir?: string } = {}` as the 6th parameter; in `intake`, right **after** the rate-limit block and **before** `if (event.type === "turn")`:

```ts
    // Memory lane "Ask Houge anyway" (ADR 0029 §5.6): one admission, then an ordinary turn whose triage is skipped by its override row.
    let memLaneAsk: { original_run_id: string } | undefined;
    if (event.type === "memlane_ask") {
      const prep = memLaneAskTurnEvent(this.runStore, event);
      if (!prep.ok) return prep.result;
      memLaneAsk = { original_run_id: prep.original_run_id };
      event = prep.turnEvent;
    }
    if (event.type === "memlane_undo") return this.accepted(event, now, handleMemLaneUndo(this.runStore, event));
```

and in the `turn` branch: when `memLaneAsk` is set, wrap the run creation and the override writes in **one** `this.runStore.inTransaction(() => { const r = this.handleTaskIntake(event, now); if (r.ok && r.status === "created") recordTriageOverride(…, r.run_id, …); return r; })` — `handleTaskIntake` (`gateway.ts:1021-1068`) is synchronous and opens no transaction of its own (verify with `rg inTransaction src/gateway`; if it does, hoist that one). `created` is returned only after the commit. **A resumed duplicate can also report `status: "created"`** (`resumeDuplicate`, `gateway.ts:1080`): write the override label only when the branch reports a genuinely new run — read the duplicate marker that path sets (or compare `getRunState`/created_at before and after) and skip the label and the override event otherwise; a redelivered callback must return the same run with no second `triage_override` row (test). `getRunNotifyTarget` **throws** for an unknown run (`run-store.ts:6181`): `memLaneAskTurnEvent` wraps it in try/catch and maps a throw to the chat-bound refusal. (`event` must be a `let` for the rewrite, or shadow it with a local; keep the original for the trigger audit if the branch records it.) Tests: a label-write failure (spy `recordMemoryEvent` to throw once) leaves no new run; a redelivered callback returns the same run without a second `triage_override` row. Thread `{ dataDir }` from `telegram-daemon.ts:151` and `telegram-poll-runner.ts:123` (the same `dataDir` the worker's `ompOptions` receives).

- [ ] **Step 5: Run, typecheck**

Run: `npx vitest run tests/triggers/telegram-command-parser.test.ts tests/gateway && npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add src/triggers/telegram-command-parser.ts src/triggers/telegram-trigger-adapter.ts src/domain/types.ts src/gateway/gateway.ts src/gateway/memlane-commands.ts src/run/run-store.ts src/telegram/telegram-daemon.ts src/telegram/telegram-poll-runner.ts tests/triggers/telegram-command-parser.test.ts tests/gateway/memlane-commands.test.ts
git commit -m "feat(gateway): memory lane Undo and Ask-Houge-anyway taps; chat-bound, one admission, override label and auto-disable"
```

---

#### Rev 1 text retained for the code blocks referenced above (reference only; the Rev 2 steps above are the ones to execute)


**Files:**
- Modify: `src/triggers/telegram-command-parser.ts` (after `parseMemoryUndoCallback`, `:281-286`), `src/triggers/telegram-trigger-adapter.ts` (`normalizeCallbackQuery`, after the memory-undo branch), `src/domain/types.ts:4` (`TaskEventType`), `src/gateway/gateway.ts` (result union `:60-80`, dispatch `:205-222`)
- Create: `src/gateway/memlane-commands.ts`
- Test: `tests/triggers/telegram-command-parser.test.ts` (extend), `tests/gateway/memlane-commands.test.ts` (new)

**Interfaces:**
- Produces:
  ```ts
  // parser
  export function parseMemLaneCallback(data: unknown): { action: "undo"; change_id: string } | { action: "ask"; run_id: string } | null;
  // types.ts: TaskEventType += "memlane_undo" | "memlane_ask"
  // gateway result union += { ok: true; status: "lesson_change_undone"; run_id: string }
  // memlane-commands.ts
  export const TRIAGE_OVERRIDE_LIMIT = 3; export const TRIAGE_OVERRIDE_WINDOW_DAYS = 7;
  export function handleMemLaneUndo(store: RunStore, event: TypedTaskEvent): GatewayIntakeResult;
  export function prepareMemLaneAsk(store: RunStore, event: TypedTaskEvent, env: NodeJS.ProcessEnv, dataDir: string): { ok: true; turnEvent: TypedTaskEvent } | { ok: false; result: GatewayIntakeResult };
  ```
  The gateway, on `memlane_ask`, calls `prepareMemLaneAsk` and then `return this.intake(turnEvent)` so the daemon's existing `status === "created" → submitTurn` path runs the re-submitted planner turn.

- [x] ~~Step 1: Write the failing parser tests**

Append to `tests/triggers/telegram-command-parser.test.ts`:

```ts
describe("parseMemLaneCallback (spec §5.6)", () => {
  const lc = "lc_12345678-1234-1234-1234-123456789abc"; const run = "run_12345678-1234-1234-1234-123456789abc";
  it("parses undo and ask and rejects anything else", () => {
    expect(parseMemLaneCallback(`memlane:undo:${lc}`)).toEqual({ action: "undo", change_id: lc });
    expect(parseMemLaneCallback(`memlane:ask:${run}`)).toEqual({ action: "ask", run_id: run });
    expect(parseMemLaneCallback("memlane:undo:evil")).toBeNull();
    expect(parseMemLaneCallback(`memlane:merge:${run}`)).toBeNull();
    expect(parseMemLaneCallback(42)).toBeNull();
  });
});
```

- [x] ~~Step 2: Add the parser and the event wiring**

`src/triggers/telegram-command-parser.ts`:

```ts
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const MEMLANE_UNDO = new RegExp(`^memlane:undo:(lc_${UUID})$`);
const MEMLANE_ASK = new RegExp(`^memlane:ask:(run_${UUID})$`);

/** Memory lane card taps (ADR 0029 §5.6). Exact shapes only; anything else is TELEGRAM_COMMAND_INVALID downstream. */
export function parseMemLaneCallback(data: unknown): { action: "undo"; change_id: string } | { action: "ask"; run_id: string } | null {
  if (typeof data !== "string") return null;
  const undo = MEMLANE_UNDO.exec(data); if (undo) return { action: "undo", change_id: undo[1]! };
  const ask = MEMLANE_ASK.exec(data); if (ask) return { action: "ask", run_id: ask[1]! };
  return null;
}
```

`src/domain/types.ts:4`: add `| "memlane_undo" | "memlane_ask"`.

`src/triggers/telegram-trigger-adapter.ts`, in `normalizeCallbackQuery` right after the `parseMemoryUndoCallback` branch and before `parseSelfWriteCallback`:

```ts
  const memlane = parseMemLaneCallback(callback.data);
  if (memlane) {
    return {
      ok: true,
      event: buildTypedTaskEvent({
        source: "telegram", type: memlane.action === "undo" ? "memlane_undo" : "memlane_ask", requested_by: identity,
        notify: { kind: "telegram", chat_id: String(message.chat.id) },
        idempotency_key: `telegram:${update.update_id}:callback:${callback.id}`,
        source_reference: `telegram:update:${update.update_id}:callback:${callback.id}`,
        metadata: { telegram_update_id: update.update_id, telegram_callback_id: callback.id,
          ...(memlane.action === "undo" ? { change_id: memlane.change_id } : { run_id: memlane.run_id }) }
      })
    };
  }
```

Copy the exact return shape from `buildMemoryUndoTapEvent` (`:316-327`): if that helper wraps the event differently (e.g. returns `{ ok: true, event }` via a shared function), mirror it.

- [x] ~~Step 3: Write the failing handler tests**

Create `tests/gateway/memlane-commands.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { handleMemLaneUndo, prepareMemLaneAsk, TRIAGE_OVERRIDE_LIMIT } from "../../src/gateway/memlane-commands.js";
import { readJevDisarmMarker, jevDisarmMarkerPath } from "../../src/jev/jev-flags.js";
import { RunStore } from "../../src/run/run-store.js";
import { createQueuedTurnRun } from "../helpers/runs.js";

const NOW = "2026-10-04T10:00:00.000Z";
const tap = (type: "memlane_undo" | "memlane_ask", metadata: Record<string, unknown>, chat = "555", key = `k:${Math.random()}`) => buildTypedTaskEvent({
  source: "telegram", type, requested_by: { kind: "user", id: "paco" }, notify: { kind: "telegram", chat_id: chat },
  idempotency_key: key, source_reference: key, metadata: { telegram_update_id: 1, telegram_callback_id: key, ...metadata } });

// Spec §5.6: Undo is compare-and-set and chat-bound; "Ask Houge anyway" re-submits the original text with triage off,
// is the override label, and three in seven days auto-disable the lane to shadow.
describe("memlane callbacks", () => {
  it("undo restores rows and replies; a foreign chat is refused; a second tap says already undone", () => {
    const store = RunStore.openInMemory();
    const id = store.addLesson({ scope: "ask", text: "rule", theme: "format", source: "lane", created_at: NOW });
    const change = store.insertLessonChange({ run_id: "run_x", chat_id: "555", new_id: id, superseded_id: null, pruned_ids: [] });
    expect(handleMemLaneUndo(store, tap("memlane_undo", { change_id: change.change_id }, "999")).ok).toBe(false);
    expect(store.getLesson(id)?.status).toBe("active");
    const r = handleMemLaneUndo(store, tap("memlane_undo", { change_id: change.change_id }));
    expect(r).toMatchObject({ ok: true, status: "lesson_change_undone" });
    expect(store.getLesson(id)?.status).toBe("pruned");
    expect(store.getLedgerEvents().some((e) => e.event_type === "lesson_change_undone" && e.payload.change_id === change.change_id)).toBe(true);
    const again = handleMemLaneUndo(store, tap("memlane_undo", { change_id: change.change_id }));
    expect(again.ok).toBe(true);
    store.close();
  });
  it("ask re-submits the original text as a planner turn with an override row, and the gateway creates the run", () => {
    const store = RunStore.openInMemory(); const dir = mkdtempSync(join(tmpdir(), "mla-"));
    const original = createQueuedTurnRun(store, "以后回复短一点");
    store.recordChatTurn({ chat_id: "555", run_id: original, role: "user", text: "以后回复短一点" });
    const prep = prepareMemLaneAsk(store, tap("memlane_ask", { run_id: original }), {}, dir);
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;
    expect(prep.turnEvent.type).toBe("turn");
    expect(prep.turnEvent.goal).toBe("以后回复短一点");
    const intake = new Gateway(store).intake(prep.turnEvent);
    expect(intake.ok && intake.status).toBe("created");
    const newRun = intake.ok && "run_id" in intake ? intake.run_id : "";
    expect(store.triageOverrideFor(newRun)).toBe(true);
    store.close();
  });
  it("three overrides in seven days write the disarm marker and open triage_overrides", () => {
    const store = RunStore.openInMemory(); const dir = mkdtempSync(join(tmpdir(), "mla-"));
    for (let i = 0; i < TRIAGE_OVERRIDE_LIMIT; i++) {
      const run = createQueuedTurnRun(store, `msg ${i}`);
      store.recordChatTurn({ chat_id: "555", run_id: run, role: "user", text: `msg ${i}` });
      const prep = prepareMemLaneAsk(store, tap("memlane_ask", { run_id: run }), {}, dir);
      expect(prep.ok).toBe(true);
      if (prep.ok) new Gateway(store).intake(prep.turnEvent);
    }
    expect(readJevDisarmMarker(jevDisarmMarkerPath({}, dir))?.reason).toBe("triage_overrides");
    expect(store.listOpenIncidents().some((i) => i.kind === "triage_overrides")).toBe(true);
    store.close();
  });
});
```

Note: `prepareMemLaneAsk` writes the `triage_override` ledger row with the **new** run id, so it must mint the new idempotency key deterministically (`${event.idempotency_key}:ask`) and the gateway must create the run with exactly that key; the row is written **before** the intake with `new_run_id` = the run id the gateway will assign. Since the gateway assigns `run_${uuid}` itself, do it the other way round: `prepareMemLaneAsk` returns the turn event; the gateway, after `this.intake(turnEvent)` returns `created`, calls `recordTriageOverride(store, event, created.run_id, env, dataDir)` (exported from the same module) which writes the ledger row and runs the override count. Adjust the second test to call that helper the way the gateway does if the direct `intake` path in the test does not reach it — simplest: expose `handleMemLaneAsk(store, event, intake: (e) => GatewayIntakeResult, env, dataDir): GatewayIntakeResult` that does prepare → intake → record, and have both the gateway and the test call it.

- [x] ~~Step 4: Create `src/gateway/memlane-commands.ts`**

```ts
import { buildTypedTaskEvent, type TypedTaskEvent } from "../domain/types.js";
import type { GatewayIntakeResult } from "./gateway.js";
import { oncePerTrigger, replyTo } from "./memory-commands.js";
import { jevDisarmMarkerPath, writeJevDisarmMarker } from "../jev/jev-flags.js";
import { openAlertedIncident } from "../run/incident-alert.js";
import type { RunStore } from "../run/run-store.js";

/** Memory lane card taps (ADR 0029 §5.6). Undo is compare-and-set; "Ask Houge anyway" is the override label. */
export const TRIAGE_OVERRIDE_LIMIT = 3;
export const TRIAGE_OVERRIDE_WINDOW_DAYS = 7;
export const LESSON_CHANGE_NOT_FOUND_TEXT = "That lesson change does not exist here, so nothing was undone.";
export const LESSON_CHANGED_SINCE_TEXT = "↩️ Not undone: that lesson has changed since; use /lessons.";
export const LESSON_ALREADY_UNDONE_TEXT = "↩️ Already undone.";
export const MEMLANE_ASK_NOT_FOUND_TEXT = "I can't find that message any more; please send it again.";

const chatOf = (e: TypedTaskEvent): string => (e.notify.kind === "telegram" ? e.notify.chat_id : "");

export function handleMemLaneUndo(store: RunStore, event: TypedTaskEvent): GatewayIntakeResult {
  return oncePerTrigger(store, event, () => {
    const change_id = typeof event.metadata?.change_id === "string" ? event.metadata.change_id : "";
    const change = store.getLessonChange(change_id);
    if (!change || change.chat_id !== chatOf(event)) {
      replyTo(store, event, "memlane_undo_refused", LESSON_CHANGE_NOT_FOUND_TEXT);
      return { ok: false, error: { code: "LESSON_CHANGE_NOT_FOUND", message: "No such lesson change in this chat" } };
    }
    const r = store.undoLessonChange(change_id);
    if (r.status === "undone") {
      store.recordMemoryEvent("lesson_change_undone", { change_id, restored: r.restored, skipped: r.skipped });
      const skipped = r.skipped.length > 0 ? ` (left as is: #${r.skipped.join(", #")})` : "";
      replyTo(store, event, "memlane_undo", `↩️ Undone: lesson #${change.new_id} retired, restored #${r.restored.join(", #") || "—"}${skipped}.`);
    } else {
      replyTo(store, event, "memlane_undo", r.status === "changed_since" ? LESSON_CHANGED_SINCE_TEXT : LESSON_ALREADY_UNDONE_TEXT);
    }
    return { ok: true, status: "lesson_change_undone", run_id: "" };
  });
}

/**
 * Re-submit the original message as a planner turn with triage off. The override row is the calibration label
 * (spec §5.9) and the drift signal: three in seven days cap the lane at shadow through the persisted marker.
 */
export function handleMemLaneAsk(
  store: RunStore, event: TypedTaskEvent, intake: (e: TypedTaskEvent) => GatewayIntakeResult, env: NodeJS.ProcessEnv, dataDir: string
): GatewayIntakeResult {
  return oncePerTrigger(store, event, () => {
    const run_id = typeof event.metadata?.run_id === "string" ? event.metadata.run_id : "";
    const text = store.userTurnTextForRun(run_id);
    if (!text) {
      replyTo(store, event, "memlane_ask_refused", MEMLANE_ASK_NOT_FOUND_TEXT);
      return { ok: false, error: { code: "MEMLANE_ASK_NOT_FOUND", message: "No user turn for that run" } };
    }
    const created = intake(buildTypedTaskEvent({
      source: "telegram", type: "turn", program: "turn", goal: text, requested_by: event.requested_by, notify: event.notify,
      idempotency_key: `${event.idempotency_key}:ask`, source_reference: `${event.source_reference}:ask`
    }));
    if (!created.ok || created.status !== "created") return created;
    const change_id = store.getLessonChangeByRun?.(run_id)?.change_id ?? null;
    store.recordMemoryEvent("triage_override", { run_id, new_run_id: created.run_id, change_id });
    const since = new Date(Date.now() - TRIAGE_OVERRIDE_WINDOW_DAYS * 86_400_000).toISOString();
    if (store.countRecentLedgerEvents("triage_override", since) >= TRIAGE_OVERRIDE_LIMIT) {
      writeJevDisarmMarker(jevDisarmMarkerPath(env, dataDir), "triage_overrides");
      openAlertedIncident(store, { kind: "triage_overrides", subject: "jev", detail: { window_days: TRIAGE_OVERRIDE_WINDOW_DAYS, limit: TRIAGE_OVERRIDE_LIMIT }, chat_id: chatOf(event) });
    }
    return created;
  });
}
```

Drop the `getLessonChangeByRun?.` optional call: add `getLessonChangeByRun(run_id: string): LessonChange | undefined` to the store in this task (`SELECT * FROM lesson_changes WHERE run_id = ? ORDER BY created_at DESC LIMIT 1`, parse `pruned_ids`) and call it plainly. Check `buildTypedTaskEvent`'s required fields for a `turn` (`program`, `goal`) against `src/domain/types.ts:123` and the smoke script's `intake` in the dossier (§K), which is the canonical shape.

`src/gateway/gateway.ts`: result union gains `| { ok: true; status: "lesson_change_undone"; run_id: string }`; dispatch gains, next to `memory_undo`:

```ts
    if (event.type === "memlane_undo") return this.accepted(event, now, handleMemLaneUndo(this.runStore, event));
    if (event.type === "memlane_ask") return handleMemLaneAsk(this.runStore, event, (e) => this.intake(e), process.env, this.dataDir ?? process.cwd());
```

The gateway needs the data dir for the marker: add an optional constructor option `{ dataDir?: string }` if `Gateway` has none (check its constructor; the daemon constructs it in `telegram-daemon.ts` — pass the same `dataDir` the worker gets). If `accepted()` wraps results in a way `handleMemLaneAsk`'s nested `intake` result does not fit, return the nested result directly as written (it is already a complete `GatewayIntakeResult`).

Update the second and third tests to call `handleMemLaneAsk(store, event, (e) => new Gateway(store).intake(e), {}, dir)`.

- [x] ~~Step 5: Run the tests + typecheck**

Run: `npx vitest run tests/triggers/telegram-command-parser.test.ts tests/gateway/memlane-commands.test.ts tests/gateway && npm run typecheck`
Expected: PASS (the gateway's existing exhaustive-type tests still compile).

- [x] ~~Step 6: Commit**

```bash
git add src/triggers/telegram-command-parser.ts src/triggers/telegram-trigger-adapter.ts src/domain/types.ts src/gateway/gateway.ts src/gateway/memlane-commands.ts src/run/run-store.ts tests/triggers/telegram-command-parser.test.ts tests/gateway/memlane-commands.test.ts
git commit -m "feat(gateway): memory lane Undo and Ask-Houge-anyway taps; override label and auto-disable"
```

---

---
### Task 11: Replay — `replay-core`, the lane 1 replay (live-identical state), Wilson bound, the §5.9 report, option permutation

**Files:**
- Create: `src/jev/wilson.ts`, `src/jev/replay-core.ts`, `src/jev/triage-replay.ts`, `src/jev/triage-report.ts`
- Test: `tests/jev/wilson.test.ts`, `tests/jev/replay-core.test.ts`, `tests/jev/triage-replay.test.ts`, `tests/jev/triage-report.test.ts`

**Interfaces:**
- Produces (changes from Rev 1 in bold):
  ```ts
  // wilson.ts — as Rev 1
  // replay-core.ts — as Rev 1, with: readDone(outPath, done) keeps the LATEST row per key (a later failed row re-opens the key, like replay.ts:66);
  //   dry run returns { rows, universe, wouldDispatch, alreadyDone, skipped } and writes nothing; dispatch rows carry `attempt` (1-based) so a resumed run is visible
  // triage-replay.ts
  export const TRIAGE_REPLAY_OUT = ".houge/jev-triage/replay.jsonl"; export const TRIAGE_PERMUTED_OUT = ".houge/jev-triage/replay-permuted.jsonl"; export const TRIAGE_LABELS_PATH = ".houge/jev-triage/labels.jsonl";
  export const TRIAGE_LABEL_SINCE = "2026-07-02T00:00:00.000Z";
  export interface TriageReplayRow { …Rev 1 fields…; state_hash: string; p_none_tools?: never }   // state_hash joins to jev_decisions.state_hash (same buildTriageState, same lastHougeTurnOf, same sanitiser)
  export async function runTriageReplay(d: { store; env; jev; outPath; maxUsd; dryRun; limit?; log?; permute?: boolean }): Promise<ReplayCoreOutcome<TriageReplayRow>>;
  //   permute: asks TRIAGE_LANE with its options REVERSED (memory, status, none) and writes to TRIAGE_PERMUTED_OUT — the order-bias measurement spec §3.6 requires before arming
  export function loadLabels(path: string): Map<string, TriageLabel>;
  // triage-report.ts
  export interface TriageShadowStats { days: number; matched_lesson_write: number; pure_on_tool_turns: number; pure_on_no_tool_turns: number }
  export function formatTriageReport(rows, labels, outcome, bars, permuted?: TriageReplayRow[], shadow?: TriageShadowStats): string;  // no shadow stats → the ROWS TO ADD block is impossible
  //   per language: recall (proxy) / recall (human) / precision (human) / coverage / status precision, each with n and Wilson LB;
  //   threshold sweep 0.5–0.9 over p(memory) and p(pure): coverage and the two costly cells at each;
  //   confusion matrix verdict × observed action (lesson_write-only / other tools / no tools);
  //   COSTLY cells: pure on other-tool turns, pure on NO-tool turns, pure on human-labelled non-memory — all three;
  //   permutation agreement (verdict equality between canonical and reversed order, with n);
  //   INCOMPLETE when stopped, when any required set has n = 0 labels, or when the permuted run is missing; DRY RUN headline with universe/would-dispatch/done/skipped;
  //   "ROWS TO ADD" block (CalibrationRow JSON per question × language) ONLY when every §5.9 bar holds for that language.
  ```

- [ ] **Step 1: Wilson** — Rev 1 unchanged.

- [ ] **Step 2: replay-core test** (new `tests/jev/replay-core.test.ts`): a fake source of three keys; a dispatch that fails key 2 on the first run (`status: "jev_failed"`) and succeeds on the second; assert the second run re-dispatches only key 2 (latest-row-wins) and leaves 1 and 3 untouched; a dry run returns `{ universe: 3, wouldDispatch: 3, alreadyDone: 0 }` and creates no file.

- [ ] **Step 3: triage replay test** — Rev 1's `tests/jev/triage-replay.test.ts` with the seed corrected: each seeded run gets an assistant turn with a non-null `intent` (`listReplayTurns` requires it, `run-store.ts:1152-1176`) and `loop_step` rows with the real payload (`step, action, capability, ok, result_digest`, `run-ledger.ts:209`). Add: the row's `state_hash` equals `stateHash(buildTriageState({...same inputs...}).state)` computed in the test from `lastHougeTurnOf(recent, Date.parse(anchor))` — proving the replay builds the live state; and a `permute: true` run writes to the permuted path with reversed `lane` options.

- [ ] **Step 4: Implement `triage-replay.ts`** — Rev 1 with: imports `resolveChatContextTurns, chatContextSince, resolveChatContextTurnChars` **from `../capabilities/intent.js`** (as `replay.ts:3-6`); `chatContextSince(d.env, new Date(anchor))`; state via `buildTriageState({ userText: t.text, recentTurns: recent, turnChars, modality: "text", lastHougeTurn: lastHougeTurnOf(recent, Date.parse(anchor)) })` (no broker in the CLI: the sanitiser's shape pass still runs); `state_hash: stateHash(built.state)` on every row; `permute` builds the lane question with `criteria: [...TRIAGE_LANE.criteria].reverse()` and a distinct `key` suffix `:perm`.

State parity note: the replay runs without a broker, so a historical turn that contained one of the nine broker secrets hashes differently from its live row (the shape pass is identical). Accepted: such turns are rare and the report lists the count of live rows whose `state_hash` found no replay match.

The report produces the "ROWS TO ADD" block **only** when all of: the run is complete over the full universe (no `stopped`, zero `jev_failed`), every required label set is non-empty (all `observed_lesson_write` rows, all `memory`/`status` verdicts labelled), the permuted run exists and its agreement with the canonical run is reported, and the live shadow check passes (`triage` rows in the DB: ≥ 14 days of `shadow`, ≥ 5 matched planner `lesson_write` calls, zero `memory_pure` on other-tool or no-tool turns) — the CLI passes those shadow numbers in from the store.

- [ ] **Step 5: Implement `triage-report.ts`** per the interface; test `tests/jev/triage-report.test.ts` — Rev 1's cases plus: the threshold-sweep lines exist for 0.5…0.9; the no-tool costly cell is counted separately; `INCOMPLETE` when `labels` has no entry for any `observed_lesson_write` row; the "ROWS TO ADD" block appears only when all bars hold (construct a passing fixture for `zh` with n ≥ 5 status labels and ≥ 36 proxy rows is unnecessary — assert the block is absent on the small fixture and present on a synthetic 40-row all-correct fixture).

- [ ] **Step 6: Run, typecheck, commit**

```bash
git add src/jev/wilson.ts src/jev/replay-core.ts src/jev/triage-replay.ts src/jev/triage-report.ts tests/jev/wilson.test.ts tests/jev/replay-core.test.ts tests/jev/triage-replay.test.ts tests/jev/triage-report.test.ts
git commit -m "feat(jev): generic replay core, lane 1 replay with live-identical state, option permutation, Wilson-bounded §5.9 report"
```

---

#### Rev 1 text retained for the code blocks referenced above (reference only; the Rev 2 steps above are the ones to execute)


**Files:**
- Create: `src/jev/wilson.ts`, `src/jev/replay-core.ts`, `src/jev/triage-replay.ts`, `src/jev/triage-report.ts`
- Test: `tests/jev/wilson.test.ts`, `tests/jev/triage-replay.test.ts`, `tests/jev/triage-report.test.ts`

**Interfaces:**
- Consumes: `listReplayTurns`, `getChatTurnsBefore`, `runLoopCapabilities`, `runSource` (store); `buildTriageState`, `TRIAGE_QUESTIONS`; `triageVerdict`; `criteriaHash`; `langOf`.
- Produces:
  ```ts
  // wilson.ts
  export function wilsonLower(successes: number, n: number, z?: number): number | null;   // 95% default z=1.96; null when n=0
  // replay-core.ts
  export interface ReplayCoreDeps<Row> { source: () => Array<{ key: string }>; prepare: (row: { key: string }) => Promise<Row | { skip: string }>; outPath: string; log?: (l: string) => void; maxUsd: number; estimateUsd: (row: Row) => number; dispatch: (row: Row) => Promise<Row>; dryRun: boolean; }
  export interface ReplayCoreOutcome<Row> { rows: Row[]; spentUsd: number; estimatedUsd: number; stopped?: "budget" | "auth" | "fused"; }
  export async function runReplayCore<Row extends { key: string; status: string; est_usd: number; stop?: "auth" | "fused" }>(d: ReplayCoreDeps<Row>): Promise<ReplayCoreOutcome<Row>>;
  export function readDone(outPath: string, doneStatuses: ReadonlySet<string>): Map<string, Record<string, unknown>>;  // append-only, torn-line tolerant
  // triage-replay.ts
  export interface TriageReplayRow { key: string; turn_id: string; run_id: string; lang: Lang; status: "ok" | "dry_run" | "skipped_state_too_large" | "jev_failed"; est_usd: number;
    observed_lesson_write: boolean; observed_other_tools: boolean; jev_lane?: string; p_memory?: number; p_status?: number; p_none?: number; conf_lane?: number; p_pure?: number; scope?: string;
    verdict?: "status" | "memory_pure" | "memory_mixed" | "fallthrough"; model?: string; criteria_hash_lane?: string; label?: TriageLabel; error?: string; stop?: "auth" | "fused"; }
  export interface TriageLabel { memory: boolean; status: boolean; pure: boolean | null; scope: "ask" | "research" | null; by: "paco"; at: string }
  export const TRIAGE_REPLAY_OUT = ".houge/jev-triage/replay.jsonl";
  export const TRIAGE_LABELS_PATH = ".houge/jev-triage/labels.jsonl";
  export const TRIAGE_LABEL_SINCE = "2026-07-02T00:00:00.000Z";
  export async function runTriageReplay(d: { store: RunStore; env: NodeJS.ProcessEnv; jev: (req: JevRequest) => Promise<JevResult>; outPath: string; maxUsd: number; dryRun: boolean; limit?: number; log?: (l: string) => void }): Promise<ReplayCoreOutcome<TriageReplayRow>>;
  export function loadLabels(path: string): Map<string, TriageLabel>;  // keyed by turn_id
  // triage-report.ts
  export function formatTriageReport(rows: TriageReplayRow[], labels: Map<string, TriageLabel>, outcome: { spentUsd: number; estimatedUsd: number; stopped?: string }, bars: TriageBars): string;
  ```

- [x] ~~Step 1: Write the failing Wilson test**

Create `tests/jev/wilson.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { wilsonLower } from "../../src/jev/wilson.js";

// Spec §1.1/§5.9: bars are reported with the lower bound the sample can prove; 90% on n=60 proves ~80%.
describe("wilsonLower", () => {
  it("matches the textbook values", () => {
    expect(wilsonLower(54, 60)!).toBeCloseTo(0.797, 2);
    expect(wilsonLower(36, 36)!).toBeCloseTo(0.904, 2);
    expect(wilsonLower(29, 36)!).toBeCloseTo(0.654, 2);
    expect(wilsonLower(0, 0)).toBeNull();
    expect(wilsonLower(0, 10)!).toBe(0);
  });
});
```

- [x] ~~Step 2: Create `src/jev/wilson.ts`**

```ts
/** Wilson score interval, lower bound (Brown, Cai & DasGupta 2001). The number a thin sample can actually prove. */
export function wilsonLower(successes: number, n: number, z = 1.96): number | null {
  if (n <= 0) return null;
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (centre - spread) / denom);
}
```

Run: `npx vitest run tests/jev/wilson.test.ts` → PASS.

- [x] ~~Step 3: Write the failing replay tests**

Create `tests/jev/triage-replay.test.ts` (uses an in-memory store seeded with Telegram turns and `loop_step` rows; the fake Jev answers by message content):

```ts
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JEV_MODEL, type JevRequest, type JevResult } from "../../src/jev/jev-client.js";
import { loadLabels, runTriageReplay, TRIAGE_LABEL_SINCE } from "../../src/jev/triage-replay.js";
import { RunStore } from "../../src/run/run-store.js";
import { createQueuedTurnRun } from "../helpers/runs.js";

const choice = (choice: string, probabilities: Record<string, number>) => {
  const n = Object.keys(probabilities).length; const pMax = Math.max(...Object.values(probabilities));
  return { type: "choice" as const, choice, probabilities, confidence: (pMax - 1 / n) / (1 - 1 / n) };
};
const fakeJev = async (req: JevRequest): Promise<JevResult> => {
  const msg = String((req.state as { latest_message: string }).latest_message);
  const memory = /以后|记住/.test(msg);
  return { ok: true, model: JEV_MODEL, input_tokens: 500, latency_ms: 200, answers: {
    lane: choice(memory ? "memory" : "none", memory ? { none: 0.05, status: 0.05, memory: 0.9 } : { none: 0.95, status: 0.03, memory: 0.02 }),
    complete: choice("pure", { mixed: 0.1, pure: 0.9 }), scope: choice("ask", { ask: 0.9, research: 0.1 }) } };
};
function seed(store: RunStore) {
  const a = createQueuedTurnRun(store, "以后回复短一点"); store.recordChatTurn({ chat_id: "555", run_id: a, role: "user", text: "以后回复短一点", created_at: "2026-08-01T00:00:00.000Z" });
  store.appendRunLedgerEvent(a, "loop_step", "core", { step: 1, capability: "lesson_write", status: "ok" });
  const b = createQueuedTurnRun(store, "今天天气？"); store.recordChatTurn({ chat_id: "555", run_id: b, role: "user", text: "今天天气？", created_at: "2026-08-02T00:00:00.000Z" });
  store.appendRunLedgerEvent(b, "loop_step", "core", { step: 1, capability: "web_search", status: "ok" });
  const c = createQueuedTurnRun(store, "old"); store.recordChatTurn({ chat_id: "555", run_id: c, role: "user", text: "old", created_at: "2026-06-20T00:00:00.000Z" }); // before the label epoch
  return { a, b, c };
}

// Spec §5.9: universe = Telegram turns since 2026-07-02; comparator = observed lesson_write; rows are ids and numbers; resumable.
describe("runTriageReplay", () => {
  it("replays the labelled universe, records the observed action and Jev's numbers, never text", async () => {
    const store = RunStore.openInMemory(); seed(store);
    const out = join(mkdtempSync(join(tmpdir(), "tr-")), "replay.jsonl");
    const r = await runTriageReplay({ store, env: {}, jev: fakeJev, outPath: out, maxUsd: 1, dryRun: false });
    expect(r.rows.map((x) => x.status)).toEqual(["ok", "ok"]); // "old" is before TRIAGE_LABEL_SINCE
    const mem = r.rows.find((x) => x.observed_lesson_write)!;
    expect(mem).toMatchObject({ jev_lane: "memory", verdict: "memory_pure", lang: "zh" });
    expect(mem.p_memory).toBeCloseTo(0.9, 9);
    const file = readFileSync(out, "utf8");
    expect(file).not.toContain("以后回复短一点");
    expect(TRIAGE_LABEL_SINCE).toBe("2026-07-02T00:00:00.000Z");
    store.close();
  });
  it("resumes: a second run over the same file dispatches nothing new", async () => {
    const store = RunStore.openInMemory(); seed(store);
    const out = join(mkdtempSync(join(tmpdir(), "tr-")), "replay.jsonl");
    let calls = 0; const counting = async (q: JevRequest) => { calls++; return fakeJev(q); };
    await runTriageReplay({ store, env: {}, jev: counting, outPath: out, maxUsd: 1, dryRun: false });
    await runTriageReplay({ store, env: {}, jev: counting, outPath: out, maxUsd: 1, dryRun: false });
    expect(calls).toBe(2);
    store.close();
  });
  it("stops on auth and reports INCOMPLETE through `stopped`; a dry run spends nothing", async () => {
    const store = RunStore.openInMemory(); seed(store);
    const out = join(mkdtempSync(join(tmpdir(), "tr-")), "replay.jsonl");
    const dry = await runTriageReplay({ store, env: {}, jev: fakeJev, outPath: out, maxUsd: 1, dryRun: true });
    expect(dry.rows.every((x) => x.status === "dry_run")).toBe(true); expect(dry.spentUsd).toBe(0);
    const auth = async (): Promise<JevResult> => ({ ok: false, reason: "auth", detail: "HTTP 401", error_kind: "auth" });
    const r = await runTriageReplay({ store, env: {}, jev: auth, outPath: join(mkdtempSync(join(tmpdir(), "tr-")), "r.jsonl"), maxUsd: 1, dryRun: false });
    expect(r.stopped).toBe("auth");
    store.close();
  });
  it("loadLabels reads Paco's JSONL keyed by turn_id", () => {
    const p = join(mkdtempSync(join(tmpdir(), "tr-")), "labels.jsonl");
    writeFileSync(p, `${JSON.stringify({ turn_id: "t1", memory: true, status: false, pure: true, scope: "ask", by: "paco", at: "2026-10-05T00:00:00.000Z" })}\n`);
    expect(loadLabels(p).get("t1")).toMatchObject({ memory: true, pure: true });
  });
});
```

`appendRunLedgerEvent(run_id, "loop_step", "core", payload)` — check `loop_step`'s required payload fields in `run-ledger.ts` and supply them.

- [x] ~~Step 4: Create `src/jev/replay-core.ts`**

Lift the skeleton of `src/jev/replay.ts` (`runReplay` :82, `readDone` :63, `emit`) into a generic module:

```ts
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/** Generic Jev replay loop (ADR 0029 §3.6): source → prepare → dispatch → append-only JSONL; resumable; budget-capped. */
export interface ReplayCoreDeps<Row extends ReplayRowBase> {
  source: () => Array<{ key: string }>;
  prepare: (row: { key: string }) => Promise<Row | { skip: Row }>;
  dispatch: (row: Row) => Promise<Row>;
  estimateUsd: (row: Row) => number;
  outPath: string;
  maxUsd: number;
  dryRun: boolean;
  doneStatuses: ReadonlySet<string>;
  log?: (line: string) => void;
}
export interface ReplayRowBase { key: string; status: string; est_usd: number; stop?: "auth" | "fused" }
export interface ReplayCoreOutcome<Row> { rows: Row[]; spentUsd: number; estimatedUsd: number; stopped?: "budget" | "auth" | "fused" }

export function readDone(outPath: string, doneStatuses: ReadonlySet<string>): Map<string, Record<string, unknown>> {
  const done = new Map<string, Record<string, unknown>>();
  if (!existsSync(outPath)) return done;
  for (const line of readFileSync(outPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (typeof row.key === "string" && typeof row.status === "string" && doneStatuses.has(row.status)) done.set(row.key, row);
    } catch { /* a torn last line from an interrupted run is re-done, not fatal */ }
  }
  return done;
}

function emit(outPath: string, row: unknown): void {
  mkdirSync(dirname(outPath), { recursive: true });
  appendFileSync(outPath, `${JSON.stringify(row)}\n`);
}

export async function runReplayCore<Row extends ReplayRowBase>(d: ReplayCoreDeps<Row>): Promise<ReplayCoreOutcome<Row>> {
  const done = readDone(d.outPath, d.doneStatuses);
  const rows: Row[] = []; let spentUsd = 0; let estimatedUsd = 0; let stopped: ReplayCoreOutcome<Row>["stopped"];
  for (const src of d.source()) {
    if (done.has(src.key)) { rows.push(done.get(src.key) as unknown as Row); continue; }
    const prepared = await d.prepare(src);
    if ("skip" in prepared) { emit(d.outPath, prepared.skip); rows.push(prepared.skip); continue; }
    const est = d.estimateUsd(prepared);
    estimatedUsd += est;
    if (d.dryRun) { const row = { ...prepared, status: "dry_run", est_usd: est }; rows.push(row); continue; } // never written: a dry run leaves no "done" rows
    if (spentUsd + est > d.maxUsd) { stopped = "budget"; break; }
    const out = await d.dispatch({ ...prepared, est_usd: est });
    emit(d.outPath, out); rows.push(out);
    if (out.status === "ok") spentUsd += est;
    if (out.stop) { stopped = out.stop; break; }
    d.log?.(`${src.key} ${out.status}`);
  }
  return { rows, spentUsd, estimatedUsd, ...(stopped ? { stopped } : {}) };
}
```

- [x] ~~Step 5: Create `src/jev/triage-replay.ts`**

```ts
import { existsSync, readFileSync } from "node:fs";
import { chatContextSince, resolveChatContextTurnChars, resolveChatContextTurns } from "../core/chat-context.js"; // the module replay.ts imports these from — copy its import line
import type { RunStore } from "../run/run-store.js";
import { langOf, type Lang } from "./intent-question.js";
import type { JevRequest, JevResult } from "./jev-client.js";
import { criteriaHash, toJevQuestion } from "./questions/types.js";
import { buildTriageState, TRIAGE_LANE, TRIAGE_QUESTIONS } from "./questions/triage.js";
import { runReplayCore, type ReplayCoreOutcome } from "./replay-core.js";
import { marginOf } from "./decide.js";
import { resolveTriageBars, triageVerdict } from "./thresholds.js";

export const TRIAGE_REPLAY_OUT = ".houge/jev-triage/replay.jsonl";
export const TRIAGE_LABELS_PATH = ".houge/jev-triage/labels.jsonl";
/** loop_step.capability exists since 2026-07-02: the comparator label's epoch (spec §5.9 universe = 288 Telegram runs). */
export const TRIAGE_LABEL_SINCE = "2026-07-02T00:00:00.000Z";
const JEV_USD_PER_MTOK = 0.042;
const DONE: ReadonlySet<string> = new Set(["ok", "skipped_state_too_large"]);

export interface TriageLabel { memory: boolean; status: boolean; pure: boolean | null; scope: "ask" | "research" | null; by: "paco"; at: string }
export interface TriageReplayRow {
  key: string; turn_id: string; run_id: string; lang: Lang; status: "ok" | "dry_run" | "skipped_state_too_large" | "jev_failed"; est_usd: number;
  observed_lesson_write: boolean; observed_other_tools: boolean;
  jev_lane?: string; p_memory?: number; p_status?: number; p_none?: number; conf_lane?: number; margin_lane?: number; p_pure?: number; scope?: string;
  verdict?: "status" | "memory_pure" | "memory_mixed" | "fallthrough"; model?: string; criteria_hash_lane?: string; error?: string; stop?: "auth" | "fused";
}
type Prepared = TriageReplayRow & { state: Record<string, unknown> };

export function loadLabels(path: string): Map<string, TriageLabel> {
  const m = new Map<string, TriageLabel>();
  if (!existsSync(path)) return m;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as TriageLabel & { turn_id: string };
    m.set(r.turn_id, r);
  }
  return m;
}

export async function runTriageReplay(d: {
  store: RunStore; env: NodeJS.ProcessEnv; jev: (req: JevRequest) => Promise<JevResult>; outPath: string; maxUsd: number; dryRun: boolean; limit?: number; log?: (l: string) => void;
}): Promise<ReplayCoreOutcome<TriageReplayRow>> {
  const turns = d.store.listReplayTurns({ sinceIso: TRIAGE_LABEL_SINCE, ...(d.limit !== undefined ? { limit: d.limit } : {}) })
    .filter((t) => d.store.runSource(t.run_id) === "telegram");
  const byKey = new Map(turns.map((t) => [t.turn_id, t]));
  return runReplayCore<TriageReplayRow>({
    source: () => turns.map((t) => ({ key: t.turn_id })),
    doneStatuses: DONE, outPath: d.outPath, maxUsd: d.maxUsd, dryRun: d.dryRun, log: d.log,
    estimateUsd: (row) => ((JSON.stringify((row as Prepared).state).length / 3) * 1.8 * JEV_USD_PER_MTOK) / 1_000_000, // CJK undercount ×1.8 (2026-09-26 lesson)
    prepare: async ({ key }) => {
      const t = byKey.get(key)!;
      const caps = d.store.runLoopCapabilities(t.run_id);
      const base: TriageReplayRow = { key, turn_id: t.turn_id, run_id: t.run_id, lang: langOf(t.text), status: "ok", est_usd: 0,
        observed_lesson_write: caps.includes("lesson_write"), observed_other_tools: caps.some((c) => c !== "lesson_write") };
      const anchor = t.anchor ?? t.created_at;
      const recent = d.store.getChatTurnsBefore(t.chat_id, resolveChatContextTurns(d.env), chatContextSince(d.env, anchor), anchor, t.run_id);
      const built = buildTriageState({ userText: t.text, recentTurns: recent, turnChars: resolveChatContextTurnChars(d.env), modality: "text",
        lastHougeTurn: null, pending: { rating_ask: false }, lastTurnTools: [] }, (s) => s);
      if (!built.ok) return { skip: { ...base, status: "skipped_state_too_large" } };
      return { ...base, state: built.state } as Prepared;
    },
    dispatch: async (row) => {
      const { state, ...rest } = row as Prepared;
      const questions: JevRequest["questions"] = {};
      for (const q of TRIAGE_QUESTIONS) questions[q.id] = toJevQuestion(q);
      const r = await d.jev({ state, questions });
      if (!r.ok) return { ...rest, status: "jev_failed", error: r.reason, ...(r.reason === "auth" || r.reason === "fused" ? { stop: r.reason } : {}) };
      const lane = r.answers.lane!; const v = triageVerdict(r.answers, resolveTriageBars(d.env), rest.lang, r.model);
      return { ...rest, status: "ok", model: r.model, criteria_hash_lane: criteriaHash(TRIAGE_LANE, r.model), jev_lane: lane.choice,
        p_memory: lane.probabilities.memory ?? 0, p_status: lane.probabilities.status ?? 0, p_none: lane.probabilities.none ?? 0,
        conf_lane: lane.confidence, margin_lane: marginOf(lane), p_pure: r.answers.complete?.probabilities.pure ?? 0, scope: r.answers.scope?.choice,
        verdict: v.kind === "memory" ? (v.complete === "pure" ? "memory_pure" : "memory_mixed") : v.kind };
    }
  });
}
```

Copy the exact import of `resolveChatContextTurns` / `chatContextSince` / `resolveChatContextTurnChars` from `src/jev/replay.ts` (`prepare`, `:171`). `ReplayTurnRow` has `turn_id, chat_id, run_id, text, created_at, recorded_intent, anchor` (`run-store.ts:361`).

- [x] ~~Step 6: Create `src/jev/triage-report.ts` and its test**

Test `tests/jev/triage-report.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatTriageReport } from "../../src/jev/triage-report.js";
import type { TriageReplayRow } from "../../src/jev/triage-replay.js";
import { TRIAGE_BAR_DEFAULTS } from "../../src/jev/thresholds.js";

const row = (o: Partial<TriageReplayRow>): TriageReplayRow => ({ key: "k", turn_id: "t", run_id: "r", lang: "zh", status: "ok", est_usd: 0,
  observed_lesson_write: false, observed_other_tools: false, jev_lane: "none", p_memory: 0.02, p_status: 0.01, p_none: 0.97, conf_lane: 0.95, p_pure: 0.5, verdict: "fallthrough", ...o });

// Spec §5.9: per-class bars, both positive sets, the costly cell, Wilson bounds and n; INCOMPLETE on a stop; dry run headline.
describe("formatTriageReport", () => {
  it("reports recall on the action proxy and on human labels, precision, the costly cell, per language", () => {
    const rows = [
      row({ turn_id: "a", observed_lesson_write: true, jev_lane: "memory", p_memory: 0.9, conf_lane: 0.85, p_pure: 0.9, verdict: "memory_pure" }),
      row({ turn_id: "b", observed_lesson_write: true, jev_lane: "none", verdict: "fallthrough" }),
      row({ turn_id: "c", observed_other_tools: true, jev_lane: "memory", p_memory: 0.9, conf_lane: 0.85, p_pure: 0.9, verdict: "memory_pure" }), // the costly cell
      row({ turn_id: "d", lang: "en" })
    ];
    const labels = new Map([["a", { memory: true, status: false, pure: true, scope: "ask" as const, by: "paco" as const, at: "" }],
      ["c", { memory: false, status: false, pure: null, scope: null, by: "paco" as const, at: "" }]]);
    const text = formatTriageReport(rows, labels, { spentUsd: 0.01, estimatedUsd: 0.01 }, TRIAGE_BAR_DEFAULTS);
    expect(text).toMatch(/recall \(action proxy\).*1\/2.*50\.0%.*LB/);
    expect(text).toMatch(/recall \(human\).*1\/1/);
    expect(text).toMatch(/precision \(human\).*1\/2/);
    expect(text).toMatch(/COSTLY: pure on tool-using turns: 1/);
    expect(text).toMatch(/\bzh\b/); expect(text).toMatch(/\ben\b/);
    expect(text).toMatch(/STOP|NO-GO/);
  });
  it("prints INCOMPLETE on an early stop and a distinct dry-run headline", () => {
    expect(formatTriageReport([row({ status: "dry_run" })], new Map(), { spentUsd: 0, estimatedUsd: 0.02 }, TRIAGE_BAR_DEFAULTS)).toMatch(/^DRY RUN/m);
    expect(formatTriageReport([row({})], new Map(), { spentUsd: 0, estimatedUsd: 0, stopped: "auth" }, TRIAGE_BAR_DEFAULTS)).toMatch(/^INCOMPLETE/m);
  });
});
```

Implementation `src/jev/triage-report.ts`:

```ts
import type { TriageBars } from "./thresholds.js";
import type { TriageLabel, TriageReplayRow } from "./triage-replay.js";
import { wilsonLower } from "./wilson.js";

const pct = (a: number, n: number): string => (n === 0 ? "n/a" : `${((100 * a) / n).toFixed(1)}%`);
const lb = (a: number, n: number): string => { const w = wilsonLower(a, n); return w === null ? "LB n/a" : `LB ${(100 * w).toFixed(1)}%`; };
const line = (label: string, a: number, n: number): string => `  ${label}: ${a}/${n} = ${pct(a, n)} (${lb(a, n)})`;

/** Per-class evidence (spec §5.9). Agreement over all turns is never printed as a headline: ~250 `none` turns would hide the positive class. */
export function formatTriageReport(rows: TriageReplayRow[], labels: Map<string, TriageLabel>, outcome: { spentUsd: number; estimatedUsd: number; stopped?: string }, bars: TriageBars): string {
  if (rows.length > 0 && rows.every((r) => r.status === "dry_run")) return `DRY RUN — ${rows.length} turns, est. $${outcome.estimatedUsd.toFixed(3)}; nothing dispatched, no verdict.`;
  const out: string[] = [];
  if (outcome.stopped) out.push(`INCOMPLETE — stopped: ${outcome.stopped}; the numbers below cover a prefix and are NOT a verdict.`);
  const ok = rows.filter((r) => r.status === "ok");
  const costly = ok.filter((r) => r.verdict === "memory_pure" && r.observed_other_tools).length;
  const costlyHuman = ok.filter((r) => r.verdict === "memory_pure" && labels.get(r.turn_id)?.memory === false).length;
  for (const lang of ["zh", "en", "mixed"] as const) {
    const L = ok.filter((r) => r.lang === lang); if (L.length === 0) continue;
    const confident = (r: TriageReplayRow) => r.verdict === "memory_pure" || r.verdict === "memory_mixed";
    const proxyPos = L.filter((r) => r.observed_lesson_write);
    const humanPos = L.filter((r) => labels.get(r.turn_id)?.memory === true);
    const memVerdicts = L.filter(confident);
    const memCorrect = memVerdicts.filter((r) => labels.get(r.turn_id)?.memory === true);
    const statusVerdicts = L.filter((r) => r.verdict === "status");
    const statusCorrect = statusVerdicts.filter((r) => labels.get(r.turn_id)?.status === true);
    out.push(`${lang}: ${L.length} turns`);
    out.push(line("recall (action proxy)", proxyPos.filter(confident).length, proxyPos.length));
    out.push(line("recall (human)", humanPos.filter(confident).length, humanPos.length));
    out.push(line("precision (human)", memCorrect.length, memVerdicts.filter((r) => labels.has(r.turn_id)).length));
    out.push(line("coverage of human positives", humanPos.filter(confident).length, humanPos.length));
    out.push(line("status precision (human)", statusCorrect.length, statusVerdicts.filter((r) => labels.has(r.turn_id)).length));
  }
  out.push(`COSTLY: pure on tool-using turns: ${costly}; pure on human-labelled non-memory: ${costlyHuman}`);
  out.push(`bars: conf ≥ ${bars.minConf}, p(memory) ≥ ${bars.minMemory}, gap ≥ ${bars.minGap}, p(pure) ≥ ${bars.minPure}, p(status) ≥ ${bars.minStatus}`);
  out.push(`spent $${outcome.spentUsd.toFixed(3)} of est. $${outcome.estimatedUsd.toFixed(3)}`);
  const go = !outcome.stopped && costly === 0 && costlyHuman === 0;
  out.push(go ? "GO candidate — read the per-class lines and Wilson bounds against spec §5.9 before arming." : "STOP / NO-GO — a costly cell is non-zero or the run is incomplete.");
  return out.join("\n");
}
```

- [x] ~~Step 7: Run the replay suite + typecheck**

Run: `npx vitest run tests/jev/wilson.test.ts tests/jev/triage-replay.test.ts tests/jev/triage-report.test.ts tests/jev/replay.test.ts && npm run typecheck`
Expected: PASS (the old intent replay keeps working untouched).

- [x] ~~Step 8: Commit**

```bash
git add src/jev/wilson.ts src/jev/replay-core.ts src/jev/triage-replay.ts src/jev/triage-report.ts tests/jev/wilson.test.ts tests/jev/triage-replay.test.ts tests/jev/triage-report.test.ts
git commit -m "feat(jev): generic replay core, lane 1 replay with observed-action labels, Wilson-bounded per-class report"
```

---

---
### Task 12: CLI — `houge jev replay|label|report triage`

**Files:**
- Create: `src/jev/triage-label.ts`
- Modify: `src/cli.ts` (new `jev` branch next to `jev-shadow`, `:311`)
- Test: `tests/jev/triage-label.test.ts`

**Interfaces:** as Rev 1 (`selectForLabelling`, `parseLabelAnswer`, `labelInteractively`), plus the CLI grammar:
`houge jev replay triage [--dry-run] [--max-usd N] [--limit N] [--permute]`, `houge jev label triage [--sample=N]`, `houge jev report triage`. Only `--sample=N` (with `=`) is accepted; it and `--permute` are parsed and removed **before** the remaining tokens reach `parseReplayArgs` (which rejects unknown tokens, `replay.ts:203`).

- [ ] **Step 1: Tests** — Rev 1 unchanged, plus a tiny `parseJevCliFlags(argv)` unit test: `["--sample=40","--dry-run"]` → `{ sample: 40, permute: false, rest: ["--dry-run"] }`; `["--sample","40"]` → error.

- [ ] **Step 2: Implement** — Rev 1's `triage-label.ts` unchanged; in `cli.ts` the branch from Rev 1 with `const flags = parseJevCliFlags(rest.slice(2))` feeding `parseReplayArgs(flags.rest)`, `permute: flags.permute` into `runTriageReplay` (out path `TRIAGE_PERMUTED_OUT` when permuting). **Both `replay` and `report` call `formatTriageReport(rows, labels, outcome, bars, permutedRows, shadow)`** where `permutedRows = readDone(TRIAGE_PERMUTED_OUT, …)` and `shadow = store.triageShadowStats(sinceIso)` — a new store reader over the `triage` ledger rows: `{ days: number /* distinct UTC days with decision "shadow" */, matched_lesson_write: number /* shadow rows whose run has a loop_step lesson_write */, pure_on_tool_turns: number /* shadow rows with complete "pure" ∧ lane "memory" ∧ conf ≥ bar whose run used any tool other than lesson_write */, pure_on_no_tool_turns: number }` (test it on a seeded store in Task 11's report test). The report's "ROWS TO ADD" gate reads exactly these numbers. The replay client's audit role is `triage`.

- [ ] **Step 3: Run, typecheck, build, dry run**

Run: `npx vitest run tests/jev/triage-label.test.ts && npm run typecheck && npm run build && node dist/cli.js jev replay triage --dry-run --max-usd 0.5`
Expected: `DRY RUN — universe N, would dispatch N, done 0, skipped 0 …` with N ≈ 285 (the live `listReplayTurns` universe since 2026-07-02 — the senior review measured 285, not 288: `listReplayTurns` needs an assistant turn with a non-null intent; report the number you get and the delta to the spec's 288).

- [ ] **Step 4: Commit**

```bash
git add src/jev/triage-label.ts src/cli.ts tests/jev/triage-label.test.ts
git commit -m "feat(cli): houge jev replay|label|report triage"
```

---

#### Rev 1 text retained for the code blocks referenced above (reference only; the Rev 2 steps above are the ones to execute)


**Files:**
- Create: `src/jev/triage-label.ts`
- Modify: `src/cli.ts` (new `else if (command === "jev")` branch next to `jev-shadow`, `:311`)
- Test: `tests/jev/triage-label.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // triage-label.ts
  export function selectForLabelling(rows: TriageReplayRow[], existing: Map<string, TriageLabel>, sample: number, rng?: () => number): TriageReplayRow[];
  //   every row with jev_lane ∈ {memory, status} at any confidence + every observed_lesson_write row + `sample` random others, minus already-labelled; deduplicated
  export function parseLabelAnswer(line: string): { memory: boolean; status: boolean; pure: boolean | null; scope: "ask" | "research" | null } | null;
  //   grammar: "m" memory, "s" status, "n" neither; suffix "p" pure / "x" mixed; suffix "a" ask / "r" research. e.g. "mpa", "mxr", "n", "s"
  export async function labelInteractively(i: { rows: TriageReplayRow[]; store: RunStore; labelsPath: string; input: NodeJS.ReadableStream; output: NodeJS.WritableStream; now?: () => Date }): Promise<number>; // appends JSONL, returns count
  ```

- [x] ~~Step 1: Write the failing tests**

Create `tests/jev/triage-label.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseLabelAnswer, selectForLabelling } from "../../src/jev/triage-label.js";
import type { TriageReplayRow } from "../../src/jev/triage-replay.js";

const row = (turn_id: string, o: Partial<TriageReplayRow> = {}): TriageReplayRow => ({ key: turn_id, turn_id, run_id: `r${turn_id}`, lang: "zh", status: "ok", est_usd: 0,
  observed_lesson_write: false, observed_other_tools: false, jev_lane: "none", verdict: "fallthrough", ...o });

// Spec §5.9 step 2: every Jev memory/status verdict, all 36 action-proxy runs regardless of verdict, plus a random none sample; deduplicated.
describe("selectForLabelling", () => {
  it("takes every memory/status verdict and every lesson_write run once, plus the sample, skipping already-labelled", () => {
    const rows = [row("a", { jev_lane: "memory" }), row("b", { observed_lesson_write: true }), row("c", { jev_lane: "memory", observed_lesson_write: true }),
      row("d", { jev_lane: "status" }), ...Array.from({ length: 50 }, (_, i) => row(`n${i}`))];
    const picked = selectForLabelling(rows, new Map([["a", { memory: true, status: false, pure: true, scope: "ask", by: "paco", at: "" }]]), 5, () => 0.5);
    const ids = picked.map((r) => r.turn_id);
    expect(ids).toEqual(expect.arrayContaining(["b", "c", "d"])); expect(ids).not.toContain("a");
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((x) => x.startsWith("n"))).toHaveLength(5);
  });
});
describe("parseLabelAnswer", () => {
  it("reads the compact grammar and rejects noise", () => {
    expect(parseLabelAnswer("mpa")).toEqual({ memory: true, status: false, pure: true, scope: "ask" });
    expect(parseLabelAnswer("mxr")).toEqual({ memory: true, status: false, pure: false, scope: "research" });
    expect(parseLabelAnswer("n")).toEqual({ memory: false, status: false, pure: null, scope: null });
    expect(parseLabelAnswer("s")).toEqual({ memory: false, status: true, pure: null, scope: null });
    expect(parseLabelAnswer("maybe")).toBeNull();
  });
});
```

- [x] ~~Step 2: Create `src/jev/triage-label.ts`**

```ts
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import type { RunStore } from "../run/run-store.js";
import type { TriageLabel, TriageReplayRow } from "./triage-replay.js";

/** Paco's labelling sitting (spec §5.9 step 2): the human labels decide the costly cells, not the action proxy. */
export function selectForLabelling(rows: TriageReplayRow[], existing: Map<string, TriageLabel>, sample: number, rng: () => number = Math.random): TriageReplayRow[] {
  const fresh = rows.filter((r) => r.status === "ok" && !existing.has(r.turn_id));
  const must = fresh.filter((r) => r.jev_lane === "memory" || r.jev_lane === "status" || r.observed_lesson_write);
  const rest = fresh.filter((r) => !must.includes(r));
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [rest[i], rest[j]] = [rest[j]!, rest[i]!]; }
  return [...must, ...rest.slice(0, sample)];
}

const ANSWER = /^(m|s|n)(p|x)?(a|r)?$/;

export function parseLabelAnswer(line: string): { memory: boolean; status: boolean; pure: boolean | null; scope: "ask" | "research" | null } | null {
  const m = ANSWER.exec(line.trim().toLowerCase());
  if (!m) return null;
  const memory = m[1] === "m"; const status = m[1] === "s";
  return { memory, status, pure: memory && m[2] ? m[2] === "p" : null, scope: memory && m[3] ? (m[3] === "a" ? "ask" : "research") : null };
}

/** Terminal only: prints the stored turn text (local DB, never egress) and reads one answer per turn. Enter skips. */
export async function labelInteractively(i: { rows: TriageReplayRow[]; store: RunStore; labelsPath: string; input: NodeJS.ReadableStream; output: NodeJS.WritableStream; now?: () => Date }): Promise<number> {
  mkdirSync(dirname(i.labelsPath), { recursive: true });
  const rl = createInterface({ input: i.input, output: i.output });
  const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));
  let n = 0;
  try {
    i.output.write("Answer per turn: m = memory instruction, s = status question, n = neither; add p (pure) or x (mixed), a (ask) or r (research). Enter = skip.\n");
    for (const [idx, r] of i.rows.entries()) {
      const text = i.store.userTurnTextForRun(r.run_id) ?? "(text missing)";
      i.output.write(`\n[${idx + 1}/${i.rows.length}] jev=${r.jev_lane ?? "-"} lesson_write=${r.observed_lesson_write ? "yes" : "no"}\n${text}\n`);
      const a = parseLabelAnswer(await ask("> "));
      if (!a) continue;
      appendFileSync(i.labelsPath, `${JSON.stringify({ turn_id: r.turn_id, ...a, by: "paco", at: (i.now?.() ?? new Date()).toISOString() })}\n`);
      n++;
    }
  } finally { rl.close(); }
  return n;
}
```

- [x] ~~Step 3: Wire the CLI**

In `src/cli.ts`, add a branch before `jev-shadow` (same shape, `:333-376`):

```ts
} else if (command === "jev") {
  const sub = rest[0]; const point = rest[1];
  if (point !== "triage" || !["replay", "label", "report"].includes(sub ?? "")) { console.error("Usage: houge jev replay|label|report triage [--dry-run] [--max-usd N] [--limit N] [--sample N]"); process.exit(1); }
  if (readTombstone()) { console.error(formatTombstoneParkedMessage(resolveTombstonePath(process.env))); process.exit(1); }
  const { runTriageReplay, loadLabels, TRIAGE_REPLAY_OUT, TRIAGE_LABELS_PATH } = await import("./jev/triage-replay.js");
  const { formatTriageReport } = await import("./jev/triage-report.js");
  const { readDone } = await import("./jev/replay-core.js");
  const { resolveTriageBars } = await import("./jev/thresholds.js");
  const { parseReplayArgs } = await import("./jev/replay.js");
  const args = parseReplayArgs(rest.slice(2).filter((a) => !a.startsWith("--sample")));
  if (!args.ok) { console.error(args.error); process.exit(1); }
  const store = RunStore.open("houge.sqlite", storeOptions);
  try {
    if (sub === "replay") {
      const { createJevClient } = await import("./jev/jev-client.js");
      const jev = createJevClient({ apiKey: broker ? broker.typesafeKey() : process.env.TYPESAFE_API_KEY,
        audit: store.llmAuditSink({ correlation_id: "cli:jev-triage-replay", role: "triage" }), meteredBreached: () => store.meteredFuseLatched(), retries: 3, timeoutMs: 15_000 });
      const outcome = await runTriageReplay({ store, env: process.env, jev, outPath: TRIAGE_REPLAY_OUT, maxUsd: args.maxUsd, dryRun: args.dryRun,
        ...(args.limit !== undefined ? { limit: args.limit } : {}), log: (l) => console.error(l) });
      console.log(formatTriageReport(outcome.rows, loadLabels(TRIAGE_LABELS_PATH), outcome, resolveTriageBars(process.env)));
      process.exitCode = outcome.stopped ? 1 : 0;
    } else {
      const rows = [...readDone(TRIAGE_REPLAY_OUT, new Set(["ok", "skipped_state_too_large"])).values()] as unknown as import("./jev/triage-replay.js").TriageReplayRow[];
      if (sub === "report") { console.log(formatTriageReport(rows, loadLabels(TRIAGE_LABELS_PATH), { spentUsd: 0, estimatedUsd: 0 }, resolveTriageBars(process.env))); }
      else {
        const { labelInteractively, selectForLabelling } = await import("./jev/triage-label.js");
        const sampleArg = rest.find((a) => a.startsWith("--sample="))?.split("=")[1];
        const picked = selectForLabelling(rows, loadLabels(TRIAGE_LABELS_PATH), Number(sampleArg ?? 40) || 40);
        const n = await labelInteractively({ rows: picked, store, labelsPath: TRIAGE_LABELS_PATH, input: process.stdin, output: process.stdout });
        console.error(`labelled ${n} of ${picked.length}`);
      }
    }
  } finally { store.close(); }
}
```

Note: the replay's audit role is `triage` (Task 1) so the sweep exclusion and per-point rate apply; the `llm_leg_failing` filter `role NOT LIKE 'classify_replay%'` is irrelevant here because provider `jev` is excluded outright.

- [x] ~~Step 4: Run the tests, typecheck, build, and a dry run against the live DB**

Run: `npx vitest run tests/jev/triage-label.test.ts && npm run typecheck && npm run build && node dist/cli.js jev replay triage --dry-run --max-usd 0.5`
Expected: tests PASS; the dry run prints `DRY RUN — N turns, est. $…` with N ≈ 288 (Telegram runs since 2026-07-02) and spends nothing. Report N in the task report.

- [x] ~~Step 5: Commit**

```bash
git add src/jev/triage-label.ts src/cli.ts tests/jev/triage-label.test.ts
git commit -m "feat(cli): houge jev replay|label|report triage"
```

---

---
### Task 13: Live gate — `scripts/live-gate-jev-triage.mjs`

**Files:**
- Create: `scripts/live-gate-jev-triage.mjs`

Changes from Rev 1 (all review findings):
- **`envFilePath` is not exported** from `dist/config/load-env.js`; copy the helper from `scripts/live-gate-omp.mjs:648` into this script (or `const repo = dirname(resolve(process.env.HOUGE_ENV_FILE ?? ".env"))`).
- **Planner-attempt count** counts only `llm_attempt` rows with `role === "compose"` (the memory lane's distill/reconcile legs are `distill`/`consolidate` on Kimi and must not fail case 1).
- **Case 1b Undo goes through the real callback path**: build a `memlane_undo` `TypedTaskEvent` (as the adapter would) and `new Gateway(store, …, { dataDir: root }).intake(it)`; assert the lesson rows and the `lesson_change_undone` event.
- **Case 2b — forced second `lesson_write` through the real tool path, live-style probe:** a fresh run on the copied DB: `const tools = worker.buildOmpTools(claim)`; `await worker.triageTurn({...})` with the real Jev and real Kimi (expect `lane_reply`); then execute the planner's own tool entry — `tools.registry` → the `lesson_write` adapter — with `{ scope: "ask" }` on the same claim before the run completes (look at how `tests/core/core-worker-omp-tools.test.ts` invokes a loop tool through the registry and do the same); assert the already-saved digest and that the run's `llm_attempt` count did not grow (zero additional distill/reconcile legs).
- **The retained Rev 1 script below is superseded line by line by these bullets:** its `{ loadHougeEnv, envFilePath }` import, its `plannerAttempts` filter, its direct `store.undoLessonChange` call, its `finalText` helper and its key restore are all replaced; it installs the test calibration file before constructing the worker.
- **Calibration for the gate:** the gate writes a temp JSON of calibration rows for zh/en (hashes computed from `dist/jev/questions/triage.js`) and sets `HOUGE_JEV_CALIBRATION_FILE` + `HOUGE_JEV_GATE=1`; without them `act` is impossible by design (Task 3 arming sequence). The armed re-run after Paco's commit uses no file.
- **Case 6** restores the key with `delete process.env.TYPESAFE_API_KEY` / re-assign only when it was set; the gate's worker has no broker, so this proves the env-key path only — say so in the header and in Task 14's docs (the broker path is covered by `jevClient` reading `broker.typesafeKey()` first, tested hermetically in Task 9 with a fake broker).
- Remove the unused `finalText` helper.
- Header lists what the gate cannot exercise: the slot-A steered ack (hermetic in Task 8) and the broker-supplied key path (hermetic in Task 9 with a fake broker: add that test there — `ompWorker(..., { broker: fakeBrokerWith("test-key") })` and assert the `fetchImpl` saw `Authorization: Bearer test-key`).

Everything else (cases 1–5, `VACUUM INTO` copy, disarm flags, tombstone case 4 with the triage row asserted before the planner answers, exit codes 0/1/2) as Rev 1.

- [ ] **Step 1: Write the gate** (Rev 1 script with the six changes above).
- [ ] **Step 2: Build and run** — `npm run build && node scripts/live-gate-jev-triage.mjs`; expected `LIVE GATE: PASS`; paste the full output including the `triage` rows into the task report; a FAIL is a finding to fix and re-run.
- [ ] **Step 3: Commit** — `git add scripts/live-gate-jev-triage.mjs && git commit -m "test(live): lane 1 triage live gate against a copy of the live DB"`.

---

#### Rev 1 text retained for the code blocks referenced above (reference only; the Rev 2 steps above are the ones to execute)


**Files:**
- Create: `scripts/live-gate-jev-triage.mjs`

**Interfaces:**
- Consumes: the built `dist/` (CoreWorker, Gateway, RunStore, flags), the live `.env` (`TYPESAFE_API_KEY` via the broker or env), a `VACUUM INTO` copy of `houge.sqlite` (pattern: `scripts/live-gate-omp.mjs --smoke`, `copyDb`, `smokeEnv`).
- Produces: exit 0 PASS / 1 FAIL / 2 setup error. Every case asserts the **ledger row**, not only the reply (spec §5.9 step 5).

- [x] ~~Step 1: Write the gate**

```js
#!/usr/bin/env node
// Live gate — Jev System One lane 1 (spec §5.9 step 5). Runs the real Jev against a COPY of the live DB with the real
// omp toolchain available (planner turns may spawn a child on Kimi/Opus: budget for a few subscription turns).
// Cases: pure memory → card + no planner request; mixed → saved + planner prefix + second lesson_write refused;
// status → code text; posture parked → skipped{posture}; key removed → skipped{no_key} + incident; 429 stub → incident.
import { mkdtempSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const DIST = resolve(new URL("../dist", import.meta.url).pathname);
const failures = [];
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); if (!ok) failures.push(name); };

async function main() {
  const [{ loadHougeEnv, envFilePath }, { DISARM_FLAGS }, { CoreWorker }, { buildTypedTaskEvent }, { Gateway }, { RunStore }] = await Promise.all([
    import("../dist/config/load-env.js"), import("../dist/config/disarm-posture.js"), import("../dist/core/core-worker.js"),
    import("../dist/domain/types.js"), import("../dist/gateway/gateway.js"), import("../dist/run/run-store.js")
  ]);
  loadHougeEnv();
  const repo = dirname(resolve(envFilePath()));
  const root = mkdtempSync("/tmp/hg-jev-"); // short: bridge sockets must fit sun_path
  for (const k of ["HOUGE_TELEGRAM_BOT_TOKEN", "HOUGE_TELEGRAM_CHAT_ID", "HOUGE_TELEGRAM_USER_ID"]) delete process.env[k];
  for (const f of DISARM_FLAGS) process.env[f] = "false";
  Object.assign(process.env, { HOUGE_EPISODIC_ENABLED: "false", HOUGE_TOMBSTONE_PATH: join(root, "houge.kill"), HOUGE_PARK_MARKER_PATH: join(root, "houge.parked"),
    HOUGE_DISARM_PATH: join(root, "houge.disarm"), HOUGE_JEV_ENABLED: "1", HOUGE_JEV_TRIAGE_ENABLED: "arm", HOUGE_JEV_DISARM_PATH: join(root, "houge.jev-disarmed") });
  const live = resolve(process.argv.includes("--db") ? process.argv[process.argv.indexOf("--db") + 1] : join(repo, "houge.sqlite"));
  const src = new DatabaseSync(live, { readOnly: true }); try { src.exec(`VACUUM INTO '${join(root, "houge.sqlite")}'`); } finally { src.close(); }
  const store = RunStore.open(join(root, "houge.sqlite"));
  const makeWorker = (jevFetch) => new CoreWorker(store, repo, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { dataDir: root, distDir: DIST, ...(jevFetch ? { jevFetch } : {}) });
  const chat = `-1000${Date.now() % 100000}`;
  const intake = (text) => new Gateway(store).intake(buildTypedTaskEvent({ source: "telegram", type: "turn", program: "turn", goal: text,
    requested_by: { kind: "user", id: "gate" }, notify: { kind: "telegram", chat_id: chat }, idempotency_key: `gate:${randomUUID()}`, source_reference: "gate" }));
  const settle = async (run_id, ms = 180_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const s = store.getRunState(run_id); if (s === "completed" || s === "failed") return s; await new Promise((r) => setTimeout(r, 500)); } return "timeout"; };
  const triageRow = (run_id) => store.getLedgerEvents().find((e) => e.event_type === "triage" && e.correlation_id === run_id)?.payload;
  const plannerAttempts = (run_id) => store.getLedgerEvents().filter((e) => e.event_type === "llm_attempt" && e.correlation_id === run_id && e.payload.provider !== "jev").length;
  const finalText = (run_id) => store.getLedgerEvents().filter((e) => e.event_type === "notification_queued" && e.payload.run_id === run_id).at(-1)?.payload?.text ?? "";

  let worker = makeWorker();
  try {
    // 1. pure memory instruction
    let r = intake("从现在起，回复请控制在三句话以内。"); worker.submitTurn(r.run_id); check("1 pure: run completed", (await settle(r.run_id)) === "completed");
    let row = triageRow(r.run_id); check("1 pure: triage row answered/memory/pure/act", row?.status === "answered" && row.lane === "memory" && row.complete === "pure" && row.decision === "act", JSON.stringify(row));
    check("1 pure: no planner request", plannerAttempts(r.run_id) === 0, `planner attempts=${plannerAttempts(r.run_id)}`);
    const change = store.getLessonChangeByRun(r.run_id); check("1 pure: lesson_changes row", !!change, change?.change_id);
    // 1b. undo through the store path the callback uses
    if (change) { const u = store.undoLessonChange(change.change_id); check("1b undo restores", u.status === "undone" && store.getLesson(change.new_id)?.status === "pruned"); }
    // 2. mixed
    r = intake("以后别用敬语。另外，今天悉尼天气怎么样？"); worker.submitTurn(r.run_id); check("2 mixed: completed", (await settle(r.run_id)) === "completed");
    row = triageRow(r.run_id); check("2 mixed: triage complete=mixed act", row?.complete === "mixed" && row.decision === "act", JSON.stringify(row));
    check("2 mixed: planner ran", plannerAttempts(r.run_id) > 0);
    check("2 mixed: exactly one lesson_saved", store.getLedgerEvents().filter((e) => e.event_type === "lesson_saved" && e.correlation_id === r.run_id).length === 1);
    // 3. status
    r = intake("你刚才重启过吗？现在跑的是哪个版本？"); worker.submitTurn(r.run_id); check("3 status: completed", (await settle(r.run_id)) === "completed");
    row = triageRow(r.run_id); check("3 status: lane=status act, no planner", row?.lane === "status" && row.decision === "act" && plannerAttempts(r.run_id) === 0, JSON.stringify(row));
    // 4. posture: tombstone → skipped{posture}
    const { writeFileSync, rmSync } = await import("node:fs"); writeFileSync(process.env.HOUGE_TOMBSTONE_PATH, "gate");
    r = intake("以后回复短一点"); worker.submitTurn(r.run_id); await settle(r.run_id, 30_000);
    check("4 posture: skipped{posture}", triageRow(r.run_id)?.skip_reason === "posture", JSON.stringify(triageRow(r.run_id))); rmSync(process.env.HOUGE_TOMBSTONE_PATH);
    // 5. 429 stub → skipped{rate_limited} + incident
    await worker.shutdownPlanners(); worker = makeWorker(async () => new Response("{}", { status: 429, headers: { "content-type": "application/json" } }));
    r = intake("以后回复短一点"); worker.submitTurn(r.run_id); check("5 429: completed via planner", (await settle(r.run_id)) === "completed");
    check("5 429: skipped{rate_limited}", triageRow(r.run_id)?.skip_reason === "rate_limited", JSON.stringify(triageRow(r.run_id)));
    check("5 429: incident jev_rate_limited", store.listOpenIncidents().some((i) => i.kind === "jev_rate_limited"));
    // 6. no key → skipped{no_key} + incident (the broker is absent in this gate; env key removed)
    await worker.shutdownPlanners(); const key = process.env.TYPESAFE_API_KEY; delete process.env.TYPESAFE_API_KEY; worker = makeWorker();
    r = intake("以后回复短一点"); worker.submitTurn(r.run_id); await settle(r.run_id);
    check("6 no key: skipped{no_key} + incident", triageRow(r.run_id)?.skip_reason === "no_key" && store.listOpenIncidents().some((i) => i.kind === "jev_no_key"), JSON.stringify(triageRow(r.run_id)));
    process.env.TYPESAFE_API_KEY = key;
  } finally { await worker.shutdownPlanners(); store.close(); }
  console.log(failures.length === 0 ? "\nLIVE GATE: PASS" : `\nLIVE GATE: FAIL\n  - ${failures.join("\n  - ")}`);
  return failures.length === 0 ? 0 : 1;
}
main().then((c) => process.exit(c), (e) => { console.error(`live gate setup error: ${e instanceof Error ? e.stack ?? e.message : String(e)}`); process.exit(2); });
```

The slot-A case (bare ack steered into an `AWAITING_APPROVAL` turn) is covered hermetically in Task 8; a live approval wait needs a planner that asks for an external write, which this gate does not force. State that in the gate's header and in the task report.

- [x] ~~Step 2: Build and run**

Run: `npm run build && node scripts/live-gate-jev-triage.mjs`
Expected: `LIVE GATE: PASS`, exit 0. Paste the full output into the task report, including the `triage` rows. A FAIL is a finding: fix the code (or the gate's semantics if the gate is wrong — say which) and re-run. Three runs on the A1 gate found one real defect each; expect the same.

- [x] ~~Step 3: Commit**

```bash
git add scripts/live-gate-jev-triage.mjs
git commit -m "test(live): lane 1 triage live gate against a copy of the live DB"
```

---

---
### Task 14: Docs sync and ship

As Rev 1, plus these deviations and notes the reviews surfaced, written where they belong:
- `docs/decisions/0029-jev-system-one.md` (and the ADR 0019 amendment text): the daemon builds the Jev client **per call** (cheap; the broker key is read each time) and `jev_no_key` opens on the **first armed turn**, not at boot — both acceptable, both stated.
- `docs/reference/configuration.md`: `HOUGE_JEV_ENABLED`, `HOUGE_JEV_TRIAGE_ENABLED=off|shadow|arm`, `HOUGE_JEV_TRIAGE_MIN_CONF|_PURE|_STATUS`, `HOUGE_JEV_DISARM_PATH`; calibration rows live in `src/jev/calibration.ts` and are added by Paco's commit after the replay report prints them; the `HOUGE_JEV_SHADOW_ENABLED` row marked dormant/superseded; the CLI grammar from Task 12 (`--sample=N` only).
- `docs/reference/jev-decision-layer.md`: the diagram, the lane table, how to read a `triage` row, and the two user-visible gaps: during the lane's 15–25 s the chat shows nothing and new messages are **queued**; a `mixed` verdict whose save found nothing durable runs the planner with no note (it may spend a second distill/reconcile pair).
- `tasks/todo.md` state block: what Paco owes — the labelling sitting (`houge jev label triage --sample=40`), the arm decision per language after the report's "ROWS TO ADD" block, and the AGENTS.md invariant sentence (his hand).
- `tasks/lessons.md`: at least "a terminal path needs one owner", "`ranOnce` covered three tools, not all", "size bars on the positive class", "a plan written from a dossier drifts: two reviews found 20 helper/signature mismatches before a line was written".

Steps 2–4 as Rev 1 (`npm run typecheck && npm test && npm run build`, none skipped; commits per concern; ship message with the kickstart command and whether a run is in flight).

---


#### Rev 1 text retained for the code blocks referenced above (reference only; the Rev 2 steps above are the ones to execute)


**Files:**
- Modify: `docs/reference/configuration.md` (one new section "Jev System One (ADR 0029)": `HOUGE_JEV_ENABLED`, `HOUGE_JEV_TRIAGE_ENABLED`, `HOUGE_JEV_TRIAGE_MIN_CONF|_PURE|_STATUS`, `HOUGE_JEV_DISARM_PATH`; ledger events `triage`, `ack_nudged`, `lesson_saved`, `lesson_change_undone`, `triage_override`; incidents `jev_*`, `triage_overrides`; tables `jev_decisions`, `lesson_changes`; CLI `houge jev …`; retire the `HOUGE_JEV_SHADOW_ENABLED` row with a "dormant, superseded by ADR 0029" note)
- Create: `docs/reference/jev-decision-layer.md` (the §1.2 diagram and lane table from the spec, verbatim, plus "how to read a `triage` row")
- Modify: `README.md` (one line under the runtime section linking the two docs), `docs/decisions/0029-jev-system-one.md` (status `proposed` → `accepted (lane 1 live <date>)` only after Paco's kickstart and the live gate on the running build), `docs/decisions/0013-llm-inner-composition.md`, `0014-dual-llm-privilege-separation.md`, `0019-metered-ceiling.md` (append the amendment paragraphs drafted at the end of ADR 0029; update their Status lines and the README index rows), `docs/ROADMAP.md` (lane 1 shipped delta), `tasks/todo.md` (state block: lane 1 live, flags, what Paco owes: the labelling sitting, the arm decision per language), `tasks/lessons.md` (what the five review rounds taught, in the existing themed style — at least: "a terminal path needs one owner", "ranOnce covered three tools, not all", "size bars on the positive class"), `sessions.md` (one arc entry)
- The AGENTS.md invariant line is **Paco's hand**: hand him the exact sentence from ADR 0029 ("AGENTS.md invariant") in the ship message; do not edit AGENTS.md.

- [x] ~~Step 1: Write the docs** (no code; follow `CONTRIBUTING.md` placement rules; every env var documented once, in `configuration.md`, linked from README).

- [x] ~~Step 2: Verify the whole thing**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck 0; all tests green with **none skipped** (report the file/test counts); build ok.

- [x] ~~Step 3: Commit per concern**

```bash
git add docs/reference/configuration.md docs/reference/jev-decision-layer.md README.md
git commit -m "docs(config): Jev System One flags, events, incidents, tables and CLI"
git add docs/decisions/0013-llm-inner-composition.md docs/decisions/0014-dual-llm-privilege-separation.md docs/decisions/0019-metered-ceiling.md docs/decisions/0029-jev-system-one.md docs/decisions/README.md
git commit -m "docs(adr): ADR 0029 amendments to 0013, 0014, 0019; index rows"
git add docs/ROADMAP.md tasks/todo.md tasks/lessons.md sessions.md
git commit -m "docs: lane 1 state block, roadmap delta, lessons and session entry"
```

- [x] ~~Step 4: Ship message to Paco** (plain language): what is live after kickstart (flags default **off**; `shadow` first), the kickstart command (`launchctl kickstart -k gui/$(id -u)/com.houge.daemon`), whether a run is in flight, the replay command and the labelling sitting he owes (`node dist/cli.js jev replay triage --max-usd 0.5`, then `jev label triage --sample=40`), the AGENTS.md sentence for his hand, and that `arm` waits for the §5.9 bar per language.

---

---
## Self-review (plan author)

1. **Spec coverage.** §3.1 → T2 (hash over the question; model a separate key); §3.2 → T5 + T9 (`triageEvent` once per eligible turn after the outcome); §3.3 → T1 (+ deviations named in T14); §3.4 → T5/T7/T9 (rows + event + save in ONE transaction via `inTx`; skip rows immediate); §3.5 → T3 (`calibration.ts`, empty at ship); §3.6 → T11/T12 (permutation included); §3.7 deferred by the spec; §3.8 → T6; §4.1–4.8 → no allow/deny path, no score on cards, sanitised egress (T2 `sanitizeJevText`), fail-toward-today on every skip; §5.1 → T8 + T9 (posture from the supervisor dep, abort signal, post-save failure named); §5.2 → T2 (two fields cut, reason stated); §5.3 → T2; §5.4 → T3; §5.5 → T7/T9 (voice anchor parity, guard after commit); §5.6 → T4/T9/T10 (Undo event inside the transaction, chat-bound ask, outcome label); §5.7 none by design; §5.8 → T4/T9/T10; §5.9 → T11/T12/T13; §5.10 → T14.
2. **Placeholders.** None; "as Rev 1" references point at code blocks that remain in this document's earlier tasks or are restated.
3. **Type consistency.** `TriageInput` now carries `posture` and `signal` (T8) and `triageTurn` reads both (T9); `LessonWriteOptions.inTx(saved, change_id)` (T7) is what T9's `finalize` rides; `persistDecisionRows` (T5) is called only inside `inTransaction` (T9); `criteriaHash(q)` has one argument everywhere (T2/T3/T5/T11); `calibratedLang(…, rows)` (T3) with `CALIBRATED_ROWS` default; `getLessonChangeByRun` added in T10 and used by T10/T13 only; `lastHougeTurnOf` (T2) used in T9 and T11.
4. **Open items for the executors to confirm against the code** (not design gaps): the gateway's turn-creation branch shape for the single-admission rewrite (T10); the fake session's start-failure path for the rejecting-spawn test (T8); `getRunNotifyTarget`'s return shape (T10); the `loop_step` payload fields (T11).

## Review record

- **Codex plan pass on Rev 1 (2026-10-04): NOT READY** — 11 BLOCKERs, 7 RISKs, 2 NITs. **Senior live-probe review on Rev 1 (2026-10-04): NOT READY** — 3 BLOCKERs, 11 WARNINGs, 8 SUGGESTIONs (baseline typecheck 0; supervisor suite 90/90 in 24 s; 285-turn replay universe measured). Every finding verified against the code; all folded into Rev 2: calibration not pre-seeded (`calibration.ts` empty), hash without model, rows + event + save in one transaction (`inTx`), warm spawn never rejects + `laneEnded` guard + stop-and-join on timeout, posture from the supervisor dep, abort-aware save and state-identity check, voice anchor parity, guard set after commit, post-save failure → inform + `ompFail` note, closed-reason incident, egress sanitiser seam (new `egress-redact.ts`), `pending`/`last_turn_tools` cut so `state_hash` joins, `lastHougeTurnOf` shared, chat-bound `ask` with one admission and the outcome label, Undo event inside the transaction, replay imports/`Date`/seed/latest-row-wins/dry-run accounting/permutation/§5.9 report, `--sample=N`, live gate `envFilePath`/`compose`-only count/callback Undo/key restore, test-helper shapes (`heldSession`, `Script.start`, `done` casts, `vi.stubEnv`), `findFailingLlmLegs` arity, `loop_step` payload. Not taken: none rejected; two spec deviations recorded in T14 (client per call; `jev_no_key` on first armed turn).

---
- **Codex scoped re-pass on Rev 2 (2026-10-04): NOT READY** — 9 CLOSED, 11 PARTIAL, 7 exact fix sentences. Rev 3 applies them: `LessonWriteOutcome.committed` set only after `inTransaction` returns and no in-memory mutation inside `inTx`; one outer finaliser in `triageTurn` writing fallback rows + event for every non-acting exit (incl. hook rollback), `laneLost` checks before every write after an await; `finishLane` records the user turn and stops/joins the warm start before `laneEnded`, then completes in a `finally`; override creation in one `inTransaction` around `handleTaskIntake`, unknown run → refusal, duplicate → same run; sanitiser gains heredoc/long-literal/OTP/id shapes with long CJK + English negatives; `calibration.ts` gains `calibrationRows(env)` with a gate-only file and `resolveJevTriageMode` caps `arm` at shadow when the file is set outside a gate; the arming sequence is written in Task 3 and bound to Tasks 11–13; the live gate gains the forced second `lesson_write` probe and the broker-key hermetic test moves to Task 9. Rev 3 goes back to Codex for a confirmation pass on exactly these edits.
- **Codex confirmation pass on Rev 3 (2026-10-04): NOT READY** — 2 closed (committed save; replay completeness), 9 open with 8 exact sentences. Rev 4 applies all eight: `settleTriage` is the one finaliser (per-turn `triageFinalized` flag, lost-turn no-write, outer try/catch, per-stage failure tests); `decide()` no longer persists the skipped row (the caller does, after the cancellation check); Task 8's injected failures each assert exactly one FAILED `start_failed` outcome (incl. `settleStart`); Task 10 labels only a genuinely new run (resumed duplicates excluded) and catches the unknown-run lookup; the quoted-literal rule is opaque-only with a prose negative and the nine-digit id false positive documented; `readFileSync` imported, `status` armable on the `lane` row alone, the CLI passes permuted rows and a new `triageShadowStats` reader into the report; Task 13 states which retained lines it supersedes and forces the second call through the registry's `lesson_write` entry; Task 9 gains the fake-broker Authorization test via an `ompWorker` `broker` option. **Plan review gate closed by the author after four rounds (Codex ×3 + senior ×1); the remaining assurance is per-task TDD with two-stage review and the live gate.**
- **Codex confirmation on Rev 4 (2026-10-04): 5 CLOSED, 3 OPEN with exact sentences** — applied verbatim in Rev 5: `settleTriage` owns the act writes (called from inside `inTx` with `{ inTx: true }`, flag flipped after commit); the answered rows are retained once Jev succeeded so distill / reconcile / rolled-back `inTx` throws settle as answered `fallback` and only a client throw settles as skipped `error`; the Task 3 armed check is lane-specific; the broker test uses its local response factory. **Gate closed:** every reviewer finding across five rounds is either applied verbatim or recorded as an accepted deviation (Task 14). Remaining assurance: per-task red → green with two-stage review, then the live gate.
