import * as random from "@pulumi/random";
import { Effect } from "effect";
import type { Effectify } from "effect-pulumi";
import { effectify } from "effect-pulumi";

const erandom = effectify(random);

/** `Effectify<T>` is the type of an already-wrapped package, which is what
 * lets a helper take one as a parameter instead of calling `effectify` itself.
 * Writing `typeof erandom` would work here too; naming the type is what you
 * need once the helper lives in another module, where the wrapped value is not
 * in scope to take `typeof` of. */
const namedPet = (
  provider: Effectify<typeof random>,
  name: string,
  words: number
) => provider.RandomPet(name, { length: words });

const program = Effect.gen(function* () {
  const pet = yield* namedPet(erandom, "pet", 2);
  const pw = yield* erandom.RandomPassword("pw", {
    length: 20,
  });
  return {
    petName: pet.id,
    password: pw.result,
  };
});

export const { petName, password } = Effect.runSync(program);
