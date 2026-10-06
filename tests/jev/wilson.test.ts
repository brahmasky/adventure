import { describe, expect, it } from "vitest";
import { wilsonLower } from "../../src/jev/wilson.js";

// Spec §1.1/§5.9: bars are reported with the lower bound the sample can prove; 90% on n=60 proves ~80%.
describe("wilsonLower", () => {
  it("matches the textbook values", () => {
    expect(wilsonLower(54, 60)!).toBeCloseTo(0.797, 2);
    expect(wilsonLower(36, 36)!).toBeCloseTo(0.904, 2);
    expect(wilsonLower(29, 36)!).toBeCloseTo(0.654, 2);
    expect(wilsonLower(0, 0)).toBeNull();
    expect(wilsonLower(0, 10)!).toBe(0);
  });
});
