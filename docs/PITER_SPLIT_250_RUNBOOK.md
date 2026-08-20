# Piter split payment: 250 RUB per participant-hour

## Policy contract

- Policy ID: `piter-split-250-per-hour-v1`
- Station ID: `1ea77cbf-bc36-49a1-96d6-f35c216a409b`
- Pricing mode: `PER_PARTICIPANT_HOUR`
- Currency: `RUB`
- Four-player rate: `250` RUB per participant-hour
- Two-team rate: `500` RUB per team-hour
- Full-game payment source: the Viva slot/product price; this policy must never override it
- Create resolves the active CUP campaign once and stores the normalized policy snapshot in the game
- Join never selects the current CUP campaign: it uses the stored snapshot, or ordinary Viva split pricing when the game has no snapshot
- Before participant booking, a stored promo rate must exactly match the confirmed organizer Viva transaction for the same exercise and booking; browser metadata alone is never pricing authority
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
- A non-Piter split game uses the Viva product price divided by the server share count.
- A Piter game created under the campaign keeps its exact policy ID, version and hourly rates when a participant joins after the campaign is changed, expired or disabled; the rate is re-proved from the organizer transaction before each participant booking.
- A game created without a policy snapshot never adopts a campaign enabled later.
- Full payment uses the existing Viva full-payment path and the ordinary slot price.
- Before `activeFrom` and after `expiresAt`, Piter split pricing falls back to the Viva product price divided by the server share count.
- If CUP policy lookup is unavailable, one-time split payment fails closed; full payment remains available.
- CUP lookup is required only when creating a one-time split game; joining an existing game does not depend on current CUP availability, but does require read-only Viva confirmation of the organizer transaction.
- Viva token requests are bounded to 10 seconds and Viva Admin API requests to 20 seconds.

## Return to the ordinary scheme

Set `expiresAt` to the end of the last eligible game date in Moscow time, or disable the campaign when new Piter games must return to the ordinary scheme. Do not change the rate or reuse the policy ID for another price. Games already created with this policy keep the immutable stored snapshot for later participants; games created after expiry/disable use ordinary Viva split pricing. Newer pricing must use a new policy ID.

Rollback is configuration-only after all compatible code is deployed: an expired, disabled or unmatched policy makes new games calculate the ordinary split share from the Viva product cost. Existing games preserve their stored policy snapshot. No change is required in the full-payment path.
