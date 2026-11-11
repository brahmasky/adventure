/**
 * Rules: ADR 0035 G2 (the daemon the only writer): a process that is not the daemon's worker answers grow_submit
 * `REFUSED not_the_daemon` before it creates or commits anything in the zone; only the daemon (and the live gates) ask for
 * the writer role. Changing a rule changes its test in the same commit.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CoreWorker } from "../../src/core/core-worker.js";
import { RunStore } from "../../src/run/run-store.js";
import { shortTmp, tmpOmpDist } from "../helpers/omp-env.js";

const SUBMIT = { name: "web-notes", description: "taking structured notes on a web page the user shares", example: "summarise this page for me", body: "x".repeat(300) };

describe("ADR 0035 G2: the daemon is the only writer (not_the_daemon)", () => {
  it("a worker built without the writer role refuses grow_submit and leaves the zone directory uncreated", async () => {
    const grow = shortTmp("hgz-"), data = shortTmp("hgw-");
    const saved = { dir: process.env.HOUGE_GROW_DIR, on: process.env.HOUGE_GROW_ENABLED };
    process.env.HOUGE_GROW_DIR = join(grow.dir, "grow");
    process.env.HOUGE_GROW_ENABLED = "true";
    const store = RunStore.openInMemory();
    try {
      const raw = new CoreWorker(store, join(data.dir, "project"), async () => ({ ok: true, output: { answer: "stub" } }), undefined, undefined, undefined, undefined, undefined, undefined, async () => null,
        undefined, undefined, { dataDir: data.dir, distDir: tmpOmpDist(data.dir) });
      const exec = (raw as unknown as { growSubmitExecute(c: unknown, s: unknown, i: Record<string, unknown>): Promise<{ output: { answer: string } }> }).growSubmitExecute;
      const r = await exec.call(raw, {}, {}, SUBMIT);
      expect(r.output.answer).toBe("REFUSED not_the_daemon");
      expect(existsSync(process.env.HOUGE_GROW_DIR)).toBe(false);
    } finally {
      store.close(); grow.cleanup(); data.cleanup();
      if (saved.dir === undefined) delete process.env.HOUGE_GROW_DIR; else process.env.HOUGE_GROW_DIR = saved.dir;
      if (saved.on === undefined) delete process.env.HOUGE_GROW_ENABLED; else process.env.HOUGE_GROW_ENABLED = saved.on;
    }
  });

  it("the daemon passes growWriter: true and the worker's guard sits before the zone is touched", () => {
    expect(readFileSync("src/telegram/telegram-daemon.ts", "utf8")).toMatch(/growWriter: true/);
    const src = readFileSync("src/core/core-worker.ts", "utf8");
    const guard = src.indexOf('growWriter !== true) return answer("REFUSED not_the_daemon")');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(src.indexOf("svc.ensureZone", guard - 400));
  });
});
