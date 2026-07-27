import * as pulumi from "@pulumi/pulumi";
import { Effect } from "effect";
import { PulumiError } from "./errors.js";

/** `Output.promise()` is how the Pulumi runtime itself gets a settled value out
 * of an Output, but it is not part of the public `Output<T>` surface. */
interface PromisableOutput<T> {
  promise(withUnknowns?: boolean): Promise<T>;
}

/** Lift a single Output into an Effect.
 *
 * `withUnknowns: true` matters during `pulumi preview`, where a not-yet-created
 * resource's outputs have no value: it resolves to Pulumi's unknown sentinel
 * instead of throwing, so a program that reads outputs still previews cleanly.
 */
export const fromOutput = <T>(
  output: pulumi.Output<T>
): Effect.Effect<T, PulumiError> =>
  Effect.tryPromise({
    try: () => (output as unknown as PromisableOutput<T>).promise(true),
    catch: (cause) => new PulumiError({ cause }),
  });

/** Lift a record of Outputs into a single Effect of the resolved record —
 * use this right after constructing a resource to grab several fields at
 * once (e.g. `{ id: bucket.id, arn: bucket.arn }`). */
export const fromOutputs = <T extends Record<string, pulumi.Output<any>>>(
  outputs: T
): Effect.Effect<{ [K in keyof T]: pulumi.Unwrap<T[K]> }, PulumiError> =>
  fromOutput(pulumi.all(outputs) as pulumi.Output<any>);
