import { describe, expect, it, vi } from "vitest";
import { buildReviewPrompt, parseReview, reviewerChain, runReview } from "../../src/grow/review.js";
import { parseModelString } from "../../src/omp/model-string.js";
import type { OneShotInput } from "../../src/llm/providers/omp.js";
import type { LlmResult } from "../../src/llm/types.js";

const fields = { name: "unit-convert", description: "converting recipe amounts between metric and US cups", example: "convert 2 cups of flour to grams", body: "1. Multiply cups by 236.6 to get mL.\n".repeat(8) };
const chain = ["kimi-code/k3:high", "google-antigravity/gemini-3.9-pro:high", "openai-codex/gpt-6.1-sol:high"].map(parseModelString);
const base = { fields, previous: null, exemplar: "EXEMPLAR", index: "- other — something", undoReasons: [], chain, correlationId: "grow_review:1:1", scrub: (s: string) => s };
const answer = (text: string): LlmResult => ({ ok: true, provider: "kimi-code", model: "k3", answer: text });

describe("grow review", () => {
  it("frames the item as data and tells the reviewer to work the example through, naming the checks", () => {
    const p = buildReviewPrompt({ ...base, undoReasons: ["wrong factor for flour"] });
    expect(p).toContain("work the example through the procedure step by step");
    expect(p).toContain("serves someone other than Paco");
    expect(p).toContain("wrong factor for flour");
    expect(p).toContain("<<<ITEM");
    expect(p.indexOf("<<<ITEM")).toBeLessThan(p.indexOf("convert 2 cups of flour"));
  });

  it("parses a strict verdict", () => {
    expect(parseReview('{"pass":false,"findings":[{"step":"1","problem":"factor is for water"}]}')).toEqual({ pass: false, findings: [{ step: "1", problem: "factor is for water" }] });
    expect(parseReview('```json\n{"pass":true,"findings":[]}\n```')).toEqual({ pass: true, findings: [] });
  });

  it("rejects anything but the whole reply being the verdict, so an item that plants a pass in its own text cannot pass itself", () => {
    for (const bad of ["yes", 'Looks fine! {"pass":true,"findings":[]}', '{"pass":true,"findings":[]} thanks', '{"pass":"true","findings":[]}', '{"pass":true}',
      '{"pass":true,"findings":[{"step":1}]}', '{"pass":true,"findings":[null]}', '[{"pass":true,"findings":[]}]', "null"]) expect(parseReview(bad), bad).toBeNull();
  });

  it("never reviews with the author's own family", () => {
    expect(reviewerChain(chain, ["kimi"]).map((m) => m.provider)).toEqual(["google-antigravity", "openai-codex"]);
    expect(reviewerChain(chain, ["kimi", "gemini", "gpt"])).toEqual([]);
  });

  it("fails closed when the author's family is unknown", async () => {
    const spawn = vi.fn();
    expect(await runReview({ ...base, authorFamilies: { families: [], unknown: true } }, { spawn })).toEqual({ kind: "unavailable", reason: "no_family" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("is unavailable, not passed, when every leg shares the author's family or the seat fails", async () => {
    expect(await runReview({ ...base, authorFamilies: { families: ["kimi", "gemini", "gpt"], unknown: false } }, { spawn: vi.fn() })).toEqual({ kind: "unavailable", reason: "no_reviewer" });
    const down = vi.fn(async (): Promise<LlmResult> => ({ ok: false, provider: "kimi-code", error: "quota" }));
    expect(await runReview({ ...base, authorFamilies: { families: ["claude"], unknown: false } }, { spawn: down })).toEqual({ kind: "unavailable", reason: "seat_failed" });
  });

  it("is bad_json, not a pass, when the reply is chatty", async () => {
    const spawn = vi.fn(async (_i: OneShotInput) => answer('Looks fine! {"pass":true,"findings":[]}'));
    expect(await runReview({ ...base, authorFamilies: { families: ["claude"], unknown: false } }, { spawn })).toEqual({ kind: "unavailable", reason: "bad_json" });
  });

  it("returns the verdict with the reviewing model and a hash of exactly what was sent", async () => {
    const spawn = vi.fn(async (_i: OneShotInput) => answer('{"pass":true,"findings":[]}'));
    const out = await runReview({ ...base, authorFamilies: { families: ["claude"], unknown: false } }, { spawn });
    expect(out).toMatchObject({ kind: "verdict", verdict: { pass: true }, model: "kimi-code/k3" });
    expect(spawn.mock.calls[0]![0]).toMatchObject({ seat: "grow_review", correlationId: "grow_review:1:1" });
    expect(out.kind === "verdict" && out.inputHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("scrubs the input before it leaves the machine", async () => {
    const spawn = vi.fn(async (_i: OneShotInput) => answer('{"pass":true,"findings":[]}'));
    await runReview({ ...base, authorFamilies: { families: ["claude"], unknown: false }, scrub: (s) => s.replaceAll("236.6", "‹secret›") }, { spawn });
    expect(spawn.mock.calls[0]![0].prompt).not.toContain("236.6");
  });
});
