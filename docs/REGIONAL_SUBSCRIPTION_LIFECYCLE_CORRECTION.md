# Piter/HUB annual subscription lifecycle correction

## Scope and safety boundary

This runbook covers the annual `piter_friendship` and `network_friendship`
storefronts. It does not authorize a Viva product edit, refund, reissue,
subscription mutation, CUP publication, runtime flag change, Node-RED import or
deployment.

The required business lifecycle is:

- activate on the first provider-confirmed booking;
- otherwise activate on `2026-10-01` in `Europe/Moscow`;
- count 365 validity days from the actual activation.

## Read-only production finding

The read-back performed on 2026-08-21 established:

- both Piter and HUB product cards exist and have exact UUID matches;
- both products report `activationDays=0`, `validityDays=365`, `visits=365`;
- one Piter sale is provider-paid at `1_980_000` minor RUB;
- its client subscription is already `ACTIVE`, has zero bookings and retains
  `365/365` visits;
- Viva reports auto activation on 2026-08-20 and expiration on 2027-08-20;
- HUB has no paid sale and therefore no client subscription instance to map.

The client and transaction identities remain outside Git. The read-back matched
the paid sale by exact product and transaction, while reports contain only
sanitized hashes and provider-instance evidence.

## Future-sale guard

Before `POST /api/v1/transactions`, the server must inspect the exact selected
Viva product returned by the authenticated product list. Piter and HUB checkout
is allowed only when all conditions are true:

1. `productType` is exactly `SUBSCRIPTION`;
2. `activationDays`, `validityDays` and `visits` are JSON integers;
3. `validityDays=365` and `visits=365`;
4. `purchaseDate(Europe/Moscow)` is not later than `2026-10-01`;
5. `purchaseDate(Europe/Moscow) + activationDays` is not earlier than
   `2026-10-01`;
6. the existing exact product, price and discount checks also pass.

Missing, string-coerced or early-activation fields fail closed with
`REGIONAL_SUBSCRIPTION_PROVIDER_LIFECYCLE_INCOMPATIBLE`. A later provider
activation deadline is allowed because the immutable CUP lifecycle is designed
to perform the earlier transition on the first confirmed booking or on 1
October. No Viva
transaction is created for an incompatible product. Successful preflight fields
are copied into the local reservation row so the later payment read-back can
prove which lifecycle was sold.

The guard does not choose or mutate `activationDays`. A value that projects an
earlier date fails closed. A later provider deadline is only a safety window;
it does not replace the CUP transition on first use or the fixed-date worker.
Those runtime gates still require a controlled NEW-subscription canary proving
that a first booking activates the provider instance.

## Read-only sales drift audit

The regional sales audit consumes explicit local JSON exports only. It does not
read Node-RED credentials, call Viva or MongoDB, write a report file, or expose
an apply mode:

```bash
npm run subscriptions:audit-regional-sales -- \
  --provider-file /absolute/path/viva-transactions.json \
  --ledger-file /absolute/path/lk-sales.json \
  --counter-key piter_friendship \
  --product-id <exact-viva-product-id> \
  --inventory-id piter_friendship_12m_2026_v1 \
  --batch-size 100 \
  --total-limit 400
```

The JSON result contains counts and truncated SHA-256 identifiers only. Any
missing ledger rows remain a review plan; this command cannot mutate either
system. A live exact reconciliation still requires a separately obtained safe
Viva export and a separate approval for every later mutation.

## Existing Piter instance: dry-run decision

The current instance cannot be represented as `PENDING_ACTIVATION`: provider
truth already says `ACTIVE` and fixes the expiration to 2027-08-20. Falsifying
it as pending would break reconciliation and could grant a second 365-day term.

The Admin OpenAPI exposes activation, expiration update and refund operations,
but no reviewed transition from `ACTIVE` back to `NEW`. Therefore the preferred
correction is provider-supported reset/reissue, not an invented API call.

### Preferred path: provider-supported reset or reissue

1. Keep the instance out of CUP runtime and retain the sanitized paid/read-back
   evidence.
2. Confirm the supported Viva UI/support operation and its accounting effect.
3. Capture a fresh exact GET immediately before mutation.
4. Perform exactly one approved mutation. If the response is lost, do not retry;
   recover by exact client-subscription lookup.
5. Preserve the paid amount, receipt/transaction link and one-subscription-per-
   client invariant. Do not silently create a second paid entitlement.
6. Require read-back of a single replacement in `NEW`, matching the exact
   product/client, with provider auto activation exactly on 2026-10-01.
7. Only then create a CUP `PENDING_ACTIVATION` instance pinned to the published
   policy digest and verified provider mapping.

### Fallback path: explicit grandfathering

If Viva cannot reset or reissue without financial side effects, the existing
instance may only be represented as `ACTIVE` with its real 2026-08-20 through
2027-08-20 period. This is a business exception, not the requested October
lifecycle. It requires separate approval, an explicit exception/audit record
and must not share a `PENDING_ACTIVATION` instance with the standard policy.

## Required canary sequence

1. Read back the changed product and prove the lifecycle guard accepts it.
2. Create one separately approved synthetic/controlled purchase; do not reuse a
   real client without explicit authorization.
3. Prove the new client subscription remains `NEW` before its first booking.
4. Create one booking and read it back by exact provider booking ID.
5. Prove Viva and CUP each transition exactly once to `ACTIVE` and share the
   same activation period.
6. Force a CUP-unavailable retry and prove no second Viva booking is created.
7. Keep the fixed-date worker disabled until the first-use canary is complete.
8. Run the deadline canary separately with provider evidence current at or after
   `2026-09-30T21:00:00.000Z`.

## Gate order

1. isolated code checkpoint and user verification;
2. integration into local `main`;
3. push and CI;
4. LK/Node-RED deploy with the guard active;
5. separately approved Viva product mutation and read-back;
6. provider mapping and policy publication;
7. instance creation/reconciliation;
8. first-use activation enablement;
9. fixed-date worker enablement.

Approval of one gate does not authorize the next.
