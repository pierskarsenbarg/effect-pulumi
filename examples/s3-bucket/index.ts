import * as aws from "@pulumi/aws";
import { Effect } from "effect";
import { effectify } from "effect-pulumi";

const eaws = effectify(aws);

const program = Effect.gen(function* () {
  const bucket = yield* eaws.s3.Bucket("my-bucket");
  return { bucketName: bucket.id };
});

export const bucketName = Effect.runSync(
  Effect.map(program, ({ bucketName }) => bucketName)
);
