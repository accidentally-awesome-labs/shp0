import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // pg + node APIs play best in the forks pool
    pool: "forks",
    // All test files share one test DB — run them sequentially to avoid races.
    fileParallelism: false,
    testTimeout: 15000,
  },
});
