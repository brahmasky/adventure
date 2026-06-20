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

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown error";
}
