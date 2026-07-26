import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";
import {
  buildChairArgs,
  buildCodexJudgeArgs,
  chairConfigDir,
  CHAIR_DEFAULT_TIMEOUT_MS,
  CODEX_JUDGE_DEFAULT_TIMEOUT_MS,
  SEAT_MAX_BYTES,
  spawnCodexJudge,
  spawnPanelChair
} from "../../src/capabilities/idea-panel-seats.js";
import { buildChildEnv, type SpawnImpl, type SpawnResult } from "../../src/llm/providers/cli-spawn.js";
import { createSecretBroker, type SecretBroker } from "../../src/config/secret-broker.js";

const FAKE_TOKEN = "sk-ant-oat01-fake-chair-token-987654";

function brokerWithToken(): SecretBroker {
  return createSecretBroker({ CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN } as NodeJS.ProcessEnv);
}

function brokerWithoutToken(): SecretBroker {
  return createSecretBroker({} as NodeJS.ProcessEnv);
}

function spawnResult(partial: Partial<SpawnResult> = {}): SpawnResult {
  return { code: 0, stdout: "", stderr: "", timedOut: false, ...partial };
}

/** stdout of `claude -p --output-format json` — the `result` field carries the assistant text. */
function chairJsonStdout(resultText: string): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: resultText,
    session_id: "fake-session"
  });
}

const DIGEST = "DATA:\n1. some card --system-prompt looks-like-a-flag";
const SYSTEM = "You are the panel chair. Output strict JSON.";

// The chair config dir is derived from os.homedir() — point it at a throwaway temp home so unit
// tests never touch the operator's real ~/.houge.
let fakeHome: string;

beforeEach(() => {
  fakeHome = mkdtempSync(join(os.tmpdir(), "houge-seats-home-"));
  vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("spawnPanelChair — contained claude CLI chair", () => {
  const CHAIR_ENV = { HOUGE_CLAUDE_BIN: "/usr/local/bin/claude" } as NodeJS.ProcessEnv;

  it("spawns the exact verified argv (v2.1.219) with the digest on stdin, never argv", async () => {
    const spawnImpl = vi.fn<SpawnImpl>(async () =>
      spawnResult({ stdout: chairJsonStdout('{"shortlist":[]}') })
    );

    const result = await spawnPanelChair({
      digest: DIGEST,
      system: SYSTEM,
      broker: brokerWithToken(),
      env: CHAIR_ENV,
      spawnImpl
    });

    expect(result).toEqual({ ok: true, answer: '{"shortlist":[]}' });
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const [file, args, opts] = spawnImpl.mock.calls[0]!;
    expect(file).toBe("/usr/local/bin/claude");
    // Exact-array assertion: every flag verified against `/usr/local/bin/claude` v2.1.219
    // (--help + live parse probe). --max-turns is hidden from --help but probe-accepted;
    // --mcp-config must be {"mcpServers":{}} (bare {} is rejected by 2.1.219).
    expect(args).toEqual([
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
      SYSTEM
    ]);
    expect(args).not.toContain(DIGEST);
    expect(opts.input).toBe(DIGEST); // untrusted digest rides stdin ONLY
    expect(opts.cwd).toBe(os.tmpdir());
    expect(opts.timeoutMs).toBe(CHAIR_DEFAULT_TIMEOUT_MS);
    expect(opts.maxBytes).toBe(SEAT_MAX_BYTES);
  });

  it("child env is EXACTLY the allowlist base + CLAUDE_CONFIG_DIR + CLAUDE_CODE_OAUTH_TOKEN", async () => {
    const spawnImpl = vi.fn<SpawnImpl>(async () =>
      spawnResult({ stdout: chairJsonStdout("x") })
    );

    await spawnPanelChair({
      digest: DIGEST,
      system: SYSTEM,
      broker: brokerWithToken(),
      env: CHAIR_ENV,
      spawnImpl
    });

    const [, , opts] = spawnImpl.mock.calls[0]!;
    const expectedKeys = [
      ...Object.keys(buildChildEnv(undefined)), // PATH/HOME/TERM/LANG/USER — whichever are set
      "CLAUDE_CONFIG_DIR",
      "CLAUDE_CODE_OAUTH_TOKEN"
    ].sort();
    expect(Object.keys(opts.env).sort()).toEqual(expectedKeys);
    expect(opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(FAKE_TOKEN);
    expect(opts.env.CLAUDE_CONFIG_DIR).toBe(join(fakeHome, ".houge", "claude-chair"));
    expect(opts.env.HOUGE_TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(opts.env.KIMI_API_KEY).toBeUndefined();
  });

  it("creates the isolated config dir with a tool-denying settings.json on first use", async () => {
    const spawnImpl = vi.fn<SpawnImpl>(async () =>
      spawnResult({ stdout: chairJsonStdout("x") })
    );

    await spawnPanelChair({
      digest: DIGEST,
      system: SYSTEM,
      broker: brokerWithToken(),
      env: CHAIR_ENV,
      spawnImpl
    });

    const settingsPath = join(fakeHome, ".houge", "claude-chair", "settings.json");
    expect(existsSync(settingsPath)).toBe(true);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      permissions: { allow: [], deny: ["*"] }
    });
  });

  it("HOUGE_CLAUDE_BIN unset/empty → unavailable, spawnImpl NEVER called", async () => {
    const spawnImpl = vi.fn<SpawnImpl>(async () => spawnResult());

    for (const env of [{}, { HOUGE_CLAUDE_BIN: "  " }] as NodeJS.ProcessEnv[]) {
      const result = await spawnPanelChair({
        digest: DIGEST,
        system: SYSTEM,
        broker: brokerWithToken(),
        env,
        spawnImpl
      });
      expect(result).toEqual({ ok: false, unavailable: true });
    }
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("broker token null → unavailable, spawnImpl NEVER called", async () => {
    const spawnImpl = vi.fn<SpawnImpl>(async () => spawnResult());

    const result = await spawnPanelChair({
      digest: DIGEST,
      system: SYSTEM,
      broker: brokerWithoutToken(),
      env: CHAIR_ENV,
      spawnImpl
    });

    expect(result).toEqual({ ok: false, unavailable: true });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("plumbs HOUGE_RADAR_CHAIR_TIMEOUT_MS through to the spawn", async () => {
    const spawnImpl = vi.fn<SpawnImpl>(async () =>
      spawnResult({ stdout: chairJsonStdout("x") })
    );

    await spawnPanelChair({
      digest: DIGEST,
      system: SYSTEM,
      broker: brokerWithToken(),
      env: { ...CHAIR_ENV, HOUGE_RADAR_CHAIR_TIMEOUT_MS: "5000" } as NodeJS.ProcessEnv,
      spawnImpl
    });

    expect(spawnImpl.mock.calls[0]![2].timeoutMs).toBe(5000);
  });

  it("ENOENT spawn error → unavailable", async () => {
    const spawnImpl = vi.fn<SpawnImpl>(async () =>
      spawnResult({ code: null, spawnError: { code: "ENOENT" } })
    );

    const result = await spawnPanelChair({
      digest: DIGEST,
      system: SYSTEM,
      broker: brokerWithToken(),
      env: CHAIR_ENV,
      spawnImpl
    });

    expect(result).toEqual({ ok: false, unavailable: true });
  });

  it("timeout → plain {ok:false} (never unavailable — the binary exists)", async () => {
    const spawnImpl = vi.fn<SpawnImpl>(async () =>
      spawnResult({ code: null, timedOut: true })
    );

    const result = await spawnPanelChair({
      digest: DIGEST,
      system: SYSTEM,
      broker: brokerWithToken(),
      env: CHAIR_ENV,
      spawnImpl
    });

    expect(result).toEqual({ ok: false });
  });

  it("malformed / non-result stdout → {ok:false}", async () => {
    const cases = [
      "not json at all",
      "{}",
      JSON.stringify({ type: "result", is_error: true, result: "refused" }),
      JSON.stringify({ type: "result", result: "" }),
      JSON.stringify({ type: "result", result: 42 })
    ];
    for (const stdout of cases) {
      const spawnImpl = vi.fn<SpawnImpl>(async () => spawnResult({ stdout }));
      const result = await spawnPanelChair({
        digest: DIGEST,
        system: SYSTEM,
        broker: brokerWithToken(),
        env: CHAIR_ENV,
        spawnImpl
      });
      expect(result).toEqual({ ok: false });
    }
  });

  it("non-zero exit → {ok:false}", async () => {
    const spawnImpl = vi.fn<SpawnImpl>(async () =>
      spawnResult({ code: 1, stdout: chairJsonStdout("x") })
    );

    const result = await spawnPanelChair({
      digest: DIGEST,
      system: SYSTEM,
      broker: brokerWithToken(),
      env: CHAIR_ENV,
      spawnImpl
    });

    expect(result).toEqual({ ok: false });
  });
});

describe("spawnCodexJudge — contained codex CLI judge", () => {
  const VERDICT = '{"scores":[{"card":1,"score":7,"reason":"ok"}]}';

  /** `codex exec` stdout is a session transcript — the echoed prompt (with its JSON answer
   *  template) comes FIRST, so any stdout parse would find the template, not the verdict. */
  const TRANSCRIPT = [
    "OpenAI Codex (session abc123)",
    "user instructions:",
    SYSTEM,
    DIGEST,
    'Answer as {"scores":[{"card":0,"score":0,"reason":"template"}]}',
    "thinking… tokens used: 1234"
  ].join("\n");

  /** Extract the `-o` outfile path the judge put on argv. */
  function outfileOf(args: readonly string[]): string {
    const i = args.indexOf("-o");
    expect(i).toBeGreaterThanOrEqual(0);
    return args[i + 1]!;
  }

  /** Spawn stub that behaves like the real codex: writes the final message to the
   *  argv-provided `-o` outfile (unless told not to) and emits transcript noise on stdout. */
  function codexSpawnStub(opts: { outfileContent?: string; writeOutfile?: boolean } = {}) {
    const write = opts.writeOutfile ?? true;
    return vi.fn<SpawnImpl>(async (_file, args) => {
      if (write) writeFileSync(outfileOf(args), opts.outfileContent ?? VERDICT);
      return spawnResult({ stdout: TRANSCRIPT });
    });
  }

  it("spawns `exec --sandbox read-only -o <outfile> -` and reads the OUTFILE, not stdout", async () => {
    const spawnImpl = codexSpawnStub();

    const result = await spawnCodexJudge({
      digest: DIGEST,
      system: SYSTEM,
      env: {} as NodeJS.ProcessEnv,
      spawnImpl
    });

    // The answer is the outfile verdict — never the transcript's echoed JSON template.
    expect(result).toEqual({ ok: true, answer: VERDICT });
    const [file, args, opts] = spawnImpl.mock.calls[0]!;
    expect(file).toBe("codex"); // resolveCodexBin default
    const outfile = outfileOf(args);
    expect(dirname(outfile)).toMatch(/houge-panel-codex-/);
    expect(args).toEqual(buildCodexJudgeArgs(outfile));
    expect(args).toEqual(["exec", "--sandbox", "read-only", "--skip-git-repo-check", "-o", outfile, "-"]);
    expect(args).not.toContain(DIGEST);
    // Prompt delivery mirrors coding-agent: trailing `-` + whole prompt (system, then digest)
    // on stdin — the untrusted digest is never an argv token.
    expect(opts.input).toBe(`${SYSTEM}\n\n${DIGEST}`);
    expect(opts.cwd).toBe(os.tmpdir());
    expect(opts.timeoutMs).toBe(CODEX_JUDGE_DEFAULT_TIMEOUT_MS);
    expect(opts.maxBytes).toBe(SEAT_MAX_BYTES);
    // The `-o` tempdir is cleaned up after a successful run.
    expect(existsSync(dirname(outfile))).toBe(false);
  });

  it("missing outfile (codex wrote nothing) and empty outfile → {ok:false}; tempdir still cleaned", async () => {
    const missing = codexSpawnStub({ writeOutfile: false });
    expect(
      await spawnCodexJudge({ digest: DIGEST, system: SYSTEM, env: {} as NodeJS.ProcessEnv, spawnImpl: missing })
    ).toEqual({ ok: false });
    expect(existsSync(dirname(outfileOf(missing.mock.calls[0]![1])))).toBe(false);

    const empty = codexSpawnStub({ outfileContent: "   \n" });
    expect(
      await spawnCodexJudge({ digest: DIGEST, system: SYSTEM, env: {} as NodeJS.ProcessEnv, spawnImpl: empty })
    ).toEqual({ ok: false });
    expect(existsSync(dirname(outfileOf(empty.mock.calls[0]![1])))).toBe(false);
  });

  it("oversized outfile (> SEAT_MAX_BYTES) → {ok:false}", async () => {
    const huge = codexSpawnStub({ outfileContent: "x".repeat(SEAT_MAX_BYTES + 1) });
    expect(
      await spawnCodexJudge({ digest: DIGEST, system: SYSTEM, env: {} as NodeJS.ProcessEnv, spawnImpl: huge })
    ).toEqual({ ok: false });
  });

  it("honors HOUGE_CODEX_BIN and HOUGE_CODEX_TIMEOUT_MS", async () => {
    const spawnImpl = codexSpawnStub();

    await spawnCodexJudge({
      digest: DIGEST,
      system: SYSTEM,
      env: {
        HOUGE_CODEX_BIN: "/opt/bin/codex",
        HOUGE_CODEX_TIMEOUT_MS: "9000"
      } as NodeJS.ProcessEnv,
      spawnImpl
    });

    const [file, , opts] = spawnImpl.mock.calls[0]!;
    expect(file).toBe("/opt/bin/codex");
    expect(opts.timeoutMs).toBe(9000);
  });

  it("child env is the bare buildChildEnv() allowlist — NO oauth token, NO secrets", async () => {
    const spawnImpl = codexSpawnStub();

    await spawnCodexJudge({
      digest: DIGEST,
      system: SYSTEM,
      env: {} as NodeJS.ProcessEnv,
      spawnImpl
    });

    const [, , opts] = spawnImpl.mock.calls[0]!;
    expect(Object.keys(opts.env).sort()).toEqual(Object.keys(buildChildEnv(undefined)).sort());
    expect(opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(opts.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(opts.env.KIMI_API_KEY).toBeUndefined();
  });

  it("ENOENT → unavailable; timeout → plain {ok:false}; tempdir cleaned on failure too", async () => {
    const enoent = vi.fn<SpawnImpl>(async () =>
      spawnResult({ code: null, spawnError: { code: "ENOENT" } })
    );
    expect(
      await spawnCodexJudge({ digest: DIGEST, system: SYSTEM, env: {} as NodeJS.ProcessEnv, spawnImpl: enoent })
    ).toEqual({ ok: false, unavailable: true });
    expect(existsSync(dirname(outfileOf(enoent.mock.calls[0]![1])))).toBe(false);

    const timedOut = vi.fn<SpawnImpl>(async () => spawnResult({ code: null, timedOut: true }));
    expect(
      await spawnCodexJudge({ digest: DIGEST, system: SYSTEM, env: {} as NodeJS.ProcessEnv, spawnImpl: timedOut })
    ).toEqual({ ok: false });
    expect(existsSync(dirname(outfileOf(timedOut.mock.calls[0]![1])))).toBe(false);
  });

  it("non-zero exit → {ok:false} even when the outfile carries a verdict (refusal posture)", async () => {
    const spawnImpl = vi.fn<SpawnImpl>(async (_file, args) => {
      writeFileSync(outfileOf(args), VERDICT);
      return spawnResult({ code: 2, stdout: "chatter" });
    });
    expect(
      await spawnCodexJudge({ digest: DIGEST, system: SYSTEM, env: {} as NodeJS.ProcessEnv, spawnImpl })
    ).toEqual({ ok: false });
  });
});

describe("chairConfigDir — constant, code-owned location", () => {
  it("is ~/.houge/claude-chair under the (stubbed) home dir, not env-configurable", () => {
    expect(chairConfigDir()).toBe(join(fakeHome, ".houge", "claude-chair"));
  });
});

describe("buildChairArgs", () => {
  it("never contains the digest and carries the system prompt as the final value", () => {
    const args = buildChairArgs("SYS");
    expect(args[args.length - 2]).toBe("--system-prompt");
    expect(args[args.length - 1]).toBe("SYS");
  });
});
