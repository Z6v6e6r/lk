# TRAINING registration owner v1

This source packet is **PARTIAL B05**: registration for an existing group training
through the existing LK subscription booking writer. It supports an explicitly
unmanaged CUP subscription and an existing LK1 selector result of LEGACY or
UNMATCHED. Every matched non-legacy LK1 rule, including a 100% discount, remains
unsupported. It does not enable money, copay, trial purchase, CUP usage, training
creation, cancellation or tournament registration.

The exact synthetic backend contract is
`scripts/tests/fixtures/training-registration-owner-v1-contract.json`, SHA256
`ad6b0447943617233fd4677dc61205fef054e22d1b1d19a3fcf12ede3b7e88b8`.
Its proposal-status text and business base commit are retained as immutable
provenance, not runtime authority. The source base is #270 at
`7abe118bd909b331650dc9bcf76e7492480493a7`.

## Authority and transport

The new internal preparation/admission/read routes use the existing RS256
delegation issuer, audience, key, receiver and execution gates. Each verifies its
own exact method, actual route, scope, request hash, correlation ID, actor-token
hash and expiry. A fresh user-scoped Viva profile must match the signed actor.
No service credential substitutes for that identity proof.

Preparation reads a complete bounded date schedule, recomputes the existing
public UUID from each provider exercise ID, and requires one exact match. Exact
exercise detail supplies date, duration, category, studio, room and capacity.
The authenticated exercise's available-subscription list supplies the selected
owned subscription; contradictory explicit actor/subscription aliases are
refused. Current canonical CUP and LK1 selectors, plus existing PRO/Topokraty
restrictions, are embedded from their real source. Explicit valid allowlist,
plan-rule and station-exclusion configuration is required. Missing, malformed,
ambiguous or unavailable evidence is never LEGACY. The canonical writer still
applies its existing category and daily restrictions.

Preparation has no durable write and yields a backend-only, nonbinding 60-second
capsule. Every material target and selector fact is checked again before the
first booking. Provider references in the capsule/receipt must never be spread
into Web/mobile DTOs. This packet adds no public LK2 DTO or consumer.

## Durable attempt and receipt

The existing daily-operation collection holds a separate outer row of kind
`TRAINING_REGISTRATION_ADMISSION`, keyed by the unchanged shared operation-ID
formula. Identity and provider references are nested; canonical root actor,
subscription, exercise, date and LK1 fields are absent so legacy daily selectors
do not select this row. A changed same-key action, request, capsule or immutable
identity fails closed.

Admission CAS-leases the exact row for 120 seconds before its sole loopback POST
to `/lk/subscription-bookings`. Only hashes/expiry metadata are persisted, never
the actor token or delegation. The loopback context is restrictive: canonical
prepare validates it, and the booking router independently reads the persisted
admission, live lease and authenticated actor before writing. The existing
canonical operation stores its immutable training binding and original attempt
context before the existing provider booking POST. Its admin credential remains
inside the existing writer; neither a background actor nor an arbitrary request
marker can enter this path. Monetary/CUP dispatch is fenced off for this context.

Provider success is followed by exact canonical persistence and a complete
authenticated booking read. A receipt requires the same actor, exercise,
subscription and original booking ID, positive ACTIVE/CONFIRMED/BOOKED status,
no contradictory cancellation or waitlist evidence, and canonical CONFIRMED
state. The loopback callback alone cannot authorize a receipt. A fresh GET read
checks the original registration again, is nonmutating and rejects a changed
terminal booking or receipt.

## Recovery and compatibility

A fresh signed `recovery_only:true` admission reuses the exact original body and
hash. It may lease an expired existing attempt and reconcile the same canonical
operation before current selector evaluation. It cannot prepare a replacement,
reserve CUP usage, reclaim a different operation or send another provider
booking POST. A persisted original provider booking ID permits exact readback
and conditional local confirmation. Missing/corrupt original context, absent
canonical state, a replaced booking or an ACK loss with no attributable original
booking ID remains UNKNOWN. No adoption by matching actor, room or time occurs.

Recovery requires fresh foreground actor credentials. There is no automatic
service-account/background recovery. Concurrent attempts use original-state,
binding and attempt-token CAS; stale acknowledgements cannot finalize a later
attempt. Ordinary callers cannot reclaim a canonical operation carrying the new
training binding. Existing rows and requests without it retain their prior
behavior.

The source-only composer accepts the exact reviewed #270 canonical function
preimage and existing store/topology. It atomically includes the new restrictive
gate, exact `TRAINING_LEGACY_V1` probe, prepare validation and finalizer scrub.
The actual GET probe traverses options → prepare → router → finalizer using
a private read-only stage marker. Both canonical GET/POST inbound edges and the
Mongo catch → error handler → finalizer privacy leg are checked by the composer.
Options and prepare gain a third private probe output; ordinary outputs stay
unchanged. New router/old prepare and old finalizer combinations cannot produce
the required capability. Cancellation flags on the target and nested exercise
also deny confirmation, including when a booking status says CONFIRMED.
Old/missing/raw-owner probes fail before loopback mutation. Existing capability
versions 1/2/3 retain their responses. Unknown installed wrappers or changed
graph/store identities are rejected rather than replaced. Historical
PATRIOTS/activation/deployment pins are unchanged. This composition is not a
production-flow preimage or deployment authorization.

Before activation, an owner must separately verify the actual deployed graph,
explicit selector configuration, credential scope, exact provider response
shapes and existing environment gates. Rollback removes the new routes and
capability as one source packet; retain new journal and canonical bindings.
Pending attempts must not be resumed by an older owner which ignores their
restriction. Keep training admission disabled until the compatible packet is
restored and original attempts can be read. No data deletion or automatic
backfill is part of rollback.

## Evidence boundary

`trainingRegistrationOwner.test.mjs` runs whole-entry synthetic preparation,
admission, the real canonical writer source, receipt/read and recovery. It covers
interleaved CAS claims, stale attempts, ACK losses, selector drift, changed
bindings, unknown statuses, foreign actor/subscription, mixed capability and
credential scrubbing. `trainingRegistrationOwnerPatch.test.mjs` verifies exact
source/topology custody and unchanged ordinary prepare/finalize/probes.
Both are included in the existing receiver CI command.

These tests use no provider or database. They do not establish physical Mongo
concurrency, provider last-seat atomicity, installed Node-RED compatibility,
mobile acceptance or production readiness. No new physical Mongo fixture is
claimed. Real cancellation/rejoin races after a provider read remain a runtime
acceptance boundary; a local receipt is an observation, not a permanent promise
that the registration can never change.
