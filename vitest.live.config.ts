import { defineConfig } from "vitest/config";

/** Only used by `npm run test:live`. Includes the live example harness that
 * the default config deliberately excludes. */
export default defineConfig({
  test: {
    globals: true,
    testTimeout: 300_000,
    hookTimeout: 300_000,
    include: ["test/**/*.live.test.ts"],
  },
});
