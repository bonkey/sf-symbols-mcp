import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "tests/**/*.test.ts",
      "packages/*/src/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      "eval/**/*.test.ts",
    ],
    // Extraction integration tests are macOS-only and skip themselves elsewhere.
    testTimeout: 30_000,
  },
});
