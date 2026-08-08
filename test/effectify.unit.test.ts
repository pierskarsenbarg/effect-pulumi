import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import * as pulumi from "@pulumi/pulumi";
import { Deferred, Effect, Exit } from "effect";
import {
  effectify,
  fromOutput,
  fromOutputs,
  PulumiError,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Mock resource monitor — present purely so the fake resource subclasses below
// can construct at all. No real provider, no credentials.
// ---------------------------------------------------------------------------

pulumi.runtime.setMocks(
  {
    newResource: (args: pulumi.runtime.MockResourceArgs) => ({
      id: `${args.name}-id`,
      state: { ...args.inputs, arn: `arn:test:${args.name}` },
    }),
    call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
  },
  "effect-pulumi-test",
  "unit",
  false // not a dry run, so outputs actually resolve
);

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeBucketArgs {
  readonly bucketName: pulumi.Input<string>;
  readonly region?: pulumi.Input<string>;
  /** Test hook: makes the constructor throw synchronously. */
  readonly explode?: boolean;
}

class FakeBucket extends pulumi.CustomResource {
  declare public readonly bucketName: pulumi.Output<string>;
  declare public readonly region: pulumi.Output<string>;
  declare public readonly arn: pulumi.Output<string>;

  constructor(
    name: string,
    args: FakeBucketArgs,
    opts?: pulumi.CustomResourceOptions
  ) {
    if (args?.explode) {
      throw new Error("bad args: explode was set");
    }
    super("test:index:FakeBucket", name, { arn: undefined, ...args }, opts);
  }

  /** Mirrors the codegen'd static every provider resource ships for adopting
   * an existing resource into state. */
  public static get(name: string, id: pulumi.Input<pulumi.ID>): FakeBucket {
    return new FakeBucket(name, { bucketName: `adopted-${name}` }, { id });
  }
}

/** A CustomResource whose args are entirely optional, to check that
 * `effectify` keeps `Ctor(name)` callable. */
class FakeQueue extends pulumi.CustomResource {
  declare public readonly arn: pulumi.Output<string>;

  constructor(
    name: string,
    args?: { readonly fifo?: pulumi.Input<boolean> },
    opts?: pulumi.CustomResourceOptions
  ) {
    super("test:index:FakeQueue", name, { arn: undefined, ...args }, opts);
  }
}

interface FakeStackArgs {
  /** Deliberately a bare primitive, not an Input<T> — the component does
   * synchronous work on it in the constructor. */
  readonly replicas: number;
}

class FakeStack extends pulumi.ComponentResource {
  public readonly doubled: number;
  public readonly receivedArgs: unknown;

  constructor(
    name: string,
    args: FakeStackArgs,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super("test:index:FakeStack", name, {}, opts);
    this.receivedArgs = args;
    // Would be NaN (or throw) if effectify had auto-lifted/replaced the arg.
    this.doubled = (args as FakeStackArgs).replicas * 2;
    this.registerOutputs({});
  }
}

const getThing = (name: string) => `invoked:${name}`;

/** Codegen-style invoke: takes an args object, returns a Promise. */
const getThingInfo = async (args: {
  readonly name: string;
}): Promise<{ name: string; tier: string }> => ({
  name: args.name,
  tier: "STANDARD",
});

const getBroken = async (): Promise<never> => {
  throw new Error("invoke blew up");
};

const fakeProvider = {
  storage: {
    FakeBucket,
    FakeQueue,
    getThing,
    getThingInfo,
    getBroken,
    Tier: { Standard: "STANDARD", Cold: "COLD" } as const,
  },
  compute: {
    FakeStack,
  },
  version: "1.2.3",
};

const eprovider = effectify(fakeProvider);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("effectify — namespace traversal", () => {
  it.effect("recurses into nested namespace objects", () =>
    Effect.gen(function* () {
      expect(typeof eprovider.storage).toBe("object");
      expect(typeof eprovider.storage.FakeBucket).toBe("function");
      expect(typeof eprovider.compute.FakeStack).toBe("function");
    })
  );

  it.effect("preserves sync functions' behaviour and surface", () =>
    Effect.gen(function* () {
      // Sync functions do get wrapped (async-ness is only detectable by
      // calling), but the Proxy leaves behaviour, name, length and identity
      // across reads intact.
      expect(eprovider.storage.getThing("x")).toBe("invoked:x");
      expect(eprovider.storage.getThing.name).toBe("getThing");
      expect(eprovider.storage.getThing.length).toBe(getThing.length);
      expect(eprovider.storage.getThing).toBe(eprovider.storage.getThing);
    })
  );

  it.effect("passes plain values and enum-like objects through", () =>
    Effect.gen(function* () {
      expect(eprovider.version).toBe("1.2.3");
      expect(eprovider.storage.Tier.Standard).toBe("STANDARD");
    })
  );

  it.effect("memoizes the proxy for a given namespace object", () =>
    Effect.gen(function* () {
      expect(eprovider.storage).toBe(eprovider.storage);
      expect(effectify(fakeProvider)).toBe(eprovider);
    })
  );

  it.effect("reports keys and membership like the wrapped namespace", () =>
    Effect.gen(function* () {
      expect(Object.keys(eprovider.storage).sort()).toEqual(
        Object.keys(fakeProvider.storage).sort()
      );
      expect("FakeBucket" in eprovider.storage).toBe(true);
      expect("Nope" in eprovider.storage).toBe(false);
    })
  );
});

describe("effectify — wrapper identity and statics", () => {
  it.effect("hands back the identical wrapper on every access", () =>
    Effect.gen(function* () {
      // Un-memoized wrapping would allocate a fresh closure per property
      // read, breaking identity comparisons and disagreeing with the
      // getOwnPropertyDescriptor trap.
      expect(eprovider.storage.FakeBucket).toBe(eprovider.storage.FakeBucket);
      expect(
        Object.getOwnPropertyDescriptor(eprovider.storage, "FakeBucket")?.value
      ).toBe(eprovider.storage.FakeBucket);
    })
  );

  it.effect("forwards codegen-style statics like `get`", () =>
    Effect.gen(function* () {
      const adopted = eprovider.storage.FakeBucket.get("adopted", "adopted-id");
      expect(adopted).toBeInstanceOf(FakeBucket);
      const { name } = yield* fromOutputs({ name: adopted.bucketName });
      expect(name).toBe("adopted-adopted");
    })
  );

  it.effect("forwards inherited statics, and instanceof still works", () =>
    Effect.gen(function* () {
      const bucket = yield* eprovider.storage.FakeBucket("static-check", {
        bucketName: "static-check-bucket",
      });
      expect(eprovider.storage.FakeBucket.isInstance(bucket)).toBe(true);
      expect(bucket instanceof eprovider.storage.FakeBucket).toBe(true);
    })
  );
});

describe("effectify — invoke wrapping", () => {
  it.effect("returns an Effect that resolves the invoke's result", () =>
    Effect.gen(function* () {
      const info = yield* eprovider.storage.getThingInfo({ name: "assets" });
      expect(info).toEqual({ name: "assets", tier: "STANDARD" });
    })
  );

  it.effect("surfaces a rejected invoke as a PulumiError", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(eprovider.storage.getBroken());
      expect(error).toBeInstanceOf(PulumiError);
      expect((error.cause as Error).message).toContain("invoke blew up");
    })
  );

  it("does not leak an unhandled rejection when the Effect is discarded", async () => {
    // The invoke starts at the call site, so a caller who drops the Effect
    // without running it must not crash the process when the call fails.
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      seen.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      void eprovider.storage.getBroken();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(seen).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it.effect("leaves non-resource classes constructible, statics intact", () =>
    Effect.gen(function* () {
      class Helper {
        constructor(readonly x: number) {}
        static make(x: number): Helper {
          return new Helper(x);
        }
      }
      const wrapped = effectify({ Helper });
      expect(new wrapped.Helper(2).x).toBe(2);
      expect(wrapped.Helper.make(3)).toBeInstanceOf(Helper);
    })
  );
});

describe("effectify — CustomResource wrapping", () => {
  it.effect("returns an Effect that constructs the resource", () =>
    Effect.gen(function* () {
      const bucket = yield* eprovider.storage.FakeBucket("wrapped", {
        bucketName: "wrapped-bucket",
      });

      expect(bucket).toBeInstanceOf(FakeBucket);

      const { name, arn } = yield* fromOutputs({
        name: bucket.bucketName,
        arn: bucket.arn,
      });
      expect(name).toBe("wrapped-bucket");
      expect(arn).toBe("arn:test:wrapped");
    })
  );

  it.effect("is lazy — nothing is constructed until the Effect runs", () =>
    Effect.gen(function* () {
      let constructed = false;
      const spied = {
        Tracked: class extends pulumi.CustomResource {
          constructor(name: string, args: Record<string, unknown>) {
            constructed = true;
            super("test:index:Tracked", name, args);
          }
        },
      };

      const effect = effectify(spied).Tracked("lazy", {});
      expect(constructed).toBe(false);

      yield* effect;
      expect(constructed).toBe(true);
    })
  );

  it.effect("converts a thrown constructor error into a PulumiError", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        eprovider.storage.FakeBucket("boom", {
          bucketName: "boom-bucket",
          explode: true,
        })
      );

      expect(Exit.isFailure(exit)).toBe(true);
      const error = yield* Effect.flip(
        eprovider.storage.FakeBucket("boom2", {
          bucketName: "boom-bucket",
          explode: true,
        })
      );
      expect(error).toBeInstanceOf(PulumiError);
      expect(error._tag).toBe("PulumiError");
      expect((error.cause as Error).message).toContain("explode was set");
      // `.message` is derived from the cause, so plain (non-Effect) logging
      // and test diffs show the failure rather than an empty string.
      expect(error.message).toContain("explode was set");
    })
  );

  it.effect("supports constructors whose args are optional", () =>
    Effect.gen(function* () {
      const queue = yield* eprovider.storage.FakeQueue("optional-args");
      expect(queue).toBeInstanceOf(FakeQueue);
    })
  );
});

describe("effectify — Effect-valued arg auto-lifting (CustomResource)", () => {
  it.effect("resolves Effect args before constructing", () =>
    Effect.gen(function* () {
      const source = yield* eprovider.storage.FakeBucket("source", {
        bucketName: "source-bucket",
      });

      const derived = yield* eprovider.storage.FakeBucket("derived", {
        // An Effect in an args slot — resolved by effectify, no manual
        // unwrapping at the call site.
        bucketName: fromOutput(source.bucketName),
      });

      const { name } = yield* fromOutputs({ name: derived.bucketName });
      expect(name).toBe("source-bucket");
    })
  );

  it.effect("propagates a failing Effect arg as the resource's error", () =>
    Effect.gen(function* () {
      const failing = Effect.fail(new PulumiError({ cause: "arg blew up" }));

      const error = yield* Effect.flip(
        eprovider.storage.FakeBucket("bad-arg", { bucketName: failing })
      );

      expect(error).toBeInstanceOf(PulumiError);
      expect(error.cause).toBe("arg blew up");
    })
  );

  it.effect("does not construct the resource when an arg Effect fails", () =>
    Effect.gen(function* () {
      let constructed = false;
      const spied = {
        Tracked: class extends pulumi.CustomResource {
          constructor(name: string, args: Record<string, unknown>) {
            constructed = true;
            super("test:index:Tracked2", name, args);
          }
        },
      };

      yield* Effect.exit(
        effectify(spied).Tracked("never", {
          value: Effect.fail(new PulumiError({ cause: "nope" })),
        })
      );

      expect(constructed).toBe(false);
    })
  );

  it.effect("leaves plain Outputs and Inputs completely untouched", () =>
    Effect.gen(function* () {
      const source = yield* eprovider.storage.FakeBucket("plain-source", {
        bucketName: "plain-source-bucket",
      });

      // No fromOutput/rewrapping — a bare Output must work exactly as it
      // does in vanilla Pulumi.
      const derived = yield* eprovider.storage.FakeBucket("plain-derived", {
        bucketName: source.bucketName,
        region: pulumi.output("eu-west-2"),
      });

      const { name, region } = yield* fromOutputs({
        name: derived.bucketName,
        region: derived.region,
      });
      expect(name).toBe("plain-source-bucket");
      expect(region).toBe("eu-west-2");
    })
  );

  it.live("resolves independent Effect args concurrently", () =>
    Effect.gen(function* () {
      // `bucketName` can only complete after `region` has run. One-at-a-time
      // resolution walks entries in insertion order, so it would park on
      // `bucketName` forever — the timeout (needs the live clock, hence
      // it.live) is what turns that regression into a failure, not a hang.
      const latch = yield* Deferred.make<void>();
      const bucket = yield* eprovider.storage
        .FakeBucket("concurrent", {
          bucketName: Deferred.await(latch).pipe(
            Effect.as("concurrent-bucket")
          ),
          region: Deferred.succeed(latch, void 0).pipe(Effect.as("eu-west-2")),
        })
        .pipe(
          Effect.timeoutFail({
            duration: "5 seconds",
            onTimeout: () =>
              new PulumiError({ cause: "args resolved sequentially" }),
          })
        );

      const { name, region } = yield* fromOutputs({
        name: bucket.bucketName,
        region: bucket.region,
      });
      expect(name).toBe("concurrent-bucket");
      expect(region).toBe("eu-west-2");
    })
  );

  it.effect("does not mutate the caller's args object", () =>
    Effect.gen(function* () {
      const args = { bucketName: Effect.succeed("no-mutate-bucket") };
      yield* eprovider.storage.FakeBucket("no-mutate", args);
      expect(Effect.isEffect(args.bucketName)).toBe(true);
    })
  );
});

describe("effectify — ComponentResource wrapping", () => {
  it.effect("wraps the constructor but passes args through verbatim", () =>
    Effect.gen(function* () {
      const args = { replicas: 3 };
      const stack = yield* eprovider.compute.FakeStack("component", args);

      expect(stack).toBeInstanceOf(FakeStack);
      expect(stack.doubled).toBe(6);
      expect(stack.receivedArgs).toBe(args); // same object, not a lifted copy
    })
  );

  it.effect("never auto-lifts Effect-valued component args", () =>
    Effect.gen(function* () {
      const sneaky = Effect.succeed(4);
      const stack = yield* eprovider.compute.FakeStack(
        "component-no-lift",
        // Type error by design (see the @ts-expect-error negative check
        // below); at runtime the Effect must arrive unresolved.
        { replicas: sneaky } as unknown as FakeStackArgs
      );

      expect((stack.receivedArgs as { replicas: unknown }).replicas).toBe(
        sneaky
      );
      expect(Number.isNaN(stack.doubled)).toBe(true);
    })
  );

  it.effect(
    "converts a thrown component constructor error to PulumiError",
    () =>
      Effect.gen(function* () {
        const spied = {
          Broken: class extends pulumi.ComponentResource {
            // The throw is the point of the fixture; the unreachable `super()`
            // below it is only there because TypeScript requires a derived
            // constructor to contain one.
            // oxlint-disable-next-line constructor-super
            constructor(name: string) {
              throw new Error("component blew up");
              // oxlint-disable-next-line no-unreachable
              super("test:index:Broken", name, {});
            }
          },
        };

        const error = yield* Effect.flip(effectify(spied).Broken("broken"));
        expect(error).toBeInstanceOf(PulumiError);
        expect((error.cause as Error).message).toContain("component blew up");
      })
  );
});

describe("output bridge", () => {
  it.effect("fromOutput resolves a single Output", () =>
    Effect.gen(function* () {
      const value = yield* fromOutput(pulumi.output("hello"));
      expect(value).toBe("hello");
    })
  );

  it.effect("fromOutputs resolves a record of Outputs", () =>
    Effect.gen(function* () {
      const resolved = yield* fromOutputs({
        a: pulumi.output(1),
        b: pulumi.output("two"),
      });
      expect(resolved).toEqual({ a: 1, b: "two" });
    })
  );

  it.effect("fromOutput surfaces a rejected Output as PulumiError", () =>
    Effect.gen(function* () {
      // A hand-rolled Output stub rather than `pulumi.output(Promise.reject(…))`:
      // a real failed Output fans its rejection out into several derived
      // promises (isKnown/isSecret/allResources) that Pulumi never awaits,
      // which surfaces as unhandled rejections in the test run. The behaviour
      // under test is only that `fromOutput` maps a rejected `promise()` onto
      // a PulumiError.
      const rejected = {
        promise: () => Promise.reject(new Error("output failed")),
      } as unknown as pulumi.Output<string>;

      const error = yield* Effect.flip(fromOutput(rejected));
      expect(error).toBeInstanceOf(PulumiError);
      expect((error.cause as Error).message).toContain("output failed");
    })
  );
});

// ---------------------------------------------------------------------------
// Type-level checks (compile-time only — `npm run build` is the assertion)
// ---------------------------------------------------------------------------

describe("effectify — type level", () => {
  it.effect("types resource factories precisely", () =>
    Effect.gen(function* () {
      const bucketEffect: Effect.Effect<FakeBucket, PulumiError> =
        eprovider.storage.FakeBucket("typed", { bucketName: "typed-bucket" });
      const bucket = yield* bucketEffect;
      const _name: pulumi.Output<string> = bucket.bucketName;

      // @ts-expect-error — unknown arg fields are still rejected.
      yield* eprovider.storage.FakeBucket("typed-bad", { nope: 1 });

      // ComponentResource args are never auto-lifted, so an Effect where a
      // bare primitive is expected must not type-check.
      yield* eprovider.compute.FakeStack("typed-component", {
        // @ts-expect-error — no lifting for components.
        replicas: Effect.succeed(2),
      });

      // A CustomResource arg, by contrast, does accept an Effect.
      yield* eprovider.storage.FakeBucket("typed-lifted", {
        bucketName: Effect.succeed("lifted"),
      });

      // Statics survive on the wrapped constructor, typed as on the class.
      const _adopted: FakeBucket = eprovider.storage.FakeBucket.get(
        "typed-adopted",
        "typed-adopted-id"
      );

      // Promise-returning invokes are typed as Effects…
      const infoEffect: Effect.Effect<
        { name: string; tier: string },
        PulumiError
      > = eprovider.storage.getThingInfo({ name: "typed" });
      void infoEffect;
      // …while sync helpers keep their plain signature.
      const _plain: string = eprovider.storage.getThing("typed");
    })
  );
});
