import path from "node:path";
import { defineConfig } from "vitest/config";

// Declares the "@/" alias for vitest and stubs required env vars for server-module imports.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    env: {
      OAUTH_CLIENT_ID: "test-client-id",
      OAUTH_CLIENT_SECRET: "test-client-secret",
      OAUTH_SCOPES: "read:self",
      SESSION_SECRET: "test-session-secret-0123456789",
      FAL_KEY: "test-fal-key",
      GROQ_API_KEY: "test-groq-key",
    },
  },
});
