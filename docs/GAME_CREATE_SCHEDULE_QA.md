# Read-only game schedule for LK2 QA

`GET /lk/integrations/v1/game-create-schedule` takes an actor's Viva bearer and a
server-resolved station, Moscow date and 60, 90 or 120 minute duration. The LK1 owner
resolves the master service and reads the same Viva endpoint as the LK1 creation screen.
The list includes current slots that meet the booking lead time.

Pass the opaque `slotId` from the list to recalculate that slot. LK1 reads availability
again, uses the existing exact split-price parser and checks the actor's residency
through the existing subscription price-preview evaluator. The full-court tariff uses
RUB for the fixed Viva tenant. When Viva declares a currency it must be RUB. An
unconfirmed residency result stays unavailable. A quote expires after at most 30 seconds.
There are no reservation, checkout or payment commands in this reader.

When Viva's owned-subscriptions page contains only subscription instance IDs,
the reader requires the LK1 new-game quote to include `appliedSubscriptionProductId`.
LK1 returns this field after validating the Residency product, ownership and policy
for the selected slot. Older quotes without product identity cannot establish a
Residency price for an instance from that page.

Run `node scripts/game-create-schedule-qa.mjs` from this worktree with its pinned
dependencies installed. The service binds `127.0.0.1:24811`. For Docker use the isolated
LK2 QA overlay sharing the API network namespace. Keep it off public ingress. LK2
forwards only the session-bound user credential and strips provider room IDs before
returning the response to the UI.
