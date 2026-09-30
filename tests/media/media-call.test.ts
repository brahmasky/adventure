import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildMediaCall } from "../../src/media/media-ingest.js";
import { RunStore } from "../../src/run/run-store.js";
import type { LlmProvider } from "../../src/llm/types.js";
import { FAKE_OMP_BIN, pinOmpEnv } from "../helpers/omp-env.js";

// Ruling 2 (live probe 2026-09-30): omp reads a photo as an image block, but inlines an .opus voice
// note as TEXT and the model hallucinated a transcript. So a photo must reach omp and a voice note never.
pinOmpEnv();
const PINNED = ["HOUGE_AGY_BIN", "HOUGE_LLM_MEDIA_PROVIDERS", "HOUGE_LLM_TIMEOUT_MS_MEDIA"] as const;
const saved: Record<string, string | undefined> = {};
let work: string;
let mediaDir: string;
let store: RunStore;
beforeEach(() => {
  for (const k of PINNED) { saved[k] = process.env[k]; delete process.env[k]; }
  work = mkdtempSync(path.join(os.tmpdir(), "houge-mcall-"));
  mediaDir = mkdtempSync(path.join(os.tmpdir(), "houge-media-"));
  store = RunStore.openInMemory();
  writeFileSync(path.join(work, "s.json"), JSON.stringify({ "*": { frames: "oneshot-image.jsonl" } }));
  process.env.HOUGE_OMP_BIN = FAKE_OMP_BIN;
  process.env.HOUGE_OMP_SANDBOX = "0";
  process.env.HOUGE_OMP_ENV_PASSTHROUGH = "FAKE_OMP_SCENARIO,FAKE_OMP_ARGV_LOG";
  process.env.FAKE_OMP_SCENARIO = path.join(work, "s.json");
  process.env.FAKE_OMP_ARGV_LOG = path.join(work, "argv.log");
});
afterEach(() => {
  store.close();
  rmSync(work, { recursive: true, force: true });
  rmSync(mediaDir, { recursive: true, force: true });
  for (const k of PINNED) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const ompSpawns = () => (existsSync(path.join(work, "argv.log")) ? readFileSync(path.join(work, "argv.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv: string[] }) : []);
const attempts = (run_id: string) => store.getLedgerEvents(run_id).filter((e) => e.event_type === "llm_attempt").map((e) => e.payload);

describe("buildMediaCall — which leg reads a photo and which hears a voice note", () => {
  it("a photo is ONE omp one-shot on cfg.media with the image as an @path argument, audited as reader", async () => {
    const file = path.join(mediaDir, "media.jpg");
    writeFileSync(file, "jpeg");
    const call = buildMediaCall({ store, run_id: "run_photo", kind: "photo", env: process.env });
    const r = await call({ question: "describe", system: "reader", media: { path: file, mime: "image/jpeg" } });
    expect(r).toMatchObject({ ok: true, output: { answer: "It is a solid bright red rectangular image.", provider: "google-antigravity" } });
    const spawns = ompSpawns();
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.argv).toContain(`@${file}`);
    expect(spawns[0]?.argv).toContain("google-antigravity/gemini-3.8-flash");
    expect(attempts("run_photo")).toEqual([expect.objectContaining({ role: "reader", outcome: "ok", family: "gemini" })]);
  });

  it("a voice note NEVER reaches omp: it goes to the voice leg only, audited as media_transcribe", async () => {
    const file = path.join(mediaDir, "media.opus");
    writeFileSync(file, "ogg");
    const seen: string[] = [];
    const voiceLeg: LlmProvider = { name: "agy-cli", supportsMedia: () => true, answer: async (req) => { seen.push(req.media?.path ?? ""); return { ok: true, provider: "agy-cli", model: "flash", answer: "the transcript" }; } };
    const call = buildMediaCall({ store, run_id: "run_voice", kind: "voice", env: process.env, voiceLeg });
    const r = await call({ question: "transcribe", system: "s", media: { path: file, mime: "audio/ogg" } });
    expect(r).toMatchObject({ ok: true, output: { answer: "the transcript" } });
    expect(seen).toEqual([file]);
    expect(ompSpawns()).toEqual([]);
    expect(attempts("run_voice")).toEqual([expect.objectContaining({ role: "media_transcribe", provider: "agy-cli", outcome: "ok" })]);
  });

  it("the default voice chain is agy-cli alone: a missing agy is an unavailable agy row, never an omp fallback", async () => {
    process.env.HOUGE_AGY_BIN = "/nonexistent/houge-tests/agy";
    const file = path.join(mediaDir, "media.opus");
    writeFileSync(file, "ogg");
    const r = await buildMediaCall({ store, run_id: "run_v2", kind: "voice", env: process.env })({ question: "t", media: { path: file, mime: "audio/ogg" } });
    expect(r.ok).toBe(false);
    expect(ompSpawns()).toEqual([]);
    expect(attempts("run_v2")).toEqual([expect.objectContaining({ provider: "agy-cli", outcome: "unavailable" })]);
  });

  it("refuses any voice provider but agy-cli (pi and the API legs are gone)", () => {
    process.env.HOUGE_LLM_MEDIA_PROVIDERS = "agy-cli,pi";
    expect(() => buildMediaCall({ store, run_id: "r", kind: "voice", env: process.env })).toThrow(/only agy-cli/);
  });
});
