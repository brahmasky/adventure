import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    pool: "threads",
    testTimeout: 10_000,
    setupFiles: ["tests/helpers/setup-no-real-omp.ts"]
  }
});
