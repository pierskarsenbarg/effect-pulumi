import * as random from "@pulumi/random";
import { Effect } from "effect";
import { effectify } from "effect-pulumi";

const erandom = effectify(random);

const program = Effect.gen(function* () {
  const pet = yield* erandom.RandomPet("pet", {
    length: 2,
  });
  const pw = yield* erandom.RandomPassword("pw", {
    length: 20,
  });
  return {
    petName: pet.id,
    password: pw.result,
  };
});

export const { petName, password } = Effect.runSync(program);
