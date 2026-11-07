# FPR personal levels

Completed official FPR protocols now use the ordinary tournament level formula over
only their closed matches (the actual 25-point scores). Frozen participant levels
and confidence factors are authoritative; an unrated zero starts at 1.0 by the
owner's explicit decision. Test and ambiguous duplicate protocols do not award.
Community sporting scores and personal level are separate calculations; sporting
standings, scores, pairs and rounds are never rewritten by this worker.

Events use domain `TOURNAMENT` and the original physical event ID, with
`fprProtocolId` tracing the protocol. The original empty legacy result cannot
compensate its FPR award. Existing level exclusions on either record are inherited.
Corrections/reopening append compensations, preserving immutable history. Historical
absolute tournament targets and later game deltas are replayed in event-time order.
A non-baseline additive reconciliation preserves the underlying unclamped balance;
future games remain visible. All validated identity aliases are read by subsequent
ordinary tournament and game projectors for identities carrying `fprLevelFrontier`.

Each identity is updated in a snapshot/majority MongoDB transaction: source write
fence, immutable events, canonical/compatibility projections and provider outbox.
Exact preimages reject concurrent changes. The source fence changes only reserved
root metadata `fprLevelLedgerFence`, never sporting results. Provider delivery uses
the latest canonical frontier and requires an explicit matching numeric SYNCED ACK.

## Activation and historical operation

An immutable overlay patches only the two installed workers and adds six runtime
modules. Every other installed manifest byte is preserved and hash-checked. Build
with `scripts/build_fpr_level_worker_overlay.mjs`; never replace the installed older
worker with a whole newer local checkout.

Root-owned 0600 `/var/lib/padlhub-rating-worker/fpr-level-activation.json` requires:
`policy: fpr-ordinary-level-v1`, `unratedStartLevel: 1`, boolean `enabled` and
`dispatchEnabled`. Both default false. Disabling ledger alone does not stop dispatch.
The common `/var/lock/padlhub-rating-worker.lock` must cover preparation, activation,
backfill and delivery; ordinary/game runners use the same lock.

`scripts/reconcile_fpr_personal_levels.mjs` is server-only and defaults to prepare.
Use `--runtime` with the verified immutable release, `--operation` with a new private
`/root/.padlhub-fpr-level-*` directory, and `--mode prepare|apply|postcheck` under the
common flock with `FPR_LEVEL_SHARED_LOCK_HELD=1`. It saves full BSON-aware backups,
frozen plans, durable intent and per-player receipts on the server. Only aggregate
counters leave the server. The initial operation is pinned to 19 tournaments,
185 appearances, 138 players and 8 unrated appearances; one ambiguous test source
(two protocols) remains excluded. A changed cohort requires a newly reviewed packet.

Apply requires a preview younger than 15 minutes, unchanged runtime/flow/source and
identity preimages, active candidate and both automation switches false. An uncertain
or partial apply is not blindly retried: inspect durable receipts and exact readback,
then prepare a separately reviewed forward repair. After success, verify zero retry
events, canonical/compatibility equality, unchanged sports data, provider numeric
readback and refreshed community snapshots before enabling both switches.

Recovery is **forward compatible only** after the first FPR award. An old worker may
interpret the empty original result as reopened and compensate valid awards. Keep
source ownership guards, alias handling and current-frontier dispatch in any recovery
release. Pause both switches while diagnosing; retain all history and backups.

Checks: `npm run test:community-rating`, `npm run test:fpr-level-mongo`,
`npm run test:rating-worker-release`, TypeScript, lint and normal bundle build.

## Client results

The worker writes a display-only `fprLevelResults` snapshot on the original protocol
document. Each row contains either the actual persisted active TOURNAMENT award's
before/after/delta, `pending`, or `not_awarded`. It is not a recalculation from today's
player level. Historical protocols receive the same snapshot without creating new
awards or changing sporting results, canonical levels, or provider queues.

The snapshot is bound to the completed official protocol ID/revision, physical event,
roster and level exclusions. A missing, ambiguous, compensated, or stale award is not
shown as a zero change. Source and legacy preimages are checked before the metadata
write; the exact primary document is updated with compare-and-swap. Repeating the
worker with identical content leaves the snapshot unchanged.

The history mapper exposes only the validated snapshot and exclusion IDs, without
administrative reasons. The client cabinet shows `Уровень до → после` and signed Δ
with up to five decimal places, preserving a real zero and small changes. Pending
awards retain sporting standings and offer the existing history refresh action.
Ordinary tournament result mapping and ranking are unchanged.

Roll out the worker first, preserving the immutable installed manifest and using the
fixed dependency allowlist in `build_fpr_level_worker_upgrade.mjs`. Verify a dry run,
metadata-only historical projections and a zero-change retry before publishing the
frontend. Shared API imports affect multiple bundles: verify all public release
manifest hashes and the client history table after an authorized frontend release.
