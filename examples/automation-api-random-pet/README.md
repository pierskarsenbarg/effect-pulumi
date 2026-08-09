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

This repo's own `.github/workflows/ci.yml` runs the example on every PR, in the
`Examples (local state)` job — read that for the working version. It uses a
local file backend rather than Pulumi Cloud, so it needs no secrets and works
on forked PRs:

```yaml
env:
  PULUMI_BACKEND_URL: file://${{ runner.temp }}/pulumi-state
  PULUMI_CONFIG_PASSPHRASE: ci   # throwaway: the state dies with the runner
  PULUMI_STACK_NAME: ci-${{ github.run_id }}
steps:
  - uses: pulumi/actions@v7      # no `command`: install-only
  - run: mkdir -p "${{ runner.temp }}/pulumi-state"
  - run: npm ci
  - run: npm run start -w effect-pulumi-automation-random-pet
  - run: npm run destroy -w effect-pulumi-automation-random-pet
    if: always()
```

For Pulumi Cloud instead, drop the two backend variables and pass
`PULUMI_ACCESS_TOKEN: ${{ secrets.PULUMI_ACCESS_TOKEN }}`.
