import { describe, expect, it } from "vitest";
import { fieldScrub } from "../../src/grow/checks.js";

const scrub = fieldScrub({ redactSecretValues: (s) => s });
const steps = "1. Step number 1 of the procedure, written out in full.\n2. Step number 2 of the procedure, written out in full.\n3. Step number 3 of the procedure, written out in full.";

describe("fieldScrub", () => {
  it.each([
    "~/.ssh/id_ed25519", "/Users/paco/.claude/settings.json", "read the .env file", "read .env.local",
    "read .env.", "see .env!", "edit .env.local.", "~/.ssh.", "~/.ssh?", "Credentials live in ~/.aws.", "${HOME}/.ssh/id_rsa",
    "/home/paco/.ssh/id_rsa", "the .ENV file", "~/.claude.json", "read .env.production",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345"
  ])("changes %s, so a secret never lands in a skill", (s) => { expect(scrub(s)).not.toBe(s); });

  it.each([
    "https://www.nrc.gov/reactors/new-reactors/smr.html", "add 1000000 grams of water", "copy .env.example to start", "copy .env.example to start.", "see .env.sample, then", "use the environment variables", "an event.env property", steps
  ])("leaves ordinary text alone: %s", (s) => { expect(scrub(s)).toBe(s); });

  // A secret split by an invisible character, or spelled in compatibility forms, still reads as the secret: the scrub
  // looks at the text a reader sees, so it does not depend on the door refusing those characters first.
  const token = `ghp_${"A1b2C3d4E5".repeat(3)}abcdef`;
  it.each([
    ["the plain token (control)", `use ${token} here`],
    ["a token with a soft hyphen inside", `use ${token.slice(0, 10)}\u00ad${token.slice(10)} here`],
    ["a home secret path with a soft hyphen", "read ~/.s\u00adsh/id_rsa first"],
    ["a dotenv path with a joiner", "open the .\u200denv file"],
    ["a fullwidth home secret path", "read ~/\uff0e\uff53\uff53\uff48/id_rsa first"],
    ["a fullwidth token", `use ${[...token].map((c) => String.fromCodePoint(c.codePointAt(0)! + 0xfee0)).join("")} here`]
  ])("changes %s", (_n, s) => { expect(scrub(s)).not.toBe(s); });

  it.each(["wait\u2026 then stir", "\u00bd cup at 200\u00b0C", "a\u00a0b non-breaking", "\uff21\uff22\uff23 fullwidth letters", "3 m\u00b2 of floor", "\ufb01ne ligature"])(
    "leaves text whose compatibility form differs but holds no secret alone: %s", (s) => { expect(scrub(s)).toBe(s); });
});
