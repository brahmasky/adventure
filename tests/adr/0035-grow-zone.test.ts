/**
 * Rules: ADR 0035 (docs/decisions/0035-grow-zone-verification.md) G2 one door, G5 the verifier is out of Houge's reach.
 * Changing a rule changes its test in the same commit.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROTECTED_DIRS } from "../../src/capabilities/self-write-guard.js";
import { DISARM_FLAGS } from "../../src/config/disarm-posture.js";

const root = join(import.meta.dirname, "..", "..");
const walk = (dir: string): string[] =>
  readdirSync(join(root, dir), { withFileTypes: true }).flatMap((d) => {
    const rel = join(dir, d.name);
    return d.isDirectory() ? walk(rel) : /\.ts$/.test(d.name) ? [rel] : [];
  });

describe("ADR 0035 G5: the grow machinery is on the protected surface", () => {
  it("lists src/grow in PROTECTED_DIRS, so a self-write cannot edit the gate that checks self-written skills", () => {
    expect(PROTECTED_DIRS).toContain("src/grow");
  });
  it("puts HOUGE_GROW_ENABLED in DISARM_FLAGS, so /disarm can stop submissions", () => {
    expect(DISARM_FLAGS).toContain("HOUGE_GROW_ENABLED");
  });
});

describe("ADR 0035 G2: one door into the zone's repository", () => {
  it("has no caller of writeAndCommit / removeAndCommit outside src/grow/ops.ts", () => {
    const callers = walk("src").filter((p) => /\.(?:writeAndCommit|removeAndCommit)\(/.test(readFileSync(join(root, p), "utf8")));
    expect(callers.filter((p) => p !== join("src", "grow", "ops.ts"))).toEqual([]);
  });
});
