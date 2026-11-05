import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(join(import.meta.dirname, "..", "..", "src", "telegram", "telegram-daemon.ts"), "utf8");
const bootPlanners = src.slice(src.indexOf("function bootPlanners"));

describe("boot wiring of the retired Jev flags warning", () => {
  it("bootPlanners calls warnRetiredJevFlags(process.env), the only signal a retired var is still in .env", () => {
    expect(bootPlanners).toMatch(/warnRetiredJevFlags\(process\.env\)/);
  });
  it("the old lane-switch warning is gone from the daemon", () => {
    expect(src).not.toMatch(/warnUnknownJevLanesOff/);
  });
});
