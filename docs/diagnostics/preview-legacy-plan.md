# Legacy-plan preview refusal diagnostics

Owner: LK subscription preview maintainers. Audience: operators investigating
`PRICE_PREVIEW_LEGACY_PLAN_UNRESOLVED` on the game-price preview route. A refused
legacy quote emits one bounded info observation named
`subscription_price_preview_legacy_plan_refused` at `preview_router`, step `next`.
It is an observation of the existing refusal, not another request or HTTP error.
Do not add it to canonical HTTP or final legacy-warning counts.

The plan/ownership/provider guards, their order and short circuit are unchanged.
The plan resolver and compatibility resolver still run exactly once, with their
original arguments. The diagnostic runs only inside the failed legacy guard;
it never calls a resolver, scans provider records, reads a database, retries, or
changes a quote. The response remains HTTP 503 with the existing `error.code`;
partial quotes still do not appear in that response. Earlier refusals, successful
quotes, managed evaluations and the event-route legacy fallback emit no new info.

| Field | Meaning / allowed values |
| --- | --- |
| `previewLegacyPlanVerdict` | `NO_PLAN`, `OPEN_GAME_EXCLUDED`, `UNKNOWN`; derived from the effective plan already used by the failed guard |
| `previewLegacyRuleDisposition` | `NO_MATCH`, `SALE_BEFORE_CUTOFF`, `STATION_EXCLUDED`, `MANAGED`, `UNKNOWN`; derived from the already-returned shared-rule verdict |
| `previewLegacyResolverEvidence` | `NO_RECOGNIZED_MARKER` when the effective resolver result is absent; otherwise `UNKNOWN` |
| `previewTargetKind` | `NEW_GAME`, `EXISTING_GAME`, `UNKNOWN`; the existing server-side route-context boolean |
| `previewLegacyOrigin` | Always `UNKNOWN`; no trusted server origin marker currently exists |
| `previewLegacyRequestedCountBucket` | `ONE`, `MULTIPLE`, `UNKNOWN`; request selection cardinality without identities |
| `previewLegacyPartialQuotesDiscarded` | Optional boolean: previously accumulated quotes are hidden by this request-level error |
| `previewLegacyBoundNamePresent` | Optional boolean: a nonblank bound catalog name exists; its content is never emitted |
| `previewLegacyFactsFailed` | Boolean: optional fact derivation failed; remaining fields may be unknown/absent |

`NO_MATCH` does not distinguish an absent rule set from a rule set with no matching
product. `NO_RECOGNIZED_MARKER` describes the resolver result, not which marker
source was inspected. The shared resolver exposes no branch trace: this change
does not invent `KNOWN_EXACT_PRODUCT` or `BOUND_NAME_MARKER` evidence, duplicate
its matching rules or inspect its source at runtime. `SALE_BEFORE_CUTOFF` requires
a plan-sourced legacy verdict with formatted purchase/cutoff dates in that order;
neither date leaves the function. Station exclusion is taken from the shared
resolver's explicit flag. An unrecognized verdict stays `UNKNOWN`.

The event contains only fixed metadata, enums and booleans. It contains no raw
plan key, name, product/subscription/actor/target identity, provider body, URL/query,
IP, headers, dates, amounts, auth, exception text or stable fingerprint. Optional
fields use own data descriptors and never execute accessors or coerce objects.
One diagnostic cannot inspect more records as the subscription batch grows.
The shared sanitizer and JSON schema allowlist the same new facts.

The dedicated info sink works with missing, throwing or silently filtering scoped
observers; it does not change observer lifecycle, budgets or final warning logic.
If fact derivation or the log sink throws, the original refusal still runs. If no
info sink exists, no event is emitted. There is at most one new event per refused
request, using the existing process logger; successful requests emit none.

Local tests run the actual router/final with source-bound pure helpers and the
shared rule resolver on synthetic fixtures. They compare results and helper-call
order with the original guard, including lifecycle/identity/schema/provider scope,
transport/timeout, daily conflict, event and managed routes, old sales, station
exclusions, quote batches, accessors, sinks, sanitizer and schema privacy.
No private flow fixture is required for these tests and no network call is made.

This is source-only preparation for `POST /lk/subscriptions/game-price-preview`,
function `lk_subscription_price_preview_20260908_router`. No import/export flow,
runtime setting, dependency, configuration, write endpoint or deployment workflow
is changed. Any future activation needs separate authorization and a fresh exact
live preimage with a source-preserving focused patch; do not replace an installed
router wholesale with a regenerated older graph. Local mocks need no live pull.

After authorized activation, accept evidence only from natural traffic with
confirmed source provenance. Use verdict + rule disposition to distinguish a
missing plan from a scope exclusion. A natural `NO_PLAN` still needs separate
evidence to explain the unrecognized server-bound mapping; `OPEN_GAME_EXCLUDED`
requires confirming that the exclusion is intended for that target/contour.
Timestamp equality does not establish HTTP request identity. Server-side exact
pairing and trusted synthetic/natural origin are not added here. Historical
refusals, unique users and payment/booking impact remain unknown; a quiet window
does not close them. Keep plan/ownership/provider guards fail-closed.

Stop on changed HTTP outcomes, new transport calls, unexpected log growth, raw
fields or source drift. Disable by reverting this diagnostic diff through the
authorized reviewed release mechanism; removing diagnostics does not repair a
bad mapping or change subscription policy. No feature flag or live action is
introduced by this PR.
