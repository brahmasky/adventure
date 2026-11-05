import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";
import { drainOutbox } from "../helpers/omp-worker.js";

// Paco reads /status through the gateway renderer, not renderHougeStatus (codex B): the front-door
// line must be here, naming why Jev is off, or an off door looks like a healthy quiet one.
const NOW = "2026-11-05T10:00:00.000Z";
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sfd-"));
  vi.stubEnv("HOUGE_DISARM_PATH", join(dir, "houge.disarm"));
  vi.stubEnv("HOUGE_JEV_DISARM_PATH", join(dir, "houge.jev-disarmed"));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

function statusText(): string {
  const s = RunStore.openInMemory();
  new Gateway(s, undefined, dir, undefined, undefined, { dataDir: dir }).intake(buildTypedTaskEvent({ source: "telegram", type: "status", requested_by: { kind: "user", id: "paco" },
    notify: { kind: "telegram", chat_id: "222" }, idempotency_key: "telegram:fd", source_reference: "telegram:update:fd" }), NOW);
  const text = String([...drainOutbox(s).values()][0]?.text);
  s.close();
  return text;
}

describe("/status front-door line", () => {
  it("flag unset: names HOUGE_JEV_ENABLED, right after the Self-check line", () => {
    vi.stubEnv("HOUGE_JEV_ENABLED", "");
    expect(statusText()).toMatch(/Self-check: .*\nJev front door: off \(HOUGE_JEV_ENABLED is off/);
  });
  it("posture file with the flag off: says disarmed", () => {
    writeFileSync(join(dir, "houge.disarm"), "{}");
    vi.stubEnv("HOUGE_JEV_ENABLED", "false");
    expect(statusText()).toContain("Jev front door: off (/disarm; /rearm restores it)");
  });
  it("flag on: armed", () => {
    vi.stubEnv("HOUGE_JEV_ENABLED", "1");
    expect(statusText()).toContain("Jev front door: armed");
  });
});
