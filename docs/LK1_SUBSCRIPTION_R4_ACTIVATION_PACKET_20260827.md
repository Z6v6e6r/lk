# LK1 subscription enforcement R4 activation packet — 2026-08-27

Status: source-controlled offline packet preparation only. This document, the
manifest and the packet builder do not authorize upload, install, Node-RED import,
restart, Deploy, database migration, provider call, booking, payment, feature-flag
change, secret provisioning or production rollback.

## Frozen identities

- fresh `origin/main`: `0e2b500b8608b28363bf134e1d6e6489ae0b9cd5`;
- main tree: `8dd82b9c87fe2e3cbaa128b977e18bbc95d877fe`;
- read-only live pull: `2026-08-27T13:51:45.289Z` and a confirming later pull;
- live flow SHA-256: `9e9698ea3e7cfa0bd2b42a95a7eed20a82436cb06f40ecd80c13896a1960b263`;
- reviewed candidate SHA-256: `703c065429bcee016e86ac7559c3b834754bab61bcb5c70f4da55b1cc32064ca` (supersedes the pre-rollout-gate `928a7c49…` candidate);
- inventory: `4762 -> 4812` nodes, `215` unchanged HTTP inputs,
  `54` exact existing-node changes and `50` exact additions;
- broken wires/links: `0/0`;
- production custody: `UNBOUND`;
- live mutation authorized: `false`.

The preceding reviewed candidate used live source `14b5aff6…` and candidate
`d88ea0af…`. The current live flow advanced while keeping all five subscription
target preimages and all thirteen tracked postimages byte-identical. The refreshed
offline builder composes the same reviewed business logic on the new exact live preimage and
preserves later unrelated runtime functions. Any further whole-flow drift is STOP.

## Offline packet

The source-controlled allowlist is
`scripts/lk1_subscription_enforcement_activation_manifest.mjs`. It fixes every
changed node and allowed field, every added node ID, source/candidate SHA, node counts
and HTTP-route count. The generated exact-graph contract additionally pins complete
per-node source/candidate digests and rejects removed nodes or any route identity or
configuration change.

From a clean checkpoint commit and a fresh private live workspace:

```bash
npm run nodered:lk1-subscription-enforcement:packet -- \
  --workspace /absolute/private/fresh-live-workspace \
  --out /absolute/private/new-activation-packet
```

The output directory is outside Git, mode `0700`, and contains three `0600` files:

- `candidate.flow.json`;
- `reviewed-flow.contract.json`;
- `activation-plan.json`.

The command has no SSH, SCP, HTTP, provider or database action. It refuses a dirty
worktree, a detached/non-commit source, an existing output path, a path inside the
repository, stale origin metadata, whole-flow drift, candidate drift, allowlist drift
or contract inventory drift.

## Current blockers before any Deploy

1. The production migration runner and immutable release source identity were refreshed
   in a later isolated R4 source task to `9e9698ea… -> 928a7c49…`; this closes only the
   source-identity mismatch and does not authorize release installation or execution.
2. `scripts/legacy_game_command_production_trust_anchor.json` remains `UNBOUND`.
3. Runtime provisioning was not found for
   `subscriptions_runtime_api_base_url`,
   `subscriptions_runtime_context_integration_token` or
   `subscriptions_activation_integration_token` through process environment,
   `settings.js` or persistent Node-RED context. Values were not read or logged.
   A later source-only entitlement lifecycle also requires the distinct
   `subscriptions_entitlement_integration_token`; it is likewise not provisioned
   or authorized by this packet.
4. There is no approved evidence that the exact custom-node package, MongoDB driver,
   database revision/index prerequisites, backup/restore rehearsal and writer
   quiescence gates are ready on the target.
5. The repository staged-delivery workflow still requires separate user approvals for
   integration to local `main`, push of `main`, and production Deploy/postcheck.

Consequently this packet is not executable release authority and must report
`productionCustodyState=UNBOUND`, `liveMutationAuthorized=false` and
`deploymentPerformed=false`.

## Future guarded order

After separate approval and closure of every blocker:

1. fresh-fetch exact pushed `main` and exact-head CI;
2. fresh-pull live flow and require the same source SHA;
3. independently validate the exact-graph packet and required runtime package/config;
4. stop writers and prove quiescence under the migration runbook;
5. create and verify protected database and flow backups;
6. complete the separately approved migration apply/postcheck;
7. recheck live-flow drift and the global reviewed-flow lock/lease;
8. perform one guarded full-flow publication and restart;
9. prove active-flow SHA, PM2 health, logs, public endpoint health and the subscription
   smoke matrix before resuming writers;
10. retain the exact flow/contract backup timestamp through the soak window.

No step in that order is authorized by preparing this packet.

## Rollback readiness

The packet binds the exact preimage and candidate, but production rollback is not yet
ready. A future deploy must first create fsynced, root-owned `0600` flow and contract
backups through the reviewed-flow helper. Rollback may use only the backup pair whose
deployment ID is `lk1-subscription-enforcement` and whose candidate digest is
`928a7c49…`; it must validate the active candidate, matching lease and backup bytes,
restore atomically, restart only the existing `node-red` PM2 process, and repeat public
and subscription postchecks. Blind restoration, manual `flows.json` editing and reuse
of a backup from another deployment ID are forbidden.
