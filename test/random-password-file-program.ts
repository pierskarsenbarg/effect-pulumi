/**
 * Shared fixture: a small program that uses the parts of the library the
 * `@pulumi/random` examples cannot reach on their own - `fromOutput`/
 * `fromOutputs`, an Effect passed into a resource's args, and one resource
 * depending on another's Output - without needing cloud credentials.
 * `RandomPassword`'s output flows into a `local.File`'s content, and
 * `fromOutputs` pulls back `contentSha256`: not an input we supplied, but a
 * checksum the provider computes from whatever it actually wrote to disk.
 * Asserting that against an independently computed hash of the password is
 * what makes this a real test of the dependency, rather than a check that
 * Pulumi's state faithfully echoes back a value we handed it ourselves.
 *
 * Deliberately not named `*.test.ts`: vitest's `include` globs would try to
 * collect it as a suite and fail on finding no tests. Its only consumer is
 * `random-password.live.test.ts`, which deploys it for real - `@pulumi/local`
 * only touches the local filesystem, so this needs the Pulumi CLI and a state
 * backend but no credentials.
 */

import * as random from "@pulumi/random";
import * as local from "@pulumi/local";
import { Effect } from "effect";
import { effectify, fromOutput, fromOutputs } from "../src/index.js";

const erandom = effectify(random);
const elocal = effectify(local);

const localFileProgram = (envName: string) =>
  Effect.gen(function* () {
    const pw = yield* erandom.RandomPassword(`${envName}-pw`, {
      length: 20,
    });

    // The password Output flows straight into another resource's args -
    // arg-lifting resolves it before `File` is constructed.
    const file = yield* elocal.File(`${envName}-file`, {
      filename: `${envName}-file`,
      content: fromOutput(pw.result),
    });

    // `contentSha256` isn't in `FileArgs` - it can't be supplied, only read
    // back once the provider has computed it from the file it wrote.
    const { contentSha256, fileName, password } = yield* fromOutputs({
      contentSha256: file.contentSha256,
      fileName: file.filename,
      password: pw.result,
    });

    return { contentSha256, fileName, password };
  });

/** The program as a `PulumiFn`, which is the shape the Automation API takes.
 * Returns raw values, not Outputs: the CLI builds `UpResult.outputs` from
 * whatever the inline program returns, so wrapping them here would nest them
 * as `outputs.contentSha256.value.value`. */
export const inlineProgram = (envName: string) => async () => {
  const { contentSha256, fileName, password } = await Effect.runPromise(
    localFileProgram(envName)
  );
  return { contentSha256, fileName, password };
};
