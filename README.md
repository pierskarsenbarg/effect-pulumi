# effect-pulumi

[![CI](https://github.com/pierskarsenbarg/effect-pulumi/actions/workflows/ci.yml/badge.svg)](https://github.com/pierskarsenbarg/effect-pulumi/actions/workflows/ci.yml)

Gives Pulumi programs Effect's composability — typed errors, sequenced
dependent resources, and structured result inspection — without hand-wrapping
every resource constructor.

## Why

Mixing Effect and Pulumi by hand means wrapping every constructor and every
data-source call yourself:

```ts
const bucket = yield* Effect.try({
  try: () => new aws.s3.Bucket("assets", { forceDestroy: true }),
  catch: (cause) => new InfraError({ cause }),
});
const ami = yield* Effect.tryPromise({
  try: () => aws.ec2.getAmi({ mostRecent: true, owners: ["amazon"] }),
  catch: (cause) => new InfraError({ cause }),
});
```

`effectify` wraps the provider package once, and both collapse to plain calls
with a shared, typed error channel:

```ts
const eaws = effectify(aws);

const bucket = yield* eaws.s3.Bucket("assets", { forceDestroy: true });
const ami = yield* eaws.ec2.getAmi({ mostRecent: true, owners: ["amazon"] });
```

## Install

```sh
npm install effect-pulumi
```

Requires Node.js ≥ 22 (the floor `@pulumi/pulumi` itself sets). The peer
ranges are `@pulumi/pulumi ^3.0.0` and `effect ^3.0.0`, currently verified
against `@pulumi/pulumi` 3.255 and `effect` 3.22.

`@pulumi/pulumi` and `effect` are peer dependencies — this library extends
your Pulumi and Effect runtimes, so it must use the same copies you do rather
than bundle its own. npm 7+ installs peers automatically; on pnpm or Yarn you
may need them explicitly:

```sh
npm install @pulumi/pulumi effect
```

Ships as dual ESM + CommonJS, so it works from a conventional CJS Pulumi
program as well as an ESM one:

```ts
import { effectify } from "effect-pulumi";   // ESM
const { effectify } = require("effect-pulumi"); // CJS
```

## Quick start

```ts
import * as aws from "@pulumi/aws";
import { Effect } from "effect";
import { effectify, fromOutput, fromOutputs } from "effect-pulumi";

const eaws = effectify(aws); // wrap the provider package once

const program = Effect.gen(function* () {
  const bucket = yield* eaws.s3.Bucket("assets", { forceDestroy: true });
  //    ^ Effect<aws.s3.Bucket, PulumiError> — no Effect.sync / Effect.try

  const object = yield* eaws.s3.BucketObject("readme", {
    bucket: fromOutput(bucket.id), // an Effect in an args slot, auto-resolved
    key: "readme.txt",
    content: "hello",
  });

  return yield* fromOutputs({ id: bucket.id, key: object.key });
});

// In a classic (ESM) Pulumi project this is the whole entrypoint: run the
// Effect at module load and export the results as stack outputs.
export const { id, key } = await Effect.runPromise(program);
```

Alternatively, hand `program` to the [Automation API](#automation-api) as an
inline program and deploy it from the same process. The full version of this
example — deployed for real by `npm run test:live` — lives in
[`examples/s3-bucket.ts`](examples/s3-bucket.ts).

## What `effectify` does

`effectify(mod)` returns a lazy, memoized proxy over a provider package:

| Export kind | Result |
| --- | --- |
| `CustomResource` subclass | `(name, args, opts?) => Effect<R, PulumiError>`, and any **top-level** args field may additionally be an `Effect` (several resolve concurrently) |
| `ComponentResource` subclass | `(name, args, opts?) => Effect<R, PulumiError>`, args passed through verbatim — never auto-lifted |
| Namespace object (`aws.s3`) | Recursively proxied, lazily |
| Invoke function (`aws.s3.getBucket`) | Returns `Effect<R, PulumiError>` instead of `Promise<R>` |
| `*Output` invoke variant (`getBucketOutput`) | Passed through untouched (returns an `Output`, as upstream) |
| Enums, plain values, sync functions | Passed through untouched |

Semantics worth knowing:

- **Outputs still work exactly as in vanilla Pulumi.** `effectify` only
  *additionally* accepts `Effect`s; passing a bare `Output<T>` or `Input<T>`
  needs no unwrapping or rewrapping.
- **Statics survive the wrapping.** `eaws.s3.Bucket.get(name, id)` (adopt an
  existing resource), `isInstance`, and any other codegen'd static forward to
  the original class — `instanceof` works too — so the wrapped package can be
  the only import a program needs.
- **Component args are never lifted.** Component args aren't guaranteed to be
  `Input<T>`-shaped the way codegen'd `CustomResource` args are — a component
  may do synchronous work on a bare primitive in its constructor — so passing
  an `Effect` where a component expects a primitive is a type error. See
  [Component resources](#component-resources) for the patterns this implies.
- **Invokes start when you call them.** Whether a function is async is only
  knowable by calling it, so `eaws.getAmi(args)` fires the invoke immediately
  and hands back an Effect that resolves the already-in-flight call — the
  failure still lands in the typed error channel, but `Effect.retry` re-awaits
  the same call rather than re-invoking. To re-invoke per attempt, defer the
  call site: `Effect.suspend(() => eaws.getAmi(args))`.

Resource registration stays synchronous under the hood; `Effect.try` runs its
thunk immediately. This removes wrapper boilerplate, not Pulumi's execution
model.

## Component resources

Component resources are fully supported as *consumers*: `effectify` detects
any class extending `pulumi.ComponentResource` — your own, or those in a
component-based package like `@pulumi/awsx` — and wraps its constructor into
an Effect factory, exactly like a custom resource. Construction errors land
in the typed error channel, and the component sequences with `yield*` like
everything else.

What differs is the args object. Custom resource args can carry `Effect`
fields because codegen guarantees they are all `Input<T>`-shaped, so
substituting a resolved value is always legal. Component args are
hand-authored: a component may take a bare `replicas: number` and do
synchronous arithmetic on it inside its constructor, and an `Effect` silently
swapped in there would break it. So for components, `effectify` refuses at
the type level instead of guessing — resolve your Effects first, then
construct with plain values:

```ts
const eawsx = effectify(awsx);

const program = Effect.gen(function* () {
  // ✗ type error — component args are never auto-lifted:
  //   eawsx.ecs.Cluster("app", { vpcId: fromOutput(vpc.id) })

  // ✓ resolve first, then pass a plain value (or just pass the Output —
  //   Input<T>-typed component args accept those as in vanilla Pulumi):
  const vpcId = yield* fromOutput(vpc.id);
  const cluster = yield* eawsx.ecs.Cluster("app", { vpcId });
});
```

*Authoring* a component is different: a `ComponentResource` constructor is
synchronous, so you cannot `yield*` inside it. Write a component's internals
in plain Pulumi — its children are ordinary constructor calls — and use
`effectify` at the program level, where composition actually happens. The
wrapped and unwrapped worlds interoperate freely: a component built from raw
Pulumi children can itself be constructed through an effectified package,
and its `Output` properties flow into `fromOutput`/`fromOutputs` like any
other resource's.

## Automation API

`deploy` runs `createOrSelectStack` → config → `up` as one pipeline, returning
the stack handle alongside the result so callers can tear down without
re-selecting.

```ts
const exit = await Effect.runPromiseExit(
  deploy({
    stackName,
    projectName,
    program: inlineProgram("dev"),
    up: { onOutput: (out) => process.stdout.write(out) },
  })
);
// Exit/Cause instead of a thrown, stringified error
```

Every operation forwards the matching Pulumi options type — `UpOptions`,
`PreviewOptions`, `RefreshOptions`, `DestroyOptions`, `RemoveOptions`. Pass
`onOutput` to stream the CLI's progress; without it a multi-minute deploy
prints nothing until it finishes. Stacks can be inline programs
(`projectName` + `program`) or an existing project on disk (`workDir`).

Previewing is opt-in via `preview: true` (or a `PreviewOptions` object), and
its result comes back on `DeployResult.preview`. It is off by default because
a preview is a full engine run against the provider, so previewing and then
immediately upping does the work twice — and `up` surfaces the same failures.

Teardown is two steps. `destroyStack` removes the resources but leaves the
stack registered with the backend; `teardownStack` destroys and then deletes
it, which is what you want for per-run stacks. `RemoveOptions.force` deletes a
stack while leaving its resources alive and billing — it is reachable, but it
orphans them.

## Handling failures

Failures are values with types, not stringified stack traces. `PulumiError`
covers resource construction and Output resolution; `AutomationError` adds
the lifecycle `stage` it came from. Both derive `.message` from the
underlying cause, so they read well even outside Effect.

```ts
import { Effect } from "effect";
import { deploy } from "effect-pulumi";

const guarded = deploy({ stackName, projectName, program }).pipe(
  // Transient engine failures during `up` are worth another attempt; a
  // failure creating the stack or setting config is not.
  Effect.retry({ times: 2, while: (error) => error.stage === "up" }),
  Effect.catchTag("AutomationError", (error) =>
    Effect.fail(new Error(`deploy failed at ${error.stage}: ${error.message}`))
  )
);
```

The same works inside a program: `Effect.catchTag("PulumiError", …)` around a
resource, or `Effect.exit` / `runPromiseExit` at the edge to inspect the full
`Cause`.

## API

| Export | What it does |
| --- | --- |
| `effectify(mod)` | Wrap a provider package (or any namespace) once; see the table above |
| `fromOutput(output)` | `Output<T>` → `Effect<T, PulumiError>`; resolves to the unknown sentinel during `preview` instead of throwing |
| `fromOutputs(record)` | Record of Outputs → `Effect` of the resolved record |
| `deploy(opts)` | Select/create stack → apply config → optional preview → `up`; returns `{ stack, result, preview? }` |
| `createOrSelectStack(opts)` | Inline (`projectName` + `program`) or local (`workDir`) stack |
| `setStackConfig(stack, config)` | Apply a whole config map in one `setAllConfig` round-trip |
| `previewStack(stack, opts?)` | `pulumi preview`, returning the `PreviewResult` |
| `upStack(stack, opts?)` | `pulumi up`, returning the `UpResult` |
| `refreshStack(stack, opts?)` | Re-sync state from the actual cloud resources |
| `stackOutputs(stack)` | Read current outputs without running an update |
| `destroyStack(stack, opts?)` | Destroy resources; the stack stays registered |
| `removeStack(stack, opts?)` | Delete the stack from the backend |
| `teardownStack(stack, opts?)` | Destroy then remove — skips the remove if the destroy failed |
| `PulumiError` | Construction / Output-resolution failure; carries `cause` |
| `AutomationError` | Lifecycle failure; carries `stage` and `cause` |

## Scripts

| Command | What it does |
| --- | --- |
| `npm run build` | Build dual ESM + CJS (`tsup`) with declarations to `dist/` |
| `npm run typecheck` | Type-check everything, including tests and examples |
| `npm test` | Unit + mocked-provider tests. No credentials needed |
| `npm run test:package` | Builds, packs a tarball and consumes it from ESM and CJS projects |
| `npm run test:live` | Deploys `examples/s3-bucket.ts` for real, then destroys it |

`npm test` never runs the live harness: it's excluded in `vitest.config.ts`
and additionally gated on `EFFECT_PULUMI_RUN_LIVE_TESTS=1`. The live harness
picks up credentials from the environment the normal way each provider expects
(e.g. `AWS_PROFILE` / `AWS_ACCESS_KEY_ID`), and uses
`Effect.acquireRelease` + `Effect.scoped` so the stack is destroyed even when
an assertion fails.
