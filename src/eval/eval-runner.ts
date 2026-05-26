import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface EvalSuiteFile {
  name: string;
  required_fixtures: string[];
}

export interface EvalResult {
  suite: string;
  passed: boolean;
  failed: string[];
}

export function runEvalSuite(projectRoot: string, suite: string): EvalResult {
  const path = join(projectRoot, "evals", "suites", `${suite}.json`);
  const data = JSON.parse(readFileSync(path, "utf8")) as EvalSuiteFile;
  const fixturesDir = join(projectRoot, "evals", "fixtures");
  const failed = data.required_fixtures.filter((name) => {
    const fixtureName = name.trim();
    return fixtureName.length === 0 || !existsSync(join(fixturesDir, `${fixtureName}.json`));
  });
  return { suite: data.name, passed: failed.length === 0, failed };
}
