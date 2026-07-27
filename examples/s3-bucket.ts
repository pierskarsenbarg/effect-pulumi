import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { Effect } from "effect";
import { effectify, fromOutput, fromOutputs } from "../src/index.js";

const eaws = effectify(aws);

/** Exported so both the Automation API deploy and the integration test can
 * reuse the exact same program logic. */
export const s3BucketProgram = (envName: string) =>
  Effect.gen(function* () {
    const bucket = yield* eaws.s3.Bucket(`${envName}-assets`, {
      forceDestroy: true,
    });

    // Passing an Effect directly into an args field — auto-resolved by
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

export const inlineProgram = (envName: string) => async () => {
  const { bucketId, objectUrl } = await Effect.runPromise(
    s3BucketProgram(envName)
  );
  return { bucketId, objectUrl };
};
