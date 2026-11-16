# Subscription checkout recovery — 16 November 2026

The reported purchase message is `ZERO_PENDING_MESSAGE`. A durable browser marker
prevents another purchase while the first result is uncertain. The separate support
message, `Support identity fields conflict`, indicates duplicate or crossed ownership
of an LK messenger identity; changing checkout state cannot resolve that conflict.

## Frontend correction

`createZeroPayment` previously retained its marker when checkout stopped between
writing local custody and invoking the purchase helper. No request had been sent,
but reopening the offer was blocked indefinitely. The correction tracks dispatch
and removes only this invocation's exact new markers before dispatch, while both
offer and account/product locks remain held. A changed/replacement marker survives.
Every error after invoking a purchase helper still retains custody.

## Guarded operational recovery

`scripts/reconcile_expired_subscription_checkouts.mjs` defaults to dry-run. It uses
the explicitly selected owning Mongo config, existing Node-RED service credentials,
fixed Viva endpoints and three concurrent provider reads. It never sends a payment,
refund, new transaction, subscription issuance or provider cancellation request.

Release requires all of:

- exact transaction, product, quantity, amount and original payment URL;
- one unanimous valid provider client UUID and an exact matching phone; any explicit
  local client ID must agree (phone-only purchases legitimately have `clientId: null`);
- `UNPAID`, the whole amount still payable, no deposit or discount, and one full
  `CARD_ONLINE` leg;
- card `REJECTED / EXPIRED`, expired payment window, no payment/refund/service/receipt
  or processing evidence;
- an approved complete dry-run plan, fresh prewrite provider observation, exact
  whole-document Mongo compare-and-swap, majority acknowledgement and postcheck.

Only `friendship` is enabled: the installed backend receipt and browser reset consumer
are explicitly bound to that counter. Other counters are held as `UNSUPPORTED_COUNTER`.
Age, a local failed state, a missing link or HTTP 404 never authorize release.

Evidence directories must be new, absolute and outside the repository. Directories
use mode `0700`; preimages, provider observations, plans and postchecks use `0600`.
Raw evidence contains personal/payment data and must never be added to Git. Keep
the full scan/preimage and both provider observations for any recovery investigation.
Do not blindly restore a released sale: first recheck current provider facts and the
exact operation receipt; restoration is a separate live action.

Example (paths, PID and config ID must be verified for the current target):

```sh
node scripts/reconcile_expired_subscription_checkouts.mjs \
  --flows /absolute/live/flows.json \
  --mongo-config-id VERIFIED_CONFIG_ID \
  --service-env-pid VERIFIED_NODE_RED_PID \
  --mongodb-module /absolute/node_modules/mongodb \
  --evidence-dir /absolute/new-private-dry-run

node scripts/reconcile_expired_subscription_checkouts.mjs \
  --flows /absolute/live/flows.json \
  --mongo-config-id VERIFIED_CONFIG_ID \
  --service-env-pid VERIFIED_NODE_RED_PID \
  --mongodb-module /absolute/node_modules/mongodb \
  --evidence-dir /absolute/new-private-apply \
  --apply --plan /absolute/new-private-dry-run/plan.json
```

The 16 November scan classified 2,694 pending sales: 68 eligible; 1,985 unsupported
counter; 637 without the exact closed-card proof; 3 not provider-unpaid; 1 owner
mismatch. These are operational categories, not counts of customers or unpaid debts.
All 68 eligible records were released with fresh provider checks and exact CAS;
the apply report recorded 68 successful updates and no CAS conflicts. No other
sale, payment, subscription, booking or chat record was modified.

## Support identity incident

A read-only Mongo audit found 108 duplicated LK user-identity groups and 215
duplicated identity fields among 3,450 LK messenger profiles. A group can contribute
both user and chat fields; these figures must not be described as 215 affected users.
The samples share a verified singleton phone and an exact LK pair, but that alone
does not authorize a bulk merge of the entire population.

The owning implementation is ph-admin `loadIngestIdentityOwner`. Its ownership
guard must remain intact. Before a data repair, inventory every duplicate's complete
phone/email/connector bindings and all dialog, message, metric and outbox references.
Resolve the canonical current profile, remap those references consistently, preserve
dialog station/access scope and message/outbox IDs and states, and prevent historical
message hydration from recreating removed profiles. Mixed phones, crossed identities,
incomplete history or multiple canonical candidates must remain held. Coordinate
persistent state with the live in-memory cache; deleting only Mongo profiles is not
a complete repair. No support merge, restart or guard relaxation was performed here.

## Validation and limits

The focused checkout/recovery suite passes, including pre-dispatch cleanup, retained
post-dispatch ambiguity, changed custody, foreign ownership, malformed provider facts
and exact receipt contracts. Runtime-config tests also pass. Full lint passes with
existing warnings. TypeScript and production bundles passed during the full build;
its combined dev phase ran out of local disk space. After removing only this task's
generated build outputs, the complete dev-bundle command passed. The affected
production storefront bundle also builds successfully.

Independent payment/reliability and auth/privacy reviews covered the operational
release and ownership/schema adaptation. No browser checkout with an affected
customer, new real purchase, paid settlement, chat acceptance or deployment of the
frontend correction is claimed.
