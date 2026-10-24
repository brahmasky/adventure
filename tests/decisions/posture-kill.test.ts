import { POSTURE_KILL } from "../../src/decisions/entries/posture-kill.js";
import { decideSync } from "../../src/decisions/decide.js";
import { describe, it, expect } from "vitest";

describe("posture.kill entry", () => {
  it("armed when armed", () => {
    const r = decideSync(POSTURE_KILL, { armed: true }, { run_id: null, recorder: { record: () => null } });
    expect(r.verdict).toBe("armed");
  });
  it("killed when not armed", () => {
    const r = decideSync(POSTURE_KILL, { armed: false }, { run_id: null, recorder: { record: () => null } });
    expect(r.verdict).toBe("killed");
  });
});
