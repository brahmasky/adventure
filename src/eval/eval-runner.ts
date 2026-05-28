import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface EvalSuiteFile {
  name: string;
  required_fixtures: string[];
}

export interface EvalFixtureFile {
  name: string;
  checks: string[];
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
    if (fixtureName.length === 0) return true;
    const fixturePath = join(fixturesDir, `${fixtureName}.json`);
    if (!existsSync(fixturePath)) return true;

    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Partial<EvalFixtureFile>;
    return fixture.name !== fixtureName || !Array.isArray(fixture.checks) || fixture.checks.length === 0;
  });
  return { suite: data.name, passed: failed.length === 0, failed };
}
