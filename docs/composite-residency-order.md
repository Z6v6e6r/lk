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
