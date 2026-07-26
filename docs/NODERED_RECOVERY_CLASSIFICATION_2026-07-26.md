# Node-RED recovery classification — 2026-07-26

This is a read-only recovery checkpoint. No server flow, PM2 process, route, or
database record was changed.

## Current live revalidation

The live flow was read and hashed twice after the initial inventory:

- current live SHA256:
  `6d66ef25bdb2a03a031e8be6471fd9333ff960ed980e14e7011e95c76e006a90`;
- drift from the preserved `0f5c...` snapshot is limited to two nodes;
- function node `2e70b2e547e77c00` changed from SHA `8017f7cd...` to
  `b46468ec...`;
- Mongo node `ddc581fde0073e34` changed `limit` from absent to `"1"`.

The function source and focused idempotency regression have been recovered.
The Mongo `limit` change remains on hold and is not included. Full evidence and
the guarded reconstruction procedure are recorded in
`docs/NODERED_TOURNAMENT_RATING_RECOVERY_2026-07-26.md`.

## Historical verified preimage

- host: `lk-primary-147`
- path: `/root/.node-red/flows.json`
- SHA256 reverified on 2026-07-26:
  `0f5cd853450a0bcc60e9d2349463b67c491b6a8653302d9a49f4389354c2adf0`
- recovery copy:
  `/Users/zver/Desktop/project-fixed-6-recovery-20260725/live-20260726/lk-primary-147-flows-20260726.json`
- nodes: 4,614

The recovery copy stays outside Git because a raw flow can contain production
configuration and credentials.

## Import decision

Do not import the quarantine candidate or generated import JSON wholesale.

- 37 IDs exist only in live.
- 37 IDs exist only in the candidate.
- Those 74 entries are two ID generations of the same referral-subscription
  route cohort. Live IDs and wires are authoritative.
- 34 shared nodes differ.
- 13 shared function bodies differ.

The recovery path is node-specific: retain the live ID and wires, review one
source function, validate its tests, then use the exact live function SHA as
the preimage guard.

## Function-body drift

Hashes identify bodies without recording their content in the report.

| Cohort | Live node ID | Node | Candidate SHA256 | Live SHA256 | Decision |
|---|---|---|---|---|---|
| tournament subscription | `08b36003a66cd381` | `summer_subscription_limit` | `accd0d473b9bbd5ab1bc1508b0bd8cd1d346f05296cd58444709287558f06791` | `0da092ffc4e56a233a46904fc219da54f2689159936359fb40119d3b757283a7` | hold with subscription cohort |
| tournament subscription | `945c1f1c113a56b6` | `Prepare tournament subscription status` | `412bf7b29c3a1f358540d66d73ee2a3ed2a37c0c46a31c78f65633e7255c74bb` | `b41239d08da4b9fc8c7949705117c95d264e6e34a0d311d03423e0d6b735bdfa` | hold with subscription cohort |
| tournament subscription | `ef90184a8c79cfc1` | `Build tournament subscription status` | `d21846dc537f9b0c8940ab83ddd6c4dd3df4f0e296fa640e98ede0bd479d926b` | `f2235daf139588dc82ae1a97033c41bb1d5cb90f09adc64eb46721568f490060` | hold with subscription cohort |
| tournament subscription | `d1ab6ebf91540479` | `Prepare tournament subscription purchase` | `a9dd090a0dc868acdbc999abaa713f04eb845bc8242779ee14073ed89f621bed` | `dd93b6248a9a9283b4a549eeb5272891155366c44e86613c4963f1e043d16425` | hold with subscription cohort |
| tournament subscription | `ee9ae5265456837d` | `Prepare tournament subscription confirm` | `b8785a0983c6fbcbff4d2eb2b125ac6c577e4b943491152e3324a92a120bfbcf` | `d6d3f5e345c4957e0b3cf86987219801dcf42883b6993f1d1db1f393df49a893` | hold with subscription cohort |
| tournament subscription | `4ede87e47d44312c` | `Resolve tournament subscription confirm` | `4471693385741f5ec91c10b19799831eb5fffd54a50d5ae7c2b9c0f4639c266d` | `bdbcaa4d6786dcbed70edb1eb42d75dd33f895458799832a5a3ff85ab0a7d80c` | hold with subscription cohort |
| tournament subscription | `acd980b88353c25d` | `summer_subscription_limit` | `accd0d473b9bbd5ab1bc1508b0bd8cd1d346f05296cd58444709287558f06791` | `6d71cc957a1fd9763125bdbf982c0d10fb3ca8e44371f08bff26bdfb67473668` | live duplicates differ; do not normalize blindly |
| games list | `fcb8b28e2ecb4e7c` | `Build upcoming query by phone` | `2535de7d1219cc56fe4eb752c5b4df14f9f4dc1f8f2443a0b29422fb3af990ee` | `1751a97de77d5c1b9994a1266b45635685e2551dd18f714a5765ce1e6e7f3e44` | review query contract first |
| games list | `f4cc88af12330122` | `Dedupe + normalize upcoming games` | `e99d0311090ac280d6ff2c6d8d27a0034d63f6acb6bcbcd3f6a9fcc3d990287e` | `34c4eb2eb0e614504f6e17927e093b454e820d45b13b4a7be19ec85cf76460ca` | duplicate live nodes differ |
| games list | `0485dea01865b2dd` | `Dedupe + normalize upcoming games` | `e99d0311090ac280d6ff2c6d8d27a0034d63f6acb6bcbcd3f6a9fcc3d990287e` | `aabbe49ef2b7547df800ae95ac0b59579279e3841c635fc8b66356dc52218886` | duplicate live nodes differ |
| split payment | `f3f9a60354d394da` | `Prepare split game payment` | `c6172152ecc068e67545f625d7071a69580bde00c5d37b10c0fc9a51a2becfc2` | `d76e532d8f9d3cba655a4fabadf21635c85ed360a4bfac18534e10fef5661bfa` | recover with payment tests |
| split payment | `e92e68bf3f08a70c` | `Prepare split join payment` | `fe43d31b545ec8b74fc4783418c9dd0f59e632fac6052fc951078b7415b38084` | `707fdde66c340769a0c68e6e693bda22eb040b715ef33ad109e39c4709cea950` | recover with payment tests |
| split payment | `8f7bd5b482fe9763` | `Route Viva split payment` | `2b0eef5efd231b525144ac38469029d3fc6c4caa5303220e4329fd86098637cf` | `d9d6d1f17c12f38b567cf226468caa6780ed3d6e707f55f4af26c066be86b1a4` | recover with payment tests |

The six games-list/payment candidate hashes match the corresponding source
files in the quarantine checkout. Clean `main` contains older versions of
those files, while live contains a third version. Therefore neither clean
`main` nor quarantine source is automatically authoritative.

## Shared-node configuration drift

The other 21 shared nodes have no function-body change:

- `662c4669cc17d82a`, `bf7e8b4a95f35228`, `7792fedede7d0730`:
  debug `active`;
- `ccd7d6b82f8b90c1`, `f6a7b8c9d0e64212`: `wires`;
- `ddc581fde0073e34`: history `limit`;
- `ab1e202650000001` through `ab1e202650000006`: editor coordinates only;
- `d223efc8797469a2`: comment `name/info`;
- `127cf4d595cc30bc`, `result_rating_compatibility_write_001`:
  Mongo `maxTimeMS`;
- `665453741f79a08a`, `601bcf38026c03b7`: split `propertyType`;
- `170d7819636f6e23`, `pd5245_profile_request`,
  `pd5245_bookings_request`, `pd5245_exercise_request`: request timeout.

These differences must not ride along with a function repair. Each requires a
separate operational justification or should remain exactly as live.

## Recovery order

1. Games list query and the two normalizers: determine which live node is on
   each active path, preserve its ID/wires, then test phone and `clientId`
   matching.
2. Split-payment trio: recover as one tested contract because their payloads
   and routing are coupled.
3. Tournament-subscription cohort: first recover its missing source/test
   dependency chain from quarantine; keep the live route IDs.
4. Referral-subscription 37-node cohort: generate a name-to-live-ID mapping
   from the live preimage; never replace the whole tab.
