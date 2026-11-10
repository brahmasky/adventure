import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelString } from "../../src/omp/model-string.js";

const tick = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../../src/grow/tick.js", async (orig) => ({ ...(await orig<typeof import("../../src/grow/tick.js")>()), runGrowTick: tick.run }));
const oneShot = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("../../src/llm/providers/omp.js", async (orig) => ({ ...(await orig<typeof import("../../src/llm/providers/omp.js")>()), spawnOneShot: oneShot.spawn }));

import { EXEMPLAR_NAME } from "../../src/grow/seed.js";
import { GROW_CLAIM_STALE_MS } from "../../src/grow/tick.js";
import { bootGrowZone, runGrowTickSafe, type RunTelegramDaemonOptions } from "../../src/telegram/telegram-daemon.js";
import { growSetup, mkTmp } from "../helpers/grow.js";
import { pinOmpEnv } from "../helpers/omp-env.js";

pinOmpEnv();
const NOW = "2026-11-10T10:00:00.000Z";
const SEED = join(import.meta.dirname, "..", "..", "grow-seed");
const SNAP = "houge-20261110T000000Z.sqlite";
type Setup = Awaited<ReturnType<typeof growSetup>>;
const CHAIN = [{ provider: "p", model: "m" }] as unknown as ModelString[];
const fakeWorker = (s: Setup, candidates = vi.fn(() => CHAIN)) => ({ growService: () => s.svc, modelRoles: () => ({ chains: () => undefined, candidates }) }) as never;
const opts = (s: Setup, projectRoot: string, signal = new AbortController().signal) => ({ store: s.store, projectRoot, stopSignal: signal }) as unknown as RunTelegramDaemonOptions;
const openKinds = (s: Setup): string[] => s.store.listOpenIncidents().map((i) => i.kind);

let saved: string | undefined;
beforeEach(() => { oneShot.spawn.mockReset(); saved = process.env.HOUGE_BACKUP_ENABLED; tick.run.mockReset(); tick.run.mockResolvedValue({ requests: 0, reviewed: null }); });
afterEach(() => { if (saved === undefined) delete process.env.HOUGE_BACKUP_ENABLED; else process.env.HOUGE_BACKUP_ENABLED = saved; vi.restoreAllMocks(); });

describe("bootGrowZone", () => {
  it("makes the zone consistent (reconcile, then sync with HEAD) before it seeds", async () => {
    const s = await growSetup(); const root = mkTmp(); cpSync(SEED, join(root, "grow-seed"), { recursive: true });
    const order: string[] = [];
    for (const m of ["reconcile", "syncWithHead", "seed"] as const) {
      const orig = s.svc[m].bind(s.svc) as (...a: unknown[]) => Promise<unknown>;
      vi.spyOn(s.svc, m).mockImplementation((async (...a: unknown[]) => { order.push(m); return orig(...a); }) as never);
    }
    await bootGrowZone(opts(s, root), fakeWorker(s), NOW);
    expect(order).toEqual(["reconcile", "syncWithHead", "seed"]);
    expect(s.store.getGrowItem(EXEMPLAR_NAME)).toMatchObject({ state: "live", origin: "exemplar" });
    expect(openKinds(s)).not.toContain("grow_seed_failed");
  });

  it("a failing exemplar opens grow_seed_failed and leaves the zone usable", async () => {
    const s = await growSetup(); const root = mkTmp();
    mkdirSync(join(root, "grow-seed", "skills", "bad-one"), { recursive: true });
    writeFileSync(join(root, "grow-seed", "skills", "bad-one", "SKILL.md"), "---\nname: bad-one\ndescription: \"x\"\nexample: \"y\"\norigin: exemplar\n---\n\nshort\n");
    await bootGrowZone(opts(s, root), fakeWorker(s), NOW);
    expect(openKinds(s)).toContain("grow_seed_failed");
    expect(await s.svc.ensureZone()).toBe(true);
    expect(s.svc.disabledReason()).toBeNull();
  });

  it("a clean boot closes the grow_seed_failed incident an earlier bad boot opened", async () => {
    const s = await growSetup(); const root = mkTmp();
    const bad = join(root, "grow-seed", "skills", "bad-one"); mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "SKILL.md"), "---\nname: bad-one\ndescription: \"x\"\nexample: \"y\"\norigin: exemplar\n---\n\nshort\n");
    await bootGrowZone(opts(s, root), fakeWorker(s), NOW);
    expect(openKinds(s)).toContain("grow_seed_failed");
    rmSync(bad, { recursive: true });   // the seed folder stays, now with nothing failing in it
    await bootGrowZone(opts(s, root), fakeWorker(s), NOW);
    expect(openKinds(s)).not.toContain("grow_seed_failed");
  });

  it("an invalid legacy file counts: it opens grow_seed_failed even when every exemplar passes", async () => {
    const s = await growSetup(); const root = mkTmp();
    mkdirSync(join(root, "grow-seed", "skills"), { recursive: true });   // an empty seed folder: no exemplar can have failed
    mkdirSync(join(root, "skills", "paco"), { recursive: true });
    writeFileSync(join(root, "skills", "paco", "broken.md"), "not a skill file");
    await bootGrowZone(opts(s, root), fakeWorker(s), NOW);
    expect(openKinds(s)).toContain("grow_seed_failed");
  });

  it("logs a code, never a message, when the boot itself throws", async () => {
    const s = await growSetup(); const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const worker = { growService: () => { throw new Error("secret-path /Users/x"); } } as never;
    await bootGrowZone(opts(s, mkTmp()), worker, NOW);
    expect(err).toHaveBeenCalledWith("[telegram-daemon] grow boot failed: Error");
  });
});

describe("runGrowTickSafe", () => {
  it("does nothing when the stop signal is aborted", async () => {
    const s = await growSetup(); const c = new AbortController(); c.abort();
    await runGrowTickSafe(opts(s, mkTmp(), c.signal), fakeWorker(s), NOW);
    expect(tick.run).not.toHaveBeenCalled();
  });

  it("passes the grow_review chain and catches a rejected tick, logging a code only", async () => {
    const s = await growSetup(); const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const candidates = vi.fn(() => CHAIN);
    tick.run.mockRejectedValueOnce(new TypeError("token sk-live-123 in /Users/x"));
    await expect(runGrowTickSafe(opts(s, mkTmp()), fakeWorker(s, candidates), NOW)).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledWith("[telegram-daemon] grow tick failed: TypeError");
    const deps = tick.run.mock.calls[0]![0] as { chain(): ModelString[] };
    expect(deps.chain()).toBe(CHAIN);
    expect(candidates).toHaveBeenCalledWith("grow_review");
  });

  it("hands the tick the stop signal, an audit sink scoped to grow_review with the call's correlation id, and a deadline inside the claim bound", async () => {
    const s = await growSetup(); const c = new AbortController();
    const sink = vi.spyOn(s.store, "llmAuditSink");
    oneShot.spawn.mockResolvedValue({ ok: true, provider: "omp", answer: "x" });
    await runGrowTickSafe(opts(s, mkTmp(), c.signal), fakeWorker(s), NOW);
    const deps = tick.run.mock.calls[0]![0] as { signal: AbortSignal; spawn(i: unknown): Promise<unknown> };
    expect(deps.signal).toBe(c.signal);
    await deps.spawn({ correlationId: "grow_review:7:1:t", seat: "reader", chain: CHAIN, prompt: "p" });
    expect(sink).toHaveBeenCalledWith({ correlation_id: "grow_review:7:1:t", role: "grow_review" });
    const passed = oneShot.spawn.mock.calls[0]![0] as { deadlineAt: number };
    expect(passed.deadlineAt).toBeLessThan(Date.parse(NOW) + GROW_CLAIM_STALE_MS);   // the stale release can never free a row mid-review
    expect(passed.deadlineAt).toBeGreaterThan(Date.parse(NOW));
  });

  it("still runs the bundle step when the tick rejects: a failing bundle opens the incident, a good one is written", async () => {
    process.env.HOUGE_BACKUP_ENABLED = "1";
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    tick.run.mockRejectedValue(new Error("boom"));
    const bad = await growSetup(); const root = mkTmp();
    mkdirSync(join(root, "backups")); writeFileSync(join(root, "backups", SNAP), "snap");
    rmSync(join(bad.dir, "grow", ".git"), { recursive: true, force: true });
    await runGrowTickSafe(opts(bad, root), fakeWorker(bad), NOW);
    expect(openKinds(bad)).toContain("grow_backup_failed");
    const good = await growSetup();
    await runGrowTickSafe(opts(good, root), fakeWorker(good), NOW);
    expect(existsSync(join(root, "backups", SNAP.replace(".sqlite", ".grow.bundle")))).toBe(true);
  });

  it("opens grow_backup_failed once while the bundle keeps failing, and a later written bundle resolves it", async () => {
    process.env.HOUGE_BACKUP_ENABLED = "1";
    const bad = await growSetup(); const root = mkTmp();
    mkdirSync(join(root, "backups")); writeFileSync(join(root, "backups", SNAP), "snap");
    rmSync(join(bad.dir, "grow", ".git"), { recursive: true, force: true });
    await runGrowTickSafe(opts(bad, root), fakeWorker(bad), NOW);
    await runGrowTickSafe(opts(bad, root), fakeWorker(bad), NOW);
    expect(bad.store.listOpenIncidents().filter((i) => i.kind === "grow_backup_failed")).toHaveLength(1);
    const good = await growSetup();
    const store = bad.store;
    await runGrowTickSafe({ store, projectRoot: root, stopSignal: new AbortController().signal } as unknown as RunTelegramDaemonOptions, fakeWorker(good), NOW);
    expect(openKinds(bad)).not.toContain("grow_backup_failed");
  });

  it("makes no bundle while backups are off", async () => {
    delete process.env.HOUGE_BACKUP_ENABLED;
    const s = await growSetup(); const root = mkTmp();
    mkdirSync(join(root, "backups")); writeFileSync(join(root, "backups", SNAP), "snap");
    rmSync(join(s.dir, "grow", ".git"), { recursive: true, force: true });
    await runGrowTickSafe(opts(s, root), fakeWorker(s), NOW);
    expect(openKinds(s)).not.toContain("grow_backup_failed");
  });
});
