# Subscription audit corrections

Owner: PadlHub LK. Audience: subscription booking and event checkout users.
This change addresses the seven findings from the 15 September audit. It changes
source and constructs a local reviewed candidate; it does not deploy, reconcile
stored operations, or execute bookings/payments.

| Finding | Correction | Regression evidence |
|---|---|---|
| F1 cross-date preview | Validate all operation dates, keep daily minutes separate from cross-date benefit bindings | Historical operation no longer rejects the complete event quote; malformed evidence still rejects |
| F2 active paid benefits | Gateway reads bindings across dates and counts unique active provider booking IDs belonging to the selected subscription | Four ON_PLACE bindings count four; other instances do not contribute |
| F3 service date | Offset timestamps are converted to Europe/Moscow; local calendar/time stays Moscow | UTC/+03/-04 midnight equivalence, invalid dates/times; purchase-date normalizer unchanged |
| F4 leave read | Reject error, non-array and malformed array members before treating a query as empty | Unavailable reads return RETRY_REQUIRED; valid empty lookup preserves NOT_APPLICABLE |
| F5 checkout identity | Cache key includes a digest of account/session identity, exercise and fresh server booking ID; old unbound entries are discarded and logout clears cache | Other account/session/event/booking cannot recover the link; same-session token refresh can |
| F6 checkout expiry | No invented expiry on cache recovery; expired/invalid links cannot enable or execute payment | Exact expiry boundary, missing deadline, unsafe URL, click-time check and UI expiry timer |
| F7 bound pending usage | Deduplicate an upstream-only FREE claim against one matching provider SUBSCRIPTION booking | One FREE60 claim + its booking remains60; conflicting IDs, owner, instance, exercise, date, duration or duplicate evidence fails closed |

F7 is deliberately conservative: missing provider evidence retains the reservation;
paid/mixed ambiguity is not turned into a confirmed binding. Provider duration must
equal the reserved free minutes and fit the policy's daily allowance. Neither the
claim state nor its stored booking ID is repaired. Five previously unresolved claims
are outside this code change.

## Exact backend candidate

`scripts/patch_nodered_subscription_audit_fixes.mjs` exports the pure
`composeSubscriptionAuditFixes(liveBytes, deploymentId)` function. It accepts only
the reviewed function preimages and changes `func` on these existing nodes:

- `lk_subscription_booking_router_20260804` — `POST /lk/subscription-bookings`
  and its split create/join callers: usage/date computation and read query only.
- `lk_subscription_price_preview_20260908_router` —
  `POST /lk/subscriptions/game-price-preview`: identical usage/date computation.
- `lk_split_leave_daily_limit_route_20260811` — split leave claim-read validation.

Node IDs, routes, wires, credentials/configuration, policy values, evaluator,
payment/create/recovery writes and all other nodes are preserved. The full graph
contract rejects unexpected changes and supports an exact inverse contract.
Historical paid-JOIN/visit-worker composers are not used to import unrelated changes.
The separate preview-only candidate from `SUBSCRIPTION_PREVIEW_USAGE_FIX.md` is
included in this combined successor; it is not an additional deployment step.

Current tracked gateway, base service-date helper and leave source are synchronized
with the relevant pure transforms. The historical unified candidate records the
new base-router source hash as an UNBOUND amendment; its frozen candidate hashes
and activation prohibition are unchanged. Private flow bytes and customer records must
remain outside Git and logs. The composer performs no transport or deployment.

## Checks

```sh
node --test scripts/tests/subscriptionAuditFixes.test.mjs scripts/tests/tournamentPendingPayment.test.mjs
LK_SUBSCRIPTION_AUDIT_FLOW_FIXTURE=/absolute/private/source.flow.json \
LK_PREVIEW_USAGE_FLOW_FIXTURE=/absolute/private/source.flow.json \
  node --test scripts/tests/subscriptionAuditFixes.test.mjs scripts/tests/tournamentPendingPayment.test.mjs
```

The private run exercises the full successor gateway, extracted preview usage,
the full event-preview entry/router/evaluator path with synthetic GET DTOs,
leave routing, exact graph preservation and inverse. HTTP/Mongo output messages
are intercepted, never sent. Without the private file, exact-live checks are
explicitly skipped. Both new suites run in the existing exact-head CI matrix.

Frontend cache is advisory and can only supplement a fresh pending booking with
the same identity. JWT session fields partition cache but are not an authorization
decision. For opaque token rotation, continuity cannot be proven: recovery falls
back to the fresh server response. No tokens are persisted by this cache.

## Release and remaining evidence

The DEV frontend uses a shared backend. A future installation requires fresh
preimage/runtime revision verification, reviewed source/head, lock/lease, backup,
exact postcheck and the established guarded rollback. Stop on graph drift,
incorrect quote/counter, unexpected writes or degraded API/Mongo health.
Do not deploy the old browser preview draft or perform a broad flow import.

Local/CI results do not close the 47-case real E2E matrix. Real provider amounts,
booking/cancellation/refund effects, concurrent requests and midnight roundtrips
remain separate acceptance checks. Event archive/late-payment lifecycle gaps
identified by the audit are not silently represented as fixed by these seven
corrections. No real records are mutated by the tests.
