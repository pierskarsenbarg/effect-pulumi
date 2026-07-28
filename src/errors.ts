import { Data } from "effect";

/** Any synchronous failure constructing a resource (bad args, provider
 * validation, etc.), or a failure resolving an Output's promise. */
export class PulumiError extends Data.TaggedError("PulumiError")<{
  readonly cause: unknown;
}> {}

/** Failure from an Automation API lifecycle call (up/preview/destroy/select). */
export class AutomationError extends Data.TaggedError("AutomationError")<{
  readonly stage:
    | "createOrSelectStack"
    | "setConfig"
    | "up"
    | "preview"
    | "destroy"
    | "removeStack";
  readonly cause: unknown;
}> {}
