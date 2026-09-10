# Group booking payment link: missing reserve ingress

## Confirmed cause

The user's DEV group signup calls POST `/lk/subscription-bookings?operationId=...`
through the reserve origin. Before POST, the browser sends an OPTIONS preflight.
On 10 September, reserve returned 404 with no CORS headers, while primary returned
204 with POST/OPTIONS and Content-Type/Authorization allowed. Fresh `nginx -T`
confirmed reserve has the quote and catalog proxies but no booking proxy; the
request falls through to static `try_files $uri =404`.

The current reserve access log contained two OPTIONS/404 entries and no POST for
the reported operation. This is limited log evidence, not a provider/database
status assertion. No authenticated replay, booking, payment or refund was executed.

## Isolated correction

Base origin/main: bcf9f7caba517e75584e38be15eb0b7512072c28.
Branch: codex/group-booking-reserve-route-20260910.

- Add the exact reserve booking location, verified HTTPS to primary, POST/OPTIONS,
  16 KiB body limit, no retries, unchanged operationId/body/Authorization.
- Reuse the SHA-guarded builder with an optional static marker; primary defaults
  remain unchanged. Reserve builder requires its exact static fallback marker.
- Add regression and physical nginx checks; document the distinct install path.
- No frontend, Node-RED, pricing or subscription policy changes.

Private candidate from the live reserve config:
source SHA-256 `47a3a8ce7cf53feb2aa4077c9a4e291dee0e30d96ec653f7ccdead828919ef55`;
candidate `351ef367e9bd8dd86f8115db84153f25f7496145de8e630eb1496b6b784cee59`.
Removing the inserted fragment restores the original source byte for byte.
These hashes are preparation evidence; installation requires fresh readback.

## Evidence and limits

- Booking nginx unit suite: 7 PASS, physical test initially opt-in skipped.
- Opted-in network-none Docker nginx: 2 PASS, no skips. Exact fragment verified
  with synthetic TLS primary, preflight/CORS, method/body limits, intact query
  and synthetic Authorization, single upstream forwarding per POST, no extra route.
- Delivery gate: 68 PASS, one loopback test cancelled by sandbox; the exact test
  rerun with loopback access passed (1 PASS).
- Preview ingress compatibility: 1 PASS, 2 optional physical skips.
- Product identity compatibility: 19 PASS, 3 optional skips; first invocation
  lacked Node TypeScript stripping, corrected invocation passed.
- Full lint: 0 errors, 387 existing warnings. Independent specialist review:
  no material findings. Frontend build was not run because no bundle input changed.

No merge, push, deploy, nginx reload or live data mutation in this correction stage.
Payment link issuance remains unverified until installation and an authorized
user booking. Installation affects only reserve nginx and must not restart
Node-RED or publish frontend. Use the reserve-aware guarded install procedure
in scripts/nginx/README.md; the primary apply helper is incompatible.
