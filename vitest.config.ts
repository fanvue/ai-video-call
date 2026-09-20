import path from "node:path";
import { defineConfig } from "vitest/config";

// Mirrors tsconfig's "@/*" -> "./src/*" path alias, which plain vitest doesn't read on its own.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
