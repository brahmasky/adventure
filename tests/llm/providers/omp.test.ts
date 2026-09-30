// tests/llm/providers/omp.test.ts
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OMP_ENV_VARS, resolveOmpConfig } from "../../../src/omp/omp-config.js";
import { parseModelChain } from "../../../src/omp/model-string.js";
import { LEG_EXIT_GRACE_MS, spawnOneShot } from "../../../src/llm/providers/omp.js";
import { recordingSink } from "../../helpers/llm-audit.js";

const FAKE = new URL("../../fixtures/fake-omp.mjs", import.meta.url).pathname;
const saved: Record<string, string | undefined> = {};
let dir: string;
beforeEach(() => {
  for (const k of [...OMP_ENV_VARS, "FAKE_OMP_SCENARIO", "FAKE_OMP_ARGV_LOG"]) { saved[k] = process.env[k]; delete process.env[k]; }
  dir = mkdtempSync(join(tmpdir(), "houge-omp-oneshot-"));
});
afterEach(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

function setup(scenario: object) {
  const sc = join(dir, "scenario.json");
  writeFileSync(sc, JSON.stringify(scenario));
  process.env.FAKE_OMP_SCENARIO = sc;
  process.env.FAKE_OMP_ARGV_LOG = join(dir, "argv.log");
  return resolveOmpConfig({ HOUGE_OMP_BIN: FAKE, HOUGE_OMP_SANDBOX: "0", HOUGE_OMP_ENV_PASSTHROUGH: "FAKE_OMP_SCENARIO,FAKE_OMP_ARGV_LOG" });
}
const argvLog = () => readFileSync(join(dir, "argv.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

describe("omp one-shot seat — every non-planner LLM call in Houge", () => {
  it("returns the first leg's answer and writes exactly one ok audit row with family and request_key", async () => {
    const cfg = setup({ "google-antigravity/gemini-3.8-flash": { text: "digest ok" } });
    const audit = recordingSink();
    const r = await spawnOneShot(
      { seat: "reader", chain: cfg.reader, prompt: "summarise", correlationId: "tick:test:1" },
      { cfg, audit, versionCheck: () => ({ ok: true, version: "18.4.4" }) }
    );
    expect(r).toMatchObject({ ok: true, answer: "digest ok", provider: "google-antigravity" });
    expect(audit.attempts).toHaveLength(1);
    expect(audit.attempts[0]).toMatchObject({ outcome: "ok", family: "gemini", request_key: "tick:test:1:0", credential_id: 1 });
  });

  it("falls through a quota failure to the next leg and audits both — a dead leg must be visible, not silent", async () => {
    const cfg = setup({
      "google-antigravity/gemini-3.8-flash": { text: "", stopReason: "error", errorMessage: "429 usage limit reached" },
      "kimi-code/k3": { text: "from kimi" }
    });
    const audit = recordingSink();
    const r = await spawnOneShot({ seat: "reader", chain: cfg.reader, prompt: "x", correlationId: "c" }, { cfg, audit, versionCheck: () => ({ ok: true, version: "18.4.4" }) });
    expect(r).toMatchObject({ ok: true, answer: "from kimi" });
    expect(audit.attempts.map((a) => [a.outcome, a.error_kind])).toEqual([["error", "quota"], ["ok", undefined]]);
  });

  it.each([
    ["model_refusal", "the request was blocked: refusal"],
    ["other", "the model returned something unexpected"]
  ])("stops the chain on a %s failure — a later leg must never silently answer what this seat refused (spec §8, B8)", async (kind, errorMessage) => {
    const cfg = setup({
      "google-antigravity/gemini-3.8-flash": { text: "", stopReason: "error", errorMessage },
      "kimi-code/k3": { text: "from kimi" }
    });
    const audit = recordingSink();
    const r = await spawnOneShot({ seat: "reader", chain: cfg.reader, prompt: "x", correlationId: "c" }, { cfg, audit, versionCheck: () => ({ ok: true, version: "18.4.4" }) });
    expect(r.ok).toBe(false);
    expect(audit.attempts.map((a) => [a.model, a.error_kind])).toEqual([["gemini-3.8-flash", kind]]);
    expect(argvLog()).toHaveLength(1);
  });

  it("classifies a bad model from stderr when omp exits 1 with empty stdout, then the next leg serves", async () => {
    const cfg = setup({
      "google-antigravity/gemini-3.8-flash": { exit: 1, stderr: 'Model "x" not found' },
      "kimi-code/k3": { text: "from kimi" }
    });
    const audit = recordingSink();
    const r = await spawnOneShot({ seat: "reader", chain: cfg.reader, prompt: "x", correlationId: "c" }, { cfg, audit, versionCheck: () => ({ ok: true, version: "18.4.4" }) });
    expect(r).toMatchObject({ ok: true, answer: "from kimi" });
    expect(audit.attempts.map((a) => [a.outcome, a.error_kind])).toEqual([["error", "model_missing"], ["ok", undefined]]);
  });

  it("falls through a model omp refuses at process start (live 18.4.4 stderr: Model \"…\" not found + hint) to the next leg", async () => {
    const cfg = setup({ rpcBadModelAtStart: ["google-antigravity/gemini-3.8-flash"], "kimi-code/k3": { text: "from kimi" } });
    const audit = recordingSink();
    const r = await spawnOneShot({ seat: "reader", chain: cfg.reader, prompt: "x", correlationId: "c" }, { cfg, audit, versionCheck: () => ({ ok: true, version: "18.4.4" }) });
    expect(r).toMatchObject({ ok: true, answer: "from kimi" });
    expect(audit.attempts.map((a) => [a.model, a.outcome, a.error_kind])).toEqual([["gemini-3.8-flash", "error", "model_missing"], ["k3", "ok", undefined]]);
  });

  it("delivers the prompt on stdin, never argv, and disables every tool and extension", async () => {
    const cfg = setup({ "*": { text: "ok" } });
    await spawnOneShot({ seat: "ticks", chain: cfg.ticks, prompt: "--help me", correlationId: "c" }, { cfg, audit: recordingSink(), versionCheck: () => ({ ok: true, version: "18.4.4" }) });
    const [call] = argvLog();
    expect(call.stdin).toBe("--help me");
    expect(call.argv).not.toContain("--help me");
    for (const f of ["-p", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-rules"]) expect(call.argv).toContain(f);
    expect(call.argv.slice(call.argv.indexOf("--profile"), call.argv.indexOf("--profile") + 2)).toEqual(["--profile", "houge"]);
  });

  it("marks family_collapse on a reader leg that shares the planner's family (D10: proceed, but audited)", async () => {
    const cfg = setup({ "*": { text: "ok" } });
    const audit = recordingSink();
    await spawnOneShot(
      { seat: "reader", chain: parseModelChain("kimi-code/k3"), prompt: "x", correlationId: "c", plannerFamily: "kimi" },
      { cfg, audit, versionCheck: () => ({ ok: true, version: "18.4.4" }) }
    );
    expect(audit.attempts[0]).toMatchObject({ outcome: "ok", family_collapse: true });
  });

  it("refuses every leg when the omp version is not the pinned one", async () => {
    const cfg = setup({ "*": { text: "ok" } });
    const r = await spawnOneShot({ seat: "reader", chain: cfg.reader, prompt: "x", correlationId: "c" },
      { cfg, audit: recordingSink(), versionCheck: () => ({ ok: false, kind: "version_mismatch" as const, version: "18.5.0", reason: "omp 18.5.0 is not the pinned 18.4.4" }) });
    expect(r).toMatchObject({ ok: false, unavailable: true });
  });

  it("times out a hung leg and moves on", async () => {
    const cfg = setup({ "google-antigravity/gemini-3.8-flash": { sleepMs: 5_000, text: "late" }, "kimi-code/k3": { text: "on time" } });
    const audit = recordingSink();
    const r = await spawnOneShot({ seat: "reader", chain: cfg.reader, prompt: "x", correlationId: "c", timeoutMs: 300 }, { cfg, audit, versionCheck: () => ({ ok: true, version: "18.4.4" }) });
    expect(r).toMatchObject({ ok: true, answer: "on time" });
    expect(audit.attempts[0]).toMatchObject({ outcome: "error", error_kind: "timeout" });
  });

  /** A fake omp that leaves a grandchild holding its stdout (a lingering helper); the grandchild writes its pid. */
  function lingeringBin(body: string): { cfg: ReturnType<typeof resolveOmpConfig>; pidFile: string } {
    const bin = join(dir, "omp-linger.sh"); const pidFile = join(dir, "helper.pid");
    writeFileSync(bin, `#!/bin/sh\nsleep 30 &\necho $! > '${pidFile}'\ncat >/dev/null\n${body}\n`); chmodSync(bin, 0o755);
    return { cfg: resolveOmpConfig({ HOUGE_OMP_BIN: bin, HOUGE_OMP_SANDBOX: "0" }), pidFile };
  }
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const ANSWER = `echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"stopReason":"stop","model":"k3","provider":"kimi-code"}}'`;

  it("settles on omp's exit plus a bounded grace when a helper still holds stdout — the poll loop is never frozen by it (B11)", async () => {
    const { cfg, pidFile } = lingeringBin(`${ANSWER}\nexit 0`);
    const t0 = Date.now();
    const r = await spawnOneShot({ seat: "ticks", chain: parseModelChain("kimi-code/k3"), prompt: "x", correlationId: "c", timeoutMs: 5_000 },
      { cfg, audit: recordingSink(), versionCheck: () => ({ ok: true, version: "18.4.4" }) });
    expect(Date.now() - t0).toBeLessThan(LEG_EXIT_GRACE_MS + 4_000); // the helper lives 30 s
    expect(r).toMatchObject({ ok: true, answer: "ok" });
    const pid = Number(readFileSync(pidFile, "utf8"));
    await new Promise((res) => setTimeout(res, 100));
    expect(alive(pid)).toBe(false); // the helper that held the pipe was killed with omp's process group
  });

  it("a hung leg is bounded by timeout plus grace and its whole process group is killed (B11)", async () => {
    const { cfg, pidFile } = lingeringBin("sleep 30");
    const t0 = Date.now();
    const audit = recordingSink();
    const r = await spawnOneShot({ seat: "ticks", chain: parseModelChain("kimi-code/k3"), prompt: "x", correlationId: "c", timeoutMs: 2_000 },
      { cfg, audit, versionCheck: () => ({ ok: true, version: "18.4.4" }) });
    expect(Date.now() - t0).toBeLessThan(2_000 + LEG_EXIT_GRACE_MS + 3_000); // the leg sleeps 30 s
    expect(r.ok).toBe(false);
    expect(audit.attempts[0]).toMatchObject({ outcome: "error", error_kind: "timeout" });
    expect(existsSync(pidFile)).toBe(true);
    await new Promise((res) => setTimeout(res, 100));
    expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
  });
});
