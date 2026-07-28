# Tournament participants request-storm containment

## Scope

The protected route is `GET /lk/tournaments/participants?exerciseId=<uuid>`.
The public tournament list must not hydrate participant rosters. It uses the
participant count already present in the tournament summary. A roster request
is allowed only after a user opens one tournament detail.

## Application limits

The Node-RED v2 flow applies these limits before Viva client lookups:

- response cache: 60 seconds fresh, 10 minutes stale, at most 500 exercises;
- stale-while-refresh: a stale response is returned while one refresh runs;
- at most 8 cold exercise refreshes globally;
- at most 3 Viva client-detail requests concurrently;
- client-detail queue: at most 30 entries and 4 seconds of waiting;
- client-detail cache: 30 minutes, at most 2,000 clients;
- same-key cold duplicates fail fast with `429` and `Retry-After: 2`;
- a circuit opens for 30 seconds after two upstream failures.

The public response strips phone numbers. Cache state is exposed in
`X-LK-Participants-Cache` for the targeted nginx access log.

## Nginx guard

Install `scripts/nginx/lk-tournament-participants-guard.conf` in the nginx
`http` context and place
`scripts/nginx/lk-tournament-participants-location.conf` inside the
`padlhub.su` server block. The edge limit is 60 requests per minute per IP with
a burst of 20 and returns `429` when exceeded.

Always run `nginx -t` before reload. The focused log is:

```text
/var/log/nginx/lk_tournament_participants_access.log
```

Useful cache values are `hit`, `miss`, `stale-refreshing`, `stale-overload`,
and `stale-error`.

## Production rollout and rollback

On 2026-07-20 the guarded Node-RED candidate was built from fresh live flow
SHA-256 `4e51d3154dc60c29a7f29ad332bddd4f0aa243099ed39f3144039c651c9f2f3f`
and activated as SHA-256
`390aec5910d3de19b8b5efea71fcb54c8bf7c6d67400e37569c456eef520b186`.

Backups:

- Node-RED: `/root/.node-red/flows.json.codex-before-participants-v2-20260720T100230Z.bak`;
- nginx: `/etc/nginx/backups/padlhub.su.codex-before-participants-v2-20260720T100802Z.bak-disabled`;
- prod frontend: `/var/www/html/lk/.codex-backups/participants-fanout-20260720T095903Z/`;
- dev frontend: `/var/www/html/lk/.codex-backups/participants-fanout-20260720T095903Z/` on `lk-reserve-89`.

Rollback is backup-first and scoped: restore the exact Node-RED backup and
restart only `node-red`; restore the nginx server file, remove the focused
guard include/config, run `nginx -t`, then reload nginx; restore only
`tournament-signup.js` and its release manifest for the frontend.

## Acceptance checks

- the public list renders without roster requests for every card;
- opening one card performs one abortable, no-retry roster request;
- hot concurrent requests are served from cache;
- cold overload returns stale data or `429` instead of accumulating waiters;
- Node-RED RSS stabilizes and other LK routes stay responsive;
- public roster payload contains no phone field.
