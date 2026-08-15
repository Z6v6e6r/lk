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
