import { defineConfig } from "vitest/config";

/** Only used by `npm run test:package`. This suite builds and packs the
 * library, so it is kept out of the default run. */
export default defineConfig({
  test: {
    globals: true,
    testTimeout: 300_000,
    hookTimeout: 300_000,
    include: ["test/**/*packaging*.test.ts"],
    // The packed consumer projects are compiled by tsc, not vitest.
    fileParallelism: false,
  },
});
