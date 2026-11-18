# Cancelled unpaid day reservations

The booking gateway and price preview previously counted every CONFIRMED ledger
operation as a covered event, including a zero-visit monetary attempt whose Viva
booking had already been cancelled. A later event on that day received a discount
instead of the first free event.

The shared usage step now excludes a zero-visit group/tournament operation only
when complete self-API active/history receipts prove the exact cancelled booking,
actor, exercise and service date. Both raw lists are checked before merging so an
active row cannot be hidden by history. Receipts must be at most 60 seconds old
and newer than the operation. Missing, contradictory, pending and visit-consuming
records stay counted. The eight-active-booking limit and daily visit guard remain
in place. Receipt rows are removed before a new operation is persisted.

The unpaid worker reconciles an already cancelled booking without a Viva PUT.
It requires an expired, unpaid, bound transaction and zero subscription visits,
then repeats both provider reads before a majority+journaled frozen-snapshot CAS.
The original transaction, checkout, decision and booking identity are retained.
Both this path and normal unpaid cancellation store the same exact release proof.
Paid, refund, processing, uncertain and visit-adjustment cases are excluded.

An old HTTP operation ID returns a terminal 409 with its successor ID only after
that release proof. The widget remembers it for the next explicit submission;
polling never changes its ID or automatically posts a new attempt. The server
requires the immediate predecessor and root linkage, then performs fresh ownership,
pricing, allowance and daily-guard validation. An old paid checkout is never reused.

Production preparation uses `patch_live_cancelled_day_allowance.mjs` against the
exact installed flow, changing only booking and preview function bodies. The final
flow and gateway hashes must also be pinned in `lk1LiveGatewayGuard.mjs` and deployed
as a pair with the worker. Keep the permanent flow-read auth release referenced by
Node-RED settings; do not replace the service token, settings, cohort or cursor.

For historical repair, dry-run and freeze the exact operation list, back up every
preimage durably on the server, stop the worker and require zero global INTENT/REVIEW
records. Recheck each frozen ledger/provider snapshot before calling
`releaseAlreadyCancelledLk1Allowance`. Postcheck the unchanged financial evidence,
RELEASED ledger state and provider cancellation/unpaid status. No payment, refund,
visit change, rebooking or roster write is part of that repair. Code rollback does
not automatically undo ledger reconciliation or recreate a cancelled booking.

Regression checks: `cancelledDayAllowance.test.mjs`,
`lk1UnpaidBookingCancellation.test.mjs`, existing subscription-rejoin and
friendship/residency preview tests, then the subscription-enforcement CI gate.
