# effect-pulumi

[![CI](https://github.com/pierskarsenbarg/effect-pulumi/actions/workflows/ci.yml/badge.svg)](https://github.com/pierskarsenbarg/effect-pulumi/actions/workflows/ci.yml)

Gives Pulumi programs Effect's composability - typed errors, sequenced
dependent resources, and structured result inspection - without hand-wrapping
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

`@pulumi/pulumi` and `effect` are peer dependencies - this library extends
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
awaited value:

```ts
const aws = require("@pulumi/aws");
const { Effect } = require("effect");
const { effectify, fromOutput, fromOutputs } = require("effect-pulumi");

const eaws = effectify(aws);

const program = Effect.gen(function* () {
  const bucket = yield* eaws.s3.Bucket("assets", { forceDestroy: true });

  const object = yield* eaws.s3.BucketObject("readme", {
    bucket: fromOutput(bucket.id),
    key: "readme.txt",
    content: "hello",
  });

  return yield* fromOutputs({ id: bucket.id, key: object.key });
});

module.exports = Effect.runPromise(program);
```

`Effect.runSync` does work for programs that never resolve an Output's value
- e.g. [`examples/random-pet`](examples/random-pet), which exports raw
`Output`s from resource properties directly rather than reading through them
with `fromOutput`.

Alternatively, hand `program` to the [Automation API](#automation-api) as an
inline program and deploy it from the same process.

The full version of the program above lives in
[`test/s3-bucket-program.ts`](test/s3-bucket-program.ts). It sits in `test/`
rather than `examples/` because it is a fixture rather than a project you can
run - its only consumer today is the mocked suite in `npm test`, exercising a
real `@pulumi/aws` package under Pulumi's mocks, no cloud account involved.

For examples you can actually deploy, see [`examples/`](examples/) - those use
`@pulumi/random`, whose resources take no inputs from one another, so they
don't show `fromOutput` or an Effect in an args slot. For that, see
[`test/random-password-file-program.ts`](test/random-password-file-program.ts):
a `RandomPassword`'s Output flows into a `local.File`'s args, and it's
deployed for real by `npm run test:live` - no cloud credentials needed, since
`@pulumi/local` only touches the local filesystem.
