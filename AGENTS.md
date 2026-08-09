# AGENTS.md

Guidance for coding agents working in this repository. Canonical file —
`CLAUDE.md` imports this one, so edit here.

## What this is

`effect-pulumi` — Effect bindings for Pulumi. Wrap a provider package once
with `effectify(...)` and every resource constructor becomes an
`Effect`-returning factory, with typed errors and structured deploy results.

Published to npm as dual ESM + CJS. `@pulumi/pulumi` and `effect` are **peer**
dependencies.

| Path | Role |
| --- | --- |
| `src/effectify.ts` | The core. Proxies a provider package; lifts `Effect`s in args |
| `src/output-bridge.ts` | `fromOutput` / `fromOutputs` — `Output<T>` → `Effect` |
| `src/automation.ts` | Automation API lifecycle wrappers |
| `src/errors.ts` | `PulumiError`, `AutomationError` |
| `examples/`, `test/` | Not shipped — excluded from the build and the tarball |

## Commands

| Command | Notes |
| --- | --- |
| `npm test` | Unit + mocked-provider + automation. Fast, no credentials |
| `npm run typecheck` | Type-checks **everything**, including tests and examples |
| `npm run lint` | oxlint. `lint:fix` applies the safe fixes |
| `npm run format` | oxfmt, in place. `format:check` asserts instead |
| `npm run check` | typecheck + lint + format:check in one go |
| `npm run build` | tsup → dual ESM/CJS + declarations in `dist/` |
| `npm run test:package` | Builds, packs, consumes the tarball. ~16s |
| `npm run test:live` | Real Automation API deploy via `@pulumi/random` + `@pulumi/local`. Needs the Pulumi CLI, no cloud credentials |

There are three vitest configs on purpose. The default excludes both the live
harness and the packaging suite (slow); each has its own config. Don't
collapse them.

## Things that are easy to get wrong

**Relative imports need `.js`, even in `.ts` files.** `module: NodeNext` plus
`"type": "module"`. TypeScript never rewrites specifiers, and Node's ESM
resolver has no extension guessing, so the source must name the *emitted*
file. `import { PulumiError } from "./errors.js"` is correct. `npm run lint`
now guards this — `import/extensions` is switched on in `.oxlintrc.json`
precisely because nothing else in the toolchain catches it.

**Two tsconfigs, different jobs.** `tsconfig.json` type-checks `src` +
`examples` + `test` and emits nothing. `tsconfig.build.json` is scoped to
`src` with an explicit `rootDir`, and tsup uses it for declarations. Adding
tests to the build config leaks them into the published types; pinning
`rootDir` in the type-check config is a hard error (TS6059).

**Never move `@pulumi/pulumi` or `effect` out of `peerDependencies`,** and
never let tsup inline them (they're pinned in `external`). `effectify` detects
resource constructors with `prototype instanceof pulumi.Resource` — a second
copy of `@pulumi/pulumi` in the tree makes that silently return `false` for
every constructor, so resources pass through unwrapped with no error.

**`effectify` proxies a fresh object, not the module.** Module namespace
objects (and `@pulumi/aws`'s lazy getters) expose non-configurable
properties, so a `get` trap returning a wrapper off the module itself
violates proxy invariants. It forwards via closure instead.

**`LiftedArgs` uses `A extends object`, not `Record<string, unknown>`.**
Pulumi codegen emits `interface BucketArgs`, and interfaces don't get implicit
index signatures — the stricter constraint silently disables Effect-lifting
for every real provider. Similarly, the constructor parameter tuple is mapped
homomorphically so optional args stay optional.

The rule generalises: **never constrain a generic with `Record<string, …>`.**
`fromOutputs` did, and it rejected every interface-typed bag of Outputs until
it moved to the self-referential `T extends { [K in keyof T]: Output<any> }`.
Object literals satisfy both forms, so runtime tests can't see the difference
— the guard is in `typecheck`, not `test`. Keep `Output<any>` rather than
`Output<unknown>`: `apply` puts `T` in contravariant position, so
`Output<string>` is not assignable to `Output<unknown>`.

**`Output.promise()` is not public API** but is what the runtime uses.
`fromOutput` passes `withUnknowns: true` so reading outputs during `preview`
resolves to the unknown sentinel instead of throwing.

**Component args are never lifted.** `CustomResource` args are codegen'd
`Input<T>` and safe to lift; `ComponentResource` args are hand-authored and
may be bare primitives. This asymmetry is deliberate and tested.

**Invoke wrapping is call-then-inspect, and that's forced.** There is no
runtime marker for "this function returns a Promise", so the wrapper calls
the function and wraps the result only if it's thenable. Consequences to
preserve: the invoke starts at the call site (the Effect awaits an in-flight
Promise — document, don't "fix", since laziness would require wrapping sync
functions too); rejections are pre-observed so a discarded Effect can't
become an unhandled rejection; and `pulumi.Output` must stay non-thenable
for `*Output` variants to pass through — the type mapping only rewrites
`Promise`-returning signatures, and runtime and types must agree.

**`automation.ts` has two fixed bugs with guards.** Don't reintroduce them:
`deploy` must not preview unless asked (a preview is a full engine run — doing
it before every `up` doubles the work), and no operation may substitute a
default `onOutput` (it silences all progress). Also, `teardownStack` must not
remove a stack whose destroy failed — that orphans live resources.

## Lint and format

oxlint and oxfmt, both native, both configured at the repo root. Every `"off"`
in `.oxlintrc.json` and every entry in `.oxfmtrc.json` carries a comment saying
why; read it before flipping one back on.

**oxfmt is pinned to the style already in the tree** — `printWidth: 80`,
`trailingComma: "es5"` — not to its own defaults of 100 and `"all"`. Changing
either rewrites every file, which buries the next real diff. `sortPackageJson`
is off for the same reason.

**Markdown is deliberately unformatted.** `*.md` is in `ignorePatterns`. The
docs are full of `—` and `→`, which oxfmt's table alignment measures as one
column each, and — worse — the README's ```` ```ts ```` fences are snippets
lifted out of generator bodies, so formatting them as standalone programs
reparses `yield* eaws.s3.Bucket(...)` into the binary expression
`yield * eaws...` and silently corrupts the docs.

**Four rules are off because they misread Effect or `@effect/vitest`,** not
because the code is sloppy: `require-yield` (an `Effect.gen` body that only
asserts never yields), `vitest/no-standalone-expect` (`it.effect` isn't
recognised as a test block, so all 108 assertions look standalone),
`no-underscore-dangle` (`_tag` is Effect's discriminant), and
`unicorn/no-array-sort` (wants `toSorted()`, which is ES2023 — the `lib`
follows `target: ES2022`, so it wouldn't type-check).

**Prefer an inline `oxlint-disable-next-line` with a reason** over a new
`"off"` entry when a single site is the exception. Two exist today, both in
`test/`: the component-constructor fixture that throws before its required
`super()`, and the live test's inline `onOutput`.

## Testing conventions

**The `@effect/vitest` override is load-bearing.** `@effect/vitest@0.30.0`
still declares `peer vitest@^3.2.0`, so installing vitest 4 fails `npm install`
with ERESOLVE. The `overrides` entry in `package.json` points that peer at the
root's own vitest spec (`$vitest`); the whole suite passes on vitest 4, the
range is just stale upstream. Drop the override once a stable `@effect/vitest`
accepts vitest 4 on `effect@3` — the `4.0.0-beta` line does, but it requires
`effect@4.0.0-beta`. `overrides` only applies to the root project, so it never
reaches consumers of the published package.

**Mutation-test new guards.** A test that can't go red is worth nothing.
After adding a regression guard, reintroduce the bug, confirm the test fails,
then revert. Commit first so `git checkout -- <file>` is the restore path — a
`/tmp` backup can be stranded by an interruption.

**The packaging suite asserts on the artifact, not on tsup.** Keep it that
way; swapping build tools should be validated by it, not blocked by it.

**Don't commit compiled output.** `tsc` emits `.js`/`.d.ts` next to sources
when it lacks an `outDir` — and `rootDir` errors are non-fatal, so it emits
anyway. `.gitignore` covers this; if you see stray artifacts in `src/`,
`test/` or `examples/`, delete them rather than committing them.

## Releasing

Push a semver tag to publish: `git tag v1.2.3 && git push origin v1.2.3`.
`.github/workflows/publish.yml` triggers on `v[0-9]+.[0-9]+.[0-9]+`, re-runs
the full `prepublishOnly` gate (typecheck, lint, format, test, build,
packaging suite) as explicit steps, then runs `npm publish` with provenance
and creates a GitHub Release with auto-generated notes.

**The tag is authoritative for the published version, not the committed
`package.json`.** The workflow derives the version from the tag and writes it
into `package.json` in the CI checkout right before publishing
(`npm version <tag> --no-git-tag-version --allow-same-version`) — that edit is
never committed or pushed back. There is no separate "bump package.json"
step; the repo's committed version can lag behind the last published release.

Publishing needs an `NPM_TOKEN` repo secret — an npm **Automation** token
(not "Publish", which still prompts for a 2FA OTP that nothing in CI can
answer). npm's tokenless "Trusted Publishing" (OIDC) isn't used here: it's
configured on a package's npmjs.com Settings page, which can't exist before a
first publish, and npm's docs don't confirm it works for one. Worth adopting
later, once the package exists on the registry.

## Known gaps

- **`automation.ts`'s unit tests mock `LocalWorkspace`,** so they prove
  sequencing, option forwarding and error tagging — not that the real
  Automation API accepts these arguments. The `examples` CI job now covers
  that part by deploying `examples/automation-api-random-pet` for real; what
  remains uncovered there is any behaviour specific to a cloud provider or the
  Pulumi Cloud backend.
- **Peer ranges (`^3.0.0`) are an untested claim.** Verified against
  `@pulumi/pulumi` 3.254 and `effect` 3.22 only.
- **Nothing in CI, or in `npm run test:live`, exercises a real cloud
  provider.** `test/random-password-file-program.ts` — the live fixture —
  moved from `@pulumi/aws` to `@pulumi/random` + `@pulumi/local` so it needs
  no credentials, which is what let `test:live` join the `examples` CI job.
  The AWS-shaped fixture (`test/s3-bucket-program.ts`) still exists but now
  runs only under Pulumi's mocks (`aws-provider.mocked.test.ts`), never for
  real. Real-cloud-provider coverage is a gap until something is deployed
  against an actual cloud account again — manually, or behind a credentialed
  CI job explicitly scoped for it.
  `.github/workflows/ci.yml` covers typecheck, lint, format, unit tests, build
  and packaging on PRs and pushes to `main`, plus an `examples` job that
  deploys and destroys both `@pulumi/random` examples and runs `test:live`,
  all against a local file backend (`PULUMI_BACKEND_URL=file://…`) — no
  credentials, so it works on forks too. That job is gated on the `test`
  matrix passing, so a red build skips it rather than reporting a second,
  derivative failure.

## Conventions

- Match the surrounding style; comments explain *why*, not *what*.
- Prefer adding to an existing test file over creating a new one.
- Don't add dependencies without a clear reason — the production tree is
  deliberately just `@pulumi/pulumi` and `effect`.
