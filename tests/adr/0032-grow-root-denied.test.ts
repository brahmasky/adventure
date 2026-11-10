/**
 * Rule: ADR 0032 §5.1 as amended by ADR 0035 (docs/decisions/0035-grow-zone-verification.md): the grow zone and the
 * backup folder are read- and write-denied to every child. `repo`, `data` and `grow` are three different directories, so
 * this cannot pass on the pre-existing repo deny. Changing this rule changes this test in the same commit.
 */
import { describe, expect, it } from "vitest";
import { isDeniedRead, isDeniedWrite } from "../../src/omp/protected-paths.js";
import { renderSeatbelt } from "../../src/omp/seatbelt.js";

const ctx = { home: "/Users/p", repo: "/Users/p/Projects/adventure", data: "/Users/p/Library/Application Support/houge/data", grow: "/Users/p/Library/Application Support/houge/grow" };

describe("ADR 0032 5.1: the grow zone and the backup folder are denied to children", () => {
  const paths = [`${ctx.grow}/skills/x/SKILL.md`, `${ctx.repo}/backups/houge-20261103T233023Z.sqlite`, `${ctx.repo}/backups/x.grow.bundle`];

  it("denies read and write by function", () => {
    for (const p of paths) {
      expect(isDeniedRead(p, ctx), p).toBe(true);
      expect(isDeniedWrite(p, ctx), p).toBe(true);
    }
  });

  it("renders the read+write deny in both profiles", () => {
    for (const prof of Object.values(renderSeatbelt(ctx))) {
      expect(prof).toContain(`(deny file-read* file-write* (subpath "${ctx.grow}"))`);
      expect(prof).toContain(`(deny file-read* file-write* (subpath "${ctx.repo}/backups"))`);
    }
  });
});
