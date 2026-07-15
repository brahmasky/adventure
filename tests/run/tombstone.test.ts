import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  clearTombstone,
  DEFAULT_TOMBSTONE_PATH,
  formatKillAckText,
  formatTombstoneParkedMessage,
  readTombstone,
  resolveTombstonePath,
  REVIVE_COMMAND,
  writeTombstone
} from "../../src/run/tombstone.js";

// Every call passes an EXPLICIT env object (PINNED_ENV hermeticity): the module must
// never be exercised against the repo root here — a stray test tombstone at the real
// default path would kill the real daemon's next boot.
const dir = mkdtempSync(join(tmpdir(), "houge-tombstone-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function envAt(name: string): NodeJS.ProcessEnv {
  return { HOUGE_TOMBSTONE_PATH: join(dir, name) };
}

describe("tombstone path resolution", () => {
  it("defaults to houge.kill at the repo root and honors HOUGE_TOMBSTONE_PATH", () => {
    expect(resolveTombstonePath({})).toBe(DEFAULT_TOMBSTONE_PATH);
    expect(DEFAULT_TOMBSTONE_PATH).toBe("houge.kill");
    expect(resolveTombstonePath({ HOUGE_TOMBSTONE_PATH: "/tmp/x/houge.kill" })).toBe("/tmp/x/houge.kill");
    // blank override degrades to the default rather than writing to ""
    expect(resolveTombstonePath({ HOUGE_TOMBSTONE_PATH: "  " })).toBe(DEFAULT_TOMBSTONE_PATH);
  });
});

describe("tombstone lifecycle", () => {
  it("write → read roundtrips the kill record (killed_at, by, optional reason)", () => {
    const env = envAt("roundtrip.kill");
    const path = writeTombstone({ killed_at: "2026-07-15T00:00:00.000Z", by: "paco", reason: "runaway" }, env);
    expect(path).toBe(env.HOUGE_TOMBSTONE_PATH);
    expect(readTombstone(env)).toEqual({ killed_at: "2026-07-15T00:00:00.000Z", by: "paco", reason: "runaway" });
    // the file body is human-inspectable JSON (the operator reads it before reviving)
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ by: "paco" });
  });

  it("absent tombstone reads null — the ONLY state that lets the daemon start", () => {
    expect(readTombstone(envAt("never-written.kill"))).toBeNull();
  });

  it("a CORRUPT tombstone still kills: garbage/non-object bodies read as present, not null", () => {
    // Corrupting the file must never revive the agent (fail-closed): a kill switch that
    // a disk glitch or a stray editor could undo is not a kill switch.
    const garbage = envAt("garbage.kill");
    writeFileSync(garbage.HOUGE_TOMBSTONE_PATH!, "{not json at all");
    expect(readTombstone(garbage)).toEqual({});

    const nonObject = envAt("nonobject.kill");
    writeFileSync(nonObject.HOUGE_TOMBSTONE_PATH!, "42");
    expect(readTombstone(nonObject)).toEqual({});

    const empty = envAt("empty.kill");
    writeFileSync(empty.HOUGE_TOMBSTONE_PATH!, "");
    expect(readTombstone(empty)).toEqual({});
  });

  it("clearTombstone removes the file (manual revival); clearing a missing file is a no-op", () => {
    const env = envAt("cleared.kill");
    writeTombstone({ killed_at: "2026-07-15T00:00:00.000Z", by: "paco" }, env);
    clearTombstone(env);
    expect(readTombstone(env)).toBeNull();
    expect(() => clearTombstone(env)).not.toThrow();
  });
});

describe("user-facing strings", () => {
  it("the /kill ack names the tombstone path and the full manual revival steps", () => {
    const text = formatKillAckText("/x/houge.kill");
    expect(text).toContain("/x/houge.kill");
    expect(text).toContain(REVIVE_COMMAND);
    expect(text).toContain("PARKS");
  });

  it("the boot park line names the path and the revival steps (the operator's only breadcrumb)", () => {
    const text = formatTombstoneParkedMessage("/x/houge.kill");
    expect(text).toContain("/x/houge.kill");
    expect(text).toContain(REVIVE_COMMAND);
  });
});
