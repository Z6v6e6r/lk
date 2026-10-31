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
