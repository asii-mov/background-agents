import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/**/*.test.ts",
      "guard/**/*.test.ts",
      "dispatcher/**/*.test.ts",
      "test/**/*.test.ts",
    ],
  },
});
