import { describe, expect, it } from "vitest";
import { NO_OMP_BIN } from "../helpers/omp-env.js";

describe("hermetic omp default (every suite)", () => {
  it("a suite that never pins the omp env still cannot reach a real omp on PATH", () => {
    expect(process.env.HOUGE_OMP_BIN).toBe(NO_OMP_BIN);
  });
});
