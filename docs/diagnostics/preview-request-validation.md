# Preview request validation diagnostics

Owner: LK preview backend. Audience: operators investigating an advisory preview
refusal. This change adds source diagnostics only; it does not activate a flow,
observer, sink, or configuration in production.

For `POST /lk/subscriptions/game-price-preview`, the existing entry function
records the first evaluated guard that rejects a request with
`PRICE_PREVIEW_REQUEST_INVALID`. The original boolean guards and their order are
preserved. Conditions are evaluated once; diagnostic derivation never replays a
date check or inspects fields after short-circuit refusal. The auth/body guard
keeps its separate `PRICE_PREVIEW_AUTH_REQUIRED` response. Entry acceptance still
requires the existing server-side session, target, subscription ownership and
provider checks before any quote can be issued.

The final function forwards two optional fields to the existing no-throw
`lkDiagnostics` observer:

| Field | Meaning |
| --- | --- |
| `firstFailedValidationPredicate` | Fixed enum naming the first failed body/target/ID/array/start/duration/share guard; the complete allowlist is in `schema.v1.json`. |
| `validationFieldShape` | `MISSING`, `NULL`, `STRING`, `NUMBER`, `BOOLEAN`, `ARRAY`, `OBJECT`, `OTHER`, or `UNKNOWN`. An invalid array member reports that member's shape; array count/duplicate failures report `ARRAY`. `MISSING` means an undefined value, not an independently established absent property. |

Filter `source=node_red`, `method=POST`,
`routeTemplate=/lk/subscriptions/game-price-preview`, `stage=preview_final`,
`code=PRICE_PREVIEW_REQUEST_INVALID`, and `httpStatus=400`. The shared sanitizer
removes the new fields outside this exact server refusal and maps unknown enum
values to `UNKNOWN`. Older events without the fields remain valid. The published
schema and executable allowlist are generated from the same contract.

The context retains only these two enum values. It never retains a rejected
value for diagnostics. Unknown key names, body contents, URLs/query strings,
auth/session data, target/subscription IDs, dates, clock values and provider
payloads are not added to the event. For an unknown key the diagnostic says
`BODY_EXTRA_KEYS` or `TARGET_EXTRA_KEYS`, never the actual key name. No new raw
logging, identifier or fingerprint is introduced. Existing random diagnostic
request identity, budget and sink behavior are unchanged.

The top-level extra-key check precedes the auth/body check. Consequently
`BODY_EXTRA_KEYS` does not prove that a session or even the auth syntax passed.
Event targets allow omitted `subscriptionIds`; game targets require them. A
syntactically valid ID does not establish existence or ownership. These facts
must not be inferred from entry diagnostics.

HTTP status, error body, response headers, quote eligibility and downstream
guards are unchanged. The fields are internal diagnostics, not response error
details. An absent or failing observer leaves both success and refusal behavior
unchanged. No retry, provider request, database write or queue action is added.

Local checks cover every predicate, field-shape bounds, first-failure ordering,
the pre-auth branch, all four target kinds, valid requests, logger failures,
sanitizer scope and backward compatibility. An AST fingerprint strips only the
diagnostic wrappers and compares the original guard logic and ID grammars with
the pre-change source. A moving-clock and short-circuit test protects against
diagnostic re-evaluation. These fixtures perform no real API/provider/DB calls.

Touched function nodes are `lk_subscription_price_preview_20260908_entry` and
`lk_subscription_price_preview_20260908_final`. The router, topology, routes and
ownership helpers are unchanged. No flow import/export or release packet is
generated. A future authorized deployment must use a fresh live preimage and the
existing reviewed-flow procedure, including the matching sanitizer/runtime;
deploying only the functions against an older sanitizer can drop the new fields.

Stop signal: unexpected diagnostic data, changed refusal behavior or observer
failures. Stop through the existing observer/sink control or an authorized
guarded restoration of the reviewed source. Neither action authorizes changing
validation/ownership guards or replaying a business request. This PR is source
preparation; it does not resolve the missing input evidence for past refusals.
