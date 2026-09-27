import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Tests run fully offline: in-memory database, simulated YouTube/Instagram, emails to the log.
    env: {
      DATABASE_URL: "memory://",
      DRY_RUN: "true",
      SESSION_SECRET: "test-session-secret-test-session-secret",
      ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      ALLOWED_EMAILS: "member@example.com",
      APP_URL: "http://localhost:3000",
    },
  },
});
