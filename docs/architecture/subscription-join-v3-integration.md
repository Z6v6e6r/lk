# Subscription JOIN v3: LK1 producer integration branch

Status: **integration branch only**. Merged `lk#431` into current `github/main`
(`dcd87b7b`) on `codex/join-lk431-integration-20261118`; nothing is installed,
published or activated.

## Evidence on this branch

- Merge of `lk#431` (`30b4da1d`) is clean against current main.
- Focused lifecycle/cancel suite: **145 pass / 0 fail** on the merged tree:
  `bookingPaymentAttempt.test.mjs`, `bookingPaymentAttempt.gateway.test.mjs`,
  `bookingPaymentAttempt.split.test.mjs`, `bookingPaymentCancellation.test.mjs`.
- The merge does not change v2 receiver routes or the owner gateway by itself.

## v3 producer shape (source-only target)

v3 reuses the existing v2 receiver admission/journal and the existing owner:

| Route                                                            | Producer work                                                                             | Existing owner                                                                                            |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `POST /lk/integrations/v3/booked-operation-preflights`           | Verify v3 delegation; return server quote + settlement bound by `requestSha256`           | CUP context/preflight + LK1 price preview; no write                                                       |
| `POST /lk/integrations/v3/booked-operation-admissions`           | Verify exact consent; durable ATTEMPTING marker; one dispatch                             | `/lk/subscription-bookings` with the existing managed JOIN path, returning checkout when `toPayMinor > 0` |
| `GET /lk/integrations/v3/booked-operations/:operationId`         | Read the same journal; return separate payment/booking/visit states and the bound receipt | No new write; receipt equals the owner result                                                             |
| `POST /lk/integrations/v3/booked-operations/:operationId/cancel` | Idempotent pending-payment cancel; never claims release without proof                     | Existing pending-payment cancellation from `lk#431` / canonical cleanup                                   |

Rules:

- No second checkout, no second refund/cancel mechanism, no second entitlement ledger.
- `operationId` and `quoteId` are echoed in every response; `requestSha256` binds the
  non-binding quote to the admission.
- `CONFIRMED` requires the receipt fields `receiptId, confirmedAt, bookingRef, usageRef?,
appliedRule, priceCharged{amountMinor,currency}, provider:VIVA`.
- A local TTL never releases a seat while the owner outcome is unknown; readback first.
- The v3 producer must be installed and its delegation key trusted before LK2 may send
  `amountMinor > 0`; until then LK2 keeps `GAME_PAYMENT_REQUIRED` for that case.

## Not done here

- No v3 function nodes or routes are added to the flow yet.
- No CUP globals, delegation key, receiver install, execution flag or live call.
- The exact public v3 JSON is frozen on the LK2 side in
  `packages/subscription-runtime-adapter/src/booked-operation-v3.ts`; the producer must
  validate the same keys before the graph is composed.

Installation remains a separate CRITICAL operation with a fresh live preimage, exact-graph
contract, backup and rollback.
