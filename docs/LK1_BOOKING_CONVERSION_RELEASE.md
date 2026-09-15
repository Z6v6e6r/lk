# LK1 booking conversion guard

Owner: LK1 frontend. Audience: players publishing an existing Viva booking from
the cabinet. The ordinary conversion path creates a `payMode: self` game and
cannot reconstruct subscription split-payment evidence. Previously, subscription
bookings and failed roster lookups could reach that path.

Before creating a CUP game, the updated handler reads authenticated self-bookings
and the direct Viva exercise-bookings endpoint with browser cache disabled. It
requires a unique exact booking/exercise/location/time binding, active records,
complete lists and explicit supported non-subscription payment types. Subscription
signals, contradictions, malformed responses or failed reads stop publication and
show an actionable error. The existing Viva booking remains unchanged. An already
linked game opens without conversion-triggered community publication repair.

This is a frontend fail-closed fix. It does not restore subscription games,
reconstruct a payment, change subscription rules, release claims or deploy Node-RED.
Older bundles and direct API clients do not gain this guard. A server-authoritative
subscription publication/recovery contract remains necessary for that path.

## Verification and delivery

- Behavioral tests: `bookingConversionEvidence.test.ts` covers ordinary conversion,
  ownerless self DTOs, subscription signals, conflicting ownership/payment/cancellation,
  incomplete lists, exact binding and authenticated uncached reads.
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

Stop release if an ordinary verified booking is wrongly blocked, a subscription
conversion creates a CUP record, a stale/error response reaches publication, or
channel provenance/smoke fails. Stop method: withhold activation; after an authorized
release, use its guarded static-artifact rollback. No data rollback belongs to this
change. Source/CI success does not constitute completion of the full subscription E2E.
