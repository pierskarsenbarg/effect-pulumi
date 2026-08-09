/**
 * Orchestration tests for src/automation.ts, against a mocked Automation API.
 *
 * automation.ts is a thin Effect wrapper over LocalWorkspace, so what it
 * actually owns is the sequencing, the short-circuiting when a stage fails,
 * the `stage` tag on every AutomationError, and the options it forwards. All
 * of that is covered here without a Pulumi CLI.
 *
 * What this deliberately cannot prove: that the real Automation API accepts
 * the arguments we pass it. Only test/s3-bucket.live.test.ts does that, and it
 * needs a CLI and a backend.
 */
import { beforeEach, describe, expect, vi } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import type { ConfigMap } from "@pulumi/pulumi/automation/index.js";
import {
  AutomationError,
  createOrSelectStack,
  deploy,
  destroyStack,
  previewStack,
  refreshStack,
  removeStack,
  setStackConfig,
  stackOutputs,
  teardownStack,
  upStack,
} from "../src/index.js";

type Stage =
  | "createOrSelectStack"
  | "setConfig"
  | "preview"
  | "refresh"
  | "outputs"
  | "up"
  | "destroy"
  | "removeStack";

const h = vi.hoisted(() => ({
  calls: [] as string[],
  failAt: null as string | null,
  createArgs: undefined as any,
  createWorkspaceOpts: undefined as any,
  passed: {} as Partial<Record<Stage, unknown>>,
  config: {} as ConfigMap,
  upResult: {
    summary: { result: "succeeded" },
    outputs: { k: { value: "v" } },
  },
  previewResult: { changeSummary: { create: 1 } },
  refreshResult: { summary: { result: "succeeded" } },
  outputsResult: { k: { value: "v", secret: false } },
}));

vi.mock("@pulumi/pulumi/automation/index.js", () => {
  const record = (name: Stage, opts?: unknown) => {
    h.calls.push(name);
    h.passed[name] = opts;
    if (h.failAt === name) throw new Error(`boom:${name}`);
  };

  const stack = {
    name: "the-stack",
    workspace: {
      removeStack: async (stackName: string, opts?: unknown) => {
        record("removeStack", opts);
        h.calls.push(`removeStack:${stackName}`);
      },
    },
    setAllConfig: async (config: ConfigMap) => {
      record("setConfig");
      Object.assign(h.config, config);
    },
    preview: async (opts?: unknown) => {
      record("preview", opts);
      return h.previewResult;
    },
    refresh: async (opts?: unknown) => {
      record("refresh", opts);
      return h.refreshResult;
    },
    outputs: async () => {
      record("outputs");
      return h.outputsResult;
    },
    up: async (opts?: unknown) => {
      record("up", opts);
      return h.upResult;
    },
    destroy: async (opts?: unknown) => {
      record("destroy", opts);
      return { summary: { result: "succeeded" } };
    },
  };

  return {
    LocalWorkspace: {
      createOrSelectStack: async (args: unknown, wsOpts?: unknown) => {
        h.createArgs = args;
        h.createWorkspaceOpts = wsOpts;
        record("createOrSelectStack");
        return stack;
      },
    },
  };
});

const inlineOpts = {
  stackName: "the-stack",
  projectName: "the-project",
  program: async () => ({ out: 1 }),
};

/** Stage names only, dropping the `removeStack:<name>` detail entries. */
const stages = () => h.calls.filter((c) => !c.includes(":"));

const getStack = () => deploy(inlineOpts).pipe(Effect.map((d) => d.stack));

beforeEach(() => {
  h.calls = [];
  h.failAt = null;
  h.createArgs = undefined;
  h.createWorkspaceOpts = undefined;
  h.passed = {};
  h.config = {};
});

describe("createOrSelectStack", () => {
  it.effect("passes inline program args through", () =>
    Effect.gen(function* () {
      yield* createOrSelectStack(inlineOpts);
      expect(h.createArgs).toEqual({
        stackName: "the-stack",
        projectName: "the-project",
        program: inlineOpts.program,
      });
    })
  );

  it.effect("supports a local program via workDir", () =>
    Effect.gen(function* () {
      yield* createOrSelectStack({
        stackName: "the-stack",
        workDir: "/tmp/project",
      });
      // Must be the LocalProgramArgs shape — no projectName, no program.
      expect(h.createArgs).toEqual({
        stackName: "the-stack",
        workDir: "/tmp/project",
      });
    })
  );

  it.effect("forwards workspace options", () =>
    Effect.gen(function* () {
      const workspaceOptions = { envVars: { FOO: "bar" } };
      yield* createOrSelectStack({ ...inlineOpts, workspaceOptions });
      expect(h.createWorkspaceOpts).toBe(workspaceOptions);
    })
  );
});

describe("deploy — lifecycle sequencing", () => {
  it.effect(
    "runs createOrSelectStack then up, with no preview by default",
    () =>
      Effect.gen(function* () {
        const { preview } = yield* deploy(inlineOpts);
        // Regression guard: previewing before every up does the work twice.
        expect(stages()).toEqual(["createOrSelectStack", "up"]);
        expect(preview).toBeUndefined();
      })
  );

  it.effect("previews before up when asked, and returns the result", () =>
    Effect.gen(function* () {
      const { preview } = yield* deploy({ ...inlineOpts, preview: true });
      expect(stages()).toEqual(["createOrSelectStack", "preview", "up"]);
      // Regression guard: the preview result used to be discarded.
      expect(preview).toBe(h.previewResult);
    })
  );

  it.effect("returns the stack handle alongside the up result", () =>
    Effect.gen(function* () {
      const { stack, result } = yield* deploy(inlineOpts);
      expect(stack.name).toBe("the-stack");
      expect(result).toBe(h.upResult);
    })
  );

  it.effect("applies the whole config in one call, before up", () =>
    Effect.gen(function* () {
      yield* deploy({
        ...inlineOpts,
        config: {
          region: { value: "eu-west-2" },
          token: { value: "s3cret", secret: true },
        },
      });

      expect(h.config).toEqual({
        region: { value: "eu-west-2" },
        token: { value: "s3cret", secret: true },
      });
      // One setAllConfig round-trip, not one CLI invocation per key.
      expect(stages()).toEqual(["createOrSelectStack", "setConfig", "up"]);
    })
  );

  it.effect("skips setConfig entirely when no config is given", () =>
    Effect.gen(function* () {
      yield* deploy(inlineOpts);
      expect(stages()).not.toContain("setConfig");
    })
  );
});

describe("options passthrough", () => {
  it.effect("forwards UpOptions, including onOutput", () =>
    Effect.gen(function* () {
      const up = { onOutput: () => {}, message: "ship it" };
      yield* deploy({ ...inlineOpts, up });
      expect(h.passed.up).toBe(up);
    })
  );

  it.effect("forwards PreviewOptions when preview is an options object", () =>
    Effect.gen(function* () {
      const preview = { onOutput: () => {}, expectNoChanges: true };
      yield* deploy({ ...inlineOpts, preview });
      expect(h.passed.preview).toBe(preview);
    })
  );

  it.effect("passes no preview options when preview is just `true`", () =>
    Effect.gen(function* () {
      yield* deploy({ ...inlineOpts, preview: true });
      expect(h.passed.preview).toBeUndefined();
    })
  );

  it.effect("never substitutes a silencing default for onOutput", () =>
    Effect.gen(function* () {
      // Regression guard: up/preview/destroy each used to hardcode
      // `onOutput: () => {}`, so nothing could be streamed to the caller.
      yield* deploy(inlineOpts);
      expect(h.passed.up).toBeUndefined();

      const stack = yield* getStack();
      yield* destroyStack(stack);
      expect(h.passed.destroy).toBeUndefined();
    })
  );

  it.effect("forwards DestroyOptions and RemoveOptions", () =>
    Effect.gen(function* () {
      const stack = yield* getStack();
      const destroyOpts = { onOutput: () => {} };
      const removeOpts = { preserveConfig: true };

      yield* teardownStack(stack, { destroy: destroyOpts, remove: removeOpts });

      expect(h.passed.destroy).toBe(destroyOpts);
      expect(h.passed.removeStack).toBe(removeOpts);
    })
  );

  it.effect("forwards options through the standalone primitives", () =>
    Effect.gen(function* () {
      const stack = yield* getStack();
      const upOpts = { message: "direct" };
      const previewOpts = { message: "plan" };

      yield* upStack(stack, upOpts);
      yield* previewStack(stack, previewOpts);

      expect(h.passed.up).toBe(upOpts);
      expect(h.passed.preview).toBe(previewOpts);
    })
  );
});

describe("deploy — failure tagging and short-circuiting", () => {
  const cases: ReadonlyArray<{
    readonly failAt: Stage;
    readonly ranBefore: readonly string[];
    readonly neverRuns: readonly string[];
  }> = [
    {
      failAt: "createOrSelectStack",
      ranBefore: [],
      neverRuns: ["setConfig", "preview", "up"],
    },
    {
      failAt: "setConfig",
      ranBefore: ["createOrSelectStack"],
      neverRuns: ["preview", "up"],
    },
    {
      failAt: "preview",
      ranBefore: ["createOrSelectStack"],
      neverRuns: ["up"],
    },
    {
      failAt: "up",
      ranBefore: ["createOrSelectStack", "preview"],
      neverRuns: [],
    },
  ];

  for (const { failAt, ranBefore, neverRuns } of cases) {
    it.effect(`tags a ${failAt} failure and stops there`, () =>
      Effect.gen(function* () {
        h.failAt = failAt;

        const error = yield* Effect.flip(
          deploy({
            ...inlineOpts,
            preview: true,
            config: { k: { value: "v" } },
          })
        );

        expect(error).toBeInstanceOf(AutomationError);
        expect(error.stage).toBe(failAt);
        expect((error.cause as Error).message).toBe(`boom:${failAt}`);
        // `.message` names the stage and the cause for non-Effect consumers.
        expect(error.message).toBe(`${failAt} failed: boom:${failAt}`);

        for (const before of ranBefore) expect(stages()).toContain(before);
        for (const never of neverRuns) expect(stages()).not.toContain(never);
      })
    );
  }

  it.effect("tags setStackConfig failures independently of deploy", () =>
    Effect.gen(function* () {
      const stack = yield* getStack();
      h.failAt = "setConfig";

      const error = yield* Effect.flip(
        setStackConfig(stack, { a: { value: "1" } })
      );
      expect(error.stage).toBe("setConfig");
    })
  );
});

describe("refresh and outputs", () => {
  it.effect("refreshStack forwards options and returns the result", () =>
    Effect.gen(function* () {
      const stack = yield* getStack();
      const refreshOpts = { onOutput: () => {}, message: "sync state" };

      const result = yield* refreshStack(stack, refreshOpts);

      expect(h.passed.refresh).toBe(refreshOpts);
      expect(result).toBe(h.refreshResult);
    })
  );

  it.effect("refreshStack passes no default options", () =>
    Effect.gen(function* () {
      const stack = yield* getStack();
      yield* refreshStack(stack);
      expect(h.passed.refresh).toBeUndefined();
    })
  );

  it.effect("stackOutputs reads outputs without running an update", () =>
    Effect.gen(function* () {
      const stack = yield* getStack();
      h.calls = [];

      const outputs = yield* stackOutputs(stack);

      expect(outputs).toBe(h.outputsResult);
      expect(stages()).toEqual(["outputs"]);
    })
  );

  it.effect("tags a refresh failure", () =>
    Effect.gen(function* () {
      const stack = yield* getStack();
      h.failAt = "refresh";

      const error = yield* Effect.flip(refreshStack(stack));
      expect(error).toBeInstanceOf(AutomationError);
      expect(error.stage).toBe("refresh");
    })
  );

  it.effect("tags an outputs failure", () =>
    Effect.gen(function* () {
      const stack = yield* getStack();
      h.failAt = "outputs";

      const error = yield* Effect.flip(stackOutputs(stack));
      expect(error).toBeInstanceOf(AutomationError);
      expect(error.stage).toBe("outputs");
    })
  );
});

describe("teardown", () => {
  it.effect("destroyStack destroys and leaves the stack registered", () =>
    Effect.gen(function* () {
      const stack = yield* getStack();
      h.calls = [];

      yield* destroyStack(stack);

      expect(stages()).toEqual(["destroy"]);
      expect(stages()).not.toContain("removeStack");
    })
  );

  it.effect("removeStack deletes the stack by name", () =>
    Effect.gen(function* () {
      const stack = yield* getStack();
      h.calls = [];

      yield* removeStack(stack);

      expect(stages()).toEqual(["removeStack"]);
      expect(h.calls).toContain("removeStack:the-stack");
    })
  );

  it.effect("teardownStack destroys first, then removes", () =>
    Effect.gen(function* () {
      const stack = yield* getStack();
      h.calls = [];

      const result = yield* teardownStack(stack);

      expect(stages()).toEqual(["destroy", "removeStack"]);
      expect(result.summary.result).toBe("succeeded");
    })
  );

  it.effect("teardownStack does not remove a stack it failed to destroy", () =>
    Effect.gen(function* () {
      const stack = yield* getStack();
      h.calls = [];
      h.failAt = "destroy";

      const error = yield* Effect.flip(teardownStack(stack));

      expect(error.stage).toBe("destroy");
      // Removing here would orphan whatever the destroy left behind.
      expect(stages()).not.toContain("removeStack");
    })
  );

  it.effect("tags a destroy failure", () =>
    Effect.gen(function* () {
      const stack = yield* getStack();
      h.failAt = "destroy";

      const error = yield* Effect.flip(destroyStack(stack));
      expect(error).toBeInstanceOf(AutomationError);
      expect(error.stage).toBe("destroy");
    })
  );

  it.effect("tags a removeStack failure", () =>
    Effect.gen(function* () {
      const stack = yield* getStack();
      h.failAt = "removeStack";

      const error = yield* Effect.flip(removeStack(stack));
      expect(error).toBeInstanceOf(AutomationError);
      expect(error.stage).toBe("removeStack");
    })
  );
});
