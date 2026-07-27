import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { deploy, destroyStack } from "../src/index.js";
import { inlineProgram } from "../examples/s3-bucket.js";

// Gate: only run when explicitly opted in, since this hits a real cloud
// account and needs live credentials in the environment.
const liveTestsEnabled = process.env.EFFECT_PULUMI_RUN_LIVE_TESTS === "1";
const describeLive = liveTestsEnabled ? describe : describe.skip;

describeLive("examples (live, real Automation API deploy)", () => {
  it.effect(
    "s3-bucket example deploys, resolves outputs, and tears down cleanly",
    () => {
      // Unique per run so repeated/parallel runs don't collide on stack
      // name — swap for whatever naming convention fits your CI.
      const stackName = `test-${Date.now()}`;
      const envName = `live-test-${Date.now()}`;

      const managedDeploy = Effect.acquireRelease(
        deploy({
          stackName,
          projectName: "effect-pulumi-examples",
          program: inlineProgram(envName),
        }),
        // Cleanup always runs on scope close, success or failure. Ignore
        // any destroy failure so it never masks the real assertion failure.
        ({ stack }) => destroyStack(stack).pipe(Effect.ignore)
      );

      return Effect.scoped(
        Effect.gen(function* () {
          const { result } = yield* managedDeploy;

          expect(result.summary.result).toBe("succeeded");
          expect(result.outputs.bucketId?.value).toContain(`${envName}-assets`);
          expect(result.outputs.objectUrl?.value).toContain(
            `${envName}-readme.txt`
          );
        })
      );
    },
    { timeout: 300_000 } // real cloud deploys are slow — default test timeout won't cut it
  );
});
