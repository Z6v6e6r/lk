# Node-RED tournament prepare recovery — 2026-07-26

## Scope and provenance

Phase 12 recorded the exact active `Prepare tournament doc` function from a
freshly verified live flow. A separate behavior/security cohort now builds a
guarded hardening candidate from that exact preimage. The candidate has not
been imported or deployed; no service or runtime data was changed.

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
- guarded hardening function SHA256:
  `3dc83ec10d4faa69e901795e95982f0ebe94098f6b26fa6b92b2ce7560a22225`.

The live route graph has exactly seven reachable nodes. The route sends the
raw request in parallel to active debug node `662c4669cc17d82a` and the target.
The live target output fans out to Mongo argument function
`f476ee4e8d98c43b`, HTTP response `c76ac8d5319455b4`, and active debug
`bf7e8b4a95f35228`; the argument function terminates at Mongo update node
`2d3808fb969990d4`.

Every graph node has an exact full-node hash and every function has an exact
function-body hash. The hardening candidate may change only:

- target `4f0f1ce8189a9e8c`: `func`, `outputs`, and `wires`;
- debug nodes `662c4669cc17d82a` and `bf7e8b4a95f35228`: `active`;
- HTTP response `c76ac8d5319455b4`: `statusCode`.

All IDs, routes, links, other wires, fields, and nodes remain fail-closed.

## Characterized behavior

The hardening function accepts only a trimmed string `tournamentId` with length
1–128 and format `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`. Missing, null, or blank
IDs return HTTP 400 with `TOURNAMENT_ID_REQUIRED`; wrong type, format, or length
returns HTTP 400 with `TOURNAMENT_ID_INVALID`. Error output is wired only to
the existing HTTP response, so validation failures cannot enter the Mongo
branch. Success uses the normalized ID consistently in the query, document,
rating-event source and generated event ID, and sets status 200.

The function also normalizes
client-provided tournament-start rating changes: entries without participant
or client identity, without a finite resulting rating, or without an actual
rating change are removed; accepted fields are reduced to the persisted event
shape. The remaining tournament document, rounds, participants, parameters,
standings, totals, and logs are prepared for Mongo `$set`, with `createdAt`
limited to `$setOnInsert`.

The target now has two outputs. Success retains the existing Mongo adapter,
response, and transformed-diagnostic fanout on output 0; errors use output 1
to the HTTP response only. Both raw and transformed debug nodes are disabled
in the candidate, and the response node no longer overrides dynamic 200/400
status codes.

## Residual risks

- HTTP response is emitted in parallel with the Mongo branch and therefore
  precedes confirmation that persistence succeeded.
- The POST endpoint remains unauthenticated and unauthorized. The current
  frontend call still omits `auth: true`, and the Node-RED route does not verify
  a token or organizer permission. A caller that knows a valid tournament ID
  can still overwrite caller-controlled tournament fields including organizer,
  participants, rounds, params, player logs, totals, standings, summary,
  tenant key, insert-time `createdAt`, and `startRatingChanges`.
- Rating changes are only shape-sanitized; their before/after values and actor
  are not established from trusted server state.

Persistence acknowledgement and full endpoint authentication, authorization,
and server-owned audit/rating data remain separate cohorts. Building this
candidate is not approval to deploy it and must not be treated as complete
ingress security.

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

The fresh hardening publication gate used live source SHA256
`6d66ef25bdb2a03a031e8be6471fd9333ff960ed980e14e7011e95c76e006a90`
and produced external candidate SHA256
`5b82c79c229a5f5ae51d7650c4ded4ae6ffe9f860ad051a6f3f5d62cfefe0cd1`.
Exactly four nodes changed with the approved fields, totals remained
4,614/203/7, both debug nodes were inactive, and directory/file modes were
`0700`/`0600`. The focused validation, graph, drift, TOCTOU, redaction, and
path-isolation suite passed 10/10.
