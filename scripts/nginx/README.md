# LK reserve nginx

`lk-reserve.conf` turns `lk-reserve.89-108-64-209.sslip.io` into a reserve LK gateway:

- serves `/lk/*.js`, `/lk/release*.json`, fonts and assets locally from `/var/www/html`;
- proxies LK backend routes `/lk/games`, `/lk/chats`, `/lk/communities`, `/lk/support`, `/lk/tournaments`, `/lk/onboarding`, `/lk/push`, `/lk/analytics`, `/lk/advertising`, `/lk/media`;
- proxies legacy `/seliger` and PHAB `/api/*`;
- answers CORS preflight on the reserve host;
- does not duplicate write requests, it sends every API request to one upstream only.

For current Tilda `https://padlhub.ru/lk_dev`, the config also has a temporary
compatibility shim: if `Referer` is `padlhub.ru/lk_dev`, requests to
`/lk/release.json` and `/lk/bundle.js` are served from `release-dev.json` and
`bundle-dev.js`. Because browsers may trim cross-origin referrers to origin
only, keep the regular `release.json`/`bundle.js` reserve-first too while the
Tilda loader still has `channel = "prod"`.

## Install on 89

```bash
sudo cp lk-reserve.conf /etc/nginx/sites-available/lk-reserve.conf
sudo ln -sf /etc/nginx/sites-available/lk-reserve.conf /etc/nginx/sites-enabled/lk-reserve.conf
sudo nginx -t
sudo systemctl reload nginx
```

If the certificate path differs, update these lines before `nginx -t`:

```nginx
ssl_certificate /etc/letsencrypt/live/lk-reserve.89-108-64-209.sslip.io/fullchain.pem;
ssl_certificate_key /etc/letsencrypt/live/lk-reserve.89-108-64-209.sslip.io/privkey.pem;
```

## Verify

```bash
curl -i https://lk-reserve.89-108-64-209.sslip.io/lk/health
curl -I https://lk-reserve.89-108-64-209.sslip.io/lk/release.json
curl -H 'Referer: https://padlhub.ru/lk_dev' \
  https://lk-reserve.89-108-64-209.sslip.io/lk/release.json
curl -I -H 'Referer: https://padlhub.ru/lk_dev' \
  https://lk-reserve.89-108-64-209.sslip.io/lk/bundle.js
curl -i -X OPTIONS \
  -H 'Origin: https://padlhub.ru' \
  -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: authorization,content-type' \
  https://lk-reserve.89-108-64-209.sslip.io/lk/games
curl -i 'https://lk-reserve.89-108-64-209.sslip.io/lk/games?limit=1'
```

Expected proxy responses include:

```text
Access-Control-Allow-Origin: https://padlhub.ru
X-LK-Reserve-Proxy: primary-padlhub-su
```

## Tournament participants storm guard

The production-only guard covers the cached GET
`/lk/tournaments/participants` and the separately limited, authenticated POST
`/lk/tournaments/participants/refresh`. It is split into:

- `lk-tournament-participants-guard.conf` for the nginx `http` context;
- `lk-tournament-participants-location.conf` for the `padlhub.su` server block.

See `docs/TOURNAMENT_PARTICIPANTS_REQUEST_STORM_GUARD.md` for thresholds,
verification, live backups, and rollback.

## Subscription booking gateway

`lk-subscription-booking-location.conf` is the exact production location for
`POST/OPTIONS /lk/subscription-bookings`. It must be installed in the
`padlhub.su` server block before the generic static `/lk/` handler so browser
subscription bookings reach Node-RED on `127.0.0.1:1880`.

Build a guarded candidate from a freshly copied live config, then apply it only
if both the live source SHA and candidate SHA still match:

```bash
node scripts/nginx/patch_subscription_booking_proxy.mjs build \
  /tmp/padlhub.su.live /tmp/padlhub.su.candidate LIVE_SHA
node scripts/nginx/patch_subscription_booking_proxy.mjs apply \
  /etc/nginx/sites-enabled/padlhub.su /tmp/padlhub.su.candidate \
  LIVE_SHA CANDIDATE_SHA /etc/nginx/sites-enabled/padlhub.su.backup-subscription-booking-TIMESTAMP
nginx -t
systemctl reload nginx
```

If `nginx -t` fails, restore the named backup before any reload. Public
post-checks are OPTIONS `204` with `POST, OPTIONS` and POST without Bearer
`401 SUBSCRIPTION_BOOKING_AUTH_REQUIRED`.

### Reserve booking route

`lk-subscription-booking-reserve-location.conf` adds the same POST/OPTIONS API
on the DEV reserve host, forwarding to `https://padlhub.su` with verified TLS,
unchanged URI/query, request body and Authorization, and no upstream retries.
The exact location precedes the reserve `location /lk/ { try_files $uri =404; }`.
It does not install a Node-RED gateway on reserve or change frontend pricing.

Use `buildReserveBookingNginxCandidate(source, sourceSha)` from
`prepare_subscription_booking_reserve.mjs` against a fresh private copy of
`/etc/nginx/sites-enabled/lk-reserve.tsup.space`. It rejects source drift,
conflicting routes and ambiguous/missing static markers. The existing primary
`applyCandidate()` CLI cannot install this reserve fragment. A later authorized
installation must recheck both hashes, preserve the original config and metadata,
validate with `nginx -t`, reload once, then check OPTIONS 204 and unauthenticated
POST 401. Do not replay an authenticated booking for a connectivity probe.
Restore the exact backup on failed validation; guard any post-reload rollback
against intervening config changes and validate it before reloading.

Local physical check (owned Docker fixture, network disabled, synthetic TLS):
`LK_BOOKING_RESERVE_NGINX_TEST=1 node --test scripts/tests/subscriptionBookingReserveIngress.test.mjs`.
