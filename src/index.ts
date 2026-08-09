/**
 * effect-pulumi — Effect bindings for Pulumi.
 *
 * Three independent pieces, usable together or apart:
 *
 * - {@link effectify} wraps a provider package so every resource constructor
 *   returns an `Effect` instead of throwing.
 * - {@link fromOutput} / {@link fromOutputs} bridge `Output<T>` into the
 *   Effect world.
 * - The Automation API wrappers ({@link deploy}, {@link teardownStack} and the
 *   primitives they compose) drive stacks from ordinary Node programs.
 *
 * Failures are typed: {@link PulumiError} for resource and Output problems,
 * {@link AutomationError} — carrying the `stage` that failed — for lifecycle
 * calls.
 *
 * `@pulumi/pulumi` and `effect` are peer dependencies, and must resolve to a
 * single copy: `effectify` identifies resources with `instanceof
 * pulumi.Resource`, which a duplicate `@pulumi/pulumi` in the tree would
 * silently defeat.
 *
 * @packageDocumentation
 */

export * from "./errors.js";
export * from "./output-bridge.js";
export * from "./effectify.js";
export * from "./automation.js";
