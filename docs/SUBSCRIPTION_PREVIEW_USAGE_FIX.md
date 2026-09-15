# Subscription preview: cross-date allowance validation

The installed `/lk/subscriptions/game-price-preview` router reads all HUB
operations for the authenticated actor. Its embedded allowance validator still
rejects any operation whose date differs from the selected slot. Consequently,
valid historical operations can stop the whole batch with
`LK1_ALLOWANCE_RECORD_INVALID`, including quotes for other subscription instances.

`scripts/patch_nodered_subscription_preview_usage.mjs` constructs a local candidate
for the exact router preimage `62ed17c93f6bef08877e3a8b02f93f2dc17ad293ae81768bffdb1e97fc1bd5df`.
Only `func` on `lk_subscription_price_preview_20260908_router` changes. The patch
reuses `patchPaidBenefitUsage` and exports its existing date validator to the
embedded usage function. The historical paid-join composer stays unchanged.

The resulting rules match the current booking gateway:

- Validate actor, tenant, date, decision shape and subscription identity before filtering.
- Exclude other subscriptions and released/failed operations.
- Collect benefit booking IDs across dates, so active paid-benefit bookings count toward the cap.
- Count free minutes and provider deduplication only for the selected date.

The Mongo query, authentication, routes, wires, evaluator, create/payment paths,
and persisted records remain unchanged. Malformed or ambiguous evidence still
fails closed. This repairs advisory preview; it is not activation of the entire
managed-subscription graph.

## Verification

```sh
node --test scripts/tests/subscriptionPreviewUsagePatch.test.mjs
LK_PREVIEW_USAGE_FLOW_FIXTURE=/absolute/private/source.flow.json \
  node --test scripts/tests/subscriptionPreviewUsagePatch.test.mjs
```

The first command uses tracked helpers and synthetic inputs. The second also
checks the exact private function and full graph contract, inverse contract,
unchanged nodes and rejection of repeat/drift. Both exercise cross-date allowance,
three/four active paid-benefit bookings, instance isolation, released/failed
operations, invalid records and same-day provider deduplication. Raw live flows
and customer records must remain outside Git. Neither command makes network calls.

## Release boundary

Owner: PadlHub LK backend. Audience: users requesting subscription price previews.
The frontend DEV channel currently reaches the shared backend; a DEV static release
does not authorize changing that backend. This module performs no deployment.
Before an authorized apply, obtain a fresh private live preimage, verify the running
revision and reviewed topology, rebuild and review the exact contract, and follow
the existing lease, backup, postcheck and guarded rollback procedure.

After apply, require an authenticated response for the same slot, valid quote
bindings and readback of unchanged operation state. Stop on failed quotes,
wrong counters, flow/revision drift or degraded API health; use the approved exact
rollback path, never a broad import or unguarded restart. Source tests cannot prove
the observed HTTP error body, successful live preview, bookings or payments.
