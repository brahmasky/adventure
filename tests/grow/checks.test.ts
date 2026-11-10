import { describe, expect, it } from "vitest";
import { bodyHash, checkFields, contentHash, EXEMPLAR_HINT, isSmallUpdate, parseSkillFile, renderSkillFile, type GrowFields } from "../../src/grow/checks.js";

const body = (lines: number): string => Array.from({ length: lines }, (_, i) => `${i + 1}. Step number ${i + 1} of the procedure, written out in full.`).join("\n");
const ok = (over: Partial<GrowFields> = {}): GrowFields => ({ name: "unit-convert", description: "converting recipe amounts between metric and US cups", example: "convert 2 cups of flour to grams", body: body(8), ...over });
const same = (s: string): string => s;
const code = (f: GrowFields, live: Parameters<typeof checkFields>[1] = [], scrub = same): string => { const r = checkFields(f, live, scrub); return r.ok ? "ok" : r.code; };

describe("grow formal checks", () => {
  it("accepts a well-formed skill", () => { expect(code(ok())).toBe("ok"); });

  it("points a rejected author at the exemplar by name", () => {
    expect(EXEMPLAR_HINT).toBe("see the exemplar option-comparison (grow_read it) for the expected shape");
    const r = checkFields(ok({ name: "X" }), [], same);
    expect(!r.ok && r.message.endsWith(EXEMPLAR_HINT)).toBe(true);
  });

  it.each([
    ["bad_name", { name: "Unit Convert" }], ["bad_name", { name: "ab" }],
    ["bad_description", { description: "too short" }], ["bad_description", { description: "line one is long enough\nbut has a newline" }],
    ["bad_example", { example: "short" }], ["bad_body", { body: "tiny" }], ["bad_body", { body: "x".repeat(8001) }]
  ] as const)("rejects with %s, so a malformed item never reaches the index", (want, over) => {
    expect(code(ok(over))).toBe(want);
  });

  it.each([["BEL", "\u0007"], ["NEL", "\u0085"], ["line separator", "\u2028"], ["paragraph separator", "\u2029"]])(
    "rejects %s in a field: it could hide text from a reviewer or break the file format", (_n, ch) => {
      expect(code(ok({ body: `${body(8)}${ch}` }))).toBe("control_chars");
      expect(code(ok({ description: `converting recipe amounts${ch}between metric and US cups` }))).toBe("control_chars");
    });

  it("rejects when the redactor would change a field, and never echoes the matched text", () => {
    const r = checkFields(ok({ body: `${body(8)}\nuse token sk-abc123` }), [], (s) => s.replace("sk-abc123", "‹secret›"));
    expect(r).toEqual({ ok: false, code: "secret_shape", message: "a field contains something shaped like a secret or a secret path; remove it" });
  });

  it("rejects a fenced code block of more than three lines: exact steps belong in a script, which 1a does not accept", () => {
    const fenced = "```sh\ncurl a\ncurl b\ncurl c\ncurl d\n```";
    expect(code(ok({ body: `${body(8)}\n${fenced}` }))).toBe("needs_script");
    expect(code(ok({ body: `${body(8)}\n\`\`\`\none\ntwo\nthree\n\`\`\`` }))).toBe("ok");
  });

  it("covers ~~~ fences and unclosed fences, and spares a block marked as prose", () => {
    const six = "a\nb\nc\nd\ne\nf";
    expect(code(ok({ body: `${body(8)}\n\`\`\`text\n${six}\n\`\`\`` }))).toBe("ok");
    expect(code(ok({ body: `${body(8)}\n~~~sh\na\nb\nc\nd\ne\n~~~` }))).toBe("needs_script");
    expect(code(ok({ body: `${body(8)}\n\`\`\`sh\na\nb\nc\nd\ne` }))).toBe("needs_script");
  });

  it("rejects the same body under another name and description, but not an update of the item itself", () => {
    const f = ok();
    const other = ok({ name: "other-skill", description: "something else entirely here, for other uses" });
    const hashOf = (g: GrowFields) => ({ name: g.name, description: g.description, body_hash: bodyHash(g) });
    expect(code(f, [hashOf(other)])).toBe("duplicate");            // same body
    expect(code(f, [hashOf(ok({ name: "other-skill", description: "something else entirely here, for other uses", body: body(9) })), ])).toBe("ok");
    expect(code(f, [{ name: "other-skill", description: "Converting recipe amounts between metric and US cups ", body_hash: "x" }])).toBe("duplicate");
    expect(code(f, [hashOf(f)])).toBe("ok");
  });

  it("accepts quotes, backslashes and a trailing newline, which survive the skill file format", () => {
    expect(code(ok({ description: 'when asked about "cups" or C:\\temp paths in recipes', body: `${body(8)}\n` }))).toBe("ok");
  });

  it.each([
    ["nine anchors", Array.from({ length: 9 }, (_, i) => `fact ${i}`)],
    ["a 301-char anchor", ["x".repeat(301)]],
    ["an anchor with a newline", ["line one\nline two"]]
  ])("rejects %s with bad_anchors", (_n, anchors) => { expect(code(ok({ anchors }))).toBe("bad_anchors"); });

  it("rejects a body that is under 8000 chars but over 16 KB serialized (CJK is three bytes a char)", () => {
    expect(code(ok({ body: "字".repeat(8000) }))).toBe("too_large");
  });

  it("scrubs every field, not only the body", () => {
    const hit = (s: string): string => s.replace("SECRETVALUE", "‹x›");
    expect(code(ok({ anchors: ["the key is SECRETVALUE here"] }), [], hit)).toBe("secret_shape");
    expect(code(ok({ description: "converting amounts, key SECRETVALUE included" }), [], hit)).toBe("secret_shape");
  });

  it.each([["right-to-left override", "\u202e"], ["zero-width space", "\u200b"], ["byte order mark", "\ufeff"], ["bidi isolate", "\u2066"]])(
    "rejects %s, which hides text from a reviewer", (_n, ch) => { expect(code(ok({ body: `${body(8)}${ch}` }))).toBe("control_chars"); });

  it("keeps the zero-width joiner, which emoji sequences need", () => {
    expect(code(ok({ body: `${body(8)}\n👨\u200d👩\u200d👧 family` }))).toBe("ok");
  });

  it("a small update is at most 20 changed lines and a quarter of the body, with description and example untouched", () => {
    const prev = ok({ body: body(40) });
    const edit = (n: number): GrowFields => ({ ...prev, body: prev.body.split("\n").map((l, i) => (i < n ? `${l} (edited)` : l)).join("\n") });
    expect(isSmallUpdate(prev, edit(10))).toBe(true);
    expect(isSmallUpdate(prev, edit(11))).toBe(false);          // 11 of 40 lines is over 25%
    expect(isSmallUpdate(ok({ body: body(200) }), { ...ok({ body: body(200) }), body: body(200).split("\n").map((l, i) => (i < 21 ? `${l}!` : l)).join("\n") })).toBe(false);
    expect(isSmallUpdate(prev, { ...edit(1), description: "a different description of this skill" })).toBe(false);
    expect(isSmallUpdate(prev, { ...edit(1), example: "a different example request" })).toBe(false);
  });

  it("reordering every step is not a small update", () => {
    const prev = ok({ body: body(40) });
    expect(isSmallUpdate(prev, { ...prev, body: prev.body.split("\n").reverse().join("\n") })).toBe(false);
  });

  it("renders and parses back to the same fields and origin (the file is the only content truth)", () => {
    const f = ok({ anchors: ["1 US cup is 236.6 mL"] });
    expect(parseSkillFile(renderSkillFile(f, "untrusted"))).toEqual({ ...f, origin: "untrusted" });
    expect(parseSkillFile("no frontmatter")).toBeNull();
  });

  it("the hash ignores origin, so trusting an item does not look like a content change", () => {
    expect(contentHash(ok())).toBe(contentHash(ok()));
    expect(contentHash(ok())).not.toBe(contentHash(ok({ example: "convert 3 cups of sugar to grams" })));
  });
});
