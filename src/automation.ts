import type {
  DestroyResult,
  Stack,
  UpResult,
} from "@pulumi/pulumi/automation/index.js";
import { LocalWorkspace } from "@pulumi/pulumi/automation/index.js";
import { Effect } from "effect";
import { AutomationError } from "./errors.js";

export interface DeployOptions {
  readonly stackName: string;
  readonly projectName: string;
  readonly program: () => Promise<Record<string, unknown> | void>;
  readonly config?: Record<string, { value: string; secret?: boolean }>;
}

const createOrSelectStack = (
  opts: DeployOptions
): Effect.Effect<Stack, AutomationError> =>
  Effect.tryPromise({
    try: () =>
      LocalWorkspace.createOrSelectStack({
        stackName: opts.stackName,
        projectName: opts.projectName,
        program: opts.program,
      }),
    catch: (cause) =>
      new AutomationError({ stage: "createOrSelectStack", cause }),
  });

const applyConfig = (
  stack: Stack,
  config: DeployOptions["config"]
): Effect.Effect<void, AutomationError> =>
  Effect.gen(function* () {
    if (!config) return;
    for (const [key, value] of Object.entries(config)) {
      yield* Effect.tryPromise({
        try: () => stack.setConfig(key, value),
        catch: (cause) => new AutomationError({ stage: "setConfig", cause }),
      });
    }
  });

const previewStack = (stack: Stack) =>
  Effect.tryPromise({
    try: () => stack.preview({ onOutput: () => {} }),
    catch: (cause) => new AutomationError({ stage: "preview", cause }),
  });

const upStack = (stack: Stack): Effect.Effect<UpResult, AutomationError> =>
  Effect.tryPromise({
    try: () => stack.up({ onOutput: () => {} }),
    catch: (cause) => new AutomationError({ stage: "up", cause }),
  });

/** Destroy the stack's resources. The stack itself remains registered with
 * the backend — see `removeStack` / `teardownStack` to delete it too. */
export const destroyStack = (
  stack: Stack
): Effect.Effect<DestroyResult, AutomationError> =>
  Effect.tryPromise({
    try: () => stack.destroy({ onOutput: () => {} }),
    catch: (cause) => new AutomationError({ stage: "destroy", cause }),
  });

/** Delete the stack and its configuration and history from the backend.
 *
 * This does not destroy resources — run `destroyStack` first, or the
 * resources are orphaned. Pulumi refuses to remove a stack that still has
 * resources unless `force` is set, which is exactly that orphaning, so it is
 * deliberately not exposed here. */
export const removeStack = (
  stack: Stack
): Effect.Effect<void, AutomationError> =>
  Effect.tryPromise({
    try: () => stack.workspace.removeStack(stack.name),
    catch: (cause) => new AutomationError({ stage: "removeStack", cause }),
  });

/** Full teardown: destroy the resources, then delete the stack.
 *
 * `destroyStack` alone leaves an empty stack behind, so anything creating
 * stacks per-run (ephemeral environments, tests naming stacks by timestamp)
 * accumulates them in the backend. */
export const teardownStack = (
  stack: Stack
): Effect.Effect<DestroyResult, AutomationError> =>
  Effect.gen(function* () {
    const result = yield* destroyStack(stack);
    yield* removeStack(stack);
    return result;
  });

/** Full lifecycle as one Effect pipeline: select stack, apply config,
 * preview, up. Returns the stack handle alongside the up() result so
 * callers (tests especially) can destroy() afterwards without re-selecting. */
export const deploy = (
  opts: DeployOptions
): Effect.Effect<{ stack: Stack; result: UpResult }, AutomationError> =>
  Effect.gen(function* () {
    const stack = yield* createOrSelectStack(opts);
    yield* applyConfig(stack, opts.config);
    yield* previewStack(stack);
    const result = yield* upStack(stack);
    return { stack, result };
  });
