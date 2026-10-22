# LK1 R05 / R03 / H06 source fixes

Owner: LK1 backend maintainers. Audience: maintainers of the Bitrix scheduled
summary and subscription confirmation flows. The observable source result is
safe rejection of invalid lookup results and preservation of HTTP response
ownership through managed-sale projection. No production rollout is included.

## Historical evidence remains open

The inspected slice covers 21 October 2026 16:57:55 through 22 October 2026
11:48:45 Moscow time, across 37 saved cursor windows. It has 16 R05 TypeError
Node-RED events, 145 R03 missing-response Node-RED warnings, and separately
28 H06 HTTP404 responses. These units are not incidents, attempts or users.

Historical flow SHA256:
`de181b4129ae480d0a0abddee85d72f2783ca4bcc9cdf61c9e3c82f1f66ce39d`.
Tracked implementation baseline:
`da033cb9085b771acf31d20d3845fab49e566823`.

- R05 missing result guard is established. Why Bitrix omitted `result`,
  the upstream status/error code, and the overall scheduled report/delivery
  outcome remain unresolved. The normal deal/activity-summary branch stops at
  the mapper for each recorded TypeError.
- R03's concrete clone/response defect is reproduced locally. Attribution of
  the 145 historical warnings to that branch remains a hypothesis.
- H06's historical executed guard, storage result and business/payment outcome
  remain unresolved. Source404 can arise from a missing or malformed storage
  result as well as a successful empty lookup in the preimage.

Passing regression tests or absence of later errors does not close these causes.

## Source changes and bindings

`patch_lk1_error_sources.mjs` exposes an offline in-memory transform, with no CLI,
flow write, network, restart or import. It rejects absent/duplicate targets,
wrong node types and changed function preimages. It replaces exactly these five
`func` fields and preserves node IDs, wires, routes, configuration and order.
It also verifies replacement hashes from `lk1_error_source_generation.json`.
That source-only successor is registered with the existing newest-generation
resolver and topology-dependent-source rejection list; historical generation
hashes remain frozen. It does not generate or modify tracked import/export or
modular-flow files.

| Case | Node ID | Source helper under `scripts/` | Inspected function preimage SHA256 |
| --- | --- | --- | --- |
| R05 | `4cc92586174530d5` | `nodered_bitrix_nodes/fn_deal_list_result.js` | `1fff442a95178d8ff1ffc073b19e269a5b1f84db3c1b043553b1492f2a425a9a` |
| R03 | `566ae4b886c37ae5` | `nodered_games_nodes/fn_tournament_subscription_purchase_router.js` | `9d34888e6984205562587ac43b598b49903e34d168c08fdd30ac825f22b5990a` |
| R03 | `piter_atomic_router_20260903` | `nodered_games_nodes/fn_tournament_subscription_piter_atomic_router.js` | `10a86299f807943f905cfd9846d35875b370cd94c186205c4eefd6f2e764760e` |
| R03 | `piter_atomic_error_20260903` | `nodered_games_nodes/fn_tournament_subscription_piter_atomic_error.js` | `2e27be3e1b560b41c3000f2c76e4ee2a410e8a2f2d5b86ef960c00f552c51787` |
| H06 | `ca022fd14027a5b0` | `nodered_games_nodes/fn_tournament_subscription_confirm_resolve.js` | `7d6ea160e72b0b31d60acedc4b0571f68a20b8875f0757370b4f8201a750ce7b` |

R05's helper checks transport/status/provider failure and result/record shape
before mapping IDs. Failure emits a fixed enum/status-only warning and no normal
message; valid empty `result: []` remains a valid empty report input. It never
logs the request URL, provider body or recipient, and introduces no retries.

R03 preserves the original foreground `req`/`res` on both pending and bound
managed-sale clones through durable ACK/readback. Background reconciliation keeps
its isolation. Router failures stop with a fixed safe diagnostic. The separate
Mongo catch suppresses its background HTTP output while retaining its existing
internal output; foreground failures still return503 with the original response.
This preserves durable acknowledgment checks and introduces no provider writes
or retries. A blanket missing-res suppression would hide foreground requests and
is not used.

H06 affects `POST /lk/tournaments/summer-subscription/confirm`: a storage error,
non-array result or non-document array entry returns503 with the fixed
`SUBSCRIPTION_CONFIRM_READ_FAILED` code before further operation routing.
A successful empty array remains404; a valid cached paid row retains the exact
baseline output. The client-visible503 classification is intentional and does
not establish the cause of any historical404.

## Verification and future acceptance

Regression entry: `scripts/tests/lk1ErrorSourceFixes.test.mjs`, imported by the
existing CI entry `scripts/tests/productionErrorCauses.test.mjs`.

```sh
node --test scripts/tests/productionErrorCauses.test.mjs
node --experimental-strip-types --test scripts/tests/tournamentSubscription.summer.nodered.test.ts
```

Tests execute complete function bodies with synthetic messages, global/env stubs
and fabricated Mongo acknowledgments. No DB/provider/network capability is
supplied. They cover invalid/empty/valid Bitrix results, both managed-sale clone
paths, exact and uncertain ACKs, matching and failing readbacks, foreground and
background errors including Mongo catch, safe diagnostics, storage failures,
404 compatibility and exact source-binding drift rejection. Fixtures read the
immutable baseline commit, available in the full-history CI checkout.

A future rollout requires a fresh private live preimage, a reviewed full-flow
identity/topology/contract, explicit authorization and runtime acceptance. The
in-memory source binder is not a deployment contract. Historical exact-pinned
activation/updater constants remain unchanged; they must continue rejecting
incompatible integrated sources. Do not regenerate a broad games flow over the
live preimage to install these fixes. No release candidate or production import
is prepared here.

Stop signals for future acceptance: invalid Bitrix responses entering the normal
summary path, a foreground response losing its original object, background
traffic reaching the HTTP sink, or storage failure becoming not-found. Stop the
acceptance run and retain its safe evidence; there is no activation flag or live
rollback action in this source-only change.
