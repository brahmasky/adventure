import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

/**
 * Loads `.env` into process.env without any third-party dependency
 * (uses Node's built-in `util.parseEnv`).
 *
 * Precedence: a variable already present in the real environment is NEVER
 * overwritten — an explicit `set -x FOO bar` always wins over the file. The
 * file only fills in variables that are otherwise unset.
 *
 * Resolution order for the file path:
 *   1. `options.path` if given,
 *   2. else `$HOUGE_ENV_FILE` (absolute path, lets a worktree point at a
 *      shared `.env` in the project root),
 *   3. else `<cwd>/.env`.
 *
 * A missing file is not an error — Houge also runs from a pure environment.
 *
 * @returns the keys that were applied from the file (useful for tests/logging).
 */
export function loadHougeEnv(options: { path?: string; cwd?: string } = {}): string[] {
  const cwd = options.cwd ?? process.cwd();
  const path = options.path ?? process.env.HOUGE_ENV_FILE ?? join(cwd, ".env");

  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return [];
  }

  const applied: string[] = [];
  for (const [key, value] of Object.entries(parseEnv(content))) {
    if (typeof value === "string" && process.env[key] === undefined) {
      process.env[key] = value;
      applied.push(key);
    }
  }
  return applied;
}
