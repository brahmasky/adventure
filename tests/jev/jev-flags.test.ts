import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { jevDisarmMarkerPath, readJevDisarmMarker, resolveJevEnabled, resolveJevLanesOff, resolveJevTriageMode, warnUnknownJevLanesOff, writeJevDisarmMarker } from "../../src/jev/jev-flags.js";
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
