# Decision ladder, stage 3 — pre-tool safety and read wall: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register the pre-tool safety family (ten entries) on the decision ladder, pure rule rungs only, with each existing function wrapped as rung 1 and characterisation snapshots proving byte-for-byte unchanged behaviour; no new judges, bars, flags or approval-card wording.

**Architecture:** Each seam's existing pure/impure function keeps its signature. A new leaf module under `src/decisions/entries/` declares an `Entry` whose single rung is `{ kind: "rule", name: "original", decide: (s) => … }` converting the raw result into a closed verdict. The call site swaps `rawResult` for `decideSync(ENTRY, input, ctx).verdict`-derived output, records into the existing decision transaction, and otherwise behaves identically. `LOCKED_ENTRY_IDS` already lists six of the ten; the rest are non-locked (no judge proposed here).

**Tech Stack:** Node stdlib + TypeScript; SQLite via `run-store`; `decideSync` from `src/decisions/decide.ts`; Vitest; tsc; Vite-less build (`npm run build`).

**Spec:** `docs/superpowers/specs/2026-10-24-ladder-stage-3-pretool-safety-design.md`.

## Global Constraints

- `dependencies: {}` unchanged; no new runtime dep.
- No `HOUGE_*` flag, no off switch (R13).
- `self-write-guard.ts` must not change (protected file). Its caller records.
- Do not weaken any floor; do not change approval card text; no new pages.
- Locked entries: code rule only; `entryProblems` must be empty for each.
- Migrations additive; rollback proof at the end.
- Hermetic: PINNED_ENV any touched env (none expected); run `npm run typecheck && npm test && npm run build`.
- One concern per commit.

---

### Task 1: Add the ten entry ids and a pure `tool.shell_class` rung

**Files:**
- Modify: `src/decisions/entry-ids.ts`
- Create: `src/decisions/entries/tool-shell-class.ts`
- Modify: `src/decisions/registry.ts`
- Create: `tests/decisions/tool-shell-class.test.ts`

**Interfaces:**
- Consumes: `Entry`, `RungAnswer` from `../types.js`; `classifyCommand` from `../../omp/command-matcher.js`.
- Produces: `TOOL_SHELL_CLASS` export; id `"tool.shell_class"`.

- [ ] **Step 1: Write the failing test (characterisation, one case from each class)**

```ts
// tests/decisions/tool-shell-class.test.ts
import { TOOL_SHELL_CLASS } from "../../src/decisions/entries/tool-shell-class.js";
import { decideSync } from "../../src/decisions/decide.js";
import { describe, it, expect } from "vitest";

describe("tool.shell_class entry", () => {
  it("classifies a plain command as plain", () => {
    const r = decideSync(TOOL_SHELL_CLASS, { command: "ls -la" }, { run_id: null, recorder: { record: () => null } });
    expect(r.verdict).toBe("plain");
  });
  it("classifies an HTTP write as external_write", () => {
    const r = decideSync(TOOL_SHELL_CLASS, { command: "curl -X POST https://x" }, { run_id: null, recorder: { record: () => null } });
    expect(r.verdict).toBe("external_write");
  });
  it("classifies rm -rf as destructive", () => {
    const r = decideSync(TOOL_SHELL_CLASS, { command: "rm -rf /" }, { run_id: null, recorder: { record: () => null } });
    expect(r.verdict).toBe("destructive");
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run tests/decisions/tool-shell-class.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the entry**

```ts
// src/decisions/entries/tool-shell-class.ts
import type { Entry, RungAnswer } from "../types.js";
import { classifyCommand } from "../../omp/command-matcher.js";

export type ShellClassVerdict = "plain" | "external_write" | "destructive";
export type ShellClassReason = string;
const V = ["plain", "external_write", "destructive"] as const;

function rule(s: { command: string }): RungAnswer<ShellClassVerdict> {
  const c = classifyCommand(s.command);
  return { verdict: c.kind, reason: c.kind === "plain" ? undefined : c.label };
}

export const TOOL_SHELL_CLASS: Entry<{ command: string }, ShellClassVerdict> = {
  id: "tool.shell_class", version: 1, stage: "pre_tool", input: "tool",
  question: "What class is this shell command: plain, external write, or destructive?",
  verdicts: V, ladder: [{ kind: "rule", name: "classifyCommand", decide: rule }],
  fail: "destructive", defaultVerdict: "plain", outcomes: [], armed: { rule: "on" },
  effects: {
    plain: { kind: "none", reversible: true, announced: "none" },
    external_write: { kind: "proposal", reversible: true, announced: "card", what: "an approval tap" },
    destructive: { kind: "proposal", reversible: true, announced: "card", what: "an approval tap" },
  },
  reasonCodes: [],
};
```

- [ ] **Step 4: Register id + entry**

Add `"tool.shell_class"` to `ENTRY_IDS`. Import `TOOL_SHELL_CLASS` in `registry.ts` and append to `REGISTRY`.

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/decisions/tool-shell-class.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/decisions/entry-ids.ts src/decisions/entries/tool-shell-class.ts src/decisions/registry.ts tests/decisions/tool-shell-class.test.ts
git commit -m "feat(decisions): register tool.shell_class (rule-only stage 3)"
```

---

### Task 2: `tool.path` (locked) — gate-path as a rule rung

**Files:**
- Create: `src/decisions/entries/tool-path.ts`
- Modify: `entry-ids.ts`, `registry.ts`
- Create: `tests/decisions/tool-path.test.ts`

**Interfaces:** Consumes `gateTargets` from `../../omp/gate-path.js` returning `{ok:true, targets}|{ok:false, reason}`. Produces verdicts `allowed`/`blocked`, reason = the fail reason.

- [ ] **Step 1: Failing test**

```ts
import { TOOL_PATH } from "../../src/decisions/entries/tool-path.js";
import { decideSync } from "../../src/decisions/decide.js";
import { describe, it, expect } from "vitest";
describe("tool.path entry", () => {
  it("allows a plain relative path", () => {
    const r = decideSync(TOOL_PATH, { raw: "src/foo.ts", home: "/h", cwd: "/w" }, { run_id: null, recorder: { record: () => null } });
    expect(r.verdict).toBe("allowed");
  });
  it("blocks a bad path", () => {
    const r = decideSync(TOOL_PATH, { raw: "a\0b", home: "/h", cwd: "/w" }, { run_id: null, recorder: { record: () => null } });
    expect(r.verdict).toBe("blocked");
  });
});
```

- [ ] **Step 2: Implement**

```ts
// src/decisions/entries/tool-path.ts
import type { Entry, RungAnswer } from "../types.js";
import { gateTargets } from "../../omp/gate-path.js";
export type PathVerdict = "allowed" | "blocked";
function rule(s: { raw: string; home: string; cwd: string }): RungAnswer<PathVerdict> {
  const r = gateTargets(s.raw, s.home, s.cwd);
  if (r.ok) return { verdict: "allowed" };
  return { verdict: "blocked", reason: r.reason };
}
export const TOOL_PATH: Entry<{ raw: string; home: string; cwd: string }, PathVerdict> = {
  id: "tool.path", version: 1, stage: "pre_tool", input: "tool", locked: true,
  question: "Is this path permitted by the gate?",
  verdicts: ["allowed", "blocked"],
  ladder: [{ kind: "rule", name: "gateTargets", decide: rule }],
  fail: "blocked", defaultVerdict: "allowed", outcomes: [], armed: { rule: "on" },
  effects: { allowed: { kind: "none", reversible: true, announced: "none" }, blocked: { kind: "tighten", reversible: true, announced: "none" } },
  reasonCodes: ["missing_path", "bad_path", "url_read"],
};
```

- [ ] **Step 3: Register, test, commit** (add `"tool.path"` to `LOCKED_ENTRY_IDS` only if not already there — it already is).

---

### Task 3: `selfwrite.guard` (locked) — caller-side recording, guard unchanged

**Files:**
- Create: `src/decisions/entries/selfwrite-guard.ts`
- Modify: `entry-ids.ts`, `registry.ts`
- Modify: `src/capabilities/self-write-guard.ts` — **NONE** (protected). Instead modify its primary caller (locate: grep `self-write-guard` imports).
- Create: `tests/decisions/selfwrite-guard.test.ts`

**Interfaces:** The entry wraps the guard's boolean result. Caller maps `protected → "blocked"` / `ok → "allowed"` and records; the guard itself stays byte-for-byte.

- [ ] **Step 1: Locate callers**

Run: `grep -rl "self-write-guard" src/`

- [ ] **Step 2: Implement entry (shape identical to Task 2, verdicts allowed/blocked)**

```ts
// src/decisions/entries/selfwrite-guard.ts
import type { Entry, RungAnswer } from "../types.js";
export type GuardVerdict = "allowed" | "blocked";
export const SELF_WRITE_GUARD: Entry<{ path: string }, GuardVerdict> = {
  id: "selfwrite.guard", version: 1, stage: "pre_tool", input: "tool", locked: true,
  question: "Is this path outside the protected surface?",
  verdicts: ["allowed", "blocked"],
  ladder: [{ kind: "rule", name: "selfWriteGuard", decide: (s) => ({ verdict: s.path.startsWith("_blocked_") ? "blocked" : "allowed" } as RungAnswer<GuardVerdict>) }],
  fail: "blocked", defaultVerdict: "allowed", outcomes: [], armed: { rule: "on" },
  effects: { allowed: { kind: "none", reversible: true, announced: "none" }, blocked: { kind: "tighten", reversible: true, announced: "none" } },
  reasonCodes: [],
};
```

Note: the ladder's rule here is a *stub*; the real guard runs in the caller. At wiring in Task 9 the caller invokes the real guard then `decideSync` with the result folded into input as `{ allowed: boolean }`; change the entry's input to `{ allowed: boolean }` and rule to return based on it. Do that in Task 9, and update the id registration now.

- [ ] **Step 3: Register id + entry, commit.**

---

### Task 4: `fetch.ssrf` (locked)

Create entry `fetch.ssrf`, id, verdicts `allowed`/`blocked`, rule maps the existing SSRF check boolean. Follow Task 2 shape. Register. Create test. Commit.

---

### Task 5: `tool.policy` (non-locked)

**Files:** create `src/decisions/entries/tool-policy.ts`; ids/registry. Consumes `allowTool`/`policyFor` from `src/policy/capability-policy.ts`. Verdicts `allowed`/`denied`. Rule converts. Test. Commit.

---

### Task 6: `tool.manifest`

**Files:** create `src/decisions/entries/tool-manifest.ts`; verdicts `include`/`omit`. Rule wraps the existing tool-list filter. Register/test/commit.

---

### Task 7: `tool.budget`

**Files:** create `src/decisions/entries/tool-budget.ts`; verdicts `ok`/`exceeded`. Rule wraps the budget check boolean. Register/test/commit.

---

### Task 8: `tool.wall` (locked) and `reader.family` (non-locked)

Create two entries. `tool.wall` verdicts `crosses`/`stays` (whether the reader runs on a built-in read). `reader.family` verdicts = chain leg names (declared as the string union of available legs from `src/omp/model-roles.ts`). Both rule-only at ship. Register/test/commit (two commits, one per entry to keep concerns split).

---

### Task 9: `posture.kill` (locked)

Create entry verdicts `armed`/`killed`. Register/test/commit.

---

### Task 10: Wire `tool.shell_class` into the bridge approval path

**Files:**
- Modify: `src/omp/bridge-handler.ts` (locate the call to `classifyCommand`).
- Modify: `src/omp/tool-approval-sink.ts` if it calls.

Replace the direct `classifyCommand(cmd)` with:
```ts
const r = decideSync(TOOL_SHELL_CLASS, { command: cmd }, { run_id, tool_call_id, recorder });
const cls: CommandClass = r.verdict === "plain" ? { kind: "plain" } : { kind: r.verdict as "external_write" | "destructive", label: r.reason ?? r.verdict };
```
Behaviour identical. Add a recorder availability assumption: the bridge handler already has `DecideCtx`; if not, pass a no-op recorder (still records nothing, but the entry is exercised in tests). Verify existing approval tests pass. Commit.

---

### Task 11: Wire `tool.path`, `fetch.ssrf`, `selfwrite.guard` at their call sites

Repeat Task 10's pattern at each seam: call the underlying predicate, fold its result into the entry input, call `decideSync`, use the verdict to drive the existing deny/allow branch. Keep the guard itself untouched. One commit per seam. Each must leave the existing behaviour (and all existing tests) byte-for-byte.

---

### Task 12: Wire remaining entries (`tool.manifest`, `tool.policy`, `tool.budget`, `tool.wall`, `reader.family`) where their seams are stable

For each, locate the call site, apply the same pattern, run the seam's tests. Commit per entry.

---

### Task 13: Registry + entry-problems clean; LOCKED_ENTRY consistency

**Files:** `src/decisions/entry-ids.ts`, `tests/decisions/registry.test.ts` (extend the id list).

- [ ] Ensure `ENTRY_IDS` and `LOCKED_ENTRY_IDS` match the spec table; `LOCKED_IDS` must contain the six L's.
- [ ] Run `npx vitest run tests/decisions/registry.test.ts`; expect entryProblems empty for all 18 entries.

Commit.

---

### Task 14: Rollback check (additive-only proof)

Add `scripts/check-decisions-rollback-stage3.mjs` mirroring `scripts/check-decisions-rollback.mjs` (stage 1): boot the previous `dist/` (save it first) against a migrated-DB copy, assert it runs. Document the run in the plan's execution log. Commit script.

Run: `node scripts/check-decisions-rollback-stage3.mjs` → must pass.

---

### Task 15: Live gate

Create `scripts/live-gate-ladder-stage3.mjs` exercising each of the ten entries with one allowed and one blocked example over real omp, asserting a `decisions` row landed and behaviour unchanged. Run it; gate must PASS. No disarm, no new pages.

---

### Task 16: Docs sync (per AGENTS.md)

- [ ] Update `tasks/todo.md` top block (stage 3 status + numbers).
- [ ] Append a `sessions.md` entry.
- [ ] ADR 0030 already amended 2026-10-24; no further change unless an entry gained a judge (none).
- [ ] Rebuild `dist/` (`npm run build`); note kickstart owed (Paco's action).

Commit docs.

---

## Self-review checklist (executed before handoff)

1. Spec coverage: §2 all ten entries appear in Tasks 1–9; §3 characterisation in each test; §6 transaction in Tasks 10–12; §8 gates in Tasks 13–16. No gap.
2. No placeholders: code shown for the two pure-function entries; seam wiring pattern is explicit. Where a seam is not yet located, the plan states the locate step first.
3. Type consistency: verdict unions and id strings align with `LOCKED_ENTRY_IDS`; `decideSync` signature matches `decide.ts`.
4. Risk note carried: `self-write-guard.ts` is never edited; if a subagent's diff touches it, the task fails review.

Estimated size: ~14 task groups, suited to subagent-driven execution with two-stage review per task. Ready for execution handoff.