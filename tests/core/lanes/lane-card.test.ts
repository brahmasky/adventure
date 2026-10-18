import { describe, expect, it } from "vitest";
import { DIG_DEEPER_TEXT, digDeeperButton, flattenLinks, laneCard, laneSavedNote, sanitizeLaneText } from "../../../src/core/lanes/lane-card.js";
import { parseAttachments } from "../../../src/omp/planner-supervisor.js";

// Stage B §3 and §6: a lane reply is text only, ends with Dig deeper (Paco's way to the planner), and never carries a masked
// link: a label that hides its URL is how a web-derived reply could point Paco somewhere else.
const RUN = "run_12345678-1234-1234-1234-123456789abc";
describe("laneCard", () => {
  it("ends with one Dig deeper button whose callback re-asks this run, inside Telegram's 64 bytes", () => {
    const c = laneCard({ text: "放在书房更好。", run_id: RUN })!;
    expect(c).toEqual({ text: "放在书房更好。", buttons: [{ text: DIG_DEEPER_TEXT, data: `lane:ask:${RUN}` }] });
    expect(Buffer.byteLength(c.buttons[0]!.data, "utf8")).toBeLessThanOrEqual(64);
  });
  it("flattens markdown links to label (url), or the bare url when the label is the url", () => {
    expect(flattenLinks("see [BOM](https://bom.gov.au/nsw) now")).toBe("see BOM (https://bom.gov.au/nsw) now");
    expect(flattenLinks("[https://a.example/x](https://a.example/x)")).toBe("https://a.example/x");
    // the renderer links ANY scheme without whitespace (markdown-to-telegram-html.ts step 3), so a non-http link must flatten too
    expect(flattenLinks("open [me](tg://resolve?domain=x)")).toBe("open me (tg://resolve?domain=x)");
    expect(flattenLinks("[x](javascript:alert(1))")).toBe("x (javascript:alert(1))");
    // a nested link unwraps fully: one pass would leave `[BOM (https://bom.gov.au)](https://evil.example)`, a masked link
    expect(flattenLinks("[[BOM](https://bom.gov.au)](https://evil.example)")).toBe("BOM (https://bom.gov.au) (https://evil.example)");
    expect(flattenLinks("[[[a](x://1)](x://2)](x://3)")).toBe("a (x://1) (x://2) (x://3)");
    // any depth: no pass cap, the loop runs until nothing changes (each pass strictly shortens the text)
    const deep = Array.from({ length: 8 }, (_, k) => k).reduce((acc, k) => `[${acc}](x://${k})`, "a");
    expect(flattenLinks(deep)).not.toMatch(/\]\(/);
  });

  it("a reply that is only an attach marker leaves no card: the caller falls through as empty_reply", () => {
    expect(laneCard({ text: "[[attach:/tmp/x.txt]]", run_id: "run_1" })).toBeNull();
    expect(laneCard({ text: "  [[attach:a]]\n[[attach:b]]  ", run_id: "run_1" })).toBeNull();
    expect(laneCard({ text: "[here](https://evil.example/x)", run_id: RUN })!.text).toBe("here (https://evil.example/x)");
  });
  it("strips [[attach:…]] markers (a lane reply never attaches a file)", () => {
    expect(laneCard({ text: "done [[attach:report.pdf]]", run_id: RUN })!.text).toBe("done");
  });
  // The supervisor parses [[attach:…]] from every final text (planner-supervisor finishSuccess), lane replies included: a marker
  // re-formed by the strip or by link flattening would attach a workspace file.
  it("leaves no attach marker behind when stripping or flattening re-forms one", () => {
    const a = laneCard({ text: "x [[att[[attach:x]]ach:y]] z", run_id: RUN })!.text;
    expect(a).not.toContain("[[attach:");
    expect(a).toContain("x ");
    expect(a).toContain(" z");
    expect(laneCard({ text: "k [[attach:[f](u)]] m", run_id: RUN })!.text).not.toContain("[[attach:");
  });
  it("edge cases: whitespace-only and note-only leave no card; an empty-label link is its url", () => {
    expect(laneCard({ text: " \n ", run_id: RUN })).toBeNull();
    expect(laneCard({ text: "", run_id: RUN, note: laneSavedNote({ lesson: { id: 1, theme: "t" } }) })).toBeNull();
    expect(flattenLinks("[ ](https://a.example)")).toBe("https://a.example");
  });
  it("appends the note line after a blank line when a rule saved this turn", () => {
    expect(laneCard({ text: "明天晴。", run_id: RUN, note: laneSavedNote({ lesson: { id: 51, theme: "format" } }) })!.text).toBe("明天晴。\n\n📒 Saved lesson #51 · format");
  });
  it("a saved fact adds its own line (spec §8)", () => expect(laneSavedNote({ lesson: { id: 51, theme: "format" }, fact: { id: 198 } })).toBe("📒 Saved lesson #51 · format\n🧠 Saved fact (事实) #198"));
  it("refuses callback data past 64 bytes", () => {
    expect(() => digDeeperButton(`run_${"x".repeat(60)}`)).toThrow(/64 bytes/);
  });
});

// The supervisor attaches any workspace file named by a line its own parser accepts; a lane reply (composed over web pages)
// must carry none, including a path with `]` in it that a naive marker regex misses.
describe("sanitizeLaneText vs the supervisor's attach parser", () => {
  it.each([
    ["alone on a line", "hello\n[[attach:report]final.txt]]\nbye"],
    ["inline", "see [[attach:report]final.txt]] here"],
    ["indented with spaces", "  [[attach:  a]b.txt  ]]  "],
    ["re-formed by the strip", "[[attach:a]b.txt[[attach:x]]]]"]
  ])("leaves nothing parseAttachments would attach: %s", (_n, text) => {
    expect(parseAttachments(sanitizeLaneText(text), "/ws").attachments).toEqual([]);
    expect(parseAttachments(sanitizeLaneText(text), "/ws").text).toBe(sanitizeLaneText(text));
  });
});
