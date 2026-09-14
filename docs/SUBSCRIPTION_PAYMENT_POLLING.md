# Subscription payment polling

Owner: LK backend. Audience: subscription checkout users and operations.
The checkout closes after20 minutes from the saved sale creation time OR10 admitted
checks, whichever occurs first. Boundary equality closes it. A missing/invalid creation
time fails closed. The original provider `expiresAt` and financial status are preserved.

`paymentPolling` stores `checks`, `status`, `deadlineAt`, `lastAttemptAt`, `nextCheckAt`,
`archivedAt`, `reason`, and separate `recoveryChecks`. Local `status: FAILED` means the
checkout link is archived; it is not a claim that Viva rejected the transaction.
The public response is `FAILED`, `archived: true`, `paymentUrl: null`. Confirmed `PAID`
(and paid instance-binding recovery) takes precedence. Cached nested payment URLs are
not returned for an archived checkout. Immutable transaction/payment identities remain.

The10th admission consumes the final attempt and archives locally before its request;
a confirmed payment from that attempt still succeeds. Failed requests and lost replies
consume the durable attempt. CAS (`findOneAndUpdate`, no upsert, returnDocument after)
checks the selected sale's status, transaction identity and polling preimage. Only an
acknowledged matching claim dispatches. A lost CAS, transport error or mismatched reply
never retries in the same request; foreground errors end with409/503. Cooldowns survive
Node-RED restart. They limit dispatch frequency; they are not an exactly-once provider
execution guarantee across arbitrarily long process pauses.

Archived records leave active polling. An hourly exact provider readback can settle a
late payment without opening a new checkout or resetting the active attempt count.
Binding/dispatch repair and pending history projections retain their existing financial
recovery logic and a120-second cooldown. History-watch metadata lives outside provider
`fact` and `localPreimage`; settlement and quota proof remain intact.

The query passes `[filter, {limit:60, sort:{paymentPolling.nextCheckAt:1,_id:1}}]` to
mongodb4. Standalone `msg.limit`/`msg.sort` are ignored by its adapter. Filtering on the
durable due time and updating it before dispatch rotates failed recoveries as well as
ordinary sales. Existing old records are archived gradually within the same bounded
worker. No bulk repair or collection-wide data write is part of this change.

Expansion caps the entire output at60 jobs, including at most20 history jobs (10 per
ledger). A new dispatcher holds one batch and emits one record per second. Overlapping
ticks do not enqueue another batch; unclaimed rows remain eligible in Mongo. The old
Split/Delay path is disconnected, and the candidate builder rejects extra incoming
edges that could keep it reachable. Node-RED clears function timers on close; startup
resets the dispatcher busy state.

Touched route: existing tournament subscription confirm, scheduled subscription
reconciliation, and atomic purchase replay response. The older `reconcile_router`
belongs to the disabled Media2 graph in the reviewed preimage. No endpoint is added.
Financial reservations/counters, provider credentials, product policy and sales flags
are not changed. Local archival does not release ambiguous annual reservations.

Sources: `scripts/lib/subscriptionPaymentPolling.mjs`, generated runtime copies via
`node scripts/sync_subscription_payment_polling.mjs`, source functions `poll_admit`,
`poll_ack`, `reconcile_dispatch`, `reconcile_query`, `reconcile_expand`,
`confirm_resolve`, `purchase_router`, and `piter_atomic_router`.
The generation manifest pins old and new function hashes; older release bindings stay
frozen. Deployment must include the whole reviewed graph, never only the functions:
confirm-resolve's fifth output requires the admission/CAS/error routes.

Local checks:

```sh
node --test scripts/tests/subscriptionPaymentPolling.test.mjs
PAYMENT_POLLING_TEST_MONGO_URI=mongodb://127.0.0.1:PORT node --test scripts/tests/subscriptionPaymentPolling.mongo.test.mjs
node scripts/sync_subscription_payment_polling.mjs --check
```

Candidate preparation uses a fresh verified private external workspace and creates only
local files:

```sh
npm run nodered:modular:pull-147 -- /absolute/new/private/live
node scripts/prepare_subscription_payment_polling_candidate.mjs /absolute/new/private/live /absolute/private-parent/candidate
```

The output contains candidate flow, exact graph contract and hash/count-only report.
Raw flow files must never enter Git or a PR. No merge, deployment, restart, provider
operation or production data mutation is authorized by preparing this candidate.

Stop signals after an independently authorized deployment: missing confirm responses,
claim errors, new provider/ledger mismatches, growing backlog or continued memory
restarts. Stop method: guarded exact-source rollback under the existing reviewed-flow
lease. Rollback restores flow code, not durable polling metadata; financial state is
untouched by local archival. The previous poller ignores the new metadata and resumes
its old high-volume polling, so rollback is a recovery measure, not a memory fix.
Observe RSS/heap slopes, restart intervals, confirm latency and Mongo errors separately;
passing local tests does not establish a production memory improvement.
