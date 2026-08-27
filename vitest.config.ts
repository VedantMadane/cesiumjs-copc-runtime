import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "cesiumjs-copc": fileURLToPath(
        new URL("./packages/cesium-copc/src/index.ts", import.meta.url),
      ),
      "cesiumjs-copc-analysis": fileURLToPath(
        new URL("./packages/copc-analysis/src/index.ts", import.meta.url),
      ),
      "cesiumjs-copc-core": fileURLToPath(
        new URL("./packages/copc-core/src/index.ts", import.meta.url),
      ),
      "cesiumjs-copc-runtime": fileURLToPath(
        new URL("./packages/copc-runtime/src/index.ts", import.meta.url),
      ),
      "cesiumjs-copc-worker": fileURLToPath(
        new URL("./packages/copc-worker/src/index.ts", import.meta.url),
      ),
    },
  },
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
