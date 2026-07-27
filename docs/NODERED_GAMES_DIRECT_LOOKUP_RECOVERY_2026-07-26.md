# Node-RED games direct lookup recovery — 2026-07-26

## Scope

This one-node cohort records the exact active direct game lookup query from the
verified live flow. It adds no routes, Viva gate, import, deploy, restart, or
runtime mutation.

Fixed provenance:

- whole flow SHA256:
  `6d66ef25bdb2a03a031e8be6471fd9333ff960ed980e14e7011e95c76e006a90`;
- active tab `4b91e2a2413688db`, `LK Games`;
- query node `b6bc67d99744e060`, function SHA256
  `eb771a2cf6f4f8e1fa71cca0aae253462fb47a397c4b91bca6f5f0e0006a69f6`;
- two confirmed GET routes:
  `/lk/games/:gameId` and `/lk/games/records/:gameId`;
- response function `d44d0fcf9250927f` remains unchanged at SHA256
  `dd2be64ed8e2ff42a951a799ee72b18e13e98486d3b06a24d55a872023979b68`;
- flow totals: 4,614 nodes and 203 HTTP inputs.

## Reachable behavior

A non-empty route `gameId` builds:

```text
{ id: gameId, archived: { $ne: true } }
```

An empty or invalid lookup returns HTTP 400 through the second function output.

The source also contains `paymentRef` and `bookingIds` query branches. Tests
characterize those branches as source behavior only. Both confirmed routes
require `:gameId`, so this cohort does not claim that either branch is
reachable as a production API contract.

## Guarded result

Static validation against the fixed live preimage produces `changedNodes=0`
and preserves 4,614 IDs, all wires/links, and 203 HTTP routes. The fresh
`verifyWorkspace` publication gate passed at `2026-07-26T17:11:02Z`: source
and candidate SHA256 both remained
`6d66ef25bdb2a03a031e8be6471fd9333ff960ed980e14e7011e95c76e006a90`,
the candidate was byte-identical, `changedNodes=0`, node/route totals remained
4,614/203, and the external directory/files used modes `0700`/`0600`.

The guarded command for reproducing that evidence is:

```bash
node scripts/patch_live_games_direct_lookup.mjs \
  --workspace /absolute/external/live-workspace \
  --output /absolute/external/new-direct-lookup/candidate.json \
  --report /absolute/external/new-direct-lookup/report.json
```

Candidate flow content is sensitive and remains external. Report/stdout contain
only hashes, counts, changed IDs, and changed fields.
