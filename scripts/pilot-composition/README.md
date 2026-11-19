# Residency pilot: isolated composition

This directory reproduces the isolated run used for the LK1 residency pilot evidence in
`docs/evidence/residency-pilot/isolated-composition-20261118`. It is test infrastructure:
nothing here is imported into the live Node-RED graph and nothing here calls Viva, CUP or
Keycloak for real.

## What runs

| Component | Image / source | Notes |
| --- | --- | --- |
| Node-RED | `nodered/node-red:4.0.9-22` (Node 22.14.0) + `node-red/custom-nodes/residency-lifecycle-api` | the import `node-red/imports/lk_residency_lifecycle.import.json` becomes `/data/flows.json` |
| MongoDB | `mongo:8.0.5` | disposable database `lk_residency_pilot`; the five indexes are applied by `apply-indexes.js` |
| Provider fixture | `fixture.mjs` | HTTPS, self-signed, synthetic Viva end-user/admin API, CUP context and Keycloak userinfo |
| Frontend origins | `static.mjs` | 8444 serves the published old bundle byte-for-byte; 8443 serves the branch bundle; `/lk/residency/*` is proxied to Node-RED |
| Browser | Playwright Chromium | `e2e.mjs` drives both bundles with request interception to the fixture |

The published old bundle is downloaded from `https://padlhub.su/lk/bundle.js` and must match
`fce60c89044f95ef7ec9faf1d53267dfce87fcc996efa00dbacee87ab50485be`. The branch bundle is
built with `VITE_RESIDENCY_PASS_API_BASE`, `VITE_SERV2` and `VITE_SERV2_FALLBACK` pointing to
`https://127.0.0.1:8443`; this is a harness-only build, not a release artifact.

## Exact sequence

```bash
export LK_PILOT_WORK=/tmp/lk1-pilot-run
export LK_PLAYWRIGHT_ROOT=/path/to/playwright       # package with the chromium browser
mkdir -p "$LK_PILOT_WORK/certs"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$LK_PILOT_WORK/certs/key.pem" \
  -out "$LK_PILOT_WORK/certs/cert.pem" -days 3 -subj "/CN=127.0.0.1" \
  -addext "subjectAltName=IP:127.0.0.1,DNS:localhost,DNS:host.docker.internal"

# 1. build context and image
cp -R node-red/custom-nodes/residency-lifecycle-api "$LK_PILOT_WORK/"
cp node-red/imports/lk_residency_lifecycle.import.json "$LK_PILOT_WORK/flows.json"
cp scripts/pilot-composition/{Dockerfile,settings.js,compose.yaml,compose.stopped.yaml} "$LK_PILOT_WORK/"
(cd "$LK_PILOT_WORK" && DOCKER_BUILDKIT=0 docker build -t lk1-residency-pilot-nodered:4.0.9 .)  # FROM nodered/node-red:4.0.9-22
(cd "$LK_PILOT_WORK" && docker compose -f compose.yaml up -d)
docker exec -i lk1-pilot-mongo mongosh lk_residency_pilot --quiet < scripts/pilot-composition/apply-indexes.js

# 2. build the branch bundle (harness env) and download the published old bundle
VITE_RESIDENCY_PASS_API_BASE=https://127.0.0.1:8443 \
VITE_SERV2=https://127.0.0.1:8443 VITE_SERV2_FALLBACK=https://127.0.0.1:8443 npx vite build
curl -sS -o "$LK_PILOT_WORK/bundle-old.js" https://padlhub.su/lk/bundle.js
shasum -a 256 "$LK_PILOT_WORK/bundle-old.js"   # must equal fce60c89...

# 3. fixture and frontend origins
TLS_KEY="$LK_PILOT_WORK/certs/key.pem" TLS_CERT="$LK_PILOT_WORK/certs/cert.pem" \
  node scripts/pilot-composition/fixture.mjs &
TLS_KEY="$LK_PILOT_WORK/certs/key.pem" TLS_CERT="$LK_PILOT_WORK/certs/cert.pem" \
NEW_BUNDLE="$PWD/dist/bundle.js" OLD_BUNDLE="$LK_PILOT_WORK/bundle-old.js" \
  node scripts/pilot-composition/static.mjs &

# 4. evidence
NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/pilot-composition/e2e.mjs | tee e2e-result.json
NODE_TLS_REJECT_UNAUTHORIZED=0 bash scripts/pilot-composition/backend-transcript.sh | tee backend-http.txt
```

`NODE_TLS_REJECT_UNAUTHORIZED=0` applies only to these throwaway processes because the fixture
uses a self-signed certificate. It must never be used on 147.

## Scenarios in `e2e.mjs`

| Id | Order | Expected |
| --- | --- | --- |
| A | old checkout first, new screen on another device | new screen shows the server-detected external purchase; zero `POST /lk/residency/orders` |
| B | new order first, old published checkout second, old payment | new order becomes `PAID_REQUIRES_REVIEW` with `EXTERNAL_PAYMENT_DETECTED`; no activation, no second new order |
| C | two devices create at the same time | one `POST` 200, one 409; one Mongo order; one Viva transaction |
| D | incomplete order → `CREATE_ENABLED=false` → old frontend → restart → payment | create 503 `RESIDENCY_ORDERS_DISABLED`; read/reconcile/activation continue; one order, one transaction |
| E | ordinary account | new create 403, zero orders; the old checkout still works |
| race | old transaction appears during the new POST | deterministic fixture control `/_control/race`; the post-create read returns no payment link, payment `UNKNOWN`, `UNKNOWN_OUTCOME`; both Viva transactions exist but the new UI exposes one |

Scenario B proves detection, not prevention: the published old bundle posts directly to
`https://api.vivacrm.ru/end-user/api/v1/iSkq6G/transactions` from the browser, so the gateway
sees that operation only after it exists. See the acceptance document for the boundary and
the owner options.

## Test/install tools

| Tool | Purpose |
| --- | --- |
| `preimage-check.mjs` | full-flow/id/route/no-lifecycle checks + preimage SHA-256; refuses collisions |
| `readback.sh` | post-install read-only checks (OPTIONS 204, catalog/status/orders 200, create without key 400/403/503) |
| `discount-preview.mjs` | advisory `POST /lk/subscriptions/game-price-preview`; never books or charges |
| `package.mjs` | assembles `outputs/residency-pilot-install-*` with `SHA256SUMS`; never deploys |

`backend-transcript.sh` section 10 runs the deterministic race and fails if the second link
is exposed.
