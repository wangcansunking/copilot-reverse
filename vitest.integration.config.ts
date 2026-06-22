import { defineConfig } from "vitest/config";
// Separate config for LIVE integration tests (hit real Copilot endpoints). Not part of the default
// `npm test` run — invoke with `npm run test:integration`. Auto-skips when no GitHub login is on disk.
export default defineConfig({
  test: {
    environment: "node",
    include: ["e2e/**/*.integration.test.{ts,tsx}"],
    testTimeout: 45_000,
  },
});
