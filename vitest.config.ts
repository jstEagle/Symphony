import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const source = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@symphony/config": source("./packages/config/src/index.ts"),
      "@symphony/drivers": source("./packages/drivers/src/index.ts"),
      "@symphony/plugins": source("./packages/plugins/src/index.ts"),
      "@symphony/protocol": source("./packages/protocol/src/index.ts"),
      "@symphony/runtime": source("./packages/runtime/src/index.ts"),
      "@symphony/storage": source("./packages/storage/src/index.ts"),
      "@symphony/workflow": source("./packages/workflow/src/index.ts"),
      "@": source("./apps/web/src"),
    },
  },
  test: {
    environment: "node",
    setupFiles: [source("./tests/setup.ts")],
    env: {
      SYMPHONY_DAEMON_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
    include: ["tests/**/*.test.ts", "packages/**/*.test.ts", "apps/web/**/*.test.ts"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
    },
  },
});
