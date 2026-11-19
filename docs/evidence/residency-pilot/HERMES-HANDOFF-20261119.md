# Hermes handoff: residency pilot browser artifacts (2026-11-19)

From PR #452 head <code>a7ca3270</code>; local stand installed from the 25-file packet.
No real Viva/CUP/Keycloak call, no payment, no 147 change.

## Artifacts to use

| Role | File / identity | Bytes | SHA-256 |
| --- | --- | --- | --- |
| Old published client (exact) | <code>artifacts/published-legacy-bundle.js</code>, release <code>20261118T164240Z</code>, source <code>27ea6a8c1665789786b8a6c6fc9c657dc48483ed</code> | 2 946 728 | <code>fce60c89044f95ef7ec9faf1d53267dfce87fcc996efa00dbacee87ab50485be</code> |
| New pilot client (packet) | <code>frontend/bundle.js</code> from <code>residency-pilot-install-20261118</code>, source <code>a7ca3270</code>, <code>prepared-not-published</code> | 2 976 424 | <code>0a83dbc72dc6c55549bab42ce597aa65089f9eca94f3577d803b04e018cbd59e</code> |
| Local synthetic bf3 (not production) | <code>artifacts/residency-client-bf3/bundle.js</code> | — | <code>4c3fdca47c6442e9a07801450558de78e7b1600160bc74e343d2f59c8db02c72</code> |

Packet: 25 files, <code>SHA256SUMS</code> <code>3bd31d631a155b1c07e7301d4ebb45b055b1952a573477baa546500526a69c2b</code>.
Do not substitute the synthetic bf3 build for the packet artifact in accepted results.

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

## Stand hygiene before acceptance

The disposable <code>joint_residency_delivered_20261118</code> currently has one lifecycle
order from the installation checks. Reset that collection (or use a fresh database) before
the acceptance journey so the new page starts with <code>count=0</code>. The stand's
synthetic <code>iSkq6G:10000000-…-0001</code> identity is fixture-only and must not be
carried to 147.
