# Subscription booking 503 diagnostics

Owner: LK1 backend. Audience: incident investigation. Extends the 409 observer
without changing booking, payment, provider, Mongo, retry or response decisions.
The four historical 503 responses remain UNKNOWN: this patch cannot recover old
response codes or prove that a booking did or did not happen.

## Coverage

The existing `booking_finalize` event now preserves the actual returned 503 code,
action and gateway step on exact `POST /lk/subscription-bookings`. The fixed catalog
includes product identity/current-state failures, managed runtime/config/activation,
service token/auth, product lookup busy, trial policy/history and split pricing or
reconciliation failures. Unlisted codes/actions/steps remain `UNKNOWN`.

`upstreamPhase` and `upstreamStatus` describe the latest **observed** HTTP-result
input at a known router phase, before its payload is replaced. Only bounded enums,
HTTP status and an error-presence boolean are retained in a request-keyed WeakMap.
They are not provider write/ACK proof and may describe an earlier successful read.
An invalid latest status removes an older status. Missing observation remains absent.

Some responses bypass the finalizer. Optional no-throw refusal hooks now observe
these emitting functions directly, only when they actually return 503 on the exact POST:

| Source function | Diagnostic stage |
| --- | --- |
| `fn_legacy_roster_bridge_response.js` | `roster_bridge_response` |
| `fn_legacy_roster_projection_build.js` | `roster_projection_build` |
| `fn_legacy_roster_projection_ack.js` | `roster_projection_ack` |

Their installed preimages matched the tracked source in the read-only audit.
The normal attested source application checks each preimage, candidate, exact route
hash, unique node and same-tab reachability; it does not rebuild a whole flow.
Bridge failure records its incoming HTTP status separately from its returned status.
Projection never interprets a stale status field as a provider outcome.

An owner/capability rejection occurs before the prepare node's normal observer.
`booking-prepare-failure-overlay.mjs` adds one no-throw observation at that exact
503 return, at stage `booking_prepare`. The installed prepare body differs from the
tracked offline fixture. Only the exact audited full installed preimage hash is
accepted; its opaque text is preserved byte-for-byte outside the one string edit.
Old tracked replacement, repeated edit, changed source or candidate hash fails closed.
No private function body is copied into this patch or its receipt.

All 503 observations use `outcome_unknown`, including policy refusal: a projection or
reconciliation error may follow an already accepted provider operation. No message,
body, header, error text, ID, phone, operation key or entity/key HMAC reference is
added to these failure events. Existing random request/event IDs correlate them
with terminal HTTP events. A diagnostic code is evidence of the returned branch,
not evidence that a business policy is correct or a side effect never happened.

## Verification and activation

```sh
node --test scripts/tests/subscriptionBookingFailureDiagnostics.test.mjs
node --test scripts/tests/subscriptionBookingConflictDiagnostics.test.mjs
npm run test:correlated-error-diagnostics
```

Mock checks compare complete business outputs, status/body and Mongo/fan-out
continuations with diagnostics absent/present/throwing. They cover direct projection
context/write/ACK failures, retry versus exhausted 409, successful ACK, provider 503,
missing service token, unknown enums, request isolation and fail-closed source guards.
The local profile upstream-503 path remains 502. Product failures from the audited
live router are injected at its observed result/finalizer boundary because the
older local router is not the installed product-resolution implementation.

Activation is a separate authorized operation. Refresh runtime/helper/sanitizer and
apply the reviewed focused function hooks together against a fresh verified private
live preimage. The overlay receipt proves only a source transformation on its dated
preimage, not activation or loaded runtime identity. A missing observer is a no-op;
without installed direct-node hooks those direct responses remain unobserved.
No flow import/export, production settings, deployment or real booking is performed.
Stop on unexpected diagnostic data or business-output differences; restore only the
reviewed diagnostic runtime and hook preimages to disable this change. Source rollback
cannot undo any provider booking or payment. Existing 409 events and normal 202
pending behavior are unchanged. This remains a Draft extension of the existing 409 PR.

## Scoped settings registration

`subscription-booking-scope.mjs` is the deployment facade for both409 and503.
It forwards only the own-operation reads needed by409, known HTTP-result phases,
final409/503, and the explicit direct503 hooks. Its sink accepts only those safe
failure events and stage-suppression aggregates. All unrelated observer methods
are no-ops; middleware remains unattached. Suppression counts forwarded stages,
not requests or failed bookings.

`subscription-booking-bootstrap.mjs` preserves existing settings/globals and
registers this facade only when no observer is already configured. Startup first
checks409,503 and a direct projection503 with an isolated in-memory sink; these
synthetic events never reach production logs. A private readiness receipt records
`scope=SUBSCRIPTION_BOOKING_409_503_V1` and `selfTestPassed=true` only after registration.
The receipt retains the existing installer's `SUBSCRIPTION409_SETTINGS_REGISTERED`
kind for compatibility; activation must independently check the exact scope,
generation, bundle hash and current process identity. Receipt failure before publication restores the
previous global context. A directory-fsync error after a matching ready receipt
is atomically published retains the registered observer as committed and emits
only the fixed startup enum `OBSERVER_READY_DURABILITY_UNKNOWN`; it never leaves
a false-ready file paired with a removed observer. If receipt readback itself is
unavailable, registration is kept until the guarded installer resolves the
unknown outcome. Normal successful publication fsyncs both file and directory. Missing/throwing diagnostics cannot authorize or replay
business operations. Actual installation, shared-lock coordination, fresh preimages,
restart and rollback remain the guarded installer's responsibility.

The startup enum `OBSERVER_READY_DURABILITY_UNKNOWN` is a degraded/stop signal,
not durable readiness proof: do not finish the install soak after observing it.
If runtime/settings and flow hooks require separate installers, serialize them:
validate/finish the runtime transaction first, then use a fresh guarded flow
contract. Phase-2 recovery restores its hooks to the independently validated
phase-1 runtime/settings. That is last-known-good partial activation, not a full
preactivation rollback; never reuse a stale phase-1 process/flow contract.
