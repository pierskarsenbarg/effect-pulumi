import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // Pulumi mock resource registration can be slow on first run.
    testTimeout: 30_000,
    include: ["test/**/*.test.ts"],
    // The live harness hits a real cloud account and needs credentials, so it
    // is never part of the default run — `npm run test:live` uses its own
    // config that includes it.
    exclude: ["**/node_modules/**", "**/dist/**", "test/**/*.live.test.ts"],
  },
});
