import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveOmpConfig } from "../../src/omp/omp-config.js";
import { parseModelString } from "../../src/omp/model-string.js";
import { PlannerSession, plannerArgs } from "../../src/omp/planner-session.js";

const FAKE = new URL("../fixtures/fake-omp.mjs", import.meta.url).pathname;
const sessions: PlannerSession[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.stop();
  delete process.env.FAKE_OMP_SCENARIO; delete process.env.FAKE_OMP_ARGV_LOG;
});

function make(scenario: object = {}, env: Record<string, string> = {}) {
  const d = mkdtempSync(join(tmpdir(), "hps-"));
  writeFileSync(join(d, "sc.json"), JSON.stringify(scenario));
  process.env.FAKE_OMP_SCENARIO = join(d, "sc.json"); process.env.FAKE_OMP_ARGV_LOG = join(d, "argv.log");
  const cfg = resolveOmpConfig({ HOUGE_OMP_BIN: FAKE, HOUGE_OMP_SANDBOX: "0",
    HOUGE_OMP_ENV_PASSTHROUGH: "FAKE_OMP_SCENARIO,FAKE_OMP_ARGV_LOG", ...env });
  const s = new PlannerSession({ cfg, sessionDir: d, cwd: d, systemPromptFile: join(d, "sys.md"), extensions: ["/x/houge.js"],
    bridgeSock: join(d, "b.sock"), bridgeToken: "t", model: cfg.planner[0]!, configFile: join(d, "cfg.yml"), plannerProfile: join(d, "planner.sb") });
  sessions.push(s);
  return { s, d };
}

const base = { sessionDir: "/s", cwd: "/w", systemPromptFile: "/p.md", bridgeSock: "/b", bridgeToken: "t", configFile: "/c.yml" };

describe("PlannerSession — one long-lived RPC child per chat (spec §4, §7)", () => {
  it("starts, opens the session dir, and reports whether it resumed", async () => {
    const { s } = make();
    expect(await s.start()).toMatchObject({ resumed: false, sessionId: "s1" });
  });

  it("emits the turn's frames after prompt, ending with agent_end", async () => {
    const { s } = make();
    await s.start(); const types: string[] = []; s.onFrame((f) => types.push(f.type));
    await s.prompt("hi");
    await new Promise((r) => setTimeout(r, 200));
    expect(types).toEqual(expect.arrayContaining(["turn_start", "message_end", "agent_end"]));
  });

  it("never passes --no-ui/--no-session, loads exactly one extension entry, and always pins the profile and tool set", () => {
    const cfg = resolveOmpConfig({ HOUGE_OMP_BIN: "omp", HOUGE_OMP_SANDBOX: "1" });
    const { file, args } = plannerArgs({ ...base, cfg, extensions: ["/a/houge.js"], plannerProfile: "/planner.sb",
      model: parseModelString("anthropic/claude-opus-5-5:medium") });
    expect(file).toBe("sandbox-exec");
    expect(args.slice(0, 3)).toEqual(["-f", "/planner.sb", "omp"]);
    expect(args).not.toContain("--no-ui");
    expect(args).not.toContain("--no-session"); // open_session needs persistence
    expect(args.filter((a) => a === "-e")).toHaveLength(1); // omp cache-busts each -e import
    expect(args).toEqual(expect.arrayContaining(["--profile", "houge", "--mode", "rpc", "--tools", "read,edit,write", "--approval-mode", "yolo", "--thinking", "medium"]));
  });

  it("does not leak the bridge token or any daemon secret through argv", () => {
    const cfg = resolveOmpConfig({ HOUGE_OMP_BIN: "omp" });
    const { args } = plannerArgs({ ...base, cfg, extensions: [], bridgeToken: "SECRET-TOKEN", plannerProfile: "/p.sb",
      model: parseModelString("kimi-code/k3") });
    expect(args.join(" ")).not.toContain("SECRET-TOKEN");
  });

  it("setModel sends set_model then set_thinking_level, in that order — a fallback keeps the conversation", async () => {
    const { s, d } = make();
    await s.start(); await s.setModel(parseModelString("kimi-code/k3:low"));
    const cmds = readFileSync(join(d, "argv.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((x) => x.cmd).map((x) => x.cmd.type);
    expect(cmds).toEqual(["open_session", "set_model", "set_thinking_level"]);
  });

  it("rejects pending commands and fires onExit when the child dies mid-turn", async () => {
    const { s } = make({ "*": { rpcExitAfterPrompt: true } });
    await s.start(); let code: number | null | undefined; s.onExit((c) => { code = c; });
    await expect(s.prompt("hi")).rejects.toThrow(/exited/);
    await new Promise((r) => setTimeout(r, 300));
    expect(code).toBe(3);
  });

  it("stop() is idempotent and kills a hung child within 5 s", async () => {
    const { s } = make({ "*": { rpcHangAfterPrompt: true } });
    await s.start(); await s.prompt("hi");
    const t0 = Date.now(); await s.stop(); await s.stop();
    expect(Date.now() - t0).toBeLessThan(6_000);
  });
});
