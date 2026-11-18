# Isolated composition: published old bundle + new gateway (2026-11-18)

Status: isolated test only. Node-RED, MongoDB, Viva, CUP and Keycloak are local fixtures;
`147` was not contacted, no live import or index was applied, no real payment was made.
Harness: `scripts/pilot-composition/`.

## Artifacts actually executed

| Artifact | Identity |
| --- | --- |
| Published old LK1 bundle | `https://padlhub.su/lk/bundle.js`, version `20261118T164240Z`, source `27ea6a8c1665789786b8a6c6fc9c657dc48483ed`, sha256 `fce60c89044f95ef7ec9faf1d53267dfce87fcc996efa00dbacee87ab50485be`, 2 946 728 bytes |
| New pilot bundle | this branch, production build, sha256 `0a83dbc72dc6c55549bab42ce597aa65089f9eca94f3577d803b04e018cbd59e`, 2 976 424 bytes (harness run used the same source with local `VITE_RESIDENCY_PASS_API_BASE`) |
| Custom node | sha256 tarball `00452423a223ab5b8e3a6c66fad7df2a3f5fdf38cc35962c8a9b6b646259d519`, per-file hashes in `hashes.txt` |
| Import | `lk_residency_lifecycle.import.json`, sha256 `22e524fbfae2a307b7610b29c4d68bb67e66997e7c71da54fd426b3c9042caa7`, 19 nodes, 8 API routes + OPTIONS |
| Node-RED | `nodered/node-red:4.0.9-22`, Node 22.14.0 in the container (147 runs Node 22.23.2) |
| MongoDB | `mongo@sha256:7bd28e5e…` (8.0.5), disposable `lk_residency_pilot` |
| Indexes | five reviewed specs, `indexes.json` / `environment.txt` |

## The published old bundle really posts to Viva directly

Playwright executed the downloaded bytes unchanged on `https://127.0.0.1:8444` (same origin
model as the production page). Clicking `[data-ph-buy="residency"]` produced exactly:

```text
GET  /end-user/api/v1/iSkq6G/products/subscriptions/4037a3a3-…   (price/terms)
GET  /end-user/api/v1/iSkq6G/profile
POST /end-user/api/v1/iSkq6G/transactions                          (the financial command)
```

and no request to `/lk/residency/*`. The request host is `https://api.vivacrm.ru`
(`Ea`/`API_BASE`), i.e. the browser talks to Viva directly; the gateway has no hook before
that POST. Static evidence: `docs/evidence/residency-pilot/published-bundle-20261118T164240Z.txt`.

## Backend results (real HTTP through the custom node + Mongo)

`backend-http.txt` is the verbatim transcript; summary:

| Step | Result |
| --- | --- |
| old transaction exists (UNPAID) | `POST /orders` → 409 `RESIDENCY_EXTERNAL_PURCHASE_PENDING`, Mongo orders 0, zero provider POSTs |
| old transaction CANCELLED (confirmed terminal) | `POST /orders` → 200 PENDING_PAYMENT |
| provider paid + CUP refresh | reconcile → ACTIVE, one order, one transaction |
| new order first, old checkout second and paid | unresolved read → `externalCheck.openCount=1, requiresReview=true`; reconcile → `PAID_REQUIRES_REVIEW` / `EXTERNAL_PAYMENT_DETECTED`, payment stays PENDING, activation 0 |
| ordinary account | 403 `RESIDENCY_CREATE_NOT_ALLOWED`, Mongo orders 0 |
| two simultaneous creates | 200 + 409, one order, one Viva transaction |
| `CREATE_ENABLED=false` | create 503 `RESIDENCY_ORDERS_DISABLED`; GET orders/reconcile still work; after restart the original order completes ACTIVE without a new purchase |
| race: old transaction created during the new POST | order stays `PENDING_PAYMENT` with payment `UNKNOWN`, no payment URL, `UNKNOWN_OUTCOME`; both Viva transactions exist but the new UI never exposes a second link |

## Browser scenarios

`e2e-scenarios.json`, all five `pass: true`:

| Id | Result |
| --- | --- |
| A old→new | new screen shows "Сервер обнаружил покупку резидентства…"; `new_create_posts=0`; server `externalCheck.requiresReview=true`; old page's only financial POST is the direct Viva transaction |
| B new→old | new order `PAID_REQUIRES_REVIEW`, `EXTERNAL_PAYMENT_DETECTED`, old transaction still exists and was paid on the fixture; no activation and no second new order |
| C two devices | create statuses `[200, 409]`, Mongo orders 1, new Viva transactions 1 |
| D stop/recover | stop create → 503; existing order visible; old frontend loads; restart → pay → ACTIVE; one transaction total |
| E ordinary | new create 403, zero orders; old checkout still creates its transaction |

## Guarantee and boundary (read this before the pilot)

Implemented server-side:

1. **new→new**: Mongo active-slot partial unique index + unresolved-order check; two tabs,
   two devices and concurrent requests produce one order and one provider POST.
2. **old→new**: before any new order/provider POST the gateway lists the client's Viva
   transactions for the product in a 30-day window (Viva Admin API) and refuses with 409
   when an open/unknown operation, or a paid one without an active residency, exists.
   A failed/partial/unavailable list fails closed (503) instead of allowing a second command.
3. **new→old**: not preventable. The published old client posts directly to Viva. The
   gateway detects the second operation and, when it is paid after the new order, moves the
   new order to `PAID_REQUIRES_REVIEW` (`EXTERNAL_PAYMENT_DETECTED`) instead of activating;
   the unresolved read exposes `externalCheck` so the screen blocks a new purchase.

Residual, not hidden:

- the old→new check is a read before the POST, not an atomic provider-side constraint. A
  Viva transaction created between the read and the POST is not prevented; it is detected
  on the next read/reconcile.
- the reverse direction can still create and charge a second Viva transaction. For a
  one-account pilot the owner must either (a) accept this with the operator present and the
  old page not linked, (b) hide/disable the old Viva product for the pilot window and give
  the new flow a separate pilot product id (requires Viva/CUP configuration and contract
  change), or (c) publish a reviewed old-client change that removes the residency CTA.
  None of these is authorized or performed here.

## Preimage tool

`preimage-check.txt` runs the packet's `preimage-check.mjs` against the pinned 316-route
snapshot (converted to http-in nodes) and against an injected lifecycle route. The full
`flows.json` still has to be pulled at apply time; this is a tool check and route-separation
proof, not the fresh preimage.

## Limits of this evidence

- synthetic bearer tokens; the real Keycloak `sub` of Alexey is still unknown;
- fixture Viva/CUP shapes are contract-shaped, not the live responses;
- container Node is 20.19.0, 147 runs 22.23.2; the custom node uses only stable Node APIs;
- the new bundle in the harness was built with local `VITE_RESIDENCY_PASS_API_BASE`; a
  published artifact must be built with the normal release environment and re-hashed;
- the isolated Node is 22.14.0 vs 22.23.2 on 147 (same major, no API difference used here).
