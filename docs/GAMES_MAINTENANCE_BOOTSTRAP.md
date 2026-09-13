# Organizer handoff: first maintenance bootstrap

Owner: LK Games. Purpose: unblock safe preparation of the already merged organizer-handoff feature (#59). This bootstrap is a CLOSED HOLD, not a successful drain or permission to restart. No production installation has been performed.

## Why this first step is different

The installed Node-RED version on147 was read as4.0.9. Its HTTP request close handler does not drain active provider operations. Installing a new tracker with a PM2/full-flow restart therefore cannot prove completion of requests that preceded the tracker.

Node-RED4.0.9 `nodes` deployment preserves rewired node instances. The physical loopback fixture confirms an already pending HTTP request survives a wire-only deploy, reaches the newly added collector, and a new request is rejected503. The original HTTP node object remains identical; stale Admin revision is rejected409. This fixture does not prove production Mongo/provider completion.

## Implemented scope

- `build_games_maintenance_bootstrap.mjs` pins the reviewed source `e672b79…9f223`; rejects missing/colliding nodes and any existing-node change other than wires.
- Five admission points close: self leave, staff leave, explicit cleanup, cleanup scheduler and leave retry scheduler.
- Both cleanup/leave provider HTTP nodes retain their configuration and instance. Their inputs are redirected to a HOLD collector; their outputs are redirected to a response collector. Existing provider requests can finish, but their next provider call cannot start.
- Captures go to `lk_game_maintenance_events` through the existing Mongo client, with correlation IDs and phase only. No headers, credentials, arbitrary provider bodies, names or phone numbers are persisted.
- Captures always require reconciliation. Truncated/invalid IDs are explicitly marked incomplete. Each event has a distinct key. Pending persistence is counted in flow context; failed acknowledgement or scoped catch sets a sticky unhealthy flag. A restart loses that volatile observation, invalidating its use: an empty collection is NEVER proof of no pending or unknown operations.
- `hot_bootstrap.mjs` provides an operator-transport adapter: check runtime version, compare exact Admin graph, use current v2 revision, make exactly one POST with deployment type `nodes`, then independently read back graph/revision. No file replacement, PM2 restart, automatic retry, rollback or reopening is included. An ambiguous POST requires readback/reconciliation.

## Reproduce locally

```sh
node --test scripts/tests/gamesMaintenanceBootstrap.test.mjs scripts/tests/gamesMaintenanceAdmin.test.mjs
HANDOFF_SOURCE=/private/fresh/input/source.flow.json node --test scripts/tests/gamesMaintenanceAdmin.test.mjs
NODERED_RUNTIME_ROOT=/private/disposable-node-red-4.0.9 node --test scripts/tests/gamesMaintenanceHotDeploy.test.mjs
node scripts/build_games_maintenance_bootstrap.mjs /private/fresh/input/source.flow.json ACTUAL_ADMIN_V2_REV /private/new-packet
```

The last command creates private `request.json` and `contract.json`; it performs no network operations. A real packet needs fresh source origin verification and the actual authenticated Admin revision. Raw flow and packet must never enter Git. The physical fixture uses only loopback, synthetic flows and a disposable userDir; no production environment is mounted. Node-RED is installed outside this repository for the fixture; no project dependency is added.

## Live gates still required

1. Pin current source, installed runtime semantics, Admin auth/revision, candidate and operator transport under the deployment lock. Preserve current PID, source and recovery data. Never substitute a `full`/`flows` deploy or PM2 restart.
2. Apply only the reviewed wire-only HOLD. Confirm node instances/process are retained and full graph readback matches. HOLD affects cancellation availability; it does not stop unrelated Node-RED services.
3. Establish effective timeouts and all outstanding provider/Mongo work, capture late completions and examine durable leave states plus held events. Timeouts, missing acknowledgements and incomplete evidence require exact provider/Mongo reconciliation. Elapsed time alone is insufficient. Old non-provider local-apply branches may still complete; HOLD is not a global database barrier.
4. Only after observed reconciliation can the final organizer candidate be composed from the NEW maintenance source. The old #59 source pin intentionally rejects this changed graph. Preserve HOLD through activation checks; explicitly decide how held operations are resumed. Never delete their evidence or reopen automatically.

The adapter deliberately returns `readyToRestart=false` and `readyToActivateOrganizer=false`. A production collector/reconciliation run and final candidate composition are remaining release work; this source change does not fabricate that evidence or claim that #59 is deployed.
