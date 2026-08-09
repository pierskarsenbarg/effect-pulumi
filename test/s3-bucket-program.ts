/**
 * Shared fixture: a small S3 program that uses the parts of the library the
 * `@pulumi/random` examples cannot reach - `fromOutput`/`fromOutputs`, an
 * Effect passed into a resource's args, and one resource depending on
 * another's Output.
 *
 * Deliberately not named `*.test.ts`: vitest's `include` globs would try to
 * collect it as a suite and fail on finding no tests. Its only consumer is
 * `aws-provider.mocked.test.ts`, which runs it under Pulumi's mocks in the
 * default suite - real `@pulumi/aws` classes and lazy namespace getters, but
 * no cloud calls. Nothing here is deployed for real: the live suite
 * (`npm run test:live`) exercises `random-password-file-program.ts` instead,
 * which needs no cloud credentials at all.
 */

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { Effect } from "effect";
import { effectify, fromOutput, fromOutputs } from "../src/index.js";

const eaws = effectify(aws);

const s3BucketProgram = (envName: string) =>
  Effect.gen(function* () {
    const bucket = yield* eaws.s3.Bucket(`${envName}-assets`, {
      forceDestroy: true,
    });

    // Passing an Effect directly into an args field - auto-resolved by
    // effectify before BucketObject is constructed, no fromOutputs needed
    // for this one since we only need a single field.
    const object = yield* eaws.s3.BucketObject(`${envName}-readme`, {
      bucket: fromOutput(bucket.id),
      content: "hello from effect-wrapped pulumi",
      key: `${envName}-readme.txt`,
    });

    const { id: bucketId } = yield* fromOutputs({ id: bucket.id });
    const url = yield* fromOutput(
      pulumi.interpolate`https://${bucket.bucketDomainName}/${object.key}`
    );

    return { bucketId, objectUrl: url };
  });

/** The program as a `PulumiFn`, which is the shape the Automation API takes.
 * Returns raw values, not Outputs: the CLI builds `UpResult.outputs` from
 * whatever the inline program returns, so wrapping them here would nest them
 * as `outputs.bucketId.value.value`. */
export const inlineProgram = (envName: string) => async () => {
  const { bucketId, objectUrl } = await Effect.runPromise(
    s3BucketProgram(envName)
  );
  return { bucketId, objectUrl };
};
