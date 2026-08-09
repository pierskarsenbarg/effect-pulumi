import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import { Effect } from "effect";
import { effectify } from "effect-pulumi";

const erandom = effectify(random);

/** The Pulumi program itself, as an Effect.
 *
 * Nothing here knows it is being run by the Automation API - this is the same
 * program you would put in an `index.ts` next to a `Pulumi.yaml`. */
export const program = Effect.gen(function* () {
  const config = new pulumi.Config();
  const petLength = config.getNumber("petLength") ?? 2;

  const pet = yield* erandom.RandomPet("pet", { length: petLength });
  const password = yield* erandom.RandomPassword("password", {
    length: 20,
    special: true,
  });

  return {
    petName: pet.id,
    password: password.result,
  };
});
