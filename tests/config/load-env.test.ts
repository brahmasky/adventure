import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadHougeEnv } from "../../src/config/load-env.js";

// Unique, namespaced keys so the test never collides with the real environment.
const KEYS = ["HOUGE_TEST_TOKEN", "HOUGE_TEST_MODEL", "HOUGE_TEST_PRESET"] as const;

afterEach(() => {
  for (const key of KEYS) delete process.env[key];
});

function writeEnv(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-env-"));
  const path = join(dir, ".env");
  writeFileSync(path, lines.join("\n"));
  return path;
}

describe("loadHougeEnv", () => {
  it("applies file values for unset variables", () => {
    const path = writeEnv([
      "# Houge config",
      "HOUGE_TEST_TOKEN=from-file",
      'HOUGE_TEST_MODEL="test-model-1"'
    ]);

    const applied = loadHougeEnv({ path });

    expect(process.env.HOUGE_TEST_TOKEN).toBe("from-file");
    expect(process.env.HOUGE_TEST_MODEL).toBe("test-model-1");
    expect(applied).toEqual(expect.arrayContaining(["HOUGE_TEST_TOKEN", "HOUGE_TEST_MODEL"]));
  });

  it("never overwrites a variable already set in the environment", () => {
    process.env.HOUGE_TEST_PRESET = "from-shell";
    const path = writeEnv(["HOUGE_TEST_PRESET=from-file"]);

    const applied = loadHougeEnv({ path });

    expect(process.env.HOUGE_TEST_PRESET).toBe("from-shell");
    expect(applied).not.toContain("HOUGE_TEST_PRESET");
  });

  it("treats a missing file as a no-op, not an error", () => {
    expect(loadHougeEnv({ path: join(tmpdir(), "houge-does-not-exist", ".env") })).toEqual([]);
  });
});
