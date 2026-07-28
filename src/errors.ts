import { Data } from "effect";

const describeCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Any synchronous failure constructing a resource (bad args, provider
 * validation, etc.), or a failure resolving an Output's promise. */
export class PulumiError extends Data.TaggedError("PulumiError")<{
  readonly cause: unknown;
}> {
  /** Derived so anything reading `.message` — plain logging, test failure
   * output, non-Effect error handling — sees the underlying failure instead
   * of an empty string. */
  get message(): string {
    return describeCause(this.cause);
  }
}

/** Failure from an Automation API lifecycle call (up/preview/destroy/select). */
export class AutomationError extends Data.TaggedError("AutomationError")<{
  readonly stage:
    | "createOrSelectStack"
    | "setConfig"
    | "up"
    | "preview"
    | "refresh"
    | "outputs"
    | "destroy"
    | "removeStack";
  readonly cause: unknown;
}> {
  get message(): string {
    return `${this.stage} failed: ${describeCause(this.cause)}`;
  }
}
