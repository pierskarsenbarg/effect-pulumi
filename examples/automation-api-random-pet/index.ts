import { Effect } from "effect";
import { deploy } from "effect-pulumi";
import { config, main, onOutput, stackName, stackOptions } from "./stack.js";

const deployment = Effect.gen(function* () {
  yield* Effect.log(`deploying stack ${stackName}`);

  const { result } = yield* deploy({
    ...stackOptions,
    config,
    up: { onOutput },
  });

  yield* Effect.log(`update ${result.summary.result}`);
  yield* Effect.log(`pet name: ${result.outputs.petName?.value}`);
  yield* Effect.log(
    `password: ${result.outputs.password?.secret ? "<secret>" : result.outputs.password?.value}`
  );
});

main(deployment);
