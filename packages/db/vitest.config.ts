import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // pg + node APIs play best in the forks pool
    pool: "forks",
    testTimeout: 15000,
  },
});
