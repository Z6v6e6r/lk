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
4. GETs the live exercise and complete bounded exercise-bookings pages. For an
   operation that used one subscription visit and charged a surcharge, the active
   owner booking must still be on that subscription. The reader separately checks
   the surcharge transaction and its exact product, payer, amount and booking link.
   The transaction on the booking may belong to the subscription purchase.
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

After recovery, LK resumes with the original reference and the settings from the
active wizard. For a subscription with a surcharge, the browser checks for an
existing card by both booking and payment reference before creating a draft. A
conflicting alias or incomplete lookup leaves the attempt pending. An outstanding
payment can open only the
original, still-valid checkout after the draft is read back. A paid surcharge
returns the original amount, transaction and paid time with no checkout URL.

For the paid case the browser resumes the canonical payment confirmation using
the saved draft. Its backend reads the same owner-authenticated result endpoint on
loopback, matches the exact draft and claims the transaction through the existing
claim and revision-checked write. The browser displays the invitation once it has
read back the matching paid card. Closing the wizard discards its form state. The
opaque attempt journal does not act as an unattended publisher.

A failed card save or confirmation retains the attempt. The next check uses the
same operation. If the evidence is incomplete or the unpaid checkout has expired,
the result remains pending.

## Legacy daily subscription bookings

The incident variant uses the legacy daily operations collection with no
`lk1-product` key or managed quote. When the managed key is absent, the reader
uses the same Viva bearer to read the actor's active bookings. A complete
bounded page yields the shared-day, category-day and event keys. The Mongo
read stays indexed by `_id` and constrained by tenant, actor and operation ID.
The reader confirms the exact active exercise and subscription booking in
Viva and repeats the same majority read before returning a result.

The legacy booking gateway stores `legacySplitCreate` when its internal split
CREATE owns the new exercise. This records the original reference, location,
time, capacity and visit count. A public booking request or split JOIN cannot
add the receipt. Reclaim clears a previous receipt when the new operation has
no matching CREATE evidence. The reader requires the receipt to agree with the
current booking, actor and provider slot before permitting fresh publication.

For an older row without the receipt, the browser can reconnect an existing LK
card with the same organizer, booking and slot. If the card is missing, it
shows that the booking is confirmed and directs the organizer to support.
Historical rows contain no authoritative CREATE provenance. The browser
reads the original operation and opens the invite only after a unique exact
card is read back. A new-card attempt sends a single revision-fenced write
using the server receipt's original reference. A later check looks up both
booking and payment aliases first. A transport error can therefore recover a
committed card without starting another booking or charge.

The legacy daily result returns zero organizer cash due and no payment URL,
transaction or synthetic payment deadline. It omits the participant tariff
because the old operation provides no quote snapshot. The browser uses the
existing exact-slot price if available. A one-time join still checks the
authoritative court tariff before taking payment.

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
For an existing reader, pass
`--update-reader <reviewed handler SHA256> <reviewed booking router SHA256>`
to the same preparation script. This checks the existing route and read-only
graph, then changes the result handler and the legacy booking router function
bodies. The proof insertion is anchored to the legacy Mongo insert and reclaim.
The reader, proof producer and revision-fenced game writer must be verified
together before activating legacy publication recovery. The game-payment confirmation graph must include
`fn_game_payment_confirm_router.js` and its existing claim and readback nodes.
The create/draft paths must persist the canonical tenant and revision and fence
the pending draft with the unique `(tenantKey, id)` index. A legacy
payment-reference-only upsert can overwrite a concurrent paid card and cannot
serve as this rollout's card or draft writer.
The mixed branch uses the reader on the same Node-RED instance
(`127.0.0.1:1880` on the LK host). Validate both backend paths together.
An older reader yields pending for the mixed booking. The browser never repeats
the provider CREATE after the ambiguous response.

Stop signals are wrong binding, changed source, unexpected effects, broken CORS,
worker drift, malformed receipt, incorrect tariff/deadline or stale-owner completion.
Stop by retaining the previous published artifacts and not applying the candidate;
after an authorized release use its exact guarded inverse, not manual production
edits. This source change grants no merge, deployment, restart, worker, booking,
payment or data-repair authority.

## Verification

- `splitCreateResult.test.mjs`: identities, quote/receipt/checkout, live readback,
  cancellation/release fence, mixed paid and unpaid provider evidence, legacy
  receipt and ownership checks, redaction and exact composition.
- `splitCreateRecovery.test.ts`: one original POST, GET-only recovery, preserved
  refs/reload/quota behavior, strict results, bounded reads and session/abort guards.
- `gameCreateButtonPreparation.test.mjs`: real extracted callbacks, busy/pending
  UI, title/comment/tariff preservation, one LK write, exact readback before
  showing the invitation and stale-owner suppression.
- `gamePaymentConfirmation.nodered.test.ts` and `serverGameDraftPersistence.test.ts`:
  exact mixed settlement, transaction claim, durable readback, no downgrade of an
  already paid card and rejection of mismatched evidence.
- `splitCreateResultRuntime.test.mjs`: Node-RED 4.0.9, real HTTP nodes with a
  fixture-only loopback rewrite, synthetic majority-find adapter, CORS, injected
  crypto, scoped transport catch, action-specific receipt and inverse restoration.
  It never starts a copied production graph or contacts real Viva/Mongo.

Production authenticated GET, physical-device acceptance and the next natural
timing trace require the separately authorized activation; local/CI evidence does
not claim those observations.
