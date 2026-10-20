import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeServer } from "../../src/omp/bridge-server.js";
import { BRIDGE_TIMEOUT, getBridge, HOOK_TIMEOUT_MS, resetBridgeForTest } from "../../src/omp/extension/bridge-client.js";

// Spec §2.4: a per-request timer rejects `bridge_timeout`, removes the pending entry and drops a later reply; requests
// without the option keep today's no-timeout contract (gate, call, manifest, edit/write report).
let server: BridgeServer; let delay = 0; let served = false;
beforeEach(async () => {
  resetBridgeForTest();
  const sock = join(mkdtempSync(join(tmpdir(), "hbc-")), "b.sock");
  process.env.HOUGE_BRIDGE_SOCK = sock; process.env.HOUGE_BRIDGE_TOKEN = "t";
  server = await BridgeServer.listen(sock, "t", async () => { await new Promise((r) => setTimeout(r, delay)); served = true; return { ok: true }; });
});
afterEach(async () => { await server.close(); delete process.env.HOUGE_BRIDGE_SOCK; delete process.env.HOUGE_BRIDGE_TOKEN; });

describe("bridge-client request timeout", () => {
  it("the hook timeout is 5 s", () => { expect(HOOK_TIMEOUT_MS).toBe(5_000); });
  it("rejects bridge_timeout when the reply is late, and a later reply is dropped without an unhandled rejection", async () => {
    delay = 80; served = false;
    await expect(getBridge().request({ kind: "manifest" }, { timeoutMs: 20 })).rejects.toThrow(BRIDGE_TIMEOUT);
    expect(served).toBe(false); // the timer fired before the server replied: ordering, not a wall-clock bound
    await new Promise((r) => setTimeout(r, 120)); // the late reply arrives: nothing throws
    delay = 0;
    await expect(getBridge().request({ kind: "manifest" })).resolves.toEqual({ ok: true }); // the socket still works
  });
  it("without the option a request waits as long as the server takes", async () => {
    delay = 60;
    await expect(getBridge().request({ kind: "manifest" })).resolves.toEqual({ ok: true });
  });
  it("a reply inside the timer clears it (no timer outlives the request)", async () => {
    delay = 0;
    await expect(getBridge().request({ kind: "manifest" }, { timeoutMs: 1_000 })).resolves.toEqual({ ok: true });
  });
});
