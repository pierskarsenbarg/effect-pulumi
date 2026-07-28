# effect-pulumi

Gives Pulumi programs Effect's composability — typed errors, sequenced
dependent resources, and structured result inspection — without hand-wrapping
every resource constructor.

## Install

```sh
npm install effect-pulumi
```

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
```

## What `effectify` does

`effectify(mod)` returns a lazy, memoized proxy over a provider package:

| Export kind | Result |
| --- | --- |
| `CustomResource` subclass | `(name, args, opts?) => Effect<R, PulumiError>`, and any **top-level** args field may additionally be an `Effect` |
| `ComponentResource` subclass | `(name, args, opts?) => Effect<R, PulumiError>`, args passed through verbatim — never auto-lifted |
| Namespace object (`aws.s3`) | Recursively proxied, lazily |
| Invoke function (`aws.s3.getBucket`) | Passed through untouched |
| Enums, plain values | Passed through untouched |

Static members survive the wrapping: `eaws.s3.Bucket.get(name, id)` (adopt an
existing resource), `isInstance`, and any other codegen'd static forward to
the original class, so the wrapped package can be the only import a program
needs. When several args fields are Effects, they resolve concurrently.

Two properties worth stating explicitly:

- **Outputs still work exactly as in vanilla Pulumi.** `effectify` only
  *additionally* accepts `Effect`s; passing a bare `Output<T>` or `Input<T>`
  needs no unwrapping or rewrapping.
- **Component args are never lifted.** Component args aren't guaranteed to be
  `Input<T>`-shaped the way codegen'd `CustomResource` args are — a component
  may do synchronous work on a bare primitive in its constructor — so passing
  an `Effect` where a component expects a primitive is a type error.

Resource registration stays synchronous under the hood; `Effect.try` runs its
thunk immediately. This removes wrapper boilerplate, not Pulumi's execution
model.

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
`onOutput` to stream
the CLI's progress; without it a multi-minute deploy prints nothing until it
finishes. Stacks can be inline programs (`projectName` + `program`) or an
existing project on disk (`workDir`).

Previewing is opt-in via `preview: true` (or a `PreviewOptions` object), and
its result comes back on `DeployResult.preview`. It is off by default because
a preview is a full engine run against the provider, so previewing and then
immediately upping does the work twice — and `up` surfaces the same failures.

For anything beyond that, compose the exported primitives directly:
`createOrSelectStack`, `setStackConfig`, `previewStack`, `upStack`,
`refreshStack`, `stackOutputs`, `destroyStack`, `removeStack`,
`teardownStack`. `refreshStack` re-syncs state from the actual cloud
resources; `stackOutputs` reads the current outputs without running an
update.

Teardown is two steps. `destroyStack` removes the resources but leaves the
stack registered with the backend; `teardownStack` destroys and then deletes
it, which is what you want for per-run stacks. `RemoveOptions.force` deletes a
stack while leaving its resources alive and billing — it is reachable, but it
orphans them.

Failures are typed: `PulumiError` for resource construction and Output
resolution, `AutomationError` (tagged with the failing `stage`) for lifecycle
calls.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run build` | Build dual ESM + CJS (`tsup`) with declarations to `dist/` |
| `npm run typecheck` | Type-check everything, including tests and examples |
| `npm test` | Unit + mocked-provider tests. No credentials needed |
| `npm run test:live` | Deploys `examples/s3-bucket.ts` for real, then destroys it |

`npm test` never runs the live harness: it's excluded in `vitest.config.ts`
and additionally gated on `EFFECT_PULUMI_RUN_LIVE_TESTS=1`. The live harness
picks up credentials from the environment the normal way each provider expects
(e.g. `AWS_PROFILE` / `AWS_ACCESS_KEY_ID`), and uses
`Effect.acquireRelease` + `Effect.scoped` so the stack is destroyed even when
an assertion fails.
