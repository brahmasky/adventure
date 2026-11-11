/**
 * Rule: ADR 0034 1.6 (R13) "no off switch, no shadow by design"
 * (docs/decisions/0034-decision-ladder-consolidated.md). The set of switch-like env vars under all of src/, and the modes the front door can take (the JevTriageMode union), equal the explicit lists below. A new switch or mode fails.
 * Changing this rule changes this test in the same commit.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DISARM_FLAGS } from "../../src/config/disarm-posture.js";
import { RETIRED_JEV_FLAGS } from "../../src/jev/jev-flags.js";
import { retiredNameFiles, switchEnvNames, triageModes } from "./conformance.js";

const root = join(import.meta.dirname, "..", "..");
const walk = (dir: string): string[] =>
  readdirSync(join(root, dir), { withFileTypes: true }).flatMap((d) => {
    const rel = join(dir, d.name);
    return d.isDirectory() ? walk(rel) : /\.(ts|sh|mjs)$/.test(d.name) ? [rel] : [];
  });
const texts = (dir: string): string[] => walk(dir).map((p) => readFileSync(join(root, p), "utf8"));

const STOP_REASON = "ADR 0018 STOP flag, outside R13 per ADR 0034 1.6 (ruling A5, signed by Paco 2026-11-05)";

/** (i) Retired by spec 2026-11-05: no behaviour reads them; the boot warning names them. */
const RETIRED: Record<string, string> = Object.fromEntries(RETIRED_JEV_FLAGS.map((n) => [n, "retired by spec 2026-11-05 (ADR 0034 1.6); named only by the boot warning"]));
/** (ii) The /disarm flags, imported (not retyped) from src/config/disarm-posture.ts. */
const STOP_FLAGS: Record<string, string> = Object.fromEntries(DISARM_FLAGS.map((n) => [n, STOP_REASON]));
/** (iii) Capability flags that gate a feature, not a ladder entry's decision. */
const CAPABILITY_FLAGS: Record<string, string> = {
  HOUGE_BACKUP_ENABLED: "ADR 0021 DB backup job",
  HOUGE_EPISODIC_ENABLED: "ADR 0016 episodic retrieval (embeddings)",
  HOUGE_HTTPFETCH_ENABLED: "the http_fetch loop tool's availability",
  HOUGE_INVARIANT_SWEEP_ENABLED: "ADR 0024 introspection sweep job",
  HOUGE_RATING_ENABLED: "session rating capture feature",
  HOUGE_WIKI_ENABLED: "ADR 0020 LLM wiki build/refine tools",
  HOUGE_TIME_TOOL_ENABLED: "the to_local_time loop tool's availability"
};
/** (iv) Could not be classified honestly: each reads like a gate or locked-entry switch. The orchestrator rules on these. */
// Ruled 2026-11-05 (orchestrator; listed for Paco with the signature): capability arming flags that predate the ladder and
// switch a capability, not an entry's arming. The entries in their path still record on every call.
const RULED_CAPABILITY_FLAGS: Record<string, string> = {
  HOUGE_SECRETS_FIREWALL_ENABLED: "arms the ADR 0015 firewall capability; secret.redact records only while it is armed, as ADR 0034's 4B entry row states (signed 2026-10-30)",
  HOUGE_TZ_EVIDENCE_ENABLED: "arms timezone-source evidence in time_convert; not a ladder entry",
  HOUGE_DUAL_LLM_ENABLED: "retired (ADR 0032 D3: the wall is unconditional); matched only by a comment in src/core/quarantine.ts, documented retired in configuration.md"
};
const KNOWN_SWITCHES: Record<string, string> = { ...RETIRED, ...STOP_FLAGS, ...CAPABILITY_FLAGS, ...RULED_CAPABILITY_FLAGS };

/** The front door's modes (JevTriageMode). */
const KNOWN_MODES: Record<string, string> = {
  off: "Jev is off (HOUGE_JEV_ENABLED off, /disarm, or a cap)",
  arm: "Jev decides at the front door"
};

describe("ADR 0034 1.6 (R13): switch-like env vars across src/ and front-door modes equal the allowlists", () => {
  it("reads only the known switch-like env vars anywhere in src/ (entry glue lives in core, omp, improve), so a new off switch cannot slip in unseen", () => {
    expect(switchEnvNames(texts("src"))).toEqual(Object.keys(KNOWN_SWITCHES).sort());
  });
  it("allowlists only names src still contains, so a removed switch must leave the list", () => {
    const read = new Set(switchEnvNames(texts("src")));
    expect(Object.keys(KNOWN_SWITCHES).filter((n) => !read.has(n))).toEqual([]);
  });
  it("accepts only the known front-door modes, so a new mode (a second shadow) fails here first", () => {
    expect(triageModes(readFileSync(join(root, "src/jev/jev-flags.ts"), "utf8"))).toEqual(Object.keys(KNOWN_MODES).sort());
  });
  it("the retired names occur under src/ only in src/jev/jev-flags.ts, so a retired switch cannot come back by name", () => {
    const files = walk("src").map((path) => ({ path, text: readFileSync(join(root, path), "utf8") }));
    expect(retiredNameFiles(files, RETIRED_JEV_FLAGS)).toEqual(["src/jev/jev-flags.ts"]);
  });
  it("flags a retired name planted outside src/jev/jev-flags.ts", () => {
    const files = [{ path: "src/jev/jev-flags.ts", text: "HOUGE_JEV_LANES_OFF" }, { path: "src/core/x.ts", text: "env.HOUGE_JEV_TRIAGE_ENABLED" }, { path: "src/core/y.ts", text: "clean" }];
    expect(retiredNameFiles(files, RETIRED_JEV_FLAGS)).toEqual(["src/core/x.ts", "src/jev/jev-flags.ts"]);
  });
  it("flags planted switches (incl. MODE, ARM, SKIP, ON suffixes) and planted front-door modes", () => {
    const planted = 'env.HOUGE_JEV_NEW_DISABLED; env.HOUGE_X_SHADOW; env.HOUGE_JEV_FOO; // HOUGE_Y_OFF; HOUGE_SETTLE_MODE HOUGE_X_ARM HOUGE_JEV_SKIP HOUGE_Z_ON';
    expect(switchEnvNames([planted])).toEqual(["HOUGE_JEV_NEW_DISABLED", "HOUGE_JEV_SKIP", "HOUGE_SETTLE_MODE", "HOUGE_X_ARM", "HOUGE_X_SHADOW", "HOUGE_Y_OFF", "HOUGE_Z_ON"]);
    const flags = 'export type JevTriageMode = "off" | "arm" | "dry";\nexport function other() { return raw === "zzz"; }';
    expect(triageModes(flags)).toEqual(["arm", "dry", "off"]);
  });
});
