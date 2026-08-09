import { Data } from "effect";

const describeCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * Any synchronous failure constructing a resource (bad args, provider
 * validation, etc.), or a failure resolving an Output's promise.
 *
 * Tagged `"PulumiError"`, so it can be matched by tag rather than by
 * `instanceof`:
 *
 * @example
 * ```ts
 * program.pipe(
 *   Effect.catchTag("PulumiError", (e) => Effect.logError(e.message))
 * );
 * ```
 */
export class PulumiError extends Data.TaggedError("PulumiError")<{
  /** The original thrown value or rejection reason, unwrapped and unmodified.
   * Not necessarily an `Error`. */
  readonly cause: unknown;
}> {
  /** Derived so anything reading `.message` - plain logging, test failure
   * output, non-Effect error handling - sees the underlying failure instead
   * of an empty string. */
  get message(): string {
    return describeCause(this.cause);
  }
}

/**
 * Failure from an Automation API lifecycle call (up/preview/destroy/select).
 *
 * `stage` says which call failed, which matters most in the composite
 * operations: a failed `deploy` could have died selecting the stack, applying
 * config, or running the update, and the three want different responses.
 *
 * @example
 * ```ts
 * deploy(opts).pipe(
 *   Effect.catchTag("AutomationError", (e) =>
 *     e.stage === "createOrSelectStack"
 *       ? Effect.fail(new BackendUnreachable())
 *       : Effect.logError(e.message)
 *   )
 * );
 * ```
 */
export class AutomationError extends Data.TaggedError("AutomationError")<{
  /** Which Automation API call failed. Named for the wrapper that raised it,
   * so `deploy`'s failures still report the underlying stage. */
  readonly stage:
    | "createOrSelectStack"
    | "setConfig"
    | "up"
    | "preview"
    | "refresh"
    | "outputs"
    | "destroy"
    | "removeStack";
  /** The rejection reason from the Automation API. For a failed update this is
   * usually a `CommandError` carrying the CLI's stdout and stderr. */
  readonly cause: unknown;
}> {
  /** `"<stage> failed: <cause>"` - the stage is included because the cause
   * alone rarely says which operation produced it. */
  get message(): string {
    return `${this.stage} failed: ${describeCause(this.cause)}`;
  }
}
