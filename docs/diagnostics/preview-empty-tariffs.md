# Empty event tariff diagnostics

Owner: LK1 backend. Audience: incident investigation. This change observes the
existing refusal on `POST /lk/subscriptions/game-price-preview`; it does not fix
tariff configuration, select another tariff, or calculate a fallback price.

The `lk_subscription_price_preview_20260908_router` source calls the optional
shared observer after the existing transport, completeness and request-scope
guards, only when canonical extraction returns zero rows. It emits an `audit`
event at `preview_router`, code `PREVIEW_EMPTY_TARIFF_OBSERVED`, reason
`empty_tariff_list`. The original `LK1_EVENT_TARIFF_AMBIGUOUS` HTTP 503 and its
response details remain unchanged. Count the audit separately from the final
refusal event; they describe the same request, not two failures. Other guards,
multiple/invalid tariffs, and successful quotes do not emit this audit.

`scripts/diagnostics/preview-empty-tariffs.mjs` inspects only the already-read
reply. `runtime.mjs` emits the facts through the existing allowlist sanitizer and
detail budget. Missing/failing observation does not change the business result.
No provider/DB read, retry, write, new dependency or runtime setting is added.

| Evidence | Meaning and limit |
| --- | --- |
| `correlationHash` | `c1:` + domain-separated SHA-256 of a fresh server diagnostic request ID. Stable across preview stages sharing the request object, including middleware/terminal events when installed. Never derived from `_msgid`, incoming headers, entity IDs or provider data; no HMAC key required. |
| `upstreamStatus`, `responseKind` | Exact integer 100–599 only; scalar/object/array/missing enum. Numeric strings are omitted rather than coerced. This does not attest that a JSON parser ran. |
| `tariffCompleteListGuardPassed`, `tariffExtractedEmpty` | Facts inferred from this hook's position, not a replacement parser. The actual canonical helpers and their order remain authoritative. |
| `tariffListShape`, `tariffRecognizedArrayCount` | Root/direct/nested/no recognized array, and bounded count of array paths encountered. This describes observed shape, not a new choice of tariff or a claim that all envelopes are supported. |
| `tariffShadowedNonemptyArray` | A recognized nonempty array was found even though canonical extraction returned zero. It is evidence for shadowing, not proof that the hidden record is an applicable tariff. |
| `tariffAlternateArrayPresent`, `tariffAlternateNonemptyArray` | Arrays under the fixed alternate names `products`, `tariffs`, `rows`. These collections remain unsupported by the business parser. No arbitrary field names are enumerated or logged. |
| `tariffShapeScanTruncated`, `tariffShapeScanFailed` | At most 64 unique objects, depth 6, fixed envelope keys, no array elements or property getters. After truncation, negative absence flags are omitted; a positive witness can remain. On exception, absence/shadowing flags are omitted and failure is reported. |
| `tariffBindingContextPresent`, `tariffMethodMatch`, `tariffRequestScopeMatch` | Presence of context and comparisons to the exact expected GET request. No URL, tenant or query value is emitted. |
| `tariffTenantScopeMatch`, `tariffExerciseScopeMatch` | Comparisons of the request URL to the current context. They do not independently prove that the context selected the correct tenant or exercise. |
| `tariffResponseUrlPresent`, `tariffResponseScopeMatch` | Absence is explicit. Match is omitted if no response URL was supplied; the existing guard continues to allow that absence. |
| `tariffEventIdentityMatch`, `tariffEventCategoryMatch`, `tariffEventStartMatch` | Comparisons of the retained exercise/target using the existing category/start helpers. Missing evidence is omitted. No IDs, type IDs, dates or times are emitted. |

The additive fields are documented in `schema.v1.json` and its generator. The
correlation hash is accepted by the sanitizer only on server-side preview events;
client telemetry cannot claim that hash. Existing `requestId` can be hashed
offline with `SHA256("lk-preview-request-v1" + NUL + requestId)` to join these
events. An access log join requires the same server request ID to already be
available there: this PR adds no nginx configuration, response header or provider
forwarding. The hash is not proof of a real user or of synthetic origin.

Activation remains separate. Source-only hooks produce no new tariff audit when
the shared observer is absent. The November 12 cross-day-only node-local adapter
does not admit this event. Any future installation needs the matching shared
runtime/sanitizer and this router hook, a fresh verified live preimage and a
separately reviewed focused deployment; do not regenerate an older live business
graph from main. No flow import/export or deployment candidate is produced here.

Stop signal: unexpected diagnostic data, response drift, missing boundedness or
increased logger failures. Stop method: remove/revert this optional hook and its
observer through the approved source/release path. It must not relax the tariff
guard, restart a service or change a shared setting as part of diagnosis.

Local verification uses mocked replies and the real source router/final, schema,
observer and extracted canonical list helpers:

```sh
node --test scripts/tests/subscriptionPricePreviewBackend.test.mjs scripts/tests/correlatedErrorDiagnostics.test.mjs
```

Covered cases include supported empty shapes, shadowing, unsupported envelopes,
missing response provenance, identity/category/start mismatches, earlier guards,
valid/multiple/invalid tariffs, correlation ownership, client spoofing, bounded
cyclic/deep inspection, getters, and failed log sinks. No test here calls a
provider or DB. Full private-flow integration cases retain their existing skip
when the exact private fixture is unavailable. A successful synthetic test does
not establish provider configuration or a real booking/payment outcome.
