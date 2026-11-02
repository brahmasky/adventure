import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ompProbe, probeKindOf, probeOutcomeOf, PROBE_PROMPT } from "../../src/omp/model-probe.js";
import { resolveOmpConfig } from "../../src/omp/omp-config.js";
import { RunStore } from "../../src/run/run-store.js";
import { useFakeOmp } from "../helpers/omp-env.js";

// Spec §4.2: the catalog is not the subscription. A model is adopted only after one short prompt answers through the same
// one-shot seat every tick seat uses; a model_missing answer is remembered for 7 days, anything else is retried. The kind
// must survive spawnOneShot's aggregate text (plan P6): if it degraded to "other", a retired model would never be rejected.
const dirs: string[] = []; const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "hpr-")); dirs.push(d); return d; };
const ok = () => ({ ok: true as const, version: "18.4.4" });

describe("probeKindOf / probeOutcomeOf", () => {
  it("reads the leg's kind from the aggregate text; falls back to classifyOmpError", () => {
    expect(probeKindOf("all probe legs failed — google-antigravity/gemini-3.1-pro: model_missing")).toBe("model_missing");
    expect(probeKindOf("all probe legs failed — kimi-code/k3.1-pro: quota")).toBe("quota");
    expect(probeKindOf("Model \"x/y\" not found")).toBe("model_missing");
    expect(probeKindOf("all probe legs failed — a/b: deadline")).toBe("other");
  });
  it("pass needs ok and a non-empty reply; abort is its own answer; an unavailable omp is inconclusive", () => {
    expect(probeOutcomeOf({ ok: true, provider: "p", model: "m", answer: " OK " })).toEqual({ result: "pass", kind: "ok" });
    expect(probeOutcomeOf({ ok: true, provider: "p", model: "m", answer: "  " })).toEqual({ result: "inconclusive", kind: "empty" });
    expect(probeOutcomeOf({ ok: false, provider: "omp", error: "aborted", aborted: true })).toBe("aborted");
    expect(probeOutcomeOf({ ok: false, provider: "omp", error: "x", unavailable: true })).toEqual({ result: "inconclusive", kind: "unavailable" });
  });
});

describe("ompProbe through the real one-shot seat (fake omp binary)", () => {
  it("a model omp refuses at start is model_missing; the leg is audited under role probe", async () => {
    useFakeOmp({ rpcBadModelAtStart: ["google-antigravity/gemini-3.1-pro"], "*": { text: "OK" } }, tmp());
    const store = RunStore.openInMemory();
    const probe = ompProbe(store, resolveOmpConfig(process.env), { versionCheck: ok });
    expect(await probe("google-antigravity/gemini-3.1-pro")).toEqual({ result: "model_missing", kind: "model_missing" });
    const roles = store.getLedgerEvents().filter((e) => e.event_type === "llm_attempt").map((e) => (e.payload as { role: string; error_kind?: string }));
    expect(roles.map((r) => [r.role, r.error_kind])).toEqual([["probe", "model_missing"]]);
    store.close();
  });
  it("a model that answers passes; the prompt is the fixed probe text", async () => {
    const d = tmp(); useFakeOmp({ "*": { text: "OK" } }, d);
    process.env.FAKE_OMP_ARGV_LOG = join(d, "argv.log");
    const store = RunStore.openInMemory();
    expect(await ompProbe(store, resolveOmpConfig(process.env), { versionCheck: ok })("kimi-code/k3.1-pro")).toEqual({ result: "pass", kind: "ok" });
    const { readFileSync } = await import("node:fs");
    const line = JSON.parse(readFileSync(join(d, "argv.log"), "utf8").trim().split("\n").at(-1)!) as { argv: string[]; stdin: string };
    expect(line.stdin).toBe(PROBE_PROMPT);
    expect(line.argv).toEqual(expect.arrayContaining(["--no-session", "--no-tools", "--model", "kimi-code/k3.1-pro"]));
    store.close();
  });
  it("a quota failure is inconclusive with its kind", async () => {
    useFakeOmp({ "*": { exit: 1, stderr: "429 usage limit reached" } }, tmp());
    const store = RunStore.openInMemory();
    expect(await ompProbe(store, resolveOmpConfig(process.env), { versionCheck: ok })("kimi-code/k3.1-pro")).toEqual({ result: "inconclusive", kind: "quota" });
    store.close();
  });
  it("a stop signal aborts the probe", async () => {
    useFakeOmp({ "*": { text: "OK", sleepMs: 5_000 } }, tmp());
    const store = RunStore.openInMemory(); const ac = new AbortController();
    const p = ompProbe(store, resolveOmpConfig(process.env), { versionCheck: ok })("kimi-code/k3.1-pro", ac.signal);
    setTimeout(() => ac.abort(), 200);
    expect(await p).toBe("aborted");
    store.close();
  });
});
