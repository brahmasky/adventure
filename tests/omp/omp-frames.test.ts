import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyOmpError, parseFrameLine, summarizeAssistantMessage } from "../../src/omp/omp-frames.js";

const frames = (name: string) =>
  readFileSync(new URL(`../fixtures/omp-frames/${name}`, import.meta.url), "utf8")
    .split("\n").map(parseFrameLine).filter((f) => f !== null);

describe("omp frames — the audit row and the answer both come from the assistant message_end", () => {
  it("summarises the real 18.4.4 assistant message_end: text, provider, model, usage with thinking folded in", () => {
    const summaries = frames("json-ok.jsonl").map(summarizeAssistantMessage).filter((s) => s !== null);
    expect(summaries).toHaveLength(1);
    const s = summaries[0]!;
    expect(s.text).toContain("OK");
    expect(s.provider).toBe("google-antigravity");
    expect(s.model).toMatch(/gemini/);
    expect(s.usage!.input_tokens).toBeGreaterThan(0);
    expect(s.usage!.output_tokens).toBeGreaterThan(0);
  });

  it("ignores user message_end and message_update frames so one request yields exactly one summary", () => {
    const f = frames("json-tool.jsonl");
    const n = f.map(summarizeAssistantMessage).filter((s) => s !== null).length;
    const turns = f.filter((x) => x.type === "turn_start").length;
    expect(n).toBe(turns);
  });

  it("parses the real one-shot IMAGE frames: the photo reaches the model as an image block and the answer is the assistant message_end (ruling 1 probe)", () => {
    const f = frames("oneshot-image.jsonl");
    const user = f.find((x) => x.type === "message_end" && (x.message as { role?: string }).role === "user");
    const blocks = ((user?.message as { content?: Array<{ type: string }> }).content ?? []).map((c) => c.type);
    expect(blocks).toContain("image");
    const summaries = f.map(summarizeAssistantMessage).filter((s) => s !== null);
    expect(summaries.at(-1)).toMatchObject({ text: "It is a solid bright red rectangular image.", provider: "google-antigravity", model: "gemini-3.8-flash", stopReason: "stop" });
  });

  it("returns null for garbage lines instead of throwing — omp may print warnings on stdout", () => {
    expect(parseFrameLine("not json")).toBeNull();
    expect(parseFrameLine("")).toBeNull();
    expect(parseFrameLine('{"no":"type"}')).toBeNull();
  });

  it("classifies quota, auth, model-missing and refusal texts into bounded kinds for fallback", () => {
    expect(classifyOmpError("429 rate limit exceeded; quota resets in 4h")).toBe("quota");
    expect(classifyOmpError("usage limit reached for this 5 hour window")).toBe("quota");
    expect(classifyOmpError("The provided authorization grant is invalid (re-login to restore)")).toBe("auth");
    expect(classifyOmpError('No models matching "no-such-model"')).toBe("model_missing");
    expect(classifyOmpError("stopReason=refusal")).toBe("model_refusal");
    expect(classifyOmpError("socket hang up")).toBe("transport");
  });
});
