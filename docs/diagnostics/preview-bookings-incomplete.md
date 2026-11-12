# Booking-list preview refusal diagnostics

Owner: LK subscription preview maintainers. Audience: operators investigating
`PRICE_PREVIEW_BOOKINGS_INCOMPLETE`. The source change reports the first failed
predicate on an already-read active/history response. It adds no Viva/DB read,
retry, pagination, write, policy change or response detail.

The public refusal remains HTTP 503 with only the existing `error.code`.
HTTP success, list completeness, row object/id and present-owner equality guards
retain their original order, helper calls and short circuit. Missing owner values
remain accepted by the existing contract. Transport errors and elapsed-time guards
still take precedence and keep their own codes.

The shared observer emits an `audit` at `stage=preview_router`, with:

| Field | Allowed values |
| --- | --- |
| `operationStage` | `activeBookings`, `historyBookings` |
| `firstFailure` | `upstream_status`, `list_incomplete_or_unrecognized`, `row_not_object`, `row_id_missing`, `row_owner_mismatch` |
| `upstreamStatus` | Integer 100–599 when already present as a primitive numeric status; omitted otherwise |

`list_incomplete_or_unrecognized` deliberately covers both an unrecognized DTO
and a negative completeness verdict. It does not establish pagination or truncation.
`row_owner_mismatch` reports a comparison result; it never reports either identity.
An absent/invalid status is unknown, not zero. Status accessors and custom coercion
are not invoked by the new diagnostics. No payload, headers, URL/query, IDs, row
index, counts, timestamps from provider data, or error strings enter these fields.

When the shared observer is missing or throws, a separate info event named
`subscription_price_preview_bookings_refused` contains only `event`, `code`,
`stage`, `operationStage`, `firstFailure` and optionally `upstreamStatus`.
It is one diagnostic observation, not an extra HTTP request or a second refusal.
Do not add it to legacy final-warning/HTTP counts. A throwing log sink cannot
change the business verdict. The fallback emits at most once per refused request;
the existing process logger manages its output. Shared-observer budgets remain
unchanged. Successful requests produce no new booking-refusal diagnostic.

Local tests run both stages against the original guard predicates, compare helper
calls and outgoing read transitions, and cover mixed/malformed rows, incomplete
wrappers, non-2xx, missing/invalid status, throwing sinks, transport/timeout
precedence and sanitizer privacy. They make no provider/database requests.

This change prepares source and schema only. It produces no flow export/import
and grants no activation authority. A future activation must bind the exact
installed source and matching sanitizer/observer or reviewed fallback; do not
regenerate an older live router wholesale from current main. Stop on changed
HTTP verdicts, unexpected traffic/log growth, missing startup/source evidence or
source drift; disable by reverting the diagnostic diff through the same reviewed
deployment mechanism. No flag or shared configuration is added here.

Natural verification requires separately authorized activation, then an existing
user request: compare safe aggregates by stage/firstFailure/status and canonical
HTTP counters, without generating a real preview or inferring request identity
from timestamps. A quiet window without relevant traffic does not prove a fix.
The three historical refusals' exact predicate and impact remain unknown until
new evidence establishes them; this instrumentation does not fix their cause.
