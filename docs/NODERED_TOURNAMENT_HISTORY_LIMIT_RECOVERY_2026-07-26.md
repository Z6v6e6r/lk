# Node-RED tournament history limit recovery — 2026-07-26

This cohort recovers the confirmed live `limit="1"` configuration for the
MongoDB node serving tournament history. No raw flow, generated candidate,
server flow, PM2 process, route, or database record is committed or changed.

## Provenance

The input is the output of the committed tournament-rating recovery step:

- post-rating flow SHA256:
  `6b47f3d9a46574be592348972479aa86703ec4ac9086001ef187651a3311db83`;
- current live semantic reference SHA256:
  `6d66ef25bdb2a03a031e8be6471fd9333ff960ed980e14e7011e95c76e006a90`;
- target node: `ddc581fde0073e34`, `mongodb4`,
  `Find tournament history`;
- tab: `f9575c8726e29196`;
- target preimage node SHA256:
  `c2fe2964effcf33bfc9e5a3d5a1e29066c758fbf28950f1a28000f2475022d96`;
- target candidate node SHA256:
  `4b13538168725e97f63415ffeb93b71b7c27e14c10dceffd12fdf5ac0be0113c`.

The only candidate change is an absent `limit` field becoming the string
`"1"`.

## Guarded contract

`scripts/patch_live_tournament_history_limit.mjs` requires the complete raw
input flow SHA before parsing. It validates:

- target ID, type, name, tab, preimage SHA, and candidate SHA;
- `mode=collection`, `collection=tournaments`, `operation=find`,
  `output=toArray`, and `maxTimeMS="5000"`;
- target wires to `a57565a6ddbb532f`;
- `GET /lk/tournaments/americano/history` route
  `ccd7d6b82f8b90c1` and its exact wires;
- query node `11b8491cc624fb42` and its exact JSONata
  `tournamentId` rule;
- debug node `0299bf5612ade8d5` remains inactive.

The patcher refuses a preexisting `limit`, target/route/query/debug drift,
adjacent-node drift, existing destinations, or path aliases. Candidate and
report use mode `0600`, report-first publication, and rollback on failure.

## Data precheck

The live `tournaments` collection currently has 377 non-empty `tournamentId`
values, zero duplicate groups, and at most one document per ID. The existing
`tournamentId_1` index is not unique, so a future duplicate would make an
unsorted `limit=1` lookup non-deterministic. Index hardening is a separate
data-migration decision and is not part of this exact-live recovery cohort.

Example:

```bash
node scripts/patch_live_tournament_history_limit.mjs \
  --input /path/to/post-rating-flow.json \
  --output /private/tmp/tournament-history-candidate.json \
  --report /private/tmp/tournament-history-report.json \
  --expected-flow-sha256 6b47f3d9a46574be592348972479aa86703ec4ac9086001ef187651a3311db83
```

## Validation

Focused tests passed 13/13. Full reconstruction from the post-rating preimage
confirmed:

- `changedNodes=1`;
- changed node `ddc581fde0073e34`;
- changed fields: `limit`;
- 4,614 IDs unchanged;
- all wires unchanged;
- 203 HTTP routes unchanged;
- candidate and report mode `0600`;
- normalized candidate is semantically deep-equal to the current live flow.

Raw output SHA is not used as the final gate because the patcher emits
normalized JSON. Semantic deep equality against the read-only live reference is
the relevant final proof.
