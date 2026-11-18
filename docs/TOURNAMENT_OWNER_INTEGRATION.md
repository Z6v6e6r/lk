# Tournament owner integration — source candidate, not deployment

CUP owns canonical admission and durable capacity holds. Related changes: ph-admin owner integration
and LK2 local-owner receipt consumer. P0 remains open until Viva blocks direct client/widget writes.
No live flow import, provider booking/payment or deployment is part of this change.

## Browser

`apiCreateTournamentVivaTransaction` routes server-classified tournament selections to
`POST PHAB_API_BASE/tournaments/:exerciseId/checkout` with an actor/target stable key. It forwards
selected product source/ID, promo and return URLs. CUP rebuilds the existing Viva v2 cart and derives
actor/studio from trusted data. The browser cannot submit amount, discount or invitation overrides.
One-time, owned one-time and subscription-plus-tournament retain their cart form. Existing
custom-energy and owned-subscription/money-discount paths retain their price logic and dedicated
owners. They do not fall back into the ordinary transaction route.

Unknown means recovery of the original operation, even under a different key. Browser result
resolution uses only the acknowledged transaction, never a client-wide websocket or single unrelated
exercise booking. Paid completion asks CUP to reconcile by exact transaction attribution.

## Node-RED source integration

Use `scripts/prepare_tournament_admission_candidate.mjs SOURCE SHA256 NEW_OUTPUT` on an approved,
fresh, complete exported booking graph. All three paths must be absolute; output must not exist.
The source hash, unique node IDs, router ID/type/outputs and function syntax are validated. Only
that router function changes; graph wires and other source overlays remain identical. Apply last,
after LK1 daily-visit, discount and managed-entitlement overlays. Do not rebuild from a stale base.
The installer is local-only: it cannot deploy, import, restart or edit a live runtime.

At an authorized release use the repository live-workspace validation workflow and
`node-red-release-validation` skill first. Validate disk, runtime, editor, worker and topology;
this task intentionally did not import active flows or assert that the deployed path has changed.

Required server configuration (configure only during separately authorized rollout):

- `TOURNAMENT_OWNER_API_BASE`: trusted HTTPS CUP base including `/api`, no query/credentials/hash.
- `TOURNAMENT_OWNER_INTEGRATION_TOKEN`: existing CUP LK integration credential; server-only.

Gate before preaccept, managed entitlement reserve, provider create and daily-visit acquisition:
`POST /tournaments/:exercise/subscription-admission`, Bearer, original operation/subscription IDs.
The returned grant binds actor, exercise, subscription and request ID. A GET preview never grants
write authority. A confirmed booking calls `/subscription-admission/complete` with the service
credential, and CUP atomically transfers its hold to a participant. This is retryable; missing
completion evidence remains pending. Browser credentials alone cannot finalize that receipt.

Definitive refusal CASes only the exact PREPARED operation without dispatch, booking, visit or
entitlement markers, then reads it back. Only its matching daily guard is marked released; takeover
uses exact owner CAS. Crash after refusal, lost ACK and stale cleanup are recovered from durable
state. Timeout, unknown result, foreign guard and used entitlement are never treated as refusal.

## Local reproducible checks

```sh
node --test scripts/tests/tournamentAdmission.nodered.test.mjs scripts/tests/groupScheduleCheckout.test.mjs
node --test scripts/tests/lk1DailyVisit.test.mjs scripts/tests/subscriptionBookingReserveIngress.test.mjs
TEST_MONGODB_URI='mongodb://127.0.0.1:27138/?replicaSet=tournamentTask&retryWrites=true&w=majority' node scripts/tests/tournamentAdmission.mongo.test.mjs
npm run lint
npm run build
```

The Mongo test requires an explicitly supplied loopback replica set, creates a random synthetic
namespace and drops only that namespace. It executes the patched router against actual Mongo CAS,
including real daily-guard composition after ctx initialization. No provider network call occurs.
The full prod+dev build requires the established ignored `.env`/`.env.dev` configuration. Generated
bundles/manifests and local environment files are not committed. `nodered:modular:validate` requires
a separately prepared external live workspace; no such live workspace is claimed by this candidate.

## Provider requirement

For each mapped tournament, Viva must require an atomically consumed server-authenticated owner
grant on direct transactions with bookingRequests, subscription booking, widget and admin/import
admission. Grant binding: tenant/exercise/actor/full rule/operation/capacity hold; durable result
lookup by original key. No evidence of such a Viva restriction is available from these repositories.
Use a separately authorized provider fixture to prove denied direct writes and one allowed single,
composite/promo booking after timeout/restart. Keep P0 open until that evidence exists.
