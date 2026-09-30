import { connect } from "node:net";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
});
