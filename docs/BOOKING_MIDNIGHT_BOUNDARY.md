# Club closing boundary at Moscow midnight

Owner rule, 12 November 2026: clubs operate through 00:00. A court interval
ending exactly at the following Moscow midnight is valid closing-time geometry;
an interval ending after that boundary is not enabled by this change.

## Behavior and contracts

- `POST /lk/subscriptions/game-price-preview`, function **Subscription price
  preview router**: 60/90/120-minute NEW_GAME and EXISTING_GAME targets may reach
  exactly the next midnight. The existing identity, location, subscription,
  subservice and response checks remain mandatory. An overrun still returns
  `PRICE_PREVIEW_CROSS_DAY_UNRESOLVED` before the price read.
- Viva `/products/master-services/{id}/price` keeps `fromDate` equal to the
  start/service day, the original `fromTime`, and the ending `00:00` clock.
  No `toDate`, `24:00`, tariff guess, clipping to 23:59 or amount override is added.
- Legacy split CREATE preparation/router and prospective preflight use the
  following calendar date for the exact midnight ISO endpoint. Duration and the
  tariff/daily-limit service day remain bound to the original start. Conflict
  recovery must still match the exact room and both endpoints; it gains no new
  destructive custody or retries.
- Direct master-service promo/one-time filtering/payment and persisted game
  projections use the same following-day ISO endpoint, while the price request
  retains its existing start-day clock contract. Amount, payment method, retries,
  selected subscription and idempotency behavior are unchanged.
- The historical diagnostic-only PR350 composer deliberately retains its original
  refusal semantics. It is not the installer for this business change.

Touched source functions: `nodered_subscription_price_preview_nodes/router.js`,
`nodered_games_nodes/fn_split_create_prepare.js`, `fn_split_router.js`, and the
prospective preflight `split_start.js` / `finalize.js` fragments. The historical
preflight composer injects the source-derived date helper into both owning nodes.
No Node-RED flow JSON, import/export artifact, lifecycle, observer or schema is
regenerated or changed in this PR.

## Evidence and limits

Public, isolated source tests cover exact closing for all three durations,
NEW_GAME/EXISTING_GAME, ±1 ms, month/year/leap-day rollover, both supported clock
formats, positive CREATE endpoints, original price/service date and amounts,
conflict/preflight tampering, and actual client request construction. Every
provider/DB/network boundary is stubbed. Private exact-flow tests skip when their
fixture is absent. The original private PR350 source additionally verifies the
unchanged historical candidate function hash locally; private data stays outside Git.

Provider acceptance of a midnight quote or booking has not been exercised. This
is source/local/CI evidence, not production end-to-end acceptance. The separate
new game-create owner/preparation contract intentionally remains same-day and is
outside this legacy-flow correction; it must not be represented as midnight-ready.

Audience: users selecting closing-time slots in the existing LK flows. Observed
result: synthetic request construction and guards only, until an authorized
release and passive live evidence. Stop signal: a negative/reversed end interval,
changed price/service date, or incorrect conflict/preflight binding. Stop method:
do not merge/deploy the candidate; any later release must use a fresh private live
preimage and reviewed guarded contract. No real bookings, payments, business API
probes or production mutations are part of this implementation.
