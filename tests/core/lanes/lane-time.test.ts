import { describe, expect, it } from "vitest";
import { LATE, within } from "../../../src/core/lanes/lane-time.js";

// Stage B §5/§8: the search and fetch adapters take no signal, so the lane races them: a result past its bound or after a
// /kill must never be used, and the lane must return within its bounds whatever the provider does.
describe("within", () => {
  const never = new Promise<string>(() => {});
  it("passes a value that arrives in time", async () => expect(await within(1_000, Promise.resolve("v"), new AbortController().signal)).toBe("v"));
  it("is LATE once the bound passes", async () => expect(await within(10, never, new AbortController().signal)).toBe(LATE));
  it("is LATE when the turn aborts first", async () => {
    const ctl = new AbortController();
    const r = within(10_000, never, ctl.signal);
    ctl.abort();
    expect(await r).toBe(LATE);
  });
  it("is LATE at once on an already-aborted signal, and a later rejection stays handled", async () => {
    const ctl = new AbortController(); ctl.abort();
    expect(await within(10_000, Promise.reject(new Error("late")), ctl.signal)).toBe(LATE);
  });
});
