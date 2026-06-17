import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stableHash } from "../domain/canonical.js";

export interface ReportInput {
  run_id: string;
  title: string;
  body: string;
  sources: string[];
  partial: boolean;
}

export interface WriteRunReportResult {
  path: string;
  hash: string;
}

export function writeRunReport(projectRoot: string, input: ReportInput): WriteRunReportResult {
  validateRunId(input.run_id);

  const dir = join(projectRoot, "runs", input.run_id);
  mkdirSync(dir, { recursive: true });

  const content = [
    `# ${input.title}`,
    "",
    `Run: ${input.run_id}`,
    `Partial: ${input.partial ? "yes" : "no"}`,
    "",
    input.body,
    "",
    "## Sources",
    "",
    ...input.sources.map((source) => `- ${source}`),
    ""
  ].join("\n");
  const path = join(dir, "report.md");

  writeFileSync(path, content);

  return { path, hash: stableHash(content) };
}

function validateRunId(run_id: string): void {
  if (run_id === "" || run_id.includes("/") || run_id.includes("\\") || run_id.includes("..")) {
    throw new Error(`Invalid run_id: ${run_id}`);
  }
}
