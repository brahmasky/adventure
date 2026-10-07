// Policy: single-shot, print-mode, env-allowlisted, killable `agy` (Antigravity CLI) inference is
// classified `external_read` (ungated), same as `pi`. agy is a GENERAL-model leg (Gemini Flash) for
// the research/answer surface, so it synthesizes prose without the coding-model over-production that
// blows pi's output cap. Unlike pi, agy takes the prompt as an ARGV value (`--print <prompt>`), not
// on stdin; this stays injection-safe because the prompt is a single, discrete argv element (Go's
// flag package consumes the token after `--print` as its literal value — it is never re-parsed as a
// flag).
//
// agy is AGENTIC and has no `--no-tools`. Since this leg now also serves the Dual-LLM quarantined
// reader (ADR 0014), the prompt can carry attacker-controlled external content. Containment:
//   - `--disable-slash-commands` so untrusted text can NEVER expand a slash command or skill;
//   - a FRESH, EMPTY, per-call working directory, removed afterwards, plus a minimal env
//     allowlist (no secrets);
//   - `--dangerously-skip-permissions` is NEVER passed, so headless tool requests hit agy's own
//     permission model and are auto-denied unless the operator has an explicit allow-rule.
// Tool use is deliberately permitted where the operator has allowed it; denied attempts are
// surfaced in the failure text so an injection attempt is visible rather than silent.
import { rm } from "node:fs/promises";
import { daemonMkdtemp, daemonTmpRoot, gitAncestor } from "../../run/daemon-tmp.js";
import path from "node:path";
import type { LlmProvider, LlmRequest, LlmResult } from "../types.js";
import { normalizeAgyUsage } from "../../run/llm-usage.js";
import { buildChildEnv, defaultSpawnImpl, type SpawnImpl, type SpawnResult } from "../../omp/child-env.js";
import { invalidateAgyVoiceModel, resolveAgyVoiceModel } from "./agy-models.js";

export const AGY_DEFAULT_TIMEOUT_MS = 60_000;
export const AGY_DEFAULT_MAX_BYTES = 262_144; // 256 KB — a general model won't over-produce; ample for prose.
export const AGY_BINARY = "agy";
/** The audit label when no model was passed and agy chose its own default (the listing failed). */
export const AGY_OWN_DEFAULT = "agy-default";

/**
 * Error markers that mean "this leg cannot serve right now" rather than "this request failed":
 * a retired/unknown model pin (the D1 regression) and auth walls. Mapped to `unavailable` so the
 * reason tag names the real cause. NOTE: `answerWithChain` falls through on BOTH `unavailable` and
 * plain `error`, so this classification is diagnostic, not control flow.
 */
const UNAVAILABLE_MARKERS = [
  "invalid model selection",
  "not logged in",
  "please log in",
  "/login",
  "no api key",
  "unauthenticated",
  "sign in"
];

/** Cap on provider-supplied error text echoed into `LlmResult.error` — bounded, single line. */
export const ERROR_EXCERPT_MAX = 200;

/** What the Gemini leg reads inline via `@file` (spike 2026-09-28: one turn, no tools). */
const AGY_MEDIA_MIMES: ReadonlySet<string> = new Set(["audio/ogg", "image/jpeg", "image/png"]);

// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

function stripAnsi(input: string): string {
  return input.replace(ANSI_REGEX, "");
}

function byteLength(input: string): number {
  return Buffer.byteLength(input, "utf8");
}

/** Flatten provider error prose to one bounded line — never a multi-line blob in a result. */
function errorExcerpt(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) return "";
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length > ERROR_EXCERPT_MAX ? `${flat.slice(0, ERROR_EXCERPT_MAX)}…` : flat;
}

/** Most denied-action names echoed into an error — the rest are elided, not concatenated. */
const DENIED_ACTIONS_MAX = 5;

/**
 * Names of tool actions agy auto-denied this turn (headless cannot prompt), for visibility.
 *
 * BOUNDED for the same reason {@link errorExcerpt} is, and more urgently: on the reader path the
 * model is being driven by attacker-controlled page content, so *which* tools it attempts — and
 * therefore this array's contents and length — is influenceable from outside. The joined result
 * reaches `LlmResult.error`, the chain's aggregate reason, and the planner transcript, so an
 * unbounded join would be a newline-forgery and log-flooding primitive.
 */
function deniedActionNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, DENIED_ACTIONS_MAX)
    .map((entry) =>
      typeof entry === "object" && entry !== null
        ? errorExcerpt((entry as Record<string, unknown>).action)
        : ""
    )
    .filter((name) => name.length > 0);
}

/** agy is never run with a cwd inside a git repo (round 2 N1): code-owned refusal, the chain treats it as unavailable. */
export const AGY_GIT_CWD_REFUSED = "agy refused: its working directory is inside a git repository";

export interface AgyCliProviderConfig {
  model?: string;
  timeoutMs?: number;
  maxBytes?: number;
  spawnImpl?: SpawnImpl;
}

/**
 * `agy --output-format json` prints ONE object on stdout (warnings go to stderr) and exits 0 even
 * when `status` is `ERROR` — so the envelope's `status`, not the exit code, is authoritative.
 * Returns `null` when stdout is not a JSON object (older binary, crash output), in which case the
 * caller falls back to exit-code classification.
 */
function parseAgyEnvelope(stdout: string): Record<string, unknown> | null {
  const text = stripAnsi(stdout).trim();
  if (text.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

function mediaReadLine(media: { path: string; mime: string }): string {
  const kind = media.mime.startsWith("audio/") ? "audio" : "image";
  return `The ${kind} is the file @${path.basename(media.path)} in the current directory. Open it with the view_file tool (the only tool you need); never run a shell command.`;
}

/** agy's answer to a model it no longer offers (status ERROR, exit 0). */
const INVALID_MODEL = "invalid model selection";
const isInvalidModel = (r: LlmResult): boolean => !r.ok && r.error.toLowerCase().includes(INVALID_MODEL);

export function createAgyCliProvider(config: AgyCliProviderConfig = {}): LlmProvider {
  const spawnImpl = config.spawnImpl ?? defaultSpawnImpl;

  return {
    name: "agy-cli",
    supportsMedia: (mime) => AGY_MEDIA_MIMES.has(mime),
    /**
     * No pinned version (2026-10-07): an explicit model, else HOUGE_AGY_MODEL, else the newest Gemini Flash low in
     * `agy models` (null: no --model, agy's own default). A RESOLVED model agy then refuses as retired is dropped from the
     * cache, excluded from later picks, and the call is retried once on a fresh resolution (or agy's own default); an
     * explicit or env model is the operator's and is not retried.
     */
    async answer(req: LlmRequest): Promise<LlmResult> {
      const binary = process.env.HOUGE_AGY_BIN ?? AGY_BINARY;
      const explicit = req.model ?? config.model ?? (process.env.HOUGE_AGY_MODEL?.trim() || undefined);
      if (explicit !== undefined) return answerWith(req, explicit);
      const resolved = await resolveAgyVoiceModel(binary, spawnImpl);
      const first = await answerWith(req, resolved);
      if (resolved === null || !isInvalidModel(first)) return first;
      invalidateAgyVoiceModel(resolved);
      // the refused name is excluded now: the retry runs on the next-best Flash low, or with no --model (agy's default)
      return answerWith(req, await resolveAgyVoiceModel(binary, spawnImpl));
    }
  };

  async function answerWith(req: LlmRequest, model: string | null): Promise<LlmResult> {
    const binary = process.env.HOUGE_AGY_BIN ?? AGY_BINARY;

    // The voice leg passes its own timeout (the media leg timeout); the old chain-wide
    // timeout knobs left with the chain (Task 14).
    const timeoutMs = config.timeoutMs ?? AGY_DEFAULT_TIMEOUT_MS;

    const maxBytes = config.maxBytes ?? AGY_DEFAULT_MAX_BYTES;

    // agy --print has no --system-prompt; the Houge-controlled persona is folded into the prompt
    // text (system first, then the question). The whole thing is ONE argv element — even if the
    // question looks like a flag, it is the literal value of `--print`, never re-parsed.
    // Multimodal ingest (spec 2026-09-29): a media call appends a code-owned line holding the
    // `@media.<ext>` reference and runs in the media dir (owned and removed by the caller) under
    // `--sandbox`. agy's `@` is NOT a client-side attachment: the model reads the file with its
    // auto-allowed, cwd-scoped `view_file` tool; `run_command` is auto-denied headless. Naming
    // the tool is what makes the read deterministic (probe 2026-09-29).
    const media = req.media;
    const prompt = [req.system, req.question, media ? mediaReadLine(media) : undefined]
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join("\n\n");
    const args = [
      ...(model ? ["--model", model] : []),
      // `--sandbox` is a boolean flag (agy --help, 2026-09-29): terminal restrictions for media
      // calls. Placed before --output-format so no value-taking flag can ever swallow `--print`.
      ...(media ? ["--sandbox"] : []),
      "--output-format",
      "json",
      // Untrusted external content reaches this prompt on the reader path; it must never be
      // able to expand a slash command or skill. Houge's own prompts use neither.
      "--disable-slash-commands",
      "--print",
      prompt
    ];

    // Minimal env (no secrets); agy reads its own auth from $HOME. Opt extra vars in via
    // HOUGE_AGY_ENV_PASSTHROUGH if a deployment stores agy auth in an env var.
    const env = { ...buildChildEnv(process.env.HOUGE_AGY_ENV_PASSTHROUGH), TMPDIR: daemonTmpRoot() };

    // A FRESH, EMPTY directory per text call — never the daemon temp root itself. agy is agentic and
    // roots its workspace at the cwd (`--add-dir` extends it), and the shared temp root is where
    // Houge keeps its own live state: coding-agent out dirs and media dirs (src/run/daemon-tmp.ts;
    // worktrees live beside it in <data>/selfwrite). Handing an agent
    // driven by attacker-controlled content a workspace rooted over Houge's own run state is a
    // read AND plant primitive; a per-call dir also means nothing survives between calls.
    // A media call instead runs in the media temp dir the ingest step created, so the relative
    // `@media.<ext>` resolves and cannot escape it; that dir is the caller's to remove.
    let workdir: string;
    if (media) {
      workdir = path.dirname(media.path);
    } else {
      try {
        workdir = await daemonMkdtemp("houge-agy-"); // the daemon temp root, never os.tmpdir() (B13)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, provider: "agy-cli", error: `agy workdir setup failed: ${message}` };
      }
    }

    // agy roots file access at its workspace; inside a git repo that may be the repo's top level, .env included (N1)
    if (gitAncestor(workdir) !== null) {
      if (!media) await rm(workdir, { recursive: true, force: true }).catch(() => {});
      return { ok: false, provider: "agy-cli", error: AGY_GIT_CWD_REFUSED, unavailable: true };
    }

    let result: SpawnResult;
    try {
      result = await spawnImpl(binary, args, {
        timeoutMs,
        cwd: workdir,
        env,
        maxBytes,
        input: "" // prompt is on argv, not stdin
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, provider: "agy-cli", error: `agy spawn failed: ${message}` };
    } finally {
      // Best-effort: a leaked temp dir must never fail an otherwise good answer. The media dir
      // is not ours to remove.
      if (!media) await rm(workdir, { recursive: true, force: true }).catch(() => {});
    }

    // Binary missing / spawn failure → unavailable (lets the chain fall through).
    if (result.spawnError?.code === "ENOENT") {
      return { ok: false, provider: "agy-cli", error: "agy binary not found (ENOENT)", unavailable: true };
    }
    if (result.spawnError) {
      return {
        ok: false,
        provider: "agy-cli",
        error: `agy spawn error: ${result.spawnError.code ?? "unknown"}`,
        unavailable: true
      };
    }

    // Our timeout is authoritative → normal failure (NOT unavailable).
    if (result.timedOut) {
      return { ok: false, provider: "agy-cli", error: `agy timed out after ${timeoutMs}ms` };
    }

    // Output bound: over-cap is an error, never a (possibly truncated) success.
    if (byteLength(result.stdout) > maxBytes) {
      return { ok: false, provider: "agy-cli", error: `agy output exceeded ${maxBytes} byte cap` };
    }

    const envelope = parseAgyEnvelope(result.stdout);

    // No parseable envelope: an auth wall (agy prints the prompt to stderr and nothing to
    // stdout), a renamed/removed flag, a binary predating --output-format json, or a crash mid-write.
    // stderr carries the ONLY cause here — dropping it is what would make the next D1-class
    // regression harder to diagnose than the last one, in the very change meant to make such
    // regressions visible. So: report a bounded excerpt, and still classify an auth wall as
    // unavailable even though no envelope reached us.
    if (!envelope) {
      const stderrExcerpt = errorExcerpt(stripAnsi(result.stderr));
      const unavailable =
        result.code !== 0 ||
        UNAVAILABLE_MARKERS.some((marker) => stderrExcerpt.toLowerCase().includes(marker));
      return {
        ok: false,
        provider: "agy-cli",
        error: `agy produced no JSON envelope (exit ${result.code ?? "null"})${
          stderrExcerpt ? `: ${stderrExcerpt}` : ""
        }`,
        ...(unavailable ? { unavailable: true } : {})
      };
    }

    const status = typeof envelope.status === "string" ? envelope.status : "";

    if (status !== "SUCCESS") {
      const excerpt = errorExcerpt(envelope.error);
      const unavailable = UNAVAILABLE_MARKERS.some((marker) => excerpt.toLowerCase().includes(marker));
      return {
        ok: false,
        provider: "agy-cli",
        error: `agy status ${status || "missing"}${excerpt ? `: ${excerpt}` : ""}`,
        ...(unavailable ? { unavailable: true } : {})
      };
    }

    // SUCCESS with an empty response is REAL — it is what agy returns when every tool call the
    // model attempted was auto-denied in headless mode. An empty answer is never a success.
    const answer = typeof envelope.response === "string" ? stripAnsi(envelope.response).trim() : "";
    if (answer.length === 0) {
      const denied = deniedActionNames(envelope.denied_actions);
      return {
        ok: false,
        provider: "agy-cli",
        error:
          denied.length > 0
            ? errorExcerpt(`agy produced no answer; tool actions denied: ${denied.join(", ")}`)
            : "agy produced no answer (empty response)"
      };
    }

    // Usage is normalized once and rides the result (slice 2); thinking stays inside output —
    // the normalizer reports it separately and never re-adds it. A missing block is not an error.
    const usage = normalizeAgyUsage(envelope.usage);

    return { ok: true, provider: "agy-cli", model: model ?? AGY_OWN_DEFAULT, answer, ...(usage ? { usage } : {}) };
  }
}
