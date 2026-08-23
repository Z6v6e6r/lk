# Games membership generation persistence — 2026-08-23

## Scope

Local non-split joins now carry an opaque `membershipId`. The active generic
games PATCH function must preserve that field in `participants` and `waitlist`
so the leave generation fence can remove only the membership generation that
the client actually joined.

This stage prepares a candidate only. It does not import the flow, restart
Node-RED, publish frontend bundles, create a booking, or call Viva/payment
mutations.

## Fresh live preimage

The source was pulled read-only from `lk-primary-147` at
`2026-08-23T14:47:37.417Z`:

- flow SHA256: `fc9daeecb23a15524f027fde746637e0f4fc8977fffa191073ee03485243ac25`;
- node count / HTTP input count: `4762 / 215`;
- target node: `Prepare game patch` (`e0d7883bc1a9fa8c`);
- target function SHA256: `323b78bf0acdee06ac86f838151a271fe7132a0f60a72e92a62a8e2a1fb8003e`;
- candidate function SHA256: `4fb7d6ca9961e854cefb22f0752f9c1f921e1b6cbacfea3ce16e8b8681538931`.

The live target function is byte-identical to
`25cc3c4^:scripts/nodered_games_nodes/fn_patch.js`. The candidate changes only
player normalization: it copies a non-empty `membershipId`/`membership_id` to
the normalized participant. The two PATCH inputs, target outputs, and complete
19-node reachable graph remain unchanged and pinned by exact hashes.

## Guarded construction

Use a newly pulled private workspace. The constructor fails closed on any
whole-flow, node-count, route-count, route, target, reachable-node, wiring, or
tracked-source drift. A successful candidate may change only the target
function's `func` field.

```bash
npm run nodered:modular:pull-147 -- /private/tmp/lk-games-membership-live
node scripts/patch_live_games_patch.mjs \
  --workspace /private/tmp/lk-games-membership-live \
  --output /private/tmp/lk-games-membership-publication/candidate.json \
  --report /private/tmp/lk-games-membership-publication/report.json
npm run test:games-patch-recovery
```

Any fresh-live mismatch requires a new read-only review. It must not be
resolved by weakening the contract or retrying an ambiguous apply.
