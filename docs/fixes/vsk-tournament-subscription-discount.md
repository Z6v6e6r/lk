# VSK tournament discount, 2026-11-17

Target: tournament `6afc50fecef404ceab1b8928`, Viva exercise
`732d1932-4133-48c3-aed4-5ad1abf94e79`, 22 November 2026, 12:30–14:30 Moscow,
Terekhovo. Category 2349, direction 6977.

Owner rule: an appropriate subscription or residency grants a 50% monetary discount.
For managed plans already including the 50% tournament benefit, the evaluator now
keeps this event at 50% even when the subscription could otherwise cover the first
event of the day. It consumes zero visits. Ownership, lifecycle, scope and price
verification remain prerequisites. Unrelated events retain their existing behavior.
Residency continues to require its verified runtime context; no local exception
replaces the published residency policy or client authentication.

Observed authenticated reproduction: Viva initially returned an empty tariff list,
causing `503 LK1_EVENT_TARIFF_AMBIGUOUS / empty_tariff_list`. On repetition after
session refresh, authenticated and public Viva requests both returned the same
single SERVICE product, `cost=550000`. The production preview returned 200 with
an AVAILABLE 50% quote (`amountMinor=275000`). No tariff fallback is necessary.
The underlying reason the earlier list was empty is not established: a configuration
change and session-dependent visibility were not distinguishable from the retained
logs. No provider configuration was changed during this task.

The same preview also returned `RESIDENCY_BOOKING_CONTEXT_UNAVAILABLE` for a
residency. Corresponding calls to `/api/internal/subscriptions/residency-booking-refresh`
returned 401. Residency is not fixed or verified by this change. Investigation requires
restored access to the authorized client session and the identity verifier's refusal
reason. Do not bypass identity verification or grant a local unproven benefit.

`prepareVskTournamentDiscount(rawFlowBytes, expectedSha256)` in
`scripts/prepare_vsk_tournament_discount.mjs` prepares a local candidate from an
exact reviewed live snapshot. It changes only `func` for the three named policy
and preview evaluators, preserves other live patches and refuses drift/reapplication.
The evaluator patch lives in `scripts/lib/vskTournamentDiscount.mjs`; immutable historical
evaluator source is preserved. The raw flow and candidate must remain private and outside Git. No HTTP endpoints
or import/export JSON artifacts are committed. Revert by restoring the reviewed
three function preimages only after checking intervening changes; never undo business
operations. Deployment needs fresh baseline validation and explicit authority.

Validation: evaluator/candidate regressions 16 passed; affected preview, event-payment,
residency and VSK suites 83 passed, 37 optional fixture tests skipped; managed-policy
suite 55 passed, 1 skipped. Generated live candidate passed graph comparison and
synthetic 50%/zero-visit execution in all three enabled evaluator nodes/tabs.
Full production/development bundle build passed. Lint passed with existing warnings. Critical matrix: 97 passed, 1 source assertion
failed in unchanged GroupSchedulePage (expects a retired DEV-shadow action literal).
Production activation, real booking/payment and residency acceptance remain unverified.

CI initially found a historical evaluator hash guard; preserving the pinned source fixed it.
The corrected preparer generates a byte-identical candidate, so the synthetic live-candidate
checks remain valid. Focused evaluator/candidate/historical checks: 22 passed, 1 skipped.
