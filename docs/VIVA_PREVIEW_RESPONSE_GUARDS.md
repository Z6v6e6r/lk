# Viva projection acknowledgements and exercise preview diagnostics

The onboarding level/rating projection must not acknowledge a successful PUT
solely from its HTTP status. The Node-RED HTTP request node with `ret=obj` forwards
its original string after a JSON parse warning. The capture function accepts
decoded JSON objects/arrays for non-204 2xx, preserves provider error/message and
transport-error refusal, and accepts a correct no-content 204 (`{}` after the
HTTP node, or empty/null/undefined in an isolated function call). It does not parse
strings again, retry a PUT, or perform provider readback. Existing response fields
are retained; malformed acknowledgements produce a failed projection/502.

The exercise step of `POST /lk/subscriptions/game-price-preview` keeps the same
ordered predicates and `PRICE_PREVIEW_GAME_UNRESOLVED`/503 response, without adding
HTTP error details. Its `preview_router` observer event adds the first failed
predicate as an existing allowlisted reason, safe upstream status, `responseKind`
and `contentTypeClass`. `target_start_invalid` means the start instant failed the
existing expected-start comparison; `PRICE_PREVIEW_SUBSCRIPTION_SCHEMA_INVALID`
means `availableClientSubscriptions` was not an array. An empty array still passes.

The existing diagnostics runtime provides server-generated request correlation,
sanitization and bounded emission. No bodies, headers, entity IDs, URL/query or
credentials are copied into the new fields. A text shape alone does not prove
whether the original response was invalid JSON. Missing/throwing observers and
diagnostic metadata failures leave the business verdict unchanged.

For an installed flow without the shared observer (or a failing observer), the
router emits `subscription_price_preview_exercise_refused` through `node.log`.
This fallback independently allowlists the same reason/status/shape enums, contains
no IDs or arbitrary text, and emits only on exercise refusal. It uses info level
and a separate event name, leaving the final node's legacy refusal warning/count
unchanged. No global settings/runtime activation is needed for this fallback.

Touched source nodes: onboarding `Capture Viva level PUT result` and subscription
preview `router`. The PUT builder, HTTP nodes, graph wiring, final response node,
pricing rules and writes are unchanged. No flow JSON/import/export is generated.
The source PR is not an installed-flow release packet: a future authorized apply
needs a fresh private live preimage, focused source-driven composition, exact graph
contract and the existing guarded deployment/rollback process.

Owner: backend maintainers. Audience: projection callers and preview diagnostics
operators. Expected observation: invalid non-JSON 2xx cannot report `SYNCED`, while
exercise refusals identify the failed check without relaxing it. Stop signal:
legitimate acknowledgements rejected or a changed preview verdict. Stop method:
hold publication; after an authorized release use only its reviewed rollback.

Local checks run actual functions with synthetic inputs and extracted canonical
exercise helpers; no business API, provider or database access is required:

```sh
node --experimental-strip-types --test scripts/tests/onboardingLevelProjection.nodered.test.ts scripts/tests/correlatedErrorDiagnostics.test.mjs scripts/tests/subscriptionPricePreviewBackend.test.mjs
```

## Onboarding PUT refusal diagnostics

`Capture Viva level PUT result` emits the info event
`onboarding_level_projection_refused` only when its existing verdict is a refusal.
This node-local event is independent of the optional shared observer, so it also
works on installations without that observer. It neither adds another warning nor
changes the legacy HTTP JSON parse warning. Successes produce no new event.

The event describes the status, response shape and refusal from the **same captured
message**, before the capture replaces its payload. Its fixed fields are:

| Field | Allowed values |
| --- | --- |
| `event`, `schemaVersion`, `stage` | `onboarding_level_projection_refused`, `1`, `onboarding_put` |
| `upstreamStatus` | Integer 100–599, or `null` when unknown/invalid |
| `contentTypeClass` | `json`, `html`, `text`, `other`, `missing` |
| `responseKind` | `text`, `object`, `array`, `null`, `missing`, `boolean`, `number`, `other` |
| `bodyClass` | `empty`, `missing`, `invalid_json`, `json_object`, `json_array`, `json_scalar`, `oversize`, `other` |
| `sizeBucket` | `empty`, `lt1k`, `lt64k`, `large`, `UNKNOWN` |
| `parseAttempted`, `parseOk` | Boolean; `parseOk` is `null` when not attempted |
| `refusalReason` | `transport_error`, `status_unknown`, `upstream_status`, `provider_error`, `acknowledgement_invalid`, `UNKNOWN` |
| `projectionStatus` | `FAILED` |
| `suppressedCount` | Capped integer 0–1,000,000 |

MIME classification uses a string of at most 256 characters, discards parameters
and normalizes case. JSON parsing for this event is limited to strings of at most
65,536 UTF-16 code units; size buckets use those units too. Decoded values are not
serialized for sizing. `lt64k` includes the 65,536 boundary. An empty string is
`empty` with a failed JSON parse; whitespace-only text is `invalid_json`.
For example, a retained string containing `{}` has `responseKind=text`,
`bodyClass=json_object`, `parseOk=true` and still fails the unchanged guard.
Classification never turns that string into a business acknowledgement.
For 204, Node-RED substitutes an empty decoded object before capture; the event
cannot reconstruct discarded wire bytes. MIME does not prove body contents,
final origin, redirect provenance, or the cause of a provider failure.

Reason precedence is transport error, unknown status, non-2xx status, provider
error/message, then invalid acknowledgement. No provider text, headers, URL/query,
body, requested value, client/field/game ID or request correlation ID is logged.
The event is a diagnostic record, not an extra HTTP request or proof that the PUT
was not applied. It does not identify a unique user, action or retry. Request-level
correlation to nginx and the final response remains unavailable from this event.

The function uses one node-context entry `onboardingPutDiagnosticBudgetV1`, holding
only `startedAt`, `emitted` and `suppressed`. At most 20 records are admitted per
60-second window per node; after rollover, the first new refusal reports the prior
window's suppression count. There are no timers or per-client keys. A backward
clock does not reset the budget. The quota is consumed before logging; logger
failure, missing/throwing context, or invalid budget state cannot alter business
outputs. Missing context or invalid state omits this event. It does not replace or
rate-limit the pre-existing shared observer; suppression counts cover this event
only. Clearing this context resets the counters; restart persistence follows the
configured Node-RED context store (the default memory store resets on restart).

Owner: backend maintainers. Audience: incident diagnostics operators. Expected
result: the next admitted natural refusal exposes its upstream status and bounded
response classes without a replayed PUT. Stop signal: leaked source data, changed
verdict, or output beyond the stated quota. Stop method: hold publication; any
future installed version uses its separately authorized reviewed rollback.

Source preparation and Draft PR do not activate these diagnostics. An authorized
future release still requires a fresh live preimage and exact source/graph
contract. No SDK/settings change, import/export, deploy or real provider operation
is part of this change. Regression tests pin the pre-existing capture source and
compare its outputs across 544 status/payload/error combinations, plus privacy,
boundary, suppression, logger/store failure and correct-204 checks.
