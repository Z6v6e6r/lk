# Subscription game-create timeout recovery

Owner: LK Games frontend and the split-create Node-RED graph. Audience: players
creating a game with a subscription. The UI keeps a visible preparation/creation
status, then checks an ambiguous result without submitting CREATE again.

## Contract and lifecycle

`GET /lk/games/split/create-result?operationId=lk-split-create-…` accepts the normal
Viva bearer. The query contains only the opaque operation ID. The reader:

1. Resolves the actor through Viva profile GET.
2. Reads the exact tenant/actor/operation key with majority read concern.
3. Validates the stored CREATE fingerprint, subscription, court, time, duration,
   decision, original receipt and any paid checkout.
4. GETs the live exercise and complete bounded exercise-bookings pages. Cancelled,
   contradictory, foreign or incomplete evidence cannot become success.
5. Re-reads the same confirmed operation with majority concern and checks the
   version/quote/receipt before returning the whitelisted result.

This graph has only HTTP GET, Mongo find and response effects. Missing operations
never enter fresh validation, reclaim, booking, cancellation, payment or visit
adjustment. A missing cached service token is an unknown result; this reader does
not refresh credentials or execute a provider write. Requests have an 8-second
server budget and bounded pagination. The existing CORS layer handles preflight.

The browser sends the initial CREATE once. A transport error, timeout, explicit
pending result or malformed success enters bounded GET recovery. The response must
match the original operation, selected subscription, station, court and time.
Authentication changes or owner cancellation discard a late response. Closing the
overlay or changing its selection aborts the owner, including after LK persistence
has begun, before further publication/navigation.

The browser retains opaque operation/ref pairs under
`lk_split_create_attempt_refs_v1:<operationId>` until the LK card is saved or a definitive
pre-create refusal is returned. Re-checks use the original reference. A storage
write failure disables later synchronization so stale storage cannot erase an
in-memory ambiguous attempt. If storage is completely unavailable, the guard is
limited to the active page. Corrupt/oversized journals fail closed. The active-page
64-entry bound does not evict unresolved attempts. Separate keys avoid overwriting
another tab's unrelated pending attempt. The server-owned stored receipt supplies
the canonical reference when tabs used different local references.

After confirmation the existing LK upsert is resumed with the original reference,
title and participant comment. A failed card save retains the attempt; its next
check does not create another Viva event. Unresolved recovery shows a neutral
status and a check action, rather than a subscription refusal.

## Price, reference and deadline compatibility

The normal legacy free response omits operationId. Its normalized create result
retains the known request ID so LK persistence can close the correct journal row.
The nominal participant share comes from the fingerprint-validated stored target
tariff (`target.basePriceMinor`), separately from the organizer's `finalPriceMinor`.
An organizer's zero entitlement price never makes the other participant shares zero.

A new top-level `createReceipt` is added only to the existing LK1 PREPARED record
when both the managed action and split context are CREATE. It contains version,
original paymentRef, payment deadline and assembly deadline; no credentials,
profile or redirects. The existing entitlement fingerprint is unchanged. JOIN,
training, tournaments and ordinary HTTP booking do not receive this receipt.

Legacy confirmed free rows without a receipt can be read with an explicit legacy
reference marker; the client uses its original retained ref after validating all
other binding fields. Their payment deadline remains null. The assembly deadline
is the original target start minus 24 hours. Legacy paid rows lacking a canonical
receipt remain unknown: no new payment window or checkout is invented.

## Timing diagnostics

The incident's historic logs did not contain per-stage CREATE timing. Current
read-only pricing measurements cannot establish the slow step of that old request.

Four existing live functions are wrapped with optional no-throw timing: split
prepare, split router, subscription router and subscription finalizer. Each uses
an explicit built-in crypto library. `SPLIT_CREATE_STAGE_TIMING_V1` records a fresh
server trace, allowlisted stage, duration, total duration and server timestamp.
No request URL, actor, subscription, payment reference, target, payload or token is
logged by this diagnostic. The paired stage boundaries distinguish pricing,
profile, subscriptions, active/history pages, Mongo claims and provider creation.
No production inject or synthetic booking is needed to collect the next natural
request after a separately authorized release.

## Offline preparation and activation boundary

Run `scripts/prepare_split_create_result.mjs <external source.flow.json> <new external output>`
against a verified live-source snapshot. Raw flow, candidate and exact-graph
contract stay outside Git in private directories. The source SHA and provenance
are checked; recorded timestamps are never refreshed. The composer preserves all
existing graph identity, order and wiring, changes four function bodies/library
bindings, and appends the six-node GET reader. Its receipt insertion uses one
exact guarded source anchor. No stale canonical flow is substituted for live code.

Preparation is offline, not permission to apply. Before activation, obtain a fresh
live preimage and active-runtime readback, confirm the reviewed delta, editor state,
existing deployment lock/lease and the dependent cancellation-worker generation
pins. Coordinate the worker's existing re-attestation procedure; never weaken its
drift guard. Use the existing reviewed-flow mechanism and separately authorized
deployment procedure. Apply/verify the backend before publishing the frontend.
An older backend yields pending/unknown; the client never falls back to POST.

Stop signals are wrong binding, changed source, unexpected effects, broken CORS,
worker drift, malformed receipt, incorrect tariff/deadline or stale-owner completion.
Stop by retaining the previous published artifacts and not applying the candidate;
after an authorized release use its exact guarded inverse, not manual production
edits. This source change grants no merge, deployment, restart, worker, booking,
payment or data-repair authority.

## Verification

- `splitCreateResult.test.mjs`: identities, quote/receipt/checkout, live readback,
  cancellation/release fence, unknown results, redaction and exact composition.
- `splitCreateRecovery.test.ts`: one original POST, GET-only recovery, preserved
  refs/reload/quota behavior, strict results, bounded reads and session/abort guards.
- `gameCreateButtonPreparation.test.mjs`: real extracted callbacks, busy/pending
  UI, title/comment/tariff preservation, one LK upsert and stale-owner suppression.
- `splitCreateResultRuntime.test.mjs`: Node-RED 4.0.9, real HTTP nodes with a
  fixture-only loopback rewrite, synthetic majority-find adapter, CORS, injected
  crypto, scoped transport catch, action-specific receipt and inverse restoration.
  It never starts a copied production graph or contacts real Viva/Mongo.

Production authenticated GET, physical-device acceptance and the next natural
timing trace require the separately authorized activation; local/CI evidence does
not claim those observations.
