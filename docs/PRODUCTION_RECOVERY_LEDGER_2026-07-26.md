# Production recovery ledger — 2026-07-26

This is a read-only inventory of the deployed LK frontend and Node-RED state.
No server files, services, data, or public manifests were changed.

Phase 3 recovered the shared tournament category gate and the production-proven
`direction.id=5278` classification as a focused source/test change. The current
Node-RED drift was also classified by live node ID and function-body hash in
`docs/NODERED_RECOVERY_CLASSIFICATION_2026-07-26.md`.

Phase 4 recovered the exact Classic Mexicano algorithm/test postimages and
reintroduced the atomic score-plus-next-layout frontend contract. Evidence and
the offline-queue scope boundary are recorded in
`docs/CLASSIC_MEXICANO_RECOVERY_2026-07-26.md`.

Phase 5 recovered the exact current live `Recalculate ratings & totals`
function and its tournament completion idempotency contract. The guarded
candidate builder proves that only function node `2e70b2e547e77c00` changes
while IDs, wires, and HTTP routes remain invariant. The adjacent Mongo history
`limit="1"` drift remains quarantined. Evidence is recorded in
`docs/NODERED_TOURNAMENT_RATING_RECOVERY_2026-07-26.md`.

Phase 6 recovered that Mongo history `limit="1"` as its own guarded cohort.
The patch is chained from the committed post-rating flow SHA, changes only node
`ddc581fde0073e34`, and validates the route, JSONata query, inactive debug tap,
IDs, wires, and HTTP routes. The normalized candidate is semantically
deep-equal to current live. Evidence is recorded in
`docs/NODERED_TOURNAMENT_HISTORY_LIMIT_RECOVERY_2026-07-26.md`.

Phase 7 restores only a read-only Node-RED audit toolchain. A fresh raw flow,
its redacted metadata, the modular candidate, and validation report are kept in
a private external workspace and never in Git. The workflow has no patch,
import, export, deploy, or runtime mutation operation. The former wide
`sync-games-source`, `prepare-147`, and `exports` commands remain quarantined.

Phase 8 normalizes the chat source mapping without changing chat business
logic. The legacy constructor is replaced by an exact 11-node synchronizer for
the active `LK Games` tab. All tracked functions match the fixed live preimage,
so the current candidate changes zero nodes. Three dirty chat variants remain
on hold. Evidence is recorded in
`docs/NODERED_CHAT_RECOVERY_2026-07-26.md`.

Phase 9 recovers the exact live games-list identity query and normalizer as a
two-function cohort. Fresh verification produces a byte-identical zero-change
candidate. Within the 23 audited legacy dependencies, the prior chat cohort
normalized 11 and this cohort normalized 2, leaving 8 legacy-dependency
mismatches. Two similarly named orphan games-list nodes are counted separately.
The broader recovery classification separately retains 7 subscription and
3 split-payment function mismatches. The legacy broad constructor and dirty
normalizer remain quarantined.
Evidence is in `docs/NODERED_GAMES_LIST_IDENTITY_RECOVERY_2026-07-26.md`.

Phase 10 normalizes the one active direct game lookup query. The two confirmed
`:gameId` routes and downstream Mongo/response chain remain unchanged. This
reduces the remaining legacy-dependency mismatches from 8 to 7; the separately
counted 2 games-list orphans, 7 subscription mismatches, and 3 split-payment
mismatches remain quarantined. Evidence is recorded in
`docs/NODERED_GAMES_DIRECT_LOOKUP_RECOVERY_2026-07-26.md`.

Phase 11 normalizes the active game create/upsert function and guards all 21
nodes reachable from its six POST routes. The fresh live source already equals
the tracked postimage, so publication is byte-identical and changes zero nodes.
This reduces the remaining audited legacy-dependency mismatches from 7 to 6;
the separately counted 2 games-list orphans, 7 subscription mismatches, and
3 split-payment mismatches remain quarantined. The known confirm-alias mode and
pre-Mongo HTTP 200 defects are preserved, not silently fixed. Evidence is in
`docs/NODERED_GAMES_CREATE_UPSERT_RECOVERY_2026-07-26.md`.

Phase 12 normalizes the active tournament document prepare function behind
`POST /lk/tournaments/americano` and guards its complete seven-node graph.
This reduces unresolved audited legacy units from 6 to 5 and, more
specifically, active mismatches from 5 to 4. The four active mismatches are
`fn_patch` plus the three split-payment functions; the fifth unresolved unit is
the orphan/retirement candidate `fn_write_result_response`. Raw/transformed
active debug taps, missing-ID handling, pre-Mongo HTTP response, and
caller-provided rating-change trust remain explicit holds. Evidence is in
`docs/NODERED_TOURNAMENT_PREPARE_RECOVERY_2026-07-26.md`.

Phase 13 normalizes the active games PATCH source from the fresh production
preimage after the deployed tournament A+B cohort. It guards the two confirmed
PATCH routes, the 19-node reachable graph, full-flow SHA, target SHA, IDs,
wires, and links; its publication is byte-identical and changes zero nodes.
This reduces the authoritative source-recovery queue from five units to four:
the coupled split-payment trio and the orphan/retirement decision for
`fn_write_result_response`. The quarantine-only cancellation guard, roster
snapshot rebuild, and `$push` audit changes are explicitly not part of this
normalization and need separate business-contract review. Evidence is in
`docs/NODERED_GAMES_PATCH_RECOVERY_2026-07-27.md`.

Phase 14 normalizes the coupled split-payment trio as one cohort: create,
join, and Viva-router source bodies were taken only from the same fresh live
preimage and tested together. The source synchronizer refuses stale snapshots,
unexpected node identity/output shape, and unknown source preimages. This
removes the final three active source mismatches; the only remaining recovery
unit is the orphan/retirement decision for `fn_write_result_response`.
The normalization does not deploy, import, restart, or change the existing
payment business contract.

Behavior/security cohort A builds, but does not deploy, a four-node hardening
candidate from the exact Phase 12 live preimage. It requires and normalizes
`tournamentId`, routes validation errors away from Mongo, disables both active
debug taps, and enables dynamic HTTP 200/400 status handling. This candidate
does not change the authoritative five-unit recovery queue. Mongo completion
acknowledgement remains a separate hold. The POST endpoint itself is still
unauthenticated and unauthorized: the frontend omits `auth: true`, Node-RED
does not verify a token or organizer permission, and a caller that knows an ID
can overwrite the caller-controlled tournament document, not only rating
changes. Full endpoint authentication/authorization and server-owned audit and
rating data are therefore a separate mandatory cohort; cohort A is not complete
ingress security.

Behavior/security cohort B builds a combined A+B candidate directly from the
same exact live preimage and proves the A intermediate before adding durable
Mongo acknowledgement. Success no longer responds before persistence evidence;
Mongo exceptions use a dedicated scoped Catch and redacted 503 formatter.
Three deterministic nodes are added, `maxTimeMS="0"` remains unchanged, and
the candidate is not deployed. Endpoint authentication/authorization and
server-owned tournament/audit/rating data remain mandatory separate work.
This hardening does not alter the authoritative five-unit source-recovery
queue. Evidence is in
`docs/NODERED_TOURNAMENT_PERSISTENCE_ACK_HARDENING_2026-07-26.md`.

## Decision

Do not run a broad build/deploy from either `origin/main` or the quarantine
`dev` checkout.

- `origin/main` does not contain the source history of the current production
  bundles.
- The quarantine `dist/` reproduces most, but not all, deployed artifacts.
- A single release version currently points to bundles from several different
  deployment cohorts.
- The local modular Node-RED candidate does not match the live flow and cannot
  be imported wholesale.

The exact live frontend artifacts and live flow were copied into a local
recovery set outside Git and verified with SHA256. The raw flow is intentionally
not committed because it can contain production configuration and credentials.

## Release manifests

| Channel | Host | Public origin | Version | Manifest SHA256 | Git provenance |
|---|---|---|---|---|---|
| prod | `lk-primary-147` | `https://padlhub.su/lk/` | `20260725T082609Z` | `4a30a84821d9c703e6430ebf73765b77cd3b0b9c47592dc1789cfcbaff49eb4b` | absent |
| dev | `lk-reserve-89` | `https://lk-reserve.89-108-64-209.sslip.io/lk/` | `20260725T082609Z` | `e0d088da0c96c372f66aff916277a0797ea917377d7e41efb5e7a04c76a59836` | absent |

Server and public manifest bodies matched. Both manifests predate the new
`sourceCommit/sourceBranch/sourceDirty` contract.

## Production artifacts versus quarantine `dist/`

| Artifact | Live SHA256 | Dirty `dist/` |
|---|---|---|
| `release.json` | `4a30a84821d9c703e6430ebf73765b77cd3b0b9c47592dc1789cfcbaff49eb4b` | exact |
| `bundle.js` | `5e97603b665c536eb4275960466435fe99c0aee49bcc88d9887f9083f6c332e0` | exact |
| `games.js` | `d26b4abaee965ef0424d26100c104989ec759dd5f5064731343f1e16da57c745` | exact |
| `tournaments.js` | `5df868c676b92dcd16a72fd98369862ab3917f3f645d24a9ba050f0f8aaa24bc` | exact |
| `tournament-signup.js` | `2762a709f5ec809d06a4e20734eb80d86d65c00f95618a3ae728a1d55c8330f4` | mismatch |
| `group-schedule.js` | `ed682a85f9c5267190b6b62380bf7b110a85870ada764c775855ff470f36d50b` | exact |
| `padel-day-schedule.js` | `5d17a183a697578f28825ad54591e0179cf910de8ddf680a0a7cf848b40bff27` | mismatch |
| `tournament-subscription.js` | `193ea21f64ee7d08d6dd7b4df71673401231a700b7f35648fcb3c632c176b298` | exact |
| `tournament-subscription-referral.js` | `0764e96e5689b3c700deca4e9a11b8e8287f8a977ea3a6dcdff99b22c00c4e9c` | exact |
| `onboarding.js` | `ee66d4dcc333cd2712a41c62bfc45ec14e8973a9aec5f4ad5e8aa236a5664266` | exact |
| `levels-info.js` | `5c8fb7b1576897de67cd2ffc99aecc1b65a52c024386a3bb3d59600f7112e57b` | exact |
| `communities.js` | `74281e2d9f71e38656b118c1694dc6abfb08a40b7246adf3c8daa571609c10b0` | exact |

Result: 10 of 12 prod entries match, including the manifest.

## Development artifacts versus quarantine `dist/`

| Artifact | Live SHA256 | Dirty `dist/` |
|---|---|---|
| `release-dev.json` | `e0d088da0c96c372f66aff916277a0797ea917377d7e41efb5e7a04c76a59836` | exact |
| `bundle-dev.js` | `8417e3ea3b2f8c542a12a2a18ba6a3fb9e32bcd3fc3b65ac41ea8fbcb19ec99b` | exact |
| `games-dev.js` | `886e3aebff1b48e9241898fabf21f8ea668146fe15f9843f3e261251f55500b6` | exact |
| `tournaments-dev.js` | `70d9320101203ff10c5bcaea6053fbcdddddaa77005a23c422c72478752f7f8b` | exact |
| `tournament-signup-dev.js` | `0dba5967ce8d7b6abae90123b0774b2709b1c523259b86e53a73e2a44f75f8ae` | mismatch |
| `group-schedule-dev.js` | `8d4dfd9d8dcc3ce6c74d1e4b29feb4dd201d2e31e338b3b72782e9d409064d2e` | exact |
| `padel-day-schedule-dev.js` | `e888ec2d631217598e582caed304d149abaf56294808786f7fcc3f533579c3d0` | mismatch |
| `tournament-subscription-dev.js` | `2f2a66105649dd7931842a86e696641606a32431c77745a770c558a4b3d0d92a` | mismatch |
| `tournament-subscription-referral-dev.js` | `8816d178b2ee874e443feb071c1d18808a75664bec8a52f1f02c6c360f407e8d` | mismatch |
| `onboarding-dev.js` | `0c89db95a104504a233ce8aed86fbc29b71d4368fef7d61c1fb1c2dacda52a8f` | mismatch |
| `levels-info-dev.js` | `533852bd8403860fb2aa5f2a8859b0c41f1e9855545991c73575c083d66bc215` | mismatch |
| `communities-dev.js` | `a9df9c15b4d865e5e8425142a94e72af16ad103e568ea85cc6678d527e86a172` | exact |

Result: 6 of 12 dev entries match, including the manifest.

## Artifact cohorts

The shared manifest version does not mean that every bundle was rebuilt
together:

- prod `tournaments.js` was replaced on 2026-07-25;
- prod `bundle.js`, `games.js`, `group-schedule.js`, and `communities.js` are
  from the 2026-07-23 rollout;
- prod `tournament-signup.js` and several other standalone bundles are older;
- the dev host contains even more mixed timestamps.

The latest tournament cohort is attributable: the “Time for Friends”
classification rollout produced release `20260725T082609Z`, prod SHA
`5df868c6...`, and dev SHA `70d93201...`. Its focused source is
`src/utils/tournamentCategory.ts` plus its test, but the bundle also contains
all earlier tournament dependencies. Those dependencies must be recovered
before this change can be reproduced from clean `main`.

## Classic Mexicano recovery boundary

Clean `origin/main` does not contain
`src/components/tournaments/mexicanoClassic.ts`. The file first appears in the
tracked `dev` checkpoint `a30ecc6`, while the current quarantine adds a further
large mixed diff across that helper, `TournamentsPage.tsx`, API code, and
tests. Copying those files would mix the production-proven next-round save with
unrelated tournament and subscription work.

Classic Mexicano has now been recovered from blob-verified source/test
postimages. The atomic score-plus-next-layout contract is integrated into the
clean tournament manager. The production offline queue is still held because
its infrastructure is absent from clean `main`; it must be recovered
separately rather than pulled in through the current mixed `TournamentsPage`.

## Live Node-RED preimage

The current live flow was re-read and hashed twice after the initial inventory:

| Field | Value |
|---|---|
| Current live SHA256 | `6d66ef25bdb2a03a031e8be6471fd9333ff960ed980e14e7011e95c76e006a90` |
| Drift from preserved snapshot | two nodes |
| Recovered node | `2e70b2e547e77c00`, function SHA `b46468ec...` |
| Recovered second node | `ddc581fde0073e34`, Mongo `limit="1"` |

The table below remains the preserved historical recovery snapshot used as the
fail-closed reconstruction preimage.

| Field | Value |
|---|---|
| Host/path | `lk-primary-147:/root/.node-red/flows.json` |
| SHA256 | `0f5cd853450a0bcc60e9d2349463b67c491b6a8653302d9a49f4389354c2adf0` |
| Size | 8,148,734 bytes |
| Modified | 2026-07-24 12:37:19 MSK |
| Node count | 4,614 |
| HTTP input nodes | 203 |
| Function nodes | 1,099 |
| PM2 sample | online; restart count 22 |

The PM2 memory/CPU values were a point-in-time inventory sample, not a health
conclusion.

The quarantine modular metadata records an earlier live pull:

- pulled at `2026-07-24T09:32:51Z`;
- raw source SHA `0b2a4f5a59809bc547f63b21e247f003536afeaffb29859bd9c497d6962b67e8`;
- patched local `source.flow.json` SHA
  `56fedfb3f61f1538c2b8a83158d0deb16324a2119f04f809e93cc84745fcaaa6`.

Compared with the current live flow, the patched local candidate has:

- 37 IDs present only in live;
- 37 IDs present only in the candidate;
- 34 changed shared nodes;
- 13 changed function bodies.

The 37 added/removed IDs are largely same-named referral-subscription nodes
with different IDs. Importing the candidate could therefore duplicate or
replace active HTTP routes. The two active
`Dedupe + normalize upcoming games` functions also differ from each other and
from the current source function. A new live pull and node-specific preimage
review are mandatory before any Node-RED recovery commit or rollout.

## Recovery queue

### Production-proven

1. “Time for Friends” classifier: recovered as a focused tested change.
2. Classic Mexicano online atomic next-round persistence: recovered as a
   separate tested change.
3. Tournament rating recalculation/current completion idempotency: recovered as
   an exact live function with a guarded node-specific builder.
4. Tournament history `limit="1"`: recovered as a separate guarded
   configuration cohort chained from the rating candidate.
5. Recover the Classic Mexicano offline result queue as its own dependency
   cohort.
6. Recover the 2026-07-23 core performance cohort for
   `bundle/games/group-schedule/communities` with its focused tests.
7. Rebuild Node-RED only from a fresh live pull and source functions; never
   promote the quarantined full flow/import JSON directly.
8. Use the external-workspace audit before defining any later node-specific
   recovery cohort; audit output alone is not a deployable artifact.
9. Review the three held chat function variants as separate business changes;
   do not fold them into source normalization.
10. After Phase 12 the authoritative audited queue is exactly 5 unresolved
    units: 4 active function-body mismatches (`fn_patch` and the coupled three
    split-payment functions) plus the orphan/retirement candidate
    `fn_write_result_response`.
11. Review `fn_patch` first, then review the split-payment trio together as one
    coupled recovery cohort; do not split those three functions into separate
    recovery changes. Review `fn_write_result_response` last as a retirement
    decision. Its exact live body occurs zero times, repository code has no
    references to it, and the remaining reference is documentation only; no
    patcher reference is claimed.

### Hold / quarantine

- Do not overwrite prod `tournament-signup.js` or `padel-day-schedule.js` from
  the current dirty `dist/`.
- Do not overwrite the six mismatching dev bundles.
- Do not treat `release.json` version equality as proof of bundle parity.
- Do not commit the raw live flow or recovery archives.

## Reusable audit commands

```bash
npm run audit:release-artifacts -- /path/to/remote.sha256 dist
npm run audit:nodered-flow-drift -- /path/to/candidate.json /path/to/live.json
npm run test:recovery-audits
```
