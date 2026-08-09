/**
 * Exercises `effectify` against the *real* @pulumi/aws package (via Pulumi's
 * mock resource monitor — no credentials, no cloud calls).
 *
 * The fake classes in effectify.unit.test.ts are plain objects, so they can't
 * catch problems that only show up on a genuine provider package: module
 * namespace objects with non-configurable properties, @pulumi/aws's lazily
 * defined namespace getters, and real codegen'd args interfaces.
 */
import { describe, expect, it } from "vitest";
import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { Effect } from "effect";
import { effectify, fromOutput, fromOutputs } from "../src/index.js";
import { inlineProgram } from "./s3-bucket-program.js";

pulumi.runtime.setMocks(
  {
    newResource: (a: pulumi.runtime.MockResourceArgs) => ({
      id: `${a.name}-id`,
      state: {
        ...a.inputs,
        arn: `arn:aws:s3:::${a.name}`,
        bucketDomainName: `${a.name}.s3.amazonaws.com`,
      },
    }),
    call: (a: pulumi.runtime.MockCallArgs) => a.inputs,
  },
  "proj",
  "stack",
  false
);

const eaws = effectify(aws);

describe("real @pulumi/aws proxy", () => {
  it("traverses lazy namespaces and constructs", async () => {
    expect(typeof eaws.s3).toBe("object");
    expect(typeof eaws.s3.Bucket).toBe("function");
    expect(typeof eaws.getRegion).toBe("function");
    expect(Object.keys(eaws.s3).length).toBeGreaterThan(10);
    expect("Bucket" in eaws.s3).toBe(true);

    // Wrapper identity is stable across property reads, and the codegen'd
    // statics are still reachable through the wrapper.
    expect(eaws.s3.Bucket).toBe(eaws.s3.Bucket);
    expect(typeof eaws.s3.Bucket.get).toBe("function");
    expect(typeof eaws.s3.Bucket.isInstance).toBe("function");

    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const bucket = yield* eaws.s3.Bucket("assets", { forceDestroy: true });
        const object = yield* eaws.s3.BucketObject("readme", {
          bucket: fromOutput(bucket.id),
          content: "hi",
          key: "readme.txt",
        });
        const { id } = yield* fromOutputs({ id: bucket.id });
        const url = yield* fromOutput(
          pulumi.interpolate`https://${bucket.bucketDomainName}/${object.key}`
        );
        return {
          id,
          url,
          objBucket: yield* fromOutput(object.bucket as pulumi.Output<string>),
        };
      })
    );

    expect(out.id).toBe("assets-id");
    expect(out.url).toBe("https://assets.s3.amazonaws.com/readme.txt");
    // The Effect-valued `bucket` arg was resolved to the real bucket id.
    expect(out.objBucket).toBe("assets-id");

    // Statics work through the wrapper against real codegen output too.
    const adopted = eaws.s3.Bucket.get("adopted", "adopted-id");
    expect(adopted instanceof aws.s3.Bucket).toBe(true);
    expect(await Effect.runPromise(fromOutput(adopted.id))).toBe("adopted-id");

    // A real Promise-returning invoke comes back as an Effect…
    const region = await Effect.runPromise(
      eaws.getRegion({ name: "eu-west-2" })
    );
    expect(region.name).toBe("eu-west-2");
    // …while its Output-returning variant passes through unwrapped, because
    // Outputs are not thenable.
    const regionOut = eaws.getRegionOutput({ name: "eu-west-1" });
    expect(pulumi.Output.isInstance(regionOut)).toBe(true);
    expect(await Effect.runPromise(fromOutput(regionOut))).toMatchObject({
      name: "eu-west-1",
    });
  });

  it("the s3-bucket program builds and returns the expected stack-output shape", async () => {
    // `UpResult.outputs` is an OutputMap — `{ [key]: { value, secret } }` —
    // built by the CLI from whatever the inline program *returns*. So the
    // program must return raw values; wrapping them itself would nest them as
    // `outputs.bucketId.value.value`.
    const outputs = await inlineProgram("live-test")();

    expect(Object.keys(outputs).sort()).toEqual(["bucketId", "objectUrl"]);
    expect(outputs.bucketId).toBe("live-test-assets-id");
    expect(outputs.objectUrl).toContain("live-test-readme.txt");
  });
});
