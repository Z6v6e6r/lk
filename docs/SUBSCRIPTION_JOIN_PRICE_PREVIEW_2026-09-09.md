# Subscription price and limits before joining a game

Stage: implemented and locally verified; user verification pending.
MODEL_ROUTE: parent
Risk: R3 (subscription prices and ownership). Base: `160180124d5708f2a71f0480f6e6dc682620158f`.

Both game-details entry points now load the existing product binding/name lookup, then request the same advisory price evaluator used by CREATE. Each purchased subscription displays its participation amount and paid overage, or an unavailable/exhausted state. A pending or failed quote cannot enable subscription checkout. Card payment remains available independently; the explicit refresh retries the advisory read.

Candidate filtering only applies game category/station compatibility. Balance and lifecycle are evaluated by the server, so an exhausted subscription can explain its limit and an annual 90-minute subscription with one visit is not prematurely hidden by the legacy two-visit filter. The existing payment endpoint rechecks current entitlement and price. The displayed amount is never sent as debit authority.

## Contract and source scope

`POST /lk/subscriptions/game-price-preview` additionally accepts:

```json
{"target":{"targetKind":"EXISTING_GAME","gameId":"pay_fixture","startsAt":"2099-09-23T07:00:00+03:00","durationMinutes":90},"subscriptionIds":["00000000-0000-4000-8000-000000000002"]}
```

The server authenticates the profile, reads exactly one `lk_games` record by ID, resolves stored exercise/station/room/master-service/subservices and the shared singles/doubles helper, and reads the actual exercise with the user's Viva token. Mismatched time, duration, location, ID, cancellation, malformed records, incomplete ownership or failed reads stop the quote. The existing tariff endpoint, instance-scoped booking/operation counters and policy evaluator compute the result. No price, discount, benefit balance or actor identity is accepted from the browser.

Existing NEW_GAME requests remain compatible. Both variants retain bounded requests, cancellation and explicit refresh; account/target/options changes invalidate the displayed scope. Preview itself only performs Viva GET and Mongo find. The preceding, already-existing product lookup may bind missing metadata under its own verified-ownership lease.

Existing graph upgrade `composeSubscriptionJoinPricePreviewArtifacts` changes three nodes:

- `lk_subscription_price_preview_20260908_entry`: request union and selection key.
- `lk_subscription_price_preview_20260908_router`: existing game validation and sixth output.
- `lk_subscription_price_preview_20260908_catch`: include the new read node.

It adds `lk_subscription_price_preview_20260908_games` (`lk_games`, find) and preserves other nodes, route IDs, configuration and ordering. Exact preimages and the reviewed-flow contract reject drift. No generated flow/import is committed. The builder requires the instance-scoped gateway/evaluator already present in main; runtime compatibility must be freshly checked before an approved deployment. An older runtime must not receive this preview alone over incompatible counter logic.

## Changed files

- `src/components/games/{GamesPage,GameJoinPage}.tsx`: load and guard subscription join quotes.
- `src/components/games/JoinSubscriptionOptions.tsx`: shared choices, exact amounts, limits, retry and accessible price descriptions.
- `src/components/games/{subscriptionPricePreview,useSubscriptionPricePreview}.ts`: existing-game target identity and shared hook documentation.
- `src/MyApp.css`: responsive join option layout.
- `scripts/nodered_subscription_price_preview_nodes/{entry,router}.js`: GET/find-only existing-game preview.
- `scripts/patch_nodered_subscription_price_preview.mjs`: source-bound helpers and guarded graph upgrade.
- `scripts/tests/subscriptionPricePreview{,Aside,Backend,Hook}.test.*` and `splitSubscriptionLifecycleSource.test.ts`: regression cases.
- `docs/WORKLOG.md` and this report: evidence and remaining gates.

## Verification

- Critical subscription matrix plus preview/instance/lifecycle/decision suites: 568 tests, 560 PASS, 8 SKIP, 0 FAIL. Private fixture-backed JOIN and graph-upgrade tests ran, including 60/90/120 minutes, free/surcharge, singles share, legacy last-visit rejection, annual last-visit acceptance, separate instance limits, malformed/foreign/duplicate targets, cancellation, provider failures and zero write-capable paths.
- Eight skipped tests require other exact-flow fixtures or isolated nginx/Docker; they are not counted as passes.
- Full `npm run build` (prod and dev): PASS with inert compile-time configuration. After final UI adjustments, TypeScript and affected root/games prod/dev bundles: PASS. These are verification builds, not publishable release artifacts.
- Full lint: zero errors; existing warnings remain. Final scoped frontend lint: zero errors, 10 warnings in the existing GamesPage component.
- Independent payment-safety review: PASS, no blocking findings.
- Actual React component and application styles rendered in a loopback-only fixture at desktop and 390px width. Verified individual prices, exhausted/unknown/loading disabled choices, retry and no console warnings/errors. The fixture initially omitted global border-box and was corrected to match `src/index.css` before the final mobile check.
- Local interactive example: http://127.0.0.1:8879 (synthetic data; no backend booking/payment calls).

## Limits and transitions

No real JOIN, booking, payment, subscription debit or shared database mutation was executed. No merge, push, Draft PR or deployment occurs in this stage. The original checkout and earlier task worktrees are preserved. A local task-branch checkpoint is prepared after the reviewed diff and secret/PII scan.

Integration, main push and deployment retain separate user gates. Before deployment: fresh runtime preimage, compatible instance-scoped counters, exact candidate review, then frontend/backend publication and real-session read-only postchecks. Actual paid participation is a separate explicitly authorized user action.
