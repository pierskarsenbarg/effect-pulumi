import type { ConfigMap, PulumiFn } from "@pulumi/pulumi/automation/index.js";
import { Effect } from "effect";
import type { AutomationError, InlineStackOptions } from "effect-pulumi";
import { program } from "./program.js";

export const projectName = "effect-pulumi-automation-random-pet";

/** Stack name comes from the environment so CI can deploy an ephemeral stack
 * per run without editing the source. */
export const stackName = process.env.PULUMI_STACK_NAME ?? "dev";

/** Stream the CLI's progress. Without an `onOutput` nothing is printed while
 * an operation runs — the text only appears on the result once it finishes. */
export const onOutput = (out: string) => {
  process.stdout.write(out);
};

/** `PulumiFn` is promise-returning, so this is the one place the Effect
 * program is run: the Automation API awaits it inside the Pulumi engine. */
const asPulumiFn: PulumiFn = () => Effect.runPromise(program);

export const stackOptions: InlineStackOptions = {
  stackName,
  projectName,
  program: asPulumiFn,
};

export const config: ConfigMap = {
  [`${projectName}:petLength`]: { value: process.env.PET_LENGTH ?? "3" },
};

/** Run an Effect as the process entry point: print the failure and exit
 * non-zero so a CI step fails, rather than surfacing an unhandled rejection. */
export const main = (effect: Effect.Effect<void, AutomationError>): void => {
  Effect.runPromise(effect).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
};
