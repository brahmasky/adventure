import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_ASK_SYSTEM_PROMPT, llmToolAdapter } from "../../src/llm/registry.js";
import type { LlmRequest, LlmResult } from "../../src/llm/types.js";

// I4: llmToolAdapter is the shape every seat call goes through (runner, wall, media ingest). The
// attachment is validated and the question checked BEFORE any leg runs; the system prompt has a
// fixed precedence; a failed chain maps to the runner's failure shape.
const saved = process.env.HOUGE_ASK_SYSTEM_PROMPT;
let mediaDir: string;
beforeEach(() => { delete process.env.HOUGE_ASK_SYSTEM_PROMPT; mediaDir = mkdtempSync(path.join(os.tmpdir(), "houge-media-")); });
afterEach(() => {
  if (saved === undefined) delete process.env.HOUGE_ASK_SYSTEM_PROMPT; else process.env.HOUGE_ASK_SYSTEM_PROMPT = saved;
  rmSync(mediaDir, { recursive: true, force: true });
});

function fakeSeat(result: LlmResult = { ok: true, provider: "p", model: "m", answer: "A" }) {
  const seen: LlmRequest[] = [];
  return { seen, answer: async (req: LlmRequest) => { seen.push(req); return result; } };
}

describe("llmToolAdapter — media is validated before any leg runs", () => {
  const cases: Array<[string, () => unknown]> = [
    ["a path outside tmpdir", () => ({ path: "/etc/media.jpg", mime: "image/jpeg" })],
    ["a foreign basename", () => { const p = path.join(mediaDir, "secret.jpg"); writeFileSync(p, "x"); return { path: p, mime: "image/jpeg" }; }],
    ["a basename with the wrong mime", () => ({ path: path.join(mediaDir, "media.jpg"), mime: "audio/ogg" })],
    ["a malformed field (not an object)", () => "media.jpg"],
    ["a malformed field (missing mime)", () => ({ path: path.join(mediaDir, "media.jpg") })]
  ];
  for (const [name, media] of cases) {
    it(`rejects ${name} with "media rejected" and never calls the seat`, async () => {
      const seat = fakeSeat();
      expect(await llmToolAdapter(seat)({ question: "q", media: media() })).toEqual({ ok: false, error: "media rejected" });
      expect(seat.seen).toEqual([]);
    });
  }

  it("passes a valid attachment through", async () => {
    const seat = fakeSeat();
    const file = path.join(mediaDir, "media.jpg");
    await llmToolAdapter(seat)({ question: "q", media: { path: file, mime: "image/jpeg" } });
    expect(seat.seen[0]?.media).toEqual({ path: file, mime: "image/jpeg" });
  });
});

describe("llmToolAdapter — system prompt precedence and the question", () => {
  it("input.system wins, then HOUGE_ASK_SYSTEM_PROMPT, then the default", async () => {
    const seat = fakeSeat();
    const call = llmToolAdapter(seat);
    process.env.HOUGE_ASK_SYSTEM_PROMPT = "ENV PERSONA";
    await call({ question: "q", system: "CALLER" });
    await call({ question: "q" });
    delete process.env.HOUGE_ASK_SYSTEM_PROMPT;
    await call({ question: "q", system: "" });
    expect(seat.seen.map((r) => r.system)).toEqual(["CALLER", "ENV PERSONA", DEFAULT_ASK_SYSTEM_PROMPT]);
  });

  it("an empty or missing question is refused before any leg runs", async () => {
    const seat = fakeSeat();
    for (const question of ["", undefined, 42]) {
      expect(await llmToolAdapter(seat)({ question })).toEqual({ ok: false, error: "question must be a non-empty string" });
    }
    expect(seat.seen).toEqual([]);
  });
});

describe("llmToolAdapter — result mapping", () => {
  it("a failed chain becomes the runner's failure with the chain's error", async () => {
    const r = await llmToolAdapter(fakeSeat({ ok: false, provider: "omp", error: "all reader legs failed — x: quota" }))({ question: "q" });
    expect(r).toEqual({ ok: false, error: "all reader legs failed — x: quota" });
  });

  it("a success carries question, answer, model and provider", async () => {
    expect(await llmToolAdapter(fakeSeat())({ question: "q" })).toEqual({ ok: true, output: { question: "q", answer: "A", model: "m", provider: "p" } });
  });
});
