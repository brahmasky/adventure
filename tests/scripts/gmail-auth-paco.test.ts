import { describe, expect, it } from "vitest";
import { parseEnvText, upsertEnvLine } from "../../scripts/gmail-env.mjs";

// Spec 2026-11-09 §3.1: `gmail-auth.mjs --account paco` writes EXACTLY ONE refresh-token line, replacing an earlier one, because
// the env loader keeps the first value of a name (a second appended line would be silently ignored and the old token kept).
const NAME = "HOUGE_PACO_GMAIL_REFRESH_TOKEN";

describe("upsertEnvLine", () => {
  it("replaces an existing line in place and keeps every other line", () => {
    const before = `A=1\n${NAME}=old\nB=2\n`;
    expect(upsertEnvLine(before, NAME, "new")).toBe(`A=1\n${NAME}=new\nB=2\n`);
  });
  it("appends when absent, with a newline between when the file lacked a trailing one", () => {
    expect(upsertEnvLine("A=1\n", NAME, "t")).toBe(`A=1\n${NAME}=t\n`);
    expect(upsertEnvLine("A=1", NAME, "t")).toBe(`A=1\n${NAME}=t\n`);
    expect(upsertEnvLine("", NAME, "t")).toBe(`${NAME}=t\n`);
  });
  it("leaves exactly one line when the name was duplicated, and never matches a longer name", () => {
    const out = upsertEnvLine(`${NAME}=a\nX=1\n${NAME}=b\n${NAME}_EXTRA=keep\n`, NAME, "z");
    expect(out.split("\n").filter((l) => l.startsWith(`${NAME}=`))).toEqual([`${NAME}=z`]);
    expect(out).toContain(`${NAME}_EXTRA=keep`);
    expect(out).toContain("X=1");
  });
  it("replaces an `export` form too", () => {
    expect(upsertEnvLine(`export ${NAME}=old\n`, NAME, "n")).toBe(`${NAME}=n\n`);
  });
});

describe("parseEnvText", () => {
  it("reads KEY=VALUE, strips matching quotes, skips comments, first value wins", () => {
    expect(parseEnvText(`# c\nA=1\nB="two"\nA=3\n  export C='x y'\nbad line\n`)).toEqual({ A: "1", B: "two", C: "x y" });
  });
});
