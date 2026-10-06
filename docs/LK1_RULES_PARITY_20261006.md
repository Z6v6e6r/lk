# LK1 court co-pay compatibility, 2026-10-06

The master-service `total` uses rubles in the existing exact split price contract.
Booking and preview now convert it once to minor units, including kopecks, and
reject malformed, non-positive or over-ceiling totals. A 12,000 RUB two-hour
window proves 6,000 RUB per hour and a 1,500 RUB second-hour co-pay.

The current event payment carrier expresses a discount from its one-time base.
If the approved quarter-court co-pay exceeds that base, the evaluator now refuses
with `LK1_COURT_COPAY_UNREPRESENTABLE`; booking and preview propagate that same
explicit error before admission/payment continuation. It never clips the court
charge or selects a new payment carrier. Other payment bindings stay unchanged.

The installed denied-output graph routes evaluator → blocked → finalize. With
the real `ctx.lk1` context, its existing finalizer wraps the failure in HTTP202 /
`PENDING_CONFIRMATION`, retaining `details.code`; preview returns HTTP503 with
that same code. There is no provider/admission continuation. This correction
preserves that existing recovery contract. A known refusal may therefore appear
unresolved to a consumer; making it terminal needs separately assigned finalizer
ownership and recovery review. The snapshot regression uses the actual LK1
context, rather than claiming the generic non-LK1 HTTP409 response.

The leading owner confirmed preservation of HTTP202 in this scope. Follow-up
owner: `scripts/nodered_lk1_hub_nodes/finalize.js` and its installed finalizer.
Condition: the existing `ctx.lk1` error wrapper handles this confirmed source
refusal as pending. The separate B operation GET must retain that uncertainty;
it must not infer FAILED, paid settlement or permission for a new purchase.
The focused fixture proves that repeating the same refused input still yields
no booking/create/payment continuation and no booking/transaction/payment URL.

## One preparation graph

`scripts/prepare_lk1_rules_parity_20261006.mjs` composes against the reviewed
downloaded 147 snapshot SHA256
`8806b4e5ece9afd1449db73dd4e51964adb5566c845665feed4ff834784483e3`
(4,815 nodes, origin metadata timestamp 2026-10-06T09:33:48.385Z).
That is preparation evidence, not current production state or authority to apply.

The exact graph permits only these existing fields:

- `lk_subscription_booking_router_20260804.func`: court proof/dispatch, monetary
  binding, usage accounting and identical explicit refusal;
- `lk_subscription_managed_policy_20260820.func` and
  `lk_subscription_price_preview_20260908_evaluate.func`: identical evaluator;
- `lk_subscription_price_preview_20260908_router.func`: quote built from the same
  canonical helpers and allowance block;
- `piter_atomic_router_20260903.initialize`: refreshed HUB capability receipt
  dependency digest after gateway/evaluator changes.

Gateway initialization stays byte-identical: maxActiveBookings=8, nine plan
rules, Patriots and trial dormant. Existing early PRO initialization, response
before exercise, target station/room before dispatch, and exercise continuation
are preserved. No route, wire, collection, credentials or provider writes change.
The receipt initializer retains its existing sales-flag behavior; a capability
receipt is not booking or paid-settlement evidence.

The existing G1 body helper can omit Patriots deltas for this preparation. Its
default behavior remains historical G1. Reviewed source fragment pins move with
the correction, but historical full-flow/live-field/postimage pins do not move.
Old G1/G2 wrappers therefore cannot deliver this correction and must not be used.
No sequence of partial wrappers substitutes for this graph.

## Local checks and apply boundary

Use Node 22. CI includes `scripts/tests/lk1RulesParity.test.mjs`. Core fixtures
exercise conversion, rejection and matching booking/preview failure codes without
a private flow. For the additional exact downloaded-generation graph, receipt,
policy and rollback checks, supply `LK1_RULES_PARITY_SNAPSHOT` to the same test.
Without that private input, that one integration test reports a skip.

The CLI accepts `<fresh-private-147-workspace> <new-private-output-directory>`;
origin freshness verification precedes any output. All candidate/contract/source
rollback artifacts stay outside Git, mode0600 inside a mode0700 directory.
Rollback restores exact source bytes with their original matching capability
receipt; the reverse exact-graph contract rejects foreign changes.

No deployment wrapper is added or invoked. At an explicitly authorized future
apply, refresh the live preimage and re-review drift against this generation.
Use the existing reviewed-flow graph contract, lock/lease and guarded recovery.
The old G1→soak→G2 Patriots window is not part of this candidate. Direct runtime
globals/receipt, provider price DTO and authenticated rendered UI remain separate
acceptance evidence. B's operation-read identity/storage contract is separate.
