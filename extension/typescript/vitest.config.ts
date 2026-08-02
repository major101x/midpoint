import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    environment: "node",
    // Handlers hold module-level state; run test files serially so an
    // accidental cross-file dependency surfaces rather than flaking.
    fileParallelism: false,
  },
});
