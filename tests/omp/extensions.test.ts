import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeServer } from "../../src/omp/bridge-server.js";
import { resetBridgeForTest } from "../../src/omp/extension/bridge-client.js";
import type { BridgeRequest } from "../../src/omp/bridge-protocol.js";

let server: BridgeServer; const seen: BridgeRequest[] = [];
beforeEach(async () => {
  resetBridgeForTest(); // the client is a process singleton: never carry a socket to a closed server across tests
  seen.length = 0;
  const sock = join(mkdtempSync(join(tmpdir(), "hx-")), "b.sock");
  process.env.HOUGE_BRIDGE_SOCK = sock; process.env.HOUGE_BRIDGE_TOKEN = "t";
  server = await BridgeServer.listen(sock, "t", async (req) => {
    seen.push(req);
    if (req.kind === "manifest") return [{ name: "bash", description: "run", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }];
    if (req.kind === "call") return { content: "exit 0 output", isError: false };
    if (req.kind === "gate") return (req.input as { path?: string }).path === "/secret" ? { decision: "deny", reason: "protected_path" } : { decision: "allow" };
    return { ok: true };
  });
});
afterEach(async () => { await server.close(); delete process.env.HOUGE_BRIDGE_SOCK; delete process.env.HOUGE_BRIDGE_TOKEN; });

function stubPi() {
  const tools: any[] = []; const handlers = {} as { tool_call: (e: any) => any; tool_result: (e: any) => any };
  return { tools, handlers, api: { registerTool: (t: any) => tools.push(t), on: (ev: "tool_call" | "tool_result", h: any) => { handlers[ev] = h; } } };
}

describe("omp extensions — what the planner sees and what it may call", () => {
  it("registers exactly the daemon's manifest; each stub forwards the call with omp's toolCallId", async () => {
    const pi = stubPi();
    const mod = await import("../../src/omp/extension/houge-tools.js");
    await mod.hougeTools(pi.api);
    expect(pi.tools.map((t) => t.name)).toEqual(["bash"]);
    const r = await pi.tools[0].execute("tc-1", { command: "ls" }, undefined, () => {});
    expect(r.content[0].text).toBe("exit 0 output");
    expect(seen.find((s) => s.kind === "call")).toMatchObject({ tool: "bash", toolCallId: "tc-1", input: { command: "ls" } });
  });

  it("blocks any tool outside the allowlist — omp's own web_search/fetch must never run (D3)", async () => {
    const pi = stubPi();
    await (await import("../../src/omp/extension/houge-tools.js")).hougeTools(stubPi().api);
    await (await import("../../src/omp/extension/houge-policy.js")).hougePolicy(pi.api);
    expect(await pi.handlers.tool_call({ toolName: "web_search", toolCallId: "x", input: {} })).toMatchObject({ block: true });
    expect(await pi.handlers.tool_call({ toolName: "bash", toolCallId: "y", input: { command: "ls" } })).toBeUndefined();
  });

  it("gates read/edit/write through the daemon and blocks on deny with the daemon's reason", async () => {
    const pi = stubPi();
    await (await import("../../src/omp/extension/houge-policy.js")).hougePolicy(pi.api);
    expect(await pi.handlers.tool_call({ toolName: "read", toolCallId: "r1", input: { path: "/secret" } })).toEqual({ block: true, reason: "protected_path" });
    expect(await pi.handlers.tool_call({ toolName: "read", toolCallId: "r2", input: { path: "/tmp/a" } })).toBeUndefined();
  });

  it("reports a built-in result with counts only — never the content", async () => {
    const pi = stubPi();
    await (await import("../../src/omp/extension/houge-policy.js")).hougePolicy(pi.api);
    await pi.handlers.tool_call({ toolName: "write", toolCallId: "w1", input: { path: "/tmp/a" } });
    await pi.handlers.tool_result({ toolName: "write", toolCallId: "w1", isError: false, content: [{ type: "text", text: "secret body" }] });
    const report = seen.find((s) => s.kind === "report") as any;
    expect(report).toMatchObject({ toolCallId: "w1", outcome: "succeeded", bytes_out: 11 });
    expect(JSON.stringify(report)).not.toContain("secret body");
  });

  it("fails closed when the bridge env is missing: every gated call is blocked", async () => {
    delete process.env.HOUGE_BRIDGE_SOCK;
    const { resetBridgeForTest } = await import("../../src/omp/extension/bridge-client.js");
    resetBridgeForTest();
    const pi = stubPi();
    await (await import("../../src/omp/extension/houge-policy.js")).hougePolicy(pi.api);
    expect(await pi.handlers.tool_call({ toolName: "read", toolCallId: "r3", input: { path: "/tmp/a" } })).toMatchObject({ block: true });
  });

  it("gate carries path fields only: a 2 MB write body never crosses the bridge (frame-size contract)", async () => {
    const pi = stubPi();
    await (await import("../../src/omp/extension/houge-policy.js")).hougePolicy(pi.api);
    const big = "x".repeat(2 * 1024 * 1024);
    expect(await pi.handlers.tool_call({ toolName: "write", toolCallId: "big", input: { path: "/tmp/a", content: big } })).toBeUndefined();
    const gate = seen.find((s) => s.kind === "gate") as BridgeRequest;
    expect(JSON.stringify(gate).length).toBeLessThan(1024);
    expect(gate).toMatchObject({ input: { path: "/tmp/a" } });
    expect(JSON.stringify(gate)).not.toContain("xxxx");
  });
});

describe("omp extensions — fail closed", () => {
  const policy = async () => { const pi = stubPi(); await (await import("../../src/omp/extension/houge-policy.js")).hougePolicy(pi.api); return pi; };
  const withServer = async (handle: (r: BridgeRequest) => Promise<unknown>) => {
    await server.close(); resetBridgeForTest();
    const sock = process.env.HOUGE_BRIDGE_SOCK as string;
    server = await BridgeServer.listen(sock, "t", handle);
  };

  it("a manifest entry alone does not allow a tool: unregistered stubs (load-time fetch failed) => native bash is blocked", async () => {
    const pi = await policy(); // houge-tools never ran, so nothing registered
    expect(await pi.handlers.tool_call({ toolName: "bash", toolCallId: "n1", input: {} })).toMatchObject({ block: true });
  });

  it("only names whose registerTool returned are trusted: a throwing registerTool leaves the tool blocked", async () => {
    const tools = await import("../../src/omp/extension/houge-tools.js");
    await expect(tools.hougeTools({ registerTool: () => { throw new Error("boom"); }, on: () => undefined })).rejects.toThrow("boom");
    const pi = await policy();
    expect(await pi.handlers.tool_call({ toolName: "bash", toolCallId: "n2", input: {} })).toMatchObject({ block: true });
  });

  it("manifest fetch rejects for a non-builtin => block", async () => {
    await (await import("../../src/omp/extension/houge-tools.js")).hougeTools(stubPi().api);
    await withServer(async (req) => { if (req.kind === "manifest") throw new Error("nope"); return {}; });
    const pi = await policy();
    expect(await pi.handlers.tool_call({ toolName: "bash", toolCallId: "n3", input: {} })).toMatchObject({ block: true });
  });

  it.each([[null], [{}], ["allow"], [{ decision: "ALLOW" }]])("gate result %j is not an allow => block", async (bad) => {
    await withServer(async () => bad);
    const pi = await policy();
    expect(await pi.handlers.tool_call({ toolName: "read", toolCallId: "n4", input: { path: "/tmp/a" } })).toMatchObject({ block: true });
  });

  it("bridge closes mid-request => block; next request reconnects and works", async () => {
    let first = true; let sockets: () => void = () => undefined;
    await withServer(async (req) => { if (req.kind === "gate" && first) { first = false; sockets(); return new Promise(() => undefined); } return { decision: "allow" }; });
    sockets = () => { void server.close(); };
    const pi = await policy();
    expect(await pi.handlers.tool_call({ toolName: "read", toolCallId: "c1", input: { path: "/tmp/a" } })).toMatchObject({ block: true });
    const sock = process.env.HOUGE_BRIDGE_SOCK as string;
    server = await BridgeServer.listen(sock, "t", async () => ({ decision: "allow" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(await pi.handlers.tool_call({ toolName: "read", toolCallId: "c2", input: { path: "/tmp/a" } })).toBeUndefined();
  });

  it("paths[] over 64 entries is blocked whole, never truncated (a protected path at index 64+ must not slip through)", async () => {
    const pi = await policy();
    const paths = Array.from({ length: 100 }, (_, i) => `/tmp/f${i}`);
    expect(await pi.handlers.tool_call({ toolName: "edit", toolCallId: "mp", input: { paths, edits: "y".repeat(5000) } })).toEqual({ block: true, reason: "too_many_paths" });
    expect(seen.find((s) => s.kind === "gate")).toBeUndefined();
  });

  it("a non-string paths entry is blocked bad_path; a valid paths[] is forwarded intact without the body", async () => {
    const pi = await policy();
    expect(await pi.handlers.tool_call({ toolName: "edit", toolCallId: "bp", input: { paths: ["/tmp/a", 5] } })).toEqual({ block: true, reason: "bad_path" });
    expect(await pi.handlers.tool_call({ toolName: "edit", toolCallId: "ok", input: { paths: ["/tmp/a", "/tmp/b"], edits: "body" } })).toBeUndefined();
    const g = seen.find((s) => s.kind === "gate") as any;
    expect(g.input).toEqual({ paths: ["/tmp/a", "/tmp/b"] });
  });

  it("the single houge.ts entry registers stubs and allows them (omp loads each -e with a ?mtime query, so two entries cannot share `registered`; live-proven only)", async () => {
    const entry = stubPi();
    await (await import("../../src/omp/extension/houge.js")).default(entry.api);
    expect(entry.tools.map((t) => t.name)).toEqual(["bash"]);
    expect(await entry.handlers.tool_call({ toolName: "bash", toolCallId: "s2", input: {} })).toBeUndefined();
  });

  it("a failing manifest does not unload the gate (omp drops all handlers of an extension that throws): entry resolves, stubs absent, read and bash blocked", async () => {
    await withServer(async () => { throw new Error("manifest down"); });
    const pi = stubPi();
    await (await import("../../src/omp/extension/houge.js")).default(pi.api);
    expect(pi.tools).toEqual([]);
    expect(await pi.handlers.tool_call({ toolName: "read", toolCallId: "f1", input: { path: "/tmp/a" } })).toMatchObject({ block: true });
    expect(await pi.handlers.tool_call({ toolName: "bash", toolCallId: "f2", input: {} })).toMatchObject({ block: true });
  });

  it("report: bytes_out counts UTF-8 bytes and duration_ms is measured from the tool_call hook", async () => {
    const pi = await policy();
    await pi.handlers.tool_call({ toolName: "write", toolCallId: "d1", input: { path: "/tmp/a" } });
    await new Promise((r) => setTimeout(r, 60));
    await pi.handlers.tool_result({ toolName: "write", toolCallId: "d1", isError: false, content: [{ type: "text", text: "é猴" }] });
    const rep = seen.find((s) => s.kind === "report") as any;
    expect(rep.bytes_out).toBe(5);
    expect(rep.duration_ms).toBeGreaterThanOrEqual(50);
  });
});

describe("omp extensions — hermeticity", () => {
  it("importing the extensions and rendering the Seatbelt profile never reads the real ~/.omp (developer login state cannot pass the suite)", async () => {
    const realHome = process.env.HOME ?? "";
    const reads: string[] = [];
    const track = (orig: (...a: any[]) => any) => (...a: any[]) => { reads.push(String(a[0])); return orig(...a); };
    const r = vi.spyOn(fs, "readFileSync").mockImplementation(track(fs.readFileSync.bind(fs)) as any);
    const st = vi.spyOn(fs, "statSync").mockImplementation(track(fs.statSync.bind(fs)) as any);
    syncBuiltinESMExports();
    const saved = process.env.HOME;
    process.env.HOME = mkdtempSync(join(tmpdir(), "hx-home-"));
    delete process.env.HOUGE_BRIDGE_SOCK; delete process.env.HOUGE_BRIDGE_TOKEN;
    try {
      await import("../../src/omp/extension/houge-tools.js");
      await import("../../src/omp/extension/houge-policy.js");
      const { renderSeatbelt } = await import("../../src/omp/seatbelt.js");
      renderSeatbelt({ home: process.env.HOME, repo: "/r", data: "/r" });
    } finally {
      r.mockRestore(); st.mockRestore(); syncBuiltinESMExports();
      if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved;
    }
    expect(reads.filter((p) => realHome && p.startsWith(join(realHome, ".omp")))).toEqual([]);
  });
});
