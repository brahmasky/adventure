import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolAdapterResult } from "../tools/tool-registry.js";
import { createWorktree, removeWorktree } from "../run/worktree.js";

/**
 * `coding_agent_cli` capability (ADR 0011, Phase 1 — code self-diagnose). Houge reads
 * his OWN source by delegating to Codex CLI **read-only**, in a fresh git worktree of
 * committed HEAD. This is a thin *tool* delegation (like web_search delegates to Tavily)
 * — not the runtime engine — so the cheap LLM chain still owns Houge's cognition (ADR 0010).
 *
 * Containment (ADR 0011 §5):
 *   - `codex exec --sandbox read-only` (Codex's own sandbox); NEVER a `--dangerously-bypass-*`
 *     flag — those are deliberately absent here.
 *   - A worktree of HEAD has only TRACKED files, so gitignored secrets are absent by
 *     construction, and the running daemon's tree is untouched.
 *   - `side_effect_level: "external_read"` — the one outward flow is Houge's own source
 *     going to OpenAI (inherent to Codex; Paco's code on Paco's subscription). A read,
 *     not a write — no `/approve` gate. The worktree is ALWAYS torn down (finally).
 */

const DEFAULT_CODEX_BIN = "codex";
const DEFAULT_CODEX_TIMEOUT_MS = 240_000;

export interface CodingAgentAdapterConfig {
  /** Absolute project root (a git repo) the worktree is cut from. */
  projectRoot: string;
  /** Injectable env for config resolution (tests). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Whether the read-only Codex consult is enabled (`HOUGE_CODEX_ENABLED`). Default OFF —
 * the selfcode branch degrades gracefully to a normal answer when this is not truthy, so
 * shipping the feature dark is safe. Accepts `1`/`true`/`yes`/`on` (case-insensitive).
 */
export function resolveCodexEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.HOUGE_CODEX_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/** Resolve the codex binary name/path (`HOUGE_CODEX_BIN`, default `codex`). */
export function resolveCodexBin(env: NodeJS.ProcessEnv): string {
  const bin = env.HOUGE_CODEX_BIN?.trim();
  return bin && bin.length > 0 ? bin : DEFAULT_CODEX_BIN;
}

/** Resolve the codex model override (`HOUGE_CODEX_MODEL`, default: unset → codex's own). */
export function resolveCodexModel(env: NodeJS.ProcessEnv): string | undefined {
  const model = env.HOUGE_CODEX_MODEL?.trim();
  return model && model.length > 0 ? model : undefined;
}

/** Resolve the codex wall-clock timeout in ms (`HOUGE_CODEX_TIMEOUT_MS`, default 240000). */
export function resolveCodexTimeoutMs(env: NodeJS.ProcessEnv): number {
  const n = Number(env.HOUGE_CODEX_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_CODEX_TIMEOUT_MS;
}

/**
 * Build the argv for a read-only codex consult. Exported so a test can assert the exact
 * flags (read-only sandbox, `-C <worktree>`, `-o <outfile>`, the model flag when set, and
 * the trailing `-` so the prompt is read from stdin). NEVER includes a bypass flag.
 */
export function buildCodexArgs(worktree: string, outfile: string, model?: string): string[] {
  const args = ["exec", "--sandbox", "read-only", "-C", worktree, "-o", outfile];
  if (model) {
    args.push("-m", model);
  }
  // Trailing `-`: instructions are read from stdin (the framed question).
  args.push("-");
  return args;
}

/**
 * Build the argv for a **write-mode** codex run (Phase 3 — code self-write, ADR 0011 §5/§6).
 * IDENTICAL to {@link buildCodexArgs} except the sandbox is `workspace-write` (Codex may edit
 * files) instead of `read-only`, confined to `-C <worktree>`. The diff lands only in the
 * throwaway worktree; the daemon's live tree is untouched (it becomes a branch for Paco to
 * merge, §5). NEVER includes a `--dangerously-bypass-*` / `--yolo` / `--skip-git-repo-check`
 * flag — those are deliberately absent (asserted in tests, as the read-only path).
 */
export function buildCodexWriteArgs(worktree: string, model?: string): string[] {
  const args = ["exec", "--sandbox", "workspace-write", "-C", worktree];
  if (model) {
    args.push("-m", model);
  }
  // Trailing `-`: the framed write task is read from stdin (the DATA channel).
  args.push("-");
  return args;
}

interface NodeError extends Error {
  code?: string;
  status?: number | null;
  signal?: string | null;
}

/**
 * Factory: returns a `ToolAdapter` that consults Codex read-only in a fresh worktree.
 * Input `{ question: string }` is the framed diagnosis prompt (symptom + context, all on
 * the DATA channel). Output `{ diagnosis, worktree, model, bin }` on success; a clean flat
 * error on non-zero exit / missing output / timeout / codex-not-found.
 */
export function createCodingAgentAdapter(
  config: CodingAgentAdapterConfig
): (input: Record<string, unknown>) => ToolAdapterResult {
  const env = config.env ?? process.env;

  return (input: Record<string, unknown>): ToolAdapterResult => {
    const question = input.question;
    if (typeof question !== "string" || question.trim().length === 0) {
      return { ok: false, error: "question must be a non-empty string" };
    }

    const bin = resolveCodexBin(env);
    const model = resolveCodexModel(env);
    const timeout = resolveCodexTimeoutMs(env);

    let worktree: string | undefined;
    let outDir: string | undefined;
    try {
      worktree = createWorktree(config.projectRoot).path;
    } catch (error) {
      // Worktree could not be created (git missing, not a repo) — nothing to clean up.
      return { ok: false, error: `Failed to create worktree: ${errorMessage(error)}` };
    }

    try {
      // The `-o` outfile lives outside the worktree so the read-only sandbox can't be
      // asked to write into its own root; codex writes the final message to it.
      outDir = mkdtempSync(join(tmpdir(), "houge-codex-out-"));
      const outfile = join(outDir, "last-message.txt");

      try {
        execFileSync(bin, buildCodexArgs(worktree, outfile, model), {
          input: question,
          timeout,
          stdio: ["pipe", "pipe", "pipe"]
        });
      } catch (error) {
        const err = error as NodeError;
        if (err.code === "ENOENT") {
          return {
            ok: false,
            error: `Coding agent binary not found: ${bin} (set HOUGE_CODEX_BIN or install codex)`
          };
        }
        if (err.signal === "SIGTERM" || err.code === "ETIMEDOUT") {
          return { ok: false, error: `Coding agent timed out after ${timeout}ms` };
        }
        const status = typeof err.status === "number" ? err.status : "unknown";
        return { ok: false, error: `Coding agent exited non-zero (status ${status}): ${errorMessage(error)}` };
      }

      let diagnosis: string;
      try {
        diagnosis = readFileSync(outfile, "utf8").trim();
      } catch {
        return { ok: false, error: "Coding agent produced no output file" };
      }
      if (diagnosis.length === 0) {
        return { ok: false, error: "Coding agent produced an empty diagnosis" };
      }

      return {
        ok: true,
        output: { diagnosis, worktree, model: model ?? "default", bin }
      };
    } finally {
      // ALWAYS tear down the worktree and the out dir, success or failure.
      if (worktree) removeWorktree(worktree);
      if (outDir) {
        try {
          rmSync(outDir, { recursive: true, force: true });
        } catch {
          // best-effort cleanup of the tmp out dir
        }
      }
    }
  };
}

export interface SelfWriteCodexConfig {
  /** The worktree the diff is written into. Created/torn-down by the orchestrator (the diff
   *  must outlive this call so the checker stack can inspect it), NOT here. */
  worktree: string;
  /** Injectable env for config resolution (tests). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Factory: returns an adapter that has Codex **write a diff** in `config.worktree`
 * (`--sandbox workspace-write`). Input `{ task: string }` is the framed write task on the
 * DATA channel (symptom + context + "you are EDITING Houge's OWN source"). Unlike the
 * read-only diagnose adapter, this does NOT create or tear down the worktree (the caller
 * owns it so the resulting diff survives for the checker stack) and there is no `-o` outfile
 * — the artifact is the modified files. Returns `{ ok:true, output:{ worktree, model, bin } }`
 * on success; a clean flat error on non-zero exit / timeout / codex-not-found. Reuses the
 * shared `resolveCodex*` resolvers.
 */
export function createSelfWriteCodexAdapter(
  config: SelfWriteCodexConfig
): (input: Record<string, unknown>) => ToolAdapterResult {
  const env = config.env ?? process.env;

  return (input: Record<string, unknown>): ToolAdapterResult => {
    const task = input.task;
    if (typeof task !== "string" || task.trim().length === 0) {
      return { ok: false, error: "task must be a non-empty string" };
    }

    const bin = resolveCodexBin(env);
    const model = resolveCodexModel(env);
    const timeout = resolveCodexTimeoutMs(env);

    try {
      execFileSync(bin, buildCodexWriteArgs(config.worktree, model), {
        input: task,
        timeout,
        cwd: config.worktree,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      const err = error as NodeError;
      if (err.code === "ENOENT") {
        return {
          ok: false,
          error: `Coding agent binary not found: ${bin} (set HOUGE_CODEX_BIN or install codex)`
        };
      }
      if (err.signal === "SIGTERM" || err.code === "ETIMEDOUT") {
        return { ok: false, error: `Coding agent timed out after ${timeout}ms` };
      }
      const status = typeof err.status === "number" ? err.status : "unknown";
      return { ok: false, error: `Coding agent exited non-zero (status ${status}): ${errorMessage(error)}` };
    }

    return { ok: true, output: { worktree: config.worktree, model: model ?? "default", bin } };
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown error";
}
