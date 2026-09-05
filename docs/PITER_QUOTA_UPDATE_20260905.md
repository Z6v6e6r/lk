# Piter: update of installed atomic topology

## Scope and state

Local preparation only. No publication, restart, lease mutation, reconciliation
write, seed or activation is performed by this builder. Managed usage stays off.

- Exact source: `e38f844343ef290aa49f2583861dfc4488031b97d303ccbe36b3a5e12c292ec3`.
- Exact candidate: `650a76ba68b196808663102423c83cbe6ae9db1c69eca6669fc25b0f969e8841`.
- Exact graph contract: `b92fb84d6f95472d3ac07c688a4bf8528a8584aa7021b48145a4593ff05131a8`.
- Node count stays 4768; all 215 HTTP inputs are unchanged.
- Only `func` changes for `c165e43eba668c25` (subscription status) and
  `piter_atomic_router_20260903` (atomic purchase router).
- All other nodes, order, topology, credentials/config and unrelated fixes stay
  identical to the fresh source. No nodes are added or removed.

The fixed tuple is a reviewed local input/output contract, not evidence that the
server still has those bytes. Any source drift requires renewed inspection and
review; the CLI has no hash/target override. Do not use the old initial installer
over the existing atomic graph.

This supersedes the unpublished 7775475... -> 8cc76ed... candidate. The fresh
source includes the completed `subscription-create-preflight` deployment, whose
three function changes (`8f7bd5b482fe9763`, `lk_subscription_booking_router_20260804`,
`lk_subscription_booking_finalize_20260804`) were independently compared and are
preserved exactly. Its historical terminal receipt is not a fresh lease check.

## Local preparation

Use the existing read-only pull into a NEW private directory outside Git, then:

```text
node scripts/prepare_piter_atomic_quota_update.mjs --workspace /absolute/fresh-private-workspace
```

The builder requires verified live-147 origin, exact SHA and freshness <=30 min.
It writes `build-piter-quota-update/{candidate.flow.json,reviewed-flow.contract.json,report.json}`
with directory 0700/files 0600. Existing output is rejected, including partial
output after an interrupted write. Do not overwrite it; retain and use a fresh
workspace. The full flow contains private configuration and must stay outside Git.

Function preimages/replacements and whole-flow hashes are pinned. The existing
exact-graph validator proves two `func` changes only and the structural reverse
back to the exact fresh source. This is not a physical rollback or Mongo test.
The activation report supports equal node counts only for this exact update tuple,
with explicit `--initial-batch-remaining 50` and packet V2. Other equal-count or
drifted update identities fail closed. Legacy V1 initial-install packets retain
their existing contract.

## Required gates before any later live operation

1. Preserve single source ownership and obtain one coordinated publication window
   with the ab_leto/shared-subscription owner. Never mix a stale initial installer
   or all-bundle frontend deployment into this focused backend update.
2. Follow repository integration/push/CI/deploy approvals. Produce the release
   package from the confirmed clean pushed revision, not this local preview.
3. Re-read exact live flow, deployment lease/runtime state and scoped database:
   sentinel must still be absent and atomic attempts absent before this launch
   preparation is used. An already-active schema1 sentinel remains runtime-compatible
   and invalidates that assumption. Stop on any conflicting write or drift.
4. Install only the exact reviewed flow under the normal shared lock/lease helper
   after explicit deploy authority. The deployment family remains
   `piter-atomic-sales-20260903`; exact SHA pairs, timestamped backups and fresh lease
   distinguish this update from the earlier installation. Never reuse old backup
   paths or expire/remove somebody else's lease to make progress.
5. Fresh reconciliation is still mandatory. Two historical refunds currently fail
   the strict cross-record timestamp equality check even on canonical provider GETs.
   The provider timezone/precision contract is unresolved. Do not guess timezone,
   rewrite evidence timestamps or reuse an old candidate's reconciliation receipt.
6. Only after that blocker is resolved may a fresh packet and explicitly approved
   reconciliation/seed/activation run under their own guards. Seed is inactive;
   activation is a separate DB transition. A flow update alone does not open sales.

## Operator dependency packaging

The new `scripts/lib/piterAtomicQuotaUpdateContract.mjs` is a runtime dependency
of `piterAtomicActivationContract.mjs`. Include it with all transitive dependencies
for the packet builder, ledger operator AND legacy reconciliation operator.
Verify the packaged operator dependency closure and hashes before any live stage;
this local candidate does not provide or authorize a server operator installation.

## Recovery boundary

The only structural restore source is the exact e38f844... snapshot, not the
older pre-atomic source. `structuralReverseCheckPassed=true` and
`rollbackAuthorized=false` are intentional. Before restoring code, use the
existing data-aware rollback precheck and approved recovery procedure. Once a
schema2 sentinel or attempts exist, do not assume the old schema1 runtime can
continue them; deactivation/quiescence/data custody must be proven separately.
This builder neither clears data nor rewrites the sentinel.

## Checks

- New updater, activation/reconciliation, topology, reviewed-flow deploy and
  purchase runtime suite: 174 PASS, 1 Linux-only SKIP.
- Full inert prod/dev build including TypeScript: PASS; not production configured.
- Lint: 0 errors, 387 existing warnings; exact diff check PASS.
- Independent release/custody and payment-compatibility reviews: PASS.
- Actual local candidate from fresh live snapshot reproduced the tuple above;
  production publication/DB activation/browser purchase remain NOT DONE.
