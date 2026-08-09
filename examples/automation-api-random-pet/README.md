# automation-api-random-pet

Drives an **inline** Pulumi program with the Automation API, using
`effect-pulumi` on both sides: `effectify` inside the program, and the
Automation wrappers (`deploy`, `createOrSelectStack`, `destroyStack`) around
it. There is no `Pulumi.yaml` — the program is the function in `program.ts`.

## Run it

```sh
npm install          # from the repo root; this also builds effect-pulumi
npm run start  -w effect-pulumi-automation-random-pet
npm run destroy -w effect-pulumi-automation-random-pet
```

Both scripts compile to `bin/` first, so `node` runs plain JavaScript and no
TypeScript loader is needed.

Requirements: the Pulumi CLI on `PATH`, and credentials for a backend
(`PULUMI_ACCESS_TOKEN`, or `pulumi login --local` with
`PULUMI_CONFIG_PASSPHRASE` set). The `random` provider needs no cloud account.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PULUMI_STACK_NAME` | `dev` | Stack to create/select |
| `PET_LENGTH` | `3` | Words in the generated pet name — set as stack config |

## In GitHub Actions

```yaml
- uses: pulumi/actions@v6            # puts the Pulumi CLI on PATH
- run: npm ci
- run: npm run start -w effect-pulumi-automation-random-pet
  env:
    PULUMI_ACCESS_TOKEN: ${{ secrets.PULUMI_ACCESS_TOKEN }}
    PULUMI_STACK_NAME: ci-${{ github.run_id }}
- run: npm run destroy -w effect-pulumi-automation-random-pet
  if: always()
  env:
    PULUMI_ACCESS_TOKEN: ${{ secrets.PULUMI_ACCESS_TOKEN }}
    PULUMI_STACK_NAME: ci-${{ github.run_id }}
```

A per-run stack name leaves an empty stack behind each time; switch
`destroy.ts` to `teardownStack` to delete the stack too.
