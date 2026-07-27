# Node-RED chat source normalization — 2026-07-26

## Scope

This cohort replaces the legacy chat flow constructor with a fail-closed
synchronizer for 11 existing function nodes in the active `LK Games` tab.
It does not create routes or nodes and has no import, deploy, restart, or live
mutation operation.

The fixed preimage contract is:

- whole flow SHA256:
  `6d66ef25bdb2a03a031e8be6471fd9333ff960ed980e14e7011e95c76e006a90`;
- tab ID `4b91e2a2413688db`, exact label `LK Games`;
- 4 existing chat HTTP inputs;
- 11 function node IDs mapped to tracked files in
  `scripts/nodered_chat_nodes/`;
- 4,614 node IDs and 203 HTTP inputs.

Each target guard includes its ID, type, name, tab, output count, wires, and
function preimage SHA256. The whole-flow IDs, wires, links, and HTTP routes are
hashed before and after synchronization. Only a target node's `func` field may
change.

## Current result

A fresh read-only pull from `lk-primary-147` at
`2026-07-26T15:04:19.818Z` produced the fixed SHA and was checked against the
tracked sources:

- mapped sources matching live preimages: 11/11;
- changed nodes: 0;
- node IDs/wires/links/HTTP routes: unchanged;
- semantic candidate: equal to the source;
- zero-change candidate bytes: copied unchanged from the verified source.
- focused recovery suite: 8/8 passed.

The unapproved quarantine variants of `fn_chat_get_build_query.js`,
`fn_chat_post_build_insert.js`, and `fn_chat_read_insert.js` have different
SHA256 values and remain on hold.

## Guarded command

The input workspace must first pass the fresh live-origin verifier. Output and
report must be explicit paths in the same new external publication directory:

```bash
node scripts/patch_nodered_chat_flow.mjs \
  --workspace /absolute/external/live-workspace \
  --output /absolute/external/new-chat-candidate/candidate.json \
  --report /absolute/external/new-chat-candidate/report.json
```

The new publication directory is mode `0700`; candidate and redacted report
are mode `0600`. Existing, partial, repository, symlink, hardlink, and input
aliases are rejected. The command only builds evidence and never deploys it.
