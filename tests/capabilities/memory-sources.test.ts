import { describe, expect, it } from "vitest";
import {
  cutThread, evidenceLines, MEMORY_THREAD_CHAR_CAP, MEMORY_THREAD_TEXT_CAP, MEMORY_THREAD_TEXT_CHARS, memorySources, pacoTextOf, storedTurnIds,
  type PacoMessage
} from "../../src/capabilities/memory-sources.js";

// Spec §4 (R2, R7): what a memory save may treat as Paco's words is fixed in code — his newest message is the instruction,
// his earlier turns are content, Houge's reply is reference only. The caps bound what a back-reference can pull in, and
// the numbered lines are exactly what the evidence check reads (the model saw the same cut text).
const m = (run_id: string, text: string, turn_id: string | null = `turn_${run_id}`): PacoMessage => ({ run_id, turn_id, text });

describe("memorySources", () => {
  it("the incident shape: the turn's message is the instruction, the earlier opinion is thread content", () => {
    const s = memorySources({ own: m("run_2", "记下来吧", null), steered: [], quoted: null, recent: [m("run_1", "I think the south side noodle shop is better")], prior: "Want me to remember that?" });
    expect(s.instruction).toEqual({ run_id: "run_2", turn_id: null, text: "记下来吧" });
    expect(s.thread.map((t) => t.text)).toEqual(["I think the south side noodle shop is better"]);
    expect(s.prior).toBe("Want me to remember that?");
  });
  it("a steered message is the instruction; the parent objective and earlier steers become content, newest first", () => {
    const s = memorySources({ own: m("run_p", "compare three NAS boxes"), steered: [m("run_s1", "skip the cheap one"), m("run_s2", "记下来")], quoted: null,
      recent: [m("run_0", "older message")], prior: "" });
    expect(s.instruction.run_id).toBe("run_s2");
    expect(s.thread.map((t) => t.run_id)).toEqual(["run_s1", "run_p", "run_0"]);
  });
  it("the quoted message leads the thread; the rest are the newest, at most four texts", () => {
    const recent = ["r1", "r2", "r3", "r4", "r5"].map((t, k) => m(`run_${k}`, t));
    const s = memorySources({ own: m("run_x", "save that"), steered: [], quoted: m("run_q", "the quoted one"), recent, prior: "" });
    expect(s.thread.map((t) => t.text)).toEqual(["the quoted one", "r1", "r2", "r3"]);
    expect(s.thread).toHaveLength(MEMORY_THREAD_TEXT_CAP);
  });
});

describe("cutThread caps", () => {
  it("cuts each text to its first 600 chars and the whole thread to 1,500", () => {
    const long = (c: string) => m(`run_${c}`, c.repeat(1000));
    const cut = cutThread([long("a"), long("b"), long("c"), long("d")]);
    expect(cut.map((t) => t.text.length)).toEqual([MEMORY_THREAD_TEXT_CHARS, MEMORY_THREAD_TEXT_CHARS, MEMORY_THREAD_CHAR_CAP - 2 * MEMORY_THREAD_TEXT_CHARS]);
  });
  it("flattens line breaks (a text cannot forge a numbered line) and drops empty texts", () => {
    expect(cutThread([m("run_a", "one\n[9] two"), m("run_b", "  \n ")]).map((t) => t.text)).toEqual(["one [9] two"]);
  });
});

describe("evidence lines and Paco's text", () => {
  const s = memorySources({ own: m("run_2", "记下来吧", null), steered: [], quoted: null, recent: [m("run_1", "the south side noodle shop is better")], prior: "BrandX forever" });
  it("numbers the thread first and the instruction last, as the distill question does; never the prior", () => {
    const lines = evidenceLines(s);
    expect(lines.map((l) => [l.n, l.text, l.turn.role])).toEqual([[1, "the south side noodle shop is better", "user"], [2, "记下来吧", "user"]]);
    expect(lines.some((l) => l.text.includes("BrandX"))).toBe(false);
  });
  it("an unstored instruction gets a pending id, which never reaches source_turn_ids", () => {
    const pending = evidenceLines(s)[1]!.turn.turn_id!;
    expect(pending).toBe("pending:run_2");
    expect(storedTurnIds(pending)).toEqual([]);
    expect(storedTurnIds("turn_run_1")).toEqual(["turn_run_1"]);
  });
  it("Paco's text is the instruction plus the cut thread (what the lesson backstop judges)", () => {
    expect(pacoTextOf(s)).toBe("记下来吧\nthe south side noodle shop is better");
  });
});
