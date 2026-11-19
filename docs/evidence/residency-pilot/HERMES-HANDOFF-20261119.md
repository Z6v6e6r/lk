# Hermes handoff: residency pilot browser artifacts and activation guard (2026-11-19)

From the current PR #452 head; the exact source commit is in `frontend/release.json` in the
packet. The browser code is unchanged from the previous pilot artifact; the server custom
node now has the read-only GET contract and the pre-activation conflict guard.
No real Viva/CUP/Keycloak call, no payment, no 147 change.

## Artifacts to use

| Role | File / identity | Bytes | SHA-256 |
| --- | --- | --- | --- |
| Old published client (exact) | <code>artifacts/published-legacy-bundle.js</code>, release <code>20261118T164240Z</code>, source <code>27ea6a8c1665789786b8a6c6fc9c657dc48483ed</code> | 2 946 728 | <code>fce60c89044f95ef7ec9faf1d53267dfce87fcc996efa00dbacee87ab50485be</code> |
| New pilot client (packet) | <code>frontend/bundle.js</code> from <code>residency-pilot-install-20261119</code>, source = <code>frontend/release.json</code>, <code>prepared-not-published</code> | 2 976 424 | <code>0a83dbc72dc6c55549bab42ce597aa65089f9eca94f3577d803b04e018cbd59e</code> |
| Local synthetic bf3 (not production) | <code>artifacts/residency-client-bf3/bundle.js</code> | — | <code>4c3fdca47c6442e9a07801450558de78e7b1600160bc74e343d2f59c8db02c72</code> |

Packet: <code>residency-pilot-install-20261119</code>; <code>SHA256SUMS</code> and the exact
source commit are inside. Do not substitute the synthetic bf3 build for the packet artifact
in accepted results.

## Shared composition snapshot

| Object | Count | SHA-256 |
| --- | --- | --- |
| <code>artifacts/lk1-slice.flow.json</code> (LK1 after Codex) | 54 nodes, 3 http-in | <code>ae9924dc78c4f2035cd3c5861c9291655c4800c0805ccc034bc2fbca100b213f</code> |
| <code>artifacts/joint-acceptance.flow.json</code> (LK1 + residency) | 73 nodes, 18 http-in | <code>94202a84b8e1f253b415905a88c1f85881df4ded05d002bdee47a078e5864f0c</code> |

These are composition slices, not the full 147 <code>flows.json</code>. The full 147 preimage
is a separate read-only step at apply time.

## Browser session contract (the previous synthetic issuer mismatch)

The old client's legacy bootstrap reads <code>localStorage.padlhub_auth_token_v1</code>.
Seed it before page scripts:

    {"token":"<JWT>","expiresAt":<future ms>}

JWT payload (unsigned is enough for the fixture): <code>sub</code>, <code>phone</code>
(e.g. <code>+15550000000</code>), <code>azp:"widget"</code>,
<code>tenant_key:"iSkq6G"</code>, <code>exp</code>. Do not use a synthetic OIDC issuer;
the old bootstrap does not consume it. The new client uses the same storage key and calls
<code>/lk/residency/*</code> with this bearer.

Interception:

- <code>https://api.vivacrm.ru/end-user/**</code> → <code>https://residency.fixture:9443/viva/end-user/**</code>
- <code>https://api.vivacrm.ru/api/**</code> → <code>https://residency.fixture:9443/viva/api/**</code>
- <code>https://kc.vivacrm.ru/**</code> → <code>https://residency.fixture:9443/kc/**</code>
- <code>https://joint.fixture/lk/residency/**</code> → <code>http://nodered:1880/lk/residency/**</code>
- all other external origins → 204/abort; no real calls.

Pages: old <code>https://joint.fixture/lk_new?buyResidency=1</code>, selector
<code>[data-ph-buy="residency"]</code>; new
<code>https://joint.fixture/lk_new?buyResidency=lifecycle</code>, CTA
«Стать резидентом · 790 ₽».

## Expected acceptance results

| Check | Expected |
| --- | --- |
| Old artifact renders | card «Резидент», 790 ₽ / 30 дней |
| Old click | exactly one <code>POST /end-user/api/v1/iSkq6G/transactions</code>; zero <code>/lk/residency/*</code> |
| New create closed (<code>CREATE_ENABLED=false</code>) | direct <code>POST /lk/residency/orders</code> → 503 <code>RESIDENCY_ORDERS_DISABLED</code>; old POST still succeeds (residual) |
| New pilot page | catalog/status 200, CTA visible |
| OPTIONS on the stand | 204 from the stock gateway; the current stand wrapper returns 200 — any unauthenticated 2xx is acceptable |
| Create without Idempotency-Key | 400 <code>RESIDENCY_IDEMPOTENCY_KEY_REQUIRED</code>, no order, no provider POST |
| Ordinary account | 403 <code>RESIDENCY_CREATE_NOT_ALLOWED</code>, zero orders |
| Pilot create | one 200, one order, one Viva transaction |
| Pay + return/reconcile | ACTIVE, one window from paymentDate, no second link |
| Stop create | new create 503; read/reconcile 200; original order completable |
| Race | old transaction appears during new POST → no second payment link, payment <code>UNKNOWN</code>, <code>UNKNOWN_OUTCOME</code> |
| Two devices | one 200 + one 409, one order, one Viva transaction |

The old path creating a transaction while the new create is stopped is expected and must be
reported as the residual risk, not as a new-service failure.

## Activation guard acceptance (new head)

The server now guarantees:

- <code>GET /orders/{id}</code>, <code>GET /orders?state=unresolved</code> and
  <code>GET /orders/{id}/payment</code> are projections. They do not change state,
  revision or <code>activeSlot</code>, do not read the provider in the payment endpoint,
  and send **0** CUP `residency-booking-refresh` commands.
- Every activation path (immediate PAID create, reconcile, late read, expiry sweep) first
  reads the provider's external transaction list. `OPEN`, `UNKNOWN` or a `PAID`
  operation created at/after the order blocks activation. An unavailable list is
  fail-closed.
- A conflict ends in `PAID_REQUIRES_REVIEW` / `EXTERNAL_PAYMENT_DETECTED` with
  **0** activation calls.
- One confirmed payment activates exactly once: first reconcile 1, repeated reconcile 1,
  restart + reconcile 1. A stale `IN_FLIGHT` after a crash is finalized from CUP
  `residency-booking-context` (refresh false), so a successful first refresh is not
  repeated; an unreadable context is retryable without a refresh command.
- `GET /orders?state=unresolved` computes `externalCheck` over recently terminal orders
  too, so an ACTIVE activation cannot hide a later external PAID operation.

| Case | Expected |
| --- | --- |
| Any of the three GETs after the local window | 200, same durable row/revision, 0 CUP activation |
| External `OPEN` / `UNKNOWN` / `PAID` conflict at reconcile | `PAID_REQUIRES_REVIEW`, 0 activation, 0 CUP |
| Conflict at immediate PAID create | `PAID_REQUIRES_REVIEW`, 0 activation |
| Single confirmed payment, repeat + restart | exactly 1 activation total |
| Stale `IN_FLIGHT` after a crash, CUP context ACTIVE | finalized from context, 0 second refresh |
| ACTIVE order + later external PAID | list `count=0`, `paidAfterOrderCount=1`, `requiresReview=true` |

Evidence: `docs/evidence/residency-pilot/activation-guard-20261119/` and the packet's
`evidence/activation-guard-20261119/`. Synthetic only; no real Viva/CUP/payment.

## Stand hygiene before acceptance

The disposable <code>joint_residency_delivered_20261118</code> currently has one lifecycle
order from the installation checks. Reset that collection (or use a fresh database) before
the acceptance journey so the new page starts with <code>count=0</code>. The stand's
synthetic <code>iSkq6G:10000000-…-0001</code> identity is fixture-only and must not be
carried to 147.