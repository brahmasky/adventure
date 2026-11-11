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

  // Each of these renders as nothing (or as nothing visible) and can hide text from the reviewer or split a secret's
  // shape so the scrub misses it. The table spans every class the door refuses, at its range ends.
  it.each([
    ["tag character (start)", "\u{E0001}"], ["tag character (letter)", "\u{E0041}"], ["tag character (cancel)", "\u{E007F}"],
    ["variation selector 1", "\ufe00"], ["variation selector 16", "\ufe0f"], ["supplementary variation selector", "\u{E0100}"], ["last supplementary variation selector", "\u{E01EF}"],
    ["soft hyphen", "\u00ad"], ["zero-width joiner", "\u200d"], ["left-to-right mark", "\u200e"], ["right-to-left mark", "\u200f"],
    ["Arabic letter mark", "\u061c"], ["function application", "\u2061"], ["invisible plus", "\u2064"], ["Mongolian vowel separator", "\u180e"],
    ["Hangul filler", "ㅤ"], ["Hangul choseong filler", "ᅟ"], ["Hangul jungseong filler", "ᅠ"], ["halfwidth Hangul filler", "ﾠ"],
    ["interlinear annotation anchor", "\ufff9"], ["interlinear annotation terminator", "\ufffb"],
    ["C1 control (first)", "\u0080"], ["C1 control (last)", "\u009f"], ["inhibit symmetric swapping", "\u206a"], ["nominal digit shapes", "\u206f"],
    ["bare carriage return", "\r"], ["private-use character", "\ue000"], ["unassigned code point", "\u0378"], ["lone surrogate", "\ud800"],
    ["combining grapheme joiner", "\u034f"], ["Khmer inherent vowel AQ", "\u17b4"], ["Khmer inherent vowel AA", "\u17b5"],
    ["Mongolian free variation selector 1", "\u180b"], ["Mongolian free variation selector 3", "\u180d"], ["Mongolian free variation selector 4", "\u180f"],
    ["Braille blank", "\u2800"], ["musical null notehead", "\u{1D159}"], ["Khitan filler", "\u{16FE4}"], ["Hangul-Hanja tone mark area (default ignorable)", "\u{1BCA0}"]
  ])("rejects %s in any field", (_n, ch) => {
    expect(code(ok({ body: `${body(8)}\nsee th${ch}is step` }))).toBe("control_chars");
    expect(code(ok({ anchors: [`a fact${ch} here`] }))).toBe(ch === "\r" ? "bad_anchors" : "control_chars");   // a one-line field refuses \r first
  });

  it("keeps newline and tab in the body, and ordinary non-ASCII text", () => {
    expect(code(ok({ body: `${body(8)}\n\tindented note: 200 °C, ½ cup, café, 猴哥, m²` }))).toBe("ok");
  });

  it("rejects an emoji sequence and says so: the joiner and the variation selector are not allowed", () => {
    for (const s of ["\u{1F468}\u200d\u{1F469}\u200d\u{1F467} family", "red ❤\ufe0f heart"]) {
      const r = checkFields(ok({ body: `${body(8)}\n${s}` }), [], same);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.code).toBe("control_chars");
      expect(!r.ok && r.message).toMatch(/emoji sequences are not allowed/);
    }
  });

  it("names the class of the refused character, never the character itself", () => {
    const msg = (ch: string): string => { const r = checkFields(ok({ body: `${body(8)}\nx${ch}y` }), [], same); return r.ok ? "" : r.message; };
    expect(msg("\u0007")).toMatch(/a control character/);
    expect(msg("\u200b")).toMatch(/an invisible format character/);
    expect(msg("\ufe0f")).toMatch(/a variation selector/);
    expect(msg("ㅤ")).toMatch(/an invisible filler/);
    expect(msg("\u2028")).toMatch(/a line or paragraph separator/);
    expect(msg("\ue000")).toMatch(/a private-use character/);
    expect(msg("\u0378")).toMatch(/an unassigned code point/);
    expect(msg("\u034f")).toMatch(/an invisible default-ignorable character/);
    expect(msg("\u2800")).toMatch(/an invisible filler or blank character/);
    expect(msg("\u180b")).toMatch(/a variation selector/);
    expect(msg("\u200b")).not.toContain("\u200b");
  });

  // A small update goes live unreviewed, so each of its four bounds must bite on its own. The changed characters are
  // the removed plus the added lines' lengths.
  describe("a small update", () => {
    const prev = ok({ body: body(40) });                  // 2,301 chars, 40 lines of 55-57
    const edit = (f: GrowFields, n: number, at = (l: string) => `${l} (edited)`): GrowFields => ({ ...f, body: f.body.split("\n").map((l, i) => (i < n ? at(l) : l)).join("\n") });
    /** `short` one-char lines, then `long` lines of exactly 100 chars: line bounds and character bounds pulled apart. */
    const mixed = (short: number, long: number): GrowFields => ok({ body: [...Array.from({ length: short }, () => "s"), ...Array.from({ length: long }, (_, i) => `${String(i).padStart(3, "0")} ${"x".repeat(96)}`)].join("\n") });
    const flip = (l: string): string => (l === "s" ? "t" : `${l.slice(0, 4)}${"y".repeat(96)}`);

    it("is at most 20 changed lines, whatever their share", () => {
      const f = mixed(30, 70);                              // 100 lines: the 25% line share would allow 25
      expect(isSmallUpdate(f, edit(f, 20, flip))).toBe(true);
      expect(isSmallUpdate(f, edit(f, 21, flip))).toBe(false);   // 42 changed chars: only the 20-line cap bites
    });

    it("is at most a quarter of the lines", () => {
      const f = mixed(15, 25);                              // 40 lines, 2,554 chars
      expect(isSmallUpdate(f, edit(f, 10, flip))).toBe(true);
      expect(isSmallUpdate(f, edit(f, 11, flip))).toBe(false);   // 22 changed chars: only the line share bites
    });

    it("changes at most a quarter of the old body's characters", () => {
      expect(isSmallUpdate(prev, edit(prev, 4))).toBe(true);     // 476 changed chars of 2,262 (newlines not counted)
      expect(isSmallUpdate(prev, edit(prev, 5))).toBe(false);    // 595 > a quarter of 2,262, yet 5 lines and under 800
    });

    it("changes at most 800 characters, however long the body", () => {
      const f = mixed(0, 70);                               // 7,000 chars: a quarter would allow 1,750
      expect(isSmallUpdate(f, edit(f, 4, flip))).toBe(true);     // 4 x (100 + 100) = 800
      expect(isSmallUpdate(f, edit(f, 5, flip))).toBe(false);    // 1,000 changed chars in 5 of 70 lines
    });

    it("finds the alignment across a shift of 20 inserted lines, and is fast on an 8,000-line body", () => {
      const lines = Array.from({ length: 100 }, (_, i) => `l${i}`);
      const f = ok({ body: lines.join("\n") });
      expect(isSmallUpdate(f, { ...f, body: [...Array.from({ length: 20 }, () => "x"), ...lines].join("\n") })).toBe(true);
      expect(isSmallUpdate(f, { ...f, body: [...lines.slice(0, 50), ...Array.from({ length: 20 }, () => "x"), ...lines.slice(50)].join("\n") })).toBe(true);
      expect(isSmallUpdate(f, { ...f, body: [...Array.from({ length: 21 }, () => "x"), ...lines].join("\n") })).toBe(false);
      const t0 = performance.now();
      isSmallUpdate(ok({ body: `${"\n".repeat(7999)}a` }), ok({ body: `b${"\n".repeat(7999)}` }));
      isSmallUpdate(ok({ body: Array.from({ length: 4000 }, (_, i) => String(i % 7)).join("\n") }), ok({ body: Array.from({ length: 4000 }, (_, i) => String((i + 3) % 7)).join("\n") }));
      expect(performance.now() - t0).toBeLessThan(300);   // the door answers in milliseconds (spec 5.3); a full table took 1.65 s
    });

    it("is not two lines swapped for 7,000 characters (the reviewers' probe)", () => {
      expect(isSmallUpdate(prev, edit(prev, 2, () => "z".repeat(3500)))).toBe(false);
    });

    it("leaves description and example untouched", () => {
      expect(isSmallUpdate(prev, { ...edit(prev, 1), description: "a different description of this skill" })).toBe(false);
      expect(isSmallUpdate(prev, { ...edit(prev, 1), example: "a different example request" })).toBe(false);
    });

    it("is not an anchors-only change: an anchor is a fact the item asserts, and a new fact needs review", () => {
      const anchored = ok({ body: body(40), anchors: ["1 US cup is 236.6 mL"] });
      expect(isSmallUpdate(anchored, { ...anchored, anchors: ["1 US cup is 240 mL"] })).toBe(false);
      expect(isSmallUpdate(anchored, { ...anchored, anchors: [] })).toBe(false);
      expect(isSmallUpdate(anchored, { ...anchored })).toBe(true);
    });
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
