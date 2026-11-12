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
