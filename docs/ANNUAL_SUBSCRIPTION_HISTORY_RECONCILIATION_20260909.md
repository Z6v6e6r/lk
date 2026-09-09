# Annual subscription history reconciliation — 2026-09-09

Local correction on `codex/subscription-sale-quotas-20260909`, based on
`be2e395eebae6b6fee7e405fbfa87ef3e3e703bf`. This is not an opening or data-apply packet.

## Corrected checks

- A transaction refund and its linked subscription have independent `refundedAt`
  fields. Reconciliation retains both raw values and requires valid timestamps,
  exact transaction/product/client linkage, exactly one REFUNDED subscription,
  and equal positive refund amounts. It does not assign a zone to a zone-less
  subscription timestamp or compare the two entity times using a tolerance.
- New reconciliation packets carry `refundEvidenceVersion: 1`. Their mutation
  markers and provider-only refund proofs retain both raw timestamps. Validation
  rejects missing or contradictory proof, amount, timestamp, and subscription
  identity, including after a packet digest is recomputed. Activation additionally
  binds proof to the provider transaction and persisted ledger fields.
- Legacy V1 packets without the new version remain readable. Existing marker,
  receipt, full-preimage, CAS, postimage, lease, and recovery requirements remain.
- Payment deadlines require zoned ISO timestamps and exact instants, except for
  the observed creation-response nanoseconds to transaction-GET microseconds
  serialization. Only fractional digits below one microsecond may be discarded
  in that direction. Different microseconds, rounding up, missing zones, and
  general millisecond truncation fail. Source deadline fields remain unchanged.
- `vivaHistoricalEvidence.mjs` is included in the deferred operator's verified
  publication dependency closure. Original pinned contracts remain in the test;
  separate history-amendment hashes document the changed contracts. Future private
  operator publication must include the helper and verify its hash.

## Read-only verification

A new Mongo/Viva snapshot completed at `2026-09-09T14:57:14.321Z` using 96 provider
GETs. Operator Mongo/provider business writes: zero. Raw evidence stays outside
Git in a private local directory. Capture skew is 3.057 seconds for HAB and 2.113
seconds for Piter. These are diagnostic snapshots, not executable fresh evidence.

| Historical observation | HAB | Piter |
|---|---:|---:|
| Local rows | 20 | 83 |
| Local paid rows still PAID in Viva | 4 | 40 |
| Local paid rows now REFUND in Viva | 1 | 2 |
| Local pending rows, expired and UNPAID in Viva | 15 | 41 |
| Positive PAID transactions absent from local collection | 14 | 2 |
| Provider-only UNPAID | 4 | 1 |
| Provider-only free PAID issues | 18 | 5 |
| Positive refunds with exact linked REFUNDED subscriptions | 2 | 3 |
| Refund of a free issue, amount zero | 1 | 0 |

There are no client conflicts or deadline conflicts under the existing identity
rules and corrected deadline check. The previously reported Piter client conflict
was a diagnostic error: the legacy local client ID is null, not a different ID;
the existing contract already permits its matching phone. No identity repair is
needed, and no client ID was substituted.

All sixteen provider-only paid transactions have one linked ACTIVE/NEW
subscription; cross-inventory lookup found no corresponding local sale rows.
Historical HAB amounts remain at the recorded prices. The new 98,000 RUB product
price is not applied retroactively.

Offline replay at snapshot time advances the Piter packet builder past the refund
and deadline checks and stops on the first genuine missing paid sale. For that
diagnostic only, the inventory-only Mongo read was projected to the narrower
inventory/counter input envelope after verifying every row was in scope. The
projection and synthetic candidate metadata are not retained as execution inputs.

## Remaining opening work

1. Define how provider-only paid sales contribute to the HAB aggregate limit of
   100. User clarification is pending. The daily limit remains one new seat.
2. Implement reviewed accounting for provider-only paid/unpaid transactions,
   preserving their real transaction identities without fabricating local
   payments. Piter must still start at the approved 48 of 100. A hypothetical
   count of all 42 confirmed Piter cash sales would imply adjustment 10; this is
   arithmetic, not an approved or applied baseline.
3. Extend HAB's empty-inventory-only opening contract for reconciled history and
   handle the zero-amount free-issue return separately from paid refunds.
4. Recollect exact execution evidence, bind to the then-current installed flow,
   and prepare inactive ledgers plus guarded CAS operations before live approval.
   Parallel deployments changed the observed flow hash; archived opening hashes
   are not evidence of the current runtime or authority to activate it.

Current business targets are RA ten new daily seats with previous operations
preserved; Friendship seven total daily seats including paid/active pending;
HAB one daily seat at 98,000 RUB; Piter 48/100 at 19,800 RUB. Both annual products
are configured for next-day activation. This change does not turn on sales flags.

## Checks

- Annual history/atomic/deferred/topology contracts: 96 passed, 14 skipped.
- Exact CI critical subscription matrix: 523 passed, 5 skipped.
- Exact CI candidate/drift matrix: 65 passed, 2 skipped.
- Skips are unavailable private historical/runtime fixtures and Linux flock
  custody evidence on macOS. They are not production passes.
- Full prod/dev bundle build with inert configuration passed; lint: zero errors,
  387 existing warnings. Frontend build inputs are unchanged by this correction.
- Independent payment-safety and timestamp reliability reviews completed. Fixed
  findings: missing helper publication hash, incomplete refund mutation acceptance,
  and negative-epoch truncation. Live mutation/recovery was not exercised.

No merge, push, deploy, payment/refund, database mutation, or sales activation was
performed in this correction stage. The overall historical opening plan remains
in preparation; the two false data mismatches are resolved in local source.
