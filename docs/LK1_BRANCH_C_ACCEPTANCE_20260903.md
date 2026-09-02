# LK1 Branch C acceptance — 2026-09-03

## Frozen source

- preserved checkpoint: `767b3f42fcfffb759691c071d3039ea0f440dba4`;
- frozen `origin/main`: `780210d9e324c3dea1d74d7886a62667c3fa4559`;
- ordinary merge, no rebase: `63d7ae06cf28a89b9187172e8b925e44dc87d0a4`;
- no push, merge to `main`, deployment, activation, or provider/data write was
  performed.

## Current-main review and source verification

- The preserved Atlas full-dataset, stale-pagination, exact-success,
  unknown-intent and cross-tab/reload guards remain in the ancestry.
- Current PITER pricing intentionally charges 70% of the full authoritative
  price for 90/120 minutes. The decision UI no longer infers or promises a
  free first hour from duration alone; it shows only the exact server amount.
- The Partner Game Membership candidate remains outside ordinary frontend
  source (`0` exact API/enable markers in `src`) and its patcher remains
  fail-closed behind exact enablement globals.
- The direct read-only Node-RED source identity on `lk-primary-147` was
  `sha256:d5dd1564fd0dd89d736d7d5b305d44563b87df9d1b9a40a3a1f12b7d690aa01f`.
  This is identity evidence, not an import, activation or full live baseline
  exercise.

Fresh local checks passed: Night E acceptance, split create/recovery,
Partner Game Membership (`47/47`), tournament category (`8/8`), Node-RED
modular toolchain (`7/7`), ESLint (`0` errors, `375` warnings), and complete
production plus development builds with loopback-only build configuration.

## Public read-only result

The public PROD manifest is still the clean detached build
`98092303fa7dc50a5e87be1474fde0698d3db06e` from
`2026-08-31T13:41:23.310Z`, not this acceptance branch. In the public browser
Atlas rendered 33 cards and opened a real Detail page. No join, payment or
subscription action was clicked. The Detail `← Назад` action returned to
`/lk_new?authMode=viva` instead of reopening Atlas. Therefore public
Atlas-to-Detail-to-Back acceptance fails on the installed PROD build.

## Unresolved subscription ordering

The annual-shadow synthetic runtime currently records a paid 90/120-minute
discount as one daily usage unit. If 90 minutes is reserved first, the first
60-minute request is then rejected as `DAILY_USAGE_LIMIT_REACHED`. The written
contract says one 60-minute operation is free and separately describes a
repeat 60-minute operation, but does not state whether a paid 90/120-minute
discount may consume that free-hour allowance. This is a material product
meaning and was not changed implicitly.

## Verdict

```ini
LK1_GAME_ATLAS_SOURCE=PASS
LK1_GAME_ATLAS_ACCEPTANCE=FAIL
LK1_SUBSCRIPTION_LOCAL_MATRIX=PASS
LK1_SUBSCRIPTION_ACCEPTANCE=BLOCKED
PARTNER_API_REGRESSION=PASS
PUBLIC_WRITES=0
UNKNOWN_P0=0
LK1_WEEKLY_SCOPE=NOT_CLOSED
```

`UNKNOWN_P0=0` applies to the reviewed acceptance matrix: unknown subscription
responses fail closed. It is not a statement that every external runtime state
has been exercised. Closing the weekly scope requires resolving the daily-quota
ordering and a separately gated publication/deployment followed by exact-build
public viewport and Node-RED post-checks.
