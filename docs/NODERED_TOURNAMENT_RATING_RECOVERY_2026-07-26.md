# Node-RED tournament rating recovery — 2026-07-26

This recovery cohort records the current production implementation of the
`Recalculate ratings & totals` function without committing or importing a raw
Node-RED flow.

No server flow, PM2 process, HTTP route, Mongo node, or database record was
changed.

## Current live evidence

The live flow on `lk-primary-147` was read and hashed twice:

- path: `/root/.node-red/flows.json`;
- current SHA256:
  `6d66ef25bdb2a03a031e8be6471fd9333ff960ed980e14e7011e95c76e006a90`;
- previous preserved recovery snapshot SHA256:
  `0f5cd853450a0bcc60e9d2349463b67c491b6a8653302d9a49f4389354c2adf0`.

Only two nodes differ between those snapshots:

| Node ID | Node | Previous | Current live | Decision |
|---|---|---|---|---|
| `2e70b2e547e77c00` | function `Recalculate ratings & totals` | function SHA `8017f7cd...` | function SHA `b46468ec...` | recover source and tests |
| `ddc581fde0073e34` | mongodb4 `Find tournament history` | `limit` absent | `limit="1"` | hold; excluded from this cohort |

The current live function body is byte-for-byte equal to
`scripts/nodered_games_nodes/fn_tournament_recalculate.js` with SHA256:

`b46468ecffddd481bd4eed456c665b51226e156be34df93a4fa6a01a2747ddc6`

## Recovered contract

Repeated result saves for an already completed tournament keep the original
`finishedAt` and `completedAt`. A later request timestamp must not move the
canonical tournament completion boundary.

The exact live function also contains the current Classic Mexicano layout
guards and keeps Classic Mexicano next-round generation frontend-owned. This
cohort does not split or rewrite the live function because the production node
is the authoritative reviewed unit.

## Guarded candidate builder

`scripts/patch_live_tournament_finished_at_idempotency.mjs` is fail-closed. It
requires the expected node ID, type, name, and function preimage SHA. It also
requires the SHA256 of the complete input flow bytes before parsing, pins the
candidate source SHA, and refuses to write unless all of the following are true:

- the complete flow matches the expected preimage SHA;
- exactly one node changes;
- only that node's `func` field changes;
- node IDs are unchanged;
- all wires are unchanged;
- all HTTP routes are unchanged.

The script resolves real paths and existing inode identity so symlink or
hardlink aliases cannot overwrite the input. It never edits the input flow.
Candidate and report are prepared as mode `0600` temporary files; the report is
published first, and any later publication failure rolls both outputs back.

Example for the preserved recovery snapshot:

```bash
node scripts/patch_live_tournament_finished_at_idempotency.mjs \
  --input /path/to/lk-primary-147-flows-20260726.json \
  --output /private/tmp/tournament-rating-candidate.json \
  --report /private/tmp/tournament-rating-report.json \
  --expected-node-id 2e70b2e547e77c00 \
  --expected-node-type function \
  --expected-node-name "Recalculate ratings & totals" \
  --expected-sha256 8017f7cdf2587d0ea448ca349866a7ab1124115992ff9733746b38696f13ae4a \
  --expected-flow-sha256 0f5cd853450a0bcc60e9d2349463b67c491b6a8653302d9a49f4389354c2adf0
```

Validation against the preserved `0f5c...` snapshot produced:

- `changedNodes=1`;
- input flow SHA256:
  `0f5cd853450a0bcc60e9d2349463b67c491b6a8653302d9a49f4389354c2adf0`;
- changed node: `2e70b2e547e77c00`;
- changed fields: `func`;
- before SHA256: `8017f7cdf2587d0ea448ca349866a7ab1124115992ff9733746b38696f13ae4a`;
- after SHA256: `b46468ecffddd481bd4eed456c665b51226e156be34df93a4fa6a01a2747ddc6`;
- 4,614 node IDs unchanged;
- all wires unchanged;
- 203 HTTP routes unchanged.

Regression coverage also proves that adjacent-node drift fails the whole-flow
preimage guard, input aliases are rejected, and a report write failure leaves
no published candidate. The generated candidate and report are temporary
evidence and are not committed.

## Scope boundary

The `limit="1"` change on `ddc581fde0073e34` remains quarantined. Its query
semantics require a separate operational justification and regression test.
It must not ride along with the tournament completion repair.

No raw/live flow, `node-red/modular/source.flow.json`, full import, generated
candidate, or report belongs in this commit.
