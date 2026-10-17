# Published tournament enrollment

Owner: PadlHub operations. Audience: participants of tournaments explicitly published
through the administration panel. The general worker enrolls each proven participant
into every active community containing an active `ADMIN_PANEL / PUBLISHED` publication.
It does not change the separate rating-primary community selection.

Default off. To enable on the existing rating-worker deployment:

```env
PUBLISHED_TOURNAMENT_AUTO_ENROLLMENT_ENABLED=true
PUBLISHED_TOURNAMENT_AUTO_ENROLLMENT_CUTOVER_ISO=2026-08-31T21:00:00.000Z
```

The cutover is the event calendar boundary, not the last edit date. September repair
uses `[2026-08-31T21:00:00Z, 2026-09-30T21:00:00Z)` (Moscow September 1–30).
Future events in this period are included only with freshly verified active bookings.
Finalized local standings prove completed participation; explicit cancelled or waitlist
records are excluded. Non-final/provider-only tournaments use bounded, read-only Viva
roster requests. No booking, payment or refund is created by this module.

Exact UUID, phone collision, publication alias/date and ban checks fail closed. Each
valid community/tournament/player receipt is transactional with membership. Receipts
also record existing members so a later voluntary departure is not undone by the same
old tournament. A new tournament can independently establish another enrollment.
An operation reads the current publication/tournament in the transaction and rejects
changes from the planned source. This is snapshot evidence, not a lock preventing a
concurrent publisher from subsequently removing their publication.

`lk_published_tournament_enrollments` stores private mutation preimages and full BSON
postimage hashes. Guarded recovery must run in reverse mutation order; any intervening
community edit rejects whole-document restore. Never force restore over newer edits.
Unexpected per-operation failures are reported as `ENROLLMENT_EXECUTION_FAILED`;
expected source/membership drift is reported separately. Other valid operations continue.
Inspect these reasons even when the enclosing rating job succeeds.

Read-only repair preflight:

```sh
node scripts/run_published_tournament_enrollment_147.mjs \
  --from 2026-08-31T21:00:00.000Z --to 2026-09-30T21:00:00.000Z \
  --provider-limit 500 --out /private/path/september-dry-run.json
```

Only an authorized apply adds `--apply`, under the shared worker flock. Repeat requests
are idempotent. Provider reads have a 120-second budget (plus one in-flight request);
unread groups remain visible and rotate on the next pass. Private CLI reports include
details; cron logs and `rating_job_runs.counts` contain aggregate reasons.

After apply: verify memberships, dry-run scoped community recalculation, apply it, then
check snapshot matrix/formula and enrollment's next scheduled execution. The owner has
authorized the September 2026 repair, community rating refresh and enabling this general
mechanism on `lk-primary-147`. No protected-branch merge is part of this release.

Release from clean pushed source, compare live manifest hashes, package all dependencies,
and switch `current` under the shared lock. Preserve the entire environment and add only
the two keys above; do not use the destructive environment generator. Stop new enrollment
by disabling its flag, then restore the prior immutable release if needed. Disabling the
flag does not undo already committed memberships.

Validation: pure negative tests plus isolated MongoDB replica-set transactions, concurrent
replay, source drift, literal payloads and guarded apply/restore; community rating tests,
worker package/watchdog checks, lint/typecheck. Production evidence is recorded separately.
