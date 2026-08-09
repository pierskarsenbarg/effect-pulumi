import type {
  ConfigMap,
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
 * process, with no `Pulumi.yaml` on disk. */
export interface InlineStackOptions {
  /** Stack to select, created if absent. */
  readonly stackName: string;
  /** Project name to register the stack under. Chosen freely here, since
   * there is no `Pulumi.yaml` to take it from — but it is part of the stack's
   * identity in the backend, so changing it later points at a different
   * stack. */
  readonly projectName: string;
  /** The program itself. Runs in this process, so it needs no separate Node
   * runtime and can close over values from the caller. */
  readonly program: PulumiFn;
  readonly workspaceOptions?: LocalWorkspaceOptions;
}

/** Arguments for a local program — an existing Pulumi project on disk. */
export interface LocalStackOptions {
  /** Stack to select, created if absent. */
  readonly stackName: string;
  /** Directory holding the project's `Pulumi.yaml`. Its `name:` supplies the
   * project name, which is why there is no `projectName` here. */
  readonly workDir: string;
  readonly workspaceOptions?: LocalWorkspaceOptions;
}

/** Either flavour of stack. Discriminated at runtime by the presence of
 * `workDir`, so the two are not interchangeable: an inline program needs
 * `projectName`, a local one takes it from `Pulumi.yaml`. */
export type StackOptions = InlineStackOptions | LocalStackOptions;

const isLocal = (opts: StackOptions): opts is LocalStackOptions =>
  "workDir" in opts;

/** Select the stack, creating it if it does not exist, and return the handle
 * every other operation here takes.
 *
 * Creating the workspace is itself work — it may write files and shell out to
 * the CLI — so hold on to the returned `Stack` rather than re-selecting before
 * each operation. */
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
  config: ConfigMap | undefined
): Effect.Effect<void, AutomationError> =>
  !config || Object.keys(config).length === 0
    ? Effect.void
    : Effect.tryPromise({
        try: () => stack.setAllConfig(config),
        catch: (cause) => new AutomationError({ stage: "setConfig", cause }),
      });

/** Compute the plan without applying it.
 *
 * A preview is a full engine run against the provider, not a cheap check — see
 * {@link DeployOptions.preview} before pairing one with an `up`. */
export const previewStack = (
  stack: Stack,
  opts?: PreviewOptions
): Effect.Effect<PreviewResult, AutomationError> =>
  Effect.tryPromise({
    try: () => stack.preview(opts),
    catch: (cause) => new AutomationError({ stage: "preview", cause }),
  });

/** Apply the program: create, update and delete resources to match it.
 *
 * The result carries the stack's outputs and a summary; pass `onOutput` to
 * watch progress while it runs. */
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

/** {@link deploy}'s arguments: the stack to target, plus what to do with it. */
export type DeployOptions = StackOptions & {
  /** Config to apply before the update, in one `setAllConfig` call. Keys are
   * fully qualified (`"my-project:myKey"`). */
  readonly config?: ConfigMap;
  /** Options forwarded to the update — `onOutput` to stream progress,
   * `parallel`, `target`, and so on. */
  readonly up?: UpOptions;
  /** Run `preview` before `up`, returning its result.
   *
   * Off by default: a preview is a full engine run against the provider, so
   * previewing and then immediately upping does the work twice. `up` reports
   * the same failures, so this earns its cost only when you want the plan
   * itself. */
  readonly preview?: PreviewOptions | boolean;
};

/** What {@link deploy} hands back. */
export interface DeployResult {
  /** The selected stack, so teardown needs no second `createOrSelectStack`. */
  readonly stack: Stack;
  /** The update's result — `outputs` and `summary` live here. */
  readonly result: UpResult;
  /** Present only when `preview` was requested. */
  readonly preview?: PreviewResult;
}

/**
 * Select or create the stack, apply config, optionally preview, then up.
 *
 * The common path, assembled from the primitives above. Anything more
 * involved — refreshing first, inspecting the plan before deciding, retrying a
 * stage — should compose those directly rather than grow options here.
 *
 * @param opts - Which stack, and what to do with it.
 * @returns The stack handle alongside the results, so callers can tear down
 * afterwards without re-selecting.
 *
 * @example Deploy, use the outputs, then always tear down
 * ```ts
 * Effect.scoped(
 *   Effect.gen(function* () {
 *     const { result } = yield* Effect.acquireRelease(
 *       deploy({ stackName, projectName, program, up: { onOutput } }),
 *       ({ stack }) => teardownStack(stack).pipe(Effect.ignore)
 *     );
 *     return result.outputs.bucketId?.value;
 *   })
 * );
 * ```
 */
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
