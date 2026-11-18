# Subscription booking history pagination

The subscription preview and booking gateway previously requested `size=1000`
without following subsequent pages. A valid paginated Viva response was refused as
`PRICE_PREVIEW_BOOKINGS_INCOMPLETE` (preview) or
`SUBSCRIPTION_BOOKINGS_*_INCOMPLETE` (booking). The UI rendered the preview refusal
as «Условия подписки не подтверждены». This is a failed verification of booking
history, not evidence that the client must accept new subscription terms.

Both readers now collect explicitly numbered `content` pages before evaluating
usage. Existing complete arrays and legacy complete wrappers retain their behavior.
Pagination is bound to tenant, actor, stage, exact GET URL and the original deadline.
Within each list, duplicate normalized booking IDs, foreign owners, malformed rows,
changed totals, skipped pages and incomplete final counts fail closed. The same ID
may occur in active and history; the existing merge/cancellation logic is preserved.
The first active receipt remains the freshness timestamp.

Limits: ten pages / 10,000 rows per list, one 25-second active/history pagination
budget (also bounded by the preview's original 28-second request limit), at most
10 seconds per continuation GET. Expiration also applies when the first history
response is a complete legacy array. Temporary GET timeouts restore the original
`msg.requestTimeout` before later phases, including booking POSTs. Every pagination
failure stops before operation claims, reserves, booking creation or payments.

Offset pages do not provide a provider-level atomic snapshot. Stable totals and
unique IDs detect common drift but cannot detect every equal-count concurrent
replacement. Larger histories or unsupported page metadata remain a safe refusal.
No subscription policy, allowance, payment amount or historical client data changes.

## Selective release preparation

`scripts/prepare_subscription_booking_pagination.mjs` composes an offline candidate
from an explicitly hashed live flow. Only `func` of these nodes may change:

- `lk_subscription_price_preview_20260908_router`
- `lk_subscription_booking_router_20260804`

The composer retains installed pricing helpers and owner modules; it embeds only
the tracked pure pagination collector into the preview. Each text replacement has
an exact inverse. Unknown anchors, disabled nodes, repeated application, source or
function hash drift stop preparation. The existing preview source builder also
exports the collector, including for older pinned calculation generations.

Before any separately authorized production deployment:

1. Use the pushed clean source commit. Pull a fresh private external live-147
   workspace using `scripts/pull_nodered_source_from_147.sh`; do not regenerate
   modular exports from a repository snapshot.
2. Record the exact source-flow SHA256 and both function SHA256 values, verify the
   installed topology and review the resulting two-function diff.
3. Create an empty external directory with mode `0700`, then run:

   ```sh
   node scripts/prepare_subscription_booking_pagination.mjs \
     /absolute/private/live-workspace /absolute/private/output \
     <source-commit> <source-flow-sha256> <booking-function-sha256> <preview-function-sha256>
   ```

4. Use the existing reviewed-flow deployment procedure with the emitted exact
   contract and private candidate. Keep the preimage/rollback artifacts private.
   This composer does not deploy, restart services, change policies or call Viva.
5. Verify installed hashes and unchanged graph/lifecycle, then refresh the affected
   client's subscription price using their authenticated session. Confirm a quote
   is returned and no booking/payment was created by the refresh. A synthetic
   rehearsal is not an authenticated production acceptance test.

## Verification

The CI critical matrix includes `subscriptionBookingPagination.nodered.test.mjs`
and `subscriptionBookingPaginationPatch.test.mjs`. They exercise both actual reader
bodies, 1000+1 rows, mixed single/multiple-page stages, terminal-page conflicts,
foreign/duplicate rows, URL binding, deadlines, timeout restoration and reversible
selective composition. Optional `LK_BOOKING_PAGINATION_FLOW_FIXTURE` enables a
private installed-flow rehearsal with synthetic responses; never commit that flow.
