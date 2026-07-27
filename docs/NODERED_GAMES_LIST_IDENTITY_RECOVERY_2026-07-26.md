# Node-RED games list identity recovery — 2026-07-26

## Scope

This cohort records the exact active games-list query and normalizer from the
fresh verified live flow. It changes no production runtime and does not use the
legacy broad games constructor.

Fixed provenance:

- fresh read-only pull: `2026-07-26T16:08:58.724Z`;
- whole flow SHA256:
  `6d66ef25bdb2a03a031e8be6471fd9333ff960ed980e14e7011e95c76e006a90`;
- active tab: `4b91e2a2413688db`, `LK Games`;
- query node `25a807ca124cd83e`, function SHA256
  `2535de7d1219cc56fe4eb752c5b4df14f9f4dc1f8f2443a0b29422fb3af990ee`;
- normalizer node `0485dea01865b2dd`, function SHA256
  `aabbe49ef2b7547df800ae95ac0b59579279e3841c635fc8b66356dc52218886`;
- graph: two existing GET routes -> query -> Mongo -> normalizer;
- flow totals: 4,614 nodes and 203 HTTP inputs.

The similarly named orphan functions `fcb8b28e2ecb4e7c` and
`f4cc88af12330122` are guarded as non-targets. Of the 23 audited legacy
dependencies, the prior chat cohort normalized 11 and this cohort normalized
2; 8 legacy-dependency mismatches remain. The two orphan games-list nodes are
tracked separately from those 8. The dirty normalizer variant with HOLD SHA256
`e99d0311090ac280d6ff2c6d8d27a0034d63f6acb6bcbcd3f6a9fcc3d990287e`
remains quarantined. That HOLD SHA is intentionally different from the live
normalizer SHA above.

The broader recovery classification is also separate from the 23-dependency
count: 7 subscription functions and 3 split-payment functions remain
quarantined as their own future cohorts.

## Identity contract

The recovered live logic accepts phone-only, clientId-only, or both identities,
stores `_lkClientId`, and checks organizer, participant, waitlist, and active
split-payment identity projections. A clientId-only active participant is
retained; phone and client ID are alternative current-identity matches; and
persisted participant/waitlist phone and ID projections are retained. Inactive
nested roster entries, inactive split-payment identities, and stale
`allRelatedPhones` / `allRelatedClientIds` aggregates alone do not survive the
normalizer's current-identity post-filter.

## Guarded candidate result

Fresh verified publication produced a byte-identical candidate:

- source/candidate SHA256:
  `6d66ef25bdb2a03a031e8be6471fd9333ff960ed980e14e7011e95c76e006a90`;
- changed nodes: 0;
- IDs, wires, links, and 203 HTTP inputs unchanged;
- publication directory mode `0700`, files mode `0600`.

```bash
node scripts/patch_live_games_list_identity.mjs \
  --workspace /absolute/external/live-workspace \
  --output /absolute/external/new-games-list-candidate/candidate.json \
  --report /absolute/external/new-games-list-candidate/report.json
```

The candidate is a full sensitive Node-RED flow and must remain only in the
private external publication directory. Only the report and stdout are
redacted. These artifacts are evidence only and do not authorize import or
deployment.
