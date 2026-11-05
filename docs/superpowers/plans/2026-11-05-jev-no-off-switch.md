# Jev: no off switch, no shadow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The front door is armed whenever `HOUGE_JEV_ENABLED` is on (unless a safety cap holds it off, with the cause shown
in `/status`); `HOUGE_JEV_LANES_OFF`, `HOUGE_JEV_TRIAGE_ENABLED`, the front door's shadow mode and the runner's shadow/off
modes are gone.

**Architecture:** One resolver in `src/jev/jev-flags.ts` returns `{ mode, cause }`; the front door, both status renderers
and the boot warning read it. The runner loses `ctx.armed` and its shadow/off walk branches; `ArmedMode` narrows to `"on"`.
History stays readable (no migration).

**Tech Stack:** Node 26 + TypeScript, vitest, SQLite (`node:sqlite`), zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-11-05-jev-no-off-switch-no-shadow-design.md` (Rev 1.1, approved by Paco 2026-11-05).
Read it before your task; section numbers below (§N) refer to it.

## Global Constraints

- `dependencies: {}` stays empty. Node stdlib plus devDeps only.
- Functions under 50 lines. Match surrounding style. Every changed line traces to the spec.
- No migration; CHECK constraints keep `'shadow'`; `RecordedArmedMode` and `JevDecisionOutcome` keep `"shadow"` for rows older
  builds wrote; no writer emits `"shadow"`.
- Never write the live DB `/Users/xiaochuan/Projects/adventure/houge.sqlite`; never send real Telegram from a gate.
- Status lines name env vars, never values. No message text or ids in rows or prints.
- `src/decisions/jev-version-check.ts` and `src/decisions/` are protected surface: edited here under the approved spec.
- Tests live in `tests/<area>/` mirroring `src/`; each test says why the behaviour matters; red before green.
- The retired names `HOUGE_JEV_LANES_OFF` and `HOUGE_JEV_TRIAGE_ENABLED` appear under `src/` only in `src/jev/jev-flags.ts`
  after Task 2 (comments included).
- Commits: Conventional Commits, one concern each, stage files by name, end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Commands: `npm run typecheck`, `npx vitest run <paths>`, `npm test` (full), `npm run build`.

## File map

| File | Change | Task |
|---|---|---|
| `src/jev/jev-flags.ts` | resolver, cause, status line, retired-flag warning; old resolvers deleted in Task 2 | 1, 2 |
| `src/core/core-worker.ts` | front door reads the resolver; shadow and lane-off paths go | 2 |
| `src/core/turn-handler-ladder.ts` | `PlanInput` loses `mode` and `lanesOff` | 2 |
| `src/decisions/entries/turn-handler.ts` | ack rule whenever not off | 2 |
| `src/decisions/jev-version-check.ts` | `treeArmed` loses `lanesOff` | 2 |
| `src/jev/decide.ts`, `src/jev/tree-policy.ts`, `src/gateway/memlane-commands.ts`, `src/jev/calibration.ts` | types / comments | 2 |
| `src/telegram/telegram-daemon.ts` | boot warning swap | 2 |
| `src/decisions/{decide,types,registry}.ts` | runner shadow/off modes go | 3 |
| `src/status/houge-status.ts`, `src/gateway/gateway.ts`, `src/core/core-worker.ts` (`hougeStatusText`) | front-door line | 4 |
| `tests/adr/{0034-no-off-switch.test.ts,conformance.ts}` | R13 test | 5 |
| `scripts/*` (gates listed in Task 5), `scripts/live-gate-jev-no-off-switch.mjs` (new) | gates | 5 |
| `docs/decisions/0033-*`, `0034-*`, `README.md` index cells unchanged, docs listed in Task 6 | ADR amendments, docs sync | 6 |

---

### Task 1: The front-door resolver, status line and retired-flag warning

Model: cheap tier (the code is below). Additive only: nothing else changes yet, so the tree compiles.

**Files:**
- Modify: `src/jev/jev-flags.ts`
- Test: `tests/jev/jev-flags.test.ts` (add a new `describe`; leave existing tests for Task 2)

**Interfaces:**
- Produces: `type JevTriageMode = "off" | "arm"` (Task 2 narrows the existing type; in Task 1 add the new names beside the
  old ones), `type FrontDoorCause`, `interface FrontDoor { mode: "off" | "arm"; cause: FrontDoorCause }`,
  `resolveJevFrontDoor(env, dataDir): FrontDoor`, `frontDoorLine(env, dataDir): string`,
  `RETIRED_JEV_FLAGS: readonly ["HOUGE_JEV_LANES_OFF", "HOUGE_JEV_TRIAGE_ENABLED"]`,
  `warnRetiredJevFlags(env, log?): string[]` (returns the names it warned about).

- [ ] **Step 1: Write the failing tests** (append to `tests/jev/jev-flags.test.ts`; adjust imports)

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frontDoorLine, RETIRED_JEV_FLAGS, resolveJevFrontDoor, warnRetiredJevFlags } from "../../src/jev/jev-flags.js";

describe("front door (spec 2026-11-05 §4): armed whenever Jev is on, unless a cap holds it off; the cause is named", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "houge-frontdoor-"));
  const posture = (d: string) => { const p = join(d, "houge.disarm"); writeFileSync(p, "{}"); return p; };
  const marker = (d: string) => writeFileSync(join(d, "houge.jev-disarmed"), JSON.stringify({ reason: "old", at: "" }));

  it("Jev on, nothing else: armed — a stale triage off/shadow or lane list no longer switches it (1-A)", () => {
    const d = dir();
    for (const extra of [{}, { HOUGE_JEV_TRIAGE_ENABLED: "off" }, { HOUGE_JEV_TRIAGE_ENABLED: "shadow" }, { HOUGE_JEV_LANES_OFF: "answer" }]) {
      expect(resolveJevFrontDoor({ HOUGE_JEV_ENABLED: "1", ...extra }, d)).toEqual({ mode: "arm", cause: "armed" });
    }
  });
  it("flag off: env_off; flag off with the /disarm posture file: disarmed", () => {
    const d = dir();
    expect(resolveJevFrontDoor({}, d)).toEqual({ mode: "off", cause: "env_off" });
    expect(resolveJevFrontDoor({ HOUGE_JEV_ENABLED: "false", HOUGE_DISARM_PATH: posture(d) }, d)).toEqual({ mode: "off", cause: "disarmed" });
  });
  it("a posture file with the flag on (a gate's child env) does not disarm: the flag decides", () => {
    const d = dir();
    expect(resolveJevFrontDoor({ HOUGE_JEV_ENABLED: "1", HOUGE_DISARM_PATH: posture(d) }, d).mode).toBe("arm");
  });
  it("a calibration file outside a gate caps at off (was shadow); inside a gate it does not", () => {
    const d = dir();
    expect(resolveJevFrontDoor({ HOUGE_JEV_ENABLED: "1", HOUGE_JEV_CALIBRATION_FILE: "/x.json" }, d)).toEqual({ mode: "off", cause: "calibration_file" });
    expect(resolveJevFrontDoor({ HOUGE_JEV_ENABLED: "1", HOUGE_JEV_CALIBRATION_FILE: "/x.json", HOUGE_JEV_GATE: "1" }, d).mode).toBe("arm");
  });
  it("a leftover disarm marker caps at off (was shadow); the calibration file outranks it", () => {
    const d = dir(); marker(d);
    expect(resolveJevFrontDoor({ HOUGE_JEV_ENABLED: "1" }, d)).toEqual({ mode: "off", cause: "disarm_marker" });
    expect(resolveJevFrontDoor({ HOUGE_JEV_ENABLED: "1", HOUGE_JEV_CALIBRATION_FILE: "/x.json" }, d).cause).toBe("calibration_file");
  });
  it("the status line names the cause and env var names, never a value", () => {
    const d = dir();
    expect(frontDoorLine({ HOUGE_JEV_ENABLED: "1" }, d)).toBe("Jev front door: armed");
    expect(frontDoorLine({}, d)).toBe("Jev front door: off (HOUGE_JEV_ENABLED is off in this process: .env, or /rearm awaiting a restart)");
    expect(frontDoorLine({ HOUGE_JEV_ENABLED: "0", HOUGE_DISARM_PATH: posture(d) }, d)).toBe("Jev front door: off (/disarm; /rearm restores it)");
    expect(frontDoorLine({ HOUGE_JEV_ENABLED: "1", HOUGE_JEV_CALIBRATION_FILE: "/secret/path.json" }, d))
      .toBe("Jev front door: off (HOUGE_JEV_CALIBRATION_FILE is set outside a gate)");
    marker(d);
    expect(frontDoorLine({ HOUGE_JEV_ENABLED: "1" }, d)).toBe("Jev front door: off (houge.jev-disarmed marker from an older build; remove it by hand)");
  });
});

describe("retired Jev flags (spec §5): read for no behaviour; a value that would have changed behaviour is named once at boot", () => {
  it("names both retired vars", () => {
    expect([...RETIRED_JEV_FLAGS]).toEqual(["HOUGE_JEV_LANES_OFF", "HOUGE_JEV_TRIAGE_ENABLED"]);
  });
  it("warns per var set to a behaviour-changing value, without printing the value", () => {
    const lines: string[] = [];
    const warned = warnRetiredJevFlags({ HOUGE_JEV_LANES_OFF: "answer", HOUGE_JEV_TRIAGE_ENABLED: "shadow" }, (l) => lines.push(l));
    expect(warned).toEqual(["HOUGE_JEV_LANES_OFF", "HOUGE_JEV_TRIAGE_ENABLED"]);
    expect(lines).toEqual([
      "jev: HOUGE_JEV_LANES_OFF is retired (ADR 0034 1.6) and ignored; remove it from .env",
      "jev: HOUGE_JEV_TRIAGE_ENABLED is retired (ADR 0034 1.6) and ignored; remove it from .env"
    ]);
    expect(lines.join("\n")).not.toMatch(/answer|shadow/);
  });
  it("stays silent for HOUGE_JEV_TRIAGE_ENABLED=arm (kept in .env so an older dist/ still arms after a rollback) and for unset/blank lane lists", () => {
    const lines: string[] = [];
    expect(warnRetiredJevFlags({ HOUGE_JEV_TRIAGE_ENABLED: " ARM ", HOUGE_JEV_LANES_OFF: " " }, (l) => lines.push(l))).toEqual([]);
    expect(warnRetiredJevFlags({}, (l) => lines.push(l))).toEqual([]);
    expect(lines).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run tests/jev/jev-flags.test.ts` → import errors (`resolveJevFrontDoor` not exported).

- [ ] **Step 3: Implement** in `src/jev/jev-flags.ts` (add; keep the old exports until Task 2):

```ts
import { disarmPosturePresent } from "../config/disarm-posture.js";

export type FrontDoorCause = "armed" | "disarmed" | "env_off" | "calibration_file" | "disarm_marker";
export interface FrontDoor { mode: "off" | "arm"; cause: FrontDoorCause }

/**
 * The front door's arming (ADR 0034 1.6; spec 2026-11-05 §4). First match wins. `disarmed` needs the flag off AND the
 * posture file: in the daemon /disarm sets both, but a gate's child env can carry the file with the flag on, and then the
 * flag decides. Both caps fail toward the planner (off), as they failed toward shadow before.
 */
export function resolveJevFrontDoor(env: NodeJS.ProcessEnv, dataDir: string): FrontDoor {
  if (!resolveJevEnabled(env)) return { mode: "off", cause: disarmPosturePresent(env) ? "disarmed" : "env_off" };
  if (Boolean(env.HOUGE_JEV_CALIBRATION_FILE?.trim()) && env.HOUGE_JEV_GATE !== "1") return { mode: "off", cause: "calibration_file" };
  if (readJevDisarmMarker(jevDisarmMarkerPath(env, dataDir))) return { mode: "off", cause: "disarm_marker" };
  return { mode: "arm", cause: "armed" };
}

const FRONT_DOOR_TEXT: Readonly<Record<FrontDoorCause, string>> = {
  armed: "Jev front door: armed",
  disarmed: "Jev front door: off (/disarm; /rearm restores it)",
  env_off: "Jev front door: off (HOUGE_JEV_ENABLED is off in this process: .env, or /rearm awaiting a restart)",
  calibration_file: "Jev front door: off (HOUGE_JEV_CALIBRATION_FILE is set outside a gate)",
  disarm_marker: "Jev front door: off (houge.jev-disarmed marker from an older build; remove it by hand)"
};

/** The `/status` line (spec §7): names env vars, never values. */
export function frontDoorLine(env: NodeJS.ProcessEnv, dataDir: string): string {
  try {
    return FRONT_DOOR_TEXT[resolveJevFrontDoor(env, dataDir).cause];
  } catch (e) {
    console.error(`jev: front-door status check failed: ${e instanceof Error ? e.message : String(e)}`);
    return "Jev front door: unknown (check failed)";
  }
}

/** Retired by spec 2026-11-05 (ADR 0034 1.6): read for no behaviour; named here only for the boot warning. */
export const RETIRED_JEV_FLAGS = ["HOUGE_JEV_LANES_OFF", "HOUGE_JEV_TRIAGE_ENABLED"] as const;

/** Would this value have changed behaviour on the old build? `TRIAGE=arm` is the live, rollback-safe value: silent. */
function retiredValueMatters(name: (typeof RETIRED_JEV_FLAGS)[number], v: string | undefined): boolean {
  if (v === undefined) return false;
  return name === "HOUGE_JEV_TRIAGE_ENABLED" ? v.trim().toLowerCase() !== "arm" : v.trim().length > 0;
}

/** Boot only (spec §5): one error line per retired var whose value would have changed behaviour; fail loud, run on. */
export function warnRetiredJevFlags(env: NodeJS.ProcessEnv, log: (line: string) => void = console.error): string[] {
  const warned = RETIRED_JEV_FLAGS.filter((n) => retiredValueMatters(n, env[n]));
  for (const n of warned) log(`jev: ${n} is retired (ADR 0034 1.6) and ignored; remove it from .env`);
  return warned;
}
```

Check `HOUGE_DISARM_PATH` is the env override `disarmPosturePresent(env)` reads (`src/config/disarm-posture.ts:64`); if the
test's posture file needs other content to count as present, mirror what `disarmPosturePresent` checks (existence).

- [ ] **Step 4: Run, expect PASS** — `npx vitest run tests/jev/jev-flags.test.ts`; `npm run typecheck`.
- [ ] **Step 5: Commit** — `feat(jev): front-door resolver with a named cause; retired-flag boot warning`
  (stage `src/jev/jev-flags.ts tests/jev/jev-flags.test.ts`).

---

### Task 2: The front door reads the resolver; shadow and lane-off paths go

Model: standard tier (multi-file, judgment on test re-pointing).

**Files:**
- Modify: `src/jev/jev-flags.ts` (delete `resolveJevTriageMode`, `resolveJevLanesOff`, `warnUnknownJevLanesOff`,
  `LANE_SWITCHES`, `laneNames`; `JevTriageMode` becomes `"off" | "arm"` and `FrontDoor.mode` uses it; the file header
  comment drops "tri-state flag per lane")
- Modify: `src/core/core-worker.ts`:
  - import `resolveJevFrontDoor` (drop `resolveJevLanesOff`, `resolveJevTriageMode`);
  - `triageTurnInner` (≈3097): `const mode = resolveJevFrontDoor(process.env, this.ompDataDir()).mode;` and remove the
    `armed:` property from the `decideLadder` ctx; delete `TREE_SHADOWED` (≈308) and its comment;
  - `planAnswered` (≈3162): drop the `mode` parameter; `const arming = treeArmingFor(this.runStore, d, lang);` (the off
    path never reaches it: the gate rule exits first); call `planTree(d, { userText, lang, thinkHarder, rows, arming })`;
    drop `NOT_ARMED` from imports if now unused;
  - `treeRung`, `routeDecided`, `routeAnswered`: drop the `mode` parameter where its only remaining use was the removed
    branches (follow the compiler);
  - `decisionFor` (≈4540): `function decisionFor(r: Route, save: SaveOutcome, outcome?: "act" | "fallback"): "act" | "fallback"`,
    first line removed; `TriageSettle.answered.decision: "act" | "fallback"`;
  - the `triageOff` docstring keeps "Flag off" (still true: `HOUGE_JEV_ENABLED` off or a cap).
- Modify: `src/core/turn-handler-ladder.ts`: `PlanInput` loses `mode` and `lanesOff`; `armed = treeArmed(i.lang, i.rows, i.arming)`;
  remove `UNARMED` only if nothing else uses it (grep `src/` and `tests/`); the `PlanInput` docstring drops "shadow arms nothing".
- Modify: `src/decisions/jev-version-check.ts`: `treeArmed(lang, rows, arming)`; `routed` drops `&& !lanesOff.has(l)`;
  docstring drops the `lanesOff` sentence; drop the `LaneSwitch` import if unused.
- Modify: `src/decisions/entries/turn-handler.ts`: after the five exits, `return ackRule(s);` (comment: the mode is off or
  armed, and off exited first).
- Modify: `src/jev/decide.ts`: `persistDecisionRows(…, decision: "act" | "fallback", …)`.
- Modify comments naming the retired vars or the front door's shadow: `src/jev/tree-policy.ts:12` (the `LaneSwitch`
  type: keep the type if `jev-version-check.ts` or tests still use it, otherwise delete it with its comment),
  `src/gateway/memlane-commands.ts:58` ("or switches the lane off (…)" → "or disarms Jev"), `src/jev/calibration.ts:53-55`
  ("caps `arm` at shadow" → "holds the front door off"), `src/decisions/types.ts:128` (the `ctx.armed` docstring goes in
  Task 3; leave it), `src/config/disarm-posture.ts:55` comment ("switches every Jev lane off" → "switches Jev's front door
  off; Jev's other entries do not read this flag").
- Modify: `src/telegram/telegram-daemon.ts:37,455`: `warnRetiredJevFlags(process.env);`.
- Tests (re-point, don't delete, where the guarded behaviour survives):
  - `tests/jev/jev-flags.test.ts`: delete the `resolveJevTriageMode`, `resolveJevLanesOff`, `warnUnknownJevLanesOff`
    cases; keep `resolveJevEnabled`, marker-path and marker-read cases.
  - `tests/helpers/triage-harness.ts:99`: delete `SHADOW`; each user (`turn-handler-pin`, `turn-handler-ladder`,
    `core-worker-triage`) moves its shadow case to `ARM` or to Jev off by what it asserts. A case that asserted "shadow
    records but never applies" becomes "a disarm marker → planner, reason `disabled`, no `jev_decisions` row, the skipped
    verdict and the `turn.handler` row written" (spec §4 / S2). Delete the `tests/core/__pins__/turn-handler/shadow.json`
    pin and its case; add a `disarm-marker` pin case if the pin suite covers caps.
  - `tests/core/core-worker-lanes.test.ts:135` (`HOUGE_JEV_LANES_OFF=answer`) → the answer lane unarmed by calibration rows
    that lack the `category:answer` pseudo-row; same assertion (planner on the gear's role, reason routed).
  - `tests/core/turn-handler-pin.test.ts:103` (`answer-lane-off`) → `answer-row-missing` the same way.
  - `tests/jev/tree-policy.test.ts:340` → the missing-pseudo-row case.
  - `tests/jev/triage-parity.test.ts:23`: drop `HOUGE_JEV_LANES_OFF` and `HOUGE_JEV_TRIAGE_ENABLED`; prove the planner path
    with calibration rows that carry no lane pseudo-rows (keep the comment's reason).
  - `tests/core/turn-handler-ladder-glue.test.ts:15`, `tests/core/turn-handler-ladder.test.ts`: `PlanInput` without `mode`
    and `lanesOff`; a former shadow case → a `NOT_ARMED` arming case (all lanes unarmed by the model check).
  - `tests/decisions/jev-version-arming.test.ts:144`: the source pin becomes `/treeArmed\(i\.lang, i\.rows, i\.arming\)/`.
  - `tests/decisions/turn-handler-entry.test.ts`: the ack rule runs for `mode: "arm"`; no shadow case.
  - `tests/helpers/setup-no-real-omp.ts:20`: keep deleting `HOUGE_JEV_TRIAGE_ENABLED` (harmless, guards an old `.env`) —
    no change. `tests/run/test-gate.test.ts` — no change (leak probe by name).
  - New: `tests/telegram/boot-retired-flags.test.ts` — reads `src/telegram/telegram-daemon.ts` and expects
    `/warnRetiredJevFlags\(process\.env\)/` inside `bootPlanners`, and no `warnUnknownJevLanesOff` (spec §8 boot wiring; why:
    a dropped call silently loses the only signal that a retired var is still in `.env`).

- [ ] **Step 1:** write/re-point the failing tests listed above (the boot-wiring test and the marker-cap front-door test
  first); run `npx vitest run tests/jev tests/core tests/decisions tests/telegram/boot-retired-flags.test.ts` → FAIL.
- [ ] **Step 2:** make the source changes above; `npm run typecheck` until clean (the compiler lists every `"shadow"` /
  `mode` / `lanesOff` consumer).
- [ ] **Step 3:** `grep -rn "HOUGE_JEV_LANES_OFF\|HOUGE_JEV_TRIAGE_ENABLED\|lanesOff\|TREE_SHADOWED" src` → only
  `src/jev/jev-flags.ts` lines for the two names; nothing else.
- [ ] **Step 4:** run the same vitest paths → PASS; then `npm test` (full) → green, none skipped. (`tests/adr/0034-no-off-switch.test.ts`
  will fail here on the mode list and allowlist; that is Task 5's. If so, note it in the report and do not edit it.)
- [ ] **Step 5: Commit** — `refactor(jev): the front door is armed whenever Jev is on; shadow and lane-off paths removed`.

---

### Task 3: The runner loses its shadow and off modes

Model: standard tier.

**Files:**
- Modify: `src/decisions/types.ts`: `export type ArmedMode = "on";` with docstring "Every rung runs armed (R13): the type
  admits nothing else."; delete `DecideCtx.armed` and its docstring; `RungOutcome` docstring: "One rung's turn in the walk."
  and `result: RungResult<V, D>` (no `| null`) if no reader needs null (follow the compiler; `walkReask` checks `o.result`);
  `Entry.armed` docstring: "Every registered entry is armed `on` (R13), by type."; `RecordedArmedMode` unchanged, with the
  docstring adding "`shadow` only on rows older builds wrote".
- Modify: `src/decisions/decide.ts`: delete the two `if (mode === "off") …` lines; `modeOf` → delete, and pass
  `"on"` where `mode` was used (or drop `mode` from `apply` and `RungOutcome` construction: `mode: "on"`); delete
  `Walk.shadowed`, its init, `apply`'s shadow line; `finish`: `armedMode: "on" as const`; `apply`'s docstring drops "not
  shadow".
- Modify: `src/decisions/registry.ts:79`: delete the "entry armed other than on" check (unreachable by type).
- Modify: `src/core/core-worker.ts` only if a `ctx.armed` remains (Task 2 removed the only one).
- Tests:
  - `tests/decisions/decide.test.ts:99-121,155-160`: delete the shadow/off walk cases; add one type-level test:
    ```ts
    it("R13 by type: no entry can be declared shadow or off, and no caller can pass an arming override", () => {
      // @ts-expect-error — ArmedMode is "on" only
      const bad: Entry<never, "a", never>["armed"] = { system_one: "shadow" };
      // @ts-expect-error — DecideCtx has no `armed`
      const ctx: DecideCtx<never, "a", never> = { run_id: null, recorder: { record: (_e, r) => r }, armed: {} };
      expect([bad, ctx]).toHaveLength(2);
    });
    ```
    (adjust the recorder stub to the real `DecisionRecorder` shape; `npm run typecheck` covers `tests/` — verify with
    `grep -n include tsconfig.json`; if tests are not type-checked, assert with `expectTypeOf` from vitest instead.)
  - `tests/decisions/record.test.ts:48,155`: a case that recorded because `armedMode` was `"shadow"` now uses `"late"`
    (the remaining non-`on` value), so `shouldRecord`'s `armedMode !== "on"` stays covered.
  - `tests/decisions/registry.test.ts:78`: delete the "armed other than on" case.
  - `tests/run/decisions-store.test.ts`, `tests/run/invariant-sweep-jev.test.ts`, `tests/decisions/digest*.test.ts`: no
    change (they write historical `shadow` values the store must still accept and readers must still skip).
- [ ] Red: the type-level test (fails while `ArmedMode` still has `"shadow"`: `@ts-expect-error` unused) → `npm run typecheck` FAIL.
- [ ] Green: source changes; `npm run typecheck`; `npx vitest run tests/decisions tests/run`; `npm test` full.
- [ ] Commit — `refactor(decisions): the runner has no shadow or off mode (R13 by type)`.

---

### Task 4: `/status` says why the front door is off

Model: cheap-to-standard tier.

**Interfaces:** Consumes `frontDoorLine(env, dataDir)` (Task 1).

**Files:**
- Modify: `src/status/houge-status.ts`: `HougeStatusInput` gains `frontDoor: string`; `collectHougeStatus`'s argument gains
  `dataDir: string` and fills `frontDoor: frontDoorLine(d.env, d.dataDir)`; `renderHougeStatus` adds `i.frontDoor` right after
  the `Runtime:` line.
- Modify: `src/core/core-worker.ts` `hougeStatusText`: pass `dataDir: this.ompDataDir()`.
- Modify: `src/gateway/gateway.ts` `formatStatusText`, HEALTH section: after the `Self-check:` line add
  `frontDoorLine(process.env, this.options.dataDir ?? this.projectRoot)` (the daemon passes
  `options.omp?.dataDir ?? options.projectRoot`, the same value as the worker's `ompDataDir()`).
- Tests:
  - `tests/status/houge-status.test.ts` (or the existing status test file; find it with `grep -rln renderHougeStatus tests`):
    the rendered block contains `Jev front door: armed` after `Runtime:` with Jev on, and the marker line with a marker in
    `dataDir`; existing fixtures gain `frontDoor`.
  - Gateway: in the existing `/status` overview test (find with `grep -rln "HEALTH" tests/gateway`), drive the real `/status`
    command through the gateway with `HOUGE_JEV_ENABLED` unset → the reply contains the `env_off` line; with a posture file
    and the flag `"false"` → the `disarmed` line. Why: Paco's `/status` is this renderer, not `renderHougeStatus` (codex B).
- [ ] Red → green → `npm test` full → commit `feat(status): /status names why Jev's front door is off`.

---

### Task 5: R13 conformance test, gates

Model: standard tier.

**Files:**
- Modify: `tests/adr/conformance.ts` `triageModes`: re-anchor from `export function resolveJevTriageMode` to the
  `JevTriageMode` union only (the resolver no longer compares raw strings); update its docstring.
- Modify: `tests/adr/0034-no-off-switch.test.ts`:
  - delete `R13_SUBJECT`, `R13_SUBJECTS`;
  - add `const RETIRED: Record<string, string> = Object.fromEntries(RETIRED_JEV_FLAGS.map((n) => [n, "retired by spec 2026-11-05 (ADR 0034 1.6); named only by the boot warning"]));`
    imported from `src/jev/jev-flags.js`, and put it in `KNOWN_SWITCHES`;
  - new test: "the retired names occur under src/ only in src/jev/jev-flags.ts, so a retired switch cannot come back by
    name": walk `src`, collect files containing either name, expect `["src/jev/jev-flags.ts"]`;
  - `KNOWN_MODES` = `{ off: "Jev is off (HOUGE_JEV_ENABLED off, /disarm, or a cap)", arm: "Jev decides at the front door" }`;
  - `STOP_REASON` unchanged; update the header comment (rule text) and the planted-mode fixture to the new anchor;
  - the docs-parity test (`tests/docs/`) stays green: `configuration.md` lists both retired names (Task 6 writes the doc,
    so run `tests/docs` after Task 6; if Task 5's run shows only that failure, note it).
- Modify gates (add `HOUGE_JEV_ENABLED: "0"` beside each `HOUGE_JEV_TRIAGE_ENABLED: "off"`; keep the triage key — an older
  `dist/` the rollback checks run still reads it): `scripts/check-chat-is-for-paco-rollback.mjs:141`,
  `check-ladder-2b-hooks-rollback.mjs:66`, `check-ladder-remainder-r{1..6}-rollback.mjs` (184, 208, 212, 219, 242, 260),
  `check-ladder-stage4b-rollback.mjs:308`, `check-ladder-stage4c-rollback.mjs:314`, `check-loud-degradation-rollback.mjs:203`,
  `check-standing-rollback.mjs:68`, `live-gate-ladder-2b-hooks.mjs:89`, `live-gate-ladder-stage4b.mjs:340`,
  `live-gate-ladder-stage4c.mjs:311`, `live-gate-standing-approval.mjs:76`. Read each line first: if `HOUGE_JEV_ENABLED`
  is already set there, set it to `"0"` rather than adding a duplicate key.
- Modify: `scripts/live-gate-decisions-parity.mjs:119`: drop `HOUGE_JEV_LANES_OFF` from the scrubbed keys only if the scrub
  is a list of keys the gate deletes from `.env` before loading (a retired var in `.env` is harmless either way — keep it
  scrubbed if unsure, and say which in the report).
- Create: `scripts/live-gate-jev-no-off-switch.mjs`, modelled on `scripts/live-gate-jev-tree.mjs` (copy its env setup,
  temp-root, DB-copy and CoreWorker harness; read it first). Before loading `.env` (via `HOUGE_ENV_FILE`), delete
  `HOUGE_TELEGRAM_BOT_TOKEN`, `HOUGE_TELEGRAM_CHAT_ID`, `HOUGE_TELEGRAM_USER_ID` and set `HOUGE_DISARM_PATH`,
  `HOUGE_JEV_DISARM_PATH`, `HOUGE_TOMBSTONE_PATH`, `HOUGE_PARK_MARKER_PATH` under the temp root. Checks (spec §9), each
  printing `PASS`/`FAIL <name>`; exit 1 on any FAIL:
  1. `resolveJevFrontDoor(realEnv, tmpData)` = `{ mode: "arm", cause: "armed" }`;
  2. child env + `HOUGE_JEV_TRIAGE_ENABLED=off` + `HOUGE_JEV_LANES_OFF=answer`: resolver still `arm`;
     `warnRetiredJevFlags` returns both names (exactly two lines); `treeArmed(lang, liveRows, trustedArming)` arms `answer`
     (with the live calibration rows from the DB copy and the trusted arming the live model has);
  3. a marker in the temp data dir: resolver `disarm_marker`; `renderHougeStatus(collectHougeStatus({ …, dataDir }))` and the
     gateway's `/status` reply both carry the marker line;
  4. `HOUGE_JEV_ENABLED=0` → `env_off`; plus a posture file → `disarmed`;
  5. one status-lane turn (a zh status question, e.g. the one `live-gate-jev-tree.mjs` uses for its status case) through the
     real Jev in arm on the temp DB: `handler_outcome = lane_reply`, `route_outcome = act`, zero `compose` attempts, one
     `turn.handler` decisions row with `rung IN ('system_one','model')` and `armed_mode = 'on'`, and one `jev_decisions` row
     with `decision = 'act'`; then zero rows with `armed_mode = 'shadow'` or `decision = 'shadow'` written by this run.
- [ ] Red: the new R13 cases fail before the test edits match the tree (run `npx vitest run tests/adr`); green after.
- [ ] `npm run build`; run every gate edited above that runs without old-dist arguments, plus the new gate:
  `HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node scripts/live-gate-jev-no-off-switch.mjs`. Rollback checks
  that need `--old-dist` are run by the orchestrator in the final gate pass; list them in the report.
- [ ] Commit — `test(adr): R13 test tracks retired Jev flags; gates keep Jev off by HOUGE_JEV_ENABLED` and, separately,
  `test(gate): live gate for the front door without an off switch`.

---

### Task 6: ADR amendments and docs sync

Model: standard tier (prose; the orchestrator reviews wording against the spec).

**Files:**
- `docs/decisions/0034-decision-ladder-consolidated.md`:
  - rule 1.6: replace "The runner's `shadow` mode exists only so the front door keeps its configured triage shadow mode.
    (Paco 2026-11-04: … this rule is amended when it ships.)" with: "The front door is armed whenever Jev runs; the only env
    var over its arming is the STOP flag `HOUGE_JEV_ENABLED` (ADR 0018), which arms and disarms the front door — Jev's other
    entries do not read it. `HOUGE_JEV_LANES_OFF` and `HOUGE_JEV_TRIAGE_ENABLED` are retired (2026-11-05); the runner has no
    shadow or off mode." Keep the A5 parenthetical as signed.
  - rule 3.1: replace "or was asked in shadow (the runner's `shadow` mode, rule 1.6)" with nothing, and add after the
    sentence: "(Rows written before 2026-11-05 may carry `armed_mode = 'shadow'`.)"
  - grep the file for `shadow` and `LANES_OFF` and `TRIAGE_ENABLED`; lines 399 and 452 describe history ("never shadow",
    "dropped by R13") — leave them.
  - History row: `| 2026-11-05 | No off switch, no shadow: front-door shadow, HOUGE_JEV_LANES_OFF and HOUGE_JEV_TRIAGE_ENABLED removed; HOUGE_JEV_ENABLED is the front door's STOP flag | [no off switch](../superpowers/specs/2026-11-05-jev-no-off-switch-no-shadow-design.md) | (awaiting Paco's signature) |`.
- `docs/decisions/0033-jev-system-one-consolidated.md`: F7 ends at "suggests rows only with the model the rows reported."
  (delete the live-shadow-stats clause and its parenthetical); I2 strike "and it is not in `HOUGE_JEV_LANES_OFF`" and its
  "to be removed" parenthetical; G6: "outside `HOUGE_JEV_GATE=1` a set file holds the front door off. A `houge.jev-disarmed`
  marker an older build left also holds it off until removed by hand; no code writes it any more. `/status` names either
  cause."; the lane list (line ≈194): "(5) context relevance, driving lesson credit (ships armed, ADR 0034 1.6)"; the
  open-questions line (≈215): strike "(lane 5 may move from shadow to selection; its shadow plan …)" up to its close;
  History row as above, plus "F7's live-shadow-stats clause named a reader no code had".
- `docs/reference/configuration.md`: `HOUGE_JEV_ENABLED` row: "the front door's flag and ADR 0018 STOP flag" (not "Master
  switch"); `HOUGE_JEV_TRIAGE_ENABLED` and `HOUGE_JEV_LANES_OFF` rows → "Retired 2026-11-05 (ADR 0034 1.6): read for no
  behaviour; a value other than `arm` (or a non-empty lane list) logs one line at boot. Keep `HOUGE_JEV_TRIAGE_ENABLED=arm`
  in `.env` while an older `dist/` is a rollback target: older builds read it."; the calibration-file row's "caps `arm` at
  `shadow`" → "holds the front door off"; lines ≈1128-1129 likewise.
- `docs/reference/jev-decision-layer.md`: lines ≈71-72, 168, 207 (`shadow (rows only)` → "`shadow` (rows written before
  2026-11-05)"), 325, 336, 348-352 (delete recovery step 0; step 1 → "`/disarm`, or `HOUGE_JEV_ENABLED=0` in `.env` and a
  kickstart"), 415-416.
- `README.md:346` and the `/status` description (add the front-door line); `CONTEXT.md:73` (**Rung**: drop "the only shadow
  is …"), `:207` (**Intent Shadow**: drop "Not the front door's configured triage `shadow` mode, which still exists.");
  `docs/ROADMAP.md:266` ("Jev lane 5 (context relevance → credit) ships armed, with memory stage C"); `docs/reference/decision-map.md`
  if it names the shadow mode.
- `tasks/todo.md` state block: the "Decided, not shipped" item → in progress on branch `jev-no-off-switch`; add to the
  drift list: "`/disarm` stops Jev at the front door only; the version, improve and golden ticks, `memory.kind` and
  `turn.settle` keep calling Jev (found by the no-off-switch spec review, 2026-11-05)" and "`HOUGE_EPISODIC_EVIDENCE` has a
  `shadow` mode, the default (memory A1 evidence check; not a ladder entry, so outside this spec — Paco to say whether R13
  covers it)".
- [ ] `npx vitest run tests/docs tests/adr` green; `npm test` full green; commit `docs(adr): ADR 0033/0034 amended for no off switch, no shadow (awaiting signature)`
  and `docs: configuration, Jev layer, README, CONTEXT, ROADMAP for the retired Jev flags`.

---

## Final gates (orchestrator)

Whole-branch review (most capable non-orchestrator model) + codex whole-diff; `npm run typecheck && npm test && npm run build`;
the new live gate; `live-gate-jev-tree`, `live-gate-memory-write`, `live-gate-decisions-parity`; each edited rollback
check with its `--old-dist` arguments where its header requires them; docs sync (`sessions.md`, `tasks/lessons.md`);
Paco signs the ADR amendments; merge, rebuild, kickstart, `/status` shows `Jev front door: armed`.
