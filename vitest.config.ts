import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { environment: "node", include: ["tests/**/*.test.{ts,tsx}", "e2e/**/*.e2e.test.{ts,tsx}"] },
});
