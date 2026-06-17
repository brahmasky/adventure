import { describe, expect, it } from "vitest";
import { canonicalJson, stableHash } from "../../src/domain/canonical.js";

describe("canonicalJson", () => {
  it("sorts object keys recursively", () => {
    const left = { b: 2, a: { d: 4, c: 3 } };
    const right = { a: { c: 3, d: 4 }, b: 2 };

    expect(canonicalJson(left)).toBe(canonicalJson(right));
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonicalJson({ value: Number.NaN })).toThrow(/non-finite number/);
    expect(() => canonicalJson({ value: Number.POSITIVE_INFINITY })).toThrow(/non-finite number/);
  });

  it("rejects unsupported object instances", () => {
    expect(() => canonicalJson(new Date("2026-05-25T00:00:00.000Z"))).toThrow(/unsupported object/);
  });
});

describe("stableHash", () => {
  it("hashes semantically identical objects to the same digest", () => {
    expect(stableHash({ z: 1, a: 2 })).toBe(stableHash({ a: 2, z: 1 }));
  });
});
