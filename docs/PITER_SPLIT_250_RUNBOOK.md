# Piter split payment: 250 RUB per participant-hour

## Policy contract

- Policy ID: `piter-split-250-per-hour-v1`
- Station ID: `1ea77cbf-bc36-49a1-96d6-f35c216a409b`
- Pricing mode: `PER_PARTICIPANT_HOUR`
- Currency: `RUB`
- Four-player rate: `250` RUB per participant-hour
- Two-team rate: `500` RUB per team-hour
- Full-game payment source: the Viva slot/product price; this policy must never override it

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
- Full payment uses the existing Viva full-payment path and the ordinary slot price.
- Before `activeFrom` and after `expiresAt`, Piter split pricing falls back to the Viva product price divided by the server share count.
- If CUP policy lookup is unavailable, one-time split payment fails closed; full payment remains available.

## Return to the ordinary scheme

Set `expiresAt` to the end of the last eligible game date in Moscow time. Do not change the rate or reuse the policy ID for another price. Keep the campaign enabled until all games on or before that date have finished so late participants receive the same versioned rate. After that, disable/archive the campaign. Newer pricing must use a new policy ID.

Rollback is configuration-only after all compatible code is deployed: an expired or unmatched policy makes Node-RED calculate the ordinary split share from the Viva product cost. No change is required in the full-payment path.
