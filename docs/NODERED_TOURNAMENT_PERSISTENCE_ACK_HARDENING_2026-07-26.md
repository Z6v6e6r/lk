# Node-RED tournament persistence acknowledgement hardening — 2026-07-26

## Scope

Behavior/security cohort B builds a combined A+B candidate directly from exact
live flow SHA256
`6d66ef25bdb2a03a031e8be6471fd9333ff960ed980e14e7011e95c76e006a90`.
Live contains neither hardening cohort. The patcher first proves committed A
intermediate SHA256
`5b82c79c229a5f5ae51d7650c4ded4ae6ffe9f860ad051a6f3f5d62cfefe0cd1`,
then applies B. Nothing here has been imported or deployed.

The scope remains `POST /lk/tournaments/americano`. Eight nodes are reachable
by ordinary wires. The Mongo-scoped Catch and its formatter add two support
nodes, producing a ten-node guarded support graph.

## Persistence contract

On valid input the prepare function stashes the exact legacy success payload
before the existing adapter replaces `msg.payload`. It no longer sends success
directly to the HTTP response.

Mongo `updateOne` must return explicit `acknowledged === true` and credible
persistence evidence: a positive matched, modified, or upserted count, or a
non-empty `upsertedId`. Direct, array, nested `result`, and nested `payload`
shapes are accepted. Matched one with modified zero is a valid idempotent save;
an acknowledged all-zero result is not. Same-server legacy evidence in nested
`result.n`, `result.nModified`, and `result.upserted` is accepted only when the
candidate-wide acknowledgement set is explicitly true and non-conflicting.

Only then does new node `745f991e11130b08` restore the legacy payload and
return HTTP 200 with `Cache-Control: no-store`. Malformed, unacknowledged,
zero-evidence, and error-bearing results return exactly:

```json
{
  "error": "TOURNAMENT_PERSISTENCE_FAILED",
  "message": "Не удалось сохранить турнир. Повторите попытку",
  "retryable": true
}
```

Catch `f9a12e4068858809` is scoped only to Mongo `2d3808fb969990d4`.
Formatter `fae579ef6d10446d` removes source, driver, database, and private
context before returning the same HTTP 503 body.

## Guarded topology

The combined candidate retains A and additionally:

- removes the early target-success wire to HTTP response;
- routes Mongo to the acknowledgement node;
- adds the three deterministic, collision-checked nodes above.

Validation errors still go directly to HTTP response. Success goes through
adapter, Mongo, and acknowledgement. Mongo exceptions go through scoped Catch
and formatter. Each execution therefore has one response path. Mongo
`maxTimeMS="0"` remains unchanged.

The combined postimage SHA256 is
`d9f84e4fd6b087752dc810b9fc247e3d532cc6580c19a4a822f2111ddebeca4c`.
It contains 4,617 nodes and 203 HTTP routes, with eight wire-reachable and two
Catch-support nodes. Exactly eight nodes differ from live: five approved
existing nodes and three additions.

## Residual risks

- `maxTimeMS="0"` leaves no node-level Mongo timeout for a stalled operation.
- The POST endpoint still lacks authentication and organizer authorization.
- Caller-provided tournament/audit/rating data is not server-owned or
  truth-validated.
- This guarded candidate is not deployment approval or runtime evidence.

Candidate content remains private and external. Report/stdout contain only
hashes, counts, changed IDs, and changed fields.

Fresh external publication passed: source `6d66ef25...` produced exact combined
candidate `d9f84e4f...`, `changedNodes=8`, totals 4,617/203, wire/support counts
8+2, and directory/file modes `0700`/`0600`. The focused suite passed 13/13.
