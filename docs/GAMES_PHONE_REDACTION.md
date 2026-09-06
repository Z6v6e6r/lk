# Games API phone redaction

## Scope

Phone data is removed from successful game read responses for the active routes:

- `GET /lk/games`
- `GET /lk/games/by-phone`
- `GET /lk/games/:gameId`
- `GET /lk/games/records/:gameId`

The list query may still accept `phone` as a private lookup input. Filtering, stale-membership checks,
deduplication, and pagination run before response redaction. The stored MongoDB document is not mutated.

The response sanitizer removes phone-bearing fields and phone identities, exact Russian phone values,
phone values embedded in text, and phone query parameters. Arrays, ordinary JSON objects, and metadata
are traversed recursively. Non-plain runtime values such as `Date` and BSON `ObjectId` are preserved.

## Client compatibility

Identity-filtered list responses include `identityFiltered: true`. The current client treats IDs from
such a response as already authorized by the server-side lookup, so removing phone fields does not make
the user's games disappear. Unmarked responses from an older backend continue through the previous
client-side identity guard.

Game, organizer, participant, and waitlist IDs remain unchanged. Names, booking fields, status, payment
state, pagination, and the existing 404 response are preserved.

### UUID preservation regression (2026-09-05)

The previous embedded-phone matcher interpreted the `860-4924-4450` portion of a
canonical UUID as a Russian phone number. It replaced that portion of the game ID
with `[redacted]` in both list and detail responses, so the generated invitation
could not find the existing game. The stored game and its Viva booking were intact.

Both response functions now preserve complete canonical UUID spans (case-insensitive
hexadecimal `8-4-4-4-12` with hexadecimal boundaries), including UUIDs in prefixed IDs,
arrays, text and invitation URLs. Phone-bearing fields, phone identities and phone
query values are removed before this exception; text outside UUID spans is still
redacted. There is no blanket exception for fields named `id` or `bookingId`.

Already copied links containing `[redacted]` cannot be reconstructed from the damaged
ID. After the approved rollout, reload the game list and copy/open a new invitation.
Do not create a replacement game or modify its booking/payment to repair this issue.

Local acceptance on base `4237fbafe42df9f577356b15487693cc7215d32e`:

- `gameResponsePhoneRedaction.test.ts`: 11/11; the six added cases failed before
  the fix and pass after it. Covers public/identity lists, detail lookup, the
  list-to-invitation-to-query ID, nested UUIDs, adjacent phones, invalid UUIDs,
  phone-field/query precedence and unchanged stored input.
- `gamesDirectLookupRecovery.test.mjs`, `gamesListIdentityRecovery.test.mjs`,
  `gameListNormalize.test.ts`, `gameIdentityRelevance.test.ts`: pass after updating
  the expected candidate source hashes. Historical whole-flow and node preimage
  pins in the two recovery patchers remain unchanged; they are not current-live
  deployment entrypoints.
- Full `npm run lint`: zero errors, 387 warnings. Full `npm run build` (TypeScript
  and prod/dev bundles): pass with the CI inert `ci.invalid` configuration and
  existing workstation dependencies. These bundles are local validation artifacts,
  not deployable release artifacts; a fresh locked install was not run.
- Fresh read-only `LK Games` modular build/validate: 315 selected nodes, 38 HTTP
  inputs, no broken wires/links. The validated extraction is the live baseline;
  the two-function candidate is separately constrained by a reviewed-flow contract.
- Independent security review: no material findings; seven additional adversarial
  VM cases passed, including cross-realm records and UUID boundaries.
- `reviewedFlowDeploy.test.mjs` and `noderedModularToolchain.test.mjs`: 42/42 pass.
  Independent release review confirms two `func`-only changes, unchanged topology,
  matching contract digests and candidate functions identical to the edited sources.

The private live snapshot is
`/private/tmp/lk-game-id-redaction-live-20260905/input/source.flow.json`
(SHA-256 `46cf684fce5017e5ff4c5add22e918cfde92d404b651b416b6fdebd30275504a`).
Both target functions were byte-identical to the base sources. The private
`candidate/flow.json` and `candidate/contract.json` in that workspace constrain
exactly the two function bodies; 4768 nodes and all 215 HTTP inputs are preserved.
Candidate SHA-256:
`7775475aea2436ca5d6ec26cdc6acc4c682556f05b71af2fb79f6e0c0edbcb71`.

This snapshot is rehearsal evidence only. Before an authorized rollout, obtain a
fresh live snapshot, recheck both function preimages and rebuild the exact candidate
and function-only contract. Abort on unrelated drift. Use the existing reviewed-flow
deployment workflow and its backup/lease checks. Rollback must target the immediately
preceding phone-redacting snapshot, never the historical unredacted preimage.
No deploy, restart, join, provider call or stored-data mutation was performed during
this implementation. Actual joining remains untested until an authorized live check.

## Candidate and release boundary

The guarded Node-RED patcher is pinned to a fresh live-flow preimage and permits only the `func` field of:

- `0485dea01865b2dd` — `Dedupe + normalize upcoming games`
- `d44d0fcf9250927f` — `Build game by id response`

It rejects route, node, wiring, link, count, source-hash, and unexpected-field drift. Candidate generation
does not import or reload Node-RED.

For rollout, publish the compatible frontend first, verify that old and marked responses both render,
then obtain a new live-flow audit and generate the Node-RED candidate from that exact preimage. Import,
reload, deployment, or rollback requires a separate approval.

## Read-only post-check

After an approved deployment, compare game IDs, counts, pagination, participant/waitlist IDs, and status
against the pre-deploy readback. Assert that response keys contain no phone fields and serialized values
contain no raw or formatted phone numbers. Exercise only read endpoints; do not join, leave, book, pay,
or mutate game data.

Rollback uses the exact pre-deploy live-flow snapshot after a fresh drift check and separate approval.

If a historical v1 reviewed-flow lease remains after the exact phone-redaction
candidate is already active and its soak window has expired, do not delete the
lease and do not use rollback merely as cleanup: that would restore the
unredacted source flow. The reviewed-flow helper provides a separate
`finalize-legacy-v1-candidate` action. It is fail-closed on frozen hashes for the
lease, active flow and both backup artifacts, revalidates the full function-only
contract and PM2 online state, writes a root-protected receipt, and only then
releases the matching v1 lease. It performs no flow write or Node-RED restart.
Running that action still requires exact production authorization.
