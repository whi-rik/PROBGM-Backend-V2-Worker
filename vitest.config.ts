import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    exclude: ["tests/integration/**", "node_modules/**"],
    reporters: ["default"],
  },
});
