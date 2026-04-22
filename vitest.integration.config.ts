import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    reporters: ["default"],
    // Integration tests share a DB. Serialize them to avoid cross-test row collisions.
    pool: "forks",
    fileParallelism: false,
  },
});
