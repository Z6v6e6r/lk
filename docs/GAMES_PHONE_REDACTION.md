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
