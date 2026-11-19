# Composite order: participation + residency in one payment (LK1)

Owner decisions (2026-11-17):

- One transition to payment → one payment for the full amount → both the participation and
  the residency are registered.
- Participation in the same order gets the residency discount.
- The CUP level decision taken at payment start stays valid until that payment finishes.

## Status for the 18.11 release

| Scenario                                                  | Status                                                                                    | Ships 18.11                |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------- |
| А — participation only (one-time)                         | READY in code and installed build; live acceptance not recorded                           | yes, as is                 |
| А — residency discount surcharge for an existing resident | PARTIAL: CUP and Node-RED flags off                                                       | no                         |
| Б — participation + residency                             | BLOCKED: planner and offer ready behind a flag; server checkout and Viva evidence missing | no                         |
| В — participation + subscription (trainings, tournaments) | PARTIAL: Viva-native widget purchase, bypasses server guards                              | already installed; not new |
| В — games                                                 | BLOCKED                                                                                   | no                         |
| Г — existing subscription + residency                     | BLOCKED: combination rule OD-01 open                                                      | no                         |
| Д — boost                                                 | BLOCKED: no product or rules (OD-11)                                                      | no                         |

Separate residency purchase (`/lk_new?buyResidency=1`) is unchanged.

## Pieces

| Piece                                                          | Where                                                           | State                            |
| -------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------- |
| Single-line money guards refuse composite transactions         | `scripts/tests/*Cancellation*`, `directCheckoutRecoveryBackend` | done (tests)                     |
| Planner: amounts, refusals, level snapshot                     | `src/residency/compositeResidencyOrder.ts`                      | done, flag off                   |
| Offer UI: consent, breakdown, already-resident                 | `src/residency/CompositeResidencyOffer.tsx`                     | done, flag off, not wired        |
| CUP accepts residency from a composite PAID transaction        | ph-admin `SUBSCRIPTIONS_RESIDENCY_COMPOSITE_LINES_ENABLED`      | Draft PR                         |
| CUP policy for a residency not yet bought (percent source, Б1) | ph-admin                                                        | missing                          |
| Server-side single Viva transaction from the plan (Б4)         | Node-RED, reuse `nodered_trial_group_nodes/checkout.js` pattern | missing; needs PROVIDER evidence |
| Wiring into group schedule and tournament signup               | `GroupSchedulePage.tsx`, tournament signup                      | missing                          |
| Owned-residency read: ACTIVE / NONE / UNKNOWN (read only)      | `src/residency/ownedResidencyRead.ts`, `ownedResidencyApi.ts`   | done, flag off (lk#459)          |

Owned-residency read: one fresh `GET …/subscriptions?includeFinished=true&size=1000`, bypassing
the subscription session snapshot. NONE needs a complete page, a product id on every row, no
live/pending/frozen residency and a read at most 60 s old; it is re-read on consent. Anything
else is UNKNOWN and refuses the sale. A row's name never proves residency.

## Viva questions to close before the server checkout (PROVIDER)

1. Does `POST /end-user/api/v1/{tenant}/transactions/preview` accept
   `[participation with bookingRequests, residency SUBSCRIPTION line]` and return one total?
2. Is a per-line `discountAmount` from the end-user API ignored or applied? If applied, a client
   can halve its own price, and only a server-side admin transaction is acceptable.
3. Does `GET /api/v1/transactions/{id}` read back both lines with `cost`, `discount` and
   `paymentDate`? CUP needs exactly this shape.
4. Does the residency subscription get issued (NEW/ACTIVE) from a multi-line PAID transaction?

The preview is read-only; the probe also counts the client's bookings before and after.

## E2E acceptance (test stand / synthetic client; real money only with explicit approval)

| #   | Steps                                                         | Expected                                                                                     |
| --- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| E1  | Paid group training, no residency, flag on, consent unchecked | Offer and amounts visible, pay button disabled                                               |
| E2  | Same, consent checked                                         | Participation at base − pct, residency at the fresh Viva price, one total                    |
| E3  | Pay                                                           | One Viva transaction with two lines; booking created; residency NEW/ACTIVE                   |
| E4  | Refresh residency in CUP after E3                             | Eligible; window = paymentDate + 30 days; purchase amount = residency line                   |
| E5  | Book a second training                                        | Residency discount applied from the purchase in E3                                           |
| E6  | Client already has active residency                           | No offer; "already resident" note; single-product checkout only                              |
| E7  | Residency read fails or times out                             | No offer (fail closed); participation-only checkout works                                    |
| E8  | Residency price changed in Viva while the screen is open      | Plan older than 60 s refused; new price shown                                                |
| E9  | Tournament, level enforced and not allowed                    | No payment starts                                                                            |
| E10 | Tournament, rule changes after payment started                | Paid participation kept; no second charge                                                    |
| E11 | Payment abandoned / card rejected                             | Seat and residency are not issued; unpaid cancellation never touches a composite transaction |
| E12 | Refund of either line (manual, OD-05)                         | CUP denies residency for the whole transaction                                               |
| E13 | Double click / two tabs                                       | One transaction (operation id), no duplicate booking                                         |

## Open decisions

- OD-01: combining residency with an existing subscription (scenario Г).
- OD-04 remainder: seat hold TTL and partial success (booking created, payment failed).
- OD-11: boost product and rules (scenario Д).
- Whether a refund of the participation line alone should keep the residency (today: no).

## First purchase from the group schedule: server quote (lk#463)

Behind `VITE_LK1_COMPOSITE_RESIDENCY_ENABLED`, the schedule asks
`POST /lk/subscriptions/game-price-preview` with
`{ target: { targetKind: "GROUP_TRAINING_RESIDENCY_PURCHASE", exerciseId } }` and renders
`residencyPurchaseQuote` as is: training price, discount, residency price, total
(`src/residency/residencyPurchaseQuote.ts`). The client sends no amounts. It refuses a quote
for another exercise, one whose numbers do not add up, or one past `expiresAt`. Expiry is
measured locally from the request time (`expiresAt - serverTimeMs`).

- A change of training aborts the request in flight and drops the old answer and consent.
- Clicking consent fetches a second server quote. Consent remains only if the exercise,
  products, published policy and all amounts still match. If any term changed, the new
  amount appears unchecked and needs fresh consent. On expiry the quote and consent are
  dropped and a fresh quote is requested before the player can agree again: three times
  automatically, then by the "Обновить цену" button.
- An owned residency (`ownedResidencyRead` ACTIVE) shows "уже резидент" instead of a quote.
- The pay button stays disabled until the single composite payment exists (lk#458).

The opened training survives a host page that keeps passing `data.exerciseId`:
`groupExerciseId` in the URL is written only by the widget and wins on mount
(`resolveGroupScheduleInitialSelection`).

## Server quote and order rehearsal (19 November)

The checkout takes its trusted price from the `residencyPurchaseQuote` response in
#457 (`POST /lk/subscriptions/game-price-preview`, target kind
`GROUP_TRAINING_RESIDENCY_PURCHASE`). The authenticated server resolves the Viva
exercise, one-time tariff, residency product and ownership, then asks CUP for the
published rule for that exercise. Checkout accepts the client's displayed terms only
after comparing them with a fresh quote for the same actor and exercise.

Example from the isolated test using the amounts reported in #457:

| Amount | Minor units | RUB |
| --- | ---: | ---: |
| Participation before discount | 550000 | 5,500 |
| CUP discount (50%) | 275000 | 2,750 |
| Participation after discount | 275000 | 2,750 |
| Residency | 79000 | 790 |
| Agreed total | 354000 | 3,540 |

`scripts/lib/compositeResidencyCheckout.mjs` re-reads the sources for a new attempt and
compares the accepted quote, including the publication digest. It persists the exact price,
lesson and operation ID before dispatch. MongoDB's unique `_id` protects the tenant,
authenticated client and operation ID tuple. An unchanged repeat reopens the saved order.
After a lost provider response it performs readback by the original reference and validates
the actor, lesson, amounts and both lines before it records the provider order ID. A
missing or conflicting readback leaves the same operation pending. The replay path never
issues another create. If the quote expires while MongoDB confirms the insert, the owner
records `EXPIRED_BEFORE_DISPATCH`. A process crash or lost Mongo ACK before the first
provider call can leave a pending operation that needs reconciliation. Start the local
rehearsal with:

```sh
node --experimental-strip-types --test scripts/tests/compositeResidencyCheckout.test.mjs
```

Viva preview v1/v2 returned 400 for the two-line service plus subscription request in #458.
The server defaults to `VIVA_COMPOSITE_FORMAT_UNAVAILABLE` for a new checkout. The tested
adapter is isolated. It commits one synthetic order and drops the reply, then returns the
same order on recovery. Enabling Viva still requires a verified single-transaction create
and readback-by-reference contract, replay protection across concurrent distinct attempts,
and end-to-end payment/activation acceptance.
