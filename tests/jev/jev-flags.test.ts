import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { frontDoorLine, jevDisarmMarkerPath, readJevDisarmMarker, RETIRED_JEV_FLAGS, resolveJevEnabled, resolveJevFrontDoor, resolveJevLanesOff, resolveJevTriageMode, warnRetiredJevFlags, warnUnknownJevLanesOff } from "../../src/jev/jev-flags.js";
import { DISARM_FLAGS } from "../../src/config/disarm-posture.js";

// Spec §3.8: default off; /disarm (which writes "false") must switch the lane off; a disarm marker left by an
// older build caps the tree at shadow until Paco deletes it (stage B writes none).
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
    writeFileSync(p, JSON.stringify({ reason: "triage_overrides", at: "2026-10-04T00:00:00.000Z" })); // a marker an older build left
    expect(readJevDisarmMarker(p)).toEqual({ reason: "triage_overrides", at: "2026-10-04T00:00:00.000Z" });
    expect(resolveJevTriageMode({ HOUGE_JEV_ENABLED: "1", HOUGE_JEV_TRIAGE_ENABLED: "arm" }, dir)).toBe("shadow");
    rmSync(p);
    expect(resolveJevTriageMode({ HOUGE_JEV_ENABLED: "1", HOUGE_JEV_TRIAGE_ENABLED: "arm" }, dir)).toBe("arm");
  });
  it("caps arm at shadow when HOUGE_JEV_CALIBRATION_FILE is set without HOUGE_JEV_GATE=1", () => {
    expect(resolveJevTriageMode({ HOUGE_JEV_ENABLED: "1", HOUGE_JEV_TRIAGE_ENABLED: "arm", HOUGE_JEV_CALIBRATION_FILE: "/some/file" }, dir)).toBe("shadow");
    expect(resolveJevTriageMode({ HOUGE_JEV_ENABLED: "1", HOUGE_JEV_TRIAGE_ENABLED: "arm", HOUGE_JEV_CALIBRATION_FILE: "/some/file", HOUGE_JEV_GATE: "1" }, dir)).toBe("arm");
  });

  // Stage B spec §6: /disarm turns off all of Jev, so each lane gets its own switch. A typo must be loud (one boot line) and
  // harmless (ignored), never a silently armed lane or a crash.
  it("HOUGE_JEV_LANES_OFF: answer and lookup, case and spaces folded; an unknown name is dropped and named once", () => {
    expect([...resolveJevLanesOff({})]).toEqual([]);
    expect([...resolveJevLanesOff({ HOUGE_JEV_LANES_OFF: " Lookup , answer " })].sort()).toEqual(["answer", "lookup"]);
    expect([...resolveJevLanesOff({ HOUGE_JEV_LANES_OFF: "memory,lookup" })]).toEqual(["lookup"]);
    const lines: string[] = [];
    expect(warnUnknownJevLanesOff({ HOUGE_JEV_LANES_OFF: "memory,lookup,wiki" }, (l) => lines.push(l))).toEqual(["memory", "wiki"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("memory, wiki");
    expect(warnUnknownJevLanesOff({ HOUGE_JEV_LANES_OFF: "answer" }, (l) => lines.push(l))).toEqual([]);
    expect(lines).toHaveLength(1);
  });
});

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
  // HOUGE_DISARM_PATH always points into the temp dir: the default is a cwd-relative houge.disarm, which a /disarm'd checkout has.
  it("flag off: env_off; flag off with the /disarm posture file: disarmed", () => {
    const d = dir();
    expect(resolveJevFrontDoor({ HOUGE_DISARM_PATH: join(d, "none") }, d)).toEqual({ mode: "off", cause: "env_off" });
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
    expect(frontDoorLine({ HOUGE_DISARM_PATH: join(d, "none") }, d)).toBe("Jev front door: off (HOUGE_JEV_ENABLED is off in this process: .env, or /rearm awaiting a restart)");
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
