# LK1 booking conversion guard

Owner: LK1 frontend. Audience: players publishing an existing Viva booking from
the cabinet. The ordinary conversion path creates a `payMode: self` game and
cannot reconstruct subscription split-payment evidence. Previously, subscription
bookings and failed roster lookups could reach that path.

Before creating a CUP game, the updated handler reads authenticated self-bookings
and the direct Viva exercise-bookings endpoint with browser cache disabled. It
requires a unique exact booking/exercise/location/time binding, active records,
complete lists and an explicit supported non-subscription payment on the
organizer's own booking. A subscription signal on the organizer booking, a
contradiction, a malformed response or a failed read stops publication and shows
an actionable error. The existing Viva booking remains unchanged. An already
linked game opens without conversion-triggered community publication repair.

## Guard v2: co-participant subscription evidence no longer blocks

The first guard revision blocked conversion when **any** active participant of the
exercise carried a subscription signal. Because the split/`1/4` flow creates its
exercise on the shared `Открытая игра` direction (`4588` / type `1613`, commit
`07bb2e4b`), one-time organizers routinely share the exercise with subscription
players, so that rule blocked ordinary publications (on 2026-09-18, 10 of 29 open
games were mixed rosters, holding 15 one-time participants).

Guard v2 keeps every structural fail-closed check but makes the organizer's own
booking authoritative for the `payMode: self` decision:

- a subscription signal on the organizer booking still blocks with
  `BOOKING_CONVERSION_SUBSCRIPTION`;
- the organizer must still have an explicit `ONE_TIME` / `ON_PLACE` / `DEPOSIT`
  payment;
- other participants may hold one-time or subscription bookings; they are returned
  in `roster` and the caller records `canJoinBySubscription` in the created game;
- malformed ownership, cancellation conflicts, incomplete lists, duplicates and
  exact-binding mismatches still block publication.

This is a frontend fail-closed fix. It does not restore subscription games,
reconstruct a payment, change subscription rules, release claims or deploy Node-RED.
An organizer whose own booking is subscription-paid still needs support-side
restoration when the game record is missing; a server-authoritative subscription
publication/recovery contract remains necessary for that path.

## Verification and delivery

- Behavioral tests: `bookingConversionEvidence.test.ts` covers ordinary conversion,
  ownerless self DTOs, organizer versus co-participant subscription signals,
  conflicting ownership/payment/cancellation, incomplete lists, exact binding and
  authenticated uncached reads.
- `cabinetBookingConversionGuard.test.ts` checks the guard's placement before creation
  and the use of the direct Viva endpoint rather than cached tournament participants.
- Existing backend category conversion tests remain unchanged; all three suites are
  explicitly included in the exact-head enforcement workflow.
- Require the full exact-head CI result for this revision, plus channel-specific
  build/provenance and affected browser smoke at release.

The served DEV frontend uses the reserve server's `lk-frontend-dev-current` alias.
Prepare its successor with `scripts/lk1-dev-frontend-release.mjs` and the documented
guarded release process. A generic legacy-root upload does not prove this alias
was updated. DEV still uses the shared production backend/provider.

Stop release if an ordinary verified booking is wrongly blocked, a subscription-paid
organizer booking creates a CUP record, a stale/error response reaches publication, or
channel provenance/smoke fails. Stop method: withhold activation; after an authorized
release, use its guarded static-artifact rollback. No data rollback belongs to this
change. Source/CI success does not constitute completion of the full subscription E2E.
