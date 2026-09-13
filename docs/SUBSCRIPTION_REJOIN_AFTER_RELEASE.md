# Subscription join after a completed leave

Owner: LK Games booking/payment maintainers. Audience: players joining an existing
split game with a HUB subscription after their previous booking was cancelled.

Previously, a stable join operation ID kept resolving to its historical RELEASED
record. The gateway reported PENDING_CONFIRMATION, so the browser never reached
payment navigation. The new behavior retains that history and requires another
explicit submission to create a deterministic successor.

## Contract and safety

The existing authenticated `POST /lk/games/:gameId/split/join` endpoint remains the
entry point. An exact, eligible released operation returns HTTP 409 with
`details.code = SUBSCRIPTION_BOOKING_RELEASED`, the submitted `operationId`, and
`nextOperationId`. The browser stops polling, remembers the successor for this
operation only, and shows “Присоединиться снова”. It never follows the successor
inside the current request or polling loop. Reloads and multiple tabs converge on
the same ID; a missing/corrupt browser hint cannot bypass server validation.

Successors use `<base>:rejoin:<generation>`, bounded to 1000 generations. Before
inserting a missing successor the server reads its exact immediate predecessor
under the authenticated tenant/client and verifies subscription, exercise, stored
quote identity and completed GAME_LEAVE evidence. The release must reference the
same confirmed/upstream booking and include its released booking ID. No attempted
transaction, transaction intent/ID, checkout or separate visit job is admissible.
Transaction-bearing and unproven releases remain reconciliation-blocked: a released
booking alone does not prove a refunded payment or returned visit.

The successor runs fresh product ownership, tariff, availability and allowance
checks. It uses the existing unique operation insert and PREPARED-to-PENDING CAS;
the predecessor is never reclaimed or overwritten. Its release identity is saved
as `rejoinPredecessor` on the new record. Delayed LK1 accept/confirm/fail updates
are fenced against terminal states. Confirmation rejects conflicting upstream
booking IDs while preserving the existing unbound-booking recovery path.

Unresolved responses now say that the result could not be confirmed, without
claiming that a provider accepted a write. This release does not add autonomous
payment recovery or a read-only polling endpoint. Pending retries still use the
same POST and operation ID.

## Node-RED composition

Changed node: `lk_subscription_booking_router_20260804` (function body only).
Sources: `scripts/nodered_lk1_hub_nodes/gateway.js`, `gateway_hooks.js`, and the
`patch_live_lk1_hub.mjs` composition hook for LK1 mutation fences.

`composeSubscriptionRejoinArtifacts` from
`scripts/patch_nodered_subscription_rejoin.mjs` accepts private live bytes and a
deployment ID, returning candidate bytes and an exact one-node reviewed contract.
It rejects unknown ingress preimages and repeated application. The supported
installed expired-pending recovery is preserved. For the installed legacy body,
the two checkout URL checks use the existing HTTPS validator that works without
the unavailable Node-RED `URL` global. No wires, configuration nodes, credentials,
policy settings or tracked flow JSON exports are changed.

Use a fresh private external snapshot at authorized apply time. This development
change and a locally generated candidate do not authorize import, restart, payment
creation or modification of existing database records.

Stop signals: duplicate provider dispatch, a changed predecessor, mismatched
actor/subscription/booking, or a successful response without verified checkout.
Stop method: halt the rollout and use its exact reviewed rollback contract; do
not replay payment creation or edit operation states manually. Frontend alone
cannot enable successors on an older backend.

## Verification

CI includes `subscriptionRejoin.test.ts`, `subscriptionRejoinGateway.test.mjs`,
and `subscriptionRejoinPatch.test.mjs` in the critical subscription matrix.
They cover terminal release, explicit successor selection, identity mismatch,
malformed proof, unknown money, skipped generations, stale browser hints and
terminal-state fencing. The optional `LK1_REJOIN_LIVE_FIXTURE` points to a private
external `source.flow.json` to execute the composed installed function with
fixture messages: fresh identity routing, insert ownership/duplicate ACK, winner
and loser CAS, delayed confirmation rejection, and saved checkout replay in a VM
without `URL`. No real HTTP or MongoDB calls are made by these tests.

Local function/CAS tests are not real concurrent database or provider acceptance.
Rendered authenticated join, payment opening and return still require the
authorized deployment and user-controlled transaction scenario.
