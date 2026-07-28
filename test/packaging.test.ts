/**
 * Packaging regression suite.
 *
 * Everything here is about the *published artifact*, not the source: it
 * builds, packs a real tarball, installs it into a throwaway consumer
 * project, and exercises it the way a user would. It is what stops the
 * dual ESM/CJS setup and the peerDependency arrangement from silently
 * regressing — none of which the source-level tests can see.
 *
 * Excluded from the default `npm test` (it builds and packs, so it is slow)
 * and run by `npm run test:package`, which `prepublishOnly` invokes.
 *
 * The consumer project lives in os.tmpdir(); the two peers are symlinked in
 * from the repo rather than re-downloaded. Node resolves a symlinked
 * package's own dependencies from its real path, so @pulumi/pulumi still
 * finds its transitive deps in the repo's node_modules.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const localRequire = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tscBin = localRequire.resolve("typescript/bin/tsc");

/** Peers are not installed into the consumer project — they are symlinked
 * from the repo, exactly as a real install would hoist them. */
const PEERS = ["effect", "@pulumi/pulumi"];

let stage: string;
let pkgDir: string;
let manifest: Record<string, any>;
let tarballEntries: string[];

const sh = (cmd: string, cwd = repoRoot) =>
  execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const runNode = (file: string) =>
  execFileSync(process.execPath, [file], { cwd: stage, encoding: "utf8" });

/** Returns tsc's diagnostic output ("" when the project type-checks). */
const runTsc = (project: string, extraArgs: string[] = []): string => {
  try {
    execFileSync(process.execPath, [tscBin, "-p", project, ...extraArgs], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return "";
  } catch (err: any) {
    return `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
};

const write = (rel: string, body: string) => {
  const abs = path.join(stage, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
};

/** A consumer fixture that actually drives effectify, rather than just
 * importing it — this is what catches a duplicated @pulumi/pulumi, since
 * effectify detects resource constructors via `instanceof pulumi.Resource`. */
const functionalBody = (kind: "esm" | "cjs") => {
  const imports =
    kind === "esm"
      ? `import * as pulumi from "@pulumi/pulumi";
import { Effect } from "effect";
import { effectify, fromOutputs } from "effect-pulumi";`
      : `const pulumi = require("@pulumi/pulumi");
const { Effect } = require("effect");
const { effectify, fromOutputs } = require("effect-pulumi");`;

  return `${imports}
pulumi.runtime.setMocks({
  newResource: (a) => ({ id: a.name + "-id", state: { ...a.inputs } }),
  call: (a) => a.inputs,
}, "pkg", "test", false);

class Bucket extends pulumi.CustomResource {
  constructor(name, args) { super("t:index:Bucket", name, args); }
}

const wrapped = effectify({ Bucket });

Promise.resolve().then(async () => {
  const out = await Effect.runPromise(Effect.gen(function* () {
    // An Effect in an args field must still be resolved before construction.
    const b = yield* wrapped.Bucket("b", { tag: Effect.succeed("lifted") });
    return yield* fromOutputs({ tag: b.tag });
  }));
  const isResource = out.tag === "lifted";
  console.log(JSON.stringify({ tag: out.tag, ok: isResource }));
}).catch((e) => { console.error(e); process.exit(1); });
`;
};

const consumerTsconfig = (name: string) =>
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        types: [],
      },
      include: [`${name}.ts`],
    },
    null,
    2
  );

const consumerSource = `import * as pulumi from "@pulumi/pulumi";
import { Effect } from "effect";
import { effectify, fromOutput, fromOutputs, deploy, PulumiError, AutomationError } from "effect-pulumi";

declare const mod: {
  Bucket: new (name: string, args: { tag?: pulumi.Input<string> }) => pulumi.CustomResource;
};

const wrapped = effectify(mod);
const eff: Effect.Effect<pulumi.CustomResource, PulumiError> = wrapped.Bucket("b", { tag: "x" });

void eff; void fromOutput; void fromOutputs; void deploy;
void (null as unknown as AutomationError);
`;

/** Same as above plus one deliberate type error, to prove the declarations
 * are actually being read rather than silently resolving to \`any\`. */
const consumerSourceBad = `${consumerSource}
const bad: number = wrapped.Bucket("x", { tag: "y" });
void bad;
`;

beforeAll(() => {
  sh("npm run build");

  stage = fs.mkdtempSync(path.join(os.tmpdir(), "effect-pulumi-pkg-"));

  sh(`npm pack --pack-destination "${stage}"`);
  const tarball = fs
    .readdirSync(stage)
    .find((f) => f.endsWith(".tgz"))!;
  const tarballPath = path.join(stage, tarball);

  tarballEntries = sh(`tar -tzf "${tarballPath}"`)
    .split("\n")
    .map((l) => l.trim().replace(/^package\//, ""))
    .filter(Boolean);

  pkgDir = path.join(stage, "node_modules", "effect-pulumi");
  fs.mkdirSync(pkgDir, { recursive: true });
  sh(`tar -xzf "${tarballPath}" -C "${pkgDir}" --strip-components=1`);
  manifest = JSON.parse(
    fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")
  );

  for (const peer of PEERS) {
    const link = path.join(stage, "node_modules", peer);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    // "junction" is Windows-only and ignored elsewhere, so this is portable.
    fs.symlinkSync(path.join(repoRoot, "node_modules", peer), link, "junction");
  }

  write("package.json", JSON.stringify({ name: "consumer", private: true }));
  write("esm/package.json", JSON.stringify({ type: "module" }));
  write("esm/run.js", functionalBody("esm"));
  write("cjs/package.json", JSON.stringify({ type: "commonjs" }));
  write("cjs/run.js", functionalBody("cjs"));

  write("ts-esm/package.json", JSON.stringify({ type: "module" }));
  write("ts-esm/tsconfig.json", consumerTsconfig("index"));
  write("ts-esm/index.ts", consumerSource);
  write("ts-esm-bad/package.json", JSON.stringify({ type: "module" }));
  write("ts-esm-bad/tsconfig.json", consumerTsconfig("index"));
  write("ts-esm-bad/index.ts", consumerSourceBad);

  write("ts-cjs/package.json", JSON.stringify({ type: "commonjs" }));
  write("ts-cjs/tsconfig.json", consumerTsconfig("index"));
  write("ts-cjs/index.ts", consumerSource);
  write("ts-cjs-bad/package.json", JSON.stringify({ type: "commonjs" }));
  write("ts-cjs-bad/tsconfig.json", consumerTsconfig("index"));
  write("ts-cjs-bad/index.ts", consumerSourceBad);
}, 300_000);

afterAll(() => {
  if (stage) fs.rmSync(stage, { recursive: true, force: true });
});

describe("published tarball", () => {
  it("ships the build and nothing else", () => {
    expect(tarballEntries.sort()).toEqual(
      [
        "LICENSE",
        "README.md",
        "dist/index.cjs",
        "dist/index.cjs.map",
        "dist/index.d.cts",
        "dist/index.d.ts",
        "dist/index.js",
        "dist/index.js.map",
        "package.json",
      ].sort()
    );
  });

  it("leaks no source, tests or examples", () => {
    for (const entry of tarballEntries) {
      expect(entry).not.toMatch(/^src\//);
      expect(entry).not.toMatch(/^test\//);
      expect(entry).not.toMatch(/^examples\//);
      expect(entry).not.toMatch(/\.test\./);
    }
  });
});

describe("manifest", () => {
  it("is publishable", () => {
    expect(manifest.private).toBeUndefined();
    expect(manifest.name).toBe("effect-pulumi");
    expect(manifest.license).toBeTruthy();
    expect(manifest.files).toContain("dist");
  });

  it("declares @pulumi/pulumi and effect as peers, not dependencies", () => {
    expect(Object.keys(manifest.peerDependencies).sort()).toEqual([
      "@pulumi/pulumi",
      "effect",
    ]);
    // Regression guard: moving either back to `dependencies` would let a
    // consumer end up with a second copy at runtime.
    for (const peer of PEERS) {
      expect(manifest.dependencies?.[peer]).toBeUndefined();
    }
  });

  it("exposes both conditions with types listed first", () => {
    const root = manifest.exports["."];
    expect(root.import.default).toBe("./dist/index.js");
    expect(root.require.default).toBe("./dist/index.cjs");
    expect(root.import.types).toBe("./dist/index.d.ts");
    expect(root.require.types).toBe("./dist/index.d.cts");
    // "types" must precede "default" or TypeScript resolves the wrong file.
    for (const condition of ["import", "require"] as const) {
      expect(Object.keys(root[condition])[0]).toBe("types");
    }
  });
});

describe("bundle externals", () => {
  const refs = (file: string) =>
    fs.readFileSync(path.join(pkgDir, "dist", file), "utf8");

  it("imports the peers rather than inlining them (ESM)", () => {
    const src = refs("index.js");
    expect(src).toMatch(/from\s*['"]effect['"]/);
    expect(src).toMatch(/from\s*['"]@pulumi\/pulumi['"]/);
  });

  it("requires the peers rather than inlining them (CJS)", () => {
    const src = refs("index.cjs");
    expect(src).toMatch(/require\(\s*['"]effect['"]\s*\)/);
    expect(src).toMatch(/require\(\s*['"]@pulumi\/pulumi['"]\s*\)/);
  });

  it("stays small, which inlining a peer would blow past", () => {
    for (const file of ["index.js", "index.cjs"]) {
      const bytes = fs.statSync(path.join(pkgDir, "dist", file)).size;
      expect(bytes).toBeLessThan(50_000);
    }
  });
});

describe("consuming the packed package", () => {
  it("works from an ESM consumer, end to end", () => {
    const out = JSON.parse(runNode(path.join(stage, "esm", "run.js")));
    // Proves both that the import resolved and that effectify still
    // recognises resource constructors through the packed build.
    expect(out).toEqual({ tag: "lifted", ok: true });
  }, 120_000);

  it("works from a CJS consumer, end to end", () => {
    const out = JSON.parse(runNode(path.join(stage, "cjs", "run.js")));
    expect(out).toEqual({ tag: "lifted", ok: true });
  }, 120_000);
});

describe("consumer type resolution", () => {
  it("type-checks from an ESM consumer", () => {
    expect(runTsc(path.join(stage, "ts-esm", "tsconfig.json"))).toBe("");
  }, 180_000);

  it("type-checks from a CJS consumer", () => {
    expect(runTsc(path.join(stage, "ts-cjs", "tsconfig.json"))).toBe("");
  }, 180_000);

  it("actually enforces types under both conditions", () => {
    // If the declarations failed to resolve, these would silently pass as
    // `any` — so the negative case is the real assertion.
    expect(runTsc(path.join(stage, "ts-esm-bad", "tsconfig.json"))).toMatch(
      /error TS/
    );
    expect(runTsc(path.join(stage, "ts-cjs-bad", "tsconfig.json"))).toMatch(
      /error TS/
    );
  }, 180_000);

  it("resolves ESM to index.d.ts and CJS to index.d.cts", () => {
    const resolved = (dir: string) => {
      const trace = runTsc(path.join(stage, dir, "tsconfig.json"), [
        "--traceResolution",
      ]);
      const hit = [...trace.matchAll(/effect-pulumi[/\\]dist[/\\](index\.d\.[cm]?ts)/g)];
      return new Set(hit.map((m) => m[1]));
    };
    expect(resolved("ts-esm")).toEqual(new Set(["index.d.ts"]));
    expect(resolved("ts-cjs")).toEqual(new Set(["index.d.cts"]));
  }, 180_000);
});
