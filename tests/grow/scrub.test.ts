import { describe, expect, it } from "vitest";
import { fieldScrub } from "../../src/grow/checks.js";

const scrub = fieldScrub({ redactSecretValues: (s) => s });
const steps = "1. Step number 1 of the procedure, written out in full.\n2. Step number 2 of the procedure, written out in full.\n3. Step number 3 of the procedure, written out in full.";

describe("fieldScrub", () => {
  it.each([
    "~/.ssh/id_ed25519", "/Users/paco/.claude/settings.json", "read the .env file", "read .env.local",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345"
  ])("changes %s, so a secret never lands in a skill", (s) => { expect(scrub(s)).not.toBe(s); });

  it.each([
    "https://www.nrc.gov/reactors/new-reactors/smr.html", "add 1000000 grams of water", "copy .env.example to start", steps
  ])("leaves ordinary text alone: %s", (s) => { expect(scrub(s)).toBe(s); });
});
