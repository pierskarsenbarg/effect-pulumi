import * as pulumi from "@pulumi/pulumi";
import { Effect } from "effect";
import { PulumiError } from "./errors.js";

/** `Output.promise()` is how the Pulumi runtime itself gets a settled value out
 * of an Output, but it is not part of the public `Output<T>` surface. */
interface PromisableOutput<T> {
  promise(withUnknowns?: boolean): Promise<T>;
}

/**
 * Lift a single Output into an Effect.
 *
 * `withUnknowns: true` matters during `pulumi preview`, where a not-yet-created
 * resource's outputs have no value: it resolves to Pulumi's unknown sentinel
 * instead of throwing, so a program that reads outputs still previews cleanly.
 *
 * @param output - The Output to resolve.
 * @returns An Effect yielding the settled value, failing with
 * {@link PulumiError} if the underlying promise rejects.
 *
 * @example
 * ```ts
 * const bucket = yield* eaws.s3.Bucket("assets", {});
 * const id = yield* fromOutput(bucket.id); // string
 * ```
 *
 * @remarks Reading an Output only makes sense inside a running Pulumi program.
 * During `preview` the value may be the unknown sentinel rather than real data,
 * so don't branch on it to decide what to create.
 */
export const fromOutput = <T>(
  output: pulumi.Output<T>
): Effect.Effect<T, PulumiError> =>
  Effect.tryPromise({
    try: () => (output as unknown as PromisableOutput<T>).promise(true),
    catch: (cause) => new PulumiError({ cause }),
  });

/**
 * Lift a record of Outputs into a single Effect of the resolved record — use
 * this right after constructing a resource to grab several fields at once.
 *
 * Resolves them together via `pulumi.all`, so it costs one await rather than
 * one per field.
 *
 * @param outputs - A record whose values are all Outputs. Interfaces work as
 * well as object literals; the constraint is self-referential rather than
 * `Record<string, Output<any>>` precisely so interface-typed bags are accepted.
 * @returns An Effect yielding the same record with each value unwrapped.
 *
 * @example
 * ```ts
 * const bucket = yield* eaws.s3.Bucket("assets", {});
 * const { id, arn } = yield* fromOutputs({ id: bucket.id, arn: bucket.arn });
 * ```
 */
export const fromOutputs = <T extends { [K in keyof T]: pulumi.Output<any> }>(
  outputs: T
): Effect.Effect<{ [K in keyof T]: pulumi.Unwrap<T[K]> }, PulumiError> =>
  fromOutput(pulumi.all(outputs) as pulumi.Output<any>);
