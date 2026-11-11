# P1: purchase 502 and subscription booking 504, 11 November 2026

Investigation and source preparation only. All times below are Europe/Moscow.
Production was not changed; no purchase, booking, confirmation or reconciliation
operation was replayed by this investigation. No provider transaction GET was
performed, so provider payment settlement is not established.

## Established outcomes

| Operation | Evidence | Conclusion and limit |
| --- | --- | --- |
| Subscription purchase, 13:58:40 | nginx POST 502; no operationId in its query. One browser 502 was ingested in the same second, duration 431 ms, route UNKNOWN, serverLinked=false. | The browser event cannot conclusively identify this purchase. The exact failed stage and financial outcome remain UNKNOWN. |
| Subscription booking, 15:08:00 | nginx timed out reading headers from Node-RED. The same operationId appears in a second POST, successful at 15:08:17. | Two HTTP attempts are observed, not two proved bookings. |
| Saved result for that booking operation | Mongo owner record created 15:08:11.482; upstream attempted 15:08:11.498; accepted 15:08:15.500; CONFIRMED 15:08:15.928; attempts=1; booking and upstream booking IDs match. | One saved creation attempt corresponds to the second HTTP request. There is no saved first-attempt claim. This does not prove the first request never reached every external system. |
| Booking checkout | Transaction attempt saved 15:08:16.155, transactionId and checkout present. | Checkout creation is recorded; payment completion is not proved. CONFIRMED refers to the booking, not to payment. |

The bounded sales query covered createdAt [13:50,14:10), maxTimeMS=3000,
limit=101; it returned two PAYMENT_PENDING rows created at 13:50:02 and
14:09:34, without reaching the cap. Neither can be attributed to the 13:58:40
failure from timing alone. Absence of an exact local sale is not proof that Viva
created no transaction. Mongo reads were verified using each owning node's
configured connection and database. Identifiers and raw documents are excluded
from this report and source control.

## Confirmed defects, distinct from incident attribution

1. The live booking HTTP node has senderr=true, with normal output into its
   existing owner router. Its Catch covers Mongo nodes only. The installed HTTP
   implementation matches the repository's official Node-RED 4.0.9 fixture
   (SHA256 173baaaea541b5a8c00e2aeabfe25fbd1cf899946b53fe785c3fa54abbfacced).
   Transport exceptions are delivered exclusively to Catch, so the router's
   existing pending/error handling is bypassed. This can cause an nginx 504.
   The exact failed read in the first request is not established by retained logs.
2. Safe diagnostics omit the exact summer-subscription purchase route. It is
   normalized to UNKNOWN; the server middleware does not attach its correlation
   header for an unknown route. The allowlist fix restores eligibility for safe
   correlation; it does not recover historical evidence or fix the unknown 502.
3. Purchase source uses msg.httpRequestTimeout, while the installed HTTP consumer
   reads msg.requestTimeout. This is a separate defect, not the proven cause of
   the fast browser error. Do not shorten write deadlines until non-atomic sale
   branches durably preserve ambiguous provider results. No timeout change is
   included in this candidate.

## Prepared changes

`scripts/prepare_subscription_booking_transport.mjs` prepares a local candidate
from an independently authorized fresh live snapshot. It adds exactly one scoped
Catch and a sanitizer returning to the unchanged booking router. It does not
regenerate function bodies, edit worker pins or invoke any network/write API.
The sanitizer clears the stale status, request payload, headers and raw error.
Existing owner logic handles pre-write errors and post-write ambiguity.

```sh
node scripts/prepare_subscription_booking_transport.mjs \
  /private/tmp/authorized-audit \
  /private/tmp/new-booking-transport-candidate \
  REVIEWED_CURRENT_BOOKING_ROUTER_SHA256
```

The source uses the existing private workspace verifier (workspace/input0700,
single-link source and metadata0600, canonical paths, current local ownership,
formatVersion/localSourcePath/nodeCount/hash). It requires verified live-147
metadata, exact bytes and age <=30 minutes;
source and output must be outside Git. Outputs are private (directory0700,
files0600). Existing output, duplicate IDs/routes, disabled owner, source/router
drift and overlapping Catch custody fail closed. The report always states
readyForDeployment=false. Unit fixtures are synthetic; no real live candidate
was generated in this investigation.

The shared diagnostics allowlist and its published schema now recognize only the
exact purchase path. Query values, customer IDs, tokens and bodies remain excluded.

## Activation blockers and next investigation

- A whole-flow SHA change invalidates `lk1LiveGatewayGuard.mjs` worker binding,
  even with byte-identical booking functions. Prepare new immutable worker
  generations and their reviewed flow/gateway bindings together; retain previous
  generations for recovery. Never edit historical pins in place.
- Verify the current wrapped booking owner's error contract with the new Catch,
  including active training/CREATE/JOIN paths. Local tests cover the canonical
  router and the LK1 transaction ambiguity branch; full live composition was
  not available.
- Automatic approval review rejected exporting full live function bodies because
  they may embed secrets. No alternative full-body export was attempted. Any
  further source inspection must use separately authorized, reviewed disclosure
  or a suitable safe metadata check.
- Purchase502 needs an exact safe client/request/payment reference and provider
  receipts before any repair. Do not identify a payer by neighbouring timestamps,
  retry POST, issue a refund, or mark a local pending payment paid.

This is a candidate for review, not a production repair receipt.

## Local validation

- Subscription critical and drift-negative matrices: 138 files, 1855 passed,
  130 opt-in checks skipped, zero failures. These matrices do not supply a live
  owner snapshot and do not establish provider/payment acceptance.
- Final focused diagnostics/transport suite: 42 passed, including the official
  HTTP consumer with stub transport, stale response cleanup, pre/post-write
  handling, snapshot privacy and source/custody drift rejection.
- Full repository lint: zero errors, 478 warnings; changed-code lint clean.
- TypeScript build check (`tsc -b`) and `git diff --check`: passed.
- Production bundle build: blocked by absent ignored environment files in the
  isolated worktree; no runtime configuration was copied or changed.
- Independent payment/reliability/security review: passed after strengthening
  source privacy/provenance validation and sanitizing CLI failures.
