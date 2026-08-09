import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  // Dual build. With "type": "module" in package.json, tsup emits the ESM
  // build as .js and the CJS build as .cjs, with matching .d.ts / .d.cts.
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: "es2022",
  outDir: "dist",
  // Type declarations are generated from the src-scoped config, so tests and
  // examples stay out of the published types.
  tsconfig: "tsconfig.build.json",
  // @pulumi/pulumi and effect are peerDependencies - they must resolve to the
  // consumer's copy, never be inlined here. tsup externalises deps and peers
  // by default; this is belt-and-braces because inlining either one would be
  // a silent, hard-to-diagnose breakage (duplicate Effect runtime, or a
  // second @pulumi/pulumi that Pulumi's resource registration won't recognise).
  external: ["@pulumi/pulumi", "effect"],
});
