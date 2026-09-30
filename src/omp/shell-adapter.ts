import { spawn } from "node:child_process";
import { join } from "node:path";
import type { ToolAdapterResult } from "../tools/tool-registry.js";
import { buildChildEnv } from "./child-env.js";
import type { OmpConfig } from "./omp-config.js";
import type { PathContext } from "./protected-paths.js";

export interface ShellRunInput {
  command: string; cwd: string; profilePath: string; wrapperPath: string; env: Record<string, string>;
  timeoutMs: number; outputCapBytes: number; signal?: AbortSignal; sandbox: boolean;
}
export type ShellFailure = "timeout" | "output_cap" | "aborted" | "limits_failed" | "cleanup_failed" | "wrapper_unknown" | "spawn";
export interface ShellRunResult {
  status: "succeeded" | "failed"; exitCode: number | null; output: string; truncated: boolean;
  wrapperStatus: "ok" | "limits_failed" | "cleanup_failed" | "unknown"; reason?: ShellFailure;
}

const FAILED_BEFORE_SPAWN: ShellRunResult = { status: "failed", exitCode: null, output: "", truncated: false, wrapperStatus: "unknown", reason: "aborted" };

function parseStatus(raw: string): ShellRunResult["wrapperStatus"] {
  const lines = raw.split("\n").filter((l) => l.length > 0);
  if (lines.length !== 1) return "unknown";
  return lines[0] === "ok" || lines[0] === "limits_failed" || lines[0] === "cleanup_failed" ? lines[0] : "unknown";
}

export function runShell(input: ShellRunInput): Promise<ShellRunResult> {
  if (input.signal?.aborted) return Promise.resolve(FAILED_BEFORE_SPAWN);
  return new Promise((resolve) => {
    const env = { ...input.env, SB: input.profilePath, HOUGE_SHELL_SANDBOX: input.sandbox ? "1" : (input.env.HOUGE_SHELL_SANDBOX ?? "0") };
    const child = spawn("/bin/bash", [input.wrapperPath, input.command], { cwd: input.cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe", "pipe"] });
    let output = ""; let status = ""; let truncated = false; let forced: ShellFailure | undefined;
    let killer: ReturnType<typeof setInterval> | undefined;
    const killGroup = (why: ShellFailure) => {
      forced ??= why;
      const hit = () => { try { process.kill(-(child.pid as number), "SIGKILL"); } catch { /* group gone */ } };
      hit(); killer ??= setInterval(hit, 1000);
    };
    const onOut = (d: Buffer) => {
      if (output.length + d.length > input.outputCapBytes) { output += d.toString("utf8").slice(0, input.outputCapBytes - output.length); truncated = true; killGroup("output_cap"); }
      else output += d.toString("utf8");
    };
    child.stdout?.on("data", onOut); child.stderr?.on("data", onOut);
    (child.stdio[3] as NodeJS.ReadableStream | null)?.on("data", (d: Buffer) => { status += d.toString("utf8"); });
    const timer = setTimeout(() => killGroup("timeout"), input.timeoutMs);
    const onAbort = () => killGroup("aborted");
    input.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", () => { clearTimeout(timer); resolve({ ...FAILED_BEFORE_SPAWN, reason: "spawn" }); });
    child.on("close", (code) => {
      clearTimeout(timer); if (killer) clearInterval(killer);
      input.signal?.removeEventListener("abort", onAbort);
      resolve(settle(code, output, truncated, parseStatus(status), forced));
    });
  });
}

function settle(code: number | null, output: string, truncated: boolean, ws: ShellRunResult["wrapperStatus"], forced?: ShellFailure): ShellRunResult {
  const base = { exitCode: code, output, truncated, wrapperStatus: ws };
  if (forced) return { ...base, status: "failed", reason: forced };
  if (ws === "limits_failed") return { ...base, status: "failed", reason: "limits_failed" };
  if (ws === "cleanup_failed") return { ...base, status: "failed", reason: "cleanup_failed" };
  if (ws === "unknown") return { ...base, status: "failed", reason: "wrapper_unknown" };
  return { ...base, status: "succeeded" };
}

export function shellToolExecute(deps: {
  cfg: OmpConfig; ctx: PathContext; distDir: string; cwd: string;
  onIncident: (kind: string, detail: Record<string, unknown>) => void;
}): (input: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolAdapterResult> {
  return async (input, signal) => {
    const command = typeof input.command === "string" ? input.command : "";
    if (command.trim().length === 0) return { ok: false, error: "bash: command is required" };
    const r = await runShell({
      command, cwd: deps.cwd, profilePath: join(deps.ctx.data, "omp", "shell.sb"),
      wrapperPath: join(deps.distDir, "omp", "shell-wrapper.sh"), env: buildChildEnv(deps.cfg.envPassthrough),
      timeoutMs: deps.cfg.shellTimeoutMs, outputCapBytes: 32 * 1024, sandbox: deps.cfg.sandbox,
      ...(signal ? { signal } : {})
    });
    if (r.reason === "cleanup_failed" || r.reason === "wrapper_unknown") deps.onIncident(`shell_${r.reason}`, { exit_code: r.exitCode });
    if (r.status === "failed") return { ok: false, error: `bash ${r.reason}${r.output ? `\n${r.output}` : ""}` };
    return { ok: true, output: { exit_code: r.exitCode, output: r.output, truncated: r.truncated } };
  };
}
