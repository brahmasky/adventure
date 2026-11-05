# Jev: no off switch, no shadow — design

**Rev 1.0 · 2026-11-05 · Decisions 0 (Paco, 2026-11-04), 1-A and 2-A (Paco, 2026-11-05)**
**Amends:** ADR 0034 rule 1.6 (R13) and the rules that name the front door's shadow; ADR 0033 (the front door's shadow,
lane 5's shadow plan). No new ADR.
**Rests on:** a code map of `main` @ `2c549379` (2026-11-05) and the live `.env` read for key names and the one triage value
(`HOUGE_JEV_ENABLED` set, `HOUGE_JEV_TRIAGE_ENABLED=arm`, no `HOUGE_JEV_LANES_OFF`, no `HOUGE_JEV_CALIBRATION_FILE`); no
`houge.jev-disarmed` marker on disk.
**Reviews:** pending.

## 1. Why

ADR 0034 rule 1.6 (R13) says no env var switches a ladder entry off and nothing runs in shadow by design. Three things in the
code still do: `HOUGE_JEV_LANES_OFF` (switches the answer or lookup lane off while Jev runs), the front door's `shadow` mode
(`HOUGE_JEV_TRIAGE_ENABLED=shadow`: Jev is asked and recorded, nothing applied), and lane 5's plan to start in shadow
(docs only; lane 5 is not built). Paco, 2026-11-04: every lane ships armed and nothing is in shadow, so take them out, through
a spec. The signed consolidation marks them "to be removed" and keeps the `/disarm` STOP flags outside R13 (ruling A5).

## 2. Decisions

- **0 (Paco, 2026-11-04).** Remove `HOUGE_JEV_LANES_OFF`, the front door's `shadow` mode and lane 5's shadow plan. The two
  safety caps that drop an armed front door to shadow (a leftover disarm marker; a calibration file outside a gate) drop it
  to `off` instead.
- **1-A (Paco, 2026-11-05). Retire `HOUGE_JEV_TRIAGE_ENABLED`.** Without `shadow` it has `off` and `arm`, and
  `HOUGE_JEV_ENABLED` (the STOP flag) is read nowhere but the front door, so the two switch the same thing; under A5 a flag
  that leaves an entry unarmed while its capability runs is an off switch. The front door is armed whenever
  `HOUGE_JEV_ENABLED` is on, unless a safety cap holds it off. `/disarm` stays the one brake.
- **2-A (Paco, 2026-11-05). `/status` says why the front door is off.** One line, pull only (ADR 0031: not a push). It also
  closes the gap seen in the consolidation: `HOUGE_JEV_ENABLED=false` set in `.env` (not by `/disarm`) shows nowhere.

## 3. Scope

**In:** the front-door resolver and its cause; retiring both env vars (reads, boot warning, docs); the runner's shadow mode
(`ctx.armed`, the walk's shadow branch); the `lanesOff` parameter of `treeArmed`; the `/status` line; lane 5's shadow plan in
the ADRs and ROADMAP; the R13 conformance test; the tests and gates that set either retired var or ran the front door in
shadow; ADR 0033/0034 amendments; docs.

**Out (unchanged):**
- the `/disarm` STOP flags, `HOUGE_JEV_ENABLED` and `HOUGE_IMPROVE_ENABLED` (A5);
- the version check's per-question and per-lane disarm on a model move, re-armed by Paco's tap (ADR 0033 F3, ruling A2):
  a check result, not an env switch;
- `houge jev-shadow replay` (an offline replay of history, not an entry mode; the name stays);
- historical values: `decision_rows.armed_mode = 'shadow'`, `jev_decisions.decision = 'shadow'` and `intent_shadow` ledger rows
  stay readable. No migration; the CHECK constraints keep `'shadow'`; the reader types keep it; no writer emits it.

## 4. The front door's mode

`src/jev/jev-flags.ts` replaces `resolveJevTriageMode` with one resolver:

```ts
export type JevTriageMode = "off" | "arm";
export type FrontDoorCause = "armed" | "disarmed" | "env_off" | "calibration_file" | "disarm_marker";
export function resolveJevFrontDoor(env: NodeJS.ProcessEnv, dataDir: string): { mode: JevTriageMode; cause: FrontDoorCause };
```

In order, first match wins:

| Condition | mode | cause |
|---|---|---|
| `HOUGE_JEV_ENABLED` not on and the disarm posture file present | off | `disarmed` |
| `HOUGE_JEV_ENABLED` not on | off | `env_off` |
| `HOUGE_JEV_CALIBRATION_FILE` set and `HOUGE_JEV_GATE` ≠ `1` | off | `calibration_file` |
| a `houge.jev-disarmed` marker (readable or not) at `jevDisarmMarkerPath` | off | `disarm_marker` |
| otherwise | arm | `armed` |

"On" keeps today's set (`1`, `true`, `yes`, `on`, case and spaces folded). The posture test is `disarmPosturePresent(env)`
(ADR 0018). The two caps keep today's meaning (fail toward the planner); only their landing mode changes from shadow to
off. `mode: "off"` reaches the existing gate rule unchanged: the turn goes to the planner, reason `disabled`.

**Behaviour today vs after, on the live daemon** (`HOUGE_JEV_ENABLED` on, `HOUGE_JEV_TRIAGE_ENABLED=arm`, no marker, no
file): `arm` both. No change.

**Other configurations:** `HOUGE_JEV_TRIAGE_ENABLED=off` or `shadow` with Jev on was off or shadow, is now armed (the
point of 1-A), with the boot line of §5. A marker or a gate-only calibration file was shadow (Jev asked, rows recorded,
nothing applied), is now off (Jev not asked, no row).

## 5. Retired env vars

`HOUGE_JEV_LANES_OFF` and `HOUGE_JEV_TRIAGE_ENABLED` are read for no behaviour. Their names live in one constant,
`RETIRED_JEV_FLAGS` in `src/jev/jev-flags.ts`, read once at boot by `warnRetiredJevFlags(env, log)` (replaces
`warnUnknownJevLanesOff`, same call site): one error line per retired var that is set to anything that would have changed
behaviour (`HOUGE_JEV_LANES_OFF` non-empty; `HOUGE_JEV_TRIAGE_ENABLED` set to anything but `arm`), naming the var, "retired
(ADR 0034 1.6), ignored", fail loud, run on. No value is printed.

`HOUGE_JEV_TRIAGE_ENABLED=arm` stays in the live `.env` on purpose and is silent: an older `dist/` reads it, so a rollback
keeps the front door armed (§9). `configuration.md` lists both vars as retired, with that note.

## 6. Removals

- **`lanesOff`.** `resolveJevLanesOff`, the `lanesOff` field of `PlanInput`, the `lanesOff` parameter of `treeArmed`
  (`src/decisions/jev-version-check.ts`, protected: edited under this spec) and the `!lanesOff.has(l)` term. A lane is
  armed by its pseudo-row, the model's check and its dependencies, as today.
- **The runner's shadow mode** (`src/decisions/`). `DecideCtx.armed` (only the front door passed it), `modeOf`'s override
  branch, the walk's `shadowed` flag and `apply`'s shadow branch go. `ArmedMode` narrows to `"on"`: a registered entry
  cannot be declared shadow or off by type, so the registry's runtime check ("entry armed other than on") is unreachable and
  goes with it; a type-level test replaces its test. `RecordedArmedMode` keeps `"shadow"` for rows written by older builds;
  `finish` writes `"on"` (or `"late"` through the injection judge, unchanged).
- **The front door's shadow.** `TREE_SHADOWED`, the `armed:` argument in `triageTurnInner`, `decisionFor`'s `"shadow"` return,
  the `"shadow"` member of the answered outcome's `decision` and `persistDecisionRows`' parameter (the stored
  `JevDecisionOutcome` keeps `'shadow'` for history). `turnHandlerGate` runs the ack rule whenever the mode is not off (today
  "only when armed", and the mode is now off or armed). `planTree` arms by `treeArmed` whenever called (the off path never
  reaches it).

Comments and docstrings that name the removed modes are rewritten in the same change; the R13 test (§8) fails on a new
switch-like name.

## 7. `/status`

`renderHougeStatus` gains one line after `Runtime:`:

| cause | line |
|---|---|
| `armed` | `Jev front door: armed` |
| `disarmed` | `Jev front door: off (/disarm; /rearm restores it)` |
| `env_off` | `Jev front door: off (HOUGE_JEV_ENABLED is off in .env)` |
| `calibration_file` | `Jev front door: off (HOUGE_JEV_CALIBRATION_FILE is set outside a gate)` |
| `disarm_marker` | `Jev front door: off (houge.jev-disarmed marker from an older build; remove it by hand)` |

`collectHougeStatus` computes it with `resolveJevFrontDoor(env, dataDir)`, where `dataDir` is the daemon's omp data dir (the
same value the worker passes); a throw renders `Jev front door: unknown (check failed)`. The line names env vars, never
values, and fits inside `HOUGE_STATUS_MAX_CHARS` (the block is cut as today if not).

## 8. Tests

Hermetic, red first.
- **R13 conformance** (`tests/adr/0034-no-off-switch.test.ts`): `R13_SUBJECTS` empties and goes; a `RETIRED` group lists
  both names, reason "retired by this spec, named only by the boot warning", and a new assertion that under `src/` those names
  occur only in `src/jev/jev-flags.ts`. The mode check reads `JevTriageMode` and expects exactly `arm`, `off`;
  `triageModes` reads the new resolver.
- **Resolver:** one case per table row in §4, including precedence (posture + calibration file → `disarmed`; file + marker
  → `calibration_file`) and a stale `HOUGE_JEV_TRIAGE_ENABLED=off` / `shadow` with Jev on → `arm`.
- **Boot warning:** each retired var set → its one line; `HOUGE_JEV_TRIAGE_ENABLED=arm` → silent; no value in the line.
- **treeArmed:** the lane cases without `lanesOff`; a lane still unarmed by a missing pseudo-row and by a drift disarm.
- **Runner:** a type-level test that `armed: { system_one: "shadow" }` does not compile on an entry; no `DecideCtx.armed`.
- **Front door:** the marker and the calibration file each settle the turn to the planner with reason `disabled` and write no
  Jev row (today: a shadow row).
- **`/status`:** one rendered line per cause.
- **Tests that used the retired paths** are re-pointed, not deleted, where the behaviour they guard survives: the parity
  test proves the planner path with rows that carry no lane pseudo-rows instead of `HOUGE_JEV_LANES_OFF`; the lane-off cases
  (`core-worker-lanes`, `turn-handler-pin`, `tree-policy`) become missing-pseudo-row cases; tests that ran the front door in
  shadow move to arm or off by what they assert. The plan lists each file.

## 9. Gates, rollback, deploy

- **Live gate** `scripts/live-gate-jev-no-off-switch.mjs` (built `dist/`, temp copy of the DB, the real `.env` through
  `HOUGE_ENV_FILE`, no Telegram send):
  1. the real `.env` resolves `arm` / `armed`;
  2. a child env adding `HOUGE_JEV_TRIAGE_ENABLED=off` and `HOUGE_JEV_LANES_OFF=answer` still resolves `arm`, boot prints
     exactly two retired-var lines, and `treeArmed` with the live calibration rows arms the answer lane;
  3. a marker file in the temp data dir → `off` / `disarm_marker`, and the `/status` block carries that line;
  4. `HOUGE_JEV_ENABLED=0` → `env_off`; with a disarm posture file too → `disarmed`;
  5. one front-door turn through the real Jev in arm on the temp DB writes a `turn.handler` decision row with
     `armed_mode = 'on'` and a Jev row whose `decision` is not `shadow`; zero `shadow` values written by the run.
  PASS needs all five; check 5 fails on a skipped Jev call (silent degradation), not only on an error.
- **Gates amended on purpose:** every gate or rollback check that sets `HOUGE_JEV_TRIAGE_ENABLED: "off"` to keep Jev away
  from the front door also sets `HOUGE_JEV_ENABLED: "0"` (the old `dist/` a rollback check runs still reads the triage var,
  so it stays); `live-gate-jev-tree` drops its lane-off case; `live-gate-decisions-parity` drops `HOUGE_JEV_LANES_OFF` from
  its scrubbed keys. Each is run and listed in the report.
- **Rollback:** no migration, no new table. An older `dist/` with the live `.env` (`HOUGE_JEV_ENABLED` on,
  `HOUGE_JEV_TRIAGE_ENABLED=arm`) arms the front door as before; rows the new build writes are `armed_mode = 'on'`, which
  every older reader accepts.
- **Deploy:** merge, rebuild `dist/`, kickstart (Tier A), verify the new pid, the boot migrations and `/status`'s
  `Jev front door: armed`.

## 10. ADRs (same branch, Paco signs)

- **ADR 0034 1.6:** drop the "runner's `shadow` mode exists only so the front door keeps…" sentence and the 2026-11-04
  "to be removed" parenthetical; state that the front door is armed whenever the capability runs, and that the only env var
  over Jev's arming is the STOP flag `HOUGE_JEV_ENABLED` (A5 kept). Rule 3.1's "or was asked in shadow (the runner's
  `shadow` mode, rule 1.6)" becomes a note that rows written before this amendment may carry `armed_mode = 'shadow'`.
  History row.
- **ADR 0033:** F7 (the triage report's live stats: historical shadow rows only), G6 (both caps hold the front door at
  off, not shadow), lane 5 in the lane list and the open-questions line (ships armed; strike "may move from shadow to
  selection; its shadow plan …"), History row.
- `tests/adr/` changes in the same commit as each rule it checks (AGENTS.md).

## 11. Docs sync

`configuration.md` (both vars retired, `HOUGE_JEV_ENABLED` now the front door's flag, the calibration-file note),
`jev-decision-layer.md` (lane-off and shadow paragraphs, the "one lane off" recovery step → `/disarm` or a missing row),
README (the R13 sentence; `/status` line), `decision-map.md` if it names the shadow mode, ROADMAP (lane 5 line),
`CONTEXT.md` (**Rung**: "the only shadow is the front door's" goes; **Intent Shadow**: "which still exists" goes), `tasks/todo.md`, `sessions.md`, `tasks/lessons.md` if a lesson comes
out. The docs-parity test must stay green.

## 12. Residuals

- A marker or a gate-only calibration file turns the front door off with a `/status` line and a boot log line, not a page.
  The marker has had no writer since stage B and the file is gate-only, so neither occurs in normal running.
- The retired names remain as literals in `src/jev/jev-flags.ts` (for the warning). The R13 test pins them to that file.
- `HOUGE_JEV_TRIAGE_ENABLED=arm` stays in the live `.env` for rollback; removing it is a later cleanup, once no
  pre-change `dist/` is a rollback target.
