// Idea Radar R2 panel seats (ADR 0027, spec §§1–2): TWO contained spawn legs — the claude CLI
// "chair" and the codex CLI "buildability judge". Panel-local by design: NEITHER seat joins the
// LLM registry / `buildLlmChain` (`answerWithChain` never sees them); only `runIdeaPanelTick`
// invokes them, so the ADR 0010 "Claude is never the engine" amendment stays narrow.
//
// Containment posture mirrors the pi provider leg: `defaultSpawnImpl` (never-reject, our own
// SIGKILL timeout, hard stdout byte cap), untrusted digest on STDIN ONLY (never argv),
// `buildChildEnv()` allowlist base, neutral `os.tmpdir()` cwd.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import {
  buildChildEnv,
  defaultSpawnImpl,
  type SpawnImpl,
  type SpawnResult
} from "../llm/providers/cli-spawn.js";
import { resolveCodexBin } from "./coding-agent.js";
import type { SecretBroker } from "../config/secret-broker.js";
import type { LlmAuditSink } from "../llm/audit.js";
import { normalizeCodexUsage, type LlmUsage } from "../run/llm-usage.js";

/**
 * Both seats resolve to this total shape — a seat NEVER throws into the panel tick. `usage` /
 * `model` / `timedOut` are telemetry-only extras consumed by {@link recordSeat}; the panel tick
 * reads `ok` / `answer` / `unavailable` alone.
 */
export type SeatResult =
  | { ok: true; answer: string; usage?: LlmUsage; model?: string }
  | { ok: false; unavailable?: boolean; timedOut?: true };

/** Default chair wall-clock timeout (`HOUGE_RADAR_CHAIR_TIMEOUT_MS` overrides). */
export const CHAIR_DEFAULT_TIMEOUT_MS = 120_000;
/** Default codex-judge wall-clock timeout (`HOUGE_CODEX_TIMEOUT_MS` overrides). */
export const CODEX_JUDGE_DEFAULT_TIMEOUT_MS = 120_000;
/** Hard stdout byte cap for both seats (the pi leg's 256 KB bound). */
export const SEAT_MAX_BYTES = 262_144;

function numericEnv(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// ---------------------------------------------------------------------------------------------
// Audit (slice 2): the seats live OUTSIDE the chain, so `answerWithChain` never sees them — each
// seat records its own `llm_attempt` at the spawn site through the same required sink.
// ---------------------------------------------------------------------------------------------

/**
 * claude `--output-format json` usage block → {@link LlmUsage}. Cache read + cache creation both
 * count as cached input (neither is billed at the full input rate). Malformed → undefined.
 */
function extractChairUsage(stdout: string): LlmUsage | undefined {
  try {
    const obj = JSON.parse(stdout.trim()) as Record<string, unknown>;
    const u = obj.usage as Record<string, unknown> | undefined;
    if (!u || typeof u !== "object") return undefined;
    const n = (v: unknown): number =>
      typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
    return {
      input_tokens: n(u.input_tokens),
      output_tokens: n(u.output_tokens),
      cached_input_tokens: n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens)
    };
  } catch {
    return undefined;
  }
}

/**
 * One attempt per seat spawn — ok / error / unavailable — recorded finally-style so a seat that
 * never produced usage (or never spawned) still leaves a row (review W7 / codex #13). Never
 * throws: the sink is best-effort by contract, and a seat must not fail the tick over telemetry.
 */
function recordSeat(audit: LlmAuditSink, provider: string, result: SeatResult, latency_ms: number): void {
  try {
    if (result.ok) {
      audit.record({
        provider,
        role: "", // the scoped store sink fills the role
        outcome: "ok",
        latency_ms,
        model: result.model ?? provider,
        ...(result.usage ? { usage: result.usage } : {})
      });
    } else {
      audit.record({
        provider,
        role: "",
        outcome: result.unavailable ? "unavailable" : "error",
        latency_ms,
        error_kind: result.unavailable ? "spawn" : result.timedOut ? "timeout" : "other"
      });
    }
  } catch (error) {
    console.warn(
      `[panel-seat] audit sink failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Chair: claude CLI, single-shot, tools disabled, isolated config dir, broker-injected OAuth.
// ---------------------------------------------------------------------------------------------

/**
 * Code-owned chair config dir: `~/.houge/claude-chair` — a CONSTANT path (not env-configurable,
 * spec §2) so the chair can never be pointed at the operator's `~/.claude` (skills, hooks, MCP
 * servers must be unreachable). Resolved lazily via `os.homedir()` so tests can stub it.
 */
export function chairConfigDir(): string {
  return join(os.homedir(), ".houge", "claude-chair");
}

/**
 * Minimal `settings.json` written into the chair config dir on first use: empty allow list plus
 * a deny-all pattern, no hooks, no MCP servers, no plugins — pure defense-in-depth behind the
 * argv-level `--tools ""` (which is the real lever: it disables the whole built-in tool set).
 */
const CHAIR_SETTINGS_JSON = '{"permissions":{"allow":[],"deny":["*"]}}\n';

/** mkdir + settings.json on first use; returns false when the dir can't be prepared. */
function ensureChairConfigDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    const settingsPath = join(dir, "settings.json");
    if (!existsSync(settingsPath)) {
      writeFileSync(settingsPath, CHAIR_SETTINGS_JSON, "utf8");
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Chair argv — every flag verified against the PINNED binary `/usr/local/bin/claude` v2.1.219
 * (`--help` + a live parse probe with a throwaway `CLAUDE_CONFIG_DIR`; unknown options are hard
 * errors in `-p` mode — `error: unknown option`, no API call — so a wrong flag can't silently
 * degrade; live gate step 0 re-verifies on the deploy host):
 *   - `-p, --print`            — non-interactive, print response and exit.
 *   - `--output-format json`   — "json (single result)": ONE JSON object on stdout whose
 *                                `result` string field carries the assistant text and whose
 *                                `is_error` flags failure (probe-verified shape).
 *   - `--max-turns 1`          — accepted by the parser (hidden from `--help` in 2.1.219 but
 *                                probe-verified); belt-and-braces on top of the tool disable.
 *   - `--tools ""`             — 'Use "" to disable all tools' (built-in set) — the real lever.
 *   - `--strict-mcp-config`    — only `--mcp-config` servers, ignoring all other MCP config.
 *   - `--mcp-config {"mcpServers":{}}` — the empty server set. NOTE: bare `{}` is REJECTED by
 *                                2.1.219 ("mcpServers: Invalid input: expected record").
 *   - `--system-prompt <s>`    — Houge-controlled discipline (never the untrusted digest).
 * The untrusted digest goes on STDIN, never argv.
 */
export function buildChairArgs(system: string): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--max-turns",
    "1",
    "--tools",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--system-prompt",
    system
  ];
}

export interface ChairParams {
  /** Untrusted card digest — delivered on stdin ONLY. */
  digest: string;
  /** Houge-controlled system discipline (safe as an argv value, like the pi leg). */
  system: string;
  /** The chair's OAuth token comes from the broker — never from ambient `process.env`. */
  broker: SecretBroker;
  /** Config env (bin path, timeout override) — injectable for tests. */
  env: NodeJS.ProcessEnv;
  /** Required audit chokepoint (slice 2): one `llm_attempt` per spawn, every outcome. */
  audit: LlmAuditSink;
  spawnImpl?: SpawnImpl;
}

/**
 * Parse `--output-format json` stdout: a single JSON object whose `result` field (string) is the
 * assistant text. Anything else — malformed JSON, missing/empty `result`, `is_error: true` —
 * is a plain failure (the tick falls back to mean-score synthesis).
 */
function extractChairAnswer(stdout: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  if (obj.is_error === true) return undefined;
  if (typeof obj.result !== "string" || obj.result.length === 0) return undefined;
  return obj.result;
}

/**
 * Spawn the contained claude chair (spec §2). Unavailable (no spawn attempted) when
 * `HOUGE_CLAUDE_BIN` is unset/empty — an absolute path is required (launchd PATH won't have
 * `claude`; DAEMON_PATH precedent) — or when the broker holds no OAuth token. ENOENT at spawn
 * time is likewise `unavailable`; timeout / non-zero exit / overflow / parse failure are plain
 * `{ok:false}` — the panel publishes either way via the deterministic fallback.
 */
export async function spawnPanelChair(params: ChairParams): Promise<SeatResult> {
  const t0 = Date.now();
  const result = await spawnPanelChairInner(params);
  recordSeat(params.audit, "claude", result, Date.now() - t0);
  return result;
}

async function spawnPanelChairInner(params: ChairParams): Promise<SeatResult> {
  const spawnImpl = params.spawnImpl ?? defaultSpawnImpl;

  const bin = params.env.HOUGE_CLAUDE_BIN?.trim();
  if (!bin) return { ok: false, unavailable: true };

  const token = params.broker.claudeOauthToken();
  if (token === null || token.length === 0) return { ok: false, unavailable: true };

  const configDir = chairConfigDir();
  if (!ensureChairConfigDir(configDir)) return { ok: false };

  const timeoutMs = numericEnv(params.env.HOUGE_RADAR_CHAIR_TIMEOUT_MS, CHAIR_DEFAULT_TIMEOUT_MS);

  // buildChildEnv() allowlist base (PATH/HOME/TERM/LANG/USER) + EXACTLY two additions: the
  // isolated config dir and the broker-held OAuth token. No bot token, no API keys (spec §2).
  const env: Record<string, string> = {
    ...buildChildEnv(undefined),
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_OAUTH_TOKEN: token
  };

  let result: SpawnResult;
  try {
    result = await spawnImpl(bin, buildChairArgs(params.system), {
      timeoutMs,
      cwd: os.tmpdir(),
      env,
      maxBytes: SEAT_MAX_BYTES,
      input: params.digest // untrusted digest: stdin ONLY, never argv
    });
  } catch {
    // defaultSpawnImpl never rejects; a rejecting injected impl still must not throw upward.
    return { ok: false };
  }

  if (result.spawnError?.code === "ENOENT") return { ok: false, unavailable: true };
  if (result.spawnError) return { ok: false, unavailable: true };
  if (result.timedOut) return { ok: false, timedOut: true };
  if (Buffer.byteLength(result.stdout, "utf8") > SEAT_MAX_BYTES) return { ok: false };
  if (result.code !== 0) return { ok: false };

  const answer = extractChairAnswer(result.stdout);
  if (answer === undefined) return { ok: false };
  const usage = extractChairUsage(result.stdout);
  return { ok: true, answer, model: "claude", ...(usage ? { usage } : {}) };
}

// ---------------------------------------------------------------------------------------------
// Codex judge: codex CLI, read-only sandbox, no secrets at all.
// ---------------------------------------------------------------------------------------------

/**
 * Codex judge argv — mirrors the coding-agent containment idiom (`buildCodexArgs`,
 * coding-agent.ts): `exec --sandbox read-only` with a trailing `-` so the prompt is read from
 * STDIN (never a bypass flag, never the digest on argv). No `-C` (neutral `os.tmpdir()` cwd —
 * the judge reads no repo). The `-o <outfile>` carries the FINAL message only: codex stdout is
 * a session transcript (banner + echoed prompt + thinking + counts), so parsing stdout both
 * dead-seats the judge (the echoed prompt's JSON template is the first balanced `{…}`) and
 * opens verdict forgery (a hostile card summary containing a valid `{"scores":[…]}` the model
 * quotes back). The outfile lives outside any sandbox path, like coding-agent's.
 * `--skip-git-repo-check` is required BECAUSE of the neutral cwd: codex exec refuses to run
 * outside a trusted/git directory (live-gate finding 2026-07-27) — coding-agent never hits this
 * since it runs `-C <worktree>` inside a repo. The flag only skips the cwd trust prompt; the
 * read-only sandbox is unchanged.
 */
export function buildCodexJudgeArgs(outfile: string): string[] {
  // `--json` + `-o` combine (live-probed 2026-09-06): the outfile still carries the final message,
  // stdout carries the JSONL stream `normalizeCodexUsage` reads for the attempt row.
  return ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "--json", "-o", outfile, "-"];
}

export interface CodexJudgeParams {
  /** Untrusted card digest — delivered on stdin ONLY. */
  digest: string;
  /** Houge-controlled framing; joined ahead of the digest on stdin (codex exec has no system-prompt flag). */
  system: string;
  env: NodeJS.ProcessEnv;
  /** Required audit chokepoint (slice 2): one `llm_attempt` per spawn, every outcome. */
  audit: LlmAuditSink;
  spawnImpl?: SpawnImpl;
}

/**
 * Spawn the contained codex judge (spec §1). Env is `buildChildEnv()` ONLY — codex authenticates
 * via its own subscription state in `$HOME` and gets none of our secrets (no broker parameter on
 * purpose: this seat cannot leak what it never receives). Missing binary (ENOENT) →
 * `unavailable`; everything else degrades to `{ok:false}` and the quorum rule decides.
 */
export async function spawnCodexJudge(params: CodexJudgeParams): Promise<SeatResult> {
  const t0 = Date.now();
  const result = await spawnCodexJudgeInner(params);
  recordSeat(params.audit, "codex", result, Date.now() - t0);
  return result;
}

async function spawnCodexJudgeInner(params: CodexJudgeParams): Promise<SeatResult> {
  const spawnImpl = params.spawnImpl ?? defaultSpawnImpl;

  const bin = resolveCodexBin(params.env);
  const timeoutMs = numericEnv(params.env.HOUGE_CODEX_TIMEOUT_MS, CODEX_JUDGE_DEFAULT_TIMEOUT_MS);

  // Prompt delivery per the coding-agent contract: the WHOLE prompt (framing + digest) goes to
  // stdin behind the trailing `-` argv token — the untrusted digest is never an argv value.
  const input = `${params.system}\n\n${params.digest}`;

  // Fresh `-o` outfile in a tempdir OUTSIDE any sandbox path (coding-agent's outDir idiom) —
  // the read-only sandbox can't be asked to write into its own root, and only the outfile
  // content (codex's final message) counts as the answer; stdout is never the answer — it is
  // only scanned by `normalizeCodexUsage` for token-usage events (telemetry, slice 2).
  let outDir: string;
  try {
    outDir = mkdtempSync(join(os.tmpdir(), "houge-panel-codex-"));
  } catch {
    return { ok: false };
  }
  const outfile = join(outDir, "verdict.txt");

  try {
    let result: SpawnResult;
    try {
      result = await spawnImpl(bin, buildCodexJudgeArgs(outfile), {
        timeoutMs,
        cwd: os.tmpdir(),
        env: buildChildEnv(undefined),
        maxBytes: SEAT_MAX_BYTES,
        input
      });
    } catch {
      return { ok: false };
    }

    if (result.spawnError?.code === "ENOENT") return { ok: false, unavailable: true };
    if (result.spawnError) return { ok: false, unavailable: true };
    if (result.timedOut) return { ok: false, timedOut: true };
    if (result.code !== 0) return { ok: false };

    // The answer is the outfile, never stdout. Missing/unreadable → the seat just failed.
    let raw: string;
    try {
      raw = readFileSync(outfile, "utf8");
    } catch {
      return { ok: false };
    }
    if (Buffer.byteLength(raw, "utf8") > SEAT_MAX_BYTES) return { ok: false };

    const answer = raw.trim();
    if (answer.length === 0) return { ok: false };
    // The judge passes no `-m`, so codex's own default model serves — "default" is the honest
    // label (not `HOUGE_CODEX_MODEL`, which this seat deliberately does not honor).
    const usage = normalizeCodexUsage(result.stdout);
    return { ok: true, answer, model: "default", ...(usage ? { usage } : {}) };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}
