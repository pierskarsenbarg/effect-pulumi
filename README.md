# effect-pulumi

[![CI](https://github.com/pierskarsenbarg/effect-pulumi/actions/workflows/ci.yml/badge.svg)](https://github.com/pierskarsenbarg/effect-pulumi/actions/workflows/ci.yml)

Gives Pulumi programs Effect's composability - typed errors, sequenced
dependent resources, and structured result inspection - without hand-wrapping
every resource constructor.

## Why

Mixing Effect and Pulumi by hand means wrapping every constructor and every
data-source call yourself:

```ts
// InfraError here is a tagged error you have to define yourself
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
ranges are `@pulumi/pulumi ^3.0.0` and `effect ^3.0.0`.

`@pulumi/pulumi` and `effect` are peer dependencies - this library extends
your Pulumi and Effect runtimes, so it must use the same copies you do rather
than bundle its own. npm 7+ installs peers automatically; on pnpm or Yarn you
may need them explicitly:

```sh
npm install @pulumi/pulumi effect
```

Ships as dual ESM + CommonJS, so it works from a conventional CJS Pulumi
program as well as an ESM one - both are shown below.

## Quick start

```ts
import * as aws from "@pulumi/aws";
import { Effect } from "effect";
import { effectify, fromOutput, fromOutputs } from "effect-pulumi";

const eaws = effectify(aws); // wrap the provider package once

const program = Effect.gen(function* () {
  const bucket = yield* eaws.s3.Bucket("assets", { forceDestroy: true });
  //    ^ Effect<aws.s3.Bucket, PulumiError> - no Effect.sync / Effect.try

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

Pulumi's TypeScript programs default to CommonJS (no `"type": "module"` in
`package.json`), where top-level `await` isn't available. `fromOutput` and
`fromOutputs` resolve an Output's real value, which is genuinely
asynchronous, so `Effect.runSync` isn't an option here either - it throws on
any effect that suspends on real async work. Export the Promise itself
instead; Pulumi's engine awaits an exported Promise the same way it would an
awaited value. The `program` itself is unchanged - only the first and last
lines differ:

```ts
const aws = require("@pulumi/aws");
const { Effect } = require("effect");
const { effectify, fromOutput, fromOutputs } = require("effect-pulumi");

// ... same program ...

module.exports = Effect.runPromise(program);
```

`Effect.runSync` does work for programs that never resolve an Output's value
- e.g. [`examples/random-pet`](examples/random-pet), which exports raw
`Output`s from resource properties directly rather than reading through them
with `fromOutput`.

Alternatively, hand `program` to the [Automation API](#automation-api) as an
inline program and deploy it from the same process.

For projects you can deploy as-is, see [`examples/`](examples/).

## Automation API

`deploy` runs `createOrSelectStack` → config → `up` as one pipeline, returning
the stack handle alongside the result so callers can tear down without
re-selecting.

```ts
const exit = await Effect.runPromiseExit(
  deploy({
    stackName: "dev",
    projectName: "my-infra",
    // a PulumiFn - run the Effect, return its result as the stack outputs
    program: async () => Effect.runPromise(program),
    up: { onOutput: (out) => process.stdout.write(out) },
  })
);
// Exit/Cause instead of a thrown, stringified error
```

Stacks are either inline programs (`projectName` + `program`, above) or an
existing project on disk (`workDir`), and every operation forwards the
matching Pulumi options type - `UpOptions`, `DestroyOptions`, and so on. Pass
`onOutput` to stream the CLI's progress; without it a multi-minute deploy
prints nothing until it finishes.

Preview is opt-in via `preview: true` and comes back on
`DeployResult.preview`. It is off by default because a preview is a full
engine run, so previewing and then immediately upping does the work twice -
and `up` surfaces the same failures anyway.

Teardown is two steps: `destroyStack` removes the resources but leaves the
stack registered, while `teardownStack` destroys and then deletes it - the
latter is what per-run stacks want. Avoid `RemoveOptions.force`, which drops
a stack while leaving its resources alive and billing with nothing tracking
them.
