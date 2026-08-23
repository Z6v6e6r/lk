# Piter split payment: 250 RUB per participant-hour

## Policy contract

- Policy ID: `piter-split-250-per-hour-v1`
- Station ID: `1ea77cbf-bc36-49a1-96d6-f35c216a409b`
- Pricing mode: `PER_PARTICIPANT_HOUR`
- Currency: `RUB`
- Four-player rate: `250` RUB per participant-hour
- Two-team rate: `500` RUB per team-hour
- Full-game payment source: the Viva slot/product price; this policy must never override it
- Create resolves the active CUP campaign for both one-time and subscription organizer payment, canonicalizes the share server-side and stores the normalized policy snapshot in the game
- A one-time organizer freezes the snapshot against the confirmed organizer transaction; a subscription organizer has no paid transaction, so participant join re-resolves the exact stored game date/station/room and validates any stored snapshot against the active CUP policy
- Legacy subscription-created games without a snapshot may adopt only the campaign selected by CUP for their exact stored game date/station/room; browser metadata alone is never pricing authority
- A malformed non-null stored snapshot fails closed before token, room, booking, product or transaction requests

Expected participant charge:

| Duration | Charge |
| --- | ---: |
| 60 minutes | 250 RUB |
| 90 minutes | 375 RUB |
| 120 minutes | 500 RUB |

## Activation

1. Deploy the additive CUP contract and admin UI while the Piter campaign remains disabled.
2. Deploy the Node-RED enforcement that resolves the policy and verifies the exact Viva `studioId/roomId` binding before any Viva mutation.
3. Deploy the DEV games bundle and verify the full matrix below.
4. Read the current CUP admin snapshot. Update one campaign in that snapshot; do not send a blind replacement payload because the PATCH replaces the complete two-campaign list.
5. Configure the Piter campaign with the exact station ID, empty station-name and room filters, the versioned policy ID, rates above, and explicit `activeFrom` / `expiresAt` game-date boundaries.
6. Enable the campaign only after the CUP response includes `selectedPromoId=piter-split-250-per-hour-v1` for Piter and `enabled=false` for a non-Piter station.

## Verification matrix

- Piter, 60/90/120 minutes: 250/375/500 RUB in the UI and in the server payment response.
- A modified browser `shareAmount`, `totalAmount`, or `studioId` does not change the server charge.
- A room that does not belong to the quoted station is rejected before Viva creates an exercise or booking.
- A non-Piter split game fetches the exact Viva court price for the verified station, room, date/time, master service and sub-services, then divides that price by the server share count. The nominal transaction product cost is not pricing authority.
- A one-time Piter game created under the campaign keeps its exact policy ID, version and hourly rates; the rate is re-proved from the organizer transaction before each participant booking.
- A subscription-created Piter game validates the exact stored snapshot against CUP on join. A legacy subscription-created game without a snapshot uses CUP only for its stored date/station/room, which repairs the pre-fix 1,500 RUB fallback without trusting browser fields.
- Full payment uses the existing Viva full-payment path and the ordinary slot price.
- Before `activeFrom` and after `expiresAt`, Piter split pricing falls back to the exact Viva court price divided by the server share count.
- If CUP policy lookup is unavailable, one-time split payment fails closed; full payment remains available.
- CUP lookup is required when creating any split game. Join requires either read-only Viva confirmation of the one-time organizer transaction or an exact CUP lookup for a subscription-created game.
- Viva token requests are bounded to 10 seconds and Viva Admin API requests to 20 seconds.

## Return to the ordinary scheme

Set `expiresAt` to the end of the last eligible game date in Moscow time, or disable the campaign when new Piter games must return to the ordinary scheme. Do not change the rate or reuse the policy ID for another price. One-time games keep the transaction-proved snapshot; subscription-created games require the campaign to remain resolvable for their eligible game date. Games created after expiry/disable use ordinary Viva split pricing. Newer pricing must use a new policy ID.

Rollback is configuration-only after all compatible code is deployed: an expired, disabled or unmatched policy makes new games calculate the ordinary split share from the exact Viva court price. Existing games preserve their stored policy snapshot. No change is required in the full-payment path.
