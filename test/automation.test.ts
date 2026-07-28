/**
 * Orchestration tests for src/automation.ts, against a mocked Automation API.
 *
 * automation.ts is a thin Effect wrapper over LocalWorkspace, so what it
 * actually owns is the sequencing (createOrSelectStack → config → preview →
 * up), the short-circuiting when a stage fails, and the `stage` tag on every
 * AutomationError. All of that is covered here without a Pulumi CLI.
 *
 * What this deliberately cannot prove: that the real Automation API accepts
 * the arguments we pass it. Only test/examples.live.test.ts does that, and it
 * needs a CLI and a backend.
 */
import { beforeEach, describe, expect, vi } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import {
  AutomationError,
  deploy,
  destroyStack,
  removeStack,
  teardownStack,
} from "../src/index.js";

type Stage =
  | "createOrSelectStack"
  | "setConfig"
  | "preview"
  | "up"
  | "destroy"
  | "removeStack";

const h = vi.hoisted(() => ({
  calls: [] as string[],
  failAt: null as string | null,
  createOpts: undefined as any,
  config: {} as Record<string, unknown>,
  upResult: { summary: { result: "succeeded" }, outputs: { k: { value: "v" } } },
}));

vi.mock("@pulumi/pulumi/automation/index.js", () => {
  const record = (name: string) => {
    h.calls.push(name);
    if (h.failAt === name) throw new Error(`boom:${name}`);
  };

  const workspace = {
    removeStack: async (stackName: string) => {
      record("removeStack");
      h.calls.push(`removeStack:${stackName}`);
    },
  };

  const stack = {
    name: "the-stack",
    workspace,
    setConfig: async (key: string, value: unknown) => {
      record("setConfig");
      h.config[key] = value;
      h.calls.push(`setConfig:${key}`);
    },
    preview: async () => {
      record("preview");
      return { summary: {} };
    },
    up: async () => {
      record("up");
      return h.upResult;
    },
    destroy: async () => {
      record("destroy");
      return { summary: { result: "succeeded" } };
    },
  };

  return {
    LocalWorkspace: {
      createOrSelectStack: async (opts: unknown) => {
        h.createOpts = opts;
        record("createOrSelectStack");
        return stack;
      },
    },
  };
});

const baseOpts = {
  stackName: "the-stack",
  projectName: "the-project",
  program: async () => ({ out: 1 }),
};

/** Stage names only, dropping the `setConfig:<key>` detail entries. */
const stages = () => h.calls.filter((c) => !c.includes(":"));

beforeEach(() => {
  h.calls = [];
  h.failAt = null;
  h.createOpts = undefined;
  h.config = {};
});

describe("deploy — lifecycle sequencing", () => {
  it.effect("runs createOrSelectStack, preview, then up", () =>
    Effect.gen(function* () {
      yield* deploy(baseOpts);
      expect(stages()).toEqual(["createOrSelectStack", "preview", "up"]);
    })
  );

  it.effect("returns the stack handle alongside the up result", () =>
    Effect.gen(function* () {
      const { stack, result } = yield* deploy(baseOpts);
      expect(stack.name).toBe("the-stack");
      expect(result).toBe(h.upResult);
    })
  );

  it.effect("forwards stackName, projectName and program", () =>
    Effect.gen(function* () {
      yield* deploy(baseOpts);
      expect(h.createOpts).toMatchObject({
        stackName: "the-stack",
        projectName: "the-project",
        program: baseOpts.program,
      });
    })
  );

  it.effect("applies every config entry, before preview", () =>
    Effect.gen(function* () {
      yield* deploy({
        ...baseOpts,
        config: {
          region: { value: "eu-west-2" },
          token: { value: "s3cret", secret: true },
        },
      });

      expect(h.config).toEqual({
        region: { value: "eu-west-2" },
        token: { value: "s3cret", secret: true },
      });
      expect(stages()).toEqual([
        "createOrSelectStack",
        "setConfig",
        "setConfig",
        "preview",
        "up",
      ]);
    })
  );

  it.effect("skips setConfig entirely when no config is given", () =>
    Effect.gen(function* () {
      yield* deploy(baseOpts);
      expect(stages()).not.toContain("setConfig");
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
          deploy({ ...baseOpts, config: { k: { value: "v" } } })
        );

        expect(error).toBeInstanceOf(AutomationError);
        expect(error.stage).toBe(failAt);
        expect((error.cause as Error).message).toBe(`boom:${failAt}`);

        for (const before of ranBefore) expect(stages()).toContain(before);
        for (const never of neverRuns) expect(stages()).not.toContain(never);
      })
    );
  }
});

describe("teardown", () => {
  it.effect("destroyStack destroys and leaves the stack registered", () =>
    Effect.gen(function* () {
      const { stack } = yield* deploy(baseOpts);
      h.calls = [];

      yield* destroyStack(stack);

      expect(stages()).toEqual(["destroy"]);
      expect(stages()).not.toContain("removeStack");
    })
  );

  it.effect("removeStack deletes the stack by name", () =>
    Effect.gen(function* () {
      const { stack } = yield* deploy(baseOpts);
      h.calls = [];

      yield* removeStack(stack);

      expect(stages()).toEqual(["removeStack"]);
      expect(h.calls).toContain("removeStack:the-stack");
    })
  );

  it.effect("teardownStack destroys first, then removes", () =>
    Effect.gen(function* () {
      const { stack } = yield* deploy(baseOpts);
      h.calls = [];

      const result = yield* teardownStack(stack);

      expect(stages()).toEqual(["destroy", "removeStack"]);
      expect(result.summary.result).toBe("succeeded");
    })
  );

  it.effect("teardownStack does not remove a stack it failed to destroy", () =>
    Effect.gen(function* () {
      const { stack } = yield* deploy(baseOpts);
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
      const { stack } = yield* deploy(baseOpts);
      h.failAt = "destroy";

      const error = yield* Effect.flip(destroyStack(stack));
      expect(error).toBeInstanceOf(AutomationError);
      expect(error.stage).toBe("destroy");
    })
  );

  it.effect("tags a removeStack failure", () =>
    Effect.gen(function* () {
      const { stack } = yield* deploy(baseOpts);
      h.failAt = "removeStack";

      const error = yield* Effect.flip(removeStack(stack));
      expect(error).toBeInstanceOf(AutomationError);
      expect(error.stage).toBe("removeStack");
    })
  );
});
