import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}", "e2e/**/*.e2e.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.{ts,tsx}"],
      // entrypoints / process-boot files are exercised by integration + manual run, not unit-mocked
      exclude: ["src/cli/index.ts", "src/worker/index.ts", "src/supervisor/index.ts", "src/**/*.d.ts"],
    },
  },
});
