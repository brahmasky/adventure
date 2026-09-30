import { spawn } from "node:child_process";
import type { LlmAuditSink } from "../audit.js";
import type { LlmResult } from "../types.js";
import { buildChildEnv } from "../../omp/child-env.js";
import type { OmpConfig } from "../../omp/omp-config.js";
import { checkOmpVersion } from "../../omp/omp-version.js";
import { classifyOmpError, parseFrameLine, summarizeAssistantMessage, type AssistantSummary } from "../../omp/omp-frames.js";
import { familyOf, formatModelString, type ModelFamily, type ModelString } from "../../omp/model-string.js";

export interface OneShotInput {
  seat: string; chain: ModelString[]; prompt: string; files?: string[];
  correlationId: string; timeoutMs?: number; plannerFamily?: ModelFamily;
}
export interface OneShotDeps {
  cfg: OmpConfig; audit: LlmAuditSink; versionCheck?: () => ReturnType<typeof checkOmpVersion>;
}

const STDOUT_CAP_BYTES = 8 * 1024 * 1024;

export function ompOneShotArgs(cfg: OmpConfig, m: ModelString, files: string[]): string[] {
  const args = ["--profile", cfg.profile, "-p", "--mode", "json", "--no-session", "--no-tools",
    "--no-extensions", "--no-skills", "--no-rules", "--model", `${m.provider}/${m.model}`];
  if (m.effort) args.push("--thinking", m.effort);
  for (const f of files) args.push(`@${f}`);
  return args;
}

interface LegOutcome { summary: AssistantSummary | null; error?: string; timedOut: boolean; latencyMs: number }

function runLeg(cfg: OmpConfig, m: ModelString, input: OneShotInput): Promise<LegOutcome> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cfg.bin, ompOneShotArgs(cfg, m, input.files ?? []), {
      env: buildChildEnv(cfg.envPassthrough), stdio: ["pipe", "pipe", "pipe"]
    });
    let out = ""; let err = ""; let timedOut = false; let bytes = 0;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, input.timeoutMs ?? cfg.oneshotTimeoutMs);
    child.stdout.on("data", (d: Buffer) => { bytes += d.length; if (bytes <= STDOUT_CAP_BYTES) out += d.toString("utf8"); else child.kill("SIGKILL"); });
    child.stderr.on("data", (d: Buffer) => { if (err.length < 4096) err += d.toString("utf8"); });
    child.stdin.on("error", () => { /* child exited before reading stdin; close handler resolves */ });
    child.on("error", (e) => { clearTimeout(timer); resolve({ summary: null, error: `spawn error: ${e.message}`, timedOut, latencyMs: Date.now() - started }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const summaries = out.split("\n").map(parseFrameLine).filter((f) => f !== null).map(summarizeAssistantMessage).filter((s) => s !== null);
      const summary = summaries.at(-1) ?? null;
      const error = timedOut ? "timed out" : code !== 0 ? `exit ${code}: ${err.slice(0, 300)}` : undefined;
      resolve({ summary, ...(error ? { error } : {}), timedOut, latencyMs: Date.now() - started });
    });
    child.stdin.end(input.prompt);
  });
}

function legFailure(o: LegOutcome): string | null {
  if (o.timedOut) return "timed out";
  if (o.summary?.stopReason === "error" || o.summary?.errorMessage) return o.summary.errorMessage ?? "error";
  if (o.error) return o.error;
  if (!o.summary || o.summary.text.trim().length === 0) return "produced no answer";
  return null;
}

export async function spawnOneShot(input: OneShotInput, deps: OneShotDeps): Promise<LlmResult> {
  const version = (deps.versionCheck ?? (() => checkOmpVersion(deps.cfg)))();
  // No leg ran, so no audit row: the structured check rides out for the caller's incident (ruling 6).
  if (!version.ok) return { ok: false, provider: "omp", error: version.reason, unavailable: true, omp_check: version };
  const errors: string[] = [];
  for (const [i, m] of input.chain.entries()) {
    const o = await runLeg(deps.cfg, m, input);
    const failure = legFailure(o);
    const family = familyOf(m);
    const base = {
      provider: m.provider, role: "", latency_ms: o.latencyMs, family, leg_index: i,
      attempt_group: input.correlationId, request_key: `${input.correlationId}:${i}`,
      ...(input.plannerFamily !== undefined && input.plannerFamily === family ? { family_collapse: true } : {})
    };
    if (failure === null && o.summary) {
      deps.audit.record({ ...base, outcome: "ok", model: o.summary.model ?? m.model,
        ...(o.summary.usage ? { usage: o.summary.usage } : {}),
        ...(o.summary.credentialId !== undefined ? { credential_id: o.summary.credentialId } : {}),
        ...(o.summary.ttftMs !== undefined ? { ttft_ms: o.summary.ttftMs } : {}) });
      return { ok: true, provider: m.provider, model: o.summary.model ?? m.model, answer: o.summary.text,
        ...(o.summary.usage ? { usage: o.summary.usage } : {}) };
    }
    const kind = o.timedOut ? "timeout" : classifyOmpError(failure ?? "");
    deps.audit.record({ ...base, outcome: "error", model: m.model, error_kind: kind });
    errors.push(`${formatModelString(m)}: ${kind}`);
  }
  return { ok: false, provider: "omp", error: `all ${input.seat} legs failed — ${errors.join("; ")}` };
}
