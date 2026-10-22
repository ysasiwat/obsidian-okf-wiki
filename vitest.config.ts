import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    // Fixture-wide tests take ~1 s alone but exceeded the 5 s default when the machine or CI runner was busy.
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/core/**"],
    },
  },
});
