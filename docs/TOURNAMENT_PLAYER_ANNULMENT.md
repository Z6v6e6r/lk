# Annul one player's tournament rating result

Owner: an authorized operator. Audience: the affected player and communities.
Outcome: exclude one tournament/player pair from community scoring and optionally
reverse its personal-level delta, while retaining original scores, participants,
rounds, standings, ranks and the original participant count. Other community
positions and normalized scores may change as a consequence of normalization.

## Persistent source metadata

An operator writes a top-level `tournaments.ratingExclusions` entry:

```json
{
  "playerId": "<exact-client-uuid>",
  "scopes": ["community", "level"],
  "auditId": "<unique-operation-id>",
  "reason": "PLAYER_DID_NOT_PLAY",
  "recordedAt": "<current-UTC-ISO-timestamp>"
}
```

Do not put it in `params`, `standings` or `totals`: normal saves/recalculation
rebuild those fields. Public save inputs cannot author the top-level exclusion;
verify that every active writer preserves it before applying an operation.
Names and phones are not sufficient identity evidence. Do not replace a player
with a different account without independently confirming that account.

The community extractor skips only the matching standing. The personal worker
appends `TOURNAMENT_RATING_ANNULLED`, compensating only uncompensated canonical
events for that tournament/client. It uses actual ledger deltas, not rounded
standing values. Compensation IDs and timestamps are deterministic from the
original event and exclusion. Historical events remain immutable. Before/after
values describe current replay, preserving subsequent valid events.

Missing baselines, a later baseline absorbing the result, a ledger frontier after
the requested correction time, and a clamped replay mismatch block automatic
compensation. Stop and reconcile those histories separately. A public save or a
later source-score recalculation must not re-enable the excluded result.

## Preparation and execution gates

1. Confirm the exact tournament, player UUID, date, scopes and affected community
   IDs. Read the live worker manifest and verify every file hash. Keep private
   exports, identities, before/after plans and receipts outside the repository.
2. Check the complete player ledger, aliases, current state, compatibility state
   and provider outbox. Refuse ambiguous identities or state/replay drift. Plan
   from an immutable source/ledger fingerprint and fixed operation ID.
3. Test compensation, subsequent valid events, community-only scope, exact
   identity matching, retry without duplicate events, crash recovery, and source
   preservation. Run `npm run test:community-rating`,
   `npm run test:rating-worker-release`, ledger regressions and applicable CI.
4. Build an immutable compatible worker package from clean, pushed source. A
   release from a newer main may change unrelated enrollment/policy behavior.
   For an older active runtime, retain its exact manifest file set and apply only
   the reviewed annulment patch plus the new exclusion module. Record both the
   runtime base commit and reviewed patch commit and every output hash.
5. Perform a read-only rehearsal with the patched extractor and compensation
   planner, overlaying the exclusion, planned events and replayed state in memory.
   Compare all other players' source facts/levels. A normal full-worker dry-run
   does not overlay future ledger/state into its community calculation and is
   insufficient for this before/after evidence. Model the provider payload too.
6. Obtain the explicit critical-release approval naming source/package, server,
   deployment, exact data correction and provider projection. A source PR or
   green CI alone authorizes none of these live transitions.
7. Under the existing worker `flock` and Mongo lease, recheck active release,
   tournament version and the complete player ledger/state fingerprint. Save a
   root-only preimage. Publish the verified compatible release before writing the
   exclusion. Use CAS on the exact source version and old exclusion value; refuse
   drift rather than overwriting it. Preserve all unrelated fields.
8. Restrict writes to the approved tournament exclusion, this player's immutable
   compensation/state/compatibility/outbox, and affected community facts,
   aggregates and snapshots. Do not run broad full-worker apply as a shortcut.
   Provider delivery must target this player's event only, with readback before
   retries; do not drain unrelated pending provider operations.
9. Verify source preservation, one compensation, exact replay and compatibility
   level, provider acknowledgement/readback, all affected snapshot periods/tabs,
   and zero changes to other personal levels. Re-run the scoped calculation and
   observe the next ordinary worker tick: no new compensation and no returning
   community fact. Preserve postcheck receipts. Do not backdate observation.

## Stop and recovery

Stop on source/release drift, identity conflicts, replay mismatch, unexpected
write targets, lost lock/lease, duplicate compensation or uncertain provider
delivery. Stop further scoped writes; preserve the audit trail and compatible
runtime while investigating. Do not retry a provider write blindly.

Before any exclusion/ledger write, a guarded return to the unchanged previous
worker is valid. After compensation, deleting the exclusion or rolling back only
the worker does **not** restore the result: old event IDs remain compensated,
and an older community extractor would count the original standing again.
Restoration is a separate authorized append-only reconciliation with a new
idempotent event and fresh projections/snapshots. Rehearse that plan on the
saved preimage; never delete ledger history, overwrite newer snapshots with old
backups, or call a source-only rollback a completed data recovery.
