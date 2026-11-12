# Subscription booking 409 diagnostics

Owner: LK1 backend. Audience: incident investigation. The existing `lkDiagnostics`
observer enriches the `booking_finalize` stage event only for HTTP 409 on exact
`POST /lk/subscription-bookings` with gateway caller `http`. Internal split,
training and create-owner callbacks are excluded. Booking decisions, response
bodies/statuses and provider/Mongo operations are unchanged.

| Field | Meaning |
| --- | --- |
| `code` | Allowlisted response `details.code` / `code`; all other values become `UNKNOWN` |
| `action` | `book`, `release`, `cancel-free`, or `UNKNOWN` |
| `operationStage` | Existing allowlisted gateway step; unknown steps become `UNKNOWN` |
| `idempotencyKeyPresent` | Normalized operation key is present in the gateway context |
| `operationReadValid` | Latest request-operation read (`operation_find`, `lk1_ingress_operation_find`, `lk1_operation_find`) was an error-free array of at most one object |
| `operationFound` | Valid latest read contained one operation; omitted for an invalid/unobserved read |
| `sameOperationKey` | Operation key equals request key, with case preserved; omitted if either is unknown |
| `sameOperationTarget` | Subscription and exercise match for `book`; subscription and booking match for `release` |
| `operationState` | Known operation state enum, otherwise omitted |
| `leaseExpired`, `pendingExpired` | Parsed deadlines were reached at observation time; invalid/missing dates are omitted |

Facts are captured at router entry before the Mongo result is replaced. The latest
read replaces previous facts. Only booleans and the state enum are retained in a
per-request `WeakMap`; no operation, row, ID, key, phone, token or body is retained
there. Unobserved comparisons are omitted rather than reported as `false`.
The final event has no entity/key HMAC references. Existing server-generated
request/event correlation and release metadata remain available. It uses the
existing logger budget and suppression accounting, with no additional event.

A daily-limit code plus `sameOperationKey=false` / `sameOperationTarget=true`
distinguishes a same-target duplicate with a different key from an earlier
daily-limit refusal with no operation read. Eligibility and release/provider
mismatch codes remain separate. Fixed LK1 daily-visit, free-cancel refusal,
quote-changed and training-exclusion codes/steps are also preserved; no regex
accepts arbitrary provider codes. Daily-visit owner rows and cancellation-job rows
are not treated as the request's operation. Ordinary pending replies are still 202 and do
not receive these fields. These observations describe the branch; they do not
prove a business rule is correct or establish a user outcome.

Synthetic checks (no business API, DB or provider):

```sh
node --test scripts/tests/subscriptionBookingConflictDiagnostics.test.mjs
npm run test:correlated-error-diagnostics
```

The dedicated test also runs in the existing exact-head CI regression matrix.
No function body, flow graph, import/export or production settings are changed by
this patch. Activation is separate: refresh the observer runtime and its imported
helper/shared sanitizer together under a separately authorized release. Installed
router/finalizer hooks must be verified then; a missing observer produces no
diagnostics. Stop on unexpected output data or business-output differences; restore
the reviewed observer runtime to stop this enrichment. No source rollback can
reverse a booking. This patch neither deploys nor changes stored bookings.
