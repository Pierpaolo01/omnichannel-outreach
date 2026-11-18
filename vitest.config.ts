import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    environment: "node",
    // Forks, not threads: the generated sequence runs keep a worker busy with synchronous SQLite
    // work for long stretches, which made thread workers miss the runner's RPC deadline.
    pool: "forks",
  },
});
