# Dead subscription hold release (PadlHub LK1)

Scheduled job for ADR 0004 (stage 2). A subscription operation in
`games.lk_subscription_daily_booking_ops` keeps the daily visit, free minutes and the
`lk1-daily-visit` guard while it is `CONFIRMED`, even when a trainer, an administrator
or Viva cancelled the booking. This job releases such an operation and the guard it owns
when the bound Viva booking is explicitly cancelled.

## What a tick does

- reads `CONFIRMED` operations of the window and `GET /exercises/{id}/bookings?showCancelled=true`;
- releases only an explicitly cancelled bound booking (not absence, not identity conflicts);
- leaves alone money markers, unknown visit counts, past dates, operations written in the
  last 5 minutes and any subscription with an unfinished LK cancellation/repair job;
- per operation, one transaction: operation CAS -> `RELEASED`, `visitReturn: UNVERIFIED`,
  guard CAS delete; any concurrent change aborts that operation only;
- writes the exact documents to `backups/` (30 days) before releasing.

It never returns a visit in Viva. Visit returns stay manual (LK2 `AGENTS.md`).

| unit | window | period |
| --- | --- | --- |
| `padlhub-dead-hold-release-near.timer` | today, tomorrow | 5 min |
| `padlhub-dead-hold-release-full.timer` | next 14 days | 30 min |

Both run `padlhub-dead-hold-release-<mode>.service` and share one lock. The Viva token
is read from `/root/.node-red/confirmed-claim-release/state/viva.token` (minted there);
a stale token makes the tick log `TOKEN_STALE` and do nothing.

## Operation

```sh
systemctl list-timers 'padlhub-dead-hold-release-*'
systemctl start padlhub-dead-hold-release-near.service      # one tick now
tail -5 /root/.node-red/dead-hold-release/state/run.log
```

Watch `result` (`DONE`, `NOTHING_TO_RELEASE`; anything else needs a look),
`postcheckMismatches` (must be 0) and `byReason.VERDICT_EVIDENCE_*`.

## Stop and rollback

```sh
systemctl disable --now padlhub-dead-hold-release-near.timer padlhub-dead-hold-release-full.timer
node /root/.node-red/dead-hold-release/scripts/release_dead_subscription_holds.mjs \
  --flows /root/.node-red/flows.json --mongodb-module /root/.node-red/node_modules/mongodb \
  --restore /root/.node-red/dead-hold-release/backups/<file>.json
```

Restore puts back only operations still carrying exactly this release, and recreates a
guard only when nobody owns that day now.
