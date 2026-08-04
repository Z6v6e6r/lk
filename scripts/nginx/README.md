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
