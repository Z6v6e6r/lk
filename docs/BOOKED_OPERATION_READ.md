# Commercial owner receipt read (B1)

`scripts/lib/bookedOperationRead.mjs` implements the isolated owner HTTP handler for
`GET /lk/integrations/v1/booked-operations/{operationId}`. It is not installed into the
live Node-RED graph by this change. No existing command router, money module, membership
pilot, runtime setting or provider write is changed.

The host injects an explicitly configured RS256 verifier and a read-only Mongo reader.
Missing dependencies return 503. The verifier requires scope
`subscription-runtime.booked-operation.read`, caller `lk2-api`, trusted issuer/audience,
canonical user/tenant/session/mapping/operation UUIDs, tenant key binding, provider actor,
exact GET path, correlation ID and 10–60 second validity. Quote tokens and shared service
tokens are insufficient. Trust configuration cannot discover keys or widen tenant access.

The reader only calls `find` on `lk_subscription_daily_booking_ops`, filters exact tenant,
operation and actor, limits to two rows, uses majority read concern and a one-second
server timeout. Zero/duplicate rows or foreign/unprovable associations yield the same
404. DB errors yield 503. No insert, update, command replay, reconciliation write, debit,
payment, create or provider call is available to this read path.

Current receipts lack a trusted canonical attempt association. Therefore the reader
requires an owner-written `padlHubOperation` object with contractVersion 1, matching
canonical operationId/tenantId/userId/providerMappingId and trusted issuer/caller.
UUID-shaped legacy operationId alone cannot supply this proof. This change does not
populate those fields, alter an index or backfill legacy data. Positive fixtures are
synthetic evidence only. B owns that canonical admission contract with the commercial
receipt writer; L supplies its coupled writer handoff. Overall B1 remains blocked for
real legacy attempts until that proof and runtime wiring are delivered.

The public response is limited to contractVersion, operationId, status, durable asOf and
allowlisted reason. It exposes no booking/exercise/subscription/provider identifiers.
PENDING remains pending. Partial/released/failed/malformed states remain UNKNOWN. A
CONFIRMED receipt requires stable internal booking confirmation, completed/not-required
activation and confirmed managed entitlement when present; it is booking evidence, not
paid settlement or game creation. 404/503/UNKNOWN never authorize another purchase.
No monotonic revision is invented from attempts or timestamps. Source PRECREATE states
are handled without claiming they are deployed.

Run `node --test scripts/tests/bookedOperationRead.test.mjs` with Node22 for the real
loopback HTTP regressions. Physical Mongo tests require an explicitly task-owned synthetic
database and separate resource allocation; a stubbed collection is not physical evidence.
B2 quote/slot authority and B3 booking/settlement/game association remain separate work.
