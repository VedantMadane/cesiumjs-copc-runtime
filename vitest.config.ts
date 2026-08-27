import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["e2e/**", "**/node_modules/**", "**/dist/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/index.ts", "**/decoder-worker.ts"],
      thresholds: {
        statements: 45,
        branches: 65,
        functions: 75,
        lines: 45,
      },
    },
  },
});
