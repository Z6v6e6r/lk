# Private quarter CREATE owner (SOURCE only)

This packet consumes the existing nonbinding CREATE preparation from LK #273 and
the actor-bound CUP canonical-target intake v3. It does not activate either system,
change a provider credential or publish/import a Node-RED graph. LK2 still needs a
matched private issuer/consumer and public draft/seat receipt integration before use.

## Scope and wire

Only opted, published schema4 `ORGANIZER_QUARTER_CREATE`, ACTIVE owned subscription,
60-minute game, four participant places and one organizer spot are supported.
The provider whole-court price remains immutable in target evidence. CUP evaluates
exactly one quarter as FREE_ENTITLEMENT, final money zero and usage units one.
No second division, full-court benefit, paid fallback, other participant adoption,
payment, refund or post-creation deletion is introduced. Ordinary LK1 durations
60/90/120 and existing entry routes retain their current behavior.

Both new routes are backend-only POSTs:

- `/lk/integrations/v1/game-create-operations/admissions`: exact body
  `{contractVersion:1,action:'CREATE_GAME',subscriptionId,target,preparation}`.
  `target` is the original public draft/revision/station/court/start/duration tuple;
  `preparation` is the exact existing private capsule, including its original 60s expiry.
- `/lk/integrations/v1/game-create-operations/:operationId/read`: exact body
  `{contractVersion:1,operationId,admissionRequestSha256}`.

Same existing RS256 issuer/audience/key, actor-token digest and verified provider
mapping are required. New exact scopes are `subscription-runtime.game-create.admit`
and `subscription-runtime.game-create.read`. Hash domains are
`game-create-admission:v1\0` and `game-create-read:v1\0`, followed by canonical ordered
body JSON. READ verifies its own signed intent, then checks the original admission
hash against stored custody. Original preparation operation-ID derivation is unchanged.
Optional signed `recovery_only:true` is accepted only for admission; false and READ
use are invalid. Missing original rows on recovery cannot create anything.

Private receipt includes original public actor/draft, provider exercise/booking IDs
and persisted CUP instance/policy/usage operation/units. It is not a public DTO.
Successful response separates immutable `operation.status/receipt` from fresh
`registration.status/asOf`. Current cancellation, contradictory identity, unavailable
or incomplete reads yield registration UNKNOWN without rewriting historical receipt.
An unknown operation includes a stable bounded reason; no raw provider error is returned.
`scripts/tests/fixtures/quarter-create-owner-v1.json` is synthetic and byte-identical
to CUP `test/fixtures/quarter-create-owner-v1.json`; tests run actual producer and CUP
intake/resolver/evaluator/reserve contract on those bytes.

## Durable phases and one writer

Existing `lk_subscription_daily_booking_ops` stores the outer row under
`game-create-admission:<verified tenant_id>:<operationId>`, with explicit `tenant_id`,
kind `GAME_CREATE_ADMISSION`, original identity/body/hash and ISO timestamps.
It deliberately has no top-level legacy `state`, `tenantKey`, `actorClientId`,
`clientSubscriptionId`, `exerciseId`, `serviceDate` or `lk1` fields.

| Outer phase | Permitted next work |
| --- | --- |
| CREATE_ACCEPTED / CREATE_OBSERVING | Fenced lease, actual composed capability, fresh original observation |
| CREATE_FACTS_READY | Exact stored actual catalogue roomIds, whole price, actor-owned runtime pins; idempotent target intake and nonbinding preflight |
| CREATE_READY | Exact immutable CUP expectations; dispatch CAS with unique nonce |
| CREATE_ATTEMPTING | Read original canonical operation; restrictive recovery only |
| CREATE_CONFIRMED | Immutable original receipt; fresh read-only registration observation |
| CREATE_REJECTED | Immutable original rejection and canonical APPLIED compensation proof; no further provider work for this operation |

The existing canonical daily operation remains the only reservation/booking writer.
Before reserve, it stores the entire original managed CREATE binding. A lost reserve
response replays the same operation and expectations, never re-observes or reprices.
Only fresh original capsule plus successful RESERVED→ATTEMPTING CAS permits the
first provider CREATE. ACK loss rereads the exact same-process nonce; a new request
cannot adopt that dispatch authority. Expired reserve-only recovery reports
`GAME_CREATE_OWNER_CAPSULE_EXPIRED_BEFORE_DISPATCH` and remains pending. Operator
reconciliation is required; no refreshed capsule, guessed release or replacement key.

A successful original POST response must supply an unambiguous ID. Exact attempt
nonce/binding CAS persists that ID before any organizer POST. Receipt custody may
finish after actor expiry, but subsequent mutation waits for fresh verified actor.
A fresh recovery uses only that saved ID. ATTEMPTING without saved original ID stays
`GAME_CREATE_OWNER_PROVIDER_ACK_UNKNOWN`: no second POST, 409 adoption or room/time
search. Organizer promotion is another exact CAS. Lost organizer ACK without an
attributable stored booking ID remains UNKNOWN, even if a matching booking appears.
Only canonical booking confirmation plus CUP CONFIRMED and completed activation
can produce a receipt. Release reuses existing signed definite precreate-refusal
logic; timeout/409/possible creation never creates new compensation authority.

A definite refusal is terminal only after the existing CUP seven-field readback
proves exact original usage operation/instance, FAILED/APPLIED/PROVIDER_REJECTED and
null provider booking. The canonical RELEASED row stores that proof atomically.
An explicit original command then persists its immutable outer REJECTED receipt;
READ alone does not finalize it. Subsequent original reads/retries return that receipt
without looking at or mutating a later operation. Registration remains UNKNOWN: a
rejected operation does not prove absence of unrelated attendance.

Only after that permanent outer receipt exists may a separately chosen fresh command
reuse the existing released daily slot. Quarter reclaim compares the complete old
canonical preimage, old actor/tenant/subscription, exact quarter binding, absence of
any successful exercise/booking and the saved outer receipt. Concurrent replacements
cannot both win. The old outer receipt is never deleted or overwritten. The new
command must use a newly prepared public draft revision (or new draft): CUP's prior
target revision stays immutable and a new key cannot rewrite it. A lost reclaim ACK
reads the new exact operation; it does not blindly issue provider CREATE. Unproved,
pending, ambiguous, foreign or already-created rows are never reclaimable.

CUP currently supports only PROVIDER_REJECTED and BOOKING_CANCELLED release reasons.
An expired PRECREATE_RESERVED capsule proves neither. Its explicit pending limitation
therefore remains; this packet does not mislabel expiry or invent financial policy.

## Composition, privacy and compatibility

`composeGameCreateOwner` accepts only exact reviewed source/topology from business
base `62e32f7b963f8ab04d7a7eabcde37a66a51b77f9`, including prior training composition.
It preserves ordinary split fourth-edge HTTP traffic; only private owner messages
enter the new bridge. A nonce-bound capability traverses actual split preparation,
split router, canonical prepare/router/finalize before mutation. Old/mixed stages,
foreign edges, missing canonical ingress, Mongo forks or changed source fail closed.
Historical PATRIOTS/deployment pins are unchanged; current diagnostic hashes are
derived separately from actual current business bytes. This is source composition,
not evidence that any installed graph matches.

Private paths suppress diagnostic observers, transport headers and debug fanout.
No actor token, admin token, signing proof or whole provider response is persisted.
Replies remove private context and credentials, and carry no-store/no-referrer.
Existing JWT/server credentials must be configured independently; the dedicated
`subscriptions_target_ingest_integration_token` must match CUP's existing dedicated
target credential. It has no fallback. Missing configuration prevents target writes.
No new flag is added: existing receiver/execution, CUP runtime/identity/intake/
resolver/entitlement and owner-evidence gates all remain prerequisites.

SOURCE review found no daily-ops TTL/index-creation or journal-pruning definition.
Outer timestamps are strings, not BSON dates. Existing daily/leave/visit/hung-claim
selectors require fields absent from outer rows. This does **not** verify deployed
indexes or operational retention. Before activation, an owner must verify no runtime
TTL, wildcard cleanup or manual reconciliation can erase outer/canonical custody.
Unknown deployed retention is a blocker, not a reason to weaken durable replay.

## Verification and activation/rollback boundary

LOCAL tests execute actual function sources with synthetic HTTP/Mongo fixtures.
Paired CUP contract tests use real intake, trusted identity hashing, canonical target
resolver and evaluator; JWT verification input/provider data remain synthetic.
CI-only `gameCreateOwner.mongo.test.mjs` uses four independent clients and captured
actual source queries against the existing monthly loopback Mongo fixture. It tests
admission convergence, nonce contention, lost ACK reads, ID persistence and organizer
CAS. It does not test a real provider. No local database service is provisioned.

Activation requires both matched task heads, full CI/physical checks, exact installed
graph preimage, correct tenant/credential purpose, strict publication/current instance
adoption, runtime retention and actor/provider acceptance. LK2 consumer/device/store
acceptance remains separate. No activation or deployment is authorized by this file.
All canonical writers must run the coherent upgraded graph, with old in-flight
writers drained before activation; source gating cannot retroactively fence an
already-running older binary's weaker reclaim CAS.
On rollback stop new private admissions through existing approved gating, retain all
rows/IDs and reconcile using the compatible owner. Never replay an ambiguous CREATE
through an older graph, erase the journal or downgrade its binding to ordinary LK1.
