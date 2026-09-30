import { connect } from "node:net";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BridgeServer } from "../../src/omp/bridge-server.js";
import { encodeLine, LineDecoder } from "../../src/omp/bridge-protocol.js";

async function client(sock: string, lines: object[]): Promise<object[]> {
  return new Promise((resolve) => {
    const c = connect(sock); const dec = new LineDecoder(); const got: object[] = [];
    c.on("data", (d) => { got.push(...dec.push(d.toString())); if (got.length >= lines.length - 1) { c.end(); } });
    c.on("close", () => resolve(got));
    for (const l of lines) c.write(encodeLine(l));
  });
}

describe("bridge server — one socket per planner child; every connection on it IS that child (spec §4)", () => {
  it("creates the socket 0600 and answers requests after a correct hello", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "hb-")), "c.sock");
    const s = await BridgeServer.listen(sock, "tok", async (req) => ({ echo: req.kind }));
    expect(statSync(sock).mode & 0o777).toBe(0o600);
    const got = await client(sock, [{ id: "h", kind: "hello", token: "tok" }, { id: "1", kind: "manifest" }]);
    expect(got).toContainEqual({ id: "1", ok: true, result: { echo: "manifest" } });
    await s.close();
  });

  it("drops a connection whose first line is not the right hello — anti-accident, not a boundary", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "hb-")), "c.sock");
    const s = await BridgeServer.listen(sock, "tok", async () => ({}));
    const got = await client(sock, [{ id: "h", kind: "hello", token: "WRONG" }, { id: "1", kind: "manifest" }]);
    expect(got.some((g) => (g as { id?: string }).id === "1")).toBe(false);
    await s.close();
  });

  it("returns ok:false with the handler's message instead of crashing the daemon", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "hb-")), "c.sock");
    const s = await BridgeServer.listen(sock, "tok", async () => { throw new Error("boom"); });
    const got = await client(sock, [{ id: "h", kind: "hello", token: "tok" }, { id: "1", kind: "manifest" }]);
    expect(got).toContainEqual({ id: "1", ok: false, error: "boom" });
    await s.close();
  });

  it("drops a non-object first line (JSON null) instead of throwing inside the data handler", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "hb-")), "c.sock");
    const s = await BridgeServer.listen(sock, "tok", async () => ({}));
    const got = await new Promise<object[]>((resolve) => {
      const c = connect(sock); const dec = new LineDecoder(); const out: object[] = [];
      c.on("data", (d) => out.push(...dec.push(d.toString())));
      c.on("close", () => resolve(out));
      c.write("null\n"); c.write(encodeLine({ id: "1", kind: "manifest" }));
    });
    expect(got).toEqual([]);
    await s.close();
  });

  it("a multi-byte character split across two chunks arrives intact (bash must run exactly the command sent)", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "hb-")), "c.sock");
    const seen: unknown[] = [];
    const s = await BridgeServer.listen(sock, "tok", async (req) => { seen.push(req); return {}; });
    const line = Buffer.from(encodeLine({ id: "1", kind: "call", tool: "bash", input: { command: "echo 猴哥" }, toolCallId: "t" }), "utf8");
    const cut = line.indexOf(Buffer.from("猴", "utf8")) + 1;
    const c = connect(sock);
    await new Promise((r) => c.once("connect", r));
    c.write(encodeLine({ id: "h", kind: "hello", token: "tok" }));
    c.write(line.subarray(0, cut));
    await new Promise((r) => setTimeout(r, 50));
    c.write(line.subarray(cut));
    await vi.waitFor(() => { expect(seen).toHaveLength(1); });
    expect((seen[0] as { input: { command: string } }).input.command).toBe("echo 猴哥");
    c.destroy(); await s.close();
  });

  it("a hello split across two writes still authenticates", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "hb-")), "c.sock");
    const s = await BridgeServer.listen(sock, "tok", async (req) => ({ echo: req.kind }));
    const got = await new Promise<object[]>((resolve) => {
      const c = connect(sock); const dec = new LineDecoder(); const out: object[] = [];
      c.on("data", (d) => { out.push(...dec.push(d.toString())); c.end(); });
      c.on("close", () => resolve(out));
      const hello = encodeLine({ id: "h", kind: "hello", token: "tok" });
      c.write(hello.slice(0, 10));
      setTimeout(() => { c.write(hello.slice(10)); c.write(encodeLine({ id: "1", kind: "manifest" })); }, 50);
    });
    expect(got).toContainEqual({ id: "1", ok: true, result: { echo: "manifest" } });
    await s.close();
  });

  it("an unterminated line over 16 MB drops the connection and fires onDisconnect (the turn aborts, nothing is silently lost)", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "hb-")), "c.sock");
    const s = await BridgeServer.listen(sock, "tok", async () => ({}));
    let disconnected = false;
    s.onDisconnect(() => { disconnected = true; });
    const closed = await new Promise<boolean>((resolve) => {
      const c = connect(sock);
      c.on("close", () => resolve(true)); c.on("error", () => undefined);
      c.write(encodeLine({ id: "h", kind: "hello", token: "tok" }));
      c.write("x".repeat(17 * 1024 * 1024));
    });
    expect(closed).toBe(true);
    await vi.waitFor(() => { expect(disconnected).toBe(true); });
    await s.close();
  });
});
