# Private fixed-quarter CREATE preparation v1

Owner: LK canonical subscription integration. Audience: authenticated LK2 backend only.
This source packet observes an owned subscription, location, service catalogue and the
price of a full court window. It does not authorize registration, assess eligibility,
reserve usage, create an exercise, lock a price, or prove CREATE completion.

POST `/lk/integrations/v1/game-create-preparations` requires the existing receiver and
execution flags, existing RS256 delegation configuration, exact scope
`subscription-runtime.game-create.prepare`, actor-token binding and fresh verified actor.
No configuration is created or enabled. Missing flags/configuration fail closed.
The exact body/claim allowlists are in `_game_create_preparation_contract.js` and the
verify node. Caller supplies public draft/station/court/subscription IDs and time;
trusted signed mapping claims supply provider identities. Client amounts, share count,
service selectors, recovery modes and unknown fields are rejected before reads.

The eight station/service pairs are extracted from the existing hub declaration and
checked against onboarding and preview declarations. No name scoring or global-cache
fallback selects a service. Fresh reads verify profile, complete owned-subscription list,
room/station, master-service/station and exact subservice. Catalogue ambiguity,
incompleteness, unavailable credentials, redirect, transport failure or missing exact
response URL stops the observation. All provider requests are bounded GETs without retry.
No Mongo node, provider business POST, index creation or external write is reachable.
No provider client name, phone, bearer or raw response is returned or persisted.
Private provider identity in the capsule must remain backend-only.

The price route is the existing room/subservice full-window route. Only positive integer
`total` minor units, at most 10,000,000 and exactly divisible by four, are supported.
The capsule identifies `WHOLE_COURT_WINDOW`, both whole and quarter minor-unit prices,
participantCount=4, exact service pair, source selector revision, minimal catalogue
facts digest and original actor/location/request bindings. Same-date Moscow windows
with minute precision are required. Observation expiry is 60 seconds, matching the
existing preparation convention; it is not a provider price guarantee. A subsequent
preparation may observe a changed price, but cannot amend any admitted operation.
Hashes provide integrity, not signing authority. No eligible/usage/reservation claim
is returned. Membership, capacity, policy, time availability and actual service/runtime
mapping acceptance remain outside this nonbinding observation.

## Admission boundary deliberately absent

CUP preflight currently accepts JOIN_GAME only. Existing production partial-discount
policies apply 1/4 to a whole-price base; the TEST exact-target contract supplies an
already-divided base. This endpoint preserves both quantities explicitly and does not
call either evaluator. A future CREATE adapter must pin one basis and avoid division
twice. It must bind service/price/mapping evidence into the existing precreate attempt,
recheck before first reservation/provider write and reject changed observations.
After PRECREATE_ATTEMPTING or any ambiguous write, only the original immutable proof
may be recovered: no new service, price or operation substitution. No unused journal
fields or changed legacy recovery comparisons are introduced here.

## Source custody and verification

`composeGameCreatePreparation` is a pure additive graph builder with an exact-graph
contract. Existing LK1/JOIN/TRAINING/SELF nodes are preserved, including output counts.
No deploy allowlist is extended. Installation and activation require separate owner
approval, a fresh runtime preimage and the normal reviewed deployment procedure.
Stop method: keep the route uninstalled; existing receiver/execution OFF also rejects
it. Removal/review condition: revisit this preparation contract when actual CREATE
admission adopts it; it must not become an alternative booking authority.

Synthetic tests use ephemeral keys and in-process provider fixtures; no provider/DB
calls occur. Task uses a sparse checkout due host disk constraints. Focused LOCAL
checks do not establish full LOCAL, CI, PROVIDER or PRODUCTION acceptance. Full automatic
CI on the final task head remains required. No actual selector/runtime/provider
population was read or activated in this task.

## Unused reserved quarter expiry (private receipt v2)

An expired capsule alone never authorizes compensation. The original canonical
`PRECREATE_RESERVED` row must win a full-preimage Mongo-clock CAS to
`PRECREATE_ABORTING` against the existing `PRECREATE_ATTEMPTING` dispatch CAS.
The original tenant, actor, subscription, service date, admission/binding, placeholder,
CUP instance/usage and reserved quarter decision remain pinned. Any field-present
attempt, provider, booking, recovery or promotion evidence (including null) denies
this branch. Mongo stores immutable ISO-string `abortedAt` and original expiry in
`quarterPrecreateAbort`; no expiry extension or provider write occurs.

A fresh exact marker read permits a short-lived `release-v1` proof for
`PRECREATE_EXPIRED_NOT_DISPATCHED` with null booking. This is proof of irreversible
no-dispatch custody, not an invented provider rejection. Lost abort/release ACKs use
exact reads. Original proof TTL is unchanged: after expiry, a fresh marker read may
issue a fresh signature, without changing `abortedAt` or capsule expiry. Only exact
CUP seven-field `FAILED/APPLIED/PRECREATE_EXPIRED_NOT_DISPATCHED/null` readback
can atomically settle canonical `RELEASED`. Its first durable readback timestamp
becomes immutable `rejectedAt`; the outer journal then stores receipt schema 2.
Only both terminal proofs allow existing full-preimage reclamation. An old key
replays its own outer receipt even after a newer canonical generation exists.
`PRECREATE_ATTEMPTING` without a receipt remains UNKNOWN indefinitely.

Receipt v2 is frozen in `scripts/tests/fixtures/quarter-create-expired-v2.json` and
paired byte-for-byte with CUP/LK2. It binds original operation/admission/actor/target,
abort UUID, original capsule expiry, abort/rejection timestamps and exact CUP usage.
It has no provider status/rejection timestamp. Public/current attendance stays
UNKNOWN. Existing successful and provider-rejected schema-1 receipts are unchanged.

SOURCE rollback: retain all abort and receipt records. Old binaries reject the new
reason/receipt, so mixed-version adoption needs the compatible CUP→LK→LK2 packet;
no flag activation or deployment is included. Never erase an abort marker, downgrade
it to RESERVED or replay CREATE. LOCAL unit/graph tests use synthetic HTTP/Mongo;
CI-only Mongo cases use the existing isolated fixture for dispatch/abort races and
ACK/reclaim recovery, with provider responses still synthetic. No provider/device/
production acceptance is implied.

Schema-2 terminal outer writes atomically include a checksum of its explicit canonical
receipt fields. Replay and reclamation require it; reordered object keys remain valid.
Missing/mismatching checksums stay UNKNOWN and are never regenerated to heal a stored
receipt. This detects partial/accidental corruption, not an actor able to modify both
trusted row and checksum; original LK custody and signed CUP release remain authority.
