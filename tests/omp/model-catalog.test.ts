import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CATALOG_TIMEOUT_MS, parseOmpCatalog, readOmpCatalog, readOmpCatalogResult, type ExecFileAsync } from "../../src/omp/model-catalog.js";
import { CATALOG_FIXTURE } from "../helpers/model-roles.js";
import { NO_OMP_BIN } from "../helpers/omp-env.js";

const cfg = { bin: "/fake/omp", profile: "houge", envPassthrough: [] as string[] };

// The catalog is the authority for resolution (Decision 1), and it is third-party output. A shape omp changes, or a
// read that hangs or throws, must leave the roles on their last good catalog and never stall or crash the daemon.
describe("parseOmpCatalog — omp's catalog is validated, never trusted", () => {
  it("keeps provider, id and thinking for every entry the selector syntax can carry", () => {
    const c = parseOmpCatalog(readFileSync(CATALOG_FIXTURE, "utf8"));
    expect(c?.find((m) => m.provider === "kimi-code" && m.id === "k3")).toEqual({ provider: "kimi-code", id: "k3", thinking: ["low", "high", "max"] });
    expect(c?.find((m) => m.id === "claude-3-haiku-20240307")?.thinking).toBeNull();
    expect(c?.some((m) => m.provider === "ollama")).toBe(false); // "gemma4:latest" is not a provider/id selector
    expect(c?.some((m) => m.provider === "google" && m.id === "gemini-3.8-flash")).toBe(true); // kept here; the allow-list drops it
  });

  it.each([["not json"], ["{}"], ['{"models":"x"}'], ['{"models":[]}'], ['{"models":[{"provider":1,"id":"k3"}]}']])(
    "returns null for %s, so the resolver keeps its last good catalog", (raw) => {
      expect(parseOmpCatalog(raw)).toBeNull();
    });

  it("drops an entry with a malformed thinking field and filters unknown levels out of a good one", () => {
    const c = parseOmpCatalog(JSON.stringify({ models: [
      { provider: "kimi-code", id: "k3", thinking: "high" },
      { provider: "anthropic", id: "claude-opus-5-5", thinking: ["low", "turbo", "high"] }
    ] }));
    expect(c).toEqual([{ provider: "anthropic", id: "claude-opus-5-5", thinking: ["low", "high"] }]);
  });
});

describe("readOmpCatalog — one bounded, session-less read that never throws", () => {
  it("runs `omp --profile <p> models --json` with a timeout and the allowlisted child env (no secret reaches omp)", async () => {
    process.env.HOUGE_TEST_CATALOG_SECRET = "canary-cat-1";
    const calls: Array<{ file: string; args: string[]; opts: Parameters<ExecFileAsync>[2] }> = [];
    const exec: ExecFileAsync = async (file, args, opts) => {
      calls.push({ file, args, opts });
      return { stdout: readFileSync(CATALOG_FIXTURE, "utf8"), stderr: "" };
    };
    try {
      expect((await readOmpCatalog(cfg, exec))?.length).toBeGreaterThan(0);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.file).toBe("/fake/omp");
      expect(calls[0]?.args).toEqual(["--profile", "houge", "models", "--json"]);
      expect(calls[0]?.opts?.timeout).toBe(CATALOG_TIMEOUT_MS);
      expect(Object.values(calls[0]?.opts?.env ?? {})).not.toContain("canary-cat-1");
    } finally {
      delete process.env.HOUGE_TEST_CATALOG_SECRET;
    }
  });

  it("returns null when omp exits non-zero, times out, or prints something that is not a catalog", async () => {
    const fail: ExecFileAsync = async () => { throw Object.assign(new Error("Command failed"), { status: 1 }); };
    const killed: ExecFileAsync = async () => { throw Object.assign(new Error("timed out"), { signal: "SIGTERM" }); };
    const garbage: ExecFileAsync = async () => ({ stdout: "Usage: omp models [--json]", stderr: "" });
    for (const exec of [fail, killed, garbage]) expect(await readOmpCatalog(cfg, exec)).toBeNull();
  });

  it("returns null for a missing binary through the real exec helper", async () => {
    expect(await readOmpCatalog({ ...cfg, bin: NO_OMP_BIN })).toBeNull();
  });
});

// Spec §4.1 check 1: an omp that answers but in a new shape is drift; an omp that cannot answer is not.
describe("readOmpCatalogResult", () => {
  it("splits ok, unparsed and unavailable", async () => {
    const exec = (stdout: string) => (async () => ({ stdout, stderr: "" })) as unknown as ExecFileAsync;
    expect(await readOmpCatalogResult(cfg, exec(JSON.stringify({ models: [{ provider: "p", id: "m" }] })))).toMatchObject({ kind: "ok", models: [{ provider: "p", id: "m" }] });
    expect(await readOmpCatalogResult(cfg, exec(JSON.stringify({ items: [] })))).toEqual({ kind: "unparsed" });
    const fail = (async () => { throw Object.assign(new Error("x"), { code: "ETIMEDOUT" }); }) as unknown as ExecFileAsync;
    expect(await readOmpCatalogResult(cfg, fail)).toEqual({ kind: "unavailable", code: "ETIMEDOUT" });
    expect(await readOmpCatalog(cfg, fail)).toBeNull();
  });
});
