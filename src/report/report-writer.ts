import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  const { path, content } = renderReport(projectRoot, input);
  writeFileSync(path, content);
  return { path, hash: stableHash(content) };
}

export interface StagedRunReport extends WriteRunReportResult {
  /** Rename the staged file into place (only after the caller won the run's terminal write). */
  commit(): void;
  /** Remove the staged file (a stale owner never overwrites the winner's report). */
  discard(): void;
}

/** Write the report to a unique temp file beside its final path; nothing is visible until commit(). */
export function stageRunReport(projectRoot: string, input: ReportInput): StagedRunReport {
  const { path, content } = renderReport(projectRoot, input);
  const tmp = `${path}.tmp-${randomUUID()}`;
  writeFileSync(tmp, content);
  return {
    path, hash: stableHash(content),
    commit: () => renameSync(tmp, path),
    discard: () => rmSync(tmp, { force: true })
  };
}

function renderReport(projectRoot: string, input: ReportInput): { path: string; content: string } {
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
  return { path: join(dir, "report.md"), content };
}

function validateRunId(run_id: string): void {
  if (run_id === "" || run_id.includes("/") || run_id.includes("\\") || run_id.includes("..")) {
    throw new Error(`Invalid run_id: ${run_id}`);
  }
}
