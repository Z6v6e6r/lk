# Residency discounts in the server booking owner

Owner: LK1 subscription booking/payment owner. Audience: holders of Viva product
`4037a3a3-e551-4f9a-a9db-1410e46b8635` across all stations. Outcome: a game costs
70% and group training 50% of the verified ordinary tariff, for the published
30-day residency interval. There are no free minutes, free visits or visit decrements.

This source change is paired with CUP's residency publication adapter and
`POST /api/internal/subscriptions/residency-booking-refresh`. It does not activate
the product or change production. Existing unrelated subscription rules and payment
owners are preserved. New station scope is the explicit published `allStations`
wildcard; no local list of studios can silently narrow the benefit. Event selectors
remain bound to the reviewed canonical dictionary of the publication.

## Server evidence and pricing

The exact server-resolved product enters the residency branch independently of
`subscriptions_lk1_plan_rules`. A matching name or an added UUID in that table
cannot grant residency. The branch requires authenticated CUP proof of the exact
mapping/publication, the owned active instance, PURCHASE/30-day dates and freshness.
The explicit refresh verifies the real owned Viva instance, linked paid transaction
and exact product card, then records a fenced provider observation in CUP.
The response has a supported capability digest and at most 30 seconds validity,
also limited by the underlying evidence deadlines.

The gateway fetches the context during target resolution and again during the
prewrite recheck. Its fingerprint binds the policy digest, publication, mapping,
client subscription, instance and validity interval. This immutable binding is stored in
the quote; replay never needs an expired CUP envelope or an enabled admission flag. The immediate booking guard
rechecks that proof and the same fingerprint. A stale response, changed rule/price,
unsupported target, missing flag or unavailable CUP refuses the operation; it
cannot become legacy or free-visit redemption.

Residency uses a fresh general owned-subscription read, including for split games:
Viva can omit a discount-only product from `availableClientSubscriptions` because
it has no visits. This does not relax actor/product/instance or ACTIVE/expiry checks.
The actual tariff still comes from the existing authenticated server tariff path.
The ordinary paid booking/transaction owner persists the amount, creates an
`ON_PLACE` booking without `clientSubscriptionId`, verifies provider readback and
recovers the same operation after a lost response. The change adds no parallel
payment engine. Normal rounding remains `base - floor(base * discount / 100)`.

Advisory preview uses the same CUP parser and bound server target. It accepts zero
visits, never authorizes a booking, and expires no later than the proof. It makes
only GET reads against Viva; the explicitly named CUP refresh records a verified
provider observation without creating a booking, payment or visit decrement.

## Source-driven candidate

The dedicated composer changes four function bodies: subscription booking router,
booking evaluator, price-preview router and preview evaluator. It preserves all
node IDs, wires, routes, credentials, initialization and unrelated configuration.
Historical wide HUB builders and source pins are unchanged. Function preimage checks
and graph preservation do not establish HTTP/Mongo wiring readiness; deployment
requires the existing exact-graph release review and fresh target verification.

Obtain a fresh private live workspace using the existing read-only workflow, then:

```
node scripts/patch_nodered_residency_booking.mjs \
  --workspace /private/tmp/fresh-live-workspace \
  --output-dir /private/tmp/new-residency-candidate
```

The tool verifies provenance/freshness and exact reviewed function preimages. It
writes a private candidate/report only; it never imports, deploys or enables flags.
Keep raw flows and candidates outside the repository. Drift requires review of
the new source; never overwrite preimage hashes merely to pass a check.

The default-off flag is `subscriptions_residency_booking_enabled`. Transport also
requires the existing PROD runtime environment, exact CUP origin and protected
runtime-context integration token. The preview cannot send that token to another
origin or follow redirects. Provisioning any runtime values is an operational step.

Stop signal: missing/expired evidence, unsupported capability, changed fingerprint,
wrong target/price, or ambiguous provider outcome. Stop new residency admission by
disabling its flag; preserve ordinary operation/readback recovery for in-flight
bookings. Disabling does not undo prior bookings/payments. CUP publication must
remain disabled until the paired compatible readers/consumer are installed.

Tests cover 60/90/120-minute games and group prices, minor-unit rounding, zero
visits, wildcard stations, malformed/foreign/frozen/expired evidence, target scope,
transport isolation, advisory behavior and private-snapshot graph preservation.
Private live-snapshot tests skip in CI without a private fixture. They use mocked
I/O locally and never make provider writes. Production acceptance, real dictionary
and Viva evidence, publication and activation are not claimed by these tests.

## Refresh transport and the installed flow

The shared residency reader takes the four existing global keys first. Only
undefined/null values may fall back to these four process/flow environment keys:

- `SUBSCRIPTIONS_RESIDENCY_BOOKING_ENABLED`
- `SUBSCRIPTIONS_RUNTIME_ENVIRONMENT` (`PROD`)
- `SUBSCRIPTIONS_RUNTIME_API_BASE_URL` (`https://padlhub.su/api`)
- `SUBSCRIPTIONS_RUNTIME_CONTEXT_INTEGRATION_TOKEN`

Explicit global false/empty/invalid values remain denials. Generic managed-product
readers and payment/replay ownership do not gain an environment fallback. Check the
fresh flow for per-flow/subflow environment overrides before relying on process
configuration. Keep the shared token in protected configuration, never flow JSON.

For an already installed residency flow, use
`node scripts/patch_nodered_residency_refresh.mjs --workspace /private/fresh-live --output-dir /private/new-candidate`.
It requires the four reviewed installed function preimages, preserves the graph and
configuration, updates the explicit refresh route and residency-only reader, and
never deploys or enables a flag. The original first-install composer remains for
its original source generation. Source drift requires review, not changed pins.

CUP bounds source reads plus persistence to eight seconds, inside the ten-second
HTTP timeout. Each preview and prewrite refreshes source evidence; failures refuse
new work. Stable CONFIRMED/PENDING replay still precedes provider refresh and
admission checks. Local private-snapshot tests exercise the actual updated gateway,
zero visits, 30/50 prices, immutable binding, prewrite drift and flag-off replay.
