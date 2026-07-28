import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // Pulumi mock resource registration can be slow on first run.
    testTimeout: 30_000,
    include: ["test/**/*.test.ts"],
    // Two suites are kept out of the default run, each with its own config:
    //  - the live harness hits a real cloud account and needs credentials
    //    (`npm run test:live`)
    //  - the packaging suite builds and packs a tarball, so it is slow
    //    (`npm run test:package`, also run by prepublishOnly)
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "test/**/*.live.test.ts",
      "test/**/*packaging*.test.ts",
    ],
  },
});
