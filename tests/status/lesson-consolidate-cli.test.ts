import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunStore } from "../../src/run/run-store.js";

const cliPath = resolve("src/cli.ts");
const tsxPath = resolve("node_modules/.bin/tsx");
let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-lessons-consolidate-"));
  tempDirs.push(dir);
  return dir;
}

/** Run the CLI with an EMPTY provider chain — the merge LLM call fails fast (no network); the
 *  dry-run degrades to "no proposals" and, critically, must still write nothing. */
function runDryRun(cwd: string) {
  return spawnSync(tsxPath, [cliPath, "lessons-consolidate", "--dry-run"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, HOUGE_LLM_PROVIDERS: "" }
  });
}

describe("houge lessons-consolidate --dry-run CLI", () => {
  afterEach(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs = [];
  });

  it("writes NOTHING: lessons rows and the last-run marker are unchanged, exit 0", () => {
    const dir = makeTempDir();
    const dbPath = join(dir, "houge.sqlite");

    // Seed two near-duplicate lessons.
    const seed = RunStore.open(dbPath);
    const before = (() => {
      seed.addLesson({ scope: "ask", text: "be concise", source: "user_feedback" });
      seed.addLesson({ scope: "ask", text: "keep it short", source: "user_feedback" });
      return seed.getActiveLessons("ask").map((r) => ({ id: r.id, text: r.text, status: r.status }));
    })();
    seed.close();

    const result = runDryRun(dir);
    expect(result.status).toBe(0);

    // Re-open and prove the dry run touched nothing.
    const after = RunStore.open(dbPath);
    try {
      expect(after.getActiveLessons("ask").map((r) => ({ id: r.id, text: r.text, status: r.status }))).toEqual(before);
      expect(after.getLessonConsolidateLastRun()).toBeNull(); // no marker stamp under dry run
    } finally {
      after.close();
    }
  });
});
