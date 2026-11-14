# Community logo binary/cache repair

The public logo endpoints returned HTTP 200 and `image/jpeg` with a JSON numeric
object instead of JPEG bytes. `sanitizeTypedCommunityPayload` recursively copied
Node.js Buffers into plain objects. This also affected the legacy media handlers.

The response sanitizer now preserves real Buffers and adds the stable
`lkLogoRev=20261112-binary-v1` query parameter to `logo`, `logoUrl`, and
`logoThumbUrl` values on the known primary/reserve community media routes. This
bypasses the previously corrupted responses cached for a year as immutable.
External images, data URLs, non-logo fields, privacy rules, and stored records
retain their existing behavior. A fresh community API read supplies the new URL;
an already open screen can require reopening or refreshing.

## Release scope

Owner: PadlHub LK backend. Audience: community list/detail and logo consumers.
The approved target is Node-RED on `lk-primary-147`; no frontend artifact is
rebuilt for publication and no shared database update is needed.

`scripts/patch_live_community_logo_binary.mjs` upgrades only existing known
response wrappers. It rejects unknown sanitizer/wrapper preimages, missing media
copies, incorrect response wiring, and whole-flow SHA drift. The reviewed
function-only contract preserves all function bodies, routes, wires, node IDs,
and configuration. The fresh production snapshot currently has 75 wrappers,
including both sets of four original/thumb/legacy media response functions.

Touched endpoints: `/lk/media/community-logo/:assetId[/thumb]`,
`/lk/media/community-logo-legacy/:communityId[/thumb]`, and the logo fields in
community list/detail/upload/mutation responses. Raw flow, candidate, contract,
and rollback artifacts stay in private external directories, outside Git.

## Ordered execution and recovery

1. Run binary/cache/privacy regressions, existing community/auth/media tests,
   reviewed-flow deployment tests, repository lint, typecheck and build. Review
   the exact diff, run the configured outgoing secret/PII scan, commit and push
   only the task branch.
2. Pull a fresh `147` preimage with `scripts/pull_nodered_source_from_147.sh`.
   Build a candidate and function-only contract with the exact source SHA.
3. Use the existing reviewed-flow helper `preflight` and `apply` with its global
   lock/lease, backup pair, source/candidate hashes and PM2 activation. Never
   overwrite a foreign lease, patch production by hand, or deploy a stale flow.
4. Verify live candidate hash, unchanged static frontend manifest/hashes, list
   URL versions, binary magic/decoding for original/thumb/legacy, and 404/error
   delivery. Open real API URLs through the verified browser tunnel and inspect
   decoded images, including a fresh read replacing a cached old URL.

Stop signals: source drift, foreign active deployment lease, wrong JPEG bytes,
missing cache version or changed privacy behavior. Before apply these stop
publication. After apply, use only the reviewed helper's guarded rollback with
the matching flow/contract backup pair if live state is still that candidate;
never overwrite a concurrent foreign change.

## Regression checks

- `node --test scripts/tests/communityLogoBinary.test.mjs`
- `npm run test:community-types`
- `npm run test:community-media-response`
- `node --test scripts/tests/reviewedFlowDeploy.test.mjs`

The new tests reproduce Buffer corruption with the frozen previous sanitizer,
exercise actual wrapped media functions, and verify byte identity, typed PII
redaction, FRIENDS compatibility, 404/500 output wiring, external URL preservation,
cache query/hash/idempotency, source immutability and negative preimage/wiring
guards. Production verification evidence belongs in the external release report.
