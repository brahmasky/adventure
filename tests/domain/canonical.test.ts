import { describe, expect, it } from "vitest";
import { canonicalJson, stableHash } from "../../src/domain/canonical.js";

describe("canonicalJson", () => {
  it("sorts object keys recursively", () => {
    const left = { b: 2, a: { d: 4, c: 3 } };
    const right = { a: { c: 3, d: 4 }, b: 2 };

    expect(canonicalJson(left)).toBe(canonicalJson(right));
  });
});

describe("stableHash", () => {
  it("hashes semantically identical objects to the same digest", () => {
    expect(stableHash({ z: 1, a: 2 })).toBe(stableHash({ a: 2, z: 1 }));
  });
});
