# LK Games CORS: guarded rollout plan

## Scope

The canonical legacy roster and payment-confirmation routes require browser requests with
`Authorization`, `Content-Type`, `Idempotency-Key` and `X-Correlation-ID`. Node-RED mirrors those
requested headers correctly, but the production `location ^~ /lk/games/` block hides the upstream
CORS response and replaces it with a fixed list that omits the two idempotency headers. The exact
`location = /lk/games` block is outside this route scope and remains unchanged.

This checkpoint builds and tests an nginx candidate only. It does not change or reload production.

## Guarded candidate

Always pull a fresh copy of `/etc/nginx/sites-enabled/padlhub.su` into a private external workspace
and calculate its SHA-256. Build the candidate with:

```bash
node scripts/nginx/patch_lk_games_cors.mjs \
  --input /absolute/private/padlhub.su \
  --output /absolute/private/padlhub.su.candidate \
  --report /absolute/private/padlhub.su.report.json \
  --expected-sha256 <fresh-source-sha256>
```

The builder fails closed unless the nested LK Games location exists exactly once, retains its
upstream header suppression, accepts `POST, OPTIONS`, returns preflight `204`, and has the reviewed
old header list. It changes only this value:

```nginx
add_header Access-Control-Allow-Headers "Content-Type, Authorization, X-API-Key, Idempotency-Key, X-Correlation-ID" always;
```

Candidate and report are exclusive-created with mode `0600`. They must stay outside the repository.

## Production gate (not executed in this checkpoint)

1. Confirm clean, pushed `main` and record the exact Git SHA.
2. Pull the live vhost again. If its SHA differs from the reviewed preimage, rebuild and repeat review.
3. Build the candidate with the guarded script and compare it to the fresh source. Exactly one line
   may change.
4. Copy the live vhost to a private backup directory outside `sites-enabled`, for example
   `/etc/nginx/backups/padlhub.su/<timestamp>/padlhub.su`, and verify the backup SHA.
5. Install the candidate to a sibling temporary file, preserve owner/mode, and atomically rename it
   over `/etc/nginx/sites-enabled/padlhub.su` only after one final live-SHA comparison.
6. Run `nginx -t`. On any error, restore the verified backup before reload.
7. Reload nginx; do not restart Node-RED.
8. Run exact preflight from `Origin: https://padlhub.ru` requesting
   `authorization,content-type,idempotency-key,x-correlation-id`. The public response must include all
   four headers.
9. Repeat the fail-closed `LEGACY_GAME_BRIDGE_DISABLED` POST checks and verify Node-RED SHA/PID/restart
   count are unchanged.

## `sites-enabled` backup cleanup plan (not executed)

The production wildcard include currently loads two non-hidden backup vhosts and `nginx -t` reports
conflicting `padlhub.su` server names:

- `padlhub.su.backup-padel-day-20260714T062438176Z`
- `padlhub.su.pre-547ee2e-20260817T185047MSK`

There is also a hidden backup `.padlhub.su.backup-subscription-booking-20260808T193154Z`; it is not
matched by the wildcard today, but should live with the other backups for consistent recovery.

Cleanup is a separate reversible operation:

Run it only after the CORS hotfix has completed its own reload and public postcheck. Do not combine
the two changes in one nginx reload or one rollback decision.

1. Record SHA-256, owner, mode and mtime of all three files.
2. Create `/etc/nginx/backups/padlhub.su/<timestamp>/` with mode `0700`.
3. Move only the three exact reviewed source paths into that directory; do not use globs.
4. Verify that every destination SHA, owner and mode matches the recorded source metadata.
5. Run `nginx -t` and confirm the duplicate `padlhub.su` warnings disappear.
6. Reload nginx and repeat public LK/games/media smoke checks.
7. Roll back by moving the exact files to their original names if validation or smoke fails.

Do not delete the backups during this cleanup. Retention/deletion requires a separate decision.
