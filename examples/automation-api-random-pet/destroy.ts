import { Effect } from "effect";
import { createOrSelectStack, destroyStack, removeStack } from "effect-pulumi";
import { main, onOutput, stackName, stackOptions } from "./stack.js";

// Destroys the resources, then deletes the stack from the backend, so a
// per-run stack name doesn't leave a trail of empty stacks. Drop the
// `removeStack` call to keep the stack for the next `npm run start`.
const teardown = Effect.gen(function* () {
  yield* Effect.log(`destroying stack ${stackName}`);

  // An inline stack is defined by its program, so selecting it needs the same
  // options the deploy used.
  const stack = yield* createOrSelectStack(stackOptions);
  const result = yield* destroyStack(stack, { onOutput });

  yield* Effect.log(`destroy ${result.summary.result}`);

  yield* removeStack(stack, { force: true });
  yield* Effect.log(`stack removed`);
});

main(teardown);
