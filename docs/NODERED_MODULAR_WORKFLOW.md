# Node-RED live workspace audit

## Scope

This first stabilization cohort provides a read-only workflow for inspecting
the current Node-RED flow from production. It never patches, imports, deploys,
restarts, or exports a release payload.

The only accepted live origin is:

```text
root@lk-primary-147:/root/.node-red/flows.json (SSH port 22)
```

Raw flows, generated modular flows, validation reports, and origin metadata
must stay in a new absolute workspace outside the repository. The repository
ignores `node-red/modular/` defensively, but the commands also reject any
workspace inside the repository.

## One-command read-only audit

Choose exactly one enabled source tab by its exact label or ID:

```bash
npm run nodered:modular:audit-147 -- \
  /private/tmp/lk-nodered-audit-YYYYMMDD \
  --source-tab-label "LK Tournaments"
```

or:

```bash
npm run nodered:modular:audit-147 -- \
  /private/tmp/lk-nodered-audit-YYYYMMDD \
  --source-tab-id "<exact-tab-id>"
```

The workspace must not already exist. The command:

1. copies the exact live flow over SSH without changing the server;
2. records redacted origin metadata next to the source;
3. verifies origin, SHA256, JSON shape, unique IDs, private permissions, and
   pull freshness of at most 30 minutes;
4. extracts only nodes from the selected tab without changing their bodies;
5. excludes the source tab node, all other tabs, and all config nodes;
6. validates node IDs and bodies, wires, links, and HTTP inputs;
7. atomically publishes the local `build/` directory only after validation.

Successful output contains hashes and counts only. The workspace layout is:

```text
<workspace>/                 mode 0700
  input/                     mode 0700
    source.flow.json         mode 0600
    source.flow.meta.json    mode 0600
  build/                     mode 0700
    selected-tab.nodes.json mode 0600
    validation.json          mode 0600
```

Symlink and hardlink aliases are rejected. Existing or partial build outputs
are rejected rather than overwritten.

## Runtime hardening outside flows

MongoDB URI logging guard не является function node и не должен добавляться в
flow candidate. Его focused test и отдельный deploy выполняются командами:

```bash
npm run nodered:runtime-hardening:test
npm run nodered:runtime-hardening:install-147
```

После любого обновления зависимостей `/root/.node-red` установленный
`postinstall` повторно применяет exact guarded patch. Если upstream-модуль
изменил logging preimage, установка fail-closed завершается ошибкой.

## Reviewed-flow deploy lock and soak lease

Every invocation of `deploy_reviewed_flow_147_remote.mjs` is serialized by the
same server-side `flock`. A successful apply also leaves a protected 15-minute
lease in `/root/.node-red/.padlhub-reviewed-flow-deploy.lease.json`.

- another reviewed-flow preflight or apply fails closed while the lease is active;
- the deployment that owns the lease may still execute its exact guarded rollback;
- a successful rollback releases its own lease;
- rollback after lease expiry reacquires protection before changing the live flow;
- a failed apply releases the lease only after automatic rollback is confirmed;
- any incomplete rollback keeps the lease, preventing another restart over an
  ambiguous runtime state;
- an expired lease is removed only while the global OS lock is held.

This lease is the minimum production soak window. Do not delete or edit it to
force an unrelated rollout; wait for expiry or roll back the owning deployment.

Exact-graph contracts may authorize a `wires`-only change on an existing
`http in` node. The route ID and every other route field (including tab,
method, URL, name, and configuration) must remain structurally identical,
while the exact changed-field list and before/after node hashes pin the reviewed
rewire. Route additions and removals remain forbidden. Function-only contracts
continue to require the complete HTTP input set to be unchanged.

## Individual gates

```bash
npm run nodered:modular:pull-147 -- /absolute/new/external/workspace
npm run nodered:modular:verify -- --workspace /absolute/external/workspace
npm run nodered:modular:build -- \
  --workspace /absolute/external/workspace \
  --source-tab-label "LK Tournaments"
npm run nodered:modular:validate -- \
  --workspace /absolute/external/workspace \
  --source-tab-label "LK Tournaments"
```

## Deliberately not restored

The old wide `sync-games-source`, `prepare-147`, and `exports` commands remain
quarantined. Their patch chains and generated imports are not part of this
cohort and must not be run against a fresh live pull. A later recovery cohort
may add node-specific candidate construction after every patcher has relative
paths, exact preimage guards, focused tests, and a separate explicit deploy
approval.

## Guarded chat source check

The chat recovery cohort consumes the same freshly verified external workspace
and checks only 11 existing function nodes. It does not reconstruct chat routes
or produce an import:

```bash
node scripts/patch_nodered_chat_flow.mjs \
  --workspace /absolute/external/live-workspace \
  --output /absolute/external/new-chat-candidate/candidate.json \
  --report /absolute/external/new-chat-candidate/report.json
```

See `docs/NODERED_CHAT_RECOVERY_2026-07-26.md` for the fixed preimage and hold
boundaries.

## Guarded games-list identity check

```bash
node scripts/patch_live_games_list_identity.mjs \
  --workspace /absolute/external/live-workspace \
  --output /absolute/external/new-games-list-candidate/candidate.json \
  --report /absolute/external/new-games-list-candidate/report.json
```

This synchronizes only the active query and normalizer. It does not run the
legacy games constructor or touch similarly named orphan functions. See
`docs/NODERED_GAMES_LIST_IDENTITY_RECOVERY_2026-07-26.md`.

## Guarded direct game lookup check

```bash
node scripts/patch_live_games_direct_lookup.mjs \
  --workspace /absolute/external/live-workspace \
  --output /absolute/external/new-direct-lookup/candidate.json \
  --report /absolute/external/new-direct-lookup/report.json
```

This synchronizes only the active direct-lookup query. It does not add routes
or alter the Mongo, response, HTTP response, or diagnostic nodes. See
`docs/NODERED_GAMES_DIRECT_LOOKUP_RECOVERY_2026-07-26.md`.

## Guarded games create/upsert check

```bash
node scripts/patch_live_games_create_upsert.mjs \
  --workspace /absolute/external/live-workspace \
  --output /absolute/external/new-create-upsert/candidate.json \
  --report /absolute/external/new-create-upsert/report.json
```

This synchronizes only `Prepare game upsert` after verifying the exact six POST
routes and their full 21-node reachable graph. It does not import or deploy the
candidate. See `docs/NODERED_GAMES_CREATE_UPSERT_RECOVERY_2026-07-26.md`.

## Guarded tournament prepare check

```bash
node scripts/patch_live_tournament_prepare.mjs \
  --workspace /absolute/external/live-workspace \
  --output /absolute/external/new-tournament-prepare/candidate.json \
  --report /absolute/external/new-tournament-prepare/report.json
```

This verifies exact live, proves the committed tournament-ID/debug
intermediate, and builds the combined persistence-acknowledgement candidate.
It does not import or deploy the candidate. See
`docs/NODERED_TOURNAMENT_PREPARE_RECOVERY_2026-07-26.md` and
`docs/NODERED_TOURNAMENT_PERSISTENCE_ACK_HARDENING_2026-07-26.md`.

## Guarded Viva User-Agent candidate

The cross-tab Viva transport header is built from the same fresh verified live
workspace without editing function bodies or topology:

```bash
npm run nodered:viva-user-agent:patch -- \
  --workspace /absolute/external/live-workspace \
  --output /absolute/external/new-viva-user-agent/candidate.json \
  --report /absolute/external/new-viva-user-agent/report.json
```

The patcher adds only the fixed `User-Agent: PadlHub-LK/1.0` configured header
to bounded, URL-evidenced Viva HTTP Request nodes. It produces a candidate only;
see `docs/VIVA_USER_AGENT.md` for scope, review and post-deploy evidence gates.

## Guarded split pricing contract candidate

The split pricing cohort replaces only the function bodies of the existing
`Prepare split game payment`, `Prepare split join payment`, and
`Route Viva split payment` nodes after verifying the exact live flow and all
three function preimages:

```bash
npm run nodered:split-create-contract:patch -- \
  --workspace /absolute/external/live-workspace \
  --output /absolute/external/new-split-create-candidate/candidate.json \
  --report /absolute/external/new-split-create-candidate/report.json
```

The builder preserves node IDs, wires, links, and HTTP routes and never imports
or deploys its output. It fails closed after any live drift. The separately
approved provider-mutation and cleanup procedure is documented in
`docs/MANAGED_SUBSCRIPTION_SYNTHETIC_CREATE_CANCEL_HAR.md`.

## Guarded legacy split pricing recovery candidate

Games created before durable draft persistence can retain a zero-amount paid
organizer booking while losing `selectedPaymentMode` and the pricing-policy
snapshot. The focused recovery candidate replaces only `Prepare split join
payment` and `Route Viva split payment` after verifying their exact live
preimages:

```bash
npm run nodered:split-pricing-recovery:patch -- \
  --workspace /absolute/external/live-workspace \
  --output /absolute/external/new-split-pricing-recovery/candidate.json \
  --import /absolute/external/new-split-pricing-recovery/nodes.import.json \
  --report /absolute/external/new-split-pricing-recovery/report.json
```

Recovery is fail-closed: the exact stored organizer booking must be an active,
non-cancelled Viva `SUBSCRIPTION` booking for the same exercise before the
server requests the campaign for the stored date, station, and room. The
builder does not import, deploy, restart Node-RED, or mutate game/provider data.
