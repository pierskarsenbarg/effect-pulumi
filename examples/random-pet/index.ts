import * as random from "@pulumi/random";
import { Effect } from "effect";
import { effectify } from "effect-pulumi";

const erandom = effectify(random);

const program = Effect.gen(function* () {
  const pet = yield* erandom.RandomPet("pet", {
    length: 2,
  });
  return {
    petName: pet.id,
  };
});

export const { petName } = Effect.runSync(program);
