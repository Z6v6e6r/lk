# LK1 PITER-only managed enforcement gate — 2026-08-28

## Scope and custody boundary

This is a source-only candidate built from repository `main`
`6edbf010f729b45cf37dadc82bbeccb7233e1594` (tree
`5f8db8b30232d464012121c325a0927df86f4f3a`) and the exact read-only LK1 flow
preimage below. It does not authorize or perform Node-RED import, runtime-global
configuration, production mutation, Ready, merge, or deployment.

## Server-owned rollout contract

- Global: `subscriptions_managed_enforcement_product_ids`.
- Accepted representation: an array of UUIDs or a JSON string containing that
  array. UUIDs are lower-cased, deduplicated, and sorted before use.
- Missing, null, blank, or empty configuration is safe and enables no managed
  product. A malformed type, JSON value, or UUID fails closed before CUP or Viva
  writes with `MANAGED_SUBSCRIPTION_ENFORCEMENT_CONFIG_INVALID`.
- PITER product `8bf334ba-3050-4017-b40a-7eef2db1eb16` enters the managed CUP
  path only when the same exact server-owned product identity is in the global
  and the actor-owned Viva subscription has `purchaseDate(Europe/Moscow)` on or
  after `2026-09-01`.
- PITER subscriptions sold before `2026-09-01` remain on the ordinary
  Friendship compatibility path. For an allowlisted exact PITER product, a
  missing, invalid, or conflicting server-side sale date fails closed with
  `SUBSCRIPTION_PURCHASE_DATE_UNRESOLVED`; browser-supplied dates are ignored.
- HUB product `db7a5250-7369-4f43-8ac5-9111be24bc74` never enters the managed
  path in this candidate, even if its UUID appears in the global.
- Product names, browser fields, `planKey`, and a caller-supplied gate object
  cannot enable managed enforcement.
- Direct and split CREATE/JOIN use the same router and the same gate.
- The exact server-owned product identity, authoritative sale date, and rollout
  decision are re-read after operation preaccept and before the provider write.
  Product, cutoff eligibility, or rollout drift is persisted as a failed
  operation and emits no Viva write.
- Exact PITER/HUB products that are not enabled keep the ordinary Friendship
  compatibility path; rollout-off alone does not invent a rejection or runtime
  dependency.

## Exact live preimage (read-only)

- flow SHA-256: `9e9698ea3e7cfa0bd2b42a95a7eed20a82436cb06f40ecd80c13896a1960b263`;
- nodes: 4762; tabs: 55 (29 enabled, 26 disabled);
- HTTP inputs: 215 (134 enabled, 81 disabled);
- broken wires: 0; broken links: 0;
- enabled target: `lk_subscription_booking_router_20260804`, `LK Games`,
  `Route atomic subscription booking`;
- target preimage SHA-256:
  `11c4b80c2624ad97fc83f634139d0db7d36aebb8df8a525bdc7baae3e9bae0fd`;
- enabled semantic duplicates of the target: 0; disabled tabs remain inert;
- three independent pulls, including the final pre-checkpoint refresh, produced
  the same full-flow digest.

## Deterministic candidate

- router function SHA-256:
  `0a580112d576cc41f0710a858b0423e56c78587142fa2f4993d94138851a8cfa`;
- unified candidate SHA-256:
  `703c065429bcee016e86ac7559c3b834754bab61bcb5c70f4da55b1cc32064ca`;
- candidate nodes: 4812; HTTP inputs: 215; tabs: 55;
- changed existing nodes: 54; added nodes: 50;
- broken wires: 0; broken links: 0;
- split pricing mutations: 0;
- A3/pay source preimage contract remains pinned to the same live flow digest.

The candidate builder rejects source digest drift, target preimage drift,
enabled-tab identity drift, and a second enabled function with the same semantic
target identity. Disabled semantic duplicates remain inert.

## Differential evidence

The gateway and candidate tests cover PITER enabled/empty, HUB, managed-looking
names, browser/plan/gate spoofing, malformed and conflicting server identities,
direct/split CREATE/JOIN, exact product and rollout TOCTOU drift, runtime-context
rechecks, generic PATCH closure, payment confirmation, split cleanup, graph
health, deterministic candidate output, and enabled/disabled duplicate handling.
The local differential run sets `LK1_SUBSCRIPTION_LIVE_FLOW_FIXTURE` to the
fresh pulled `source.flow.json` and executes the pinned live target function and
candidate against the same exact HUB payload. Their server-side name lookup
command and resulting compatibility error response are byte-for-byte equal.

Production effects remain zero until a later separately authorized activation
stage binds the runtime global and imports the reviewed exact candidate.

## 2026-08-31 purchase-date amendment

The purchase-date cutoff changes the tracked router source identity and therefore
invalidates the older full-flow candidate digest recorded above. The old candidate
must not be imported. A later deployment stage requires a new private read-only
pull from `147`, a fresh exact preimage, rebuilt full-flow digest, validation and a
separately approved reviewed-flow apply. This source checkpoint does not perform
that rebind or any live operation.

The source contract now marks the full-flow candidate as
`UNBOUND_AFTER_ROUTER_AMENDMENT` and rejects activation-manifest validation.
The previous candidate digest remains historical evidence only.
