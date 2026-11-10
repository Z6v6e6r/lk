# Academy preview with ordinary authorization

Owner: PadlHub. Audience: people receiving the review link. The preview uses the
existing FFC academy application and Viva sign-in, and displays the signed-in
user's real profile, bookings and subscriptions. It is not a sandbox: the existing
purchase, consent and push behavior is retained. Freeze/schedule buttons remain
prototype handlers; publishing does not implement those features.

The standalone page is `docs/academy-preview/index.html`. Keep the original bundle
name and a separate academy manifest in the same directory. The page pins its
active asset base to that directory so releaseGuard cannot select an old manifest
from the shared `/lk` directory. Backend URLs remain the existing root endpoints.

## Build and verification

Use a clean task checkout from pushed source, installed lockfile dependencies and
the existing ignored public dev build configuration. Set `VITE_CABINET_URL`,
`VITE_SUCCESS_URL` and `VITE_FAIL_URL` to the exact preview URL for this build so
OAuth and purchase returns land on the academy page. Never include `.env` files,
source maps or private exports in the upload.

```sh
node scripts/assert-build-env.mjs dev
npx tsc -b
npx vite build --config vite.config.academy.ts --mode dev --base ./ --outDir dist/academy-preview
node scripts/write-release.mjs dist/academy-preview release-ffc-academy-dev.json
cp docs/academy-preview/index.html dist/academy-preview/index.html
node scripts/assert-clean-deploy.mjs dist/academy-preview/release-ffc-academy-dev.json
```

The proposed target is reserve host `89`, directory
`/var/www/html/lk/academy-preview`, URL
`https://lk-reserve.89-108-64-209.sslip.io/lk/academy-preview/index.html`.
Confirm that the directory is absent immediately before first publication.
Publishing to this target requires explicit approval of the prepared release.
No nginx, auth allowlist, backend, shared LK bundle or shared manifest change is
needed. A new deployment to an existing directory needs a fresh preimage and
replacement/recovery plan.

Before publication verify Keycloak accepts the exact callback using the existing
`widget` client, tenant and identity-provider hint, without signing in. A redirect
to the provider only verifies callback acceptance, not completion of a real login.
Verify loading, failure/retry and mobile layout locally. Inspect the outgoing diff
and packet for secrets/PII and compare local, server and public SHA256 hashes.

For first publication upload assets and the manifest first, and expose index.html
last. Stop on unexpected existing files, hash mismatch, invalid OAuth redirect,
API failures or failure to render. Recovery disables only this new preview by
moving its index.html outside the web root; it must not touch shared LK files.
Perform authorized browser smoke through a verified route. A real login, profile
load, provider purchase and payment are separate acceptance evidence; do not create
bookings or payments merely to validate publication.
