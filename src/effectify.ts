/**
 * effectify — auto-wrap a Pulumi provider package (e.g. @pulumi/aws,
 * @pulumi/cloudflare) so every resource constructor becomes an
 * Effect-returning factory, without the caller ever writing `Effect.sync`.
 *
 * Usage:
 *
 *   import * as aws from "@pulumi/aws";
 *   const eaws = effectify(aws);
 *
 *   const program = Effect.gen(function* () {
 *     const bucket = yield* eaws.s3.Bucket("my-bucket", { forceDestroy: true });
 *     //    ^ Effect<aws.s3.Bucket, PulumiError> — no manual wrapping
 *   });
 *
 * How it works:
 *  - Every Pulumi resource class extends `pulumi.Resource` under the hood
 *    (via CustomResource / ComponentResource). That's the runtime marker
 *    used to tell "this export is a resource constructor" apart from "this
 *    export is a namespace object" (e.g. `aws.s3`) or "this export is an
 *    invoke function" (e.g. `aws.s3.getBucket`).
 *  - Namespace objects get recursively proxied (lazily, memoized).
 *  - CustomResource constructors get wrapped so any field in their args
 *    object may *additionally* be an Effect — resolved (concurrently, they
 *    are independent by construction) before construction. This is safe
 *    because codegen guarantees CustomResource args are always
 *    Record<string, Input<T>>.
 *  - Wrapped constructors keep their static members: `Bucket.get(...)`,
 *    `Bucket.isInstance(...)` and friends forward to the original class, so
 *    the wrapped package can be the only import a program needs.
 *  - ComponentResource constructors get wrapped with no arg-lifting — args
 *    pass through exactly as declared, since component args aren't
 *    guaranteed to be Input<T>-shaped (hand-authored, may do synchronous
 *    work on a bare primitive inside the constructor).
 *  - Invoke functions (`aws.s3.getBucket`) return an Effect instead of a
 *    Promise. There is no runtime marker for "this function is async", so
 *    the wrapper calls the function and inspects the result: a thenable
 *    becomes an Effect, anything else is returned as-is. That means the
 *    invoke *starts* at the call site (see the caveat on `wrapInvokeLike`);
 *    `*Output` invoke variants return an Output, which is not thenable, so
 *    they pass through untouched — matching the type-level mapping, which
 *    only rewrites Promise-returning signatures.
 *  - Everything else (enums, plain values, non-resource classes) passes
 *    through untouched.
 *
 * Resource registration remains synchronous under the hood — Effect.try
 * runs its thunk immediately. This only removes hand-written wrapper
 * boilerplate, not Pulumi's execution model.
 */

import * as pulumi from "@pulumi/pulumi";
import { Effect } from "effect";
import { PulumiError } from "./errors.js";

// ---------------------------------------------------------------------------
// Runtime type guards
// ---------------------------------------------------------------------------

const isResourceConstructor = (
  value: unknown
): value is new (...args: any[]) => pulumi.Resource =>
  typeof value === "function" &&
  (value === (pulumi.Resource as unknown) ||
    value.prototype instanceof pulumi.Resource);

const isComponentResourceConstructor = (
  Ctor: Function
): Ctor is new (...args: any[]) => pulumi.ComponentResource =>
  Ctor === (pulumi.ComponentResource as unknown) ||
  Ctor.prototype instanceof pulumi.ComponentResource;

/** An object whose string-keyed properties we only ever *read*. Distinct from
 * `Record<string, unknown>`, which additionally claims the properties are
 * writable and that the object declares an index signature — neither is true
 * of a codegen'd `BucketArgs`, and neither is something this module relies on. */
type UnknownProps = { readonly [key: string]: unknown };

/** Is this a namespace to recurse into? The narrowed type is only ever handed
 * to `effectifyInner`, which takes `object` — so claim exactly that and no
 * more. */
const isNamespace = (value: unknown): value is object =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Is this an args object whose entries we can scan for Effects? Same runtime
 * check as `isNamespace`, but a different question, so it gets the narrowing
 * that question needs: `object` would make `Object.entries` infer `any` values
 * and silently drop the `isEffect` filter's type safety. */
const isArgsObject = (value: unknown): value is UnknownProps =>
  isNamespace(value);

/** Note: `pulumi.Output` is deliberately not thenable, so `*Output` invoke
 * variants fail this check and pass through unwrapped — keeping the runtime
 * behaviour aligned with the type mapping, which only rewrites
 * Promise-returning signatures. */
const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { then?: unknown }).then === "function";

// ---------------------------------------------------------------------------
// Type-level mapping
// ---------------------------------------------------------------------------

/** Allow any field of a CustomResource args object to *additionally* be an
 * Effect. Homomorphic, so optional fields stay optional and plain
 * `Input<T>`/`Output<T>` values keep working untouched. */
type LiftedArgs<A> = A extends object
  ? { [K in keyof A]: A[K] | Effect.Effect<A[K], PulumiError> }
  : A;

/** Apply `LiftedArgs` to the second constructor parameter (the args object),
 * leaving `name` and `opts` alone. Mapping over the parameter tuple
 * homomorphically preserves labels and optionality, so constructors whose
 * args are optional stay callable as `Bucket("name")`. */
type LiftArgsParam<P extends readonly unknown[]> = {
  [K in keyof P]: K extends "1" ? LiftedArgs<P[K]> : P[K];
};

/** The class's static side, minus `prototype`: `keyof` on a constructor type
 * yields exactly the statics (own and inherited, e.g. codegen'd `get` and
 * `isInstance`), which the runtime wrapper forwards to the original class. */
type StaticMembers<T> = Omit<T, "prototype">;

export type Effectify<T> = T extends abstract new (
  ...params: infer P
) => infer R
  ? R extends pulumi.ComponentResource
    ? ((...params: P) => Effect.Effect<R, PulumiError>) & StaticMembers<T>
    : R extends pulumi.CustomResource
      ? ((...params: LiftArgsParam<P>) => Effect.Effect<R, PulumiError>) &
          StaticMembers<T>
      : T
  : T extends (...args: infer A) => Promise<infer R>
    ? (...args: A) => Effect.Effect<R, PulumiError>
    : T extends (...args: any[]) => any
      ? T
      : T extends object
        ? { [K in keyof T]: Effectify<T[K]> }
        : T;

// ---------------------------------------------------------------------------
// Runtime implementation
// ---------------------------------------------------------------------------

const proxyCache = new WeakMap<object, unknown>();

const isEffect = (value: unknown): value is Effect.Effect<unknown, unknown> =>
  Effect.isEffect(value);

function resolveLiftedArgs(
  args: unknown
): Effect.Effect<unknown, PulumiError> {
  if (!isArgsObject(args)) {
    return Effect.succeed(args);
  }

  const effectEntries = Object.entries(args).filter(([, v]) => isEffect(v));

  if (effectEntries.length === 0) {
    return Effect.succeed(args);
  }

  // The arg Effects are independent of one another, so resolve them
  // concurrently — it matters when several of them await slow Outputs.
  return Effect.map(
    Effect.all(
      effectEntries.map(([key, effectValue]) =>
        Effect.map(
          effectValue as Effect.Effect<unknown, PulumiError>,
          (resolved) => [key, resolved] as const
        )
      ),
      { concurrency: "unbounded" }
    ),
    (resolved) => ({ ...args, ...Object.fromEntries(resolved) })
  );
}

function wrapCustomResourceCtor(
  Ctor: new (...args: any[]) => pulumi.CustomResource
) {
  return (name: string, args?: unknown, opts?: unknown) =>
    Effect.gen(function* () {
      const resolvedArgs = yield* resolveLiftedArgs(args);
      return yield* Effect.try({
        try: () => new Ctor(name, resolvedArgs, opts),
        catch: (cause) => new PulumiError({ cause }),
      });
    });
}

function wrapComponentResourceCtor(
  Ctor: new (...args: any[]) => pulumi.ComponentResource
) {
  return (name: string, args?: unknown, opts?: unknown) =>
    Effect.try({
      try: () => new Ctor(name, args, opts),
      catch: (cause) => new PulumiError({ cause }),
    });
}

/** Forward static members (codegen'd `get`, `isInstance`, …) from the class
 * onto the factory. The factory's own and inherited properties (`name`,
 * `length`, `call`, …) win; anything else falls through to the class, so new
 * statics keep working without being enumerated here. A bonus of forwarding
 * `prototype` is that `x instanceof wrapped` still works. */
const withStatics = <F extends object>(factory: F, Ctor: Function): F =>
  new Proxy(factory, {
    get: (target, prop, receiver) =>
      Reflect.has(target, prop)
        ? Reflect.get(target, prop, receiver)
        : Reflect.get(Ctor, prop),
    has: (target, prop) =>
      Reflect.has(target, prop) || Reflect.has(Ctor, prop),
  });

function wrapResourceCtor(Ctor: new (...args: any[]) => pulumi.Resource) {
  const factory = isComponentResourceConstructor(Ctor)
    ? wrapComponentResourceCtor(Ctor)
    : wrapCustomResourceCtor(
        Ctor as new (...args: any[]) => pulumi.CustomResource
      );
  return withStatics(factory, Ctor);
}

/** Turn a Promise-returning invoke into an Effect-returning one, leaving
 * synchronous functions' behaviour untouched.
 *
 * A Proxy over the original function (rather than a new function) so `name`,
 * `length`, own properties and prototype all survive; only the call itself is
 * intercepted.
 *
 * Caveat, stated openly: whether a function is async is only knowable by
 * calling it, so the invoke *starts* when the factory is called — the Effect
 * resolves an already-in-flight Promise rather than deferring the call. Two
 * consequences:
 *  - `Effect.retry` re-awaits the same call instead of re-invoking. To
 *    re-invoke per attempt, wrap the call site: `Effect.suspend(() =>
 *    eaws.getAmi(args))`.
 *  - A discarded Effect must not surface as an unhandled rejection, so the
 *    rejection is pre-observed on a side branch before the Effect awaits it.
 */
function wrapInvokeLike(fn: Function): Function {
  return new Proxy(fn, {
    apply(target, thisArg, args) {
      const result = Reflect.apply(target, thisArg, args);
      if (!isPromiseLike(result)) {
        return result;
      }
      result.then(undefined, () => {});
      return Effect.tryPromise({
        try: () => result as Promise<unknown>,
        catch: (cause) => new PulumiError({ cause }),
      });
    },
  });
}

/** Wrapped constructors are cached so repeated reads of the same property
 * hand back the same function — identity checks like
 * `eaws.s3.Bucket === eaws.s3.Bucket` hold, and the `get` and
 * `getOwnPropertyDescriptor` traps agree on a property's value. */
const wrapperCache = new WeakMap<object, unknown>();

function effectifyValue(value: unknown): unknown {
  if (isResourceConstructor(value)) {
    const cached = wrapperCache.get(value);
    if (cached) return cached;
    const wrapped = wrapResourceCtor(value);
    wrapperCache.set(value, wrapped);
    return wrapped;
  }

  if (typeof value === "function") {
    const cached = wrapperCache.get(value);
    if (cached) return cached;
    const wrapped = wrapInvokeLike(value);
    wrapperCache.set(value, wrapped);
    return wrapped;
  }

  if (isNamespace(value)) {
    return effectifyInner(value);
  }

  return value; // plain value, enum member, type-only export
}

function effectifyInner<T extends object>(mod: T): Effectify<T> {
  const cached = proxyCache.get(mod);
  if (cached) return cached as Effectify<T>;

  // The proxy target is a fresh plain object rather than `mod` itself: ES
  // module namespace objects (and @pulumi/aws's lazily-defined namespace
  // getters) expose non-configurable own properties, and a `get` trap that
  // returns a wrapper instead of the real value would violate the proxy
  // invariants for those. Forwarding to `mod` from a closure sidesteps that
  // entirely while keeping the lazy-loading behaviour intact.
  const proxy = new Proxy(Object.create(null) as T, {
    get(_target, prop) {
      return effectifyValue(Reflect.get(mod, prop));
    },
    has(_target, prop) {
      return Reflect.has(mod, prop);
    },
    ownKeys() {
      return Reflect.ownKeys(mod);
    },
    getOwnPropertyDescriptor(_target, prop) {
      const descriptor = Reflect.getOwnPropertyDescriptor(mod, prop);
      if (!descriptor) return undefined;
      // Must be reported as configurable — the target does not actually have
      // the property, so claiming otherwise breaks the proxy invariants.
      return {
        value: effectifyValue(Reflect.get(mod, prop)),
        enumerable: descriptor.enumerable,
        configurable: true,
        writable: true,
      };
    },
    set() {
      return false; // the wrapper is read-only
    },
  }) as Effectify<T>;

  proxyCache.set(mod, proxy);
  return proxy;
}

/** Wrap a provider package (or any namespace) once. */
export function effectify<T extends object>(mod: T): Effectify<T> {
  return effectifyInner(mod);
}
