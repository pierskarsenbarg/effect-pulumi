import { createHash } from "node:crypto";
import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { deploy, teardownStack } from "../src/index.js";
import { inlineProgram } from "./random-password-file-program.js";

// Gate: only run when explicitly opted in, since this hits a real cloud
// account and needs live credentials in the environment.
// const liveTestsEnabled = process.env.EFFECT_PULUMI_RUN_LIVE_TESTS !== "1";
// const describeLive = liveTestsEnabled ? describe : describe.skip;

describe("random-password-file program (live, real Automation API deploy)", () => {
  it.effect(
    "deploys against real providers, resolves outputs, and tears down cleanly",
    () => {
      // Unique per run so repeated/parallel runs don't collide on stack
      // name - swap for whatever naming convention fits your CI.
      const stackName = `test-${Date.now()}`;
      const envName = `live-test-${Date.now()}`;

      // Stream the CLI's output. A live deploy runs for minutes, and when it
      // fails this is the only thing that explains why - the thrown error
      // alone rarely does. Kept inline next to the `deploy` call it belongs
      // to; this doubles as the example of how to wire progress output.
      // oxlint-disable-next-line unicorn/consistent-function-scoping
      const onOutput = (out: string) => process.stdout.write(out);

      const managedDeploy = Effect.acquireRelease(
        deploy({
          stackName,
          projectName: "effect-pulumi-examples",
          program: inlineProgram(envName),
          up: { onOutput },
        }),
        // Cleanup always runs on scope close, success or failure. Destroy
        // *and* remove: the stack name is unique per run, so destroying
        // alone would leave a trail of empty stacks in the backend. Any
        // teardown failure is ignored so it never masks a real assertion
        // failure.
        ({ stack }) =>
          teardownStack(stack, { destroy: { onOutput } }).pipe(Effect.ignore)
      );

      return Effect.scoped(
        Effect.gen(function* () {
          const { result } = yield* managedDeploy;

          expect(result.summary.result).toBe("succeeded");
          expect(result.outputs.fileName?.value).toContain(`${envName}-file`);

          // `contentSha256` is computed by the provider from the file it
          // actually wrote, not supplied by the program - matching it against
          // an independently computed hash of the password is what confirms
          // the RandomPassword -> File dependency really ran, rather than
          // just checking that a value we handed in comes back unchanged.
          expect(result.outputs.contentSha256?.value).toEqual(
            createHash("sha256")
              .update(result.outputs.password?.value)
              .digest("hex")
          );
        })
      );
    },
    { timeout: 300_000 } // real cloud deploys are slow - default test timeout won't cut it
  );
});
