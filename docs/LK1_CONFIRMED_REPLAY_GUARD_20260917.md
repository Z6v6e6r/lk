# Confirmed subscription replay guard (2026-09-17)

## Incident

Client `+7 913 744-32-40` (`24dda8e0-6a68-4b30-a151-2c9ee2ede4ec`, annual ХАБ
`db7a5250-7369-4f43-8ac5-9111be24bc74`) joined the open game
`pay_66a6b649-14b2-4a99-a415-d2ed3827fff4` (2026-09-22 08:30, Корт №4, Терехово) by
subscription on 2026-09-16 17:57 MSK. The claim `lk-split-join-15a9jcs1x7jvc0` was
confirmed and Viva created booking `a803ae5e-…` with a 700 ₽ remainder (transaction
`7135e337-…`, payment window until 18:17).

The player did not pay in time. At 18:28 the split participant payment-timeout cleanup
(`SPLIT_PARTICIPANT_TIMEOUT_CLEANUP_APPLIED`, `reason: PAYMENT_TIMEOUT`) cancelled the Viva
booking and expired the split payment, but the daily claim stayed `CONFIRMED` with the dead
`bookingId`. The widget repeats the same deterministic operation id
(`lk-split-join-<hash>` is derived from client, game, phone and subscription), so every
repeat replayed the dead claim and the player saw
`Временная техническая ошибка. Не удалось подтвердить условия подписки: Сервер не подтвердил
результат применения подписки. Повторите попытку; неизвестное состояние не даёт скидку.`
(nginx: `POST …/split/join` → 200, 636 bytes, at 20:10 and 22:28 MSK).

Two independent defects:

1. **Data**: the timeout cleanup never releases the subscription claim, so the seat and the
   free minutes stay consumed. A read-only scan found 13 `CONFIRMED` claims (of 400 most
   recently updated games with an expired participant slot) whose Viva booking is gone,
   including several created the same day.
2. **Contract**: the ingress replay of a `CONFIRMED` claim returned 200 with
   `settlementState`/`selectedPaymentMode` only. The widget validates a replay with
   `hasDeterministicSubscriptionDecision`, which for a paid replay also requires
   `paymentRef`, `mode` (`create`/`join`) and `gameId`; the payload had none, so the reply
   was rejected as an unknown state. The same replay also never asked the provider whether
   the booking still exists, so a valid-looking replay would have sent the player to pay for
   a cancelled booking.

## Change

| artifact | change |
| --- | --- |
| `scripts/lib/hungClaimRelease.mjs`, `scripts/reconcile_hung_subscription_claims.mjs` | opt-in `--include-confirmed` class: a `CONFIRMED` claim older than `--ttl-minutes` is released by the same provider-verified compare-and-swap only when a complete per-exercise readback shows the exact bound row cancelled (`EXACT_CANCELLED_BOOKING`) or no longer lists it while holding no live booking of this actor and subscription (`BOUND_BOOKING_ABSENT`). Without the flag the claim stays `STATE_TERMINAL`. |
| `lk_subscription_booking_router_20260804.func` (gateway) | an ingress replay of a `CONFIRMED` claim now reads `GET /api/v1/exercises/{exerciseId}/bookings?showCancelled=true&size=200` first. A live bound row keeps the ordinary replay; a cancelled row, or a complete page without the bound row and without a live booking of this actor and subscription, releases the claim (`state: RELEASED`, `releaseReason: CONFIRMED_BOOKING_GONE`, CAS on `_id + operationId + state + bookingId + lk1.fingerprint + updatedAt`) and answers 409 `SUBSCRIPTION_BOOKING_CONFIRMED_ORPHAN_RELEASED`. Unverified evidence and a live neighbour answer 202 pending; a lost CAS answers `LK1_CONFIRMED_ORPHAN_RELEASE_CONFLICT`. |
| `lk_subscription_booking_finalize_20260804.func` (finalizer) | the ingress replay response now carries `toPayMinor`/`toPay`, `transactionId`, `paymentUrl`, `settlementState`, `selectedPaymentMode` **and** `mode`, `paymentRef`, `gameId`, `exerciseId`, so a live unpaid replay passes the widget contract and the player can resume the stored checkout. |

Sources of truth: `scripts/nodered_lk1_hub_nodes/gateway.js` and
`scripts/nodered_lk1_hub_nodes/finalize.js` carry the same fragments; the installer for the
current live generation is `scripts/patch_live_lk1_confirmed_replay_guard_hotfix.mjs`
(pinned to the 2026-09-17 pull, whole-flow `90fb9821…`, 4804 nodes).

## Candidate

```sh
npm run nodered:modular:pull-147 -- /private/tmp/lk1-confirmed-replay-live
npm run nodered:modular:verify -- --workspace /private/tmp/lk1-confirmed-replay-live
node scripts/patch_live_lk1_confirmed_replay_guard_hotfix.mjs \
  --workspace /private/tmp/lk1-confirmed-replay-live \
  --output /private/tmp/lk1-confirmed-replay-out/candidate.flow.json \
  --report /private/tmp/lk1-confirmed-replay-out/report.json
```

Report: 2 changed nodes, 0 additions, `topologyChanged: false`, `routesChanged: false`,
candidate sha256 `96e5e6e3d52f0c0b427b71097f893f9d5fba752e12a22d10bb9a6f0fce7e8c56`;
gateway func `2c8bfbe7…` → `55f748d0…`, finalizer func `72f575fc…` → `2b115412…`.
The patched bodies must still pass the exact-graph contract before any install; the install
itself is a separate owner-approved operation (no deployment, import or restart here).

## Checks

- `node --test scripts/tests/lk1ConfirmedReplayGuard.test.mjs` — delta pins, fail-closed
  preimage gates, agreement with the reviewed sources, and the behavioural verdict of the
  patched live bodies (provider check first, live replay with money evidence, release on
  cancelled/deleted booking, pending on unverifiable evidence, 409/CAS-conflict acks,
  finalizer intent and money fields).
- `node --test scripts/tests/hungClaimRelease.test.mjs` — the confirmed class stays opt-in
  and every guard keeps its own reason.
- `node --experimental-strip-types --test scripts/tests/subscriptionBookingGateway.nodered.test.ts`
  — 81 pass / 1 skip (unchanged).
- `node --test scripts/tests/subscriptionRejoinGateway.test.mjs
  scripts/tests/subscriptionRejoinPatch.test.mjs scripts/tests/eventPaymentRoutesUpgrade.test.mjs
  scripts/tests/lk1PlanMoneyFirstUseHotfix.test.mjs scripts/tests/lk1FreeFirstEventHotfix.test.mjs`
  — all pass except the pre-existing `CLI refuses raw flow export inside Git`, which fails
  only because this checkout lives in a path containing a space (`%20` breaks its
  `new URL(...).pathname` fixture), not because of this change.
- `npm run nodered:modular:validate` cannot run here: it needs a built modular workspace
  (`build/`) and regenerating the modular source is quarantined.

## Residual

- Releasing the local claim does not cancel or refund the provider transaction; the stored
  `lk1.checkout` stays in the document so the operator can reconcile the money leg.
- The widget in production (bundle `20260916T103304Z`) has no rejoin support, so after a
  release it cannot advance to a new operation id by itself. Server-side this change makes
  the state consistent and the message truthful; self-service recovery needs the frontend
  rejoin release (`src/utils/subscriptionRejoin.ts`, already on `main`).
- A released `lk-split-create-*` operation has no rejoin successor (the rejoin identity
  helper only matches `lk-split-join-*`); a released organizer create stays pending until
  the frontend rejoin covers create as well.
