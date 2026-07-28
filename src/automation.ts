import type {
  ConfigValue,
  DestroyOptions,
  DestroyResult,
  LocalWorkspaceOptions,
  OutputMap,
  PreviewOptions,
  PreviewResult,
  PulumiFn,
  RefreshOptions,
  RefreshResult,
  RemoveOptions,
  Stack,
  UpOptions,
  UpResult,
} from "@pulumi/pulumi/automation/index.js";
import { LocalWorkspace } from "@pulumi/pulumi/automation/index.js";
import { Effect } from "effect";
import { AutomationError } from "./errors.js";

// ---------------------------------------------------------------------------
// Primitives
//
// Each wraps one Automation API call, tagging failures with the stage they
// came from. They are exported individually so callers can assemble their own
// lifecycle — `deploy` below is only the common path.
//
// Every operation takes the matching Pulumi options type. That includes
// `onOutput`: pass it to stream the CLI's progress as it happens. Without it
// nothing is printed during what may be a multi-minute operation (the text is
// still captured on the result's `stdout`, and on the error when one is
// thrown, but only once the operation has finished).
// ---------------------------------------------------------------------------

/** Arguments for an inline program — the Pulumi program is a function in this
 * process. */
export interface InlineStackOptions {
  readonly stackName: string;
  readonly projectName: string;
  readonly program: PulumiFn;
  readonly workspaceOptions?: LocalWorkspaceOptions;
}

/** Arguments for a local program — an existing Pulumi project on disk. */
export interface LocalStackOptions {
  readonly stackName: string;
  readonly workDir: string;
  readonly workspaceOptions?: LocalWorkspaceOptions;
}

export type StackOptions = InlineStackOptions | LocalStackOptions;

const isLocal = (opts: StackOptions): opts is LocalStackOptions =>
  "workDir" in opts;

export const createOrSelectStack = (
  opts: StackOptions
): Effect.Effect<Stack, AutomationError> =>
  Effect.tryPromise({
    try: () =>
      isLocal(opts)
        ? LocalWorkspace.createOrSelectStack(
            { stackName: opts.stackName, workDir: opts.workDir },
            opts.workspaceOptions
          )
        : LocalWorkspace.createOrSelectStack(
            {
              stackName: opts.stackName,
              projectName: opts.projectName,
              program: opts.program,
            },
            opts.workspaceOptions
          ),
    catch: (cause) =>
      new AutomationError({ stage: "createOrSelectStack", cause }),
  });

/** Apply the whole config map in one `setAllConfig` call — a single CLI
 * round-trip, where per-key `setConfig` costs one `pulumi config set`
 * invocation each. */
export const setStackConfig = (
  stack: Stack,
  config: Record<string, ConfigValue> | undefined
): Effect.Effect<void, AutomationError> =>
  !config || Object.keys(config).length === 0
    ? Effect.void
    : Effect.tryPromise({
        try: () => stack.setAllConfig(config),
        catch: (cause) => new AutomationError({ stage: "setConfig", cause }),
      });

export const previewStack = (
  stack: Stack,
  opts?: PreviewOptions
): Effect.Effect<PreviewResult, AutomationError> =>
  Effect.tryPromise({
    try: () => stack.preview(opts),
    catch: (cause) => new AutomationError({ stage: "preview", cause }),
  });

export const upStack = (
  stack: Stack,
  opts?: UpOptions
): Effect.Effect<UpResult, AutomationError> =>
  Effect.tryPromise({
    try: () => stack.up(opts),
    catch: (cause) => new AutomationError({ stage: "up", cause }),
  });

/** Refresh the stack's state from the actual cloud resources, without
 * changing them — what to run when state may have drifted (manual console
 * edits, a crashed update) before deciding what to do about it. */
export const refreshStack = (
  stack: Stack,
  opts?: RefreshOptions
): Effect.Effect<RefreshResult, AutomationError> =>
  Effect.tryPromise({
    try: () => stack.refresh(opts),
    catch: (cause) => new AutomationError({ stage: "refresh", cause }),
  });

/** Read the stack's current outputs without running an update. */
export const stackOutputs = (
  stack: Stack
): Effect.Effect<OutputMap, AutomationError> =>
  Effect.tryPromise({
    try: () => stack.outputs(),
    catch: (cause) => new AutomationError({ stage: "outputs", cause }),
  });

/** Destroy the stack's resources. The stack itself remains registered with
 * the backend — see `removeStack` / `teardownStack` to delete it too. */
export const destroyStack = (
  stack: Stack,
  opts?: DestroyOptions
): Effect.Effect<DestroyResult, AutomationError> =>
  Effect.tryPromise({
    try: () => stack.destroy(opts),
    catch: (cause) => new AutomationError({ stage: "destroy", cause }),
  });

/** Delete the stack and its configuration and history from the backend.
 *
 * This does not destroy resources — run `destroyStack` first, or use
 * `teardownStack`. Pulumi refuses to remove a stack that still has resources
 * unless `RemoveOptions.force` is set, and forcing it orphans them: they keep
 * existing and billing with nothing tracking them. */
export const removeStack = (
  stack: Stack,
  opts?: RemoveOptions
): Effect.Effect<void, AutomationError> =>
  Effect.tryPromise({
    try: () => stack.workspace.removeStack(stack.name, opts),
    catch: (cause) => new AutomationError({ stage: "removeStack", cause }),
  });

/** Full teardown: destroy the resources, then delete the stack.
 *
 * `destroyStack` alone leaves an empty stack behind, so anything creating
 * stacks per-run (ephemeral environments, tests naming stacks by timestamp)
 * accumulates them in the backend. */
export const teardownStack = (
  stack: Stack,
  opts?: { readonly destroy?: DestroyOptions; readonly remove?: RemoveOptions }
): Effect.Effect<DestroyResult, AutomationError> =>
  Effect.gen(function* () {
    const result = yield* destroyStack(stack, opts?.destroy);
    yield* removeStack(stack, opts?.remove);
    return result;
  });

// ---------------------------------------------------------------------------
// Convenience lifecycle
// ---------------------------------------------------------------------------

export type DeployOptions = StackOptions & {
  readonly config?: Record<string, ConfigValue>;
  readonly up?: UpOptions;
  /** Run `preview` before `up`, returning its result.
   *
   * Off by default: a preview is a full engine run against the provider, so
   * previewing and then immediately upping does the work twice. `up` reports
   * the same failures, so this earns its cost only when you want the plan
   * itself. */
  readonly preview?: PreviewOptions | boolean;
};

export interface DeployResult {
  readonly stack: Stack;
  readonly result: UpResult;
  /** Present only when `preview` was requested. */
  readonly preview?: PreviewResult;
}

/** Select or create the stack, apply config, optionally preview, then up.
 *
 * Returns the stack handle alongside the results so callers can tear down
 * afterwards without re-selecting. For anything more involved, compose the
 * exported primitives directly. */
export const deploy = (
  opts: DeployOptions
): Effect.Effect<DeployResult, AutomationError> =>
  Effect.gen(function* () {
    const stack = yield* createOrSelectStack(opts);
    yield* setStackConfig(stack, opts.config);

    const preview = opts.preview
      ? yield* previewStack(
          stack,
          typeof opts.preview === "boolean" ? undefined : opts.preview
        )
      : undefined;

    const result = yield* upStack(stack, opts.up);
    return { stack, result, preview };
  });
