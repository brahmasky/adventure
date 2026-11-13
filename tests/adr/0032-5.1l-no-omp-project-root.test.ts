import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildChildEnv } from "../../src/omp/child-env.js";
import { resolveOmpConfig } from "../../src/omp/omp-config.js";
import { isDeniedWrite, isOmpProjectDir } from "../../src/omp/protected-paths.js";
import { renderSeatbelt } from "../../src/omp/seatbelt.js";

// ADR 0032 5.1 (l): omp loads plugin code from the nearest `.omp` at or above its cwd and no setting turns that off, so
// neither the gate nor either sandbox profile may let one be written in the workspace or directly in an ancestor below $HOME.
const ctx = { home: "/Users/p", repo: "/Users/p/Projects/adventure", data: "/Users/p/Projects/adventure" };
describe("ADR 0032 5.1 (l): no .omp project root can be planted", () => {
  it("the gate denies it in the workspace and in each ancestor below $HOME, never $HOME's own ~/.omp", () => {
    for (const p of ["/Users/p/Projects/adventure/omp/workspace/chat-1/.omp/plugins/package.json", "/Users/p/Projects/.omp"]) {
      expect(isDeniedWrite(p, ctx), p).toBe(true);
    }
    expect(isOmpProjectDir("/Users/p/.omp/profiles/houge/agent/agent.db", ctx)).toBe(false);
  });
  it("both profiles carry the deny", () => {
    for (const p of [renderSeatbelt(ctx).planner, renderSeatbelt(ctx).shell]) {
      expect(p).toContain('(deny file-write* (regex #"^/Users/p/Projects/\\.[Oo][Mm][Pp](/.*)?$"))');
      expect(p).toContain('(deny file-write* (regex #"^/Users/p/Projects/adventure/omp/workspace(/.*)?/\\.[Oo][Mm][Pp](/.*)?$"))');
      expect(p).not.toContain('"^/Users/p/\\.[Oo][Mm][Pp]');
    }
  });
  it("omp's config dir name cannot be moved off .omp: PI_CONFIG_DIR never reaches an omp child, so the rules' fixed name holds", () => {
    const saved = process.env.PI_CONFIG_DIR;
    process.env.PI_CONFIG_DIR = ".elsewhere";
    try {
      expect(buildChildEnv(resolveOmpConfig({}).envPassthrough)).not.toHaveProperty("PI_CONFIG_DIR");
      // nor when Paco's .env lists it for passthrough
      expect(buildChildEnv(resolveOmpConfig({ HOUGE_OMP_ENV_PASSTHROUGH: "KIMI_CODE_BASE_URL,PI_CONFIG_DIR" }).envPassthrough)).not.toHaveProperty("PI_CONFIG_DIR");
    } finally { if (saved === undefined) delete process.env.PI_CONFIG_DIR; else process.env.PI_CONFIG_DIR = saved; }
  });
  it("the ADR states the rule", () => {
    expect(readFileSync(join(process.cwd(), "docs/decisions", "0032-omp-runtime-consolidated.md"), "utf8"))
      .toContain("(l) *Added 2026-11-13:* no `.omp` may be written under the workspace");
  });
});
