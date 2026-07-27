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

export const destroyStack = (
  stack: Stack
): Effect.Effect<DestroyResult, AutomationError> =>
  Effect.tryPromise({
    try: () => stack.destroy({ onOutput: () => {} }),
    catch: (cause) => new AutomationError({ stage: "destroy", cause }),
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
