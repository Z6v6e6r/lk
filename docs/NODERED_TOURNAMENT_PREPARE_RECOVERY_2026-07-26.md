# Node-RED tournament prepare recovery — 2026-07-26

## Scope and provenance

This cohort records the exact active `Prepare tournament doc` function from a
freshly verified live flow. It does not import a flow, deploy, restart a
service, or mutate runtime data.

- whole flow SHA256:
  `6d66ef25bdb2a03a031e8be6471fd9333ff960ed980e14e7011e95c76e006a90`;
- flow totals: 4,614 nodes and 203 HTTP inputs;
- active tab `f9575c8726e29196`, `LK Tournaments`;
- route `8cab773c2cea526d`, `POST /lk/tournaments/americano`, full-node
  SHA256 `0ee89863d8dada754a767e5ba92595620748095861a18d54637d82a97d71a4d5`;
- target `4f0f1ce8189a9e8c`, full-node SHA256
  `79575aa6149032f5a8dbb94408a3e3f9121a12965ce606c30bd9633eaea03ba3`;
- target function SHA256:
  `0b9a8c577a4fb0afb6f05888c7367b5806d2917e0ffd9d39edea191b8ce27688`.

The guarded route graph has exactly seven reachable nodes. The route sends the
raw request in parallel to active debug node `662c4669cc17d82a` and the target.
The transformed target output fans out to Mongo argument function
`f476ee4e8d98c43b`, HTTP response `c76ac8d5319455b4`, and active debug
`bf7e8b4a95f35228`; the argument function terminates at Mongo update node
`2d3808fb969990d4`.

Every graph node has an exact full-node hash and every function has an exact
function-body hash. Only `4f0f1ce8189a9e8c.func` may change in a candidate.
All IDs, wires, links, 203 HTTP routes, and downstream nodes remain invariant.

## Characterized behavior

The function prepares an upsert keyed by `body.tournamentId`. It normalizes
client-provided tournament-start rating changes: entries without participant
or client identity, without a finite resulting rating, or without an actual
rating change are removed; accepted fields are reduced to the persisted event
shape. The remaining tournament document, rounds, participants, parameters,
standings, totals, and logs are prepared for Mongo `$set`, with `createdAt`
limited to `$setOnInsert`.

This is live-equivalence evidence, not approval that the API contract or its
trust boundaries are correct.

## Preserved risks

- A missing `tournamentId` is accepted and produces an undefined upsert key.
- The raw caller payload is sent to an active debug node.
- The transformed Mongo update payload is also sent to an active debug node.
- HTTP response is emitted in parallel with the Mongo branch and therefore
  precedes confirmation that persistence succeeded.
- `startRatingChanges` is caller-provided. The function sanitizes its shape but
  does not establish caller authorization or the truth of rating values.

Normalization intentionally preserves these behaviors. Debug exposure,
required-ID validation, persistence acknowledgement, and rating-change trust
require separate behavior/security cohorts.

## Guarded publication

```bash
node scripts/patch_live_tournament_prepare.mjs \
  --workspace /absolute/external/live-workspace \
  --output /absolute/external/new-tournament-prepare/candidate.json \
  --report /absolute/external/new-tournament-prepare/report.json
```

The verified input is re-hashed immediately before use. Publication requires
canonical external paths, rejects aliases, hardlinks, stale input and existing
or partial targets, and atomically creates private candidate/report files.
Candidate content remains external; stdout and report contain only hashes,
counts, changed IDs, and changed fields.

The fresh publication gate passed with source and candidate SHA256 both
`6d66ef25bdb2a03a031e8be6471fd9333ff960ed980e14e7011e95c76e006a90`.
The candidate was byte-identical, `changedNodes=0`, totals remained
4,614/203/7, and external directory/file modes were `0700`/`0600`. The focused
behavior, graph, drift, TOCTOU, redaction, and path-isolation suite passed 9/9.
